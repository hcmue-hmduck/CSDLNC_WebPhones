<div align="center">

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Fira+Code&weight=700&size=40&pause=1000&color=FF3D00&center=true&vCenter=true&width=600&lines=SMARTPHONE+E-COMMERCE;MODERN+MULTI-REGION+APP;HIGH-PERFORMANCE+DASHBOARD)](https://git.io/typing-svg)

<img src="https://img.shields.io/badge/Version-1.0.0-orange?style=for-the-badge" alt="Version" />
<img src="https://img.shields.io/badge/License-ISC-green?style=for-the-badge" alt="License" />
<img src="https://img.shields.io/badge/Status-Active-success?style=for-the-badge" alt="Status" />

<br/>

![NodeJS](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![SQL_Server](https://img.shields.io/badge/SQL_Server-CC2927?style=for-the-badge&logo=microsoftsqlserver&logoColor=white)
![Handlebars](https://img.shields.io/badge/Handlebars-000000?style=for-the-badge&logo=handlebarsdotjs&logoColor=white)

**Hệ thống Thương mại Điện tử Smartphone hiện đại với kiến trúc đa vùng, tích hợp Hybrid Database (SQL & NoSQL) và trình quản lý mạnh mẽ!**

</div>

---

## 🏗️ Kiến Trúc Hệ Thống (Hybrid Architecture)

Dự án sử dụng mô hình lưu trữ kết hợp (Hybrid Storage) để tối ưu hóa hiệu năng và tính nhất quán của dữ liệu:

- **SQL Server (Relational)**: Quản lý dữ liệu giao dịch, đơn hàng, tồn kho và biến thể sản phẩm theo vùng (Bắc - Trung - Nam).
- **MongoDB (NoSQL)**: Lưu trữ thông tin chi tiết sản phẩm, thông số kỹ thuật, và cấu hình Flash Sale linh hoạt.
- **Multi-Region Support**: Hệ thống tự động điều phối kết nối đến database SQL Server tương ứng dựa trên khu vực của người dùng/admin.

```text
WebBanSmartPhones/
├── app/
│   └── model/        # Định nghĩa Schema (Mongoose & SQL Queries)
├── public/           # Tài nguyên tĩnh (CSS, JS, Images)
├── views/            # Giao diện Handlebars (Admin & Client)
├── app.js            # Luồng xử lý chính và Routes (Entry Point)
├── server.js         # Quản lý kết nối Database (SQL & Mongo)
└── .env              # Cấu hình môi trường & Bảo mật
```

---

## 💎 Tính Năng Chủ Chốt

### ⚡ Hệ Thống Flash Sale Thời Gian Thực
- **Dynamic Status**: Tự động cập nhật trạng thái sự kiện (Đang diễn ra, Sắp diễn ra, Đã kết thúc).
- **Variant Binding**: Link trực tiếp biến thể từ SQL vào sự kiện Flash Sale trên MongoDB.
- **Stock Guard**: Kiểm soát số lượng bán ra và giới hạn mua của từng khách hàng.

### 🗺️ Quản Lý Đa Vùng (Multi-Region)
- **Region Switching**: Admin có thể quản lý kho hàng và đơn hàng theo từng vùng (Bắc, Trung, Nam).
- **Connection Pooling**: Tối ưu hóa kết nối SQL Server riêng biệt cho từng khu vực để đảm bảo tốc độ truy xuất.

### 📦 Quản Lý Sản Phẩm & Biến Thể
- **Variant Engine**: Hỗ trợ nhiều phiên bản (Màu sắc, Dung lượng) với giá và tồn kho riêng biệt.
- **Cloudinary Integration**: Tự động upload và tối ưu hóa hình ảnh/video sản phẩm lên mây.
- **Rich Specs**: Lưu trữ thông số kỹ thuật chi tiết không giới hạn nhờ sự linh hoạt của MongoDB.

### 🔐 Bảo Mật & Quản Trị
- **RBAC (Role-Based Access Control)**: Phân quyền đa cấp (User, Admin, Super Admin).
- **Session Management**: Duy trì phiên làm việc an toàn, tích hợp bảo mật Cookie.

---

## 💻 Tech Stack

### Backend Powerhouse
- **Framework**: Express.js 5.x (Next-gen Express).
- **Databases**: 
  - **SQL Server**: Transact-SQL, mssql library.
  - **MongoDB**: Mongoose (ODM).
- **File Storage**: Cloudinary SDK (Images/Videos).
- **Utilities**: Multer (Upload), Dotenv, Crypto, UUID.

### Frontend & UX/UI
- **View Engine**: Handlebars (HBS) - Tối ưu SEO và tốc độ render phía Server.
- **Layouts**: Hệ thống AdminMain chuyên nghiệp.
- **Libraries**: Bootstrap 5, FontAwesome 6, Lucide Icons.

---

## 🚀 Hướng Dẫn Cài Đặt

### 🛠️ Yêu cầu tiền đề
- **Node.js**: Phiên bản 18+ hoặc 20+.
- **Database**: 
  - SQL Server (Local hoặc Azure).
  - MongoDB (Local hoặc Atlas).

### ⚙️ Các bước thực hiện

1. **Clone project và cài đặt thư viện**:
   ```bash
   npm install
   ```

2. **Cấu hình môi trường**:
   Sao chép các thông số vào file `.env`:
   ```env
   # Database Connections
   MONGODB_URI=your_mongodb_uri
   SQL_SERVER=your_sql_server
   SQL_DATABASE=your_sql_db
   SQL_USER=your_username
   SQL_PASSWORD=your_password
   
   # Multi-region SQL (Optional)
   SQL_SERVER_BAC=...
   SQL_SERVER_TRUNG=...
   SQL_SERVER_NAM=...

   # Cloudinary Keys
   CLOUDINARY_CLOUD_NAME=...
   CLOUDINARY_API_KEY=...
   CLOUDINARY_API_SECRET=...

   # Session
   SESSION_SECRET=your_super_secret_key
   ```

3. **Khởi chạy ứng dụng**:
   ```bash
   # Chế độ phát triển (Nodemon)
   npm run start
   ```

---

<div align="center">

**Dự án được xây dựng với mục tiêu đem lại trải nghiệm mua sắm mượt mà và khả năng quản trị kho hàng quy mô lớn!**

---

*Made with ❤️ for WebBanSmartPhones*

</div>
