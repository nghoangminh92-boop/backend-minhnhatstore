const express = require('express');
const bcrypt = require('bcryptjs');
const { ObjectId } = require('mongodb');
const { getDatabase } = require('../database/mongo');
const asyncHandler = require('../middleware/async-handler');
const { allowRoles, requireAuth } = require('../middleware/auth');

const router = express.Router();
const ROLES = new Set(['manager', 'staff']);
const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

function publicAccount(account) {
  return {
    id: account._id.toString(),
    username: account.username,
    role: account.role,
    active: account.active !== false,
    created: account.created
  };
}

function canManageTarget(actor, target) {
  if (actor._id.equals(target._id) || target.role === 'admin' || target.role === 'owner') return false;
  return actor.role === 'admin' || actor.role === 'manager';
}

router.use(requireAuth, allowRoles('admin', 'manager'));

router.get('/', asyncHandler(async (req, res) => {
  const storeId = req.account.storeId || req.account._id;
  const accounts = await getDatabase().collection('users')
    .find({ storeId })
    .project({ hash: 0, storeId: 0 })
    .sort({ created: 1, username: 1 })
    .toArray();
  res.json({ accounts: accounts.map(publicAccount) });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  const role = String(body.role || '');

  if (!USERNAME_PATTERN.test(username) || password.length < 8 || password.length > 100) {
    return res.status(400).json({
      error: 'Tên đăng nhập phải có 3-30 ký tự hợp lệ và mật khẩu dài 8-100 ký tự.'
    });
  }
  if (!ROLES.has(role)) {
    return res.status(403).json({ error: 'Bạn không có quyền tạo tài khoản với vai trò này.' });
  }

  const user = {
    _id: new ObjectId(),
    storeId: req.account.storeId || req.account._id,
    username,
    hash: await bcrypt.hash(password, 10),
    role,
    active: true,
    inited: true,
    created: new Date()
  };

  try {
    await getDatabase().collection('users').insertOne(user);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Tên đăng nhập đã tồn tại.' });
    }
    throw error;
  }
  res.status(201).json({ account: publicAccount(user) });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = req.body || {};
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Mã tài khoản không hợp lệ.' });
  }

  const users = getDatabase().collection('users');
  const target = await users.findOne({
    _id: new ObjectId(req.params.id),
    storeId: req.account.storeId || req.account._id
  });
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (!canManageTarget(req.account, target)) {
    return res.status(403).json({ error: 'Bạn không có quyền thay đổi tài khoản này.' });
  }

  const updates = {};
  if (Object.prototype.hasOwnProperty.call(body, 'active')) {
    if (typeof body.active !== 'boolean') {
      return res.status(400).json({ error: 'Trạng thái tài khoản không hợp lệ.' });
    }
    updates.active = body.active;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'role')) {
    if (!ROLES.has(body.role)) {
      return res.status(400).json({ error: 'Vai trò không hợp lệ.' });
    }
    updates.role = body.role;
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'Không có thông tin hợp lệ để cập nhật.' });
  }

  await users.updateOne({ _id: target._id }, { $set: updates });
  res.json({ account: publicAccount({ ...target, ...updates }) });
}));

router.post('/:id/reset-password', asyncHandler(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Mã tài khoản không hợp lệ.' });
  }

  const newPassword = String((req.body || {}).newPassword || '');
  if (newPassword.length < 8 || newPassword.length > 100) {
    return res.status(400).json({ error: 'Mật khẩu mới phải dài từ 8 đến 100 ký tự.' });
  }

  const users = getDatabase().collection('users');
  const target = await users.findOne({
    _id: new ObjectId(req.params.id),
    storeId: req.account.storeId || req.account._id
  });
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (!canManageTarget(req.account, target)) {
    return res.status(403).json({ error: 'Bạn không có quyền đặt lại mật khẩu tài khoản này.' });
  }

  const tokenVersion = (target.tokenVersion || 0) + 1;
  await users.updateOne(
    { _id: target._id },
    {
      $set: {
        hash: await bcrypt.hash(newPassword, 10),
        tokenVersion,
        passwordChangedAt: new Date()
      }
    }
  );
  res.json({ ok: true });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Mã tài khoản không hợp lệ.' });
  }

  const users = getDatabase().collection('users');
  const target = await users.findOne({
    _id: new ObjectId(req.params.id),
    storeId: req.account.storeId || req.account._id
  });
  if (!target) return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
  if (!canManageTarget(req.account, target)) {
    return res.status(403).json({ error: 'Bạn không có quyền xóa tài khoản này.' });
  }

  await users.deleteOne({ _id: target._id });
  res.json({ ok: true });
}));

module.exports = router;
