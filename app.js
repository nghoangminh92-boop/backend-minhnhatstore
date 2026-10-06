const express = require('express');
const accountRoutes = require('./routes/accounts');
const authRoutes = require('./routes/auth');
const dataRoutes = require('./routes/data');

const app = express();

// Backend chạy sau proxy (Vercel rewrite -> Render), cần để cookie `secure` và req.ip hoạt động đúng.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));

// Kiểm tra sống (Render health check / đánh thức server).
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api', authRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/data', dataRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Không tìm thấy' }));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dữ liệu gửi lên không hợp lệ.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Dữ liệu quá lớn.' });
  console.error(error);
  res.status(500).json({ error: 'Lỗi máy chủ.' });
});

module.exports = app;