-- Thay your_db bằng tên DB
-- ALTER DATABASE [DB_WebPhone] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
-- DROP DATABASE [DB_WebPhone];



-- =============================================
-- DATABASE: QUẢN LÝ BÁN ĐIỆN THOẠI TRỰC TUYẾN
-- Hỗ trợ phân tán 3 clients: Bắc, Trung, Nam
-- =============================================
CREATE DATABASE DB_WebPhone;
GO

USE DB_WebPhone;
GO

-- =============================================
-- NHÓM 1: QUẢN LÝ ĐỊA LÝ & HÀNH CHÍNH
-- Mục đích: Quản lý vùng miền, tỉnh thành, phường xã
-- =============================================

-- 1. Bảng vùng miền (3 vùng: Bắc, Trung, Nam)
CREATE TABLE regions (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ma_vung NVARCHAR(10) UNIQUE NOT NULL CHECK (ma_vung IN (N'bac', N'trung', N'nam')),
    ten_vung NVARCHAR(50) NOT NULL,
    mo_ta NVARCHAR(500),
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE()
);
GO

-- 2. Bảng tỉnh/thành phố
CREATE TABLE provinces (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ma_tinh NVARCHAR(10) UNIQUE NOT NULL,
    ten_tinh NVARCHAR(100) NOT NULL,
    vung_id NVARCHAR(10) NOT NULL,
    is_major_city BIT DEFAULT 0,
    thu_tu_uu_tien INT DEFAULT 0,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (vung_id) REFERENCES regions(ma_vung)
);
GO

-- Index cho provinces
CREATE INDEX IDX_provinces_vung_id ON provinces(vung_id);
CREATE INDEX IDX_provinces_major_city ON provinces(is_major_city, thu_tu_uu_tien) WHERE is_major_city = 1;
GO

-- 3. Bảng phường/xã/thị trấn
CREATE TABLE wards (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ma_phuong_xa NVARCHAR(20) UNIQUE NOT NULL,
    ten_phuong_xa NVARCHAR(150) NOT NULL,
    tinh_thanh_id UNIQUEIDENTIFIER NOT NULL,
    loai NVARCHAR(20) DEFAULT N'xa' CHECK (loai IN (N'phuong', N'xa', N'thi_tran')),
    is_inner_area BIT DEFAULT 0,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (tinh_thanh_id) REFERENCES provinces(id) ON DELETE CASCADE
);
GO

-- Index cho wards
CREATE INDEX IDX_wards_tinh_thanh ON wards(tinh_thanh_id);
GO

-- =============================================
-- NHÓM 2: QUẢN LÝ SẢN PHẨM
-- Mục đích: Thương hiệu, danh mục, sản phẩm, biến thể
-- =============================================

-- 4. Bảng thương hiệu (Apple, Samsung, Xiaomi...)
-- Replicate: Toàn cục (tất cả vùng cùng dữ liệu)
CREATE TABLE brands (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ten_thuong_hieu NVARCHAR(100) NOT NULL,
    mo_ta NVARCHAR(500),
    logo_url NVARCHAR(500),
    slug NVARCHAR(255) UNIQUE,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE()
);
GO

-- 5. Bảng danh mục sản phẩm (Điện thoại, Tai nghe, Phụ kiện...)
-- Replicate: Toàn cục (tất cả vùng cùng dữ liệu)
CREATE TABLE categories (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ten_danh_muc NVARCHAR(100) NOT NULL,
    danh_muc_cha_id UNIQUEIDENTIFIER NULL,
    mo_ta NVARCHAR(500),
    slug NVARCHAR(255) UNIQUE,
    anh_url NVARCHAR(500),
    thu_tu INT DEFAULT 0,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (danh_muc_cha_id) REFERENCES categories(id),
    CHECK (thu_tu >= 0)
);
GO

-- 6. Bảng sản phẩm (Thông tin chung: tên, hình, mô tả)
-- Replicate: TOÀN CỤC - 1 site tạo product thì sync cả 3 server
-- Mô hình: Shared Products - Product KHÔNG thuộc vùng cụ thể, là master data chung
-- mongo_detail_id: Tham chiếu đến MongoDB ProductDetail document (_id)
--   - MongoDB lưu: thông số kỹ thuật, hình ảnh, videos chung
--   - SQL lưu: thông tin cơ bản (tên, mô tả, danh mục)
--   - Giá bán & tồn kho: Qua product_variants (mỗi vùng có variants riêng)
CREATE TABLE products (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ma_san_pham NVARCHAR(100) UNIQUE NOT NULL,
    ten_san_pham NVARCHAR(255) NOT NULL,
    danh_muc_id UNIQUEIDENTIFIER NOT NULL,
    thuong_hieu_id UNIQUEIDENTIFIER NOT NULL,
    gia_niem_yet DECIMAL(15,2) NOT NULL,
    gia_ban DECIMAL(15,2) NOT NULL,
    mo_ta_ngan NVARCHAR(500),
    link_anh_dai_dien NVARCHAR(500),
    mongo_detail_id NVARCHAR(50) NULL, -- MongoDB ObjectId string (tham chiếu ProductDetail._id)
    site_created NVARCHAR(10) NOT NULL CHECK (site_created IN (N'bac', N'trung', N'nam')), -- Site nào tạo product (để biết nguồn gốc)
    trang_thai BIT DEFAULT 1,
    luot_xem INT DEFAULT 0,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (danh_muc_id) REFERENCES categories(id),
    FOREIGN KEY (thuong_hieu_id) REFERENCES brands(id),
    CHECK (luot_xem >= 0)
);
GO

