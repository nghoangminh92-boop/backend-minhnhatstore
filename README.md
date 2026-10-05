# Quản lý cửa hàng điện thoại: backend (Node.js + MongoDB)

API và đăng nhập giữ nguyên để frontend hiện tại tiếp tục sử dụng. Dữ liệu được lưu trong các collection `users`, `phones`, `sales`, `expenses` và `settings`.

## Phân quyền tài khoản

- **Admin (chủ cửa hàng)**: toàn quyền dữ liệu; tạo tài khoản quản lý/nhân viên; đổi vai trò, khóa/mở khóa, đặt lại mật khẩu hoặc xóa tài khoản quản lý/nhân viên.
- **Quản lý**: toàn quyền dữ liệu và quản lý tài khoản quản lý/nhân viên; không thể thay đổi tài khoản Admin.
- **Nhân viên**: xem dữ liệu, thêm điện thoại và đơn bán; không sửa/xóa dữ liệu đã lưu, không quản lý tài khoản hoặc ghi khoản chi.

Tài khoản đầu tiên trong database trống có role `admin`. Tài khoản chủ cửa hàng cũ mang role `owner` được tự động nâng cấp thành `admin` khi backend khởi động. Sau đó chỉ admin hoặc quản lý đã đăng nhập mới tạo tài khoản trong tab **Tài khoản**. Backend kiểm tra quyền trên từng yêu cầu. Tài khoản bị khóa mất hiệu lực ngay ở các yêu cầu tiếp theo.

API quản lý tài khoản:

- `GET /api/accounts`: chủ cửa hàng và quản lý xem tài khoản trong cửa hàng.
- `POST /api/accounts`: tạo nhân viên; admin có thể chọn thêm vai trò quản lý.
- `PATCH /api/accounts/:id`: đổi vai trò hoặc khóa/mở khóa tài khoản mà người gọi có quyền quản lý.
- `POST /api/accounts/:id/reset-password`: admin/quản lý đặt mật khẩu mới cho tài khoản cấp dưới; phiên cũ của tài khoản đó bị vô hiệu.
- `DELETE /api/accounts/:id`: xóa thông tin đăng nhập tài khoản cấp dưới. Dữ liệu kho, đơn hàng và chi tiêu dùng chung của cửa hàng không bị xóa.
- `POST /api/change-password`: đổi mật khẩu tài khoản đang đăng nhập sau khi xác nhận mật khẩu hiện tại; các phiên đăng nhập cũ khác sẽ bị vô hiệu.
- `POST /api/forgot-password/admin`: Admin tự đặt lại mật khẩu bằng mã `ADMIN_RECOVERY_CODE`; mã này chỉ được đặt trong `.env` và không được lưu trong database.

## Cấu trúc dự án

- `config/`: cấu hình môi trường.
- `database/`: kết nối MongoDB, indexes và JWT secret.
- `middleware/`: xác thực và xử lý lỗi bất đồng bộ.
- `routes/`: endpoints đăng nhập và dữ liệu cửa hàng.
- `app.js`: cấu hình Express.
- `server.js`: kết nối database và khởi chạy HTTP server.

## 1. Chuẩn bị MongoDB Atlas

1. Tạo cluster và database user trong MongoDB Atlas.
2. Trong **Network Access**, cho phép địa chỉ IP của máy chạy backend.
3. Chọn **Connect → Drivers** và lấy connection string.
4. Thay thông tin mẫu trong connection string; nếu mật khẩu có ký tự đặc biệt, URL-encode chúng.
5. Đổi mật khẩu database user nếu URI hoặc mật khẩu đã từng được chia sẻ. Đặt URI trong `.env` cục bộ, không commit thông tin xác thực.

## 2. Cài dependencies và chạy backend

Yêu cầu Node.js 18 trở lên. Cài dependencies:

    npm install

Tạo `.env` từ `.env.example`, điền URI Atlas mới (không dùng lại mật khẩu đã chia sẻ) và tên database. Backend tự đọc `.env` khi khởi động; biến môi trường đã có trong PowerShell sẽ được ưu tiên hơn `.env`.

