require('../load-env');

const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DB || (mongoUri
  ? decodeURIComponent(new URL(mongoUri).pathname.slice(1)) || 'cuahang'
  : 'cuahang');

module.exports = {
  databaseName,
  adminRecoveryCode: process.env.ADMIN_RECOVERY_CODE || '',
  jwtSecret: process.env.JWT_SECRET || null,
  mongoUri,
  port: Number(process.env.PORT) || 3000
};