-- Index cho products (replicate toàn cục)
CREATE INDEX IDX_products_danh_muc ON products(danh_muc_id, trang_thai);
CREATE INDEX IDX_products_thuong_hieu ON products(thuong_hieu_id, trang_thai);
CREATE INDEX IDX_products_luot_xem ON products(luot_xem DESC) WHERE trang_thai = 1;
CREATE INDEX IDX_products_trang_thai ON products(trang_thai) INCLUDE (id, ten_san_pham, link_anh_dai_dien); -- Covering index cho product listing
GO

-- 7. Bảng biến thể sản phẩm (SKU, giá, màu sắc, dung lượng...)
-- Partition: Theo site_origin - MỖI VÙNG QUẢN LÝ VARIANTS RIÊNG
-- Mô hình: Regional Variants
--   - Product chung cho cả 3 vùng
--   - Mỗi vùng tự thêm variants riêng (màu sắc, dung lượng, giá khác nhau)
--   - Vùng Bắc có thể bán Blue 128GB giá 20tr
--   - Vùng Nam có thể bán White 256GB giá 22tr
--   - SKU phải unique toàn hệ thống để tránh trùng lặp
-- LƯU Ý: Variants lưu song song SQL + MongoDB
--   - SQL: Lưu thông tin giao dịch (giá, tồn kho, SKU) - id là UNIQUEIDENTIFIER
--   - MongoDB: Lưu trong ProductDetail.regional_variants object, key là site_origin
--   - Sync: Dùng id (UNIQUEIDENTIFIER) làm key duy nhất để map SQL ↔ MongoDB
CREATE TABLE product_variants (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    san_pham_id UNIQUEIDENTIFIER NOT NULL,
    ma_sku NVARCHAR(100) UNIQUE NOT NULL, -- SKU unique toàn hệ thống
    ten_hien_thi NVARCHAR(200) NOT NULL,
    gia_niem_yet DECIMAL(15,2) NOT NULL,
    gia_ban DECIMAL(15,2) NOT NULL,
    so_luong_ton_kho INT DEFAULT 0, -- Tồn kho hiện tại (tổng hợp từ inventory)
    luot_ban INT DEFAULT 0, -- Số lượng đã bán (thống kê)
    anh_dai_dien NVARCHAR(500),
    site_origin NVARCHAR(10) NOT NULL CHECK (site_origin IN (N'bac', N'trung', N'nam')), -- BẮT BUỘC: Variant thuộc vùng nào
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (san_pham_id) REFERENCES products(id) ON DELETE CASCADE,
    CHECK (gia_ban > 0),
    CHECK (gia_niem_yet >= gia_ban),
    CHECK (so_luong_ton_kho >= 0),
    CHECK (luot_ban >= 0)
);
GO

-- Index tối ưu cho product_variants (PARTITION theo site_origin)
CREATE INDEX IDX_product_variants_san_pham ON product_variants(san_pham_id);
CREATE INDEX IDX_product_variants_site_origin ON product_variants(site_origin, trang_thai); -- QUAN TRỌNG: Query theo vùng
CREATE INDEX IDX_product_variants_product_site ON product_variants(san_pham_id, site_origin); -- Query variants của 1 product ở 1 vùng
CREATE INDEX IDX_product_variants_gia_ban ON product_variants(gia_ban);
CREATE INDEX IDX_product_variants_sku ON product_variants(ma_sku); -- Tìm nhanh theo SKU (unique)
GO

-- =============================================
-- NHÓM 3: QUẢN LÝ NGƯỜI DÙNG
-- Mục đích: Tài khoản, địa chỉ giao hàng
-- =============================================

