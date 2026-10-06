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

const NUMBER_FIELDS = ['cost', 'price', 'stock', 'qty', 'amt', 'materialCost', 'refundAmt'];

function matchesFields(left, right, fields) {
  return fields.every(field => {
    if (NUMBER_FIELDS.includes(field)) {
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
  const previousReturns = new Map(existing.saleReturns.map(item => [item.id, item]));
  const submittedSales = new Map(incoming.sales.map(sale => [sale.id, sale]));
  const submittedExpenses = new Map(incoming.expenses.map(expense => [expense.id, expense]));
  const submittedPhones = new Map(incoming.phones.map(phone => [phone.id, phone]));
  const submittedReturns = new Map(incoming.saleReturns.map(item => [item.id, item]));

  const saleFields = ['date', 'phoneId', 'name', 'qty', 'price', 'cost', 'cust', 'pay'];
  const expenseFields = ['date', 'cat', 'amt', 'note'];
  const phoneFields = ['brand', 'model', 'storage', 'color', 'cost', 'price'];
  const returnFields = ['saleId', 'date', 'qty', 'refundAmt'];

  if (
    submittedSales.size !== incoming.sales.length ||
    submittedExpenses.size !== incoming.expenses.length ||
    submittedPhones.size !== incoming.phones.length ||
    submittedReturns.size !== incoming.saleReturns.length
  ) {
    return false;
  }

  const salesWithReturns = new Set(existing.saleReturns.map(item => item.saleId));
  const returnedAfterSnapshot = new Map();

  for (const [id, sale] of previousSales) {
    const submitted = submittedSales.get(id);
    if (submitted) {
      if (!matchesFields(sale, submitted, saleFields)) return false;
      continue;
    }

    // Không cho nhân viên xóa đơn đã có đổi trả.
    if (salesWithReturns.has(id)) return false;
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

  // Đổi trả: bản ghi cũ giữ nguyên, bản ghi mới phải hợp lệ.
  const returnTotals = new Map();
  const returnedByPhone = new Map();

  for (const [id, saleReturn] of previousReturns) {
    const submitted = submittedReturns.get(id);
    if (!submitted || !matchesFields(saleReturn, submitted, returnFields)) return false;
    returnTotals.set(saleReturn.saleId, (returnTotals.get(saleReturn.saleId) || 0) + saleReturn.qty);
  }

  for (const [id, saleReturn] of submittedReturns) {
    if (previousReturns.has(id)) continue;
    const sale = previousSales.get(saleReturn.saleId);
    if (
      !id || !sale || !submittedSales.has(sale.id) ||
      !saleReturn.date || saleReturn.date < sale.date ||
      saleReturn.qty < 1 ||
      saleReturn.refundAmt > sale.price * saleReturn.qty
    ) {
      return false;
    }

    returnTotals.set(sale.id, (returnTotals.get(sale.id) || 0) + saleReturn.qty);
    returnedByPhone.set(
      sale.phoneId,
      (returnedByPhone.get(sale.phoneId) || 0) + saleReturn.qty
    );
  }

  for (const [saleId, total] of returnTotals) {
    const sale = previousSales.get(saleId);
    if (!sale || total > sale.qty) return false;
  }

  for (const phone of existing.phones) {
    const submitted = submittedPhones.get(phone.id);
    const expectedStock =
      integerValue(phone.stock) +
      (returnedAfterSnapshot.get(phone.id) || 0) +
      (returnedByPhone.get(phone.id) || 0) -
      (soldAfterSnapshot.get(phone.id) || 0);

    if (
      expectedStock < 0 ||
      !submitted ||
      !matchesFields(phone, submitted, phoneFields) ||
      // Ngày nhập kho đã lưu thì nhân viên không được đổi.
      (phone.stockDate && submitted.stockDate !== phone.stockDate) ||
      submitted.stock !== expectedStock
    ) {
      return false;
    }
  }

  return incoming.phones.every(phone => phone.stock >= 0);
}

function readAll(database, collectionName, userId, session) {
  const options = session ? { session } : undefined;
  return database.collection(collectionName)
    .find({ userId }, options)
    .project({ _id: 0, userId: 0 })
    .toArray();
}

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const database = getDatabase();
  const storeId = req.account.storeId || req.account._id;

  const [
    user,
    phones,
    sales,
    expenses,
    manualRevenues,
    repairRevenues,
    saleReturns
  ] = await Promise.all([
    database.collection('users').findOne(
      { _id: storeId },
      { projection: { inited: 1, dataRevision: 1 } }
    ),
    readAll(database, 'phones', storeId),
    readAll(database, 'sales', storeId),
    readAll(database, 'expenses', storeId),
    readAll(database, 'manualRevenues', storeId),
    readAll(database, 'repairRevenues', storeId),
    readAll(database, 'saleReturns', storeId)
  ]);

  res.json({
    empty: !user?.inited,
    revision: user?.dataRevision || 0,
    role: req.account.role,
    accountId: req.account._id.toString(),
    phones,
    sales,
    exps: expenses,
    manualRevenues,
    repairRevenues,
    saleReturns
  });
}));

router.put('/', requireAuth, asyncHandler(async (req, res) => {
  const data = req.body;
  const has = key => Boolean(data) && Object.prototype.hasOwnProperty.call(data, key);

  if (
    !data ||
    !Array.isArray(data.phones) ||
    !Array.isArray(data.sales) ||
    !Array.isArray(data.exps) ||
    (has('revision') && (!Number.isInteger(data.revision) || data.revision < 0)) ||
    (has('manualRevenues') && !Array.isArray(data.manualRevenues)) ||
    (has('repairRevenues') && !Array.isArray(data.repairRevenues)) ||
    (has('saleReturns') && !Array.isArray(data.saleReturns)) ||
    data.phones.length > 5e3 ||
    data.sales.length > 5e4 ||
    data.exps.length > 5e4 ||
    (data.manualRevenues?.length || 0) > 5e4 ||
    (data.repairRevenues?.length || 0) > 5e4 ||
    (data.saleReturns?.length || 0) > 5e4
  ) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ.' });
  }

  // Frontend hiện tại chưa gửi `revision`: bỏ qua kiểm tra xung đột khi thiếu.
  const clientRevision = has('revision') ? data.revision : null;
  const revenueRows = has('manualRevenues') ? data.manualRevenues : [];
  const repairRows = has('repairRevenues') ? data.repairRevenues : [];
  const returnRows = has('saleReturns') ? data.saleReturns : [];

  if (
    !hasUniqueIds(data.phones) ||
    !hasUniqueIds(data.sales) ||
    !hasUniqueIds(data.exps) ||
    !hasUniqueIds(revenueRows) ||
    !hasUniqueIds(repairRows) ||
    !hasUniqueIds(returnRows)
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
    stock: integerValue(phone.stock),
    stockDate: stringValue(phone.stockDate, 10)
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

  const manualRevenues = has('manualRevenues')
    ? toDocuments(revenueRows, storeId, revenue => ({
        date: stringValue(revenue.date, 10),
        amt: integerValue(revenue.amt),
        note: stringValue(revenue.note, 300)
      }))
    : null;

  const repairRevenues = has('repairRevenues')
    ? toDocuments(repairRows, storeId, revenue => ({
        date: stringValue(revenue.date, 10),
        amt: integerValue(revenue.amt),
        materialCost: integerValue(revenue.materialCost),
        note: stringValue(revenue.note, 300)
      }))
    : null;

  const saleReturns = has('saleReturns')
    ? toDocuments(returnRows, storeId, saleReturn => ({
        saleId: stringValue(saleReturn.saleId, 20),
        date: stringValue(saleReturn.date, 10),
        qty: integerValue(saleReturn.qty),
        refundAmt: integerValue(saleReturn.refundAmt)
      }))
    : null;

  const database = getDatabase();
  const userId = storeId;
  const session = getClient().startSession();

  try {
    let staffWriteAllowed = true;
    let staleData = false;
    let nextRevision = 0;

    await session.withTransaction(async () => {
      staffWriteAllowed = true;
      staleData = false;

      const store = await database.collection('users').findOne(
        { _id: userId },
        { session, projection: { dataRevision: 1 } }
      );
      const currentRevision = store?.dataRevision || 0;
      nextRevision = currentRevision + 1;

      if (clientRevision !== null && currentRevision !== clientRevision) {
        staleData = true;
        nextRevision = currentRevision;
        return;
      }

      const revenueCollection = database.collection('manualRevenues');
      const repairRevenueCollection = database.collection('repairRevenues');
      const returnCollection = database.collection('saleReturns');

      const [
        existingManualRevenues,
        existingRepairRevenues,
        existingSaleReturns
      ] = await Promise.all([
        readAll(database, 'manualRevenues', userId, session),
        readAll(database, 'repairRevenues', userId, session),
        readAll(database, 'saleReturns', userId, session)
      ]);

      // Giữ nguyên dữ liệu khi client cũ không gửi các mục này.
      const revenuesToSave = manualRevenues || existingManualRevenues.map(row => ({ userId, ...row }));
      const repairsToSave = repairRevenues || existingRepairRevenues.map(row => ({ userId, ...row }));
      const returnsToSave = saleReturns || existingSaleReturns.map(row => ({ userId, ...row }));

      if (req.account.role === 'staff') {
        const [existingPhones, existingSales, existingExpenses] = await Promise.all([
          readAll(database, 'phones', userId, session),
          readAll(database, 'sales', userId, session),
          readAll(database, 'expenses', userId, session)
        ]);

        const stripUser = ({ userId: _userId, ...row }) => row;

        const unchangedManualRevenues = sameRecords(
          existingManualRevenues,
          revenuesToSave.map(stripUser),
          ['date', 'amt', 'note']
        );

        const unchangedRepairRevenues = sameRecords(
          existingRepairRevenues,
          repairsToSave.map(stripUser),
          ['date', 'amt', 'materialCost', 'note']
        );

        staffWriteAllowed = unchangedManualRevenues &&
          unchangedRepairRevenues &&
          canStaffSave(
            {
              phones: existingPhones,
              sales: existingSales,
              expenses: existingExpenses,
              saleReturns: existingSaleReturns
            },
            {
              phones: phones.map(stripUser),
              sales: sales.map(stripUser),
              expenses: expenses.map(stripUser),
              saleReturns: returnsToSave.map(stripUser)
            }
          );

        if (!staffWriteAllowed) return;
      }

      // Tài khoản cũ chưa có trường dataRevision thì coi như 0.
      const revisionFilter = currentRevision === 0 ? { $in: [0, null] } : currentRevision;
      const revisionUpdate = await database.collection('users').updateOne(
        { _id: userId, dataRevision: revisionFilter },
        { $set: { inited: true }, $inc: { dataRevision: 1 } },
        { session }
      );
      if (revisionUpdate.matchedCount !== 1) {
        staleData = true;
        nextRevision = currentRevision;
        return;
      }

      await database.collection('phones').deleteMany({ userId }, { session });
      await database.collection('sales').deleteMany({ userId }, { session });
      await database.collection('expenses').deleteMany({ userId }, { session });
      await revenueCollection.deleteMany({ userId }, { session });
      await repairRevenueCollection.deleteMany({ userId }, { session });
      await returnCollection.deleteMany({ userId }, { session });

      await insertInBatches(database.collection('phones'), phones, session);
      await insertInBatches(database.collection('sales'), sales, session);
      await insertInBatches(database.collection('expenses'), expenses, session);
      await insertInBatches(revenueCollection, revenuesToSave, session);
      await insertInBatches(repairRevenueCollection, repairsToSave, session);
      await insertInBatches(returnCollection, returnsToSave, session);

      await database.collection('users').updateMany(
        { storeId: userId },
        { $set: { inited: true } },
        { session }
      );
    });

    if (!staffWriteAllowed) {
      return res.status(403).json({
        error: 'Nhân viên chỉ được thêm kho, đơn bán hoặc đổi trả hợp lệ; không được sửa dữ liệu đã lưu.'
      });
    }
    if (staleData) {
      return res.status(409).json({
        error: 'Dữ liệu vừa được người khác cập nhật. Hãy tải lại trang để lấy dữ liệu mới.',
        revision: nextRevision
      });
    }

    res.json({ ok: true, revision: nextRevision });
  } finally {
    await session.endSession();
  }
}));

module.exports = router;