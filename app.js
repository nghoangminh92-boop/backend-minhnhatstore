const express = require('express');
const path = require('path');
const asyncHandler = require('./middleware/async-handler');
const accountRoutes = require('./routes/accounts');
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use('/api', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/data', dataRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Lỗi máy chủ.' });
});

module.exports = app;