-- 8. Bảng người dùng (Khách hàng & nhân viên)
-- Partition: Theo vung_id (user thuộc vùng nào)
-- vai_tro: 'customer' | 'admin' | 'super_admin'
--   - customer: Khách hàng thông thường
--   - admin: Quản trị vùng (chỉ quản lý site_registered của mình)
--   - super_admin: Quản trị toàn hệ thống (quản lý cả 3 sites)
-- site_registered: Site đăng ký (với super_admin thì bất kỳ site nào cũng được, chỉ để lưu lịch sử)
CREATE TABLE users (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    email NVARCHAR(255) UNIQUE NOT NULL,
    mat_khau NVARCHAR(255) NOT NULL,
    ho_ten NVARCHAR(100),
    so_dien_thoai NVARCHAR(20),
    vai_tro NVARCHAR(20) DEFAULT N'customer' CHECK (vai_tro IN (N'super_admin', N'admin', N'customer')),
    vung_id NVARCHAR(10) NOT NULL DEFAULT N'bac' CHECK (vung_id IN (N'bac', N'trung', N'nam')),
    site_registered NVARCHAR(10) NOT NULL CHECK (site_registered IN (N'bac', N'trung', N'nam')),
    mongo_profile_id NVARCHAR(50) NULL,
    trang_thai BIT DEFAULT 1,
    ngay_dang_ky DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (vung_id) REFERENCES regions(ma_vung)
);
GO

-- Index partition theo vung_id
CREATE INDEX IDX_users_vung_id ON users(vung_id, trang_thai); -- Filter by region and status
CREATE INDEX IDX_users_site_registered ON users(site_registered);
CREATE INDEX IDX_users_vai_tro ON users(vai_tro) WHERE vai_tro != N'customer';
CREATE INDEX IDX_users_so_dien_thoai ON users(so_dien_thoai) WHERE so_dien_thoai IS NOT NULL; -- Phone lookup
GO

-- 9. Bảng địa chỉ người dùng (Nhà riêng, công ty, giao hàng...)
-- Partition: Theo user (kế thừa vung_id từ users)
CREATE TABLE user_addresses (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    user_id UNIQUEIDENTIFIER NOT NULL,
    loai_dia_chi NVARCHAR(20) CHECK(loai_dia_chi IN (N'nha_rieng', N'cong_ty', N'giao_hang')) DEFAULT N'nha_rieng',
    is_default BIT DEFAULT 0,
    ten_nguoi_nhan NVARCHAR(100) NOT NULL,
    sdt_nguoi_nhan VARCHAR(15) NOT NULL,
    phuong_xa_id UNIQUEIDENTIFIER NOT NULL,
    dia_chi_cu_the NVARCHAR(200) NOT NULL,
    ghi_chu NVARCHAR(500),
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    trang_thai BIT DEFAULT 1,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (phuong_xa_id) REFERENCES wards(id)
);
GO

-- Index cho user_addresses
CREATE INDEX IDX_user_addresses_user ON user_addresses(user_id, is_default);
CREATE INDEX IDX_user_addresses_phuong_xa ON user_addresses(phuong_xa_id);
GO

-- =============================================
-- NHÓM 4: QUẢN LÝ KHO & TỒN KHO
-- Mục đích: Kho hàng, tồn kho theo variant
-- =============================================

-- 10. Bảng kho hàng (Mỗi vùng có 1 kho)
-- Partition: Theo vung_id (mỗi vùng quản lý kho riêng)
CREATE TABLE warehouses (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ten_kho NVARCHAR(100) NOT NULL,
    vung_id NVARCHAR(10) NOT NULL CHECK (vung_id IN (N'bac', N'trung', N'nam')),
    phuong_xa_id UNIQUEIDENTIFIER NOT NULL,
    dia_chi_chi_tiet NVARCHAR(255) NOT NULL,
    so_dien_thoai NVARCHAR(20),
    trang_thai BIT DEFAULT 1,
    priority_levels INT DEFAULT 0,
    is_primary BIT DEFAULT 0,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (phuong_xa_id) REFERENCES wards(id),
    FOREIGN KEY (vung_id) REFERENCES regions(ma_vung)
);
GO

-- Index cho priority
CREATE INDEX IDX_warehouses_priority ON warehouses(vung_id, priority_levels DESC, is_primary DESC) 
    WHERE trang_thai = 1;
GO

-- 11. Bảng tồn kho (Số lượng sản phẩm trong từng kho)
-- Partition: Theo kho (mỗi vùng quản lý inventory riêng)
CREATE TABLE inventory (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    variant_id UNIQUEIDENTIFIER NOT NULL,
    kho_id UNIQUEIDENTIFIER NOT NULL,
    so_luong_kha_dung INT NOT NULL DEFAULT 0,
    so_luong_da_dat INT NOT NULL DEFAULT 0,
    muc_ton_kho_toi_thieu INT DEFAULT 10,
    so_luong_nhap_lai INT DEFAULT 50,
    lan_nhap_hang_cuoi DATETIME2 NULL,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (variant_id) REFERENCES product_variants(id),
    FOREIGN KEY (kho_id) REFERENCES warehouses(id),
    CONSTRAINT UQ_inventory_variant_kho UNIQUE (variant_id, kho_id),
    CHECK (so_luong_kha_dung >= 0),
    CHECK (so_luong_da_dat >= 0),
    CHECK (muc_ton_kho_toi_thieu >= 0),
    CHECK (so_luong_nhap_lai >= 0)
);
GO

