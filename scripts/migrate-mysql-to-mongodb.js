require('../load-env');

const mysql = require('mysql2/promise');
const { MongoClient, ObjectId } = require('mongodb');

const sourceUri = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const targetUri = process.env.MONGODB_URI;

function required(value, name) {
  if (!value) throw new Error(`${name} chưa được cấu hình.`);
  return value;
}

function mongoDatabaseName(uri) {
  if (process.env.MONGODB_DB) return process.env.MONGODB_DB;
  const name = decodeURIComponent(new URL(uri).pathname.slice(1));
  return name || 'cuahang';
}

async function insertInBatches(collection, documents, session) {
  for (let i = 0; i < documents.length; i += 1000) {
    await collection.insertMany(documents.slice(i, i + 1000), { session });
  }
}

async function migrate() {
  required(sourceUri, 'SOURCE_DATABASE_URL hoặc DATABASE_URL');
  required(targetUri, 'MONGODB_URI');

  const source = new URL(sourceUri);
  if (!['mysql:', 'mysql2:'].includes(source.protocol)) {
    throw new Error('SOURCE_DATABASE_URL phải là một URL MySQL.');
  }
  const sql = await mysql.createConnection({
    host: source.hostname,
    port: Number(source.port) || 3306,
    user: decodeURIComponent(source.username),
    password: decodeURIComponent(source.password),
    database: decodeURIComponent(source.pathname.slice(1)),
    charset: 'utf8mb4',
    ssl: process.env.SOURCE_DB_SSL === '1' ? { rejectUnauthorized: false } : undefined
  });
  const client = new MongoClient(targetUri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const db = client.db(mongoDatabaseName(targetUri));
    const usersCollection = db.collection('users');
    const phonesCollection = db.collection('phones');
    const salesCollection = db.collection('sales');
    const expensesCollection = db.collection('expenses');
    const settingsCollection = db.collection('settings');

    const counts = await Promise.all([
      usersCollection.countDocuments(),
      phonesCollection.countDocuments(),
      salesCollection.countDocuments(),
      expensesCollection.countDocuments(),
      settingsCollection.countDocuments()
    ]);
    if (counts.some(count => count > 0)) {
      throw new Error('Database MongoDB đích không trống. Di trú đã dừng để tránh ghi đè dữ liệu.');
    }

    const [users, phones, sales, expenses, settings] = await Promise.all([
      sql.query('SELECT id, username, hash, inited, created FROM users'),
      sql.query('SELECT user_id, id, brand, model, storage, color, cost, price, stock FROM phones'),
      sql.query('SELECT user_id, id, `date`, phone_id, name, qty, price, cost, cust, pay FROM sales'),
      sql.query('SELECT user_id, id, `date`, cat, amt, note FROM expenses'),
      sql.query('SELECT k, v FROM settings')
    ]);
    const [userRows] = users;
    const [phoneRows] = phones;
    const [saleRows] = sales;
    const [expenseRows] = expenses;
    const [settingRows] = settings;
    const userIds = new Map(userRows.map(user => [String(user.id), new ObjectId()]));
    const session = client.startSession();

    try {
      await session.withTransaction(async () => {
        await insertInBatches(usersCollection, userRows.map(user => {
          const id = userIds.get(String(user.id));
          return {
            _id: id,
            storeId: id,
            username: user.username,
            hash: user.hash,
            role: 'admin',
            active: true,
            inited: Boolean(user.inited),
            created: user.created
          };
        }), session);
        await insertInBatches(phonesCollection, phoneRows.map(phone => ({
          userId: userIds.get(String(phone.user_id)),
          id: phone.id,
          brand: phone.brand,
          model: phone.model,
          storage: phone.storage,
          color: phone.color,
          cost: phone.cost,
          price: phone.price,
          stock: phone.stock
        })), session);
        await insertInBatches(salesCollection, saleRows.map(sale => ({
          userId: userIds.get(String(sale.user_id)),
          id: sale.id,
          date: sale.date,
          phoneId: sale.phone_id,
          name: sale.name,
          qty: sale.qty,
          price: sale.price,
          cost: sale.cost,
          cust: sale.cust,
          pay: sale.pay
        })), session);
        await insertInBatches(expensesCollection, expenseRows.map(expense => ({
          userId: userIds.get(String(expense.user_id)),
          id: expense.id,
          date: expense.date,
          cat: expense.cat,
          amt: expense.amt,
          note: expense.note
        })), session);
        await insertInBatches(settingsCollection, settingRows.map(setting => ({
          key: setting.k,
          value: setting.v
        })), session);
      });
    } finally {
      await session.endSession();
    }

    console.log(`Di trú hoàn tất: ${userRows.length} tài khoản, ${phoneRows.length} sản phẩm, ${saleRows.length} đơn bán, ${expenseRows.length} chi phí.`);
    console.log('MySQL nguồn không bị thay đổi.');
  } finally {
    await Promise.all([sql.end(), client.close()]);
  }
}

migrate().catch(error => {
  console.error('Di trú thất bại:', error.code || error.name, error.message);
  process.exitCode = 1;
});
