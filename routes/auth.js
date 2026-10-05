const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { adminRecoveryCode } = require('../config');
const { getDatabase, getJwtSecret } = require('../database/mongo');
const asyncHandler = require('../middleware/async-handler');
const { requireAuth, setAuthCookie, tokenOf } = require('../middleware/auth');

const router = express.Router();
const failedAttempts = new Map();
const LOCK_DURATION = 15 * 60 * 1000;
const recoveryAttempts = new Map();

function isLocked(ip) {
  const attempt = failedAttempts.get(ip);
  return Boolean(attempt && attempt.count >= 10 && Date.now() - attempt.startedAt < LOCK_DURATION);
}

function recordFailure(ip) {
  const attempt = failedAttempts.get(ip);
  if (attempt && Date.now() - attempt.startedAt < LOCK_DURATION) {
    failedAttempts.set(ip, { count: attempt.count + 1, startedAt: attempt.startedAt });
  } else {
    failedAttempts.set(ip, { count: 1, startedAt: Date.now() });
  }
}

function recoveryLocked(ip) {
  const attempt = recoveryAttempts.get(ip);
  return Boolean(attempt && attempt.count >= 5 && Date.now() - attempt.startedAt < LOCK_DURATION);
}

function recordRecoveryFailure(ip) {
  const attempt = recoveryAttempts.get(ip);
  if (attempt && Date.now() - attempt.startedAt < LOCK_DURATION) {
    recoveryAttempts.set(ip, { count: attempt.count + 1, startedAt: attempt.startedAt });
  } else {
    recoveryAttempts.set(ip, { count: 1, startedAt: Date.now() });
  }
}

function recoveryCodeMatches(candidate) {
  const expectedHash = crypto.createHash('sha256').update(adminRecoveryCode).digest();
  const candidateHash = crypto.createHash('sha256').update(candidate).digest();
  return crypto.timingSafeEqual(expectedHash, candidateHash);
}

function parseCredentials(body) {
  const payload = body || {};
  const username = String(payload.username || '').trim().toLowerCase();
  const password = String(payload.password || '');
  return /^[a-z0-9._-]{3,30}$/.test(username) && password.length >= 8 && password.length <= 100
    ? { username, password }
    : null;
}

router.get('/status', asyncHandler(async (req, res) => {
  let account = null;
  let identity = null;
  try {
    identity = jwt.verify(tokenOf(req), getJwtSecret());
  } catch (error) {
    if (error.name !== 'JsonWebTokenError' && error.name !== 'TokenExpiredError' && error.name !== 'NotBeforeError') {
      throw error;
    }
  }
  if (typeof identity?.uid === 'string' && /^[a-f\d]{24}$/i.test(identity.uid)) {
    account = await getDatabase().collection('users').findOne({ _id: new ObjectId(identity.uid) });
    if (account?.active === false || (identity.tv || 0) !== (account?.tokenVersion || 0)) account = null;
  }

  const hasUsers = (await getDatabase().collection('users').countDocuments()) > 0;
  res.json({
    hasUsers,
    user: account?.username || null,
    role: account?.role || null,
    canRegister: !hasUsers
  });
}));

router.post('/register', asyncHandler(async (req, res) => {
  const users = getDatabase().collection('users');
  if ((await users.countDocuments()) > 0) {
    return res.status(403).json({ error: 'Cửa hàng đã có tài khoản. Hãy đăng nhập.' });
  }

  const credentials = parseCredentials(req.body);
  if (!credentials) {
    return res.status(400).json({
      error: 'Tên đăng nhập 3-30 ký tự (a-z, 0-9, . _ -), mật khẩu tối thiểu 8 ký tự.'
    });
  }

  try {
    const id = new ObjectId();
    const user = {
      _id: id,
      storeId: id,
      username: credentials.username,
      hash: await bcrypt.hash(credentials.password, 10),
      inited: false,
      role: 'admin',
      active: true,
      created: new Date()
    };
    await users.insertOne(user);
    setAuthCookie(req, res, user);
    res.json({ user: credentials.username, role: user.role });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
    }
    throw error;
  }
}));

router.post('/login', asyncHandler(async (req, res) => {
  if (isLocked(req.ip)) {
    return res.status(429).json({ error: 'Sai quá nhiều lần. Thử lại sau 15 phút.' });
  }

  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const user = await getDatabase().collection('users').findOne({ username });
  if (!user || !(await bcrypt.compare(String(body.password || ''), user.hash))) {
    recordFailure(req.ip);
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }
  if (user.active === false) {
    return res.status(403).json({ error: 'Tài khoản đã bị khóa. Hãy liên hệ chủ cửa hàng.' });
  }

  failedAttempts.delete(req.ip);
  setAuthCookie(req, res, user);
  res.json({ user: user.username, role: user.role });
}));

router.post('/change-password', requireAuth, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8 || newPassword.length > 100) {
    return res.status(400).json({ error: 'Mật khẩu mới phải dài từ 8 đến 100 ký tự.' });
  }
  if (!(await bcrypt.compare(currentPassword, req.account.hash))) {
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.' });
  }
  if (await bcrypt.compare(newPassword, req.account.hash)) {
    return res.status(400).json({ error: 'Mật khẩu mới phải khác mật khẩu hiện tại.' });
  }

  const tokenVersion = (req.account.tokenVersion || 0) + 1;
  await getDatabase().collection('users').updateOne(
    { _id: req.account._id },
    { $set: { hash: await bcrypt.hash(newPassword, 10), tokenVersion, passwordChangedAt: new Date() } }
  );
  setAuthCookie(req, res, { ...req.account, tokenVersion });
  res.json({ ok: true });
}));

router.post('/forgot-password/admin', asyncHandler(async (req, res) => {
  if (recoveryLocked(req.ip)) {
    return res.status(429).json({ error: 'Thử khôi phục quá nhiều lần. Hãy thử lại sau 15 phút.' });
  }
  if (!adminRecoveryCode) {
    return res.status(503).json({ error: 'Chưa cấu hình mã khôi phục Admin. Hãy liên hệ quản trị hệ thống.' });
  }

  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const recoveryCode = String(body.recoveryCode || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 8 || newPassword.length > 100) {
    return res.status(400).json({ error: 'Mật khẩu mới phải dài từ 8 đến 100 ký tự.' });
  }

  const user = await getDatabase().collection('users').findOne({ username });
  if (!recoveryCodeMatches(recoveryCode) || !user || !['admin', 'owner'].includes(user.role)) {
    recordRecoveryFailure(req.ip);
    return res.status(400).json({ error: 'Tên Admin hoặc mã khôi phục không đúng.' });
  }

  const tokenVersion = (user.tokenVersion || 0) + 1;
  await getDatabase().collection('users').updateOne(
    { _id: user._id },
    {
      $set: {
        hash: await bcrypt.hash(newPassword, 10),
        tokenVersion,
        passwordChangedAt: new Date()
      }
    }
  );
  recoveryAttempts.delete(req.ip);
  res.json({ ok: true });
}));

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = router;