-- Index tối ưu cho inventory
CREATE INDEX IDX_inventory_variant ON inventory(variant_id);
CREATE INDEX IDX_inventory_kho ON inventory(kho_id);
-- CREATE INDEX IDX_inventory_low_stock 
--     ON inventory(kho_id, so_luong_kha_dung, muc_ton_kho_toi_thieu) 
--     WHERE so_luong_kha_dung <= muc_ton_kho_toi_thieu; -- Low stock alerts
GO

-- =============================================
-- NHÓM 5: QUẢN LÝ VẬN CHUYỂN
-- Mục đích: Phương thức vận chuyển, chi phí theo vùng
-- =============================================

-- 12. Bảng phương thức vận chuyển (Tiêu chuẩn, Nhanh, Hỏa tốc)
CREATE TABLE shipping_methods (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ten_phuong_thuc NVARCHAR(100) NOT NULL,
    mo_ta NVARCHAR(500),
    chi_phi_co_ban DECIMAL(15,2) NOT NULL,
    mongo_config_id NVARCHAR(50) NULL,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    CHECK (chi_phi_co_ban >= 0)
);
GO

-- 13. Bảng chi phí vận chuyển theo vùng
CREATE TABLE shipping_method_regions (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    shipping_method_id UNIQUEIDENTIFIER NOT NULL,
    region_id NVARCHAR(10) NOT NULL,
    chi_phi_van_chuyen DECIMAL(15,2) NOT NULL DEFAULT 0,
    thoi_gian_giao_du_kien INT NULL,
    mongo_region_config_id NVARCHAR(50) NULL,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (shipping_method_id) REFERENCES shipping_methods(id) ON DELETE CASCADE,
    FOREIGN KEY (region_id) REFERENCES regions(ma_vung),
    CONSTRAINT UQ_shipping_method_region UNIQUE (shipping_method_id, region_id),
    CHECK (chi_phi_van_chuyen >= 0),
    CHECK (thoi_gian_giao_du_kien IS NULL OR thoi_gian_giao_du_kien > 0)
);
GO

-- Index cho shipping_method_regions
CREATE INDEX IDX_shipping_method_regions_region ON shipping_method_regions(region_id, trang_thai);
GO

-- =============================================
-- NHÓM 6: KHUYẾN MÃI & VOUCHER
-- Mục đích: Voucher giảm giá, áp dụng cho sản phẩm
-- =============================================

-- 14. Bảng voucher (Mã giảm giá)
-- Partition: Theo vung_id (voucher thuộc vùng nào - để filter replication)
CREATE TABLE vouchers (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ma_voucher NVARCHAR(50) UNIQUE NOT NULL,
    ten_voucher NVARCHAR(255) NOT NULL,
    mo_ta NVARCHAR(500),
    loai_giam_gia NVARCHAR(20) NOT NULL CHECK (loai_giam_gia IN (N'phantram', N'tiengiam', N'mienphi')),
    gia_tri_giam DECIMAL(15,2) NOT NULL,
    gia_tri_toi_da DECIMAL(15,2) NULL,
    don_hang_toi_thieu DECIMAL(15,2) DEFAULT 0,
    so_luong INT NOT NULL,
    da_su_dung INT DEFAULT 0,
    ngay_bat_dau DATETIME2 NOT NULL,
    ngay_ket_thuc DATETIME2 NOT NULL,
    mongo_voucher_detail_id NVARCHAR(50) NULL,
    nguoi_tao UNIQUEIDENTIFIER NOT NULL,
    vung_id NVARCHAR(10) NOT NULL CHECK (vung_id IN (N'bac', N'trung', N'nam')),
    pham_vi NVARCHAR(20) DEFAULT N'toan_cuc' CHECK (pham_vi IN (N'toan_cuc', N'theo_san_pham', N'theo_danh_muc')),
    loai_voucher NVARCHAR(50) NULL,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (nguoi_tao) REFERENCES users(id),
    FOREIGN KEY (vung_id) REFERENCES regions(ma_vung),
    CHECK (gia_tri_giam > 0),
    CHECK (don_hang_toi_thieu >= 0),
    CHECK (so_luong > 0),
    CHECK (da_su_dung >= 0 AND da_su_dung <= so_luong),
    CHECK (ngay_bat_dau < ngay_ket_thuc),
    CHECK ((loai_giam_gia = N'phantram' AND gia_tri_giam <= 100) OR loai_giam_gia != N'phantram')
);
GO

