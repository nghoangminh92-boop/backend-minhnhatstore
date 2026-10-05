const express = require('express');
const { getClient, getDatabase } = require('../database/mongo');
const asyncHandler = require('../middleware/async-handler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function stringValue(value, maxLength = 200) {
  return String(value ?? '').slice(0, maxLength);
}

function integerValue(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function toDocuments(rows, userId, mapFields) {
  const seenIds = new Set();
  const documents = [];

  for (const item of rows) {
    const row = item && typeof item === 'object' ? item : {};
    const id = stringValue(row.id, 20);
    if (seenIds.has(id)) continue;

    seenIds.add(id);
    documents.push({ userId, id, ...mapFields(row) });
  }

  return documents;
}

function hasUniqueIds(rows) {
  const ids = new Set();

  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;

    const id = stringValue(row.id, 20);
    if (!id || ids.has(id)) return false;

    ids.add(id);
  }

  return true;
}

async function insertInBatches(collection, documents, session) {
  for (let index = 0; index < documents.length; index += 1000) {
    await collection.insertMany(documents.slice(index, index + 1000), { session });
  }
}

function matchesFields(left, right, fields) {
  return fields.every(field => {
    if (['cost', 'price', 'stock', 'qty', 'amt'].includes(field)) {
      return integerValue(left[field]) === integerValue(right[field]);
    }

    return String(left[field] ?? '') === String(right[field] ?? '');
  });
}

function sameRecords(existing, incoming, fields) {
  if (existing.length !== incoming.length) return false;

  const submittedById = new Map(incoming.map(item => [item.id, item]));
  if (submittedById.size !== incoming.length) return false;

  return existing.every(item => {
    const submitted = submittedById.get(item.id);
    return submitted && matchesFields(item, submitted, fields);
  });
}

function canStaffSave(existing, incoming) {
  const previousSales = new Map(existing.sales.map(sale => [sale.id, sale]));
  const previousExpenses = new Map(existing.expenses.map(expense => [expense.id, expense]));
  const previousPhones = new Map(existing.phones.map(phone => [phone.id, phone]));
  const submittedSales = new Map(incoming.sales.map(sale => [sale.id, sale]));
  const submittedExpenses = new Map(incoming.expenses.map(expense => [expense.id, expense]));
  const submittedPhones = new Map(incoming.phones.map(phone => [phone.id, phone]));

  const saleFields = ['date', 'phoneId', 'name', 'qty', 'price', 'cost', 'cust', 'pay'];
  const expenseFields = ['date', 'cat', 'amt', 'note'];
  const phoneFields = ['brand', 'model', 'storage', 'color', 'cost', 'price'];

  if (
    submittedSales.size !== incoming.sales.length ||
    submittedExpenses.size !== incoming.expenses.length ||
    submittedPhones.size !== incoming.phones.length
  ) {
    return false;
  }

  const returnedAfterSnapshot = new Map();

  for (const [id, sale] of previousSales) {
    const submitted = submittedSales.get(id);
    if (submitted) {
      if (!matchesFields(sale, submitted, saleFields)) return false;
      continue;
    }

    if (!previousPhones.has(sale.phoneId) || sale.qty < 1) return false;
    returnedAfterSnapshot.set(
      sale.phoneId,
      (returnedAfterSnapshot.get(sale.phoneId) || 0) + sale.qty
    );
  }

  for (const [id, expense] of previousExpenses) {
    const submitted = submittedExpenses.get(id);
    if (!submitted || !matchesFields(expense, submitted, expenseFields)) return false;
  }

  if (submittedExpenses.size !== previousExpenses.size) return false;

  const soldAfterSnapshot = new Map();

  for (const [id, sale] of submittedSales) {
    if (previousSales.has(id)) continue;
    if (!sale.id || sale.qty < 1 || !sale.phoneId || !previousPhones.has(sale.phoneId)) {
      return false;
    }

    const phone = previousPhones.get(sale.phoneId);
    const expectedName = `${phone.brand} ${phone.model} ${phone.storage}`;

    if (sale.cost !== phone.cost || sale.name !== expectedName) return false;

    soldAfterSnapshot.set(
      sale.phoneId,
      (soldAfterSnapshot.get(sale.phoneId) || 0) + sale.qty
    );
  }

  for (const phone of existing.phones) {
    const submitted = submittedPhones.get(phone.id);
    const expectedStock =
      integerValue(phone.stock) +
      (returnedAfterSnapshot.get(phone.id) || 0) -
      (soldAfterSnapshot.get(phone.id) || 0);

    if (
      expectedStock < 0 ||
      !submitted ||
      !matchesFields(phone, submitted, phoneFields) ||
      submitted.stock !== expectedStock
    ) {
      return false;
    }
  }

  return incoming.phones.every(phone => phone.stock >= 0);
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const database = getDatabase();
  const storeId = req.account.storeId || req.account._id;

  const [user, phones, sales, expenses, manualRevenues] = await Promise.all([
    database.collection('users').findOne(
      { _id: storeId },
      { projection: { inited: 1 } }
    ),
    database.collection('phones')
      .find({ userId: storeId })
      .project({ _id: 0, userId: 0 })
      .toArray(),
    database.collection('sales')
      .find({ userId: storeId })
      .project({ _id: 0, userId: 0 })
      .toArray(),
    database.collection('expenses')
      .find({ userId: storeId })
      .project({ _id: 0, userId: 0 })
      .toArray(),
    database.collection('manualRevenues')
      .find({ userId: storeId })
      .project({ _id: 0, userId: 0 })
      .toArray()
  ]);

  res.json({
    empty: !user?.inited,
    role: req.account.role,
    accountId: req.account._id.toString(),
    phones,
    sales,
    exps: expenses,
    manualRevenues
  });
}));

