const app = require('./app');
const { close, connect } = require('./database/mongo');
const { port } = require('./config');

async function start() {
  try {
    await connect();
    const server = app.listen(port, () => {
      console.log(`Chạy tại http://localhost:${port}`);
    });

    const shutdown = signal => {
      server.close(async error => {
        if (error) {
          console.error(`Đóng HTTP server lỗi (${signal}):`, error.message);
          process.exitCode = 1;
        }
        try {
          await close();
        } catch (closeError) {
          console.error('Đóng kết nối MongoDB lỗi:', closeError.message);
          process.exitCode = 1;
        }
      });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    console.error('Không kết nối được MongoDB:', error.code || error.name, error.message);
    console.error('Kiểm tra MONGODB_URI, quyền truy cập Atlas và danh sách Network Access.');
    try {
      await close();
    } catch (closeError) {
      console.error('Đóng kết nối MongoDB lỗi:', closeError.message);
    }
    process.exitCode = 1;
  }
}

start();