-- Index partition theo vung_id (KEY cho replication filter)
CREATE INDEX IDX_vouchers_vung_id ON vouchers(vung_id, trang_thai, ngay_bat_dau, ngay_ket_thuc); -- Active vouchers lookup
CREATE INDEX IDX_vouchers_ma_voucher ON vouchers(ma_voucher, trang_thai) WHERE trang_thai = 1; -- Voucher code validation
GO

-- 15. Bảng áp dụng voucher cho sản phẩm
CREATE TABLE voucher_products (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    voucher_id UNIQUEIDENTIFIER NOT NULL,
    san_pham_id UNIQUEIDENTIFIER NOT NULL,
    -- vung_id NVARCHAR(10) NOT NULL CHECK (vung_id IN (N'bac', N'trung', N'nam')),
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
    FOREIGN KEY (san_pham_id) REFERENCES product_variants(id),
    -- FOREIGN KEY (vung_id) REFERENCES regions(ma_vung),
    CONSTRAINT UQ_voucher_products_voucher_sanpham UNIQUE (voucher_id, san_pham_id)
);
GO

-- Index cho voucher_products
CREATE INDEX IDX_voucher_products_san_pham ON voucher_products(san_pham_id);
GO

-- =============================================
-- NHÓM 7: FLASH SALE
-- Mục đích: Chương trình flash sale, sản phẩm giảm giá sốc
-- =============================================

-- 17. Bảng chương trình flash sale
-- Partition: Theo vung_id (flash sale thuộc vùng nào - để filter replication)
CREATE TABLE flash_sales (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ten_flash_sale NVARCHAR(255) NOT NULL,
    mo_ta NVARCHAR(500),
    ngay_bat_dau DATETIME2 NOT NULL,
    ngay_ket_thuc DATETIME2 NOT NULL,
    mongo_flash_sale_detail_id NVARCHAR(50) NULL,
    vung_id NVARCHAR(10) NOT NULL CHECK (vung_id IN (N'bac', N'trung', N'nam')),
    trang_thai NVARCHAR(20) DEFAULT N'cho' CHECK (trang_thai IN (N'cho', N'dang_dien_ra', N'da_ket_thuc', N'huy')),
    nguoi_tao UNIQUEIDENTIFIER NOT NULL,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (nguoi_tao) REFERENCES users(id),
    FOREIGN KEY (vung_id) REFERENCES regions(ma_vung),
    CHECK (ngay_bat_dau < ngay_ket_thuc)
);
GO

-- Index partition theo vung_id (KEY cho replication filter)
CREATE INDEX IDX_flash_sales_vung_id ON flash_sales(vung_id, trang_thai, ngay_bat_dau, ngay_ket_thuc); -- Active flash sales lookup
GO

-- 18. Bảng sản phẩm trong flash sale
CREATE TABLE flash_sale_items (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    flash_sale_id UNIQUEIDENTIFIER NOT NULL,
    variant_id UNIQUEIDENTIFIER NOT NULL,
    gia_goc DECIMAL(15,2) NOT NULL,
    gia_flash_sale DECIMAL(15,2) NOT NULL,
    so_luong_ton INT NOT NULL,
    da_ban INT DEFAULT 0,
    gioi_han_mua INT NULL,
    thu_tu INT DEFAULT 0,
    trang_thai NVARCHAR(20) DEFAULT N'dang_ban' CHECK (trang_thai IN (N'dang_ban', N'het_hang', N'tam_dung')),
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (flash_sale_id) REFERENCES flash_sales(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id),
    CONSTRAINT UQ_flash_sale_variant UNIQUE (flash_sale_id, variant_id),
    CHECK (gia_flash_sale < gia_goc),
    CHECK (gia_flash_sale > 0),
    CHECK (so_luong_ton >= 0),
    CHECK (da_ban >= 0 AND da_ban <= so_luong_ton),
    CHECK (gioi_han_mua IS NULL OR gioi_han_mua > 0),
    CHECK (thu_tu >= 0)
);
GO

-- Index cho flash_sale_items
CREATE INDEX IDX_flash_sale_items_flash_sale ON flash_sale_items(flash_sale_id, thu_tu);
CREATE INDEX IDX_flash_sale_items_variant ON flash_sale_items(variant_id);
GO

-- =============================================
-- NHÓM 8: ĐƠN HÀNG & THANH TOÁN
-- Mục đích: Đơn hàng, chi tiết, thanh toán, lịch sử
-- =============================================