router.put('/', requireAuth, asyncHandler(async (req, res) => {
  const data = req.body;

  if (
    !data ||
    !Array.isArray(data.phones) ||
    !Array.isArray(data.sales) ||
    !Array.isArray(data.exps) ||
    (
      Object.prototype.hasOwnProperty.call(data, 'manualRevenues') &&
      !Array.isArray(data.manualRevenues)
    ) ||
    data.phones.length > 5e3 ||
    data.sales.length > 5e4 ||
    data.exps.length > 5e4 ||
    (data.manualRevenues?.length || 0) > 5e4
  ) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
  }

  const hasManualRevenues =
    Object.prototype.hasOwnProperty.call(data, 'manualRevenues');
  const revenueRows = hasManualRevenues ? data.manualRevenues : [];

  if (
    !hasUniqueIds(data.phones) ||
    !hasUniqueIds(data.sales) ||
    !hasUniqueIds(data.exps) ||
    (hasManualRevenues && !hasUniqueIds(revenueRows))
  ) {
    return res.status(400).json({
      error: 'Mỗi bản ghi phải có mã riêng hợp lệ.'
    });
  }

  const storeId = req.account.storeId || req.account._id;

  const phones = toDocuments(data.phones, storeId, phone => ({
    brand: stringValue(phone.brand, 60),
    model: stringValue(phone.model, 100),
    storage: stringValue(phone.storage, 30),
    color: stringValue(phone.color, 60),
    cost: integerValue(phone.cost),
    price: integerValue(phone.price),
    stock: integerValue(phone.stock)
  }));

  const sales = toDocuments(data.sales, storeId, sale => ({
    date: stringValue(sale.date, 10),
    phoneId: stringValue(sale.phoneId, 20),
    name: stringValue(sale.name, 200),
    qty: integerValue(sale.qty),
    price: integerValue(sale.price),
    cost: integerValue(sale.cost),
    cust: stringValue(sale.cust, 100),
    pay: stringValue(sale.pay, 30)
  }));

  const expenses = toDocuments(data.exps, storeId, expense => ({
    date: stringValue(expense.date, 10),
    cat: stringValue(expense.cat, 60),
    amt: integerValue(expense.amt),
    note: stringValue(expense.note, 300)
  }));

  const manualRevenues = hasManualRevenues
    ? toDocuments(revenueRows, storeId, revenue => ({
        date: stringValue(revenue.date, 10),
        amt: integerValue(revenue.amt),
        note: stringValue(revenue.note, 300)
      }))
    : null;

  const database = getDatabase();
  const userId = storeId;
  const session = getClient().startSession();

  try {
    let staffWriteAllowed = true;

    await session.withTransaction(async () => {
      const revenueCollection = database.collection('manualRevenues');
      const existingManualRevenues = await revenueCollection
        .find({ userId }, { session })
        .project({ _id: 0, userId: 0 })
        .toArray();

      // Giữ dữ liệu doanh thu nếu request đến từ client cũ không gửi trường này.
      const revenuesToSave = manualRevenues || existingManualRevenues;

      if (req.account.role === 'staff') {
        const [
          existingPhones,
          existingSales,
          existingExpenses
        ] = await Promise.all([
          database.collection('phones')
            .find({ userId }, { session })
            .project({ _id: 0, userId: 0 })
            .toArray(),
          database.collection('sales')
            .find({ userId }, { session })
            .project({ _id: 0, userId: 0 })
            .toArray(),
          database.collection('expenses')
            .find({ userId }, { session })
            .project({ _id: 0, userId: 0 })
            .toArray()
        ]);

        const unchangedManualRevenues = sameRecords(
          existingManualRevenues,
          revenuesToSave.map(({ userId: _userId, ...revenue }) => revenue),
          ['date', 'amt', 'note']
        );

        staffWriteAllowed = unchangedManualRevenues && canStaffSave(
          {
            phones: existingPhones,
            sales: existingSales,
            expenses: existingExpenses
          },
          {
            phones: phones.map(({ userId: _userId, ...phone }) => phone),
            sales: sales.map(({ userId: _userId, ...sale }) => sale),
            expenses: expenses.map(({ userId: _userId, ...expense }) => expense)
          }
        );

        if (!staffWriteAllowed) return;
      }

      await database.collection('phones').deleteMany({ userId }, { session });
      await database.collection('sales').deleteMany({ userId }, { session });
      await database.collection('expenses').deleteMany({ userId }, { session });
      await revenueCollection.deleteMany({ userId }, { session });

      await insertInBatches(database.collection('phones'), phones, session);
      await insertInBatches(database.collection('sales'), sales, session);
      await insertInBatches(database.collection('expenses'), expenses, session);
      await insertInBatches(revenueCollection, revenuesToSave, session);

      await database.collection('users').updateMany(
        { storeId: userId },
        { $set: { inited: true } },
        { session }
      );

      await database.collection('users').updateOne(
        { _id: userId },
        { $set: { inited: true } },
        { session }
      );
    });

    if (!staffWriteAllowed) {
      return res.status(403).json({
        error: 'Nhân viên chỉ được thêm kho và đơn bán, xóa đơn để hoàn tồn; không được sửa dữ liệu đã lưu.'
      });
    }
  } finally {
    await session.endSession();
  }

  res.json({ ok: true });
}));

module.exports = router;