require('../load-env');

const mongoUri = process.env.MONGODB_URI;
const isProduction = process.env.NODE_ENV === 'production';

function readDatabaseName(uri) {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  if (!uri) return 'cuahang';
  try {
    return decodeURIComponent(new URL(uri).pathname.slice(1)) || 'cuahang';
  } catch {
    return 'cuahang';
  }
}

if (!mongoUri) {
  throw new Error('Thiếu biến môi trường MONGODB_URI.');
}

if (!process.env.JWT_SECRET) {
  const message = 'Thiếu biến môi trường JWT_SECRET: đăng nhập sẽ lỗi.';
  if (isProduction) throw new Error(message);
  console.warn(message);
}

module.exports = {
  databaseName: readDatabaseName(mongoUri),
  adminRecoveryCode: process.env.ADMIN_RECOVERY_CODE || '',
  jwtSecret: process.env.JWT_SECRET || null,
  mongoUri,
  port: Number(process.env.PORT) || 3000
};