-- 20. Bảng đơn hàng
-- Partition: Theo vung_don_hang (đơn hàng thuộc vùng nào)
CREATE TABLE orders (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    ma_don_hang NVARCHAR(50) UNIQUE NOT NULL,
    nguoi_dung_id UNIQUEIDENTIFIER NOT NULL,
    vung_don_hang NVARCHAR(10) NOT NULL DEFAULT N'bac' CHECK (vung_don_hang IN (N'bac', N'trung', N'nam')),
    site_processed NVARCHAR(10) NOT NULL CHECK (site_processed IN (N'bac', N'trung', N'nam')),
    shipping_method_region_id UNIQUEIDENTIFIER NOT NULL,
    dia_chi_giao_hang_id UNIQUEIDENTIFIER NOT NULL,
    is_split_order BIT DEFAULT 0,
    kho_giao_hang UNIQUEIDENTIFIER NOT NULL,
    voucher_id UNIQUEIDENTIFIER NULL,
    tong_tien_hang DECIMAL(15,2) NOT NULL,
    phi_van_chuyen DECIMAL(15,2) DEFAULT 0,
    chi_phi_noi_bo DECIMAL(15,2) DEFAULT 0,
    gia_tri_giam_voucher DECIMAL(15,2) DEFAULT 0,
    tong_thanh_toan DECIMAL(15,2) NOT NULL,
    payment_method NVARCHAR(50),
    ghi_chu_order NVARCHAR(MAX),
    trang_thai NVARCHAR(20) DEFAULT N'cho_xac_nhan' CHECK (trang_thai IN (N'cho_xac_nhan', N'dang_xu_ly', N'dang_giao', N'hoan_thanh', N'huy')),
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (nguoi_dung_id) REFERENCES users(id),
    FOREIGN KEY (vung_don_hang) REFERENCES regions(ma_vung),
    FOREIGN KEY (shipping_method_region_id) REFERENCES shipping_method_regions(id),
    FOREIGN KEY (dia_chi_giao_hang_id) REFERENCES user_addresses(id),
    FOREIGN KEY (kho_giao_hang) REFERENCES warehouses(id),
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
    CHECK (tong_tien_hang >= 0),
    CHECK (phi_van_chuyen >= 0),
    CHECK (gia_tri_giam_voucher >= 0),
    CHECK (tong_thanh_toan >= 0),
);
GO

-- Index partition theo vung_don_hang (KEY cho replication)
CREATE INDEX IDX_orders_vung_don_hang ON orders(vung_don_hang);
CREATE INDEX IDX_orders_site_processed ON orders(site_processed);
CREATE INDEX IDX_orders_nguoi_dung ON orders(nguoi_dung_id);
CREATE INDEX IDX_orders_ngay_tao ON orders(ngay_tao DESC);
GO

-- 21. Bảng chi tiết đơn hàng
CREATE TABLE order_details (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    don_hang_id UNIQUEIDENTIFIER NOT NULL,
    variant_id UNIQUEIDENTIFIER NOT NULL,
    warehouse_id UNIQUEIDENTIFIER NOT NULL,
    warehouse_region NVARCHAR(10) NOT NULL,
    flash_sale_item_id UNIQUEIDENTIFIER NULL,
    so_luong INT NOT NULL,
    don_gia DECIMAL(15,2) NOT NULL,
    thanh_tien DECIMAL(15,2) NOT NULL,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (don_hang_id) REFERENCES orders(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id),
    FOREIGN KEY (flash_sale_item_id) REFERENCES flash_sale_items(id),
    CHECK (so_luong > 0),
    CHECK (don_gia >= 0),
    CHECK (thanh_tien = so_luong * don_gia)
);
GO

-- Index cho order_details
CREATE INDEX IDX_order_details_don_hang ON order_details(don_hang_id);
CREATE INDEX IDX_order_details_variant ON order_details(variant_id, ngay_tao DESC); -- Variant sales analytics
CREATE INDEX IDX_order_details_flash_sale ON order_details(flash_sale_item_id) WHERE flash_sale_item_id IS NOT NULL; -- Flash sale orders
CREATE INDEX IDX_order_details_warehouse ON order_details(warehouse_id);
CREATE INDEX IDX_order_details_warehouse_region ON order_details(warehouse_region);
GO

-- 22. Bảng thanh toán
CREATE TABLE payments (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    don_hang_id UNIQUEIDENTIFIER NOT NULL,
    phuong_thuc NVARCHAR(20) NOT NULL CHECK (phuong_thuc IN (N'cod', N'credit_card', N'momo', N'vnpay')),
    so_tien DECIMAL(15,2) NOT NULL,
    mongo_payment_detail_id NVARCHAR(50) NULL,
    trang_thai NVARCHAR(20) DEFAULT N'pending' CHECK (trang_thai IN (N'pending', N'success', N'failed', N'refunded')),
    ma_giao_dich NVARCHAR(100) NULL,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (don_hang_id) REFERENCES orders(id),
    CHECK (so_tien > 0)
);
GO

