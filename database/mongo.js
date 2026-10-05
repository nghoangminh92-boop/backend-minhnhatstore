const { MongoClient } = require('mongodb');
const { databaseName, jwtSecret, mongoUri } = require('../config');
const crypto = require('crypto');

let client;
let database;
let secret = jwtSecret;

async function connect() {
  if (!mongoUri) throw new Error('MONGODB_URI chưa được cấu hình.');

  client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
  await client.connect();
  database = client.db(databaseName);

  await Promise.all([
    database.collection('users').createIndex({ username: 1 }, { unique: true }),
    database.collection('phones').createIndex({ userId: 1, id: 1 }, { unique: true }),
    database.collection('sales').createIndex({ userId: 1, id: 1 }, { unique: true }),
    database.collection('sales').createIndex({ userId: 1, date: 1 }),
    database.collection('expenses').createIndex({ userId: 1, id: 1 }, { unique: true }),
    database.collection('expenses').createIndex({ userId: 1, date: 1 }),
    database.collection('settings').createIndex({ key: 1 }, { unique: true })
  ]);

  const legacyAccounts = await database.collection('users')
    .find({
      $or: [
        { role: { $exists: false } },
        { role: 'owner' },
        { storeId: { $exists: false } },
        { active: { $exists: false } }
      ]
    })
    .project({ _id: 1, role: 1, storeId: 1, active: 1 })
    .toArray();
  for (const account of legacyAccounts) {
    const updates = {};
    if (!account.role || account.role === 'owner') updates.role = 'admin';
    if (!account.storeId) updates.storeId = account._id;
    if (account.active === undefined) updates.active = true;
    if (Object.keys(updates).length) {
      await database.collection('users').updateOne({ _id: account._id }, { $set: updates });
    }
  }

  if (!secret) {
    await database.collection('settings').updateOne(
      { key: 'jwt_secret' },
      { $setOnInsert: { value: crypto.randomBytes(32).toString('hex') } },
      { upsert: true }
    );
    secret = (await database.collection('settings').findOne({ key: 'jwt_secret' })).value;
  }
}

function getDatabase() {
  if (!database) throw new Error('MongoDB chưa được kết nối.');
  return database;
}

function getClient() {
  if (!client) throw new Error('MongoDB chưa được kết nối.');
  return client;
}

function getJwtSecret() {
  if (!secret) throw new Error('JWT secret chưa được khởi tạo.');
  return secret;
}

async function close() {
  if (client) await client.close();
}

module.exports = { close, connect, getClient, getDatabase, getJwtSecret };
