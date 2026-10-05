const jwt = require('jsonwebtoken');
const { ObjectId } = require('mongodb');
const { getDatabase, getJwtSecret } = require('../database/mongo');

function tokenOf(req) {
  return ((req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('token=')) || '').slice(6);
}

function requireAuth(req, res, next) {
  let identity;
  try {
    identity = jwt.verify(tokenOf(req), getJwtSecret());
    if (typeof identity.uid !== 'string' || !/^[a-f\d]{24}$/i.test(identity.uid)) {
      throw new Error('Invalid user id');
    }
  } catch {
    return res.status(401).json({ error: 'Chưa đăng nhập' });
  }

  getDatabase().collection('users').findOne({ _id: new ObjectId(identity.uid) })
    .then(account => {
      if (!account || account.active === false ||
          (identity.tv || 0) !== (account.tokenVersion || 0)) {
        res.clearCookie('token');
        return res.status(401).json({ error: 'Phiên đăng nhập hết hạn hoặc tài khoản đã bị khóa.' });
      }
      req.user = identity;
      req.account = account;
      next();
    })
    .catch(next);
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.account || !roles.includes(req.account.role)) {
      return res.status(403).json({ error: 'Bạn không có quyền thực hiện thao tác này.' });
    }
    next();
  };
}

function setAuthCookie(req, res, user) {
  const token = jwt.sign(
    { uid: user._id.toString(), u: user.username, tv: user.tokenVersion || 0 },
    getJwtSecret(),
    { expiresIn: '7d' }
  );
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    maxAge: 7 * 864e5
  });
}

module.exports = { allowRoles, requireAuth, setAuthCookie, tokenOf };