-- Index cho payments
CREATE INDEX IDX_payments_don_hang ON payments(don_hang_id);
CREATE INDEX IDX_payments_ma_giao_dich ON payments(ma_giao_dich) WHERE ma_giao_dich IS NOT NULL; -- Transaction lookup
CREATE INDEX IDX_payments_trang_thai ON payments(trang_thai, ngay_tao DESC); -- Payment status tracking
GO

-- 23. Bảng lịch sử trạng thái đơn hàng
CREATE TABLE order_status_history (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    don_hang_id UNIQUEIDENTIFIER NOT NULL,
    trang_thai_cu NVARCHAR(20),
    trang_thai_moi NVARCHAR(20) NOT NULL,
    ghi_chu NVARCHAR(500),
    nguoi_thao_tac UNIQUEIDENTIFIER NOT NULL,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (don_hang_id) REFERENCES orders(id),
    FOREIGN KEY (nguoi_thao_tac) REFERENCES users(id)
);
GO

-- Index cho order_status_history
CREATE INDEX IDX_order_status_history_don_hang ON order_status_history(don_hang_id, ngay_tao DESC); -- Order timeline
CREATE INDEX IDX_order_status_history_nguoi_thao_tac ON order_status_history(nguoi_thao_tac) WHERE nguoi_thao_tac IS NOT NULL; -- Admin activity tracking
GO

-- =============================================
-- QUAY LẠI NHÓM 6: Tạo bảng used_vouchers (cần orders)
-- =============================================

-- 16. Bảng voucher đã sử dụng
CREATE TABLE used_vouchers (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    voucher_id UNIQUEIDENTIFIER NOT NULL,
    nguoi_dung_id UNIQUEIDENTIFIER NOT NULL,
    don_hang_id UNIQUEIDENTIFIER NOT NULL,
    gia_tri_giam DECIMAL(15,2) NOT NULL,
    ngay_su_dung DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
    FOREIGN KEY (nguoi_dung_id) REFERENCES users(id),
    FOREIGN KEY (don_hang_id) REFERENCES orders(id),
    CONSTRAINT UQ_used_vouchers_don_hang UNIQUE (don_hang_id), -- Mỗi đơn hàng chỉ dùng 1 voucher
    CHECK (gia_tri_giam > 0)
);
GO

-- Index cho used_vouchers
CREATE INDEX IDX_used_vouchers_don_hang ON used_vouchers(don_hang_id);
CREATE INDEX IDX_used_vouchers_voucher ON used_vouchers(voucher_id, ngay_su_dung DESC); -- Voucher usage analytics
CREATE INDEX IDX_used_vouchers_nguoi_dung ON used_vouchers(nguoi_dung_id, ngay_su_dung DESC); -- User voucher history
GO

-- =============================================
-- QUAY LẠI NHÓM 7: Tạo bảng flash_sale_orders (cần orders)
-- =============================================

-- 19. Bảng lịch sử mua flash sale
CREATE TABLE flash_sale_orders (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    flash_sale_item_id UNIQUEIDENTIFIER NOT NULL,
    nguoi_dung_id UNIQUEIDENTIFIER NOT NULL,
    don_hang_id UNIQUEIDENTIFIER NOT NULL,
    so_luong INT NOT NULL,
    gia_flash_sale DECIMAL(15,2) NOT NULL,
    ngay_mua DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (flash_sale_item_id) REFERENCES flash_sale_items(id),
    FOREIGN KEY (nguoi_dung_id) REFERENCES users(id),
    FOREIGN KEY (don_hang_id) REFERENCES orders(id),
    CHECK (so_luong > 0),
    CHECK (gia_flash_sale > 0)
);
GO

-- Index cho flash_sale_orders
CREATE INDEX IDX_flash_sale_orders_item ON flash_sale_orders(flash_sale_item_id, ngay_mua DESC); -- Flash sale item analytics
CREATE INDEX IDX_flash_sale_orders_nguoi_dung ON flash_sale_orders(nguoi_dung_id, ngay_mua DESC); -- User flash sale history
CREATE INDEX IDX_flash_sale_orders_don_hang ON flash_sale_orders(don_hang_id); -- Order flash sale lookup
GO

-- =============================================
-- NHÓM 9: GIỎ HÀNG
-- Mục đích: Giỏ hàng tạm của khách hàng
-- =============================================

-- 24. Bảng giỏ hàng
-- Partition: Theo vung_id (giỏ hàng thuộc vùng nào)
CREATE TABLE carts (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    nguoi_dung_id UNIQUEIDENTIFIER NOT NULL,
    vung_id NVARCHAR(10) NOT NULL DEFAULT N'bac' CHECK (vung_id IN (N'bac', N'trung', N'nam')),
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (nguoi_dung_id) REFERENCES users(id),
    FOREIGN KEY (vung_id) REFERENCES regions(ma_vung)
);
GO