Ví dụ cấu hình cục bộ trong `.env`:

    MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0
    MONGODB_DB=cuahang
    ADMIN_RECOVERY_CODE=<long-random-secret-for-admin-password-recovery>

Khởi động:

    npm start

Khi thấy `HTTP server đang lắng nghe trên cổng 3000`, mở `http://localhost:3000`. Lần đầu, ứng dụng cho phép tạo tài khoản chủ cửa hàng.

## Deploy lên Render

Tạo một **Web Service** từ repository này (không chọn Static Site). Đặt:

- **Build Command:** `npm install`
- **Start Command:** `npm start`

Trong **Environment** của service, thêm `MONGODB_URI`, `MONGODB_DB` và các secret cần dùng như `JWT_SECRET` hoặc `ADMIN_RECOVERY_CODE`. Không thêm `PORT`: Render tự cấp cổng cho Web Service. Server sẽ lắng nghe trên `0.0.0.0` và phục vụ cả giao diện lẫn API từ cùng một địa chỉ. Sau khi deploy thành công, mở URL gốc của service, không phải URL bắt đầu bằng `/api`.

Nếu service báo live nhưng URL gốc không tải được, kiểm tra log khởi động và quyền truy cập mạng của MongoDB Atlas. Server chỉ bắt đầu lắng nghe sau khi kết nối MongoDB và khởi tạo index thành công.

## 3. Di trú dữ liệu từ MySQL

Script di trú sao chép tài khoản, kho hàng, giao dịch, chi phí và khóa JWT từ MySQL sang MongoDB. Script chỉ đọc MySQL, không xóa hoặc sửa dữ liệu nguồn. Database MongoDB đích phải trống; nếu đã có dữ liệu, script sẽ dừng để tránh ghi đè.

Trong cùng một cửa sổ PowerShell, đặt:

    $env:SOURCE_DATABASE_URL="mysql://<user>:<password>@127.0.0.1:3306/cuahang"
    $env:MONGODB_URI="<URI Atlas mới>"

Chạy di trú:

    npm run migrate:mysql-to-mongodb

Sau khi xác nhận số lượng dữ liệu đã di trú, chạy backend trong cùng cửa sổ PowerShell:

    npm start

Giữ nguyên bản MySQL làm bản sao lưu cho đến khi xác nhận ứng dụng hoạt động đúng trên MongoDB. Người dùng cần đăng nhập lại sau khi chuyển đổi.

## Biến môi trường

Xem `.env.example`: `MONGODB_URI`, `MONGODB_DB`, `PORT`, `JWT_SECRET` và tùy chọn `ADMIN_RECOVERY_CODE`. Hãy tạo mã khôi phục dài, ngẫu nhiên, giữ riêng tư và lưu ở nơi an toàn; không chia sẻ hoặc commit mã này. Nếu chưa cấu hình, khôi phục mật khẩu Admin sẽ không khả dụng. Script di trú dùng thêm `SOURCE_DATABASE_URL` (hoặc `DATABASE_URL` cũ) và tùy chọn `SOURCE_DB_SSL`.

Đặt `JWT_SECRET` cố định nếu cần giữ phiên đăng nhập qua các lần khởi động lại. Nếu bỏ trống, khóa được sinh và lưu trong collection `settings`. Người dùng có thể đổi mật khẩu từ nút **Đổi mật khẩu** sau khi đăng nhập; cần xác nhận mật khẩu hiện tại. Thay đổi sẽ vô hiệu các phiên đăng nhập cũ khác.

## Lỗi thường gặp

- Lỗi xác thực hoặc không chọn được máy chủ: kiểm tra URI, database user/password và **Network Access** trên Atlas.
- Không kết nối được MySQL khi di trú: kiểm tra MySQL đang chạy và `SOURCE_DATABASE_URL`.
- Database đích không trống: chọn database MongoDB trống mới hoặc sao lưu/xử lý dữ liệu đích trước khi chạy di trú lại.