-- Index partition theo vung_id (mỗi user chỉ có 1 cart per region)
CREATE UNIQUE INDEX UQ_carts_nguoi_dung_vung ON carts(nguoi_dung_id, vung_id); -- One cart per user per region
CREATE INDEX IDX_carts_vung_id ON carts(vung_id, ngay_cap_nhat DESC); -- Cart activity by region
GO

-- 25. Bảng sản phẩm trong giỏ hàng
CREATE TABLE cart_items (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    gio_hang_id UNIQUEIDENTIFIER NOT NULL,
    variant_id UNIQUEIDENTIFIER NOT NULL,
    so_luong INT NOT NULL DEFAULT 1,
    ngay_them DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (gio_hang_id) REFERENCES carts(id) ON DELETE CASCADE,
    FOREIGN KEY (variant_id) REFERENCES product_variants(id),
    CONSTRAINT UQ_cart_items_gio_hang_variant UNIQUE (gio_hang_id, variant_id),
    CHECK (so_luong > 0)
);
GO

-- Index cho cart_items
CREATE INDEX IDX_cart_items_gio_hang ON cart_items(gio_hang_id);
CREATE INDEX IDX_cart_items_variant ON cart_items(variant_id); -- Check variant in carts
GO

-- =============================================
-- NHÓM 10: ĐÁNH GIÁ & PHẢN HỒI
-- Mục đích: Đánh giá sản phẩm của khách hàng
-- =============================================

-- 26. Bảng đánh giá sản phẩm
CREATE TABLE reviews (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    san_pham_id UNIQUEIDENTIFIER NOT NULL,
    nguoi_dung_id UNIQUEIDENTIFIER NOT NULL,
    don_hang_id UNIQUEIDENTIFIER NOT NULL,
    diem_danh_gia INT NOT NULL CHECK (diem_danh_gia BETWEEN 1 AND 5),
    tieu_de NVARCHAR(255),
    mongo_review_content_id NVARCHAR(50) NULL,
    trang_thai BIT DEFAULT 1,
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_cap_nhat DATETIME2 DEFAULT GETDATE(),
    FOREIGN KEY (san_pham_id) REFERENCES products(id),
    FOREIGN KEY (nguoi_dung_id) REFERENCES users(id),
    FOREIGN KEY (don_hang_id) REFERENCES orders(id)
);
GO

-- Index cho reviews
CREATE INDEX IDX_reviews_san_pham ON reviews(san_pham_id, trang_thai, ngay_tao DESC) INCLUDE (diem_danh_gia); -- Product rating aggregation
CREATE INDEX IDX_reviews_nguoi_dung ON reviews(nguoi_dung_id, ngay_tao DESC);
CREATE INDEX IDX_reviews_don_hang ON reviews(don_hang_id); -- Order review lookup
GO

-- =============================================
-- NHÓM 11: BẢO MẬT & XÁC THỰC
-- Mục đích: Mã OTP xác thực tài khoản
-- =============================================

-- 27. Bảng mã OTP
CREATE TABLE otp_codes (
    id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWSEQUENTIALID(),
    email NVARCHAR(255) NOT NULL,
    ma_otp NVARCHAR(10) NOT NULL,
    loai_otp NVARCHAR(20) DEFAULT N'register' CHECK (loai_otp IN (N'register', N'forgot_password', N'verify_email')),
    ngay_tao DATETIME2 DEFAULT GETDATE(),
    ngay_het_han DATETIME2 NOT NULL,
    da_su_dung BIT DEFAULT 0,
    CHECK (ngay_het_han > ngay_tao)
);
GO

-- Index cho otp_codes
CREATE INDEX IDX_otp_codes_email ON otp_codes(email, da_su_dung, ngay_het_han DESC); -- OTP validation
-- Tạo chỉ mục cho những bản ghi đã được sử dụng (da_su_dung = 1)
CREATE INDEX IDX_otp_codes_cleanup_used
ON otp_codes(ngay_het_han)
WHERE da_su_dung = 1;

-- Tạo chỉ mục cho những bản ghi đã hết hạn (ngay_het_han < GETDATE())
-- DECLARE @Today DATETIME = GETDATE();
-- CREATE INDEX IDX_otp_codes_cleanup_expired 
-- ON otp_codes(ngay_het_han) 
-- WHERE ngay_het_han < @Today;


GO

-- =============================================
-- KẾT THÚC SCRIPT TẠO DATABASE
-- Tổng: 27 bảng được nhóm thành 11 nhóm chức năng
-- =============================================


