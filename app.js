import express from 'express';
import session from 'express-session';
import { engine } from 'express-handlebars';
import db from './server.js';
import DataModel from './app/model/index.js';
import sql from 'mssql';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import mongoose, { mongo } from 'mongoose';

import multer from 'multer';
import path from 'path';
import fs from 'fs';
// import cors from 'cors';

import dotenv from 'dotenv';
dotenv.config();

import { v2 as cloudinary } from 'cloudinary';
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

console.log('☁️ Cloudinary config:', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY ? '✓ Set' : '✗ Missing',
  api_secret: process.env.CLOUDINARY_API_SECRET ? '✓ Set' : '✗ Missing'
});

// Import SQL config từ server.js (tránh duplicate)
const sqlConfig = db.dbConfig;

// ✅ Kết nối databases
await db.connectAllDB();

// ✅ Set global default pool cho DataModel (backward compatibility)
sql.globalConnectionPool = db.connectionPools.default;

const app = express();

// Helper function to ensure all variants have variant_id
// If no variants exist, create default variant using sql_product_id
function ensureVariantIds(variants, sqlProductId = null) {
    if (!variants || typeof variants !== 'object') {
        variants = {
            variant_options: [],
            variant_combinations: []
        };
    }
    
    // Ensure variant_combinations exist
    if (!variants.variant_combinations || !Array.isArray(variants.variant_combinations)) {
        variants.variant_combinations = [];
    }
    
    // If no real variants, create default variant using sql_product_id
    if (variants.variant_combinations.length === 0 && sqlProductId) {
        variants.variant_combinations = [{
            variant_id: sqlProductId, // Use SQL product ID as variant_id
            name: 'Mặc định',
            is_default: true,
            price: null, // Will be set from product price
            original_price: null,
            stock: null,
            sku: null
        }];
        console.log('✅ Created default variant with variant_id:', sqlProductId);
    } else if (variants.variant_combinations.length > 0) {
        // Real variants exist - auto-generate UUID for each if missing
        variants.variant_combinations = variants.variant_combinations.map(combo => {
            if (!combo.variant_id) {
                combo.variant_id = crypto.randomUUID();
                console.log('✅ Generated variant_id:', combo.variant_id, 'for', combo.name);
            }
            // Remove is_default flag from real variants
            if (combo.is_default) {
                delete combo.is_default;
            }
            return combo;
        });
    }
    
    return variants;
}


// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
// Map legacy `/images` URL path to actual `public/image` folder
app.use('/images', express.static(path.join(process.cwd(), 'public', 'image')));

// Session middleware
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // set true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Authentication middleware
function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.redirect('/login?redirect=' + encodeURIComponent(req.originalUrl));
    }
    next();
}

// Admin authentication middleware (chỉ admin và super_admin)
// ✅ Inject DB connection based on admin's vung_id
const requireAdmin = [
    async (req, res, next) => {
        if (!req.session || !req.session.user) {
            return res.redirect('/admin-login?redirect=' + encodeURIComponent(req.originalUrl));
        }
        
        const userRole = req.session.user.vai_tro;
        if (userRole !== 'admin' && userRole !== 'super_admin') {
            return res.status(403).send('Access Denied: Chỉ admin mới có quyền truy cập');
        }
        
        // ✅ Inject DB connection based on admin's region
        try {
            const vungId = req.session.user.vung_id;
            req.dbPool = await db.getConnectionByRegion(vungId);
            console.log(`✅ Admin DB pool injected for region: ${vungId}`);
        } catch (err) {
            console.error('❌ Error injecting admin DB connection:', err);
            req.dbPool = db.connectionPools.default; // Fallback
        }
        
        next();
    }
];

// Middleware để inject pool cho admin (cho API routes)
// Nếu admin logged in → dùng pool theo vùng, không thì dùng default
const injectPoolForAdmin = async (req, res, next) => {
    try {
        if (req.session?.user?.vung_id && 
            (req.session.user.vai_tro === 'admin' || req.session.user.vai_tro === 'super_admin')) {
            req.dbPool = await db.getConnectionByRegion(req.session.user.vung_id);
            console.log(`✅ Admin API call - Using pool for region: ${req.session.user.vung_id}`);
        } else {
            req.dbPool = db.connectionPools.default;
            console.log(`ℹ️ Public/User API call - Using default pool`);
        }
        next();
    } catch (err) {
        console.error('❌ Error in injectPoolForAdmin:', err);
        req.dbPool = db.connectionPools.default;
        next();
    }
};

// Handlebars setup
app.engine('handlebars', engine({
    defaultLayout: 'AdminMain',
    helpers: {
        eq: (a, b) => a===b,
        gt: (a, b) => a > b,
        json: (context) => {
            return JSON.stringify(context);
        },
        formatNumber: (price) => {
            return new Intl.NumberFormat('vi-VN').format(price);
        },
        formatDate: (dateString) => {
            if (!dateString) return 'N/A';
            const date = new Date(dateString);
            return date.toLocaleDateString('vi-VN');
        },
        getCategoryNameById: (categoryId, categories) => {
            const category = categories.find(cat => cat._id.toString() === categoryId.toString());
            return category ? category.ten_danh_muc : 'Không tìm thấy';
        },
        formatCurrency: (amount) => {
          if (typeof amount !== 'number') {
            amount = parseFloat(amount) || 0;
          }
          return new Intl.NumberFormat('vi-VN', {
            style: 'currency',
            currency: 'VND'
          }).format(amount);
        },
        countProperties: (obj) => {
          if (!obj) return 0;
          return Object.keys(obj).length;
        },
    }
}));
app.set('view engine', 'handlebars');
app.set('views', './views');

// Global middleware để load data cho header (regions, categories)
app.use(async (req, res, next) => {
    try {
        // Load regions và categories cho tất cả các view
        const regions = await DataModel.SQL.Region.findAll();
        const categories = await DataModel.SQL.Category.findAll();
        
        // Thêm vào res.locals để có sẵn trong tất cả view
        res.locals.regions = regions;
        res.locals.categories = categories;
        
        next();
    } catch (error) {
        console.error('❌ Error loading global data:', error);
        // Vẫn tiếp tục render page ngay cả khi lỗi
        res.locals.regions = [];
        res.locals.categories = [];
        next();
    }
});



// =============================================
// MULTER CONFIGURATION FOR FILE UPLOAD
// =============================================

// Tạo thư mục upload tạm
const tempUploadDir = path.join(process.cwd(), 'temp_uploads');
if (!fs.existsSync(tempUploadDir)) {
    fs.mkdirSync(tempUploadDir, { recursive: true });
}

// Cấu hình storage cho multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, tempUploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        const name = path.basename(file.originalname, ext);
        cb(null, name + '-' + uniqueSuffix + ext);
    }
});

// File filter
const fileFilter = (req, file, cb) => {
    const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/quicktime', 'video/webm'];
    
    // Cho phép cả ảnh và video
    if (allowedImageTypes.includes(file.mimetype) || allowedVideoTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Định dạng file không được hỗ trợ: ${file.mimetype}. Chỉ chấp nhận JPG, PNG, GIF, WebP, MP4, MOV, AVI, WebM`), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB
    }
});

// Middleware xử lý lỗi upload
const handleUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            const isVideo = req.originalUrl.includes('video');
            const maxSize = isVideo ? '100MB' : '10MB';
            return res.status(400).json({
                success: false,
                message: `Kích thước file quá lớn. Tối đa ${maxSize}`
            });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Quá nhiều file được chọn'
            });
        }
    }
    
    // Xử lý lỗi file filter
    if (err.message.includes('Định dạng file không được hỗ trợ')) {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }
    
    res.status(400).json({
        success: false,
        message: err.message
    });
};



// =============================================
// CLOUDINARY UTILITY FUNCTIONS
// =============================================

// Hàm upload ảnh lên Cloudinary
const uploadToCloudinary = async (filePath, folder = 'products') => {
    try {
        console.log(`☁️ Uploading to Cloudinary folder: ${folder}`);
        
        const result = await cloudinary.uploader.upload(filePath, {
            folder: `webPhone/${folder}`,
            resource_type: 'image',
            quality: 'auto:good',
            fetch_format: 'auto'
        });

        // Xóa file tạm sau khi upload
        fs.unlinkSync(filePath);
        
        console.log(`✅ Upload successful: ${result.secure_url}`);
        return result;
    } catch (error) {
        // Vẫn xóa file tạm dù upload thất bại
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        throw new Error(`Cloudinary upload failed: ${error.message}`);
    }
};

// Hàm xóa ảnh từ Cloudinary
const deleteFromCloudinary = async (imageUrl) => {
    try {
        if (!imageUrl || !imageUrl.includes('cloudinary.com')) {
            return { result: 'not_cloudinary' };
        }

        // Extract public_id từ URL Cloudinary
        const publicId = extractPublicIdFromUrl(imageUrl);
        if (!publicId) {
            throw new Error('Could not extract public_id from URL');
        }

        console.log(`🗑️ Deleting from Cloudinary: ${publicId}`);
        const result = await cloudinary.uploader.destroy(publicId);
        return result;
    } catch (error) {
        console.error('❌ Cloudinary delete failed:', error);
        throw error;
    }
};

// Hàm extract public_id từ Cloudinary URL
const extractPublicIdFromUrl = (url) => {
    try {
        // Ví dụ: https://res.cloudinary.com/cloudname/image/upload/v1234567/karaoke/products/image.jpg
        // Hoặc: https://res.cloudinary.com/cloudname/video/upload/v1234567/karaoke/products/video.mp4
        const matches = url.match(/\/upload\/(?:v\d+\/)?(.+)\.(?:jpg|jpeg|png|gif|webp|mp4|mov|avi|webm)/i);
        return matches ? matches[1] : null;
    } catch (error) {
        console.error('Error extracting public_id:', error);
        return null;
    }
};

// =============================================
// UPLOAD ROUTES FOR BRAND, CATEGORY, PRODUCT
// =============================================

// Upload brand logo
app.post('/api/upload/brand-logo', upload.single('brandLogo'), handleUploadError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn file logo'
            });
        }

        // Kiểm tra nếu có oldImageUrl trong body thì xóa ảnh cũ
        const { oldImageUrl } = req.body;
        if (oldImageUrl) {
            try {
                await deleteFromCloudinary(oldImageUrl);
            } catch (deleteError) {
                console.warn('⚠️ Could not delete old image:', deleteError.message);
            }
        }

        // Upload ảnh mới lên Cloudinary
        const result = await uploadToCloudinary(req.file.path, 'brands');
        
        res.json({
            success: true,
            message: 'Upload logo thành công',
            data: {
                url: result.secure_url,
                public_id: result.public_id,
                format: result.format,
                bytes: result.bytes
            }
        });

    } catch (error) {
        console.error('❌ Brand logo upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi upload logo: ' + error.message
        });
    }
});

// Upload category image
app.post('/api/upload/category-image', upload.single('categoryImage'), handleUploadError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn file ảnh'
            });
        }

        // Kiểm tra nếu có oldImageUrl trong body thì xóa ảnh cũ
        const { oldImageUrl } = req.body;
        if (oldImageUrl) {
            try {
                await deleteFromCloudinary(oldImageUrl);
            } catch (deleteError) {
                console.warn('⚠️ Could not delete old image:', deleteError.message);
            }
        }

        // Upload ảnh mới lên Cloudinary
        const result = await uploadToCloudinary(req.file.path, 'categories');
        
        res.json({
            success: true,
            message: 'Upload ảnh danh mục thành công',
            data: {
                url: result.secure_url,
                public_id: result.public_id,
                format: result.format,
                bytes: result.bytes
            }
        });

    } catch (error) {
        console.error('❌ Category image upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi upload ảnh danh mục: ' + error.message
        });
    }
});

// Upload product main image
app.post('/api/upload/product-main-image', upload.single('productMainImage'), handleUploadError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn file ảnh chính'
            });
        }

        // Lấy folder name từ frontend (đã được format: ten-san-pham-productId)
        const { productId, oldImageUrl } = req.body;
        
        console.log('📦 Folder name received:', productId);
        
        // Tạo đường dẫn: products/{ten-san-pham-productId}/images
        const folderPath = productId ? `products/${productId}/images` : 'products/default/images';
        console.log(`📁 Using folder path: ${folderPath}`);

        // Kiểm tra nếu có oldImageUrl trong body thì xóa ảnh cũ
        if (oldImageUrl) {
            try {
                await deleteFromCloudinary(oldImageUrl);
            } catch (deleteError) {
                console.warn('⚠️ Could not delete old image:', deleteError.message);
            }
        }

        // Upload ảnh mới lên Cloudinary
        const result = await uploadToCloudinary(req.file.path, folderPath);
        
        res.json({
            success: true,
            message: 'Upload ảnh chính thành công',
            data: {
                url: result.secure_url,
                public_id: result.public_id,
                format: result.format,
                bytes: result.bytes
            }
        });

    } catch (error) {
        console.error('❌ Product main image upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi upload ảnh chính: ' + error.message
        });
    }
});

// Upload multiple product additional images
app.post('/api/upload/product-additional-images', upload.array('productAdditionalImages', 10), handleUploadError, async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn file ảnh'
            });
        }

        // Lấy folder name từ frontend (đã được format: ten-san-pham-productId)
        const { productId } = req.body;
        
        console.log('📦 Folder name received:', productId);
        
        // Tạo đường dẫn: products/{ten-san-pham-productId}/images
        const folderPath = productId ? `products/${productId}/images` : 'products/default/images';
        console.log(`📁 Using folder path: ${folderPath}`);

        const uploadPromises = req.files.map(file => 
            uploadToCloudinary(file.path, folderPath)
        );

        const results = await Promise.all(uploadPromises);
        
        const uploadedImages = results.map(result => ({
            url: result.secure_url,
            public_id: result.public_id,
            format: result.format,
            bytes: result.bytes
        }));

        res.json({
            success: true,
            message: `Upload ${uploadedImages.length} ảnh thành công`,
            data: uploadedImages
        });

    } catch (error) {
        console.error('❌ Product additional images upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi upload ảnh phụ: ' + error.message
        });
    }
});

// API để xóa ảnh từ Cloudinary
app.delete('/api/upload/image', async (req, res) => {
    try {
        const { imageUrl } = req.body;

        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu URL ảnh'
            });
        }

        console.log('🗑️ Received delete request for:', imageUrl);
        const result = await deleteFromCloudinary(imageUrl);

        res.json({
            success: true,
            message: 'Xóa ảnh thành công',
            data: result
        });

    } catch (error) {
        console.error('❌ Image delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa ảnh: ' + error.message
        });
    }
});



///////////////////////////////
//         GET ROUTES         //
///////////////////////////////

//Trang chủ
app.get('/', async (req, res) => {
  try {
    // Lấy tất cả sản phẩm từ SQL Server
    const sanphams = await DataModel.SQL.Product.findAll();
    
    // Lấy danh mục và thương hiệu
    const brands = await DataModel.SQL.Brand.findAll();
    
    // Lấy tỉnh thành
    const provinces = await DataModel.SQL.Province.findAll();
    
    // Lấy tất cả Flash Sales (active + upcoming)
    const allFlashSales = await DataModel.SQL.FlashSale.findAll();
    const now = new Date();
    
    console.log('🔥 Total Flash Sales in DB:', allFlashSales.length);
    console.log('📋 All Flash Sales (before status update):', allFlashSales.map(fs => ({
      id: fs.id,
      ten: fs.ten_flash_sale,
      bat_dau: fs.ngay_bat_dau,
      ket_thuc: fs.ngay_ket_thuc,
      trang_thai: fs.trang_thai
    })));
    
    // ✅ TỰ ĐỘNG CẬP NHẬT TRẠNG THÁI FLASH SALE (CHỈ UPDATE DA_KET_THUC VÀ DANG_DIEN_RA)
    for (const flashSale of allFlashSales) {
      const startDate = new Date(flashSale.ngay_bat_dau);
      const endDate = new Date(flashSale.ngay_ket_thuc);
      let newStatus = flashSale.trang_thai;
      
      if (endDate < now) {
        // Đã kết thúc
        newStatus = 'da_ket_thuc';
      } else if (startDate <= now && endDate >= now) {
        // Đang diễn ra
        newStatus = 'dang_dien_ra';
      }
      // Không tự động update thành 'sap_dien_ra' vì nó không được phép trong DB constraint
      // Admin sẽ set 'cho' hoặc 'sap_dien_ra' thủ công trong admin panel
      
      // Update nếu trạng thái thay đổi VÀ newStatus là giá trị hợp lệ
      if (newStatus !== flashSale.trang_thai && (newStatus === 'da_ket_thuc' || newStatus === 'dang_dien_ra')) {
        console.log(`🔄 Updating flash sale "${flashSale.ten_flash_sale}" status: ${flashSale.trang_thai} → ${newStatus}`);
        try {
          await DataModel.SQL.FlashSale.update(flashSale.id, {
            trang_thai: newStatus
          });
          flashSale.trang_thai = newStatus; // Update in-memory object
        } catch (error) {
          console.error(`❌ Failed to update flash sale status:`, error);
        }
      }
    }
    
    console.log('📋 All Flash Sales (after status update):', allFlashSales.map(fs => ({
      id: fs.id,
      ten: fs.ten_flash_sale,
      trang_thai: fs.trang_thai
    })));
    
    // Hiển thị tất cả flash sales (bao gồm cả đã kết thúc)
    const relevantFlashSales = allFlashSales.sort((a, b) => {
      // Sắp xếp: đang diễn ra → sắp diễn ra → đã kết thúc
      const statusOrder = {
        'dang_dien_ra': 1,
        'sap_dien_ra': 2,
        'da_ket_thuc': 3
      };
      
      const aOrder = statusOrder[a.trang_thai] || 4;
      const bOrder = statusOrder[b.trang_thai] || 4;
      
      if (aOrder !== bOrder) return aOrder - bOrder;
      
      // Cùng trạng thái thì sort theo ngày bắt đầu
      return new Date(a.ngay_bat_dau) - new Date(b.ngay_bat_dau);
    });
    
    console.log('✅ Relevant Flash Sales after filter:', relevantFlashSales.length);
    
    // Xử lý từng Flash Sale
    const flashSaleEvents = [];
    
    for (const flashSale of relevantFlashSales) {
      const flashSaleInfo = {
        id: flashSale.id,
        ten_flash_sale: flashSale.ten_flash_sale,
        mo_ta: flashSale.mo_ta,
        ngay_bat_dau: flashSale.ngay_bat_dau,
        ngay_ket_thuc: flashSale.ngay_ket_thuc,
        trang_thai: flashSale.trang_thai,
        is_active: flashSale.trang_thai === 'dang_dien_ra',
        is_upcoming: flashSale.trang_thai === 'sap_dien_ra',
        is_ended: flashSale.trang_thai === 'da_ket_thuc'
      };
      
      // ✅ Lấy các VARIANT flash sale từ SQL
      const items = await DataModel.SQL.FlashSaleItem.findByFlashSaleId(flashSale.id);
      
      console.log(`📦 Flash Sale "${flashSale.ten_flash_sale}" (${flashSale.id}): ${items?.length || 0} items`);
      
      // ✅ Enrich với thông tin từ SQL product_variants
      const enrichedItems = await Promise.all(items.map(async (item) => {
        try {
          const variantId = item.san_pham_id; // Đây là sql_variant_id
          
          // Tìm variant trong SQL product_variants
          const variant = await DataModel.SQL.ProductVariant.findById(variantId);
          
          if (!variant) {
            console.warn('❌ Variant not found in SQL:', variantId);
            return null;
          }
          
          // Lấy thông tin product từ SQL
          const product = await DataModel.SQL.Product.findById(variant.san_pham_id);
          
          if (!product) {
            console.warn('❌ Product not found for variant:', variantId);
            return null;
          }
          
          const productName = product.ten_san_pham || 'Sản phẩm không tồn tại';
          
          // Lấy ảnh đại diện của variant (hoặc product nếu variant không có)
          const variantImage = variant.anh_dai_dien || product.link_anh_dai_dien || '/image/default-product.png';
          
          // Tên biến thể
          const variantName = variant.ten_hien_thi || 'Mặc định';
          
          // Tồn kho
          const stock = variant.so_luong_ton_kho || 0;
          
          return {
            item,
            productId: variant.san_pham_id, // ✅ Thêm product ID
            productName,
            variantName,
            variantImage,
            variantSKU: variant.ma_sku,
            stock
          };
        } catch (err) {
          console.error('Error enriching flash sale item:', err);
          return null;
        }
      }));
      
      // Filter out null items and format
      const flashSaleItems = enrichedItems
        .filter(enriched => enriched !== null)
        .map(enriched => {
          const { item, productId, productName, variantName, variantImage, variantSKU, stock } = enriched;
          
          const phan_tram_giam = item.gia_goc > 0 ? Math.round((1 - item.gia_flash_sale / item.gia_goc) * 100) : 0;
          const so_luong_ton = item.so_luong_ton || 0;
          const da_ban = item.da_ban || 0;
          const con_lai = so_luong_ton - da_ban;
          const da_ban_percent = so_luong_ton > 0 ? Math.round((da_ban / so_luong_ton) * 100) : 0;
          
          return {
            id: item.san_pham_id, // Variant ID
            product_id: productId, // ✅ Product ID để check flash sale
            flash_sale_item_id: item.id,
            ten_san_pham: productName,
            ten_variant: `${productName} - ${variantName}`,
            variant_name: variantName,
            link_anh: variantImage,
            sku: variantSKU,
            gia_goc: item.gia_goc,
            gia_flash_sale: item.gia_flash_sale,
            gia_ban_formatted: new Intl.NumberFormat('vi-VN', {
              style: 'currency',
              currency: 'VND'
            }).format(item.gia_flash_sale),
            gia_goc_formatted: new Intl.NumberFormat('vi-VN', {
              style: 'currency',
              currency: 'VND'
            }).format(item.gia_goc),
            phan_tram_giam,
            so_luong_ton,
            da_ban,
            con_lai,
            da_ban_percent,
            ton_kho_variant: stock,
            gioi_han_mua: item.gioi_han_mua,
            is_hot: da_ban_percent > 50,
            is_low_stock: con_lai < 10 && con_lai > 0
          };
        });
      
      console.log(`✅ Adding "${flashSale.ten_flash_sale}" with ${flashSaleItems.length} valid items`);
      
      flashSaleEvents.push({
        info: flashSaleInfo,
        items: flashSaleItems
      });
    }
    
    console.log('🔥 Flash Sale Events Count:', flashSaleEvents.length);
    console.log('📋 Flash Sale Events:', flashSaleEvents.map(e => ({
      ten: e.info.ten_flash_sale,
      items_count: e.items.length
    })));
    
    // Tạo Set các product IDs có flash sale (từ flash sale items)
    const flashSaleProductIds = new Set();
    flashSaleEvents.forEach(event => {
      event.items.forEach(item => {
        // item.id là variant_id, cần lấy san_pham_id
        if (item.product_id) {
          flashSaleProductIds.add(item.product_id);
        }
      });
    });
    
    console.log('🔥 Products with Flash Sale:', flashSaleProductIds.size);
    
    // Format dữ liệu sản phẩm với thông tin flash sale
    const formattedProducts = sanphams.map(product => {
      const hasFlashSale = flashSaleProductIds.has(product.id);
      
      return {
        ...product,
        id: product.id,
        has_flash_sale: hasFlashSale, // ✅ Thêm flag này
        gia_ban_formatted: new Intl.NumberFormat('vi-VN', {
          style: 'currency',
          currency: 'VND'
        }).format(product.gia_ban || 0),
        gia_niem_yet_formatted: product.gia_niem_yet ? new Intl.NumberFormat('vi-VN', {
          style: 'currency',
          currency: 'VND'
        }).format(product.gia_niem_yet) : null,
        giam_gia_formatted: product.gia_niem_yet ? new Intl.NumberFormat('vi-VN', {
          style: 'currency',
          currency: 'VND'
        }).format(product.gia_niem_yet - product.gia_ban) : null,
        is_discount: product.gia_niem_yet && product.gia_niem_yet > product.gia_ban,
        phan_tram_giam: product.gia_niem_yet ? 
          Math.round((1 - product.gia_ban / product.gia_niem_yet) * 100) : 0,
        link_anh: product.link_anh_dai_dien || '/image/default-product.png',
        mo_ta: product.mo_ta_ngan || 'Sản phẩm chất lượng cao với giá cả hợp lý'
      };
    });

    // Nhóm sản phẩm theo brand động từ database
    const brandProductGroups = {};
    
    // Khởi tạo các nhóm brand
    brands.forEach(brand => {
      brandProductGroups[brand.id] = {
        brandInfo: brand,
        products: []
      };
    });
    
    // Phân loại sản phẩm vào các brand
    formattedProducts.forEach(product => {
      if (product.thuong_hieu_id && brandProductGroups[product.thuong_hieu_id]) {
        brandProductGroups[product.thuong_hieu_id].products.push(product);
      }
    });
    
    // Chuyển thành array và sắp xếp theo số lượng sản phẩm
    const brandSections = Object.values(brandProductGroups)
      .map(group => ({
        ...group.brandInfo,
        products: group.products,
        productCount: group.products.length
      }))
      .filter(section => section.productCount > 0) // Chỉ hiển thị brand có sản phẩm
      .sort((a, b) => b.productCount - a.productCount); // Sort theo số lượng sản phẩm

    console.log('📊 Brand Sections:', brandSections.map(b => ({
      name: b.ten_thuong_hieu,
      count: b.productCount
    })));

    res.render('home', { 
      layout: 'HomeMain.handlebars', 
      sanphams: formattedProducts,
      flashSaleEvents, // Array of {info, items}
      brandSections, // Thay thế iphoneProducts, samsungProducts, etc.
      brands,
      provinces
    });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).send('Server error');
  }
});

// ==========================================
// AUTHENTICATION ROUTES
// ==========================================

// GET Admin Login page
app.get('/admin-login', (req, res) => {
    // Nếu đã đăng nhập, redirect về admin
    if (req.session && req.session.user) {
        const redirect = req.query.redirect || '/admin';
        return res.redirect(redirect);
    }
    res.render('login_admin', { 
        layout: false,
        redirect: req.query.redirect || '/admin'
    });
});

// POST Admin Login - Xác thực tài khoản admin
app.post('/admin-login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng nhập email và mật khẩu'
            });
        }

        // Query user từ database
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('email', sql.NVarChar, email)
            .query(`
                SELECT id, email, ho_ten, vai_tro, mat_khau, trang_thai, vung_id
                FROM users 
                WHERE email = @email
            `);

        if (result.recordset.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Email hoặc mật khẩu không đúng'
            });
        }

        const user = result.recordset[0];

        console.log('👤 User info:', {
            email: user.email,
            vai_tro: user.vai_tro,
            vung_id: user.vung_id,
            trang_thai: user.trang_thai
        });

        // Kiểm tra tài khoản có active không
        if (!user.trang_thai) {
            return res.status(403).json({
                success: false,
                message: 'Tài khoản đã bị khóa'
            });
        }

        // Kiểm tra vai trò (chỉ admin và super_admin)
        if (user.vai_tro !== 'admin' && user.vai_tro !== 'super_admin') {
            return res.status(403).json({
                success: false,
                message: 'Bạn không có quyền truy cập trang quản trị'
            });
        }

        // Hash password input bằng SHA-256 để so sánh với DB
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        
        console.log('🔐 Password comparison:', {
            input: password,
            hashedInput: hashedPassword,
            dbHash: user.mat_khau,
            match: hashedPassword === user.mat_khau
        });

        if (user.mat_khau !== hashedPassword) {
            return res.status(401).json({
                success: false,
                message: 'Email hoặc mật khẩu không đúng'
            });
        }

        // ⚠️ KHÔNG chuyển database connection global nữa
        // Connection sẽ được inject vào mỗi request thông qua requireAdmin middleware
        let dbInfo = null;
        if (user.vung_id) {
            // Chỉ lấy thông tin để log, không switch connection
            dbInfo = await db.switchDatabaseByRegion(user.vung_id);
            console.log('ℹ️ Admin will use database:', dbInfo);
        }

        // Tạo session
        req.session.user = {
            id: user.id,
            email: user.email,
            ho_ten: user.ho_ten,
            vai_tro: user.vai_tro,
            vung_id: user.vung_id,
            dbServer: dbInfo?.server,
            dbDatabase: dbInfo?.database
        };

        // Save session và redirect
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.status(500).json({
                    success: false,
                    message: 'Lỗi lưu phiên đăng nhập'
                });
            }

            res.json({
                success: true,
                message: 'Đăng nhập thành công',
                redirect: req.body.redirect || '/admin',
                user: {
                    email: user.email,
                    ho_ten: user.ho_ten,
                    vai_tro: user.vai_tro
                }
            });
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server'
        });
    }
});

// Logout
app.post('/logout', (req, res) => {
    // Kiểm tra user role để redirect đúng trang
    const isAdmin = req.session.user && (req.session.user.vai_tro === 'admin' || req.session.user.vai_tro === 'super_admin');
    
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).json({
                success: false,
                message: 'Lỗi đăng xuất'
            });
        }
        res.json({
            success: true,
            message: 'Đăng xuất thành công',
            redirect: isAdmin ? '/admin-login' : '/login'
        });
    });
});

// GET Logout (alternative)
app.get('/logout', (req, res) => {
    // Kiểm tra user role để redirect đúng trang
    const isAdmin = req.session.user && (req.session.user.vai_tro === 'admin' || req.session.user.vai_tro === 'super_admin');
    
    req.session.destroy((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect(isAdmin ? '/admin-login' : '/login');
    });
});

// ==========================================
// ADMIN ROUTES (Require Authentication)
// ==========================================

// Trang admin dashboard
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        // Get connection info để hiển thị cho admin
        const pool = req.dbPool;
        const dbInfo = {
            server: pool.config.server,
            database: pool.config.database,
            vung_id: req.session.user.vung_id
        };
        
        console.log('📊 Admin Dashboard - Using database:', dbInfo);
        
        // Test query để verify connection
        const testResult = await pool.request().query('SELECT DB_NAME() as current_db, @@SERVERNAME as server_name');
        console.log('✅ Connected to:', testResult.recordset[0]);
        
        res.render('AD_Dashboard', { 
            layout: 'AdminMain',
            dashboardPage: true,
            user: req.session.user,
            dbInfo: {
                ...dbInfo,
                currentDb: testResult.recordset[0].current_db,
                serverName: testResult.recordset[0].server_name
            }
        });
    } catch (err) {
        console.error('❌ Admin dashboard error:', err);
        res.status(500).send('Lỗi server!');
    }
});

// API để kiểm tra connection info (debug)
app.get('/api/admin/db-info', requireAdmin, async (req, res) => {
    try {
        const pool = req.dbPool;
        const testResult = await pool.request().query(`
            SELECT 
                DB_NAME() as current_database,
                @@SERVERNAME as server_name,
                @@VERSION as sql_version
        `);
        
        res.json({
            success: true,
            poolConfig: {
                server: pool.config.server,
                database: pool.config.database,
                user: pool.config.user
            },
            actualConnection: testResult.recordset[0],
            sessionInfo: {
                vung_id: req.session.user.vung_id,
                email: req.session.user.email,
                vai_tro: req.session.user.vai_tro
            }
        });
    } catch (err) {
        console.error('❌ DB Info error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Trang quản lý vận chuyển
app.get('/vanchuyen', (req, res) => {
    try {
        res.render('vanchuyen', { layout: 'AdminMain', vanChuyenPage: true });
    } catch (err) {
        console.error('Error rendering vanchuyen:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Trang giỏ hàng
app.get('/cart', async (req, res) => {
    try {
        res.render('cart', { 
            layout: 'HomeMain.handlebars'
        });
    } catch (err) {
        console.error('Error loading cart page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Trang thanh toán
app.get('/dathang', async (req, res) => {
    try {
        res.render('dathang', { 
            layout: 'HomeMain.handlebars'
        });
    } catch (err) {
        console.error('Error loading dathang page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Trang xác nhận đơn hàng / Chi tiết đơn hàng
app.get('/order-confirmation', async (req, res) => {
    try {
        res.render('order-confirmation', { 
            layout: 'HomeMain.handlebars'
        });
    } catch (err) {
        console.error('Error loading order confirmation page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Trang danh sách đơn hàng của tôi
app.get('/donhang', async (req, res) => {
    try {
        res.render('my-orders', { 
            layout: 'HomeMain.handlebars'
        });
    } catch (err) {
        console.error('Error loading my orders page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// ========== CART API ==========

// GET /api/cart - Lấy giỏ hàng của user hiện tại
app.get('/api/cart', async (req, res) => {
    try {
        const { userId } = req.query;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Vui lòng đăng nhập để xem giỏ hàng'
            });
        }
        
        // Lấy thông tin user
        const userRequest = new sql.Request(db.connectionPools.default);
        const userResult = await userRequest
            .input('userId', sql.UniqueIdentifier, userId)
            .query('SELECT id, vung_id FROM users WHERE id = @userId');
        
        if (!userResult.recordset || userResult.recordset.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Phiên đăng nhập không hợp lệ'
            });
        }
        
        const vungId = userResult.recordset[0].vung_id;
        
        // Tìm hoặc tạo giỏ hàng theo vùng của user
        let cartRequest = new sql.Request(db.connectionPools.default);
        let cartResult = await cartRequest
            .input('userId', sql.UniqueIdentifier, userId)
            .input('vungId', sql.NVarChar(10), vungId)
            .query('SELECT id FROM carts WHERE nguoi_dung_id = @userId AND vung_id = @vungId');
        
        let cartId;
        if (!cartResult.recordset || cartResult.recordset.length === 0) {
            // Tạo giỏ hàng mới theo vùng
            const createCartRequest = new sql.Request(db.connectionPools.default);
            await createCartRequest
                .input('userId', sql.UniqueIdentifier, userId)
                .input('vungId', sql.NVarChar(10), vungId)
                .query(`
                    INSERT INTO carts (nguoi_dung_id, vung_id)
                    VALUES (@userId, @vungId)
                `);
            
            // Lấy cart vừa tạo
            const newCartRequest = new sql.Request(db.connectionPools.default);
            const newCart = await newCartRequest
                .input('userId', sql.UniqueIdentifier, userId)
                .input('vungId', sql.NVarChar(10), vungId)
                .query('SELECT TOP 1 id FROM carts WHERE nguoi_dung_id = @userId AND vung_id = @vungId ORDER BY ngay_tao DESC');
            
            cartId = newCart.recordset[0].id;
        } else {
            cartId = cartResult.recordset[0].id;
        }
        
        // Lấy các sản phẩm trong giỏ hàng
        const itemsRequest = new sql.Request(db.connectionPools.default);
        const itemsResult = await itemsRequest
            .input('cartId', sql.UniqueIdentifier, cartId)
            .query(`
                SELECT 
                    ci.id,
                    ci.gio_hang_id,
                    ci.variant_id,
                    ci.so_luong,
                    ci.ngay_them,
                    pv.san_pham_id as product_id,
                    pv.ten_hien_thi as variant_name,
                    pv.ma_sku as variant_sku,
                    pv.gia_ban as variant_price,
                    pv.so_luong_ton_kho as variant_stock,
                    pv.anh_dai_dien as variant_image,
                    pv.site_origin,
                    p.ten_san_pham,
                    p.link_anh_dai_dien,
                    p.gia_niem_yet,
                    b.ten_thuong_hieu,
                    c.ten_danh_muc
                FROM cart_items ci
                INNER JOIN product_variants pv ON ci.variant_id = pv.id
                INNER JOIN products p ON pv.san_pham_id = p.id
                LEFT JOIN brands b ON p.thuong_hieu_id = b.id
                LEFT JOIN categories c ON p.danh_muc_id = c.id
                WHERE ci.gio_hang_id = @cartId
                ORDER BY ci.ngay_them DESC
            `);

        // Check flash sale cho tất cả variants trong giỏ
        const variantIds = itemsResult.recordset.map(item => item.variant_id);
        const flashSaleMap = new Map();
        
        if (variantIds.length > 0) {
            try {
                const flashSaleRequest = new sql.Request(db.connectionPools.default);
                const flashSaleResult = await flashSaleRequest.query(`
                    SELECT 
                        fsi.id as flash_sale_item_id,
                        fsi.variant_id,
                        fsi.gia_flash_sale,
                        fsi.gia_goc,
                        fsi.so_luong_ton,
                        fsi.da_ban,
                        fsi.gioi_han_mua,
                        fs.ngay_bat_dau,
                        fs.ngay_ket_thuc
                    FROM flash_sale_items fsi
                    INNER JOIN flash_sales fs ON fsi.flash_sale_id = fs.id
                    WHERE fsi.variant_id IN ('${variantIds.join("','")}')
                        AND fs.trang_thai = N'dang_dien_ra'
                        AND fsi.trang_thai = N'dang_ban'
                        AND GETDATE() BETWEEN fs.ngay_bat_dau AND fs.ngay_ket_thuc
                        AND (fsi.so_luong_ton - fsi.da_ban) > 0
                `);
                
                // Query số lượng user đã mua cho từng flash_sale_item
                const flashSaleItemIds = flashSaleResult.recordset.map(fs => fs.flash_sale_item_id);
                const userPurchasedMap = new Map();
                
                if (flashSaleItemIds.length > 0) {
                    const purchasedRequest = new sql.Request(db.connectionPools.default);
                    const purchasedResult = await purchasedRequest
                        .input('nguoi_dung_id', sql.UniqueIdentifier, userId)
                        .query(`
                            SELECT 
                                flash_sale_item_id,
                                SUM(so_luong) as da_mua
                            FROM flash_sale_orders
                            WHERE flash_sale_item_id IN ('${flashSaleItemIds.join("','")}')
                              AND nguoi_dung_id = @nguoi_dung_id
                            GROUP BY flash_sale_item_id
                        `);
                    
                    purchasedResult.recordset.forEach(p => {
                        userPurchasedMap.set(p.flash_sale_item_id, p.da_mua);
                    });
                }
                
                flashSaleResult.recordset.forEach(fs => {
                    const daMua = userPurchasedMap.get(fs.flash_sale_item_id) || 0;
                    const conDuocMua = Math.max(0, (fs.gioi_han_mua || 999) - daMua);
                    
                    flashSaleMap.set(fs.variant_id, {
                        flash_sale_item_id: fs.flash_sale_item_id,
                        gia_flash_sale: fs.gia_flash_sale,
                        gia_goc: fs.gia_goc,
                        so_luong_ton: fs.so_luong_ton,
                        da_ban: fs.da_ban,
                        con_lai: fs.so_luong_ton - fs.da_ban,
                        gioi_han_mua: fs.gioi_han_mua,
                        da_mua: daMua,
                        con_duoc_mua: conDuocMua,
                        ngay_bat_dau: fs.ngay_bat_dau,
                        ngay_ket_thuc: fs.ngay_ket_thuc
                    });
                });
            } catch (fsError) {
                console.error('⚠️ Error checking flash sales:', fsError);
            }
        }
        
        // Format cart items với thông tin từ product_variants
        const cartItems = itemsResult.recordset.map(item => {
            const variantImage = item.variant_image || item.link_anh_dai_dien || '/image/default-product.png';
            const variantPrice = item.variant_price || 0;
            const productName = item.ten_san_pham || 'Sản phẩm';
            const variantName = item.variant_name || '';
            const fullName = variantName ? `${productName} - ${variantName}` : productName;
            
            // Kiểm tra flash sale cho variant này
            const flashSaleData = flashSaleMap.get(item.variant_id);
            const isFlashSale = !!flashSaleData;
            const flashSalePrice = flashSaleData ? flashSaleData.gia_flash_sale : null;
            const conDuocMua = flashSaleData ? flashSaleData.con_duoc_mua : 0; // Số lượng còn được mua (đã trừ đi số đã mua)
            
            // Tính giá và thành tiền dựa trên số lượng còn được mua
            let finalPrice = variantPrice;
            let thanhTien = variantPrice * item.so_luong;
            let soLuongFlashSale = 0;
            let soLuongGiaGoc = 0;
            
            if (isFlashSale && flashSalePrice && conDuocMua > 0) {
                // Số lượng được hưởng giá flash sale (dựa trên số còn được mua)
                soLuongFlashSale = Math.min(item.so_luong, conDuocMua);
                // Số lượng vượt giới hạn, tính giá gốc
                soLuongGiaGoc = Math.max(0, item.so_luong - conDuocMua);
                
                // Tính tổng thành tiền hỗn hợp
                thanhTien = (soLuongFlashSale * flashSalePrice) + (soLuongGiaGoc * variantPrice);
                
                // Giá hiển thị: LUÔN dùng giá flash sale khi có flash sale active
                finalPrice = flashSalePrice;
                
                console.log(`⚡ Flash sale active for variant ${item.variant_id}: price=${flashSalePrice}, quantity=${soLuongFlashSale}/${item.so_luong}`);
            } else if (isFlashSale && flashSalePrice && conDuocMua === 0) {
                // User đã mua hết hạn mức flash sale → hiển thị giá gốc
                finalPrice = variantPrice;
                thanhTien = variantPrice * item.so_luong;
                soLuongGiaGoc = item.so_luong;
                
                console.log(`⚠️ Flash sale limit reached for variant ${item.variant_id}: using regular price=${variantPrice}`);
            }
            
            return {
                id: item.id,
                gio_hang_id: item.gio_hang_id,
                variant_id: item.variant_id,
                san_pham_id: item.variant_id, // Alias cho compatibility với frontend
                product_id: item.product_id,
                site_origin: item.site_origin,
                so_luong: item.so_luong,
                ngay_them: item.ngay_them,
                ten_san_pham: productName,
                variant_name: variantName,
                variant_info: { // Thêm variant_info để frontend không warning
                    id: item.variant_id,
                    ten_hien_thi: variantName,
                    ma_sku: item.variant_sku,
                    so_luong_ton_kho: item.variant_stock
                },
                ten_san_pham_day_du: fullName,
                ma_sku: item.variant_sku || 'N/A',
                link_anh: variantImage,
                gia_ban: finalPrice,
                gia_niem_yet: item.gia_niem_yet,
                ton_kho: item.variant_stock || 0,
                thuong_hieu: item.ten_thuong_hieu,
                danh_muc: item.ten_danh_muc,
                is_flash_sale: isFlashSale,
                flash_sale_data: flashSaleData || null,
                so_luong_flash_sale: soLuongFlashSale, // Số lượng được giá flash sale
                so_luong_gia_goc: soLuongGiaGoc, // Số lượng tính giá gốc
                vuot_gioi_han: soLuongGiaGoc > 0, // Đã vượt giới hạn mua
                is_discount: item.gia_niem_yet && finalPrice < item.gia_niem_yet,
                phan_tram_giam: item.gia_niem_yet && item.gia_niem_yet > 0 ? 
                    Math.round((1 - finalPrice / item.gia_niem_yet) * 100) : 0,
                gia_ban_formatted: new Intl.NumberFormat('vi-VN', { 
                    style: 'currency', 
                    currency: 'VND' 
                }).format(finalPrice),
                gia_niem_yet_formatted: item.gia_niem_yet ? new Intl.NumberFormat('vi-VN', { 
                    style: 'currency', 
                    currency: 'VND' 
                }).format(item.gia_niem_yet) : null,
                thanh_tien: thanhTien, // Thành tiền số (để tính tổng)
                thanh_tien_formatted: new Intl.NumberFormat('vi-VN', { 
                    style: 'currency', 
                    currency: 'VND' 
                }).format(thanhTien)
            };
        });
        
        res.json({
            success: true,
            data: {
                cartId: cartId,
                items: cartItems,
                count: cartItems.length
            }
        });
        
    } catch (error) {
        console.error('Get cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy giỏ hàng: ' + error.message
        });
    }
});

// POST /api/cart - Thêm sản phẩm vào giỏ hàng (đơn giản)
app.post('/api/cart', async (req, res) => {
    try {
        const { variant_id, so_luong, userId } = req.body;
        
        console.log('📦 Add to cart request:', { variant_id, so_luong, userId });

        // 1. Kiểm tra đăng nhập
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Vui lòng đăng nhập để thêm vào giỏ hàng'
            });
        }

        // 2. Kiểm tra variant_id
        if (!variant_id) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn phiên bản sản phẩm'
            });
        }

        // 3. Lấy vùng của user từ database
        const userRequest = new sql.Request(db.connectionPools.default);
        const userResult = await userRequest
            .input('userId', sql.UniqueIdentifier, userId)
            .query('SELECT vung_id FROM users WHERE id = @userId');

        if (!userResult.recordset || userResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy thông tin người dùng'
            });
        }

        const vung_id = userResult.recordset[0].vung_id;
        console.log('📍 User region:', vung_id);

        // 4. Lấy hoặc tạo cart cho user theo vùng của họ
        let cartRequest = new sql.Request(db.connectionPools.default);
        let cartResult = await cartRequest
            .input('userId', sql.UniqueIdentifier, userId)
            .input('vungId', sql.NVarChar(10), vung_id)
            .query('SELECT id FROM carts WHERE nguoi_dung_id = @userId AND vung_id = @vungId');

        let cartId;
        
        if (!cartResult.recordset || cartResult.recordset.length === 0) {
            // Tạo cart mới cho user theo vùng
            console.log('📦 Creating new cart for user:', userId, 'region:', vung_id);
            
            const createCartRequest = new sql.Request(db.connectionPools.default);
            await createCartRequest
                .input('userId', sql.UniqueIdentifier, userId)
                .input('vungId', sql.NVarChar(10), vung_id)
                .query(`
                    INSERT INTO carts (nguoi_dung_id, vung_id)
                    VALUES (@userId, @vungId)
                `);
            
            // Lấy cart vừa tạo
            const newCartRequest = new sql.Request(db.connectionPools.default);
            const newCart = await newCartRequest
                .input('userId', sql.UniqueIdentifier, userId)
                .input('vungId', sql.NVarChar(10), vung_id)
                .query('SELECT TOP 1 id FROM carts WHERE nguoi_dung_id = @userId AND vung_id = @vungId ORDER BY ngay_tao DESC');
            
            cartId = newCart.recordset[0].id;
            
            console.log('✅ Created cart:', cartId);
        } else {
            cartId = cartResult.recordset[0].id;
            console.log('✅ Found existing cart:', cartId);
        }

        // 5. Kiểm tra variant có tồn tại trong giỏ chưa
        const checkRequest = new sql.Request(db.connectionPools.default);
        const checkResult = await checkRequest
            .input('cartId', sql.UniqueIdentifier, cartId)
            .input('variantId', sql.UniqueIdentifier, variant_id)
            .query(`
                SELECT id, so_luong 
                FROM cart_items 
                WHERE gio_hang_id = @cartId AND variant_id = @variantId
            `);

        if (checkResult.recordset && checkResult.recordset.length > 0) {
            // Đã có trong giỏ -> UPDATE số lượng
            const existingItem = checkResult.recordset[0];
            const newQuantity = existingItem.so_luong + so_luong;
            
            const updateRequest = new sql.Request(db.connectionPools.default);
            await updateRequest
                .input('itemId', sql.UniqueIdentifier, existingItem.id)
                .input('newQty', sql.Int, newQuantity)
                .query(`
                    UPDATE cart_items 
                    SET so_luong = @newQty 
                    WHERE id = @itemId
                `);

            console.log('✅ Updated quantity:', newQuantity);

            return res.json({
                success: true,
                message: 'Đã cập nhật số lượng trong giỏ hàng',
                existed: true,
                data: {
                    cartItemId: existingItem.id,
                    cartId: cartId
                }
            });
        } else {
            // Chưa có trong giỏ -> INSERT mới
            const insertRequest = new sql.Request(db.connectionPools.default);
            await insertRequest
                .input('cartId', sql.UniqueIdentifier, cartId)
                .input('variantId', sql.UniqueIdentifier, variant_id)
                .input('quantity', sql.Int, so_luong)
                .query(`
                    INSERT INTO cart_items (gio_hang_id, variant_id, so_luong)
                    VALUES (@cartId, @variantId, @quantity)
                `);

            // Lấy ID của item vừa thêm
            const getItemRequest = new sql.Request(db.connectionPools.default);
            const newItemResult = await getItemRequest
                .input('cartId', sql.UniqueIdentifier, cartId)
                .input('variantId', sql.UniqueIdentifier, variant_id)
                .query(`
                    SELECT TOP 1 id 
                    FROM cart_items 
                    WHERE gio_hang_id = @cartId AND variant_id = @variantId
                `);

            const cartItemId = newItemResult.recordset[0].id;
            console.log('✅ Added new item to cart:', cartItemId);

            return res.json({
                success: true,
                message: 'Đã thêm vào giỏ hàng',
                existed: false,
                data: {
                    cartItemId: cartItemId,
                    cartId: cartId
                }
            });
        }

    } catch (error) {
        console.error('❌ Add to cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi thêm vào giỏ hàng: ' + error.message
        });
    }
});

// POST /api/cart/reduce - Trừ 1 số lượng trong giỏ (dùng cho buy now khi không đặt hàng)
app.post('/api/cart/reduce', async (req, res) => {
    try {
        const { cartItemId, userId } = req.body;
        
        if (!cartItemId || !userId) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin'
            });
        }

        console.log('📉 Reducing cart item quantity:', cartItemId);

        const pool = db.connectionPools.default;
        
        // Kiểm tra số lượng hiện tại
        const checkRequest = new sql.Request(db.connectionPools.default);
        const checkResult = await checkRequest
            .input('cartItemId', sql.UniqueIdentifier, cartItemId)
            .query('SELECT so_luong FROM cart_items WHERE id = @cartItemId');
        
        if (checkResult.recordset.length === 0) {
            return res.json({ success: true, message: 'Item not found' });
        }

        const currentQty = checkResult.recordset[0].so_luong;
        
        if (currentQty <= 1) {
            // Xóa nếu số lượng <= 1
            const deleteRequest = new sql.Request(db.connectionPools.default);
            await deleteRequest
                .input('cartItemId', sql.UniqueIdentifier, cartItemId)
                .query('DELETE FROM cart_items WHERE id = @cartItemId');
            
            console.log('✅ Deleted cart item');
        } else {
            // Trừ 1
            const updateRequest = new sql.Request(db.connectionPools.default);
            await updateRequest
                .input('cartItemId', sql.UniqueIdentifier, cartItemId)
                .query('UPDATE cart_items SET so_luong = so_luong - 1 WHERE id = @cartItemId');
            
            console.log('✅ Reduced quantity by 1');
        }

        return res.json({
            success: true,
            message: 'Đã cập nhật giỏ hàng'
        });

    } catch (error) {
        console.error('❌ Reduce cart error:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// PUT /api/cart/:itemId - Cập nhật số lượng sản phẩm trong giỏ
app.put('/api/cart/:itemId', async (req, res) => {
    try {
        const { itemId } = req.params;
        const { so_luong } = req.body;
        
        if (!so_luong || so_luong < 1) {
            return res.status(400).json({
                success: false,
                message: 'Số lượng phải lớn hơn 0'
            });
        }
        
        // Lấy thông tin cart item
        const checkRequest = new sql.Request(db.connectionPools.default);
        const checkResult = await checkRequest
            .input('itemId', sql.UniqueIdentifier, itemId)
            .query(`
                SELECT 
                    ci.id, 
                    ci.variant_id
                FROM cart_items ci
                WHERE ci.id = @itemId
            `);
        
        if (!checkResult.recordset || checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm trong giỏ hàng'
            });
        }
        
        const cartItem = checkResult.recordset[0];
        const variantId = cartItem.variant_id;
        
        // Lấy thông tin variant từ SQL
        const variantRequest = new sql.Request(db.connectionPools.default);
        const variantResult = await variantRequest
            .input('variantId', sql.UniqueIdentifier, variantId)
            .query(`
                SELECT 
                    pv.id,
                    pv.ten_hien_thi,
                    pv.so_luong_ton_kho,
                    pv.trang_thai,
                    p.ten_san_pham
                FROM product_variants pv
                INNER JOIN products p ON pv.san_pham_id = p.id
                WHERE pv.id = @variantId
            `);
        
        if (!variantResult.recordset || variantResult.recordset.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Không tìm thấy thông tin biến thể sản phẩm'
            });
        }
        
        const variant = variantResult.recordset[0];
        
        // Kiểm tra variant có active không
        if (variant.trang_thai === 0) {
            return res.status(400).json({
                success: false,
                message: 'Sản phẩm này đã ngừng bán'
            });
        }
        
        // Kiểm tra số lượng tồn kho từ SQL
        const availableStock = variant.so_luong_ton_kho || 0;
        
        if (so_luong > availableStock) {
            return res.status(400).json({
                success: false,
                message: `Chỉ còn ${availableStock} sản phẩm trong kho`,
                availableStock: availableStock
            });
        }
        
        // Cập nhật số lượng
        const updateRequest = new sql.Request(db.connectionPools.default);
        await updateRequest
            .input('itemId', sql.UniqueIdentifier, itemId)
            .input('quantity', sql.Int, so_luong)
            .query('UPDATE cart_items SET so_luong = @quantity WHERE id = @itemId');
        
        res.json({
            success: true,
            message: 'Đã cập nhật số lượng sản phẩm',
            data: {
                so_luong: so_luong,
                availableStock: availableStock
            }
        });
        
    } catch (error) {
        console.error('Update cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật giỏ hàng: ' + error.message
        });
    }
});

// DELETE /api/cart/:itemId - Xóa sản phẩm khỏi giỏ hàng
app.delete('/api/cart/:itemId', async (req, res) => {
    try {
        const { itemId } = req.params;
        
        const deleteRequest = new sql.Request(db.connectionPools.default);
        const result = await deleteRequest
            .input('itemId', sql.UniqueIdentifier, itemId)
            .query('DELETE FROM cart_items WHERE id = @itemId');
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm trong giỏ hàng'
            });
        }
        
        res.json({
            success: true,
            message: 'Đã xóa sản phẩm khỏi giỏ hàng'
        });
        
    } catch (error) {
        console.error('Delete cart item error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa sản phẩm: ' + error.message
        });
    }
});

// DELETE /api/cart - Xóa toàn bộ giỏ hàng
app.delete('/api/cart', async (req, res) => {
    try {
        const { userId } = req.query;
        
        if (!userId) {
            return res.status(401).json({
                success: false,
                message: 'Vui lòng đăng nhập'
            });
        }
        
        // Xóa tất cả items trong giỏ hàng
        const deleteRequest = new sql.Request(db.connectionPools.default);
        await deleteRequest
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                DELETE FROM cart_items 
                WHERE gio_hang_id IN (SELECT id FROM carts WHERE nguoi_dung_id = @userId)
            `);
        
        res.json({
            success: true,
            message: 'Đã xóa toàn bộ giỏ hàng'
        });
        
    } catch (error) {
        console.error('Clear cart error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa giỏ hàng: ' + error.message
        });
    }
});

// Trang đăng nhập
app.get('/login', (req, res) => {
    try {
        res.render('login', { 
            layout: false // Không dùng layout vì login có design riêng
        });
    } catch (err) {
        console.error('Error loading login page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Trang đăng ký
app.get('/register', (req, res) => {
    try {
        res.render('register', { 
            layout: false // Không dùng layout vì register có design riêng
        });
    } catch (err) {
        console.error('Error loading register page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Trang profile
app.get('/profile', (req, res) => {
    try {
        res.render('profile', {
            layout: 'HomeMain'
        });
    } catch (err) {
        console.error('Error loading profile page:', err);
        res.status(500).send('Lỗi server!');
    }
});

// ========== API AUTHENTICATION ==========

// POST /api/auth/login - Đăng nhập
app.post('/api/auth/login', async (req, res) => {
    try {
        console.log('🔐 Login attempt:', req.body.identifier);
        
        const { identifier, password, rememberMe } = req.body;
        
        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng nhập đầy đủ thông tin đăng nhập'
            });
        }
        
        // Tìm user theo email hoặc số điện thoại
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('identifier', sql.NVarChar(255), identifier.trim())
            .query(`
                SELECT 
                    id,
                    email,
                    mat_khau,
                    ho_ten,
                    so_dien_thoai,
                    vung_id,
                    mongo_profile_id,
                    trang_thai,
                    ngay_dang_ky
                FROM users 
                WHERE (email = @identifier OR so_dien_thoai = @identifier)
            `);
        
        if (result.recordset.length === 0) {
            return res.status(401).json({
                success: false,
                message: 'Email/Số điện thoại hoặc mật khẩu không đúng'
            });
        }
        
        const user = result.recordset[0];
        
        // Kiểm tra trạng thái tài khoản
        if (!user.trang_thai) {
            return res.status(403).json({
                success: false,
                message: 'Tài khoản đã bị khóa. Vui lòng liên hệ hỗ trợ.'
            });
        }
        
        // So sánh mật khẩu (hash với SHA256)
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        
        if (user.mat_khau !== hashedPassword) {
            return res.status(401).json({
                success: false,
                message: 'Email/Số điện thoại hoặc mật khẩu không đúng'
            });
        }
        
        // Tạo session token (UUID)
        const sessionToken = crypto.randomUUID();
        
        // Lưu thông tin session (có thể lưu vào DB hoặc cache như Redis)
        // Hiện tại chỉ trả token về client
        
        console.log('✅ Login successful:', user.email);
        
        // Trả về thông tin user (không bao gồm mật khẩu)
        return res.json({
            success: true,
            message: 'Đăng nhập thành công',
            token: sessionToken,
            user: {
                id: user.id,
                email: user.email,
                ho_ten: user.ho_ten,
                so_dien_thoai: user.so_dien_thoai,
                vung_id: user.vung_id,
                mongo_profile_id: user.mongo_profile_id,
                ngay_dang_ky: user.ngay_dang_ky
            },
            redirectUrl: '/'
        });
        
    } catch (error) {
        console.error('❌ Login error:', error);
        return res.status(500).json({
            success: false,
            message: 'Lỗi hệ thống. Vui lòng thử lại sau.'
        });
    }
});

// POST /api/auth/register - Đăng ký tài khoản mới
app.post('/api/auth/register', async (req, res) => {
    try {
        console.log('📝 Registration attempt:', req.body.email);
        
        const { email, password, ho_ten, so_dien_thoai, vung_id } = req.body;
        
        // Validate input
        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email và mật khẩu là bắt buộc'
            });
        }
        
        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Email không hợp lệ'
            });
        }
        
        // Validate password length
        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Mật khẩu phải có ít nhất 6 ký tự'
            });
        }
        
        // Kiểm tra email đã tồn tại chưa
        const checkRequest = new sql.Request(db.connectionPools.default);
        const checkResult = await checkRequest
            .input('email', sql.NVarChar(255), email.trim())
            .input('so_dien_thoai', sql.NVarChar(20), so_dien_thoai || null)
            .query(`
                SELECT id FROM users 
                WHERE email = @email 
                ${so_dien_thoai ? 'OR so_dien_thoai = @so_dien_thoai' : ''}
            `);
        
        if (checkResult.recordset.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Email hoặc số điện thoại đã được sử dụng'
            });
        }
        
        // Hash mật khẩu
        const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
        
        // Tạo user mới
        const insertRequest = new sql.Request(db.connectionPools.default);
        await insertRequest
            .input('email', sql.NVarChar(255), email.trim())
            .input('mat_khau', sql.NVarChar(255), hashedPassword)
            .input('ho_ten', sql.NVarChar(100), ho_ten || null)
            .input('so_dien_thoai', sql.NVarChar(20), so_dien_thoai || null)
            .input('vung_id', sql.NVarChar(10), vung_id || 'bac')
            .query(`
                INSERT INTO users (email, mat_khau, ho_ten, so_dien_thoai, vung_id, trang_thai)
                VALUES (@email, @mat_khau, @ho_ten, @so_dien_thoai, @vung_id, 1)
            `);
        
        const result = await insertRequest.query(`SELECT TOP 1 * FROM users WHERE email = @email ORDER BY ngay_tao DESC`);
        const newUser = result.recordset[0];
        
        console.log('✅ Registration successful:', newUser.email);
        
        // Tự động đăng nhập sau khi đăng ký
        const sessionToken = crypto.randomUUID();
        
        return res.json({
            success: true,
            message: 'Đăng ký thành công',
            token: sessionToken,
            user: {
                id: newUser.id,
                email: newUser.email,
                ho_ten: newUser.ho_ten,
                so_dien_thoai: newUser.so_dien_thoai,
                vung_id: newUser.vung_id,
                ngay_dang_ky: newUser.ngay_dang_ky
            },
            redirectUrl: '/'
        });
        
    } catch (error) {
        console.error('❌ Registration error:', error);
        return res.status(500).json({
            success: false,
            message: 'Lỗi hệ thống. Vui lòng thử lại sau.'
        });
    }
});

// POST /api/auth/logout - Đăng xuất
app.post('/api/auth/logout', async (req, res) => {
    try {
        // Xóa session token (nếu lưu trong DB/cache)
        
        return res.json({
            success: true,
            message: 'Đăng xuất thành công'
        });
    } catch (error) {
        console.error('❌ Logout error:', error);
        return res.status(500).json({
            success: false,
            message: 'Lỗi hệ thống'
        });
    }
});

// ========== API PROFILE MANAGEMENT ==========

// GET /api/profile/by-email/:email - Lấy thông tin profile user bằng EMAIL
app.get('/api/profile/by-email/:email', injectPoolForAdmin, async (req, res) => {
    try {
        const { email } = req.params;
        
        console.log('📧 Getting profile by email:', email);
        
        // Lấy thông tin user từ SQL Server bằng EMAIL
        const request = new sql.Request(req.dbPool);
        const userResult = await request
            .input('email', sql.NVarChar, email)
            .query(`
                SELECT id, email, ho_ten, so_dien_thoai, vung_id, 
                       mongo_profile_id, ngay_dang_ky, trang_thai
                FROM users 
                WHERE email = @email
            `);
        
        if (!userResult.recordset || userResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy người dùng với email: ' + email
            });
        }
        
        const user = userResult.recordset[0];
        
        // Lấy thông tin mở rộng từ MongoDB nếu có
        let extendedProfile = null;
        if (user.mongo_profile_id) {
            try {
                extendedProfile = await db.mongoDB
                    .collection('user_profiles')
                    .findOne({ _id: new db.ObjectId(user.mongo_profile_id) });
            } catch (mongoError) {
                console.warn('MongoDB profile not found:', mongoError);
            }
        }
        
        res.json({
            success: true,
            data: {
                user: user,
                extendedProfile: extendedProfile
            }
        });
        
    } catch (error) {
        console.error('Get profile by email error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin profile: ' + error.message
        });
    }
});

// GET /api/profile/:userId - Lấy thông tin profile user (giữ lại cho tương thích)
app.get('/api/profile/:userId', injectPoolForAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        
        // Lấy thông tin user từ SQL Server
        const request = new sql.Request(req.dbPool);
        const userResult = await request
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT id, email, ho_ten, so_dien_thoai, vung_id, 
                       mongo_profile_id, ngay_dang_ky, trang_thai
                FROM users 
                WHERE id = @userId
            `);
        
        if (!userResult.recordset || userResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy người dùng'
            });
        }
        
        const user = userResult.recordset[0];
        
        // Lấy thông tin mở rộng từ MongoDB nếu có
        let extendedProfile = null;
        if (user.mongo_profile_id) {
            try {
                const ObjectId = require('mongodb').ObjectId;
                extendedProfile = await DataModel.Mongo.db
                    .collection('user_profiles')
                    .findOne({ _id: new ObjectId(user.mongo_profile_id) });
            } catch (mongoError) {
                console.warn('MongoDB profile not found:', mongoError);
            }
        }
        
        res.json({
            success: true,
            data: {
                user: user,
                extendedProfile: extendedProfile
            }
        });
        
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin profile'
        });
    }
});

// PUT /api/profile/:userId - Cập nhật thông tin profile
app.put('/api/profile/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { ho_ten, so_dien_thoai, vung_id, dia_chi } = req.body;
        
        console.log('📝 Updating profile for user:', userId);
        console.log('📦 Update data:', { ho_ten, so_dien_thoai, vung_id, dia_chi });
        
        // Validate dữ liệu cơ bản
        if (!ho_ten || ho_ten.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Họ tên không được để trống'
            });
        }
        
        // Cập nhật SQL Server
        const request1 = new sql.Request(db.connectionPools.default);
        await request1
            .input('ho_ten', sql.NVarChar, ho_ten)
            .input('so_dien_thoai', sql.VarChar, so_dien_thoai || null)
            .input('vung_id', sql.VarChar, vung_id || null)
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE users 
                SET ho_ten = @ho_ten,
                    so_dien_thoai = @so_dien_thoai,
                    vung_id = @vung_id,
                    ngay_cap_nhat = GETDATE()
                WHERE id = @userId
            `);
        
        // Lấy mongo_profile_id
        const request2 = new sql.Request(db.connectionPools.default);
        const userResult = await request2
            .input('userId', sql.UniqueIdentifier, userId)
            .query('SELECT mongo_profile_id FROM users WHERE id = @userId');
        
        let mongoProfileId = userResult.recordset[0]?.mongo_profile_id;
        
        // Cập nhật hoặc tạo MongoDB profile
        if (dia_chi) {
            const mongoData = {
                dia_chi: dia_chi,
                updated_at: new Date()
            };
            
            if (mongoProfileId) {
                // Update existing profile
                await db.mongoDB.collection('user_profiles').updateOne(
                    { _id: new db.ObjectId(mongoProfileId) },
                    { $set: mongoData }
                );
            } else {
                // Create new profile
                mongoData.user_id = userId;
                mongoData.created_at = new Date();
                
                const mongoResult = await db.mongoDB.collection('user_profiles').insertOne(mongoData);
                mongoProfileId = mongoResult.insertedId.toString();
                
                // Update SQL with mongo_profile_id
                const request3 = new sql.Request(db.connectionPools.default);
                await request3
                    .input('mongoProfileId', sql.VarChar, mongoProfileId)
                    .input('userId', sql.UniqueIdentifier, userId)
                    .query('UPDATE users SET mongo_profile_id = @mongoProfileId WHERE id = @userId');
            }
        }
        
        // Lấy dữ liệu mới sau khi update
        const request4 = new sql.Request(db.connectionPools.default);
        const updatedUser = await request4
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT id, email, ho_ten, so_dien_thoai, vung_id, 
                       mongo_profile_id, ngay_dang_ky, trang_thai 
                FROM users WHERE id = @userId
            `);
        
        res.json({
            success: true,
            message: 'Cập nhật thông tin thành công',
            data: updatedUser.recordset[0]
        });
        
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật profile: ' + error.message
        });
    }
});

// =============================================
// API ĐỊA CHỈ NGƯỜI DÙNG (USER_ADDRESSES)
// =============================================

// GET /api/user-addresses/:userId - Lấy tất cả địa chỉ của user
app.get('/api/user-addresses/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT 
                    ua.id,
                    ua.loai_dia_chi,
                    ua.is_default,
                    ua.ten_nguoi_nhan,
                    ua.sdt_nguoi_nhan,
                    ua.dia_chi_cu_the,
                    ua.ghi_chu,
                    ua.phuong_xa_id,
                    w.ten_phuong_xa,
                    w.tinh_thanh_id,
                    p.ten_tinh,
                    p.vung_id,
                    r.ten_vung
                FROM user_addresses ua
                INNER JOIN wards w ON ua.phuong_xa_id = w.id
                INNER JOIN provinces p ON w.tinh_thanh_id = p.id
                INNER JOIN regions r ON p.vung_id = r.ma_vung
                WHERE ua.user_id = @userId AND ua.trang_thai = 1
                ORDER BY ua.is_default DESC, ua.ngay_tao DESC
            `);
        
        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('Get user addresses error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách địa chỉ'
        });
    }
});

// GET /api/user-addresses/:userId/default - Lấy địa chỉ mặc định của user
app.get('/api/user-addresses/:userId/default', async (req, res) => {
    try {
        const { userId } = req.params;
        
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT TOP 1
                    ua.id,
                    ua.loai_dia_chi,
                    ua.is_default,
                    ua.ten_nguoi_nhan,
                    ua.sdt_nguoi_nhan,
                    ua.dia_chi_cu_the,
                    ua.ghi_chu,
                    ua.phuong_xa_id,
                    w.ten_phuong_xa,
                    w.tinh_thanh_id,
                    p.ten_tinh,
                    p.vung_id,
                    r.ten_vung
                FROM user_addresses ua
                INNER JOIN wards w ON ua.phuong_xa_id = w.id
                INNER JOIN provinces p ON w.tinh_thanh_id = p.id
                INNER JOIN regions r ON p.vung_id = r.ma_vung
                WHERE ua.user_id = @userId AND ua.trang_thai = 1
                ORDER BY ua.is_default DESC, ua.ngay_tao DESC
            `);
        
        if (result.recordset.length === 0) {
            return res.json({
                success: true,
                data: null,
                message: 'User chưa có địa chỉ'
            });
        }
        
        res.json({
            success: true,
            data: result.recordset[0]
        });
    } catch (error) {
        console.error('Get default address error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy địa chỉ mặc định'
        });
    }
});

// POST /api/user-addresses - Thêm địa chỉ mới
app.post('/api/user-addresses', async (req, res) => {
    try {
        const { 
            userId, 
            loai_dia_chi, 
            is_default,
            ten_nguoi_nhan, 
            sdt_nguoi_nhan, 
            phuong_xa_id, 
            dia_chi_cu_the, 
            ghi_chu 
        } = req.body;
        
        // Nếu set làm mặc định, cần bỏ default của các địa chỉ khác
        if (is_default) {
            const updateRequest = new sql.Request(db.connectionPools.default);
            await updateRequest
                .input('userId1', sql.UniqueIdentifier, userId)
                .query(`UPDATE user_addresses SET is_default = 0 WHERE user_id = @userId1`);
        }
        
        const request = new sql.Request(db.connectionPools.default);
        
        // Insert without OUTPUT because table has triggers
        await request
            .input('userId', sql.UniqueIdentifier, userId)
            .input('loai_dia_chi', sql.NVarChar(20), loai_dia_chi || 'nha_rieng')
            .input('is_default', sql.Bit, is_default || 0)
            .input('ten_nguoi_nhan', sql.NVarChar(100), ten_nguoi_nhan)
            .input('sdt_nguoi_nhan', sql.VarChar(15), sdt_nguoi_nhan)
            .input('phuong_xa_id', sql.UniqueIdentifier, phuong_xa_id)
            .input('dia_chi_cu_the', sql.NVarChar(200), dia_chi_cu_the)
            .input('ghi_chu', sql.NVarChar(500), ghi_chu || null)
            .query(`
                INSERT INTO user_addresses (
                    user_id, loai_dia_chi, is_default, ten_nguoi_nhan, 
                    sdt_nguoi_nhan, phuong_xa_id, dia_chi_cu_the, ghi_chu
                )
                VALUES (
                    @userId, @loai_dia_chi, @is_default, @ten_nguoi_nhan,
                    @sdt_nguoi_nhan, @phuong_xa_id, @dia_chi_cu_the, @ghi_chu
                )
            `);
        
        // Get the last inserted ID
        const getIdRequest = new sql.Request(db.connectionPools.default);
        const result = await getIdRequest
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT TOP 1 id 
                FROM user_addresses 
                WHERE user_id = @userId 
                ORDER BY ngay_tao DESC
            `);
        
        res.json({
            success: true,
            data: { id: result.recordset[0]?.id },
            message: 'Thêm địa chỉ thành công'
        });
    } catch (error) {
        console.error('Add address error:', error);
        console.error('Error details:', error.message);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi thêm địa chỉ: ' + error.message
        });
    }
});

// PUT /api/user-addresses/:addressId - Cập nhật địa chỉ
app.put('/api/user-addresses/:addressId', async (req, res) => {
    try {
        const { addressId } = req.params;
        const { 
            userId,
            loai_dia_chi, 
            is_default,
            ten_nguoi_nhan, 
            sdt_nguoi_nhan, 
            phuong_xa_id, 
            dia_chi_cu_the, 
            ghi_chu 
        } = req.body;
        
        // Nếu set làm mặc định, cần bỏ default của các địa chỉ khác
        if (is_default) {
            const updateRequest = new sql.Request(db.connectionPools.default);
            await updateRequest
                .input('userId1', sql.UniqueIdentifier, userId)
                .query(`UPDATE user_addresses SET is_default = 0 WHERE user_id = @userId1`);
        }
        
        const request = new sql.Request(db.connectionPools.default);
        await request
            .input('addressId', sql.UniqueIdentifier, addressId)
            .input('loai_dia_chi', sql.NVarChar(20), loai_dia_chi)
            .input('is_default', sql.Bit, is_default)
            .input('ten_nguoi_nhan', sql.NVarChar(100), ten_nguoi_nhan)
            .input('sdt_nguoi_nhan', sql.VarChar(15), sdt_nguoi_nhan)
            .input('phuong_xa_id', sql.UniqueIdentifier, phuong_xa_id)
            .input('dia_chi_cu_the', sql.NVarChar(200), dia_chi_cu_the)
            .input('ghi_chu', sql.NVarChar(500), ghi_chu || null)
            .query(`
                UPDATE user_addresses SET
                    loai_dia_chi = @loai_dia_chi,
                    is_default = @is_default,
                    ten_nguoi_nhan = @ten_nguoi_nhan,
                    sdt_nguoi_nhan = @sdt_nguoi_nhan,
                    phuong_xa_id = @phuong_xa_id,
                    dia_chi_cu_the = @dia_chi_cu_the,
                    ghi_chu = @ghi_chu,
                    ngay_cap_nhat = GETDATE()
                WHERE id = @addressId
            `);
        
        res.json({
            success: true,
            message: 'Cập nhật địa chỉ thành công'
        });
    } catch (error) {
        console.error('Update address error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật địa chỉ'
        });
    }
});

// DELETE /api/user-addresses/:addressId - Xóa địa chỉ
app.delete('/api/user-addresses/:addressId', async (req, res) => {
    try {
        const { addressId } = req.params;
        
        const request = new sql.Request(db.connectionPools.default);
        await request
            .input('addressId', sql.UniqueIdentifier, addressId)
            .query(`UPDATE user_addresses SET trang_thai = 0 WHERE id = @addressId`);
        
        res.json({
            success: true,
            message: 'Xóa địa chỉ thành công'
        });
    } catch (error) {
        console.error('Delete address error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa địa chỉ'
        });
    }
});

// POST /api/profile/:userId/change-password - Đổi mật khẩu
app.post('/api/profile/:userId/change-password', async (req, res) => {
    try {
        const { userId } = req.params;
        const { current_password, new_password } = req.body;
        
        console.log('🔐 Change password request for user:', userId);
        
        // Validate
        if (!current_password || !new_password) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng nhập đầy đủ thông tin'
            });
        }
        
        if (new_password.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'Mật khẩu mới phải có ít nhất 6 ký tự'
            });
        }
        
        // Lấy mật khẩu hiện tại
        const request1 = new sql.Request(db.connectionPools.default);
        const userResult = await request1
            .input('userId', sql.UniqueIdentifier, userId)
            .query('SELECT mat_khau FROM users WHERE id = @userId');
        
        if (!userResult.recordset || userResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy người dùng'
            });
        }
        
        // Kiểm tra mật khẩu hiện tại
        const currentPasswordHash = crypto.createHash('sha256').update(current_password).digest('hex');
        
        if (currentPasswordHash !== userResult.recordset[0].mat_khau) {
            return res.status(401).json({
                success: false,
                message: 'Mật khẩu hiện tại không đúng'
            });
        }
        
        // Hash mật khẩu mới
        const newPasswordHash = crypto.createHash('sha256').update(new_password).digest('hex');
        
        // Cập nhật mật khẩu
        const request2 = new sql.Request(db.connectionPools.default);
        await request2
            .input('mat_khau', sql.VarChar, newPasswordHash)
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                UPDATE users 
                SET mat_khau = @mat_khau,
                    ngay_cap_nhat = GETDATE()
                WHERE id = @userId
            `);
        
        res.json({
            success: true,
            message: 'Đổi mật khẩu thành công'
        });
        
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi đổi mật khẩu: ' + error.message
        });
    }
});

// Trang chi tiết sản phẩm
app.get('/product/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        console.log('🔍 Loading product detail:', productId);

        // Lấy thông tin sản phẩm từ SQL Server
        const product = await DataModel.SQL.Product.findById(productId);
        
        if (!product) {
            return res.status(404).send('Không tìm thấy sản phẩm');
        }

        // ✅ KIỂM TRA FLASH SALE ĐANG ACTIVE
        let isFlashSale = false;
        let flashSaleInfo = null;
        let priceToDisplay = product.gia_ban;
        
        try {
            const flashSaleItems = await DataModel.SQL.FlashSaleItem.findActiveByProductId(productId);
            
            if (flashSaleItems && flashSaleItems.length > 0) {
                // Lấy flash sale item đầu tiên (giá thấp nhất hoặc ưu tiên nhất)
                const flashSaleItem = flashSaleItems[0];
                isFlashSale = true;
                priceToDisplay = flashSaleItem.gia_flash_sale;
                const conLaiFlashSale = flashSaleItem.so_luong_ton - flashSaleItem.da_ban;
                
                // Safe calculation for discount percentage
                const giaGoc = flashSaleItem.gia_goc || flashSaleItem.gia_flash_sale;
                const phanTramGiam = giaGoc > 0 ? Math.round((1 - flashSaleItem.gia_flash_sale / giaGoc) * 100) : 0;
                
                flashSaleInfo = {
                    id: flashSaleItem.id,
                    flash_sale_id: flashSaleItem.flash_sale_id,
                    ten_flash_sale: flashSaleItem.ten_flash_sale,
                    gia_goc: giaGoc,
                    gia_flash_sale: flashSaleItem.gia_flash_sale,
                    phan_tram_giam: phanTramGiam,
                    so_luong_gioi_han: flashSaleItem.so_luong_ton,
                    da_ban: flashSaleItem.da_ban,
                    con_lai: conLaiFlashSale,
                    gioi_han_mua: flashSaleItem.gioi_han_mua,
                    ngay_bat_dau: flashSaleItem.ngay_bat_dau,
                    ngay_ket_thuc: flashSaleItem.ngay_ket_thuc,
                    is_low_stock: conLaiFlashSale < 10 && conLaiFlashSale > 0
                };
                console.log('🔥 Flash Sale Active:', flashSaleInfo);
            }
        } catch (flashSaleError) {
            console.error('⚠️ Error loading flash sale info:', flashSaleError);
            // Continue without flash sale info
        }

        // Lấy tất cả variants (inventory) của sản phẩm
        const inventory = await DataModel.SQL.Inventory.findByProduct(productId);
        console.log('📦 Inventory variants:', inventory.length);

        // ✅ Load product_variants với thông tin flash sale
        const productVariants = await DataModel.SQL.ProductVariant.findByProductId(productId);
        
        // Thêm thông tin flash sale vào mỗi variant
        const variantsWithFlashSale = await Promise.all(productVariants.map(async (variant) => {
            try {
                // Tìm flash sale item cho variant này
                const flashSaleItem = await DataModel.SQL.FlashSaleItem.findActiveByVariantId(variant.id);
                
                if (flashSaleItem) {
                    const conLai = flashSaleItem.so_luong_ton - flashSaleItem.da_ban;
                    const phanTramGiam = flashSaleItem.gia_goc > 0 ? 
                        Math.round((1 - flashSaleItem.gia_flash_sale / flashSaleItem.gia_goc) * 100) : 0;
                    
                    return {
                        ...variant,
                        isFlashSale: true,
                        flashSale: {
                            id: flashSaleItem.id,
                            gia_goc: flashSaleItem.gia_goc,
                            gia_flash_sale: flashSaleItem.gia_flash_sale,
                            phan_tram_giam: phanTramGiam,
                            so_luong_ton: flashSaleItem.so_luong_ton,
                            da_ban: flashSaleItem.da_ban,
                            con_lai: conLai,
                            gioi_han_mua: flashSaleItem.gioi_han_mua,
                            ngay_bat_dau: flashSaleItem.ngay_bat_dau,  // ✅ Thêm thời gian từ flash_sales
                            ngay_ket_thuc: flashSaleItem.ngay_ket_thuc,  // ✅ Thêm thời gian kết thúc
                            is_low_stock: conLai < 10 && conLai > 0
                        }
                    };
                }
                
                return {
                    ...variant,
                    isFlashSale: false,
                    flashSale: null
                };
            } catch (err) {
                console.error('Error loading flash sale for variant:', variant.id, err);
                return {
                    ...variant,
                    isFlashSale: false,
                    flashSale: null
                };
            }
        }));
        
        console.log('✨ Variants with flash sale info:', variantsWithFlashSale.length);

        // Lấy thông tin chi tiết từ MongoDB
        let mongoDetail = null;
        let thongSoKyThuat = [];
        let hinhAnhPhu = [];
        let moTaChiTiet = '';
        let variants = null;
        let videos = [];
        let videoLinks = [];
        
        try {
            // Ưu tiên query bằng mongo_detail_id nếu có (nhanh hơn vì query theo _id)
            if (product.mongo_detail_id) {
                console.log('🔍 Fetching MongoDB by mongo_detail_id:', product.mongo_detail_id);
                mongoDetail = await DataModel.Mongo.ProductDetail.findById(product.mongo_detail_id).lean();
            } else {
                // Fallback: query bằng sql_product_id (case-insensitive)
                console.log('🔍 Fetching MongoDB by sql_product_id:', productId);
                mongoDetail = await DataModel.Mongo.ProductDetail.findOne({ 
                    sql_product_id: new RegExp(`^${productId}$`, 'i')
                }).lean();
            }
            
            if (mongoDetail) {
                console.log('✅ Found MongoDB detail:', mongoDetail._id);
                console.log('📋 MongoDB fields:', Object.keys(mongoDetail));
                
                // Lấy thông số kỹ thuật từ MongoDB
                if (mongoDetail.thong_so_ky_thuat && Array.isArray(mongoDetail.thong_so_ky_thuat)) {
                    thongSoKyThuat = mongoDetail.thong_so_ky_thuat.map(spec => ({
                        ten: spec.ten ? spec.ten.replace(/\n/g, '<br>') : spec.ten,
                        gia_tri: spec.gia_tri ? spec.gia_tri.replace(/\n/g, '<br>') : spec.gia_tri
                    }));
                    console.log(`📋 Specs count: ${thongSoKyThuat.length}`);
                }
                
                // Lấy variants (phiên bản sản phẩm)
                if (mongoDetail.variants) {
                    variants = mongoDetail.variants;
                    console.log(`🎨 Variants:`, variants);
                }
                
                // Lấy hình ảnh phụ
                if (mongoDetail.hinh_anh && Array.isArray(mongoDetail.hinh_anh)) {
                    hinhAnhPhu = mongoDetail.hinh_anh;
                    console.log(`🖼️ Additional images: ${hinhAnhPhu.length}`);
                }
                
                // Lấy videos
                if (mongoDetail.videos && Array.isArray(mongoDetail.videos)) {
                    videos = mongoDetail.videos;
                    console.log(`🎬 Videos: ${videos.length}`);
                }
                
                // Lấy video links (YouTube, Vimeo, etc.)
                if (mongoDetail.video_links && Array.isArray(mongoDetail.video_links)) {
                    videoLinks = mongoDetail.video_links;
                    console.log(`🔗 Video links: ${videoLinks.length}`);
                }
                
                // Lấy mô tả chi tiết
                if (mongoDetail.mo_ta_chi_tiet) {
                    moTaChiTiet = mongoDetail.mo_ta_chi_tiet;
                }
            } else {
                console.log('⚠️ No MongoDB detail found for product:', productId);
            }
        } catch (mongoError) {
            console.error('❌ Error fetching MongoDB detail:', mongoError);
        }

        // Format giá tiền
        const formattedProduct = {
            ...product,
            id: product.id,
            gia_ban_formatted: new Intl.NumberFormat('vi-VN', {
                style: 'currency',
                currency: 'VND'
            }).format(isFlashSale ? priceToDisplay : product.gia_ban),
            gia_niem_yet_formatted: product.gia_niem_yet ? new Intl.NumberFormat('vi-VN', {
                style: 'currency',
                currency: 'VND'
            }).format(product.gia_niem_yet) : null,
            tiet_kiem_formatted: product.gia_niem_yet ? new Intl.NumberFormat('vi-VN', {
                style: 'currency',
                currency: 'VND'
            }).format(product.gia_niem_yet - (isFlashSale ? priceToDisplay : product.gia_ban)) : null,
            is_discount: product.gia_niem_yet && product.gia_niem_yet > product.gia_ban,
            phan_tram_giam: isFlashSale ? flashSaleInfo.phan_tram_giam : (product.gia_niem_yet ? 
                Math.round((1 - product.gia_ban / product.gia_niem_yet) * 100) : 0),
            // Thêm dữ liệu từ MongoDB
            thong_so_ky_thuat: thongSoKyThuat,
            hinh_anh_phu: hinhAnhPhu,
            mo_ta_chi_tiet: moTaChiTiet || product.mo_ta || '',
            variants: variants,
            videos: videos,
            video_links: videoLinks,
            // Thêm giá gốc từ SQL để dùng cho variants
            sql_gia_niem_yet: product.gia_niem_yet,
            // ✅ Flash sale data
            isFlashSale: isFlashSale,
            flashSaleInfo: flashSaleInfo,
            priceToDisplay: priceToDisplay
        };

        console.log('📦 Product detail loaded:', {
            id: formattedProduct.id,
            name: formattedProduct.ten_san_pham,
            specs: thongSoKyThuat.length,
            images: hinhAnhPhu.length,
            hasDescription: !!moTaChiTiet,
            isFlashSale: isFlashSale,
            inventoryVariants: inventory.length
        });

        res.render('productDetail', {
            layout: 'HomeMain.handlebars',
            product: formattedProduct,
            inventory: inventory, // ✅ Truyền inventory variants xuống view (legacy)
            productVariants: variantsWithFlashSale, // ✅ NEW: Variants với flash sale info
            mongoVariants: variants // ✅ MongoDB variants grouped by site_origin
        });
    } catch (err) {
        console.error('Error loading product detail:', err);
        res.status(500).send('Lỗi server!');
    }
});

// Admin logout
app.get('/logout', (req, res) => {
    res.redirect('/');
});

// Hàm đệ quy để xử lý nested objects
function extractTechnicalSpecs(obj) {
  const result = {};
  
  function processValue(currentObj) {
    for (const [key, value] of Object.entries(currentObj)) {
      // Chỉ xử lý thong_so_ky_thuat
      if (key === 'thong_so_ky_thuat' && Array.isArray(value)) {
        console.log('🔧 Processing thong_so_ky_thuat array with', value.length, 'items');
        
        value.forEach((item, index) => {
          if (item && typeof item === 'object' && item.ten && item.gia_tri !== undefined) {
            // Sử dụng trực tiếp tên từ trường 'ten' làm key
            const displayKey = item.ten.trim();
            result[displayKey] = item.gia_tri;
            // console.log(`Extracted: "${displayKey}" = "${item.gia_tri}"`);
          } else if (item && typeof item === 'object') {
            // Nếu có nested object trong thong_so_ky_thuat, xử lý tiếp
            processValue(item);
          }
        });
      }
      // Nếu có nested object, tiếp tục tìm thong_so_ky_thuat
      else if (value && typeof value === 'object' && !Array.isArray(value)) {
        processValue(value);
      }
      // Nếu là array (không phải thong_so_ky_thuat), tìm trong từng phần tử
      else if (Array.isArray(value)) {
        value.forEach(item => {
          if (item && typeof item === 'object') {
            processValue(item);
          }
        });
      }
    }
  }
  
  processValue(obj);
  return result;
}

// Route GET /admin/sanpham - Hiển thị trang quản lý sản phẩm - CẬP NHẬT CHO SCHEMA MỚI
app.get('/admin/sanpham', requireAdmin, async (req, res) => {
    try {
        console.log('🚀 Loading admin products page - NEW SCHEMA...');
        
        const pool = req.dbPool;
        
        // Lấy danh sách categories
        const categoriesResult = await pool.request()
            .query('SELECT id, ten_danh_muc, slug FROM categories WHERE trang_thai = 1 ORDER BY thu_tu');
        
        // Lấy danh sách brands
        const brandsResult = await pool.request()
            .query('SELECT id, ten_thuong_hieu, slug, logo_url FROM brands');
        
        // Lấy danh sách regions
        const regionsResult = await pool.request()
            .query('SELECT ma_vung, ten_vung FROM regions WHERE trang_thai = 1 ORDER BY ma_vung');

        console.log('📊 Data loaded:');
        console.log('  - Categories:', categoriesResult.recordset.length);
        console.log('  - Brands:', brandsResult.recordset.length);
        console.log('  - Regions:', regionsResult.recordset.length);

        res.render('sanpham', {
            layout: 'AdminMain',
            title: 'Quản lý sản phẩm',
            categories: categoriesResult.recordset,
            brands: brandsResult.recordset,
            regions: regionsResult.recordset
        });
        
    } catch (err) {
        console.error('❌ Lỗi trong route /admin/sanpham:', err);
        res.status(500).send(`
            <html>
                <head><title>Lỗi</title></head>
                <body>
                    <h1>Đã xảy ra lỗi</h1>
                    <p>Không thể tải trang quản lý sản phẩm: ${err.message}</p>
                    <a href="/admin">Quay lại trang chủ</a>
                </body>
            </html>
        `);
    }
});

// API để frontend gọi (trả về JSON) - CẬP NHẬT CHO SCHEMA MỚI
app.get('/api/sanpham', async (req, res) => {
    try {
        console.log('🔄 API /api/sanpham called - NEW SCHEMA');
        
        const { vung_id } = req.query; // Optional filter by region
        const pool = db.connectionPools.default;
        
        // Lấy danh sách products với số lượng variants
        const productsResult = await pool.request()
            .query(`
                SELECT 
                    p.id,
                    p.ma_san_pham,
                    p.ten_san_pham,
                    p.danh_muc_id,
                    p.thuong_hieu_id,
                    p.mo_ta_ngan,
                    p.link_anh_dai_dien,
                    p.mongo_detail_id,
                    p.site_created,
                    p.gia_ban,
                    p.gia_niem_yet,
                    p.trang_thai,
                    p.luot_xem,
                    p.ngay_tao,
                    p.ngay_cap_nhat,
                    c.ten_danh_muc,
                    b.ten_thuong_hieu,
                    b.logo_url as brand_logo,
                    -- Đếm số variants (all)
                    (SELECT COUNT(*) FROM product_variants pv WHERE pv.san_pham_id = p.id) as so_bien_the,
                    -- Đếm số variants active
                    (SELECT COUNT(*) FROM product_variants pv WHERE pv.san_pham_id = p.id AND pv.trang_thai = 1) as so_bien_the_active,
                    -- Đếm số variants theo vùng (nếu có filter)
                    (SELECT COUNT(*) FROM product_variants pv WHERE pv.san_pham_id = p.id AND pv.trang_thai = 1 
                        ${vung_id ? "AND pv.site_origin = '" + vung_id + "'" : ""}) as so_bien_the_vung
                FROM products p
                LEFT JOIN categories c ON p.danh_muc_id = c.id
                LEFT JOIN brands b ON p.thuong_hieu_id = b.id
                ORDER BY p.ngay_tao DESC
            `);

        // Lấy variants - JOIN với products để đảm bảo mapping chính xác
        const variantsQuery = `
            SELECT 
                pv.id,
                pv.san_pham_id,
                pv.ma_sku,
                pv.ten_hien_thi,
                pv.gia_niem_yet,
                pv.gia_ban,
                pv.so_luong_ton_kho,
                pv.luot_ban,
                pv.anh_dai_dien,
                pv.site_origin,
                pv.trang_thai,
                pv.ngay_tao,
                pv.ngay_cap_nhat,
                p.id as product_id_check
            FROM product_variants pv
            INNER JOIN products p ON pv.san_pham_id = p.id
            WHERE pv.trang_thai = 1
            ${vung_id ? "AND pv.site_origin = @vung_id" : ""}
            ORDER BY pv.ngay_tao DESC
        `;
        
        const variantsRequest = pool.request();
        if (vung_id) {
            variantsRequest.input('vung_id', sql.NVarChar(10), vung_id);
        }
        const variantsResult = await variantsRequest.query(variantsQuery);

        console.log('📦 Variants Query Result:', {
            totalVariants: variantsResult.recordset.length,
            vung_id_filter: vung_id || 'none',
            sampleVariants: variantsResult.recordset.slice(0, 3).map(v => ({
                variant_id: v.id,
                san_pham_id: v.san_pham_id,
                product_id_check: v.product_id_check,
                ids_match: v.san_pham_id === v.product_id_check,
                ma_sku: v.ma_sku,
                site_origin: v.site_origin
            }))
        });

        // Nhóm variants theo san_pham_id (sử dụng san_pham_id từ variant)
        const variantsByProduct = {};
        variantsResult.recordset.forEach(variant => {
            // Sử dụng trực tiếp san_pham_id từ variant (đã được JOIN verify)
            const productId = variant.san_pham_id;
            if (!variantsByProduct[productId]) {
                variantsByProduct[productId] = [];
            }
            variantsByProduct[productId].push({
                id: variant.id,
                san_pham_id: variant.san_pham_id,
                ma_sku: variant.ma_sku,
                ten_hien_thi: variant.ten_hien_thi,
                gia_niem_yet: variant.gia_niem_yet,
                gia_ban: variant.gia_ban,
                so_luong_ton_kho: variant.so_luong_ton_kho || 0,
                luot_ban: variant.luot_ban || 0,
                anh_dai_dien: variant.anh_dai_dien,
                site_origin: variant.site_origin,
                trang_thai: variant.trang_thai,
                ngay_tao: variant.ngay_tao
            });
        });
        
        console.log('📊 Variants mapping:', {
            totalProducts: Object.keys(variantsByProduct).length,
            sampleKeys: Object.keys(variantsByProduct).slice(0, 3)
        });

        // Lấy MongoDB details nếu có
        let productDetails = [];
        if (mongoose.connection.readyState === 1) {
            try {
                const ProductDetail = mongoose.connection.db.collection('product_details');
                productDetails = await ProductDetail.find({}).toArray();
            } catch (mongoErr) {
                console.warn('MongoDB fetch warning:', mongoErr.message);
            }
        }

        // Tạo map cho MongoDB details
        const detailMap = new Map();
        productDetails.forEach(detail => {
            const detailId = String(detail.sql_product_id);
            const technicalSpecs = extractTechnicalSpecs(detail);
            detailMap.set(detailId, technicalSpecs);
        });

        // Kết hợp dữ liệu
        const combinedProducts = productsResult.recordset.map(product => {
            // Sử dụng trực tiếp product.id để map (không lowercase)
            const variants = variantsByProduct[product.id] || [];
            
            // Debug cho sản phẩm cụ thể
            if (product.id === '96D9423E-F36B-1410-8B02-00449F2BB6F5') {
                console.log('🔍 DEBUG Product Mapping:', {
                    productId: product.id,
                    productName: product.ten_san_pham,
                    so_bien_the_from_count: product.so_bien_the,
                    variants_array_length: variants.length,
                    hasKey: variantsByProduct.hasOwnProperty(product.id),
                    all_product_ids_with_variants: Object.keys(variantsByProduct).slice(0, 5),
                    variants_sample: variants.slice(0, 2)
                });
            }

            // Tính giá min/max từ variants (chỉ active variants)
            let gia_ban_min = 0;
            let gia_ban_max = 0;
            let gia_niem_yet_min = 0;
            let tong_luot_ban = 0;

            const activeVariants = variants.filter(v => v.trang_thai === 1);
            if (activeVariants.length > 0) {
                gia_ban_min = Math.min(...activeVariants.map(v => v.gia_ban));
                gia_ban_max = Math.max(...activeVariants.map(v => v.gia_ban));
                gia_niem_yet_min = Math.min(...activeVariants.map(v => v.gia_niem_yet));
                tong_luot_ban = activeVariants.reduce((sum, v) => sum + (v.luot_ban || 0), 0);
            }

            // Lấy danh sách vùng có bán (từ site_origin của variants)
            const regions_available = [...new Set(activeVariants.map(v => v.site_origin))].sort();
            const region_icons = regions_available.map(region => {
                const regionNames = {
                    'bac': 'Miền Bắc',
                    'trung': 'Miền Trung', 
                    'nam': 'Miền Nam'
                };
                return {
                    site_origin: region,
                    ten_vung: regionNames[region] || region,
                    icon: 'fas fa-map-marker-alt'
                };
            });
            
            // Debug log cho sản phẩm cụ thể
            if (product.id === '96D9423E-F36B-1410-8B02-00449F2BB6F5') {
                console.log('🎯 Product regions data:', {
                    productName: product.ten_san_pham,
                    activeVariants: activeVariants.length,
                    regions_available,
                    region_icons
                });
            }

            return {
                id: product.id,
                ma_san_pham: product.ma_san_pham,
                ten_san_pham: product.ten_san_pham,
                danh_muc_id: product.danh_muc_id,
                thuong_hieu_id: product.thuong_hieu_id,
                ten_danh_muc: product.ten_danh_muc,
                ten_thuong_hieu: product.ten_thuong_hieu,
                brand_logo: product.brand_logo,
                mo_ta_ngan: product.mo_ta_ngan,
                link_anh_dai_dien: product.link_anh_dai_dien,
                mongo_detail_id: product.mongo_detail_id,
                site_created: product.site_created,
                // Giá lấy từ variants (ưu tiên) hoặc fallback về products table
                gia_ban: gia_ban_min || product.gia_ban || 0,
                gia_niem_yet: gia_niem_yet_min || product.gia_niem_yet || 0,
                trang_thai: product.trang_thai,
                luot_xem: product.luot_xem,
                ngay_tao: product.ngay_tao,
                ngay_cap_nhat: product.ngay_cap_nhat,
                // Thông tin từ variants (product_variants table)
                variants: variants,
                so_bien_the: product.so_bien_the || 0, // Từ COUNT query
                so_bien_the_active: product.so_bien_the_active || 0, // Từ COUNT active query
                so_bien_the_vung: product.so_bien_the_vung || 0, // Variants theo vùng
                regions_available: regions_available, // Danh sách vùng có bán: ['bac', 'nam']
                region_icons: region_icons, // Chi tiết vùng với icon
                gia_ban_min: gia_ban_min,
                gia_ban_max: gia_ban_max,
                gia_niem_yet_min: gia_niem_yet_min,
                gia_niem_yet_max: activeVariants.length > 0 ? Math.max(...activeVariants.map(v => v.gia_niem_yet)) : 0,
                tong_luot_ban: tong_luot_ban,
                tong_ton_kho: activeVariants.reduce((sum, v) => sum + (v.so_luong_ton_kho || 0), 0),
                // Thông số kỹ thuật từ MongoDB
                chi_tiet: detailMap.get(product.id) || {}
            };
        });

        // Trả về JSON cho API
        res.json({
            success: true,
            data: {
                sanphams: combinedProducts,
                totalProducts: combinedProducts.length,
                totalVariants: variantsResult.recordset.length
            },
            filter: vung_id ? { vung_id } : null,
            meta: {
                totalProducts: combinedProducts.length,
                totalVariants: variantsResult.recordset.length,
                totalWithSpecs: combinedProducts.filter(sp => Object.keys(sp.chi_tiet).length > 0).length,
                timestamp: new Date().toISOString()
            }
        });
        
    } catch (err) {
        console.error('❌ Lỗi trong API /api/sanpham:', err);
        res.status(500).json({
            success: false,
            message: 'Đã xảy ra lỗi khi lấy dữ liệu sản phẩm',
            error: process.env.NODE_ENV === 'development' ? err.message : undefined
        });
    }
});


// API cập nhật sản phẩm (toggle status, update thông tin cơ bản)
app.put('/admin/sanpham/:id', requireAdmin, async (req, res) => {
    try {
        const productId = req.params.id;
        const updateData = req.body;

        console.log(`🔄 API: Cập nhật sản phẩm ${productId}`, updateData);

        const pool = req.dbPool;
        const request = pool.request();
        
        // Build dynamic UPDATE query
        const updates = [];
        
        if (updateData.trang_thai !== undefined) {
            request.input('trang_thai', sql.Bit, updateData.trang_thai);
            updates.push('trang_thai = @trang_thai');
        }
        if (updateData.ten_san_pham !== undefined) {
            request.input('ten_san_pham', sql.NVarChar(255), updateData.ten_san_pham);
            updates.push('ten_san_pham = @ten_san_pham');
        }
        if (updateData.mo_ta_ngan !== undefined) {
            request.input('mo_ta_ngan', sql.NVarChar(sql.MAX), updateData.mo_ta_ngan);
            updates.push('mo_ta_ngan = @mo_ta_ngan');
        }
        if (updateData.danh_muc_id !== undefined) {
            request.input('danh_muc_id', sql.UniqueIdentifier, updateData.danh_muc_id);
            updates.push('danh_muc_id = @danh_muc_id');
        }
        if (updateData.thuong_hieu_id !== undefined) {
            request.input('thuong_hieu_id', sql.UniqueIdentifier, updateData.thuong_hieu_id);
            updates.push('thuong_hieu_id = @thuong_hieu_id');
        }
        
        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Không có dữ liệu để cập nhật'
            });
        }
        
        updates.push('ngay_cap_nhat = GETDATE()');
        
        const query = `
            UPDATE products
            SET ${updates.join(', ')}
            WHERE id = @id
        `;
        
        request.input('id', sql.UniqueIdentifier, productId);
        await request.query(query);

        console.log('✅ Đã cập nhật sản phẩm thành công');

        res.json({
            success: true,
            message: 'Cập nhật sản phẩm thành công',
            data: { id: productId, ...updateData }
        });

    } catch (error) {
        console.error('❌ Lỗi khi cập nhật sản phẩm:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật sản phẩm',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// API cập nhật thông số kỹ thuật - Phiên bản cho schema hiện tại
app.put('/admin/sanpham/:id/chitiet', async (req, res) => {
    try {
        const productId = req.params.id;
        const specsData = req.body;

        console.log(`🔄 API: Cập nhật thông số cho sản phẩm ${productId}`);

        // Chuyển đổi dữ liệu
        const thongSoKyThuatArray = Object.entries(specsData).map(([ten, gia_tri]) => ({
            ten: ten,
            gia_tri: gia_tri
        }));

        console.log(`📝 Sẽ cập nhật ${thongSoKyThuatArray.length} thông số`);

        // Sử dụng updateOne với $set
        const result = await DataModel.Mongo.ProductDetail.updateOne(
            { sql_product_id: productId },
            { 
                $set: { 
                    thong_so_ky_thuat: thongSoKyThuatArray,
                    updatedAt: new Date()
                } 
            }
        );

        console.log('✅ Kết quả updateOne:', result);

        if (result.modifiedCount === 0 && result.matchedCount === 0) {
            // Nếu không tìm thấy document, tạo mới
            const newDoc = new DataModel.Mongo.ProductDetail({
                sql_product_id: productId,
                thong_so_ky_thuat: thongSoKyThuatArray,
                updatedAt: new Date(),
                createdAt: new Date()
            });
            await newDoc.save();
            console.log('📝 Đã tạo document mới');
        }

        // Kiểm tra lại
        const updatedDoc = await DataModel.Mongo.ProductDetail.findOne({ 
            sql_product_id: productId 
        });

        res.json({
            success: true,
            message: 'Cập nhật thông số kỹ thuật thành công',
            data: {
                id: productId,
                thong_so_ky_thuat: updatedDoc?.thong_so_ky_thuat || [],
                specs_count: thongSoKyThuatArray.length
            }
        });

    } catch (error) {
        console.error('❌ Lỗi khi cập nhật thông số kỹ thuật:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật thông số kỹ thuật',
            error: error.message
        });
    }
});


// =============================================
// NEW PRODUCT API ROUTES - FOR NEW SCHEMA
// =============================================

// POST /api/products - Tạo sản phẩm mới (bảng products)
app.post('/api/products', async (req, res) => {
    try {
        const {
            ma_san_pham,
            ten_san_pham,
            danh_muc_id,
            thuong_hieu_id,
            mo_ta_ngan,
            link_anh_dai_dien,
            site_created,
            trang_thai,
            gia_ban,
            gia_niem_yet
        } = req.body;

        console.log('🔄 API: Tạo sản phẩm mới', { ma_san_pham, ten_san_pham });

        // Validate
        if (!ma_san_pham || !ten_san_pham || !danh_muc_id || !thuong_hieu_id) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin bắt buộc: mã sản phẩm, tên, danh mục, thương hiệu'
            });
        }

        const pool = db.connectionPools.default;

        // Kiểm tra mã sản phẩm trùng
        const checkResult = await pool.request()
            .input('ma_san_pham', sql.NVarChar(100), ma_san_pham)
            .query('SELECT id FROM products WHERE ma_san_pham = @ma_san_pham');

        if (checkResult.recordset.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Mã sản phẩm đã tồn tại'
            });
        }

        // Insert product
        const insertRequest = pool.request();
        await insertRequest
            .input('ma_san_pham', sql.NVarChar(100), ma_san_pham)
            .input('ten_san_pham', sql.NVarChar(255), ten_san_pham)
            .input('danh_muc_id', sql.UniqueIdentifier, danh_muc_id)
            .input('thuong_hieu_id', sql.UniqueIdentifier, thuong_hieu_id)
            .input('mo_ta_ngan', sql.NVarChar(500), mo_ta_ngan || null)
            .input('link_anh_dai_dien', sql.NVarChar(500), link_anh_dai_dien || null)
            .input('site_created', sql.NVarChar(10), site_created || 'bac')
            .input('gia_ban', sql.Int, gia_ban || 0)
            .input('gia_niem_yet', sql.Int, gia_niem_yet || 0)
            .input('trang_thai', sql.Bit, trang_thai !== undefined ? trang_thai : 1)
            .query(`
                INSERT INTO products (
                    ma_san_pham, ten_san_pham, danh_muc_id, thuong_hieu_id,
                    mo_ta_ngan, link_anh_dai_dien, site_created, gia_ban, gia_niem_yet, trang_thai
                )
                VALUES (
                    @ma_san_pham, @ten_san_pham, @danh_muc_id, @thuong_hieu_id,
                    @mo_ta_ngan, @link_anh_dai_dien, @site_created, @gia_ban, @gia_niem_yet, @trang_thai
                )
            `);
        
        const selectResult = await insertRequest.query(`SELECT TOP 1 * FROM products WHERE ma_san_pham = @ma_san_pham ORDER BY ngay_tao DESC`);

        res.status(201).json({
            success: true,
            message: 'Tạo sản phẩm thành công',
            data: selectResult.recordset[0]
        });

    } catch (error) {
        console.error('❌ Lỗi khi tạo sản phẩm:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi tạo sản phẩm',
            error: error.message
        });
    }
});

// PUT /api/products/:id - Cập nhật sản phẩm
app.put('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            ma_san_pham,
            ten_san_pham,
            danh_muc_id,
            thuong_hieu_id,
            mo_ta_ngan,
            link_anh_dai_dien,
            site_created,
            gia_ban,
            gia_niem_yet,
            trang_thai,
            mongo_detail_id
        } = req.body;

        console.log('🔄 API: Cập nhật sản phẩm', { id, ten_san_pham });

        const pool = db.connectionPools.default;

        // Kiểm tra sản phẩm tồn tại
        const checkResult = await pool.request()
            .input('id', sql.UniqueIdentifier, id)
            .query('SELECT id FROM products WHERE id = @id');

        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // Update
        const updateRequest = pool.request();
        await updateRequest
            .input('id', sql.UniqueIdentifier, id)
            .input('ma_san_pham', sql.NVarChar(100), ma_san_pham)
            .input('ten_san_pham', sql.NVarChar(255), ten_san_pham)
            .input('danh_muc_id', sql.UniqueIdentifier, danh_muc_id)
            .input('thuong_hieu_id', sql.UniqueIdentifier, thuong_hieu_id)
            .input('mo_ta_ngan', sql.NVarChar(500), mo_ta_ngan)
            .input('link_anh_dai_dien', sql.NVarChar(500), link_anh_dai_dien)
            .input('site_created', sql.NVarChar(10), site_created)
            .input('gia_ban', sql.Int, gia_ban)
            .input('gia_niem_yet', sql.Int, gia_niem_yet)
            .input('mongo_detail_id', sql.NVarChar(255), mongo_detail_id)
            .input('trang_thai', sql.Bit, trang_thai)
            .query(`
                UPDATE products
                SET 
                    ma_san_pham = ISNULL(@ma_san_pham, ma_san_pham),
                    ten_san_pham = ISNULL(@ten_san_pham, ten_san_pham),
                    danh_muc_id = ISNULL(@danh_muc_id, danh_muc_id),
                    thuong_hieu_id = ISNULL(@thuong_hieu_id, thuong_hieu_id),
                    mo_ta_ngan = ISNULL(@mo_ta_ngan, mo_ta_ngan),
                    link_anh_dai_dien = ISNULL(@link_anh_dai_dien, link_anh_dai_dien),
                    site_created = ISNULL(@site_created, site_created),
                    gia_ban = ISNULL(@gia_ban, gia_ban),
                    gia_niem_yet = ISNULL(@gia_niem_yet, gia_niem_yet),
                    mongo_detail_id = ISNULL(@mongo_detail_id, mongo_detail_id),
                    trang_thai = ISNULL(@trang_thai, trang_thai),
                    ngay_cap_nhat = GETDATE()
                WHERE id = @id
            `);
        
        const selectResult = await updateRequest.query(`SELECT * FROM products WHERE id = @id`);

        res.json({
            success: true,
            message: 'Cập nhật sản phẩm thành công',
            data: selectResult.recordset[0]
        });

    } catch (error) {
        console.error('❌ Lỗi khi cập nhật sản phẩm:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật sản phẩm',
            error: error.message
        });
    }
});

// DELETE /api/products/:id - Xóa sản phẩm (và tất cả variants)
app.delete('/api/products/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log('🔄 API: Xóa sản phẩm', { id });

        const pool = db.connectionPools.default;

        // BƯỚC 1: Xóa inventory của tất cả variants trước (để tránh FK constraint)
        await pool.request()
            .input('san_pham_id', sql.UniqueIdentifier, id)
            .query(`
                DELETE FROM inventory 
                WHERE variant_id IN (
                    SELECT id FROM product_variants WHERE san_pham_id = @san_pham_id
                )
            `);

        // BƯỚC 2: Xóa tất cả variants
        await pool.request()
            .input('san_pham_id', sql.UniqueIdentifier, id)
            .query('DELETE FROM product_variants WHERE san_pham_id = @san_pham_id');

        // BƯỚC 3: Xóa product
        const result = await pool.request()
            .input('id', sql.UniqueIdentifier, id)
            .query('DELETE FROM products WHERE id = @id');

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // BƯỚC 4: Xóa MongoDB details nếu có
        if (mongoose.connection.readyState === 1) {
            try {
                const ProductDetail = mongoose.connection.db.collection('product_details');
                await ProductDetail.deleteOne({ sql_product_id: id.toLowerCase() });
            } catch (mongoErr) {
                console.warn('MongoDB delete warning:', mongoErr.message);
            }
        }

        res.json({
            success: true,
            message: 'Xóa sản phẩm thành công'
        });

    } catch (error) {
        console.error('❌ Lỗi khi xóa sản phẩm:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa sản phẩm',
            error: error.message
        });
    }
});

// =============================================
// PRODUCT VARIANTS API ROUTES
// =============================================

// GET /api/variants - Lấy tất cả variants (có thể filter theo site_origin)
app.get('/api/variants', async (req, res) => {
    try {
        const { site_origin } = req.query;
        console.log('🔄 API /api/variants called', { site_origin });

        const pool = db.connectionPools.default;
        
        let query = `
            SELECT 
                pv.*,
                p.ten_san_pham,
                p.link_anh_dai_dien as san_pham_anh
            FROM product_variants pv
            LEFT JOIN products p ON pv.san_pham_id = p.id
            WHERE pv.trang_thai = 1
        `;
        
        const request = pool.request();
        
        if (site_origin) {
            query += ' AND pv.site_origin = @site_origin';
            request.input('site_origin', sql.NVarChar(10), site_origin);
        }
        
        query += ' ORDER BY pv.ngay_tao DESC';
        
        const result = await request.query(query);
        
        // Console log để kiểm tra site_origin
        console.log('📊 Total variants found:', result.recordset.length);
        console.log('🔍 Sample variants with site_origin:');
        result.recordset.slice(0, 3).forEach((v, i) => {
            console.log(`  [${i+1}] ID: ${v.id} | Product: ${v.ten_san_pham} | SKU: ${v.ma_sku} | Site: ${v.site_origin}`);
        });

        res.json({
            success: true,
            data: result.recordset,
            total: result.recordset.length
        });

    } catch (error) {
        console.error('❌ Lỗi khi lấy variants:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy danh sách variants',
            error: error.message
        });
    }
});

// POST /api/products/:productId/variants - Thêm variant cho sản phẩm
app.post('/api/products/:productId/variants', async (req, res) => {
    try {
        const { productId } = req.params;
        const {
            ma_sku,
            ten_hien_thi,
            gia_niem_yet,
            gia_ban,
            so_luong_ton_kho,
            luot_ban,
            anh_dai_dien,
            mongo_variant_id,
            site_origin,
            trang_thai
        } = req.body;

        console.log('🔄 API: Thêm variant cho sản phẩm', { productId, ma_sku });

        // Validate
        if (!ma_sku || !ten_hien_thi || !gia_ban) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin bắt buộc: SKU, tên hiển thị, giá bán'
            });
        }

        const pool = db.connectionPools.default;

        // Kiểm tra product tồn tại
        const checkProduct = await pool.request()
            .input('productId', sql.UniqueIdentifier, productId)
            .query('SELECT id FROM products WHERE id = @productId');

        if (checkProduct.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // Kiểm tra SKU trùng
        const checkSKU = await pool.request()
            .input('ma_sku', sql.NVarChar(100), ma_sku)
            .query('SELECT id FROM product_variants WHERE ma_sku = @ma_sku');

        if (checkSKU.recordset.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Mã SKU đã tồn tại'
            });
        }

        // Insert variant
        const insertRequest = pool.request();
        await insertRequest
            .input('san_pham_id', sql.UniqueIdentifier, productId)
            .input('ma_sku', sql.NVarChar(100), ma_sku)
            .input('ten_hien_thi', sql.NVarChar(200), ten_hien_thi)
            .input('gia_niem_yet', sql.Decimal(15, 2), gia_niem_yet || gia_ban)
            .input('gia_ban', sql.Decimal(15, 2), gia_ban)
            .input('so_luong_ton_kho', sql.Int, so_luong_ton_kho || 0)
            .input('luot_ban', sql.Int, luot_ban || 0)
            .input('anh_dai_dien', sql.NVarChar(500), anh_dai_dien || null)
            .input('site_origin', sql.NVarChar(10), site_origin || 'bac')
            .input('trang_thai', sql.Bit, trang_thai !== undefined ? trang_thai : 1)
            .query(`
                INSERT INTO product_variants (
                    san_pham_id, ma_sku, ten_hien_thi, gia_niem_yet, gia_ban,
                    so_luong_ton_kho, luot_ban, anh_dai_dien, site_origin, trang_thai
                )
                VALUES (
                    @san_pham_id, @ma_sku, @ten_hien_thi, @gia_niem_yet, @gia_ban,
                    @so_luong_ton_kho, @luot_ban, @anh_dai_dien, @site_origin, @trang_thai
                )
            `);
        
        const selectResult = await insertRequest.query(`SELECT TOP 1 * FROM product_variants WHERE ma_sku = @ma_sku ORDER BY ngay_tao DESC`);
        const newVariant = selectResult.recordset[0];
        
        // Tự động tạo inventory cho variant mới
        try {
            await DataModel.SQL.Inventory.syncInventoryForVariant(
                newVariant.id,
                newVariant.site_origin,
                newVariant.so_luong_ton_kho || 0
            );
            console.log('✅ Inventory created for new variant:', newVariant.id);
        } catch (invError) {
            console.error('⚠️ Lỗi tạo inventory cho variant mới:', invError);
            // Không throw error, vẫn trả về thành công vì variant đã được tạo
        }

        res.status(201).json({
            success: true,
            message: 'Thêm biến thể thành công',
            data: newVariant
        });

    } catch (error) {
        console.error('❌ Lỗi khi thêm variant:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi thêm biến thể',
            error: error.message
        });
    }
});

// PUT /api/variants/:id - Cập nhật variant
app.put('/api/variants/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const {
            ma_sku,
            ten_hien_thi,
            gia_niem_yet,
            gia_ban,
            so_luong_ton_kho,
            luot_ban,
            anh_dai_dien,
            site_origin,
            trang_thai
        } = req.body;

        console.log('🔄 API: Cập nhật variant', { id });

        const pool = db.connectionPools.default;

        const updateRequest = pool.request();
        await updateRequest
            .input('id', sql.UniqueIdentifier, id)
            .input('ma_sku', sql.NVarChar(100), ma_sku)
            .input('ten_hien_thi', sql.NVarChar(200), ten_hien_thi)
            .input('gia_niem_yet', sql.Decimal(15, 2), gia_niem_yet)
            .input('gia_ban', sql.Decimal(15, 2), gia_ban)
            .input('so_luong_ton_kho', sql.Int, so_luong_ton_kho)
            .input('luot_ban', sql.Int, luot_ban)
            .input('anh_dai_dien', sql.NVarChar(500), anh_dai_dien)
            .input('site_origin', sql.NVarChar(10), site_origin)
            .input('trang_thai', sql.Bit, trang_thai)
            .query(`
                UPDATE product_variants
                SET 
                    ma_sku = ISNULL(@ma_sku, ma_sku),
                    ten_hien_thi = ISNULL(@ten_hien_thi, ten_hien_thi),
                    gia_niem_yet = ISNULL(@gia_niem_yet, gia_niem_yet),
                    gia_ban = ISNULL(@gia_ban, gia_ban),
                    so_luong_ton_kho = ISNULL(@so_luong_ton_kho, so_luong_ton_kho),
                    luot_ban = ISNULL(@luot_ban, luot_ban),
                    anh_dai_dien = ISNULL(@anh_dai_dien, anh_dai_dien),
                    site_origin = ISNULL(@site_origin, site_origin),
                    trang_thai = ISNULL(@trang_thai, trang_thai),
                    ngay_cap_nhat = GETDATE()
                WHERE id = @id
            `);
        
        const selectResult = await updateRequest.query(`SELECT * FROM product_variants WHERE id = @id`);

        if (selectResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy biến thể'
            });
        }

        const updatedVariant = selectResult.recordset[0];

        // Cập nhật inventory nếu so_luong_ton_kho hoặc site_origin thay đổi
        if (so_luong_ton_kho !== undefined || site_origin !== undefined) {
            try {
                await DataModel.SQL.Inventory.syncInventoryForVariant(
                    updatedVariant.id,
                    updatedVariant.site_origin,
                    updatedVariant.so_luong_ton_kho || 0
                );
                console.log('✅ Inventory updated for variant:', updatedVariant.id);
            } catch (invError) {
                console.error('⚠️ Lỗi cập nhật inventory:', invError);
                // Không throw error, vẫn trả về thành công vì variant đã được cập nhật
            }
        }

        // BƯỚC 2: Đọc calculated_price từ MongoDB và cập nhật vào SQL
        try {
            const san_pham_id = updatedVariant.san_pham_id;
            
            // Lấy product từ SQL để tìm mongo_detail_id
            const productResult = await pool.request()
                .input('san_pham_id', sql.UniqueIdentifier, san_pham_id)
                .query('SELECT mongo_detail_id FROM products WHERE id = @san_pham_id');

            if (productResult.recordset.length > 0 && productResult.recordset[0].mongo_detail_id) {
                const mongoDetailId = productResult.recordset[0].mongo_detail_id;
                
                // Lấy MongoDB document
                const mongoDoc = await DataModel.Mongo.ProductDetail.findById(mongoDetailId);
                
                if (mongoDoc) {
                    // Đọc calculated_price trực tiếp từ MongoDB document
                    const calculated_price = mongoDoc.calculated_price;
                    const calculated_original_price = mongoDoc.calculated_original_price;
                    
                    // Cập nhật vào SQL product nếu có giá từ MongoDB
                    if (calculated_price !== null && calculated_price !== undefined) {
                        const updateProductData = {
                            gia_ban: calculated_price
                        };

                        // Chỉ cập nhật gia_niem_yet nếu có giá trị và lớn hơn giá bán
                        if (calculated_original_price !== null && calculated_original_price !== undefined && calculated_original_price > calculated_price) {
                            updateProductData.gia_niem_yet = calculated_original_price;
                        } else {
                            updateProductData.gia_niem_yet = calculated_price;
                        }
                        
                        // Lấy link_anh_dai_dien từ variant đầu tiên
                        let firstVariantImage = null;
                        
                        // Check structure: grouped by region or flat?
                        const variantsObj = mongoDoc.variants;
                        if (variantsObj) {
                            const isGroupedByRegion = Object.keys(variantsObj).some(key => 
                                ['bac', 'trung', 'nam'].includes(key) && 
                                variantsObj[key] && 
                                typeof variantsObj[key] === 'object'
                            );
                            
                            if (isGroupedByRegion) {
                                // NEW: Get from first region that has combinations
                                const regions = ['bac', 'trung', 'nam'];
                                for (const region of regions) {
                                    if (variantsObj[region]?.variant_combinations?.[0]?.image) {
                                        firstVariantImage = variantsObj[region].variant_combinations[0].image;
                                        break;
                                    }
                                }
                            } else {
                                // OLD: Flat structure
                                if (variantsObj.variant_combinations?.[0]?.image) {
                                    firstVariantImage = variantsObj.variant_combinations[0].image;
                                }
                            }
                        }
                        
                        if (firstVariantImage) {
                            updateProductData.link_anh_dai_dien = firstVariantImage;
                        } else if (mongoDoc.link_avatar) {
                            updateProductData.link_anh_dai_dien = mongoDoc.link_avatar;
                        }

                        await DataModel.SQL.Product.update(updateProductData, san_pham_id);
                        
                        console.log('✅ Updated SQL product from MongoDB:', {
                            product_id: san_pham_id,
                            calculated_price: calculated_price,
                            calculated_original_price: updateProductData.gia_niem_yet,
                            link_anh_dai_dien: updateProductData.link_anh_dai_dien
                        });
                    }
                }
            }
        } catch (updateError) {
            console.error('⚠️ Failed to update product from MongoDB:', updateError);
            // Không throw error, vẫn trả về kết quả variant update
        }

        res.json({
            success: true,
            message: 'Cập nhật biến thể thành công',
            data: updatedVariant
        });

    } catch (error) {
        console.error('❌ Lỗi khi cập nhật variant:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật biến thể',
            error: error.message
        });
    }
});

// DELETE /api/variants/:id - Xóa variant
app.delete('/api/variants/:id', async (req, res) => {
    try {
        const { id } = req.params;
        console.log('🔄 API: Xóa variant', { id });

        const pool = db.connectionPools.default;

        // BƯỚC 1: Xóa inventory của variant này trước (để tránh FK constraint)
        const deleteInventoryResult = await pool.request()
            .input('variant_id', sql.UniqueIdentifier, id)
            .query('DELETE FROM inventory WHERE variant_id = @variant_id');

        console.log(`✅ Deleted ${deleteInventoryResult.rowsAffected[0]} inventory records for variant`);

        // BƯỚC 2: Xóa variant
        const result = await pool.request()
            .input('id', sql.UniqueIdentifier, id)
            .query('DELETE FROM product_variants WHERE id = @id');

        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy biến thể'
            });
        }

        res.json({
            success: true,
            message: 'Xóa biến thể thành công',
            deletedInventory: deleteInventoryResult.rowsAffected[0]
        });

    } catch (error) {
        console.error('❌ Lỗi khi xóa variant:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa biến thể',
            error: error.message
        });
    }
});

// GET /api/products/:productId/variants - Lấy tất cả variants của sản phẩm
app.get('/api/products/:productId/variants', async (req, res) => {
    try {
        const { productId } = req.params;
        const pool = db.connectionPools.default;

        const result = await pool.request()
            .input('san_pham_id', sql.UniqueIdentifier, productId)
            .query(`
                SELECT * FROM product_variants
                WHERE san_pham_id = @san_pham_id
                ORDER BY ngay_tao DESC
            `);

        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('❌ Lỗi khi lấy variants:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy danh sách biến thể',
            error: error.message
        });
    }
});

// DELETE /api/products/:productId/variants - Xóa tất cả variants của sản phẩm
app.delete('/api/products/:productId/variants', async (req, res) => {
    try {
        const { productId } = req.params;
        console.log('🔄 API: Xóa tất cả variants của sản phẩm', { productId });

        const pool = db.connectionPools.default;

        // BƯỚC 1: Xóa inventory của các variants này trước (để tránh FK constraint)
        const deleteInventoryResult = await pool.request()
            .input('san_pham_id', sql.UniqueIdentifier, productId)
            .query(`
                DELETE FROM inventory 
                WHERE variant_id IN (
                    SELECT id FROM product_variants WHERE san_pham_id = @san_pham_id
                )
            `);

        console.log(`✅ Deleted ${deleteInventoryResult.rowsAffected[0]} inventory records`);

        // BƯỚC 2: Xóa tất cả variants
        const result = await pool.request()
            .input('san_pham_id', sql.UniqueIdentifier, productId)
            .query('DELETE FROM product_variants WHERE san_pham_id = @san_pham_id');

        console.log(`✅ Deleted ${result.rowsAffected[0]} variants`);

        res.json({
            success: true,
            message: `Đã xóa ${result.rowsAffected[0]} biến thể và ${deleteInventoryResult.rowsAffected[0]} bản ghi inventory`,
            deletedVariants: result.rowsAffected[0],
            deletedInventory: deleteInventoryResult.rowsAffected[0]
        });

    } catch (error) {
        console.error('❌ Lỗi khi xóa tất cả variants:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa tất cả biến thể',
            error: error.message
        });
    }
});



// Thêm các API endpoints khác
app.post('/api/sanpham', async (req, res) => {
    try {
        const productData = req.body;
        // Logic thêm sản phẩm
        const newProduct = await DataModel.SQL.Product.create(productData);
        res.json({ success: true, product: newProduct });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.put('/api/sanpham/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        const updateData = req.body;
        await DataModel.SQL.Product.update(updateData, productId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Cập nhật API xóa sản phẩm trong app.js
app.delete('/api/sanpham/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        
        console.log(`🗑️ API: Xóa sản phẩm ${productId}`);

        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'ID sản phẩm là bắt buộc'
            });
        }

        // Tìm sản phẩm để lấy thông tin ảnh và mongo_detail_id
        const product = await DataModel.SQL.Product.findById(productId);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // Xóa ảnh chính từ Cloudinary nếu có
        if (product.link_anh && product.link_anh.includes('cloudinary.com')) {
            try {
                console.log('🗑️ Deleting product main image from Cloudinary:', product.link_anh);
                await deleteFromCloudinary(product.link_anh);
            } catch (delErr) {
                console.warn('⚠️ Failed to delete product main image:', delErr.message);
            }
        }

        // Xóa document MongoDB nếu có
        if (product.mongo_detail_id) {
            try {
                // Xóa ảnh phụ từ Cloudinary trước
                const mongoDoc = await DataModel.Mongo.ProductDetail.findOne({ 
                    sql_product_id: productId 
                });
                
                if (mongoDoc && mongoDoc.hinh_anh && Array.isArray(mongoDoc.hinh_anh)) {
                    for (const imageUrl of mongoDoc.hinh_anh) {
                        if (imageUrl && imageUrl.includes('cloudinary.com')) {
                            try {
                                await deleteFromCloudinary(imageUrl);
                                console.log('🗑️ Deleted additional image:', imageUrl);
                            } catch (imgErr) {
                                console.warn('⚠️ Failed to delete additional image:', imgErr.message);
                            }
                        }
                    }
                }

                // Xóa document MongoDB
                await DataModel.Mongo.ProductDetail.findByIdAndDelete(product.mongo_detail_id);
                console.log('✅ MongoDB document deleted:', product.mongo_detail_id);
            } catch (mongoError) {
                console.warn('⚠️ Could not delete MongoDB document:', mongoError.message);
            }
        }

        // Xóa sản phẩm từ SQL
        const result = await DataModel.SQL.Product.destroy({
            where: { id: productId }
        });

        console.log(`✅ Đã xóa sản phẩm: ${product.ten_san_pham}`);

        res.json({
            success: true,
            message: 'Xóa sản phẩm thành công',
            data: result
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi xóa sản phẩm:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa sản phẩm',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});


///////////////////////////////
//      BRAND API ROUTES     //
///////////////////////////////

// GET /api/thuonghieu - Lấy tất cả thương hiệu
app.get('/api/thuonghieu', async (req, res) => {
    try {
        console.log('🔄 API: Lấy danh sách thương hiệu');
        
        const brands = await DataModel.SQL.Brand.findAll();

        console.log(`✅ Lấy được ${brands.length} thương hiệu`);

        res.json(brands);
        
    } catch (error) {
        console.error('❌ Lỗi khi lấy danh sách thương hiệu:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy danh sách thương hiệu',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/thuonghieu/:id - Lấy thông tin chi tiết thương hiệu
app.get('/api/thuonghieu/:id', async (req, res) => {
    try {
        const brandId = req.params.id;
        console.log(`🔄 API: Lấy thông tin thương hiệu ${brandId}`);

        const brand = await DataModel.SQL.Brand.findById(brandId);

        if (!brand) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy thương hiệu'
            });
        }

        res.json(brand);
        
    } catch (error) {
        console.error('❌ Lỗi khi lấy thông tin thương hiệu:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy thông tin thương hiệu',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Thêm hàm generateSlug (có thể đặt trong utils hoặc cùng file)
function generateSlug(text) {
    if (!text) return '';
    
    return text
        .toString()
        .toLowerCase()
        .normalize('NFD')                   // Tách ký tự có dấu thành ký tự gốc + dấu
        .replace(/[\u0300-\u036f]/g, '')   // Xóa các dấu
        .replace(/[đĐ]/g, 'd')             // Chuyển đ, Đ thành d
        .replace(/[^a-z0-9 -]/g, '')       // Xóa ký tự đặc biệt, giữ khoảng trắng và gạch ngang
        .replace(/\s+/g, '-')              // Thay khoảng trắng bằng gạch ngang
        .replace(/-+/g, '-')               // Xóa nhiều gạch ngang liên tiếp
        .replace(/^-+/, '')                // Xóa gạch ngang ở đầu
        .replace(/-+$/, '');               // Xóa gạch ngang ở cuối
}

// POST /api/thuonghieu - Thêm thương hiệu mới
app.post('/api/thuonghieu', async (req, res) => {
    try {
        const brandData = req.body;
        console.log('🔄 API: Thêm thương hiệu mới', brandData);

        // Validate dữ liệu
        if (!brandData.ten_thuong_hieu) {
            return res.status(400).json({
                success: false,
                message: 'Tên thương hiệu là bắt buộc'
            });
        }

        // Tạo slug từ tên thương hiệu
        const slug = generateSlug(brandData.ten_thuong_hieu);
        console.log('📝 Generated slug:', slug);

        // Kiểm tra slug trùng lặp
        console.log('🔍 Checking for existing brand with slug:', slug);
        const existingBrand = await DataModel.SQL.Brand.findOne({ where: { slug } });
        console.log('🔍 Existing brand result:', existingBrand);
        
        if (existingBrand) {
            return res.status(400).json({
                success: false,
                message: 'Slug đã tồn tại, vui lòng chọn tên khác'
            });
        }

        console.log('✅ No duplicate found, proceeding to create brand...');
        
        const newBrand = await DataModel.SQL.Brand.create({
            ten_thuong_hieu: brandData.ten_thuong_hieu,
            mo_ta: brandData.mo_ta || '',
            logo_url: brandData.logo_url || '',
            slug: slug,
            trang_thai: brandData.trang_thai !== undefined ? brandData.trang_thai : 1,
            ngay_tao: new Date()
        });

        console.log(`✅ Đã thêm thương hiệu: ${newBrand.ten_thuong_hieu}`);

        res.status(201).json({
            success: true,
            message: 'Thêm thương hiệu thành công',
            data: newBrand
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi thêm thương hiệu:', error);
        
        // Xử lý lỗi duplicate
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({
                success: false,
                message: 'Tên thương hiệu hoặc slug đã tồn tại'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Lỗi server khi thêm thương hiệu',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// PUT /api/thuonghieu/:id - Cập nhật thương hiệu
app.put('/api/thuonghieu/:id', async (req, res) => {
    try {
        const brandId = req.params.id;
        const brandData = req.body;
        
        console.log(`🔄 API: Cập nhật thương hiệu ${brandId}`, brandData);

        // Validate dữ liệu đầu vào
        if (!brandData.ten_thuong_hieu || brandData.ten_thuong_hieu.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Tên thương hiệu là bắt buộc'
            });
        }

        // Tìm thương hiệu hiện tại
        const existingBrand = await DataModel.SQL.Brand.findById(brandId);
        if (!existingBrand) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy thương hiệu'
            });
        }

        // Tạo slug mới nếu tên thay đổi
        let newSlug = existingBrand.slug;
        let hasNameChanged = false;

        if (brandData.ten_thuong_hieu.trim() !== existingBrand.ten_thuong_hieu) {
            hasNameChanged = true;
            newSlug = generateSlug(brandData.ten_thuong_hieu);
            
            console.log(`📝 Tên thay đổi, slug mới: ${newSlug}`);
            
            // Kiểm tra slug trùng lặp
            const allBrands = await DataModel.SQL.Brand.findAll();
            const duplicateBrand = allBrands.find(brand => 
                brand.slug === newSlug && brand.id != brandId
            );
            
            if (duplicateBrand) {
                console.log(`⚠️ Tìm thấy brand trùng: ${duplicateBrand.ten_thuong_hieu}`);
                return res.status(400).json({
                    success: false,
                    message: 'Tên thương hiệu đã tồn tại, vui lòng chọn tên khác'
                });
            }
        }

        // Chuẩn bị dữ liệu cập nhật
        const updateData = {
            ten_thuong_hieu: brandData.ten_thuong_hieu.trim(),
            mo_ta: brandData.mo_ta || existingBrand.mo_ta,
            logo_url: brandData.logo_url || existingBrand.logo_url,
            trang_thai: brandData.trang_thai !== undefined ? parseInt(brandData.trang_thai) : existingBrand.trang_thai
        };

        // Chỉ cập nhật slug nếu tên thay đổi
        if (hasNameChanged) {
            updateData.slug = newSlug;
        }

        console.log('📤 Dữ liệu cập nhật:', updateData);

        // Gọi update - SỬA LẠI CÁCH GỌI
        const updatedBrand = await DataModel.SQL.Brand.update(brandId, updateData);

        console.log(`✅ Đã cập nhật thương hiệu: ${updatedBrand.ten_thuong_hieu}`);

        res.json({
            success: true,
            message: 'Cập nhật thương hiệu thành công',
            data: updatedBrand
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi cập nhật thương hiệu:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật thương hiệu',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});


// DELETE /api/thuonghieu/:id - Xóa thương hiệu
app.delete('/api/thuonghieu/:id', async (req, res) => {
    try {
        const brandId = req.params.id;
        
        console.log(`🗑️ API: Xóa thương hiệu ${brandId}`);

        // Validate brandId
        if (!brandId) {
            return res.status(400).json({
                success: false,
                message: 'ID thương hiệu là bắt buộc'
            });
        }

        // Gọi phương thức destroy với điều kiện where
        const result = await DataModel.SQL.Brand.destroy({
            where: { id: brandId }
        });

        console.log(`✅ Đã xóa thương hiệu: ${result.ten_thuong_hieu}`);

        res.json({
            success: true,
            message: 'Xóa thương hiệu thành công',
            data: result
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi xóa thương hiệu:', error);
        
        // Phân loại lỗi để trả về status code phù hợp
        if (error.message.includes('Không thể xóa thương hiệu') || 
            error.message.includes('còn sản phẩm')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
        
        if (error.message.includes('Không tìm thấy thương hiệu')) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa thương hiệu',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});


// Thêm vào file server routes
///////////////////////////////
//      CATEGORY API ROUTES  //
///////////////////////////////

// GET /api/danhmuc - Lấy tất cả danh mục
app.get('/api/danhmuc', async (req, res) => {
    try {
        console.log('🔄 API: Lấy danh sách danh mục');
        
        const categories = await DataModel.SQL.Category.findAll({
            order: [['thu_tu', 'ASC'], ['ten_danh_muc', 'ASC']]
        });

        console.log(`✅ Lấy được ${categories.length} danh mục`);

        res.json(categories);
        
    } catch (error) {
        console.error('❌ Lỗi khi lấy danh sách danh mục:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy danh sách danh mục',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/danhmuc/:id - Lấy thông tin chi tiết danh mục
app.get('/api/danhmuc/:id', async (req, res) => {
    try {
        const categoryId = req.params.id;
        console.log(`🔄 API: Lấy thông tin danh mục ${categoryId}`);

        const category = await DataModel.SQL.Category.findById(categoryId);

        if (!category) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy danh mục'
            });
        }

        res.json(category);
        
    } catch (error) {
        console.error('❌ Lỗi khi lấy thông tin danh mục:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy thông tin danh mục',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// POST /api/danhmuc - Thêm danh mục mới
app.post('/api/danhmuc', async (req, res) => {
    try {
        const categoryData = req.body;
        console.log('🔄 API: Thêm danh mục mới', categoryData);

        // Validate dữ liệu
        if (!categoryData.ten_danh_muc) {
            return res.status(400).json({
                success: false,
                message: 'Tên danh mục là bắt buộc'
            });
        }

        // Tạo slug từ tên danh mục
        const slug = generateSlug(categoryData.ten_danh_muc);

        // Kiểm tra slug trùng lặp
        const existingCategory = await DataModel.SQL.Category.findOne({ where: { slug } });
        if (existingCategory) {
            return res.status(400).json({
                success: false,
                message: 'Slug đã tồn tại, vui lòng chọn tên khác'
            });
        }

        const newCategory = await DataModel.SQL.Category.create({
            ten_danh_muc: categoryData.ten_danh_muc,
            mo_ta: categoryData.mo_ta || '',
            anh_url: categoryData.anh_url || '',
            thu_tu: categoryData.thu_tu !== undefined ? parseInt(categoryData.thu_tu) : 0,
            danh_muc_cha_id: categoryData.danh_muc_cha_id || null,
            slug: slug,
            trang_thai: categoryData.trang_thai !== undefined ? categoryData.trang_thai : 1,
            ngay_tao: new Date()
        });

        console.log(`✅ Đã thêm danh mục: ${newCategory.ten_danh_muc}`);

        res.status(201).json({
            success: true,
            message: 'Thêm danh mục thành công',
            data: newCategory
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi thêm danh mục:', error);
        
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({
                success: false,
                message: 'Tên danh mục hoặc slug đã tồn tại'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Lỗi server khi thêm danh mục',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// PUT /api/danhmuc/:id - Cập nhật danh mục
app.put('/api/danhmuc/:id', async (req, res) => {
    try {
        const categoryId = req.params.id;
        const categoryData = req.body;
        
        console.log(`🔄 API: Cập nhật danh mục ${categoryId}`, categoryData);

        if (!categoryData.ten_danh_muc || categoryData.ten_danh_muc.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Tên danh mục là bắt buộc'
            });
        }

        const existingCategory = await DataModel.SQL.Category.findById(categoryId);
        if (!existingCategory) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy danh mục'
            });
        }

        let newSlug = existingCategory.slug;
        let hasNameChanged = false;

        if (categoryData.ten_danh_muc.trim() !== existingCategory.ten_danh_muc) {
            hasNameChanged = true;
            newSlug = generateSlug(categoryData.ten_danh_muc);
            
            console.log(`📝 Tên thay đổi, slug mới: ${newSlug}`);
            
            const allCategories = await DataModel.SQL.Category.findAll();
            const duplicateCategory = allCategories.find(cat => 
                cat.slug === newSlug && cat.id != categoryId
            );
            
            if (duplicateCategory) {
                console.log(`⚠️ Tìm thấy category trùng: ${duplicateCategory.ten_danh_muc}`);
                return res.status(400).json({
                    success: false,
                    message: 'Tên danh mục đã tồn tại, vui lòng chọn tên khác'
                });
            }
        }

        // Kiểm tra không được chọn chính nó làm danh mục cha
        if (categoryData.danh_muc_cha_id === categoryId) {
            return res.status(400).json({
                success: false,
                message: 'Không thể chọn chính danh mục này làm danh mục cha'
            });
        }

        const updateData = {
            ten_danh_muc: categoryData.ten_danh_muc.trim(),
            mo_ta: categoryData.mo_ta || existingCategory.mo_ta,
            anh_url: categoryData.anh_url || existingCategory.anh_url,
            thu_tu: categoryData.thu_tu !== undefined ? parseInt(categoryData.thu_tu) : existingCategory.thu_tu,
            danh_muc_cha_id: categoryData.danh_muc_cha_id || existingCategory.danh_muc_cha_id,
            trang_thai: categoryData.trang_thai !== undefined ? parseInt(categoryData.trang_thai) : existingCategory.trang_thai
        };

        if (hasNameChanged) {
            updateData.slug = newSlug;
        }

        // If the image URL changed, attempt to delete the old image from Cloudinary
        if (categoryData.anh_url && categoryData.anh_url !== existingCategory.anh_url) {
            try {
                if (existingCategory.anh_url && existingCategory.anh_url.includes('cloudinary.com')) {
                    console.log('🗑️ Deleting old category image from Cloudinary:', existingCategory.anh_url);
                    await deleteFromCloudinary(existingCategory.anh_url);
                }
            } catch (delErr) {
                console.warn('⚠️ Failed to delete old category image:', delErr.message);
            }
        }

        console.log('📤 Dữ liệu cập nhật:', updateData);

        const updatedCategory = await DataModel.SQL.Category.update(categoryId, updateData);

        console.log(`✅ Đã cập nhật danh mục: ${updatedCategory.ten_danh_muc}`);

        res.json({
            success: true,
            message: 'Cập nhật danh mục thành công',
            data: updatedCategory
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi cập nhật danh mục:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật danh mục',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// DELETE /api/danhmuc/:id - Xóa danh mục
app.delete('/api/danhmuc/:id', async (req, res) => {
    try {
        const categoryId = req.params.id;
        
        console.log(`🗑️ API: Xóa danh mục ${categoryId}`);

        if (!categoryId) {
            return res.status(400).json({
                success: false,
                message: 'ID danh mục là bắt buộc'
            });
        }

        const result = await DataModel.SQL.Category.destroy({
            where: { id: categoryId }
        });

        console.log(`✅ Đã xóa danh mục: ${result.ten_danh_muc}`);

        res.json({
            success: true,
            message: 'Xóa danh mục thành công',
            data: result
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi xóa danh mục:', error);
        
        if (error.message.includes('Không thể xóa danh mục') || 
            error.message.includes('còn sản phẩm') ||
            error.message.includes('còn danh mục con')) {
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
        
        if (error.message.includes('Không tìm thấy danh mục')) {
            return res.status(404).json({
                success: false,
                message: error.message
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa danh mục',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});




// =============================================
// PRODUCT API ROUTES
// =============================================

// POST /api/sanpham - Thêm sản phẩm mới
app.post('/api/sanpham', async (req, res) => {
    try {
        const productData = req.body;
        console.log('🔄 API: Thêm sản phẩm mới', productData);

        // Validate dữ liệu
        if (!productData.ten_san_pham || !productData.ma_sku) {
            return res.status(400).json({
                success: false,
                message: 'Tên sản phẩm và mã SKU là bắt buộc'
            });
        }

        // Kiểm tra SKU trùng
        const existingProduct = await DataModel.SQL.Product.findOne({ 
            where: { ma_sku: productData.ma_sku } 
        });
        
        if (existingProduct) {
            return res.status(400).json({
                success: false,
                message: 'Mã SKU đã tồn tại'
            });
        }

        const newProduct = await DataModel.SQL.Product.create({
            ten_san_pham: productData.ten_san_pham,
            ma_sku: productData.ma_sku,
            danh_muc_id: productData.danh_muc_id,
            thuong_hieu_id: productData.thuong_hieu_id,
            gia_niem_yet: productData.gia_niem_yet || null,
            gia_ban: productData.gia_ban,
            giam_gia: productData.giam_gia || 0,
            trang_thai: productData.trang_thai !== undefined ? productData.trang_thai : 1,
            slug: productData.slug,
            so_luong_ton: productData.so_luong_ton || 0,
            luot_xem: productData.luot_xem || 0,
            ngay_tao: new Date(),
            ngay_cap_nhat: new Date()
        });

        console.log(`✅ Đã thêm sản phẩm: ${newProduct.ten_san_pham}`);

        res.status(201).json({
            success: true,
            message: 'Thêm sản phẩm thành công',
            product: newProduct
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi thêm sản phẩm:', error);
        
        if (error.name === 'SequelizeUniqueConstraintError') {
            return res.status(400).json({
                success: false,
                message: 'Mã SKU đã tồn tại'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Lỗi server khi thêm sản phẩm',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// PUT /api/sanpham/:id - Cập nhật sản phẩm
app.put('/api/sanpham/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        const productData = req.body;
        
        console.log(`🔄 API: Cập nhật sản phẩm ${productId}`, productData);

        // Validate dữ liệu
        if (!productData.ten_san_pham) {
            return res.status(400).json({
                success: false,
                message: 'Tên sản phẩm là bắt buộc'
            });
        }

        // Tìm sản phẩm hiện tại
        const existingProduct = await DataModel.SQL.Product.findById(productId);
        if (!existingProduct) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // Kiểm tra SKU trùng (nếu thay đổi)
        if (productData.ma_sku && productData.ma_sku !== existingProduct.ma_sku) {
            const duplicateProduct = await DataModel.SQL.Product.findOne({ 
                where: { ma_sku: productData.ma_sku } 
            });
            
            if (duplicateProduct && duplicateProduct.id != productId) {
                return res.status(400).json({
                    success: false,
                    message: 'Mã SKU đã tồn tại'
                });
            }
        }

        const updateData = {
            ten_san_pham: productData.ten_san_pham,
            ma_sku: productData.ma_sku || existingProduct.ma_sku,
            danh_muc_id: productData.danh_muc_id || existingProduct.danh_muc_id,
            thuong_hieu_id: productData.thuong_hieu_id || existingProduct.thuong_hieu_id,
            gia_niem_yet: productData.gia_niem_yet || existingProduct.gia_niem_yet,
            gia_ban: productData.gia_ban || existingProduct.gia_ban,
            giam_gia: productData.giam_gia !== undefined ? productData.giam_gia : existingProduct.giam_gia,
            trang_thai: productData.trang_thai !== undefined ? productData.trang_thai : existingProduct.trang_thai,
            link_anh: productData.link_anh || existingProduct.link_anh,
            mo_ta: productData.mo_ta || existingProduct.mo_ta,
            mo_ta_ngan: productData.mo_ta_ngan || existingProduct.mo_ta_ngan,
            san_pham_noi_bat: productData.san_pham_noi_bat !== undefined ? productData.san_pham_noi_bat : existingProduct.san_pham_noi_bat,
            slug: productData.slug || existingProduct.slug,
            ngay_cap_nhat: new Date()
        };

        // Nếu URL ảnh thay đổi, xóa ảnh cũ khỏi Cloudinary
        if (productData.link_anh && productData.link_anh !== existingProduct.link_anh) {
            try {
                if (existingProduct.link_anh && existingProduct.link_anh.includes('cloudinary.com')) {
                    console.log('🗑️ Deleting old product image from Cloudinary:', existingProduct.link_anh);
                    await deleteFromCloudinary(existingProduct.link_anh);
                }
            } catch (delErr) {
                console.warn('⚠️ Failed to delete old product image:', delErr.message);
            }
        }

        console.log('📤 Dữ liệu cập nhật:', updateData);

        const updatedProduct = await DataModel.SQL.Product.update(productId, updateData);

        console.log(`✅ Đã cập nhật sản phẩm: ${updatedProduct.ten_san_pham}`);

        res.json({
            success: true,
            message: 'Cập nhật sản phẩm thành công',
            product: updatedProduct
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi cập nhật sản phẩm:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật sản phẩm',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// DELETE /api/sanpham/:id - Xóa sản phẩm
app.delete('/api/sanpham/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        
        console.log(`🗑️ API: Xóa sản phẩm ${productId}`);

        if (!productId) {
            return res.status(400).json({
                success: false,
                message: 'ID sản phẩm là bắt buộc'
            });
        }

        // Tìm sản phẩm để lấy thông tin ảnh
        const product = await DataModel.SQL.Product.findById(productId);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // Xóa ảnh từ Cloudinary nếu có
        if (product.link_anh && product.link_anh.includes('cloudinary.com')) {
            try {
                console.log('🗑️ Deleting product image from Cloudinary:', product.link_anh);
                await deleteFromCloudinary(product.link_anh);
            } catch (delErr) {
                console.warn('⚠️ Failed to delete product image:', delErr.message);
            }
        }

        // Xóa thông số kỹ thuật từ MongoDB
        try {
            await DataModel.Mongo.ProductDetail.deleteOne({ sql_product_id: productId });
            console.log('✅ Đã xóa thông số kỹ thuật từ MongoDB');
        } catch (mongoError) {
            console.warn('⚠️ Could not delete MongoDB specs:', mongoError.message);
        }

        const result = await DataModel.SQL.Product.destroy({
            where: { id: productId }
        });

        console.log(`✅ Đã xóa sản phẩm: ${product.ten_san_pham}`);

        res.json({
            success: true,
            message: 'Xóa sản phẩm thành công',
            data: result
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi xóa sản phẩm:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa sản phẩm',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// PUT /api/sanpham/:id/status - Cập nhật trạng thái sản phẩm
app.put('/api/sanpham/:id/status', async (req, res) => {
    try {
        const productId = req.params.id;
        const { trang_thai } = req.body;

        console.log(`🔄 API: Cập nhật trạng thái sản phẩm ${productId} -> ${trang_thai}`);

        if (trang_thai === undefined) {
            return res.status(400).json({
                success: false,
                message: 'Trạng thái là bắt buộc'
            });
        }

        const product = await DataModel.SQL.Product.findById(productId);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        const updatedProduct = await DataModel.SQL.Product.update(productId, {
            trang_thai: trang_thai,
            ngay_cap_nhat: new Date()
        });

        const statusText = trang_thai ? 'kích hoạt' : 'ngừng bán';
        
        res.json({
            success: true,
            message: `Đã ${statusText} sản phẩm thành công`,
            product: updatedProduct
        });

    } catch (error) {
        console.error('❌ Lỗi khi cập nhật trạng thái sản phẩm:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật trạng thái',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// =============================================
// MONGODB PRODUCT DETAILS API ROUTES - FIXED FOR strict: false
// =============================================

// POST /api/mongo/sanpham - Tạo document mới trong MongoDB
app.post('/api/mongo/sanpham', async (req, res) => {
    try {
        let { sql_product_id, thong_so_ky_thuat, hinh_anh, videos, video_links, variants, thong_tin_khac, link_avatar, mo_ta_chi_tiet, trang_thai, san_pham_noi_bat, slug, chi_tiet } = req.body;

        console.log('🔄 API: Tạo document MongoDB mới');
        console.log('📝 Request data:', {
            sql_product_id,
            has_specs: !!thong_so_ky_thuat,
            has_images: !!hinh_anh,
            has_videos: !!videos,
            has_video_links: !!video_links,
            has_variants: !!variants,
            has_link_avatar: !!link_avatar,
            has_description: !!mo_ta_chi_tiet,
            trang_thai,
            san_pham_noi_bat,
            has_chi_tiet: !!chi_tiet,
            slug
        });

        // ===== KIỂM TRA XEM CÓ DỮ LIỆU MONGO NÀO KHÔNG =====
        // Check if variants are grouped by region (new structure: {bac: {...}, trung: {...}, nam: {...}})
        const hasVariantData = variants && typeof variants === 'object' && (() => {
            // Check old structure (flat variants object)
            if (variants.variant_options || variants.variant_combinations) {
                return (variants.variant_options && variants.variant_options.length > 0) ||
                       (variants.variant_combinations && variants.variant_combinations.length > 0);
            }
            
            // Check new structure (grouped by region)
            const regions = Object.keys(variants);
            return regions.some(region => {
                const regionData = variants[region];
                return regionData && typeof regionData === 'object' && (
                    (regionData.variant_options && regionData.variant_options.length > 0) ||
                    (regionData.variant_combinations && regionData.variant_combinations.length > 0)
                );
            });
        })();
        
        const hasMongoData = (
            (thong_so_ky_thuat && Object.keys(thong_so_ky_thuat).length > 0) ||
            (hinh_anh && Array.isArray(hinh_anh) && hinh_anh.length > 0) ||
            (videos && Array.isArray(videos) && videos.length > 0) ||
            (video_links && Array.isArray(video_links) && video_links.length > 0) ||
            hasVariantData ||
            (thong_tin_khac && typeof thong_tin_khac === 'object' && Object.keys(thong_tin_khac).length > 0) ||
            link_avatar ||
            mo_ta_chi_tiet ||
            (chi_tiet && typeof chi_tiet === 'object' && Object.keys(chi_tiet).length > 0)
        );

        console.log('🔍 Variant data check:', { hasVariantData, variantsKeys: variants ? Object.keys(variants) : [] });

        if (!hasMongoData) {
            console.log('⚠️ Không có dữ liệu MongoDB nào để lưu - bỏ qua tạo document');
            return res.status(200).json({
                success: true,
                message: 'Không có dữ liệu MongoDB để lưu',
                skipped: true
            });
        }

        console.log('✅ Có dữ liệu MongoDB - tiến hành tạo document');

        // Kiểm tra kết nối MongoDB
        const dbState = mongoose.connection.readyState;
        console.log('🔌 MongoDB connection state:', dbState);
        
        if (dbState !== 1) {
            throw new Error(`MongoDB connection is not ready. State: ${dbState}`);
        }

        // Tạo document data - với strict: false, chúng ta có thể thêm bất kỳ trường nào
        const documentData = {
            sql_product_id: sql_product_id ? sql_product_id.toLowerCase() : null,
            slug: slug || `temp-${Date.now()}`
        };

        // Function to aggregate specs with variant values
        function aggregateSpecsWithVariants(specs, variantOpts) {
            if (!specs || typeof specs !== 'object') return [];
            
            // Convert specs to array format
            let specsArray = Object.entries(specs).map(([ten, gia_tri]) => ({
                ten: ten.trim(),
                gia_tri: gia_tri
            }));
            
            // If no variants, return specs as-is
            if (!variantOpts || !Array.isArray(variantOpts)) {
                return specsArray;
            }
            
            // Build mapping of spec keys to variant values
            const variantValuesBySpec = {};
            
            variantOpts.forEach(option => {
                if (!option.name || !option.values || !Array.isArray(option.values)) return;
                
                const optionName = option.name.trim();
                const uniqueValues = [...new Set(option.values)]; // Remove duplicates
                
                // Try to find matching spec by name (case-insensitive)
                const matchingSpecIndex = specsArray.findIndex(spec => 
                    spec.ten.toLowerCase() === optionName.toLowerCase() ||
                    spec.ten.toLowerCase().includes(optionName.toLowerCase()) ||
                    optionName.toLowerCase().includes(spec.ten.toLowerCase())
                );
                
                if (matchingSpecIndex !== -1) {
                    // Store variant values for this spec
                    variantValuesBySpec[specsArray[matchingSpecIndex].ten] = uniqueValues.join('/');
                    console.log(`📊 Aggregated spec "${specsArray[matchingSpecIndex].ten}": ${uniqueValues.join('/')}`);
                }
            });
            
            // Update specs with aggregated values
            specsArray = specsArray.map(spec => {
                if (variantValuesBySpec[spec.ten]) {
                    return {
                        ten: spec.ten,
                        gia_tri: variantValuesBySpec[spec.ten]
                    };
                }
                return spec;
            });
            
            return specsArray;
        }
        
        // Thêm thông số kỹ thuật nếu có (tự động tổng hợp từ variants)
        documentData.thong_so_ky_thuat = aggregateSpecsWithVariants(thong_so_ky_thuat, variants);

        // Thêm hình ảnh nếu có
        if (hinh_anh && Array.isArray(hinh_anh)) {
            documentData.hinh_anh = hinh_anh;
        } else {
            documentData.hinh_anh = [];
        }

        // Thêm videos nếu có
        if (videos && Array.isArray(videos)) {
            documentData.videos = videos;
        } else {
            documentData.videos = [];
        }

        // Thêm video links nếu có (từ YouTube, Vimeo, etc.)
        if (video_links && Array.isArray(video_links)) {
            documentData.video_links = video_links;
        } else {
            documentData.video_links = [];
        }

        // Thêm variants (biến thể) nếu có
        let calculated_price = null;
        let calculated_original_price = null;
        
        if (variants && typeof variants === 'object') {
            // Xác định structure: grouped by region hoặc flat
            const isGroupedByRegion = !variants.variant_options && !variants.variant_combinations;
            
            if (isGroupedByRegion) {
                console.log('📦 Variants grouped by region (site_origin) structure detected');
                // Lưu trực tiếp structure grouped by region
                documentData.variants = variants;
                
                // Tính calculated_price từ tất cả regions
                Object.keys(variants).forEach(region => {
                    const regionData = variants[region];
                    if (regionData.variant_combinations && Array.isArray(regionData.variant_combinations)) {
                        regionData.variant_combinations.forEach(combo => {
                            if (combo.price) {
                                const price = parseFloat(combo.price);
                                const originalPrice = combo.original_price ? parseFloat(combo.original_price) : null;
                                
                                if (calculated_price === null || price < calculated_price) {
                                    calculated_price = price;
                                    calculated_original_price = originalPrice;
                                }
                            }
                        });
                    }
                });
                
                console.log('✅ Variants data saved (grouped by region):', Object.keys(variants));
            } else {
                console.log('📦 Flat variants structure detected (legacy)');
                // Ensure all variants have variant_id (or create default variant with sql_product_id)
                const processedVariants = ensureVariantIds(variants, sql_product_id);
                
                // Lưu variants object chứa cả variant_options và variant_combinations
                documentData.variants = processedVariants;
                console.log('✅ Variants data saved (flat):', JSON.stringify(processedVariants, null, 2));
                
                // Tính calculated_price từ variant_combinations
                if (processedVariants.variant_combinations && Array.isArray(processedVariants.variant_combinations)) {
                    processedVariants.variant_combinations.forEach(combo => {
                        if (combo.price) {
                            const price = parseFloat(combo.price);
                            const originalPrice = combo.original_price ? parseFloat(combo.original_price) : null;
                            
                            if (calculated_price === null || price < calculated_price) {
                                calculated_price = price;
                                calculated_original_price = originalPrice;
                            }
                        }
                    });
                }
            }
            
            // Lưu calculated_price vào MongoDB
            documentData.calculated_price = calculated_price;
            documentData.calculated_original_price = calculated_original_price;
                
            console.log('💰 Calculated prices from variants:', {
                calculated_price,
                calculated_original_price
            });
        } else {
            // No variants provided - create default variant with sql_product_id
            documentData.variants = ensureVariantIds(null, sql_product_id);
        }

        // Thêm chi tiết bổ sung nếu có (object tự do)
        if (chi_tiet && typeof chi_tiet === 'object') {
            documentData.chi_tiet = chi_tiet;
        }

        // Thêm link_avatar nếu có
        if (link_avatar) {
            documentData.link_avatar = link_avatar;
        }

        // Thêm mô tả chi tiết nếu có
        if (mo_ta_chi_tiet) {
            documentData.mo_ta_chi_tiet = mo_ta_chi_tiet;
        }

        // Thêm trạng thái và sản phẩm nổi bật
        if (trang_thai !== undefined) {
            documentData.trang_thai = trang_thai;
        }

        if (san_pham_noi_bat !== undefined) {
            documentData.san_pham_noi_bat = san_pham_noi_bat;
        }

        // Thêm thông tin khác (key-value pairs tự do)
        if (thong_tin_khac && typeof thong_tin_khac === 'object') {
            documentData.thong_tin_khac = thong_tin_khac;
            console.log('✅ Thong_tin_khac data saved:', JSON.stringify(thong_tin_khac, null, 2));
        } else {
            documentData.thong_tin_khac = {};
        }

        console.log('📊 Document data to save:', {
            sql_product_id: documentData.sql_product_id,
            slug: documentData.slug,
            specs_count: documentData.thong_so_ky_thuat.length,
            images_count: documentData.hinh_anh.length,
            videos_count: documentData.videos ? documentData.videos.length : 0,
            video_links_count: documentData.video_links ? documentData.video_links.length : 0,
            variants_count: documentData.variants ? documentData.variants.length : 0,
            trang_thai: documentData.trang_thai,
            san_pham_noi_bat: documentData.san_pham_noi_bat,
            has_link_avatar: !!documentData.link_avatar,
            has_description: !!documentData.mo_ta_chi_tiet,
            has_chi_tiet: !!documentData.chi_tiet
        });

        // Tạo và lưu document
        const newProductDetail = new DataModel.Mongo.ProductDetail(documentData);
        const savedDetail = await newProductDetail.save();
        
        console.log('✅ MongoDB document created successfully:', savedDetail._id);
        
        // Cập nhật giá và ảnh đại diện vào SQL từ MongoDB
        if (savedDetail.calculated_price !== null && sql_product_id) {
            try {
                const sqlProduct = await DataModel.SQL.Product.findById(sql_product_id);
                if (sqlProduct) {
                    const updatePriceData = {
                        gia_ban: savedDetail.calculated_price,
                        mongo_detail_id: savedDetail._id.toString()
                    };
                    
                    // Chỉ cập nhật gia_niem_yet nếu có giá trị và lớn hơn giá bán
                    if (savedDetail.calculated_original_price !== null && savedDetail.calculated_original_price > savedDetail.calculated_price) {
                        updatePriceData.gia_niem_yet = savedDetail.calculated_original_price;
                    } else {
                        updatePriceData.gia_niem_yet = savedDetail.calculated_price; // Không có giảm giá thì bằng giá bán
                    }
                    
                    // Lấy link_anh_dai_dien từ variant đầu tiên
                    let firstVariantImage = null;
                    
                    // Check structure: grouped by region or flat?
                    const variantsObj = savedDetail.variants;
                    if (variantsObj) {
                        const isGroupedByRegion = Object.keys(variantsObj).some(key => 
                            ['bac', 'trung', 'nam'].includes(key) && 
                            variantsObj[key] && 
                            typeof variantsObj[key] === 'object'
                        );
                        
                        if (isGroupedByRegion) {
                            // NEW: Get from first region that has combinations
                            const regions = ['bac', 'trung', 'nam'];
                            for (const region of regions) {
                                if (variantsObj[region]?.variant_combinations?.[0]?.image) {
                                    firstVariantImage = variantsObj[region].variant_combinations[0].image;
                                    break;
                                }
                            }
                        } else {
                            // OLD: Flat structure
                            if (variantsObj.variant_combinations?.[0]?.image) {
                                firstVariantImage = variantsObj.variant_combinations[0].image;
                            }
                        }
                    }
                    
                    if (firstVariantImage) {
                        updatePriceData.link_anh_dai_dien = firstVariantImage;
                    } else if (savedDetail.link_avatar) {
                        updatePriceData.link_anh_dai_dien = savedDetail.link_avatar;
                    }
                    
                    await DataModel.SQL.Product.update(updatePriceData, sql_product_id);
                    console.log('✅ Updated SQL product from MongoDB:', {
                        gia_ban: savedDetail.calculated_price,
                        gia_niem_yet: updatePriceData.gia_niem_yet,
                        link_anh_dai_dien: updatePriceData.link_anh_dai_dien
                    });
                }
            } catch (sqlError) {
                console.error('⚠️ Failed to update SQL price:', sqlError);
            }
        }

        res.status(201).json({
            success: true,
            message: 'Tạo document MongoDB thành công',
            data: savedDetail,
            calculated_prices: {
                calculated_price: savedDetail.calculated_price,
                calculated_original_price: savedDetail.calculated_original_price
            }
        });

    } catch (error) {
        console.error('❌ Lỗi khi tạo document MongoDB:', error);
        
        // Log chi tiết lỗi
        console.error('📛 Error details:', {
            name: error.name,
            message: error.message,
            code: error.code,
            keyPattern: error.keyPattern,
            keyValue: error.keyValue
        });

        // Xử lý các loại lỗi cụ thể
        if (error.name === 'ValidationError') {
            const errors = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                success: false,
                message: 'Lỗi validation: ' + errors.join(', '),
                errors: errors
            });
        }
        
        if (error.name === 'MongoError' && error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: 'Lỗi trùng lặp: sql_product_id đã tồn tại trong MongoDB',
                errorCode: error.code
            });
        }

        res.status(500).json({
            success: false,
            message: 'Lỗi server khi tạo document MongoDB: ' + error.message,
            error: process.env.NODE_ENV === 'development' ? {
                name: error.name,
                message: error.message
            } : undefined
        });
    }
});

// GET /api/check-mongodb - Kiểm tra kết nối MongoDB
app.get('/api/check-mongodb', async (req, res) => {
    try {
        const dbState = mongoose.connection.readyState;
        const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
        
        console.log('🔌 MongoDB connection state:', states[dbState]);
        
        // Thử thực hiện một truy vấn đơn giản
        const count = await DataModel.Mongo.ProductDetail.countDocuments();
        
        res.json({
            success: true,
            message: `MongoDB connection is ${states[dbState]}`,
            state: states[dbState],
            documentCount: count
        });
    } catch (error) {
        console.error('❌ MongoDB check failed:', error);
        res.status(500).json({
            success: false,
            message: 'MongoDB connection failed: ' + error.message
        });
    }
});


// PUT /api/mongo/sanpham/:id - Cập nhật document MongoDB bằng _id (hỗ trợ videos và link_avatar)
app.put('/api/mongo/sanpham/:id', async (req, res) => {
    try {
        const mongoId = req.params.id;
        
        // 🔍 LOG TOÀN BỘ req.body TRƯỚC KHI DESTRUCTURE
        console.log('🔍 RAW req.body:', JSON.stringify(req.body, null, 2));
        console.log('🔍 req.body keys:', Object.keys(req.body));
        
        const { sql_product_id, thong_so_ky_thuat, hinh_anh, anh_dai_dien, videos, video_links, variants, thong_tin_khac, link_avatar, mo_ta_chi_tiet, trang_thai, san_pham_noi_bat, slug, chi_tiet } = req.body;

        // 🔍 LOG CÁC GIÁ TRỊ SAU KHI DESTRUCTURE
        console.log('🔍 After destructuring:', {
            sql_product_id: sql_product_id,
            trang_thai: trang_thai,
            san_pham_noi_bat: san_pham_noi_bat,
            slug: slug,
            thong_tin_khac: thong_tin_khac ? 'YES' : 'NO'
        });

        console.log(`🔄 API: Cập nhật document MongoDB ${mongoId}`);
        console.log('📝 Update data:', { 
            sql_product_id, 
            slug, 
            thong_so_ky_thuat: thong_so_ky_thuat ? Object.keys(thong_so_ky_thuat).length : 0, 
            hinh_anh: hinh_anh ? hinh_anh.length : 0,
            videos: videos ? videos.length : 0,
            video_links: video_links ? video_links.length : 0,
            variants: variants ? JSON.stringify(variants) : 'none',
            thong_tin_khac: thong_tin_khac ? Object.keys(thong_tin_khac).length : 0,
            trang_thai,
            san_pham_noi_bat,
            link_avatar: link_avatar ? 'yes' : 'no',
            chi_tiet: chi_tiet ? 'yes' : 'no'
        });
        
        // Function to aggregate specs with variant values
        function aggregateSpecsWithVariants(specs, variants) {
            if (!specs || typeof specs !== 'object') return [];
            
            // Convert specs to array format
            let specsArray = Object.entries(specs).map(([ten, gia_tri]) => ({
                ten: ten.trim(),
                gia_tri: gia_tri
            }));
            
            // If no variants, return specs as-is
            if (!variants || typeof variants !== 'object') {
                return specsArray;
            }
            
            // Build mapping of spec keys to variant values
            const variantValuesBySpec = {};
            
            // Check structure: grouped by region or flat?
            const isGroupedByRegion = Object.keys(variants).some(key => 
                ['bac', 'trung', 'nam'].includes(key) && 
                variants[key] && 
                typeof variants[key] === 'object'
            );
            
            let allVariantOptions = [];
            
            if (isGroupedByRegion) {
                // NEW: Collect variant_options from all regions
                Object.keys(variants).forEach(region => {
                    const regionData = variants[region];
                    if (regionData?.variant_options && Array.isArray(regionData.variant_options)) {
                        allVariantOptions = allVariantOptions.concat(regionData.variant_options);
                    }
                });
            } else {
                // OLD: Flat structure
                const variantOpts = variants?.variant_options;
                if (variantOpts && Array.isArray(variantOpts)) {
                    allVariantOptions = variantOpts;
                }
            }
            
            if (allVariantOptions.length === 0) {
                return specsArray;
            }
            
            // Process all collected variant_options
            allVariantOptions.forEach(option => {
                if (!option.name || !option.values || !Array.isArray(option.values)) return;
                
                const optionName = option.name.trim();
                const uniqueValues = [...new Set(option.values)]; // Remove duplicates
                
                // Try to find matching spec by name (case-insensitive)
                const matchingSpecIndex = specsArray.findIndex(spec => 
                    spec.ten.toLowerCase() === optionName.toLowerCase() ||
                    spec.ten.toLowerCase().includes(optionName.toLowerCase()) ||
                    optionName.toLowerCase().includes(spec.ten.toLowerCase())
                );
                
                if (matchingSpecIndex !== -1) {
                    // Merge values from all regions
                    const existingValues = variantValuesBySpec[specsArray[matchingSpecIndex].ten];
                    const newValues = uniqueValues.join('/');
                    
                    if (existingValues) {
                        // Merge and deduplicate
                        const merged = [...new Set([...existingValues.split('/'), ...uniqueValues])];
                        variantValuesBySpec[specsArray[matchingSpecIndex].ten] = merged.join('/');
                    } else {
                        variantValuesBySpec[specsArray[matchingSpecIndex].ten] = newValues;
                    }
                    
                    console.log(`📊 Aggregated spec "${specsArray[matchingSpecIndex].ten}": ${variantValuesBySpec[specsArray[matchingSpecIndex].ten]}`);
                }
            });
            
            // Update specs with aggregated values
            specsArray = specsArray.map(spec => {
                if (variantValuesBySpec[spec.ten]) {
                    return {
                        ten: spec.ten,
                        gia_tri: variantValuesBySpec[spec.ten]
                    };
                }
                return spec;
            });
            
            return specsArray;
        }
        
        // Chuyển đổi thông số kỹ thuật từ object sang array và tổng hợp từ variants
        const thongSoKyThuatArray = aggregateSpecsWithVariants(thong_so_ky_thuat, variants);

        const updateData = {
            updatedAt: new Date()
        };

        if (sql_product_id !== undefined) updateData.sql_product_id = sql_product_id;
        if (thong_so_ky_thuat !== undefined) updateData.thong_so_ky_thuat = thongSoKyThuatArray;
        
        // ⚠️ Không merge hinh_anh - frontend gửi full array với thứ tự đúng
        // (Ảnh chính đã được swap lên index 0)
        // 🔒 BẢO VỆ: Chỉ xóa khi cả frontend gửi null VÀ DB cũng empty
        if (hinh_anh !== undefined) {
            // Nếu frontend gửi array hợp lệ → Update bình thường
            if (Array.isArray(hinh_anh) && hinh_anh.length > 0) {
                updateData.hinh_anh = hinh_anh;
                console.log(`📸 Updated hinh_anh array: ${hinh_anh.length} images (order preserved)`);
            } 
            // Nếu frontend gửi null/empty → Kiểm tra DB trước khi cho phép xóa
            else if (!hinh_anh || (Array.isArray(hinh_anh) && hinh_anh.length === 0)) {
                try {
                    const existingDoc = await DataModel.Mongo.ProductDetail.findById(mongoId).lean();
                    const existingImages = existingDoc?.hinh_anh || [];
                    
                    // Nếu DB có ảnh → KHÔNG cho phép xóa (giữ nguyên)
                    if (existingImages.length > 0) {
                        console.log(`🔒 PROTECTED: Frontend sent null/empty but DB has ${existingImages.length} images. Keeping existing data.`);
                        // Không add vào updateData → giữ nguyên DB
                    } 
                    // Nếu DB cũng empty → OK to set null/empty
                    else {
                        updateData.hinh_anh = hinh_anh || [];
                        console.log(`✅ Both frontend and DB empty, setting hinh_anh to empty`);
                    }
                } catch (err) {
                    console.warn('⚠️ Could not check existing images, skipping update:', err.message);
                }
            }
        }
        
        // Lưu ảnh đại diện (ảnh chính)
        if (anh_dai_dien !== undefined) {
            updateData.anh_dai_dien = anh_dai_dien;
            console.log(`📸 Updated anh_dai_dien: ${anh_dai_dien ? anh_dai_dien.substring(0, 60) + '...' : 'null'}`);
        }
        
        // Xử lý variants và tính calculated_price
        let calculated_price = null;
        let calculated_original_price = null;
        
        if (variants !== undefined) {
            // Check structure: grouped by region or flat?
            const isGroupedByRegion = Object.keys(variants).some(key => 
                ['bac', 'trung', 'nam'].includes(key) && 
                variants[key] && 
                typeof variants[key] === 'object'
            );
            
            if (isGroupedByRegion) {
                console.log('📦 UPDATE: Variants grouped by region structure detected');
                
                // ✅ MERGE: Lấy variants cũ từ DB, chỉ cập nhật các vùng được gửi lên
                try {
                    const existingDoc = await DataModel.Mongo.ProductDetail.findById(mongoId).lean();
                    const existingVariants = existingDoc?.variants || {};
                    
                    // Merge: Giữ lại variants của các vùng không được cập nhật
                    const mergedVariants = { ...existingVariants };
                    
                    // ✅ MERGE COMBINATIONS: Merge từng vùng ở level combinations để giữ combos cũ
                    Object.keys(variants).forEach(region => {
                        const existingRegionVariants = existingVariants[region] || {};
                        const newRegionVariants = variants[region];
                        
                        // Merge combinations: Giữ combos cũ + thêm combos mới
                        const existingCombos = existingRegionVariants.variant_combinations || [];
                        const newCombos = newRegionVariants.variant_combinations || [];
                        
                        // Chỉ giữ combos đã save (có variant_id)
                        const savedExistingCombos = existingCombos.filter(combo => combo.variant_id);
                        
                        // Index combos cũ đã save theo sku
                        const existingCombosBySku = {};
                        savedExistingCombos.forEach(combo => {
                            if (combo.sku) {
                                existingCombosBySku[combo.sku] = combo;
                            }
                        });
                        
                        // Merge: Update nếu trùng sku, giữ cũ nếu không có trong mới
                        const mergedCombos = [...newCombos];
                        savedExistingCombos.forEach(oldCombo => {
                            const isUpdated = newCombos.some(c => c.sku === oldCombo.sku);
                            if (!isUpdated) {
                                mergedCombos.push(oldCombo); // Giữ combo cũ đã save
                            }
                        });
                        
                        mergedVariants[region] = {
                            ...existingRegionVariants,
                            ...newRegionVariants,
                            variant_combinations: mergedCombos
                        };
                        
                        console.log(`✅ Merged variants for region ${region}: ${existingCombos.length} old + ${newCombos.length} new = ${mergedCombos.length} total`);
                    });
                    
                    updateData.variants = mergedVariants;
                    
                    console.log('📊 Variants merge summary:', {
                        existing_regions: Object.keys(existingVariants),
                        updated_regions: Object.keys(variants),
                        final_regions: Object.keys(mergedVariants)
                    });
                } catch (err) {
                    console.warn('⚠️ Could not merge variants, using new data:', err.message);
                    updateData.variants = variants;
                }
                
                // ✨ AUTO UPDATE link_anh: Sync variant images with hinh_anh array
                const finalVariants = updateData.variants;
                const updatedHinhAnh = updateData.hinh_anh || hinh_anh;
                
                if (updatedHinhAnh && Array.isArray(updatedHinhAnh)) {
                    console.log('🔄 Auto-updating variant link_anh from hinh_anh array...');
                    
                    Object.keys(finalVariants).forEach(region => {
                        const regionData = finalVariants[region];
                        if (regionData?.variant_combinations && Array.isArray(regionData.variant_combinations)) {
                            regionData.variant_combinations.forEach(combo => {
                                // Nếu combo có link_anh và URL đó tồn tại trong hinh_anh array → OK
                                if (combo.link_anh && updatedHinhAnh.includes(combo.link_anh)) {
                                    // Keep existing link_anh
                                } 
                                // Nếu combo có link_anh nhưng URL không còn trong hinh_anh → set null
                                else if (combo.link_anh && !updatedHinhAnh.includes(combo.link_anh)) {
                                    console.log(`⚠️ Variant ${combo.sku}: Image removed from hinh_anh, clearing link_anh`);
                                    combo.link_anh = null;
                                }
                                // Nếu combo chưa có link_anh → không tự động assign (frontend phải chọn)
                            });
                        }
                    });
                }
                
                // Tính calculated_price từ tất cả regions trong merged variants
                Object.keys(finalVariants).forEach(region => {
                    const regionData = finalVariants[region];
                    if (regionData?.variant_combinations && Array.isArray(regionData.variant_combinations)) {
                        regionData.variant_combinations.forEach(combo => {
                            if (combo.price) {
                                const price = parseFloat(combo.price);
                                const originalPrice = combo.original_price ? parseFloat(combo.original_price) : null;
                                
                                if (calculated_price === null || price < calculated_price) {
                                    calculated_price = price;
                                    calculated_original_price = originalPrice;
                                }
                            }
                        });
                    }
                });
                
                console.log('✅ Variants data merged (grouped by region):', Object.keys(finalVariants));
            } else {
                console.log('📦 UPDATE: Flat variants structure detected (legacy)');
                // Ensure all variants have variant_id (or create default variant with sql_product_id)
                const updatedVariants = ensureVariantIds(variants, sql_product_id);
                updateData.variants = updatedVariants;
                
                // Tính calculated_price từ variant_combinations
                if (updatedVariants.variant_combinations && Array.isArray(updatedVariants.variant_combinations)) {
                    updatedVariants.variant_combinations.forEach(combo => {
                        if (combo.price) {
                            const price = parseFloat(combo.price);
                            const originalPrice = combo.original_price ? parseFloat(combo.original_price) : null;
                            
                            if (calculated_price === null || price < calculated_price) {
                                calculated_price = price;
                                calculated_original_price = originalPrice;
                            }
                        }
                    });
                    
                    console.log('✅ Variants data updated (flat)');
                }
            }
            
            // Lưu calculated_price vào MongoDB
            updateData.calculated_price = calculated_price;
            updateData.calculated_original_price = calculated_original_price;
            
            console.log('💰 Calculated prices from variants:', {
                calculated_price,
                calculated_original_price
            });
        }
        
        if (videos !== undefined) updateData.videos = videos;
        if (video_links !== undefined) updateData.video_links = video_links;
        if (chi_tiet !== undefined) updateData.chi_tiet = chi_tiet;
        if (link_avatar !== undefined) updateData.link_avatar = link_avatar;
        if (mo_ta_chi_tiet !== undefined) updateData.mo_ta_chi_tiet = mo_ta_chi_tiet;
        if (trang_thai !== undefined) updateData.trang_thai = trang_thai;
        if (san_pham_noi_bat !== undefined) updateData.san_pham_noi_bat = san_pham_noi_bat;
        if (slug !== undefined) updateData.slug = slug;
        if (thong_tin_khac !== undefined) updateData.thong_tin_khac = thong_tin_khac;

        // � Loại bỏ các field timestamps (MongoDB tự động quản lý)
        delete updateData.createdAt;
        delete updateData.updatedAt;
        delete updateData.__v;

        // �🔥 Tách fields có giá trị null để xóa ($unset) và fields có giá trị để update ($set)
        const fieldsToSet = {};
        const fieldsToUnset = {};
        
        Object.entries(updateData).forEach(([key, value]) => {
            // Xóa field hoàn toàn khỏi document nếu:
            // - value === null
            // - value là empty array []
            // - value là empty object {}
            // - value là empty string ""
            const isEmpty = 
                value === null ||
                (Array.isArray(value) && value.length === 0) ||
                (typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0) ||
                (typeof value === 'string' && value.trim() === '');
            
            if (isEmpty) {
                fieldsToUnset[key] = "";  // MongoDB $unset syntax - xóa field hoàn toàn
            } else {
                fieldsToSet[key] = value;
            }
        });
        
        console.log('💾 Fields to SET:', Object.keys(fieldsToSet));
        console.log('🗑️ Fields to UNSET (delete):', Object.keys(fieldsToUnset));
        
        // Tạo update query object
        const mongoUpdateQuery = {};
        if (Object.keys(fieldsToSet).length > 0) {
            mongoUpdateQuery.$set = fieldsToSet;
        }
        if (Object.keys(fieldsToUnset).length > 0) {
            mongoUpdateQuery.$unset = fieldsToUnset;
        }
        
        console.log('🔧 Final MongoDB update query:', JSON.stringify(mongoUpdateQuery, null, 2));

        // 🔍 DEBUG: Log document TRƯỚC KHI update
        const docBefore = await DataModel.Mongo.ProductDetail.findById(mongoId).lean();
        console.log('📄 Document BEFORE update:', {
            _id: docBefore?._id,
            sql_product_id: docBefore?.sql_product_id,
            slug: docBefore?.slug,
            trang_thai: docBefore?.trang_thai,
            thong_tin_khac: docBefore?.thong_tin_khac,
            has_variants: !!docBefore?.variants
        });

        const updatedDetail = await DataModel.Mongo.ProductDetail.findByIdAndUpdate(
            mongoId,
            mongoUpdateQuery,
            { new: true, runValidators: true }
        );

        if (!updatedDetail) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy document MongoDB'
            });
        }

        // 🔍 DEBUG: Log document SAU KHI update
        console.log('✅ MongoDB document updated:', mongoId);
        console.log('📄 Document AFTER update:', {
            _id: updatedDetail._id,
            sql_product_id: updatedDetail.sql_product_id,
            slug: updatedDetail.slug,
            trang_thai: updatedDetail.trang_thai,
            san_pham_noi_bat: updatedDetail.san_pham_noi_bat,
            thong_tin_khac: updatedDetail.thong_tin_khac,
            mo_ta_chi_tiet: updatedDetail.mo_ta_chi_tiet,
            has_variants: !!updatedDetail.variants,
            variants_keys: updatedDetail.variants ? Object.keys(updatedDetail.variants) : [],
            variants_bac_combos: updatedDetail.variants?.bac?.variant_combinations?.length || 0,
            default_variant_count: updatedDetail.variants?.variant_combinations?.length || 0
        });
        
        // 🔍 Log chi tiết variants để verify
        if (updatedDetail.variants?.bac) {
            console.log('✅ Variants structure verified:');
            console.log('  - Region "bac" has', updatedDetail.variants.bac.variant_combinations?.length || 0, 'combinations');
            console.log('  - Sample combo:', updatedDetail.variants.bac.variant_combinations?.[0]?.name);
        }
        
        // Cập nhật giá và ảnh đại diện vào SQL từ MongoDB
        if (updatedDetail.calculated_price !== null && updatedDetail.sql_product_id) {
            try {
                const sqlProduct = await DataModel.SQL.Product.findById(updatedDetail.sql_product_id);
                if (sqlProduct) {
                    const updatePriceData = {
                        gia_ban: updatedDetail.calculated_price
                    };
                    
                    // Chỉ cập nhật gia_niem_yet nếu có giá trị và lớn hơn giá bán
                    if (updatedDetail.calculated_original_price !== null && updatedDetail.calculated_original_price > updatedDetail.calculated_price) {
                        updatePriceData.gia_niem_yet = updatedDetail.calculated_original_price;
                    } else {
                        updatePriceData.gia_niem_yet = updatedDetail.calculated_price; // Không có giảm giá thì bằng giá bán
                    }
                    
                    // Lấy link_anh_dai_dien từ variant đầu tiên
                    let firstVariantImage = null;
                    
                    // Check structure: grouped by region or flat?
                    const variantsObj = updatedDetail.variants;
                    if (variantsObj) {
                        const isGroupedByRegion = Object.keys(variantsObj).some(key => 
                            ['bac', 'trung', 'nam'].includes(key) && 
                            variantsObj[key] && 
                            typeof variantsObj[key] === 'object'
                        );
                        
                        if (isGroupedByRegion) {
                            // NEW: Get from first region that has combinations
                            const regions = ['bac', 'trung', 'nam'];
                            for (const region of regions) {
                                if (variantsObj[region]?.variant_combinations?.[0]?.image) {
                                    firstVariantImage = variantsObj[region].variant_combinations[0].image;
                                    break;
                                }
                            }
                        } else {
                            // OLD: Flat structure
                            if (variantsObj.variant_combinations?.[0]?.image) {
                                firstVariantImage = variantsObj.variant_combinations[0].image;
                            }
                        }
                    }
                    
                    if (firstVariantImage) {
                        updatePriceData.link_anh_dai_dien = firstVariantImage;
                    } else if (updatedDetail.link_avatar) {
                        updatePriceData.link_anh_dai_dien = updatedDetail.link_avatar;
                    }
                    
                    await DataModel.SQL.Product.update(updatePriceData, updatedDetail.sql_product_id);
                    console.log('✅ Updated SQL product from MongoDB:', {
                        gia_ban: updatedDetail.calculated_price,
                        gia_niem_yet: updatePriceData.gia_niem_yet,
                        link_anh_dai_dien: updatePriceData.link_anh_dai_dien
                    });
                }
            } catch (sqlError) {
                console.error('⚠️ Failed to update SQL price:', sqlError);
            }
        }

        res.json({
            success: true,
            message: 'Cập nhật document MongoDB thành công',
            data: updatedDetail,
            calculated_prices: {
                calculated_price: updatedDetail.calculated_price,
                calculated_original_price: updatedDetail.calculated_original_price
            }
        });

    } catch (error) {
        console.error('❌ Lỗi khi cập nhật document MongoDB:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi cập nhật document MongoDB',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// GET /api/mongo/sanpham/sql/:sql_product_id - Lấy document MongoDB bằng sql_product_id
app.get('/api/mongo/sanpham/sql/:sql_product_id', async (req, res) => {
    try {
        const sqlProductId = req.params.sql_product_id;
        console.log(`🔍 API: Lấy document MongoDB bằng sql_product_id ${sqlProductId}`);

        // Query case-insensitive (SQL Server IDs có thể uppercase, MongoDB lưu lowercase)
        const productDetail = await DataModel.Mongo.ProductDetail.findOne({ 
            sql_product_id: new RegExp(`^${sqlProductId}$`, 'i')
        });

        if (!productDetail) {
            console.log('❌ Not found in MongoDB');
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy document MongoDB'
            });
        }

        // Chuyển đổi thông số kỹ thuật từ array sang object
        const thongSoKyThuatObject = {};
        if (productDetail.thong_so_ky_thuat && Array.isArray(productDetail.thong_so_ky_thuat)) {
            productDetail.thong_so_ky_thuat.forEach(spec => {
                if (spec.ten && spec.gia_tri !== undefined) {
                    thongSoKyThuatObject[spec.ten] = spec.gia_tri;
                }
            });
        }

        const responseData = {
            _id: productDetail._id,
            sql_product_id: productDetail.sql_product_id,
            slug: productDetail.slug,
            thong_so_ky_thuat: thongSoKyThuatObject,
            hinh_anh: productDetail.hinh_anh || [],
            videos: productDetail.videos || [],
            video_links: productDetail.video_links || [],
            thong_tin_khac: productDetail.thong_tin_khac || {},
            chi_tiet: productDetail.chi_tiet || {},
            link_avatar: productDetail.link_avatar || '',
            mo_ta_chi_tiet: productDetail.mo_ta_chi_tiet || '',
            trang_thai: productDetail.trang_thai !== undefined ? productDetail.trang_thai : 1,
            san_pham_noi_bat: productDetail.san_pham_noi_bat || false,
            createdAt: productDetail.createdAt,
            updatedAt: productDetail.updatedAt
        };
        
        // Hỗ trợ cả 2 cấu trúc variants
        if (productDetail.regional_variants) {
            responseData.regional_variants = productDetail.regional_variants;
        } else if (productDetail.variants) {
            responseData.variants = productDetail.variants;
            // Backward compatibility: Nếu có variant_options/variant_combinations
            if (productDetail.variants.variant_options) {
                responseData.variant_options = productDetail.variants.variant_options;
            }
            if (productDetail.variants.variant_combinations) {
                responseData.variant_combinations = productDetail.variants.variant_combinations;
            }
        }

        console.log('✅ Returning MongoDB data:', {
            videos_count: responseData.videos.length,
            video_links_count: responseData.video_links.length,
            has_regional_variants: !!responseData.regional_variants,
            has_variants: !!responseData.variants,
            thong_tin_khac_count: Object.keys(responseData.thong_tin_khac).length,
            trang_thai: responseData.trang_thai,
            san_pham_noi_bat: responseData.san_pham_noi_bat,
            has_link_avatar: !!responseData.link_avatar,
            has_chi_tiet: !!responseData.chi_tiet,
            has_mo_ta: !!responseData.mo_ta_chi_tiet
        });

        res.json({
            success: true,
            data: responseData
        });

    } catch (error) {
        console.error('❌ Lỗi khi lấy document MongoDB:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy document MongoDB',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// DELETE /api/mongo/sanpham/:id - Xóa document MongoDB
app.delete('/api/mongo/sanpham/:id', async (req, res) => {
    try {
        const mongoId = req.params.id;
        console.log(`🗑️ API: Xóa document MongoDB ${mongoId}`);

        const result = await DataModel.Mongo.ProductDetail.findByIdAndDelete(mongoId);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy document MongoDB'
            });
        }

        console.log('✅ MongoDB document deleted:', mongoId);

        res.json({
            success: true,
            message: 'Xóa document MongoDB thành công',
            data: result
        });

    } catch (error) {
        console.error('❌ Lỗi khi xóa document MongoDB:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa document MongoDB',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});














// =============================================
// MULTER CONFIGURATION FOR VIDEOS (Must be before routes)
// =============================================

// File filter hỗ trợ cả video
const fileFilterWithVideos = (req, file, cb) => {
    const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/quicktime', 'video/webm'];
    
    if (allowedImageTypes.includes(file.mimetype) || allowedVideoTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Định dạng file không được hỗ trợ: ${file.mimetype}. Chỉ chấp nhận JPG, PNG, GIF, WebP, MP4, MOV, AVI, WebM`), false);
    }
};

// Multer instance cho video
const uploadWithVideos = multer({
    storage: storage,
    fileFilter: fileFilterWithVideos,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB cho video
    }
});

// Middleware xử lý lỗi upload video
const handleVideoUploadError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'Kích thước file video quá lớn. Tối đa 50MB'
            });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({
                success: false,
                message: 'Quá nhiều file video được chọn'
            });
        }
    }
    res.status(400).json({
        success: false,
        message: err.message
    });
};

// =============================================
// VIDEO UPLOAD ROUTES
// =============================================

// Upload multiple product videos
app.post('/api/upload/product-videos', uploadWithVideos.array('productVideos', 5), handleVideoUploadError, async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn file video'
            });
        }

        console.log(`⬆️ Starting upload for ${req.files.length} videos...`);

        // Lấy folder name từ frontend (đã được format: ten-san-pham-productId)
        const { productId } = req.body;
        
        console.log('📦 Folder name received:', productId);
        
        // Tạo đường dẫn: products/{ten-san-pham-productId}/videos
        const folderPath = productId ? `products/${productId}/videos` : 'products/default/videos';
        console.log(`📁 Using folder path: ${folderPath}`);

        const uploadPromises = req.files.map(file => 
            uploadVideoToCloudinary(file.path, folderPath)
        );

        const results = await Promise.all(uploadPromises);
        
        const uploadedVideos = results.map(result => ({
            url: result.secure_url,
            public_id: result.public_id,
            format: result.format,
            bytes: result.bytes,
            duration: result.duration,
            resource_type: result.resource_type
        }));

        console.log(`✅ Uploaded ${uploadedVideos.length} videos successfully`);

        res.json({
            success: true,
            message: `Upload ${uploadedVideos.length} video thành công`,
            data: uploadedVideos
        });

    } catch (error) {
        console.error('❌ Product videos upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi upload video: ' + error.message
        });
    }
});

// Upload single product video (nếu cần)
app.post('/api/upload/product-video', uploadWithVideos.single('productVideo'), handleVideoUploadError, async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Vui lòng chọn file video'
            });
        }

        console.log('⬆️ Starting single video upload...');

        // Lấy folder name từ frontend (đã được format: ten-san-pham-productId)
        const { productId, oldVideoUrl } = req.body;
        
        // Tạo đường dẫn: products/{ten-san-pham-productId}/videos
        const folderPath = productId ? `products/${productId}/videos` : 'products/default/videos';

        // Kiểm tra nếu có oldVideoUrl trong body thì xóa video cũ
        if (oldVideoUrl) {
            try {
                await deleteVideoFromCloudinary(oldVideoUrl);
            } catch (deleteError) {
                console.warn('⚠️ Could not delete old video:', deleteError.message);
            }
        }

        // Upload video mới lên Cloudinary
        const result = await uploadVideoToCloudinary(req.file.path, folderPath);
        
        res.json({
            success: true,
            message: 'Upload video thành công',
            data: {
                url: result.secure_url,
                public_id: result.public_id,
                format: result.format,
                bytes: result.bytes,
                duration: result.duration,
                resource_type: result.resource_type
            }
        });

    } catch (error) {
        console.error('❌ Product video upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi upload video: ' + error.message
        });
    }
});

// API để xóa video từ Cloudinary
app.delete('/api/upload/video', async (req, res) => {
    try {
        const { videoUrl } = req.body;

        if (!videoUrl) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu URL video'
            });
        }

        console.log('🗑️ Received delete request for video:', videoUrl);
        const result = await deleteVideoFromCloudinary(videoUrl);

        res.json({
            success: true,
            message: 'Xóa video thành công',
            data: result
        });

    } catch (error) {
        console.error('❌ Video delete error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa video: ' + error.message
        });
    }
});

// =============================================
// CLOUDINARY VIDEO UTILITY FUNCTIONS
// =============================================

// Hàm upload video lên Cloudinary
const uploadVideoToCloudinary = async (filePath, folder = 'products/videos') => {
    try {
        console.log(`🎬 Uploading video to Cloudinary folder: ${folder}`);
        
        const result = await cloudinary.uploader.upload(filePath, {
            folder: `webPhone/${folder}`,
            resource_type: 'video',
            chunk_size: 6000000, // 6MB chunks for better upload
            eager: [
                { 
                    format: 'mp4',
                    quality: 'auto'
                },
            ],
            eager_async: true
        });

        // Xóa file tạm sau khi upload
        fs.unlinkSync(filePath);
        
        console.log(`✅ Video upload successful: ${result.secure_url}`);
        console.log(`📊 Video details: ${result.duration}s, ${result.bytes} bytes`);
        return result;
    } catch (error) {
        // Vẫn xóa file tạm dù upload thất bại
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        throw new Error(`Cloudinary video upload failed: ${error.message}`);
    }
};

// Hàm xóa video từ Cloudinary
const deleteVideoFromCloudinary = async (videoUrl) => {
    try {
        if (!videoUrl || !videoUrl.includes('cloudinary.com')) {
            return { result: 'not_cloudinary' };
        }

        // Extract public_id từ URL Cloudinary
        const publicId = extractPublicIdFromUrl(videoUrl);
        if (!publicId) {
            throw new Error('Could not extract public_id from video URL');
        }

        console.log(`🗑️ Deleting video from Cloudinary: ${publicId}`);
        const result = await cloudinary.uploader.destroy(publicId, {
            resource_type: 'video'
        });
        return result;
    } catch (error) {
        console.error('❌ Cloudinary video delete failed:', error);
        throw error;
    }
};

// =============================================
// CẬP NHẬT MONGODB PRODUCT DETAILS API ĐỂ HỖ TRỢ VIDEO
// =============================================

// DUPLICATE ROUTE - COMMENTED OUT (đã merge vào route chính ở line 3245)
/*
app.post('/api/mongo/sanpham', async (req, res) => {
    try {
        // THÊM videos vào destructuring
        const { sql_product_id, thong_so_ky_thuat, hinh_anh, videos, mo_ta_chi_tiet, slug, link_avatar } = req.body;

        console.log('🔄 API: Tạo document MongoDB mới với video support');
        console.log('📝 Request data:', {
            sql_product_id,
            has_specs: !!thong_so_ky_thuat,
            has_images: !!hinh_anh,
            has_videos: !!videos, // THÊM DÒNG NÀY
            has_description: !!mo_ta_chi_tiet,
            slug,
            link_avatar
        });

        // ... existing MongoDB connection check ...

        // Tạo document data - THÊM videos
        const documentData = {
            sql_product_id: sql_product_id.toLowerCase() || null,
            slug: slug || `temp-${Date.now()}`
        };

        // ... existing specs and images processing ...

        // Thêm video nếu có - THÊM PHẦN NÀY
        if (videos && Array.isArray(videos)) {
            documentData.videos = videos;
        } else {
            documentData.videos = [];
        }

        // ... existing description and link_avatar processing ...

        console.log('📊 Document data to save:', {
            sql_product_id: documentData.sql_product_id,
            slug: documentData.slug,
            specs_count: documentData.thong_so_ky_thuat.length,
            images_count: documentData.hinh_anh.length,
            videos_count: documentData.videos.length, // THÊM DÒNG NÀY
            has_description: !!documentData.mo_ta_chi_tiet,
            link_avatar: documentData.link_avatar
        });

        // ... existing save logic ...

    } catch (error) {
        // ... existing error handling ...
    }
});
*/



// =============================================
// UTILITY FUNCTION ĐỂ XÓA VIDEO KHI XÓA SẢN PHẨM
// =============================================

// Hàm utility để xóa tất cả video của sản phẩm
const deleteProductVideos = async (productId) => {
    try {
        console.log(`🎬 Deleting all videos for product: ${productId}`);
        
        // Tìm document MongoDB để lấy danh sách video
        const productDetail = await DataModel.Mongo.ProductDetail.findOne({ 
            sql_product_id: productId 
        });

        if (!productDetail || !productDetail.videos || productDetail.videos.length === 0) {
            console.log('ℹ️ No videos found for product');
            return;
        }

        // Xóa từng video từ Cloudinary
        const deletePromises = productDetail.videos.map(videoUrl => 
            deleteVideoFromCloudinary(videoUrl)
        );

        const results = await Promise.allSettled(deletePromises);
        
        // Log kết quả xóa
        results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                console.log(`✅ Deleted video: ${productDetail.videos[index]}`);
            } else {
                console.error(`❌ Failed to delete video: ${productDetail.videos[index]}`, result.reason);
            }
        });

        console.log(`✅ Completed deleting ${productDetail.videos.length} videos for product ${productId}`);
        
    } catch (error) {
        console.error('❌ Error deleting product videos:', error);
        throw error;
    }
};

// =============================================
// CẬP NHẬT API XÓA SẢN PHẨM ĐỂ XÓA VIDEO
// =============================================

// Cập nhật DELETE /api/sanpham/:id để xóa video
app.delete('/api/sanpham/:id', async (req, res) => {
    try {
        const productId = req.params.id;
        
        console.log(`🗑️ API: Xóa sản phẩm ${productId} (with video support)`);

        // ... existing validation ...

        // Tìm sản phẩm để lấy thông tin
        const product = await DataModel.SQL.Product.findById(productId);
        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }

        // Xóa ảnh chính từ Cloudinary nếu có
        if (product.link_anh && product.link_anh.includes('cloudinary.com')) {
            try {
                console.log('🗑️ Deleting product main image from Cloudinary:', product.link_anh);
                await deleteFromCloudinary(product.link_anh);
            } catch (delErr) {
                console.warn('⚠️ Failed to delete product main image:', delErr.message);
            }
        }

        // Xóa document MongoDB nếu có
        if (product.mongo_detail_id) {
            try {
                // Xóa ảnh phụ từ Cloudinary
                const mongoDoc = await DataModel.Mongo.ProductDetail.findOne({ 
                    sql_product_id: productId 
                });
                
                if (mongoDoc) {
                    // Xóa ảnh phụ
                    if (mongoDoc.hinh_anh && Array.isArray(mongoDoc.hinh_anh)) {
                        for (const imageUrl of mongoDoc.hinh_anh) {
                            if (imageUrl && imageUrl.includes('cloudinary.com')) {
                                try {
                                    await deleteFromCloudinary(imageUrl);
                                    console.log('🗑️ Deleted additional image:', imageUrl);
                                } catch (imgErr) {
                                    console.warn('⚠️ Failed to delete additional image:', imgErr.message);
                                }
                            }
                        }
                    }

                    // THÊM: Xóa video từ Cloudinary
                    if (mongoDoc.videos && Array.isArray(mongoDoc.videos)) {
                        for (const videoUrl of mongoDoc.videos) {
                            if (videoUrl && videoUrl.includes('cloudinary.com')) {
                                try {
                                    await deleteVideoFromCloudinary(videoUrl);
                                    console.log('🎬 Deleted video:', videoUrl);
                                } catch (videoErr) {
                                    console.warn('⚠️ Failed to delete video:', videoErr.message);
                                }
                            }
                        }
                    }

                    // Xóa document MongoDB
                    await DataModel.Mongo.ProductDetail.findByIdAndDelete(product.mongo_detail_id);
                    console.log('✅ MongoDB document deleted:', product.mongo_detail_id);
                }
            } catch (mongoError) {
                console.warn('⚠️ Could not delete MongoDB document:', mongoError.message);
            }
        }

        // Xóa sản phẩm từ SQL
        const result = await DataModel.SQL.Product.destroy({
            where: { id: productId }
        });

        console.log(`✅ Đã xóa sản phẩm: ${product.ten_san_pham}`);

        res.json({
            success: true,
            message: 'Xóa sản phẩm thành công',
            data: result
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi xóa sản phẩm:', error);
        
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi xóa sản phẩm',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// =============================================
// API ĐỂ LẤY THÔNG TIN VIDEO (Nếu cần)
// =============================================

// GET /api/product-variants/:productId - Lấy danh sách variants của sản phẩm (NEW API)
app.get('/api/product-variants/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        const { site_origin } = req.query;  // Optional filter by region
        
        console.log(`📦 [NEW API] Lấy variants sản phẩm ${productId}`, site_origin ? `vùng ${site_origin}` : 'tất cả vùng');
        
        const pool = db.connectionPools.default;
        
        // Build query with optional site_origin filter
        let query = `
            SELECT 
                id, san_pham_id, ma_sku, ten_hien_thi,
                gia_niem_yet, gia_ban, so_luong_ton_kho, luot_ban,
                anh_dai_dien, site_origin, trang_thai,
                ngay_tao, ngay_cap_nhat
            FROM product_variants
            WHERE san_pham_id = @product_id
            AND trang_thai = 1
        `;
        
        if (site_origin) {
            query += ' AND site_origin = @site_origin';
        }
        
        query += ' ORDER BY ngay_tao DESC';
        
        const request = pool.request()
            .input('product_id', sql.UniqueIdentifier, productId);
            
        if (site_origin) {
            request.input('site_origin', sql.NVarChar(10), site_origin);
        }
        
        const result = await request.query(query);
        
        console.log(`✅ Found ${result.recordset.length} variants for product ${productId}`);
        
        // Return array directly (no wrapper object) for frontend compatibility
        res.json(result.recordset);
        
    } catch (error) {
        console.error('❌ Error fetching product variants:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// GET /api/sanpham/:id/variants - Lấy danh sách variants của sản phẩm theo vùng (OLD API - kept for compatibility)
app.get('/api/sanpham/:id/variants', async (req, res) => {
    try {
        const { id } = req.params;
        const { site_origin } = req.query;  // Optional filter by region
        
        console.log(`📦 API: Lấy variants sản phẩm ${id}`, site_origin ? `vùng ${site_origin}` : 'tất cả vùng');
        
        const pool = db.connectionPools.default;
        
        const query = `
            SELECT 
                id, ma_sku, ten_hien_thi,
                gia_niem_yet, gia_ban, so_luong_ton_kho, luot_ban,
                anh_dai_dien, site_origin, trang_thai,
                ngay_tao, ngay_cap_nhat
            FROM product_variants
            WHERE san_pham_id = @product_id
            ${site_origin ? 'AND site_origin = @site_origin' : ''}
            AND trang_thai = 1
            ORDER BY ngay_tao DESC
        `;
        
        const request = pool.request()
            .input('product_id', sql.UniqueIdentifier, id);
            
        if (site_origin) {
            request.input('site_origin', sql.NVarChar(10), site_origin);
        }
        
        const result = await request.query(query);
        
        res.json({
            success: true,
            data: result.recordset,
            filter: site_origin ? { site_origin } : null,
            total: result.recordset.length
        });
        
    } catch (error) {
        console.error('❌ Lỗi khi lấy variants:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// GET /api/sanpham/:id/videos - Lấy danh sách video của sản phẩm
app.get('/api/sanpham/:id/videos', async (req, res) => {
    try {
        const productId = req.params.id;
        console.log(`🎬 API: Lấy danh sách video sản phẩm ${productId}`);

        const productDetail = await DataModel.Mongo.ProductDetail.findOne({ 
            sql_product_id: productId 
        });

        if (!productDetail) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy thông tin sản phẩm'
            });
        }

        const videos = productDetail.videos || [];

        res.json({
            success: true,
            data: {
                product_id: productId,
                videos: videos,
                total_videos: videos.length
            }
        });

    } catch (error) {
        console.error('❌ Lỗi khi lấy danh sách video:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy danh sách video',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// =============================================
// API ĐỂ LẤY ĐÁNH GIÁ SẢN PHẨM TỪ SQL SERVER
// =============================================

// GET /api/reviews/:productId - Lấy danh sách đánh giá từ bảng reviews
app.get('/api/reviews/:productId', async (req, res) => {
    try {
        const productId = req.params.productId;
        console.log(`⭐ API: Lấy đánh giá cho sản phẩm ${productId}`);

        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('san_pham_id', sql.UniqueIdentifier, productId)
            .query(`
                SELECT 
                    r.id,
                    r.diem_danh_gia,
                    r.tieu_de,
                    r.mongo_review_content_id,
                    r.ngay_tao,
                    u.ho_ten as reviewer_name,
                    u.email as reviewer_email
                FROM reviews r
                INNER JOIN users u ON r.nguoi_dung_id = u.id
                WHERE r.san_pham_id = @san_pham_id 
                    AND r.trang_thai = 1
                ORDER BY r.ngay_tao DESC
            `);

        // Calculate average rating
        let avgRating = 0;
        let totalReviews = result.recordset.length;
        
        if (totalReviews > 0) {
            const sumRating = result.recordset.reduce((sum, review) => sum + review.diem_danh_gia, 0);
            avgRating = (sumRating / totalReviews).toFixed(1);
        }

        // Format reviews for frontend
        const reviews = result.recordset.map(review => ({
            id: review.id,
            rating: review.diem_danh_gia,
            title: review.tieu_de,
            content: review.mongo_review_content_id || review.tieu_de, // Use title if no MongoDB content
            reviewer_name: review.reviewer_name,
            created_date: review.ngay_tao,
            formatted_date: formatDateAgo(review.ngay_tao)
        }));

        res.json({
            success: true,
            data: {
                reviews: reviews,
                avg_rating: parseFloat(avgRating),
                total_reviews: totalReviews
            }
        });

    } catch (error) {
        console.error('❌ Lỗi khi lấy đánh giá:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi server khi lấy đánh giá',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Helper function to format date
function formatDateAgo(date) {
    const now = new Date();
    const reviewDate = new Date(date);
    const diffInMs = now - reviewDate;
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    
    if (diffInDays === 0) {
        const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
        if (diffInHours === 0) {
            const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
            return diffInMinutes === 0 ? 'Vừa xong' : `${diffInMinutes} phút trước`;
        }
        return `${diffInHours} giờ trước`;
    } else if (diffInDays === 1) {
        return 'Hôm qua';
    } else if (diffInDays < 7) {
        return `${diffInDays} ngày trước`;
    } else if (diffInDays < 30) {
        const weeks = Math.floor(diffInDays / 7);
        return `${weeks} tuần trước`;
    } else if (diffInDays < 365) {
        const months = Math.floor(diffInDays / 30);
        return `${months} tháng trước`;
    } else {
        const years = Math.floor(diffInDays / 365);
        return `${years} năm trước`;
    }
}

// =============================================
// CẬP NHẬT MULTER CONFIG CHÍNH ĐỂ HỖ TRỢ VIDEO
// =============================================

// Cập nhật file filter chính để hỗ trợ cả video
const updatedFileFilter = (req, file, cb) => {
    const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const allowedVideoTypes = ['video/mp4', 'video/avi', 'video/mov', 'video/quicktime', 'video/webm'];
    
    if (allowedImageTypes.includes(file.mimetype) || allowedVideoTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error(`Định dạng file không được hỗ trợ: ${file.mimetype}. Chỉ chấp nhận JPG, PNG, GIF, WebP, MP4, MOV, AVI, WebM`), false);
    }
};

// Cập nhật multer instance chính
const updatedUpload = multer({
    storage: storage,
    fileFilter: updatedFileFilter,
    limits: {
        fileSize: 50 * 1024 * 1024, // 50MB cho cả ảnh và video
    }
});

// =============================================
// FLASH SALE API ROUTES
// =============================================

// GET /admin/flashsale - Trang quản lý flash sale
app.get('/admin/flashsale', requireAdmin, async (req, res) => {
    try {
        // Fetch regions from database using admin's pool
        const pool = req.dbPool;
        const regionsResult = await pool.request()
            .query('SELECT ma_vung, ten_vung FROM regions WHERE trang_thai = 1 ORDER BY ten_vung');
        
        res.render('flashsale', {
            layout: 'AdminMain',
            title: 'Quản Lý Flash Sale',
            regions: regionsResult.recordset
        });
    } catch (error) {
        console.error('Flash Sale Page Error:', error);
        res.status(500).send('Lỗi server');
    }
});

// GET /api/products-with-variants - Lấy products với variants từ MongoDB
app.get('/api/products-with-variants', async (req, res) => {
    try {
        // Lấy tất cả products từ SQL
        const products = await DataModel.SQL.Product.findAll();
        
        // Lấy variants từ MongoDB cho từng product
        const productsWithVariants = await Promise.all(
            products.map(async (product) => {
                try {
                    // Lấy MongoDB document
                    const mongoDoc = await DataModel.Mongo.ProductDetail.findOne({ 
                        sql_product_id: product.id 
                    }).lean();
                    
                    if (mongoDoc) {
                        // Extract variants từ MongoDB
                        let variants = [];
                        
                        // Kiểm tra các cấu trúc MongoDB có thể có
                        if (mongoDoc.variants && Array.isArray(mongoDoc.variants)) {
                            variants = mongoDoc.variants;
                        } else if (mongoDoc.bien_the && Array.isArray(mongoDoc.bien_the)) {
                            variants = mongoDoc.bien_the;
                        } else if (mongoDoc.color_options || mongoDoc.storage_options) {
                            const colors = mongoDoc.color_options || [null];
                            const storages = mongoDoc.storage_options || [null];
                            
                            variants = colors.flatMap(color => 
                                storages.map(storage => ({
                                    mau_sac: color?.name || color?.value || color || '',
                                    dung_luong: storage?.name || storage?.value || storage || '',
                                    gia: mongoDoc.gia || product.gia_ban,
                                    ton_kho: 100
                                }))
                            );
                        }
                        
                        return {
                            id: product.id,
                            ten_san_pham: product.ten_san_pham,
                            gia_ban: product.gia_ban,
                            link_anh: product.link_anh,
                            variants: variants.map(v => ({
                                mau_sac: v.mau_sac || v.color || '',
                                dung_luong: v.dung_luong || v.capacity || v.storage || '',
                                gia: v.gia || v.price || product.gia_ban,
                                ton_kho: v.ton_kho || v.stock || v.so_luong || 100
                            }))
                        };
                    }
                    
                    // Không có MongoDB doc → variant mặc định
                    return {
                        id: product.id,
                        ten_san_pham: product.ten_san_pham,
                        gia_ban: product.gia_ban,
                        link_anh: product.link_anh,
                        variants: [{
                            mau_sac: '',
                            dung_luong: '',
                            gia: product.gia_ban,
                            ton_kho: 100
                        }]
                    };
                } catch (err) {
                    console.error(`Error loading variants for ${product.id}:`, err);
                    return {
                        id: product.id,
                        ten_san_pham: product.ten_san_pham,
                        gia_ban: product.gia_ban,
                        link_anh: product.link_anh,
                        variants: [{
                            mau_sac: '',
                            dung_luong: '',
                            gia: product.gia_ban,
                            ton_kho: 100
                        }]
                    };
                }
            })
        );
        
        res.json(productsWithVariants);
    } catch (error) {
        console.error('Error loading products with variants:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy danh sách sản phẩm' });
    }
});

// GET /api/flashsales - Lấy danh sách flash sales
app.get('/api/flashsales', injectPoolForAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 10, trang_thai, search } = req.query;
        
        const filters = {};
        if (trang_thai) filters.trang_thai = trang_thai;
        if (search) filters.search = search;
        
        const flashSales = await DataModel.SQL.FlashSale.findAll(req.dbPool, filters);
        
        // Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;
        const paginatedData = flashSales.slice(startIndex, endIndex);
        
        res.json({
            success: true,
            data: paginatedData,
            currentPage: parseInt(page),
            totalPages: Math.ceil(flashSales.length / limit),
            total: flashSales.length
        });
    } catch (error) {
        console.error('Flash Sales API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách flash sale'
        });
    }
});

// GET /api/flashsales/:id - Lấy thông tin flash sale
app.get('/api/flashsales/:id', async (req, res) => {
    try {
        const flashSale = await DataModel.SQL.FlashSale.findById(req.params.id);
        
        if (!flashSale) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy flash sale'
            });
        }
        
        res.json({
            success: true,
            data: flashSale
        });
    } catch (error) {
        console.error('Flash Sale API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin flash sale'
        });
    }
});

// GET /api/flashsales/:id/details - Lấy chi tiết đầy đủ
app.get('/api/flashsales/:id/details', async (req, res) => {
    try {
        const flashSale = await DataModel.SQL.FlashSale.findById(req.params.id);
        
        if (!flashSale) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy flash sale'
            });
        }
        
        res.json({
            success: true,
            data: flashSale
        });
    } catch (error) {
        console.error('Flash Sale Details API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy chi tiết flash sale'
        });
    }
});

// POST /api/flashsales - Tạo flash sale mới
app.post('/api/flashsales', async (req, res) => {
    try {
        console.log('📝 Creating new flash sale...', req.body);
        
        const flashSaleData = {
            ten_flash_sale: req.body.ten_flash_sale,
            mo_ta: req.body.mo_ta,
            ngay_bat_dau: req.body.ngay_bat_dau,
            ngay_ket_thuc: req.body.ngay_ket_thuc,
            trang_thai: req.body.trang_thai || 'cho',
            nguoi_tao: req.session?.user?.id || req.body.nguoi_tao || null
        };
        
        // Bước 1: Tạo flash sale trong SQL
        const newFlashSale = await DataModel.SQL.FlashSale.create(flashSaleData);
        console.log('✅ SQL created with ID:', newFlashSale.id);
        
        // Bước 2: Tạo MongoDB document với _id = SQL flash sale id
        const mongoData = {
            banner_images: [],
            promotional_videos: [],
            rules: {
                max_quantity_per_user: null,
                min_purchase_amount: 0,
                eligible_user_groups: ['all'],
                payment_methods: ['all']
            },
            marketing: {
                seo_title: req.body.ten_flash_sale,
                seo_description: req.body.mo_ta || '',
                seo_keywords: [],
                hashtags: []
            },
            notification_settings: {
                send_email: true,
                send_sms: false,
                send_push: true,
                notify_before_start: 30,
                notify_when_sold_out: true
            },
            analytics: {
                total_views: 0,
                total_clicks: 0,
                conversion_rate: 0,
                revenue: 0
            },
            ui_settings: {
                theme_color: '#f59e0b',
                background_color: '#ffffff',
                countdown_style: 'digital',
                layout_type: 'grid'
            },
            tags: [],
            notes: ''
        };
        
        const mongoDoc = await DataModel.Mongo.FlashSaleDetail.createOrUpdate(newFlashSale.id, mongoData);
        console.log('✅ MongoDB created with _id:', mongoDoc._id);
        
        // Bước 3: Update SQL để lưu mongo_flash_sale_detail_id
        const updatedFlashSale = await DataModel.SQL.FlashSale.update(newFlashSale.id, {
            mongo_flash_sale_detail_id: mongoDoc._id.toString()
        });
        console.log('✅ SQL updated with mongo_flash_sale_detail_id');

        // Bước 4: Thêm flash_sale_items nếu có products
        if (req.body.products && Array.isArray(req.body.products) && req.body.products.length > 0) {
            console.log('📦 Adding flash sale items...', req.body.products.length, 'variants');
            
            for (const product of req.body.products) {
                console.log('📝 Inserting product:', product);
                
                // Validate variantId
                if (!product.variantId) {
                    console.error('❌ Missing variantId for product:', product);
                    throw new Error(`Product "${product.productName}" thiếu variant_id`);
                }
                
                const request = new sql.Request(db.SQL);
                await request
                    .input('flash_sale_id', sql.UniqueIdentifier, newFlashSale.id)
                    .input('san_pham_id', sql.UniqueIdentifier, product.variantId)
                    .input('gia_goc', sql.Decimal(15, 2), parseFloat(product.gia_goc) || 0)
                    .input('gia_flash_sale', sql.Decimal(15, 2), parseFloat(product.gia_flash_sale) || 0)
                    .input('so_luong_ton', sql.Int, parseInt(product.stock) || 0)
                    .input('gioi_han_mua', sql.Int, product.gioi_han_mua ? parseInt(product.gioi_han_mua) : null)
                    .query(`
                        INSERT INTO flash_sale_items 
                        (flash_sale_id, san_pham_id, gia_goc, gia_flash_sale, so_luong_ton, gioi_han_mua)
                        VALUES 
                        (@flash_sale_id, @san_pham_id, @gia_goc, @gia_flash_sale, @so_luong_ton, @gioi_han_mua)
                    `);
            }
            
            console.log('✅ Flash sale items added successfully');
        }
        
        res.json({
            success: true,
            message: 'Tạo flash sale thành công',
            data: updatedFlashSale
        });
    } catch (error) {
        console.error('❌ Create Flash Sale Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo flash sale: ' + error.message
        });
    }
});

// PUT /api/flashsales/:id - Cập nhật flash sale
app.put('/api/flashsales/:id', async (req, res) => {
    try {
        const updateData = {
            ten_flash_sale: req.body.ten_flash_sale,
            mo_ta: req.body.mo_ta,
            ngay_bat_dau: req.body.ngay_bat_dau,
            ngay_ket_thuc: req.body.ngay_ket_thuc,
            trang_thai: req.body.trang_thai
        };
        
        // Update flash sale basic info
        const updatedFlashSale = await DataModel.SQL.FlashSale.update(req.params.id, updateData);
        
        if (!updatedFlashSale) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy flash sale'
            });
        }

        // Update flash sale items if provided
        if (req.body.products && Array.isArray(req.body.products)) {
            console.log('📦 Updating flash sale items...', req.body.products.length, 'variants');
            
            // Delete existing items
            const deleteRequest = new sql.Request(db.SQL);
            await deleteRequest
                .input('flash_sale_id', sql.UniqueIdentifier, req.params.id)
                .query('DELETE FROM flash_sale_items WHERE flash_sale_id = @flash_sale_id');

            // Insert new items
            for (const product of req.body.products) {
                console.log('📝 Inserting product:', product);
                
                // Validate variantId
                if (!product.variantId) {
                    console.error('❌ Missing variantId for product:', product);
                    throw new Error(`Product "${product.productName}" thiếu variant_id`);
                }
                
                const insertRequest = new sql.Request(db.SQL);
                await insertRequest
                    .input('flash_sale_id', sql.UniqueIdentifier, req.params.id)
                    .input('san_pham_id', sql.UniqueIdentifier, product.variantId)
                    .input('gia_goc', sql.Decimal(15, 2), parseFloat(product.gia_goc) || 0)
                    .input('gia_flash_sale', sql.Decimal(15, 2), parseFloat(product.gia_flash_sale) || 0)
                    .input('so_luong_ton', sql.Int, parseInt(product.stock) || 0)
                    .input('gioi_han_mua', sql.Int, product.gioi_han_mua ? parseInt(product.gioi_han_mua) : null)
                    .query(`
                        INSERT INTO flash_sale_items 
                        (flash_sale_id, san_pham_id, gia_goc, gia_flash_sale, so_luong_ton, gioi_han_mua)
                        VALUES 
                        (@flash_sale_id, @san_pham_id, @gia_goc, @gia_flash_sale, @so_luong_ton, @gioi_han_mua)
                    `);
            }
            
            console.log('✅ Flash sale items updated successfully');
        }
        
        res.json({
            success: true,
            message: 'Cập nhật flash sale thành công',
            data: updatedFlashSale
        });
    } catch (error) {
        console.error('Update Flash Sale Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật flash sale: ' + error.message
        });
    }
});

// DELETE /api/flashsales/:id - Xóa flash sale
app.delete('/api/flashsales/:id', async (req, res) => {
    try {
        // Xóa từ SQL
        await DataModel.SQL.FlashSale.destroy(req.params.id);
        
        // Xóa từ MongoDB
        await DataModel.Mongo.FlashSaleDetail.deleteByFlashSaleId(req.params.id);
        
        res.json({
            success: true,
            message: 'Xóa flash sale thành công'
        });
    } catch (error) {
        console.error('Delete Flash Sale Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa flash sale: ' + error.message
        });
    }
});

// =============================================
// FLASH SALE ITEMS API ROUTES
// =============================================

// GET /api/flashsales/:flashSaleId/items/:itemId - Lấy thông tin 1 item
app.get('/api/flashsales/:flashSaleId/items/:itemId', async (req, res) => {
    try {
        const item = await DataModel.SQL.FlashSaleItem.findById(req.params.itemId);
        
        if (!item) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }
        
        res.json({
            success: true,
            data: item
        });
    } catch (error) {
        console.error('Flash Sale Item API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin sản phẩm'
        });
    }
});

// POST /api/flashsales/:id/items - Thêm sản phẩm vào flash sale
app.post('/api/flashsales/:id/items', async (req, res) => {
    try {
        const itemData = {
            flash_sale_id: req.params.id,
            san_pham_id: req.body.san_pham_id,
            gia_goc: req.body.gia_goc,
            gia_flash_sale: req.body.gia_flash_sale,
            so_luong_ton: req.body.so_luong_ton,
            gioi_han_mua: req.body.gioi_han_mua,
            thu_tu: req.body.thu_tu,
            trang_thai: req.body.trang_thai || 'dang_ban'
        };
        
        const newItem = await DataModel.SQL.FlashSaleItem.create(itemData);
        
        res.json({
            success: true,
            message: 'Thêm sản phẩm thành công',
            data: newItem
        });
    } catch (error) {
        console.error('Create Flash Sale Item Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi thêm sản phẩm: ' + error.message
        });
    }
});

// PUT /api/flashsales/:flashSaleId/items/:itemId - Cập nhật sản phẩm
app.put('/api/flashsales/:flashSaleId/items/:itemId', async (req, res) => {
    try {
        const updateData = {
            gia_goc: req.body.gia_goc,
            gia_flash_sale: req.body.gia_flash_sale,
            so_luong_ton: req.body.so_luong_ton,
            gioi_han_mua: req.body.gioi_han_mua,
            thu_tu: req.body.thu_tu,
            trang_thai: req.body.trang_thai
        };
        
        const updatedItem = await DataModel.SQL.FlashSaleItem.update(req.params.itemId, updateData);
        
        if (!updatedItem) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy sản phẩm'
            });
        }
        
        res.json({
            success: true,
            message: 'Cập nhật sản phẩm thành công',
            data: updatedItem
        });
    } catch (error) {
        console.error('Update Flash Sale Item Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật sản phẩm: ' + error.message
        });
    }
});

// DELETE /api/flashsales/:flashSaleId/items/:itemId - Xóa sản phẩm
app.delete('/api/flashsales/:flashSaleId/items/:itemId', async (req, res) => {
    try {
        await DataModel.SQL.FlashSaleItem.destroy(req.params.itemId);
        
        res.json({
            success: true,
            message: 'Xóa sản phẩm thành công'
        });
    } catch (error) {
        console.error('Delete Flash Sale Item Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa sản phẩm: ' + error.message
        });
    }
});

// =============================================
// FLASH SALE MONGODB DETAIL API ROUTES
// =============================================

// GET /api/flashsales/:id/detail - Lấy dữ liệu MongoDB của flash sale
app.get('/api/flashsales/:id/detail', async (req, res) => {
    try {
        const detail = await DataModel.Mongo.FlashSaleDetail.findByFlashSaleId(req.params.id);
        
        if (!detail) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy chi tiết flash sale'
            });
        }
        
        res.json({
            success: true,
            data: detail
        });
    } catch (error) {
        console.error('Flash Sale Detail API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy chi tiết flash sale'
        });
    }
});

// PUT /api/flashsales/:id/detail - Cập nhật dữ liệu MongoDB
app.put('/api/flashsales/:id/detail', async (req, res) => {
    try {
        const updateData = req.body;
        
        const updatedDetail = await DataModel.Mongo.FlashSaleDetail.createOrUpdate(
            req.params.id,
            updateData
        );
        
        res.json({
            success: true,
            message: 'Cập nhật chi tiết flash sale thành công',
            data: updatedDetail
        });
    } catch (error) {
        console.error('Update Flash Sale Detail Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật chi tiết: ' + error.message
        });
    }
});

// PATCH /api/flashsales/:id/detail/analytics - Cập nhật analytics
app.patch('/api/flashsales/:id/detail/analytics', async (req, res) => {
    try {
        const { total_views, total_clicks, conversion_rate, revenue } = req.body;
        
        const detail = await DataModel.Mongo.FlashSaleDetail.findByFlashSaleId(req.params.id);
        
        if (!detail) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy flash sale'
            });
        }
        
        const updatedAnalytics = {
            ...detail.analytics,
            ...(total_views !== undefined && { total_views }),
            ...(total_clicks !== undefined && { total_clicks }),
            ...(conversion_rate !== undefined && { conversion_rate }),
            ...(revenue !== undefined && { revenue })
        };
        
        const updated = await DataModel.Mongo.FlashSaleDetail.createOrUpdate(req.params.id, {
            analytics: updatedAnalytics
        });
        
        res.json({
            success: true,
            message: 'Cập nhật analytics thành công',
            data: updated.analytics
        });
    } catch (error) {
        console.error('Update Analytics Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật analytics'
        });
    }
});

// PATCH /api/flashsales/:id/detail/banners - Cập nhật banner images
app.patch('/api/flashsales/:id/detail/banners', async (req, res) => {
    try {
        const { banner_images } = req.body;
        
        if (!Array.isArray(banner_images)) {
            return res.status(400).json({
                success: false,
                message: 'banner_images phải là mảng'
            });
        }
        
        const updated = await DataModel.Mongo.FlashSaleDetail.createOrUpdate(req.params.id, {
            banner_images
        });
        
        res.json({
            success: true,
            message: 'Cập nhật banner thành công',
            data: updated.banner_images
        });
    } catch (error) {
        console.error('Update Banners Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật banner'
        });
    }
});

// PATCH /api/flashsales/:id/detail/marketing - Cập nhật marketing data
app.patch('/api/flashsales/:id/detail/marketing', async (req, res) => {
    try {
        const marketingData = req.body;
        
        const detail = await DataModel.Mongo.FlashSaleDetail.findByFlashSaleId(req.params.id);
        
        const updatedMarketing = {
            ...detail?.marketing,
            ...marketingData
        };
        
        const updated = await DataModel.Mongo.FlashSaleDetail.createOrUpdate(req.params.id, {
            marketing: updatedMarketing
        });
        
        res.json({
            success: true,
            message: 'Cập nhật marketing thành công',
            data: updated.marketing
        });
    } catch (error) {
        console.error('Update Marketing Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật marketing'
        });
    }
});

// =============================================
// ADDRESS MANAGEMENT ROUTES (REGIONS, PROVINCES, WARDS)
// =============================================

// ===== RENDER PAGE =====
app.get('/admin/diachi', requireAdmin, async (req, res) => {
    try {
        res.render('diachi', {
            layout: 'AdminMain',
            title: 'Quản Lý Địa Chỉ'
        });
    } catch (error) {
        console.error('Address Page Error:', error);
        res.status(500).send('Lỗi server');
    }
});

// ===== REGIONS API =====

// GET /api/regions - Lấy danh sách vùng miền
app.get('/api/regions', injectPoolForAdmin, async (req, res) => {
    try {
        const regions = await DataModel.SQL.Region.findAll(req.dbPool);
        
        res.json({
            success: true,
            data: regions
        });
    } catch (error) {
        console.error('Regions API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách vùng miền'
        });
    }
});

// GET /api/regions/:id - Lấy thông tin vùng miền
app.get('/api/regions/:id', async (req, res) => {
    try {
        const region = await DataModel.SQL.Region.findById(req.params.id);
        
        if (!region) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy vùng miền'
            });
        }
        
        res.json({
            success: true,
            data: region
        });
    } catch (error) {
        console.error('Region API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin vùng miền'
        });
    }
});

// POST /api/regions - Tạo vùng miền mới
app.post('/api/regions', async (req, res) => {
    try {
        const regionData = {
            ma_vung: req.body.ma_vung,
            ten_vung: req.body.ten_vung,
            mo_ta: req.body.mo_ta || null,
            trang_thai: req.body.trang_thai !== undefined ? req.body.trang_thai : 1
        };

        // Validate required fields
        if (!regionData.ma_vung || !regionData.ten_vung) {
            return res.status(400).json({
                success: false,
                message: 'Mã vùng và tên vùng là bắt buộc'
            });
        }

        const newRegion = await DataModel.SQL.Region.create(regionData);
        
        res.status(201).json({
            success: true,
            message: 'Tạo vùng miền thành công',
            data: newRegion
        });
    } catch (error) {
        console.error('Create Region Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi tạo vùng miền'
        });
    }
});

// PUT /api/regions/:id - Cập nhật vùng miền
app.put('/api/regions/:id', async (req, res) => {
    try {
        const updateData = {
            ma_vung: req.body.ma_vung,
            ten_vung: req.body.ten_vung,
            mo_ta: req.body.mo_ta,
            trang_thai: req.body.trang_thai
        };

        const updated = await DataModel.SQL.Region.update(req.params.id, updateData);
        
        if (!updated) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy vùng miền'
            });
        }

        res.json({
            success: true,
            message: 'Cập nhật vùng miền thành công',
            data: updated
        });
    } catch (error) {
        console.error('Update Region Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi cập nhật vùng miền'
        });
    }
});

// DELETE /api/regions/:id - Xóa vùng miền
app.delete('/api/regions/:id', async (req, res) => {
    try {
        const deleted = await DataModel.SQL.Region.delete(req.params.id);
        
        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy vùng miền'
            });
        }

        res.json({
            success: true,
            message: 'Xóa vùng miền thành công'
        });
    } catch (error) {
        console.error('Delete Region Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi xóa vùng miền'
        });
    }
});

// ===== PROVINCES API =====

// GET /api/provinces - Lấy danh sách tỉnh/thành
app.get('/api/provinces', injectPoolForAdmin, async (req, res) => {
    try {
        const { vung_id, trang_thai } = req.query;
        
        const filters = {};
        if (vung_id) filters.vung_id = vung_id;
        if (trang_thai !== undefined) filters.trang_thai = parseInt(trang_thai);
        
        const provinces = await DataModel.SQL.Province.findAll(req.dbPool, filters);
        
        res.json({
            success: true,
            data: provinces
        });
    } catch (error) {
        console.error('Provinces API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách tỉnh/thành'
        });
    }
});

// GET /api/provinces/:id - Lấy thông tin tỉnh/thành
app.get('/api/provinces/:id', injectPoolForAdmin, async (req, res) => {
    try {
        const province = await DataModel.SQL.Province.findById(req.params.id);
        
        if (!province) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy tỉnh/thành'
            });
        }
        
        res.json({
            success: true,
            data: province
        });
    } catch (error) {
        console.error('Province API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin tỉnh/thành'
        });
    }
});

// POST /api/provinces - Tạo tỉnh/thành mới
app.post('/api/provinces', async (req, res) => {
    try {
        const provinceData = {
            ma_tinh: req.body.ma_tinh,
            ten_tinh: req.body.ten_tinh,
            vung_id: req.body.vung_id,
            is_major_city: req.body.is_major_city || 0,
            thu_tu_uu_tien: req.body.thu_tu_uu_tien || 0,
            trang_thai: req.body.trang_thai !== undefined ? req.body.trang_thai : 1
        };

        // Validate required fields
        if (!provinceData.ma_tinh || !provinceData.ten_tinh || !provinceData.vung_id) {
            return res.status(400).json({
                success: false,
                message: 'Mã tỉnh, tên tỉnh và vùng miền là bắt buộc'
            });
        }

        const newProvince = await DataModel.SQL.Province.create(provinceData);
        
        res.status(201).json({
            success: true,
            message: 'Tạo tỉnh/thành thành công',
            data: newProvince
        });
    } catch (error) {
        console.error('Create Province Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi tạo tỉnh/thành'
        });
    }
});

// PUT /api/provinces/:id - Cập nhật tỉnh/thành
app.put('/api/provinces/:id', async (req, res) => {
    try {
        const updateData = {
            ma_tinh: req.body.ma_tinh,
            ten_tinh: req.body.ten_tinh,
            vung_id: req.body.vung_id,
            is_major_city: req.body.is_major_city,
            thu_tu_uu_tien: req.body.thu_tu_uu_tien,
            trang_thai: req.body.trang_thai
        };

        const updated = await DataModel.SQL.Province.update(req.params.id, updateData);
        
        if (!updated) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy tỉnh/thành'
            });
        }

        res.json({
            success: true,
            message: 'Cập nhật tỉnh/thành thành công',
            data: updated
        });
    } catch (error) {
        console.error('Update Province Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi cập nhật tỉnh/thành'
        });
    }
});

// DELETE /api/provinces/:id - Xóa tỉnh/thành
app.delete('/api/provinces/:id', async (req, res) => {
    try {
        const deleted = await DataModel.SQL.Province.delete(req.params.id);
        
        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy tỉnh/thành'
            });
        }

        res.json({
            success: true,
            message: 'Xóa tỉnh/thành thành công'
        });
    } catch (error) {
        console.error('Delete Province Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi xóa tỉnh/thành'
        });
    }
});

// GET /api/products/by-region/:regionId - Lấy sản phẩm theo vùng miền
app.get('/api/products/by-region/:regionId', async (req, res) => {
    try {
        const { regionId } = req.params;
        console.log('🔍 Fetching products for region:', regionId);
        
        // Lấy tất cả sản phẩm có trong kho thuộc vùng miền này
        const query = `
            SELECT 
                p.id,
                p.ten_san_pham,
                p.ma_sku,
                p.gia_ban,
                p.gia_niem_yet,
                p.link_anh,
                p.trang_thai,
                p.ngay_tao,
                ISNULL(SUM(inv.so_luong_kha_dung), 0) as tong_ton_kho
            FROM products p
            LEFT JOIN inventory inv ON p.id = inv.san_pham_id AND inv.so_luong_kha_dung > 0
            LEFT JOIN warehouses w ON inv.kho_id = w.id
            LEFT JOIN wards wd ON w.phuong_xa_id = wd.id
            LEFT JOIN provinces prov ON wd.tinh_thanh_id = prov.id
            LEFT JOIN regions r ON prov.vung_id = r.ma_vung
            WHERE p.trang_thai = 1
                AND (r.id = @regionId OR r.id IS NULL)
            GROUP BY 
                p.id, p.ten_san_pham, p.ma_sku, 
                p.gia_ban, p.gia_niem_yet, p.link_anh, p.trang_thai, p.ngay_tao
            HAVING ISNULL(SUM(inv.so_luong_kha_dung), 0) > 0
            ORDER BY p.ngay_tao DESC
        `;
        
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('regionId', sql.UniqueIdentifier, regionId)
            .query(query);
        
        console.log('📦 Found products:', result.recordset.length);
        
        const products = result.recordset.map(product => ({
            ...product,
            gia_ban_formatted: new Intl.NumberFormat('vi-VN').format(product.gia_ban),
            gia_khuyen_mai_formatted: product.gia_niem_yet 
                ? new Intl.NumberFormat('vi-VN').format(product.gia_niem_yet)
                : null,
            tiet_kiem: product.gia_niem_yet && product.gia_niem_yet > product.gia_ban
                ? product.gia_niem_yet - product.gia_ban
                : 0,
            tiet_kiem_formatted: product.gia_niem_yet && product.gia_niem_yet > product.gia_ban
                ? new Intl.NumberFormat('vi-VN').format(product.gia_niem_yet - product.gia_ban)
                : null,
            phan_tram_giam: product.gia_niem_yet && product.gia_niem_yet > product.gia_ban
                ? Math.round(((product.gia_niem_yet - product.gia_ban) / product.gia_niem_yet) * 100)
                : 0,
            ten_kho: 'Kho có sẵn' // Placeholder, có thể query riêng nếu cần
        }));
        
        res.json({
            success: true,
            data: products,
            count: products.length
        });
    } catch (error) {
        console.error('❌ Products by region API Error:', error);
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy sản phẩm theo vùng miền',
            error: error.message
        });
    }
});

// =============================================
// SHIPPING METHODS API
// =============================================

// GET /api/shipping-methods - Lấy tất cả phương thức vận chuyển
app.get('/api/shipping-methods', injectPoolForAdmin, async (req, res) => {
    try {
        const query = `
            SELECT 
                sm.id,
                sm.ten_phuong_thuc,
                sm.mo_ta,
                sm.chi_phi_co_ban,
                sm.mongo_config_id,
                sm.trang_thai,
                sm.ngay_tao
            FROM shipping_methods sm
            ORDER BY sm.chi_phi_co_ban ASC
        `;
        
        const result = await req.dbPool.request().query(query);
        
        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('Shipping Methods API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách phương thức vận chuyển'
        });
    }
});

// GET /api/shipping-methods/by-address/:addressId - Lấy shipping methods theo địa chỉ
app.get('/api/shipping-methods/by-address/:addressId', injectPoolForAdmin, async (req, res) => {
    try {
        const { addressId } = req.params;
        
        console.log('🚚 Fetching shipping methods for address:', addressId);
        
        // Query lấy vùng của địa chỉ và các phương thức vận chuyển tương ứng
        const query = `
            SELECT 
                sm.id as shipping_method_id,
                sm.ten_phuong_thuc,
                sm.chi_phi_co_ban,
                smr.id as shipping_method_region_id,
                smr.chi_phi_van_chuyen,
                smr.thoi_gian_giao_du_kien,
                r.ma_vung,
                r.ten_vung,
                (sm.chi_phi_co_ban + smr.chi_phi_van_chuyen) as tong_phi
            FROM user_addresses ua
            INNER JOIN wards w ON ua.phuong_xa_id = w.id
            INNER JOIN provinces p ON w.tinh_thanh_id = p.id
            INNER JOIN regions r ON p.vung_id = r.ma_vung
            INNER JOIN shipping_method_regions smr ON r.ma_vung = smr.region_id
            INNER JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
            WHERE ua.id = @addressId
                AND ua.trang_thai = 1
                AND sm.trang_thai = 1
                AND smr.trang_thai = 1
            ORDER BY (sm.chi_phi_co_ban + smr.chi_phi_van_chuyen) ASC
        `;
        
        const request = new sql.Request(req.dbPool);
        const result = await request
            .input('addressId', sql.UniqueIdentifier, addressId)
            .query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy địa chỉ hoặc không có phương thức vận chuyển cho vùng này'
            });
        }
        
        const shippingMethods = result.recordset.map(method => ({
            shipping_method_id: method.shipping_method_id,
            shipping_method_region_id: method.shipping_method_region_id,
            ten_phuong_thuc: method.ten_phuong_thuc,
            chi_phi_co_ban: method.chi_phi_co_ban,
            chi_phi_van_chuyen: method.chi_phi_van_chuyen,
            tong_phi: method.tong_phi,
            thoi_gian_giao_du_kien: method.thoi_gian_giao_du_kien,
            ma_vung: method.ma_vung,
            ten_vung: method.ten_vung,
            chi_phi_formatted: new Intl.NumberFormat('vi-VN').format(method.tong_phi) + 'đ',
            thoi_gian_text: method.thoi_gian_giao_du_kien === 0 
                ? 'Trong 24h' 
                : method.thoi_gian_giao_du_kien === 1 
                ? '1-2 ngày' 
                : `${method.thoi_gian_giao_du_kien} ngày`
        }));
        
        console.log('📦 Found shipping methods:', shippingMethods.length);
        
        res.json({
            success: true,
            data: shippingMethods,
            region_info: {
                ma_vung: result.recordset[0].ma_vung,
                ten_vung: result.recordset[0].ten_vung
            }
        });
    } catch (error) {
        console.error('❌ Shipping Methods by Address API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy phương thức vận chuyển theo địa chỉ',
            error: error.message
        });
    }
});

// GET /api/shipping-methods/by-region/:regionId - Lấy shipping methods theo vùng
app.get('/api/shipping-methods/by-region/:regionId', injectPoolForAdmin, async (req, res) => {
    try {
        const { regionId } = req.params;
        
        console.log('🚚 Fetching shipping methods for region:', regionId);
        
        const query = `
            SELECT 
                sm.id as shipping_method_id,
                sm.ten_phuong_thuc,
                sm.chi_phi_co_ban,
                smr.id as shipping_method_region_id,
                smr.chi_phi_van_chuyen,
                smr.thoi_gian_giao_du_kien,
                r.ma_vung,
                r.ten_vung,
                (sm.chi_phi_co_ban + smr.chi_phi_van_chuyen) as tong_phi
            FROM shipping_method_regions smr
            INNER JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
            INNER JOIN regions r ON smr.region_id = r.ma_vung
            WHERE r.ma_vung = @regionId
                AND sm.trang_thai = 1
                AND smr.trang_thai = 1
            ORDER BY (sm.chi_phi_co_ban + smr.chi_phi_van_chuyen) ASC
        `;
        
        const request = new sql.Request(req.dbPool);
        const result = await request
            .input('regionId', sql.NVarChar(10), regionId)
            .query(query);
        
        const shippingMethods = result.recordset.map(method => ({
            shipping_method_id: method.shipping_method_id,
            shipping_method_region_id: method.shipping_method_region_id,
            ten_phuong_thuc: method.ten_phuong_thuc,
            chi_phi_co_ban: method.chi_phi_co_ban,
            chi_phi_van_chuyen: method.chi_phi_van_chuyen,
            tong_phi: method.tong_phi,
            thoi_gian_giao_du_kien: method.thoi_gian_giao_du_kien,
            ma_vung: method.ma_vung,
            ten_vung: method.ten_vung,
            chi_phi_formatted: new Intl.NumberFormat('vi-VN').format(method.tong_phi) + 'đ',
            thoi_gian_text: method.thoi_gian_giao_du_kien === 0 
                ? 'Trong 24h' 
                : method.thoi_gian_giao_du_kien === 1 
                ? '1-2 ngày' 
                : `${method.thoi_gian_giao_du_kien} ngày`
        }));
        
        res.json({
            success: true,
            data: shippingMethods,
            region_info: result.recordset.length > 0 ? {
                ma_vung: result.recordset[0].ma_vung,
                ten_vung: result.recordset[0].ten_vung
            } : null
        });
    } catch (error) {
        console.error('❌ Shipping Methods by Region API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy phương thức vận chuyển theo vùng',
            error: error.message
        });
    }
});

// GET /api/shipping-methods/:id - Lấy chi tiết một phương thức vận chuyển
app.get('/api/shipping-methods/:id', injectPoolForAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = `
            SELECT 
                sm.id,
                sm.ten_phuong_thuc,
                sm.chi_phi_co_ban,
                sm.mongo_config_id,
                sm.trang_thai,
                sm.ngay_tao
            FROM shipping_methods sm
            WHERE sm.id = @id
        `;
        
        const request = new sql.Request(req.dbPool);
        const result = await request
            .input('id', sql.UniqueIdentifier, id)
            .query(query);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy phương thức vận chuyển'
            });
        }
        
        // Lấy chi tiết theo vùng
        const regionQuery = `
            SELECT 
                smr.id,
                smr.region_id,
                smr.chi_phi_van_chuyen,
                smr.thoi_gian_giao_du_kien,
                r.ten_vung
            FROM shipping_method_regions smr
            INNER JOIN regions r ON smr.region_id = r.ma_vung
            WHERE smr.shipping_method_id = @id
                AND smr.trang_thai = 1
        `;
        
        const regionResult = await request.query(regionQuery);
        
        res.json({
            success: true,
            data: {
                ...result.recordset[0],
                regions: regionResult.recordset
            }
        });
    } catch (error) {
        console.error('Shipping Method Detail API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy chi tiết phương thức vận chuyển'
        });
    }
});

// ===== WARDS API =====

// GET /api/wards - Lấy danh sách phường/xã
app.get('/api/wards', injectPoolForAdmin, async (req, res) => {
    try {
        const { tinh_thanh_id, loai, trang_thai } = req.query;
        
        const filters = {};
        if (tinh_thanh_id) filters.tinh_thanh_id = tinh_thanh_id;
        if (loai) filters.loai = loai;
        if (trang_thai !== undefined) filters.trang_thai = parseInt(trang_thai);
        
        const wards = await DataModel.SQL.Ward.findAll(req.dbPool, filters);
        
        res.json({
            success: true,
            data: wards
        });
    } catch (error) {
        console.error('Wards API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách phường/xã'
        });
    }
});

// GET /api/wards/:id - Lấy thông tin phường/xã
app.get('/api/wards/:id', async (req, res) => {
    try {
        const ward = await DataModel.SQL.Ward.findById(req.params.id);
        
        if (!ward) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy phường/xã'
            });
        }
        
        res.json({
            success: true,
            data: ward
        });
    } catch (error) {
        console.error('Ward API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin phường/xã'
        });
    }
});

// POST /api/wards - Tạo phường/xã mới
app.post('/api/wards', async (req, res) => {
    try {
        const wardData = {
            ma_phuong_xa: req.body.ma_phuong_xa,
            ten_phuong_xa: req.body.ten_phuong_xa,
            tinh_thanh_id: req.body.tinh_thanh_id,
            loai: req.body.loai,
            is_inner_area: req.body.is_inner_area || 0,
            trang_thai: req.body.trang_thai !== undefined ? req.body.trang_thai : 1
        };

        // Validate required fields
        if (!wardData.ma_phuong_xa || !wardData.ten_phuong_xa || !wardData.tinh_thanh_id || !wardData.loai) {
            return res.status(400).json({
                success: false,
                message: 'Mã phường/xã, tên, tỉnh/thành và loại là bắt buộc'
            });
        }

        const newWard = await DataModel.SQL.Ward.create(wardData);
        
        res.status(201).json({
            success: true,
            message: 'Tạo phường/xã thành công',
            data: newWard
        });
    } catch (error) {
        console.error('Create Ward Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi tạo phường/xã'
        });
    }
});

// PUT /api/wards/:id - Cập nhật phường/xã
app.put('/api/wards/:id', async (req, res) => {
    try {
        const updateData = {
            ma_phuong_xa: req.body.ma_phuong_xa,
            ten_phuong_xa: req.body.ten_phuong_xa,
            tinh_thanh_id: req.body.tinh_thanh_id,
            loai: req.body.loai,
            is_inner_area: req.body.is_inner_area,
            trang_thai: req.body.trang_thai
        };

        const updated = await DataModel.SQL.Ward.update(req.params.id, updateData);
        
        if (!updated) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy phường/xã'
            });
        }

        res.json({
            success: true,
            message: 'Cập nhật phường/xã thành công',
            data: updated
        });
    } catch (error) {
        console.error('Update Ward Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi cập nhật phường/xã'
        });
    }
});

// DELETE /api/wards/:id - Xóa phường/xã
app.delete('/api/wards/:id', async (req, res) => {
    try {
        const deleted = await DataModel.SQL.Ward.delete(req.params.id);
        
        if (!deleted) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy phường/xã'
            });
        }

        res.json({
            success: true,
            message: 'Xóa phường/xã thành công'
        });
    } catch (error) {
        console.error('Delete Ward Error:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Lỗi khi xóa phường/xã'
        });
    }
});

// ===== USERS MANAGEMENT =====

// Admin render route for Users management page
app.get('/admin/nguoidung', requireAdmin, async (req, res) => {
    try {
        // Lấy danh sách users từ SQL - sử dụng pool theo vùng
        const users = await DataModel.SQL.User.findAll(req.dbPool);
        
        res.render('nguoidung', {
            layout: 'AdminMain',
            users: users || []
        });
    } catch (error) {
        console.error('Render Users Page Error:', error);
        res.status(500).send('Lỗi khi tải trang người dùng');
    }
});

// GET /api/users - list users with filters
app.get('/api/users', injectPoolForAdmin, async (req, res) => {
    try {
        const { search, status } = req.query;

        // Lấy dữ liệu từ SQL với filters
        const filters = {};
        if (status !== undefined) filters.status = parseInt(status);
        
        let users = await DataModel.SQL.User.findAll(req.dbPool, filters);

        // Apply search filter if provided
        if (search) {
            const searchLower = search.toLowerCase();
            users = users.filter(u =>
                (u.name && u.name.toLowerCase().includes(searchLower)) ||
                (u.email && u.email.toLowerCase().includes(searchLower)) ||
                (u.phone && u.phone.toLowerCase().includes(searchLower))
            );
        }

        res.json({ success: true, data: users });
    } catch (error) {
        console.error('Users GET Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy danh sách người dùng' });
    }
});

// POST /api/users - create user
app.post('/api/users', async (req, res) => {
    try {
        const { name, email, phone, vung_id, status, password, additionalFields } = req.body;

        // Validate required fields
        if (!name || !email) {
            return res.status(400).json({ 
                success: false, 
                message: 'Tên và email là bắt buộc' 
            });
        }

        // Check if email already exists
        const existingUser = await DataModel.SQL.User.findByEmail(email);
        if (existingUser) {
            return res.status(409).json({ 
                success: false, 
                message: 'Email đã tồn tại' 
            });
        }

        // Hash password (in production, use bcrypt)
        const hashedPassword = password; // TODO: Implement proper password hashing

        // Create user in SQL
        const newUser = await DataModel.SQL.User.create({
            name,
            email,
            phone: phone || null,
            vung_id: vung_id || 'bac',
            status: status !== undefined ? parseInt(status) : 1,
            password: hashedPassword
        });

        // Create corresponding MongoDB profile and update SQL with mongo_profile_id
        try {
            const mongoData = {
                sql_user_id: newUser.id,
                ...additionalFields
            };
            
            const mongoProfile = await DataModel.Mongo.UserDetail.create(mongoData);
            
            // Update SQL user with MongoDB profile ID
            await DataModel.SQL.User.update(newUser.id, {
                ...newUser,
                mongo_profile_id: mongoProfile._id.toString()
            });
            
            // Add mongo_profile_id to response
            newUser.mongo_profile_id = mongoProfile._id.toString();
        } catch (mongoError) {
            console.warn('⚠️ MongoDB UserDetail creation failed:', mongoError);
            // Continue even if MongoDB fails
        }

        res.status(201).json({ 
            success: true, 
            message: 'Tạo người dùng thành công', 
            data: newUser 
        });
    } catch (error) {
        console.error('Users CREATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Lỗi khi tạo người dùng' 
        });
    }
});

// GET /api/users/:id/profile - get MongoDB profile
app.get('/api/users/:id/profile', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Get user from SQL to get mongo_profile_id
        const user = await DataModel.SQL.User.findById(id);
        if (!user || !user.mongo_profile_id) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy profile' 
            });
        }
        
        // Get profile from MongoDB
        const profile = await DataModel.Mongo.UserDetail.findById(user.mongo_profile_id);
        if (!profile) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy profile trong MongoDB' 
            });
        }
        
        // Convert to plain object and remove internal fields
        const profileData = profile.toObject();
        delete profileData.__v;
        
        // Convert additionalFields array back to object for frontend
        if (profileData.additionalFields && Array.isArray(profileData.additionalFields)) {
            const fieldsObject = {};
            profileData.additionalFields.forEach(item => {
                if (item.key) {
                    fieldsObject[item.key] = item.value || '';
                }
            });
            // Replace array with object
            Object.keys(profileData).forEach(key => {
                if (key !== '_id' && key !== 'sql_user_id' && key !== 'createdAt' && key !== 'updatedAt' && key !== 'additionalFields') {
                    delete profileData[key];
                }
            });
            Object.assign(profileData, fieldsObject);
            delete profileData.additionalFields;
        }
        
        res.json(profileData);
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    }
});

// PUT /api/users/:id - update user
app.put('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, phone, vung_id, status, password, additionalFields } = req.body;
        
        console.log('📝 PUT /api/users/:id received:', { id, additionalFields });

        // Check if user exists
        const existingUser = await DataModel.SQL.User.findById(id);
        if (!existingUser) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy người dùng' 
            });
        }

        // Check email collision if email changed
        if (email && email !== existingUser.email) {
            const userWithSameEmail = await DataModel.SQL.User.findByEmail(email);
            if (userWithSameEmail && userWithSameEmail.id !== id) {
                return res.status(409).json({ 
                    success: false, 
                    message: 'Email đã tồn tại' 
                });
            }
        }

        const updateData = {
            name: name || existingUser.name,
            email: email || existingUser.email,
            phone: phone !== undefined ? phone : existingUser.phone,
            vung_id: vung_id || existingUser.vung_id,
            status: status !== undefined ? parseInt(status) : existingUser.status
        };

        // Only update password if provided
        if (password && password.length >= 8) {
            updateData.password = password; // TODO: Implement proper password hashing
        }

        const updatedUser = await DataModel.SQL.User.update(id, updateData);

        // Update MongoDB additional fields (convert object to array)
        if (existingUser.mongo_profile_id) {
            try {
                console.log('🔍 MongoDB update attempt for profile:', existingUser.mongo_profile_id);
                console.log('📦 additionalFields received (object):', additionalFields);
                
                // Convert object to array of {key, value}
                const fieldsArray = [];
                if (additionalFields && typeof additionalFields === 'object') {
                    Object.entries(additionalFields).forEach(([key, value]) => {
                        fieldsArray.push({ key, value: String(value || '') });
                    });
                }
                
                console.log('📋 Converted to array:', fieldsArray);
                
                // Update MongoDB with array structure
                const result = await DataModel.Mongo.UserDetail.findByIdAndUpdate(
                    existingUser.mongo_profile_id,
                    { 
                        $set: { additionalFields: fieldsArray }
                    },
                    { new: true, runValidators: false }
                );
                
                console.log('✅ MongoDB update result:', result?.toObject());
            } catch (mongoError) {
                console.error('❌ MongoDB update failed:', mongoError);
            }
        } else {
            console.log('⚠️ User has no mongo_profile_id');
        }

        res.json({ 
            success: true, 
            message: 'Cập nhật người dùng thành công', 
            data: updatedUser 
        });
    } catch (error) {
        console.error('Users UPDATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message || 'Lỗi khi cập nhật người dùng' 
        });
    }
});

// DELETE /api/users/:id - delete user (soft delete)
app.delete('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const deleted = await DataModel.SQL.User.delete(id);
        
        if (!deleted) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy người dùng' 
            });
        }

        res.json({ 
            success: true, 
            message: 'Xóa người dùng thành công' 
        });
    } catch (error) {
        console.error('Users DELETE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi xóa người dùng' 
        });
    }
});

// PUT /api/users/:id/status - toggle/update status
app.put('/api/users/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        
        const existingUser = await DataModel.SQL.User.findById(id);
        if (!existingUser) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy người dùng' 
            });
        }

        const newStatus = status !== undefined ? parseInt(status) : (existingUser.status ? 0 : 1);
        
        const updatedUser = await DataModel.SQL.User.updateStatus(id, newStatus);

        res.json({ 
            success: true, 
            message: 'Cập nhật trạng thái thành công', 
            data: updatedUser 
        });
    } catch (error) {
        console.error('Users STATUS Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi cập nhật trạng thái' 
        });
    }
});

// GET /api/users/:id/detail - Get MongoDB extended user details
app.get('/api/users/:id/detail', async (req, res) => {
    try {
        const { id } = req.params;
        
        const userDetail = await DataModel.Mongo.UserDetail.findOne({ sql_user_id: id });
        
        if (!userDetail) {
            return res.json({ 
                success: true, 
                data: null 
            });
        }

        res.json({ 
            success: true, 
            data: userDetail 
        });
    } catch (error) {
        console.error('User Detail GET Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy chi tiết người dùng' 
        });
    }
});

// PUT /api/users/:id/detail - Update MongoDB extended user details
app.put('/api/users/:id/detail', async (req, res) => {
    try {
        const { id } = req.params;
        const detailData = req.body;

        const updatedDetail = await DataModel.Mongo.UserDetail.findOneAndUpdate(
            { sql_user_id: id },
            { $set: detailData },
            { upsert: true, new: true }
        );

        res.json({ 
            success: true, 
            message: 'Cập nhật chi tiết người dùng thành công',
            data: updatedDetail 
        });
    } catch (error) {
        console.error('User Detail UPDATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi cập nhật chi tiết người dùng' 
        });
    }
});

// ==================== INVENTORY & WAREHOUSE ROUTES ====================

// GET /admin/inventory - Render inventory management page
app.get('/admin/inventory', requireAdmin, async (req, res) => {
    try {
        console.log('🚀 Loading admin inventory page...');
        
        const pool = req.dbPool;
        
        // Load warehouses và products - sử dụng pool theo vùng
        const warehouses = await DataModel.SQL.Warehouse.findAll(pool);
        
        // Load products (replicated across all sites)
        const productsResult = await pool.request().query(`
            SELECT DISTINCT
                id,
                ma_san_pham,
                ten_san_pham
            FROM products
            WHERE trang_thai = 1
            ORDER BY ten_san_pham
        `);
        const products = productsResult.recordset;
        
        console.log('📊 Data loaded:');
        console.log('  - Warehouses:', warehouses.length);
        console.log('  - Products:', products.length);

        res.render('inventory', { 
            layout: 'AdminMain', 
            title: 'Quản lý Tồn kho',
            warehouses,
            products
        });
        
    } catch (err) {
        console.error('❌ Lỗi trong route /admin/inventory:', err);
        res.status(500).send(`
            <html>
                <head><title>Lỗi</title></head>
                <body>
                    <h1>Đã xảy ra lỗi</h1>
                    <p>Không thể tải trang quản lý tồn kho: ${err.message}</p>
                    <a href="/admin">Quay lại trang chủ</a>
                </body>
            </html>
        `);
    }
});

// =============================================
// QUẢN LÝ ĐỠN HÀNG (ORDERS)
// =============================================

// GET /admin/donhang - Render order management page
app.get('/admin/donhang', requireAdmin, async (req, res) => {
    try {
        console.log('🚀 Loading admin orders page...');
        
        res.render('donhang', { 
            layout: 'AdminMain', 
            title: 'Quản lý Đơn hàng',
            user: req.session.user
        });
        
    } catch (err) {
        console.error('❌ Lỗi trong route /admin/donhang:', err);
        res.status(500).send(`
            <html>
                <head><title>Lỗi</title></head>
                <body>
                    <h1>Đã xảy ra lỗi</h1>
                    <p>Không thể tải trang quản lý đơn hàng: ${err.message}</p>
                    <a href="/admin">Quay lại trang chủ</a>
                </body>
            </html>
        `);
    }
});

// API ENDPOINTS FOR ORDERS

// GET /api/donhang - Get all orders with details
app.get('/api/donhang', injectPoolForAdmin, async (req, res) => {
    try {
        console.log('🔄 API /api/donhang called');
        
        const pool = req.dbPool;
        const result = await pool.request().query(`
            SELECT 
                o.id,
                o.ma_don_hang,
                o.nguoi_dung_id,
                o.vung_don_hang,
                o.tong_tien_hang,
                o.phi_van_chuyen,
                o.gia_tri_giam_voucher,
                o.tong_thanh_toan,
                o.trang_thai,
                o.ngay_tao,
                o.ngay_cap_nhat,
                u.ho_ten,
                u.email,
                u.so_dien_thoai,
                w.ten_kho
            FROM orders o
            LEFT JOIN users u ON o.nguoi_dung_id = u.id
            LEFT JOIN warehouses w ON o.kho_giao_hang = w.id
            ORDER BY o.ngay_tao DESC
        `);

        res.json({ 
            success: true, 
            orders: result.recordset 
        });
        
    } catch (error) {
        console.error('Orders GET Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy danh sách đơn hàng' 
        });
    }
});

// GET /api/donhang/:id - Get single order with full details
app.get('/api/donhang/:id', async (req, res) => {
    console.log('🔄 Route /api/donhang/:id HIT');
    try {
        const { id } = req.params;
        console.log('🔄 Received ID:', id);
        
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(id)) {
            console.log('❌ Invalid UUID format:', id);
            return res.status(400).json({ 
                success: false, 
                message: 'ID đơn hàng không hợp lệ' 
            });
        }
        
        const pool = db.connectionPools.default;
        console.log('✅ SQL connected, querying order...');
        
        // Get order info with all details in one query
        const result = await pool.request()
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                SELECT 
                    o.id,
                    o.ma_don_hang,
                    o.nguoi_dung_id,
                    o.vung_don_hang,
                    o.is_split_order,
                    o.tong_tien_hang,
                    o.phi_van_chuyen,
                    o.gia_tri_giam_voucher,
                    o.tong_thanh_toan,
                    o.trang_thai,
                    o.ngay_tao,
                    o.ngay_cap_nhat,
                    o.payment_method,
                    o.ghi_chu_order,
                    u.ho_ten,
                    u.email,
                    u.so_dien_thoai,
                    w.ten_kho,
                    ua.dia_chi_cu_the,
                    ua.ten_nguoi_nhan,
                    ua.sdt_nguoi_nhan,
                    ward.ten_phuong_xa,
                    prov.ten_tinh,
                    sm.ten_phuong_thuc,
                    -- Get order items with product info and warehouse details
                    (
                        SELECT 
                            od.id,
                            od.variant_id,
                            od.warehouse_id,
                            od.warehouse_region,
                            od.so_luong,
                            od.don_gia,
                            od.thanh_tien,
                            pv.ten_hien_thi AS ten_bien_the,
                            pv.ma_sku,
                            p.ten_san_pham,
                            p.ma_san_pham,
                            wh.ten_kho AS ten_kho_xuat
                        FROM order_details od
                        LEFT JOIN product_variants pv ON od.variant_id = pv.id
                        LEFT JOIN products p ON pv.san_pham_id = p.id
                        LEFT JOIN warehouses wh ON od.warehouse_id = wh.id
                        WHERE od.don_hang_id = o.id
                        FOR JSON PATH
                    ) AS items_json
                FROM orders o
                LEFT JOIN users u ON o.nguoi_dung_id = u.id
                LEFT JOIN warehouses w ON o.kho_giao_hang = w.id
                LEFT JOIN user_addresses ua ON o.dia_chi_giao_hang_id = ua.id
                LEFT JOIN wards ward ON ua.phuong_xa_id = ward.id
                LEFT JOIN provinces prov ON ward.tinh_thanh_id = prov.id
                LEFT JOIN shipping_method_regions smr ON o.shipping_method_region_id = smr.id
                LEFT JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
                WHERE o.id = @id
            `);

        console.log('✅ Query completed, records:', result.recordset.length);

        if (result.recordset.length === 0) {
            console.log('❌ No order found with ID:', id);
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy đơn hàng' 
            });
        }

        const order = result.recordset[0];
        
        // Parse items JSON
        if (order.items_json) {
            try {
                order.items = JSON.parse(order.items_json);
            } catch (e) {
                console.error('Error parsing items JSON:', e);
                order.items = [];
            }
        } else {
            order.items = [];
        }
        delete order.items_json;

        // Format delivery address
        const addressParts = [
            order.dia_chi_cu_the,
            order.ten_phuong_xa,
            order.ten_tinh
        ].filter(Boolean);
        
        order.dia_chi_giao_hang = addressParts.join(', ');

        console.log('✅ Returning order with', order.items.length, 'items');
        
        res.json({ 
            success: true, 
            order 
        });
        
    } catch (error) {
        console.error('❌ Order Detail GET Error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy chi tiết đơn hàng: ' + error.message 
        });
    }
});

// Test route
console.log('✅ Order API routes registered at /api/donhang');

// PUT /api/donhang/:id/status - Update order status
app.put('/api/donhang/:id/status', requireAdmin, async (req, res) => {
    const transaction = new sql.Transaction(req.dbPool || db.connectionPools.default);
    
    try {
        const { id } = req.params;
        const { trang_thai, ghi_chu } = req.body;
        
        // Lấy user ID từ session (người đang login)
        const userId = req.session?.user?.id || null;
        
        console.log('🔄 API /api/donhang/:id/status called with:', { 
            orderId: id, 
            trang_thai, 
            ghi_chu, 
            userId,
            userName: req.session?.user?.ho_ten 
        });

        // Validate status
        const validStatuses = ['cho_xac_nhan', 'dang_xu_ly', 'dang_giao', 'hoan_thanh', 'huy'];
        if (!validStatuses.includes(trang_thai)) {
            return res.status(400).json({ 
                success: false, 
                message: 'Trạng thái không hợp lệ' 
            });
        }

        // Get current status before updating
        const checkRequest = new sql.Request(db.connectionPools.default);
        const currentOrder = await checkRequest
            .input('id', sql.UniqueIdentifier, id)
            .query('SELECT trang_thai FROM orders WHERE id = @id');
        
        if (currentOrder.recordset.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy đơn hàng' 
            });
        }

        const trang_thai_cu = currentOrder.recordset[0].trang_thai;
        
        // If status hasn't changed, no need to update
        if (trang_thai_cu === trang_thai) {
            return res.json({ 
                success: true, 
                message: 'Trạng thái không thay đổi' 
            });
        }

        // Start transaction
        await transaction.begin();

        // Update order status
        const updateRequest = new sql.Request(transaction);
        await updateRequest
            .input('id', sql.UniqueIdentifier, id)
            .input('trang_thai', sql.NVarChar(20), trang_thai)
            .input('ngay_cap_nhat', sql.DateTime2, new Date())
            .query(`
                UPDATE orders 
                SET trang_thai = @trang_thai,
                    ngay_cap_nhat = @ngay_cap_nhat
                WHERE id = @id
            `);

        // Insert into order_status_history
        const historyRequest = new sql.Request(transaction);
        await historyRequest
            .input('don_hang_id', sql.UniqueIdentifier, id)
            .input('trang_thai_cu', sql.NVarChar(20), trang_thai_cu)
            .input('trang_thai_moi', sql.NVarChar(20), trang_thai)
            .input('ghi_chu', sql.NVarChar(500), ghi_chu || null)
            .input('nguoi_thao_tac', sql.UniqueIdentifier, userId)
            .query(`
                INSERT INTO order_status_history (
                    don_hang_id, trang_thai_cu, trang_thai_moi, 
                    ghi_chu, nguoi_thao_tac, ngay_tao
                )
                VALUES (
                    @don_hang_id, @trang_thai_cu, @trang_thai_moi,
                    @ghi_chu, @nguoi_thao_tac, GETDATE()
                )
            `);

        // Commit transaction
        await transaction.commit();

        console.log('✅ Order status updated:', {
            orderId: id,
            oldStatus: trang_thai_cu,
            newStatus: trang_thai,
            user: userId
        });

        res.json({ 
            success: true, 
            message: 'Cập nhật trạng thái thành công',
            data: {
                trang_thai_cu,
                trang_thai_moi: trang_thai
            }
        });
        
    } catch (error) {
        // Rollback on error
        if (transaction._acquiredConnection) {
            await transaction.rollback();
        }
        
        console.error('Order Status Update Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi cập nhật trạng thái đơn hàng: ' + error.message
        });
    }
});

// API ENDPOINTS FOR INVENTORY

// GET /api/inventory - Get all inventory items
app.get('/api/inventory', injectPoolForAdmin, async (req, res) => {
    try {
        console.log('🔄 API /api/inventory called');
        
        const inventory = await DataModel.SQL.Inventory.findAll(req.dbPool);

        res.json({ 
            success: true, 
            data: { inventory } 
        });
        
    } catch (error) {
        console.error('Inventory GET Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy danh sách tồn kho' 
        });
    }
});

// GET /api/inventory/:id - Get single inventory item
app.get('/api/inventory/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const inventoryItem = await DataModel.SQL.Inventory.findById(id);
        
        if (!inventoryItem) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy tồn kho' 
            });
        }

        res.json({ 
            success: true, 
            data: inventoryItem 
        });
    } catch (error) {
        console.error('Inventory GET by ID Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy thông tin tồn kho' 
        });
    }
});

// POST /api/inventory - Create new inventory item
app.post('/api/inventory', async (req, res) => {
    try {
        const inventoryData = req.body;
        
        console.log('📥 Creating inventory item:', inventoryData);

        // Validate required fields
        if (!inventoryData.san_pham_id || !inventoryData.kho_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Thiếu thông tin sản phẩm hoặc kho' 
            });
        }

        const newInventory = await DataModel.SQL.Inventory.create(inventoryData);

        console.log('✅ Inventory item created:', newInventory.id);

        res.status(201).json({ 
            success: true, 
            message: 'Thêm tồn kho thành công', 
            data: newInventory 
        });
    } catch (error) {
        console.error('Inventory CREATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi thêm tồn kho: ' + error.message 
        });
    }
});

// PUT /api/inventory/:id - Update inventory item
app.put('/api/inventory/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const inventoryData = req.body;
        
        console.log('📝 Updating inventory item:', id, inventoryData);

        const existingInventory = await DataModel.SQL.Inventory.findById(id);
        if (!existingInventory) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy tồn kho' 
            });
        }

        const updatedInventory = await DataModel.SQL.Inventory.update(id, inventoryData);

        console.log('✅ Inventory item updated:', id);

        res.json({ 
            success: true, 
            message: 'Cập nhật tồn kho thành công', 
            data: updatedInventory 
        });
    } catch (error) {
        console.error('Inventory UPDATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi cập nhật tồn kho: ' + error.message 
        });
    }
});

// PUT /api/inventory/:id/adjust - Adjust stock quantity
app.put('/api/inventory/:id/adjust', async (req, res) => {
    try {
        const { id } = req.params;
        const { type, quantity, note } = req.body;
        
        console.log('📊 Adjusting stock:', { id, type, quantity, note });

        if (!type || quantity === undefined) {
            return res.status(400).json({ 
                success: false, 
                message: 'Thiếu loại điều chỉnh hoặc số lượng' 
            });
        }

        const existingInventory = await DataModel.SQL.Inventory.findById(id);
        if (!existingInventory) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy tồn kho' 
            });
        }

        let newQuantity = existingInventory.so_luong_kha_dung;
        
        switch(type) {
            case 'increase':
                newQuantity += parseInt(quantity);
                break;
            case 'decrease':
                newQuantity -= parseInt(quantity);
                if (newQuantity < 0) {
                    return res.status(400).json({ 
                        success: false, 
                        message: 'Số lượng không đủ để xuất kho' 
                    });
                }
                break;
            case 'set':
                newQuantity = parseInt(quantity);
                break;
            default:
                return res.status(400).json({ 
                    success: false, 
                    message: 'Loại điều chỉnh không hợp lệ' 
                });
        }

        const updatedInventory = await DataModel.SQL.Inventory.update(id, {
            so_luong_kha_dung: newQuantity,
            lan_nhap_hang_cuoi: new Date()
        });

        console.log('✅ Stock adjusted:', id, 'New quantity:', newQuantity);

        res.json({ 
            success: true, 
            message: 'Điều chỉnh tồn kho thành công', 
            data: updatedInventory 
        });
    } catch (error) {
        console.error('Inventory ADJUST Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi điều chỉnh tồn kho: ' + error.message 
        });
    }
});

// POST /api/inventory/upsert - Create or update inventory by variant ID
app.post('/api/inventory/upsert', async (req, res) => {
    try {
        const { bien_the_san_pham_id, so_luong_ton_kho, so_luong_da_ban, ngay_cap_nhat } = req.body;
        
        console.log('📦 Upsert inventory for variant:', bien_the_san_pham_id);

        if (!bien_the_san_pham_id) {
            return res.status(400).json({ 
                success: false, 
                message: 'Thiếu ID biến thể sản phẩm' 
            });
        }

        // Find existing inventory by variant ID
        const existingInventory = await DataModel.SQL.Inventory.findByVariantId(bien_the_san_pham_id);

        let result;
        if (existingInventory) {
            // Update existing inventory
            const updateData = {
                so_luong_kha_dung: so_luong_ton_kho ?? existingInventory.so_luong_kha_dung,
                ngay_cap_nhat: ngay_cap_nhat || new Date()
            };
            
            result = await DataModel.SQL.Inventory.update(existingInventory.id, updateData);
            console.log('✅ Inventory updated for variant:', bien_the_san_pham_id);
        } else {
            // Get variant to find warehouse for its region
            const variant = await DataModel.SQL.ProductVariant.findById(bien_the_san_pham_id);
            
            if (!variant) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'Không tìm thấy biến thể sản phẩm' 
                });
            }
            
            // Find warehouse for this region
            const warehouses = await DataModel.SQL.Warehouse.findByRegion(variant.site_origin);
            
            if (!warehouses || warehouses.length === 0) {
                return res.status(404).json({ 
                    success: false, 
                    message: `Không tìm thấy kho cho vùng ${variant.site_origin}` 
                });
            }
            
            // Create new inventory for first warehouse in region
            const newInventoryData = {
                variant_id: bien_the_san_pham_id,
                kho_id: warehouses[0].id,
                so_luong_kha_dung: so_luong_ton_kho || 0,
                so_luong_da_dat: 0,
                muc_ton_kho_toi_thieu: 10,
                so_luong_nhap_lai: 50,
                lan_nhap_hang_cuoi: new Date(),
                ngay_cap_nhat: ngay_cap_nhat || new Date()
            };
            
            result = await DataModel.SQL.Inventory.create(newInventoryData);
            console.log('✅ Inventory created for variant:', bien_the_san_pham_id);
        }

        res.json({ 
            success: true, 
            message: existingInventory ? 'Cập nhật tồn kho thành công' : 'Tạo tồn kho thành công', 
            data: result 
        });
    } catch (error) {
        console.error('Inventory UPSERT Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi cập nhật tồn kho: ' + error.message 
        });
    }
});

// DELETE /api/inventory/:id - Delete inventory item
app.delete('/api/inventory/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log('🗑️ Deleting inventory item:', id);

        const existingInventory = await DataModel.SQL.Inventory.findById(id);
        if (!existingInventory) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy tồn kho' 
            });
        }

        await DataModel.SQL.Inventory.delete(id);

        console.log('✅ Inventory item deleted:', id);

        res.json({ 
            success: true, 
            message: 'Xóa tồn kho thành công' 
        });
    } catch (error) {
        console.error('Inventory DELETE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi xóa tồn kho' 
        });
    }
});

// ============================================
// API ENDPOINTS FOR FLASH SALES
// ============================================

// GET /api/flashsales - Get all flash sales
app.get('/api/flashsales', async (req, res) => {
    try {
        const filters = {};
        if (req.query.trang_thai) filters.trang_thai = req.query.trang_thai;
        if (req.query.search) filters.search = req.query.search;
        
        const flashSales = await DataModel.SQL.FlashSale.findAll(filters);
        res.json(flashSales);
    } catch (error) {
        console.error('Flash Sales GET Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy danh sách flash sales' });
    }
});

// Alias route for frontend compatibility (with hyphen)
app.get('/api/flash-sales', injectPoolForAdmin, async (req, res) => {
    try {
        const filters = {};
        if (req.query.trang_thai) filters.trang_thai = req.query.trang_thai;
        if (req.query.search) filters.search = req.query.search;
        
        const flashSales = await DataModel.SQL.FlashSale.findAll(req.dbPool, filters);
        res.json(flashSales);
    } catch (error) {
        console.error('Flash Sales GET Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy danh sách flash sales' });
    }
});

// GET /api/flash-sales/:id - Get single flash sale by ID
app.get('/api/flash-sales/:id', injectPoolForAdmin, async (req, res) => {
    try {
        console.log('🔍 [NEW API] Getting flash sale by ID:', req.params.id);
        const flashSale = await DataModel.SQL.FlashSale.findById(req.params.id);
        
        if (!flashSale) {
            console.log('❌ Flash sale not found:', req.params.id);
            return res.status(404).json({ success: false, message: 'Không tìm thấy flash sale' });
        }
        
        console.log('✅ Flash sale found:', flashSale);
        res.json({ success: true, data: flashSale });
    } catch (error) {
        console.error('❌ Flash Sale GET Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy flash sale: ' + error.message });
    }
});

// GET /api/flash-sales/:id/items - Get flash sale items (variant-based from SQL product_variants)
app.get('/api/flash-sales/:id/items', injectPoolForAdmin, async (req, res) => {
    try {
        console.log('📦 [NEW API] Getting flash sale items for:', req.params.id);
        
        // Get flash sale items from SQL
        const items = await DataModel.SQL.FlashSaleItem.findByFlashSaleId(req.params.id);
        
        console.log('📊 Found items from SQL:', items?.length || 0);
        console.log('🔍 Enriching items with product variant data...', items);
        
        if (!items || items.length === 0) {
            return res.json([]);
        }

        // Enrich items with product_variants data - Sử dụng connection pool từ middleware
        const enrichedItems = await Promise.all(items.map(async (item) => {
            try {
                const request = new sql.Request(req.dbPool);
                const variantResult = await request
                    .input('variantId', sql.UniqueIdentifier, item.san_pham_id)
                    .query(`
                        SELECT 
                            pv.id,
                            pv.san_pham_id,
                            pv.ma_sku,
                            p.ten_san_pham,
                            pv.ten_hien_thi,
                            pv.gia_niem_yet,
                            pv.gia_ban,
                            pv.so_luong_ton_kho,
                            pv.anh_dai_dien,
                            pv.site_origin,
                            pv.trang_thai
                        FROM product_variants pv
                        LEFT JOIN products p ON pv.san_pham_id = p.id
                        WHERE pv.id = @variantId
                    `);
                
                const variant = variantResult.recordset[0];
                
                if (!variant) {
                    console.warn('⚠️ Variant not found for ID:', item.san_pham_id);
                    return null;
                }

                
                
                return {
                    id: item.id,
                    variant_id: item.san_pham_id,
                    san_pham_id: variant.san_pham_id,
                    ten_san_pham: variant.ten_san_pham || 'N/A',
                    variant_name: variant.ten_hien_thi,
                    ten_hien_thi: variant.ten_hien_thi,
                    ma_sku: variant.ma_sku,
                    gia_goc: item.gia_goc,
                    gia_flash_sale: item.gia_flash_sale,
                    gioi_han_mua: item.gioi_han_mua,
                    so_luong_ton: item.so_luong_ton,
                    da_ban: item.da_ban,
                    thu_tu: item.thu_tu,
                    trang_thai: item.trang_thai,
                    link_avatar: variant.anh_dai_dien || '/image/default-product.png',
                    anh_dai_dien: variant.anh_dai_dien || '/image/default-product.png',
                    site_origin: variant.site_origin
                };
            } catch (err) {
                console.error('Error enriching flash sale item:', err);
                return null;
            }
        }));
        
        const validItems = enrichedItems.filter(item => item !== null);
        console.log('✅ Enriched items:', validItems.length);
        res.json(validItems);
    } catch (error) {
        console.error('❌ Flash Sale Items GET Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy sản phẩm flash sale: ' + error.message });
    }
});

// POST /api/flash-sales - Create new flash sale with variants
app.post('/api/flash-sales', async (req, res) => {
    try {
        const { ten_flash_sale, mo_ta, ngay_bat_dau, ngay_ket_thuc, vung_id, trang_thai, variants } = req.body;
        
        console.log('📝 Creating flash sale:', { ten_flash_sale, vung_id, trang_thai, variantsCount: variants?.length });
        console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
        
        // Validation
        if (!ten_flash_sale) {
            return res.status(400).json({ success: false, message: 'Thiếu tên flash sale' });
        }
        if (!ngay_bat_dau || !ngay_ket_thuc) {
            return res.status(400).json({ success: false, message: 'Thiếu ngày bắt đầu hoặc ngày kết thúc' });
        }
        if (!variants || variants.length === 0) {
            return res.status(400).json({ success: false, message: 'Cần ít nhất 1 variant' });
        }
        
        // Create flash sale
        const flashSaleData = {
            ten_flash_sale,
            mo_ta,
            ngay_bat_dau,
            ngay_ket_thuc,
            vung_id: vung_id || null,
            trang_thai: trang_thai || 'cho',
            nguoi_tao: req.session?.user?.id || null
        };
        
        console.log('🔨 Creating flash sale with data:', flashSaleData);
        const flashSale = await DataModel.SQL.FlashSale.create(flashSaleData);
        console.log('✅ Flash sale created:', flashSale.id);
        
        // Add variants to flash_sale_items
        if (variants && variants.length > 0) {
            for (const variant of variants) {
                console.log('➕ Adding variant:', variant.variantId);
                await DataModel.SQL.FlashSaleItem.create({
                    flash_sale_id: flashSale.id,
                    variant_id: variant.variantId,
                    gia_goc: variant.gia_goc,
                    gia_flash_sale: variant.gia_flash_sale,
                    so_luong_ton: variant.so_luong_ton || 0,
                    da_ban: 0,
                    gioi_han_mua: variant.gioi_han_mua || 1,
                    thu_tu: variant.thu_tu || 0,
                    trang_thai: 'dang_ban'
                });
            }
        }
        
        console.log('✅ Flash sale created with', variants?.length || 0, 'variants');
        res.json({ success: true, data: flashSale });
    } catch (error) {
        console.error('❌ Flash Sale POST Error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi tạo flash sale: ' + error.message,
            error: error.toString(),
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// PUT /api/flash-sales/:id - Update flash sale
app.put('/api/flash-sales/:id', async (req, res) => {
    try {
        const { ten_flash_sale, mo_ta, ngay_bat_dau, ngay_ket_thuc, vung_id, trang_thai, variants } = req.body;
        
        console.log('📝 Updating flash sale:', req.params.id);
        
        // Update flash sale
        const flashSaleData = {
            ten_flash_sale,
            mo_ta,
            ngay_bat_dau,
            ngay_ket_thuc,
            vung_id,
            trang_thai
        };
        
        const flashSale = await DataModel.SQL.FlashSale.update(req.params.id, flashSaleData);
        
        // Update variants - smart update (delete/update/insert only what changed)
        if (variants) {
            // Lấy danh sách items hiện tại
            const currentItems = await DataModel.SQL.FlashSaleItem.findByFlashSaleId(req.params.id);
            const currentItemIds = currentItems.map(item => item.id);
            
            // 1. Xóa những item không còn trong danh sách mới
            const itemsToDelete = currentItems.filter(item => 
                !variants.some(v => v.id === item.id)
            );
            for (const item of itemsToDelete) {
                await DataModel.SQL.FlashSaleItem.destroy(item.id);
                console.log('🗑️ Deleted item:', item.id);
            }
            
            // 2. Cập nhật hoặc thêm mới
            for (const variant of variants) {
                const itemData = {
                    flash_sale_id: req.params.id,
                    variant_id: variant.variantId,
                    gia_goc: variant.gia_goc,
                    gia_flash_sale: variant.gia_flash_sale,
                    so_luong_ton: variant.so_luong_ton || 0,
                    gioi_han_mua: variant.gioi_han_mua || 1,
                    thu_tu: variant.thu_tu || 0,
                    trang_thai: variant.trang_thai || 'dang_ban'
                };
                
                if (variant.id && currentItemIds.includes(variant.id)) {
                    // Cập nhật item đã tồn tại
                    await DataModel.SQL.FlashSaleItem.update(variant.id, itemData);
                    console.log('📝 Updated item:', variant.id);
                } else {
                    // Thêm mới item
                    const newItem = await DataModel.SQL.FlashSaleItem.create(itemData);
                    console.log('➕ Created new item:', newItem.id);
                }
            }
        }
        
        console.log('✅ Flash sale updated');
        res.json({ success: true, data: flashSale });
    } catch (error) {
        console.error('❌ Flash Sale PUT Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi cập nhật flash sale: ' + error.message });
    }
});

// DELETE /api/flash-sales/:id - Delete flash sale
app.delete('/api/flash-sales/:id', async (req, res) => {
    try {
        console.log('🗑️ Deleting flash sale:', req.params.id);
        
        // Delete all items first
        await DataModel.SQL.FlashSaleItem.deleteByFlashSaleId(req.params.id);
        
        // Delete flash sale
        await DataModel.SQL.FlashSale.destroy(req.params.id);
        
        console.log('✅ Flash sale deleted');
        res.json({ success: true, message: 'Xóa flash sale thành công' });
    } catch (error) {
        console.error('❌ Flash Sale DELETE Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi xóa flash sale: ' + error.message });
    }
});

// GET /api/flashsales/:id - Get single flash sale (OLD API - kept for compatibility)
app.get('/api/flashsales/:id', async (req, res) => {
    try {
        console.log('🔍 Getting flash sale by ID:', req.params.id);
        const flashSale = await DataModel.SQL.FlashSale.findById(req.params.id);
        
        if (!flashSale) {
            console.log('❌ Flash sale not found:', req.params.id);
            return res.status(404).json({ success: false, message: 'Không tìm thấy flash sale' });
        }
        
        console.log('✅ Flash sale found:', flashSale);
        res.json({ success: true, data: flashSale });
    } catch (error) {
        console.error('❌ Flash Sale GET Error:', error);
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy flash sale: ' + error.message });
    }
});

// GET /api/flashsales/:id/items - Get flash sale items with full product details
app.get('/api/flashsales/:id/items', async (req, res) => {
    try {
        console.log('📦 Getting flash sale items for:', req.params.id);
        
        // Get flash sale items from SQL
        const items = await DataModel.SQL.FlashSaleItem.findByFlashSaleId(req.params.id);
        
        console.log('📊 Found items from SQL:', items?.length || 0, items);
        
        if (!items || items.length === 0) {
            return res.json([]);
        }

        // Enrich items with variant name from MongoDB
        const enrichedItems = await Promise.all(items.map(async (item) => {
            try {
                // san_pham_id in flash_sale_items stores variant_id from MongoDB
                const variantIdFromSQL = item.san_pham_id;
                
                console.log('🔍 Looking for variant ID:', variantIdFromSQL);
                
                // Find ALL products and search for variant (for debugging)
                const allProducts = await DataModel.Mongo.ProductDetail.find({}).lean();
                
                let foundDoc = null;
                let foundVariant = null;
                
                for (const doc of allProducts) {
                    const combinations = doc.variants?.variant_combinations || [];
                    const variant = combinations.find(v => 
                        v.variant_id && v.variant_id.toLowerCase() === variantIdFromSQL.toLowerCase()
                    );
                    
                    if (variant) {
                        foundDoc = doc;
                        foundVariant = variant;
                        break;
                    }
                }
                
                if (!foundDoc || !foundVariant) {
                    console.warn('❌ Variant not found:', variantIdFromSQL);
                    // Log first product's variants for debugging
                    if (allProducts.length > 0 && allProducts[0].variants?.variant_combinations) {
                        console.log('📋 Sample variants from first product:');
                        allProducts[0].variants.variant_combinations.slice(0, 2).forEach(v => {
                            console.log('  - variant_id:', v.variant_id, '| name:', v.name);
                        });
                    }
                    return {
                        ...item,
                        ten_san_pham: 'Variant không tồn tại',
                        variant_id: variantIdFromSQL,
                        variant_name: 'Không tìm thấy',
                        sql_product_id: null,
                        link_avatar: '/image/default-product.png'
                    };
                }
                
                // Get product name from SQL
                const product = await DataModel.SQL.Product.findById(foundDoc.sql_product_id);
                const productName = product?.ten_san_pham || 'Sản phẩm không tồn tại';
                
                console.log('✅ Found variant:', foundVariant.name, 'in product:', productName);

                return {
                    ...item,
                    ten_san_pham: productName,
                    variant_id: variantIdFromSQL,
                    variant_name: foundVariant.name,
                    sql_product_id: foundDoc.sql_product_id,
                    link_avatar: foundDoc.link_avatar || '/image/default-product.png'
                };
            } catch (err) {
                console.error('❌ Error enriching item:', item.id);
                console.error('Error message:', err.message);
                console.error('Error stack:', err.stack);
                return {
                    ...item,
                    ten_san_pham: 'Lỗi: ' + err.message,
                    variant_id: item.san_pham_id,
                    variant_name: 'Lỗi',
                    link_avatar: '/image/default-product.png'
                };
            }
        }));

        console.log('✅ Returning enriched items:', enrichedItems.length);
        res.json(enrichedItems);
    } catch (error) {
        console.error('❌ Flash Sale Items GET Error:', error);
        console.error('Error details:', error.message);
        console.error('Stack:', error.stack);
        res.status(500).json({ success: false, message: 'Lỗi khi lấy sản phẩm flash sale: ' + error.message });
    }
});

// POST /api/flashsales - Create flash sale
app.post('/api/flashsales', async (req, res) => {
    try {
        const flashSaleData = {
            ...req.body,
            nguoi_tao: req.session?.user?.id || null
        };
        const flashSale = await DataModel.SQL.FlashSale.create(flashSaleData);
        res.json({ success: true, data: flashSale });
    } catch (error) {
        console.error('Flash Sale POST Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi tạo flash sale' });
    }
});

// POST /api/flashsales/:id/items - Add item to flash sale
app.post('/api/flashsales/:id/items', async (req, res) => {
    try {
        const itemData = {
            ...req.body,
            flash_sale_id: req.params.id
        };
        const item = await DataModel.SQL.FlashSaleItem.create(itemData);
        res.json({ success: true, data: item });
    } catch (error) {
        console.error('Flash Sale Item POST Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi thêm sản phẩm flash sale' });
    }
});

// PUT /api/flashsales/:id - Update flash sale
app.put('/api/flashsales/:id', async (req, res) => {
    try {
        const flashSale = await DataModel.SQL.FlashSale.update(req.params.id, req.body);
        res.json({ success: true, data: flashSale });
    } catch (error) {
        console.error('Flash Sale PUT Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi cập nhật flash sale' });
    }
});

// DELETE /api/flashsales/:id - Delete flash sale
app.delete('/api/flashsales/:id', async (req, res) => {
    try {
        await DataModel.SQL.FlashSale.destroy(req.params.id);
        res.json({ success: true, message: 'Xóa flash sale thành công' });
    } catch (error) {
        console.error('Flash Sale DELETE Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi xóa flash sale' });
    }
});

// DELETE /api/flashsales/:flashSaleId/items/:itemId - Delete flash sale item
app.delete('/api/flashsales/:flashSaleId/items/:itemId', async (req, res) => {
    try {
        await DataModel.SQL.FlashSaleItem.destroy(req.params.itemId);
        res.json({ success: true, message: 'Xóa sản phẩm thành công' });
    } catch (error) {
        console.error('Flash Sale Item DELETE Error:', error);
        res.status(500).json({ success: false, message: 'Lỗi khi xóa sản phẩm' });
    }
});

// API ENDPOINTS FOR MONGODB PRODUCT DETAILS

// GET /api/mongodb-details/by-product/:productId - Get MongoDB details by SQL product ID
app.get('/api/mongodb-details/by-product/:productId', async (req, res) => {
    try {
        const { productId } = req.params;
        console.log('🔍 Fetching MongoDB details for product:', productId);
        
        // Find MongoDB document by sql_product_id field
        const mongoDetail = await DataModel.Mongo.ProductDetail.findOne({ 
            sql_product_id: productId 
        }).lean();
        
        if (!mongoDetail) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy thông tin MongoDB cho sản phẩm này'
            });
        }
        
        console.log('✅ Found MongoDB detail:', mongoDetail._id);
        
        res.json({
            success: true,
            data: mongoDetail,
            // Expose commonly used fields - variant_combinations nằm trong variants
            variant_combinations: mongoDetail.variants?.variant_combinations || [],
            variant_options: mongoDetail.variants?.variant_options || [],
            thong_so_ky_thuat: mongoDetail.thong_so_ky_thuat || [],
            hinh_anh: mongoDetail.hinh_anh || []
        });
    } catch (error) {
        console.error('MongoDB Details GET Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy thông tin MongoDB: ' + error.message 
        });
    }
});

// GET /api/mongodb-details/:mongoId - Get MongoDB details by MongoDB _id
app.get('/api/mongodb-details/:mongoId', async (req, res) => {
    try {
        const { mongoId } = req.params;
        console.log('🔍 Fetching MongoDB details by _id:', mongoId);
        
        // Use findOne with _id instead of findById
        const mongoDetail = await DataModel.Mongo.ProductDetail.findOne({ 
            _id: mongoId 
        }).lean();
        
        if (!mongoDetail) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy thông tin MongoDB'
            });
        }
        
        console.log('✅ Found MongoDB detail by _id:', mongoDetail._id);
        
        res.json({
            success: true,
            data: mongoDetail,
            // variant_combinations nằm trong variants
            variant_combinations: mongoDetail.variants?.variant_combinations || [],
            variant_options: mongoDetail.variants?.variant_options || [],
            thong_so_ky_thuat: mongoDetail.thong_so_ky_thuat || [],
            hinh_anh: mongoDetail.hinh_anh || []
        });
    } catch (error) {
        console.error('MongoDB Details GET Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy thông tin MongoDB: ' + error.message 
        });
    }
});

// API ENDPOINTS FOR WAREHOUSES

// GET /api/warehouses - Get all warehouses
app.get('/api/warehouses', injectPoolForAdmin, async (req, res) => {
    try {
        console.log('🔄 API /api/warehouses called');
        
        const warehouses = await DataModel.SQL.Warehouse.findAll(req.dbPool);

        res.json({ 
            success: true, 
            data: { warehouses } 
        });
        
    } catch (error) {
        console.error('Warehouse GET Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy danh sách kho' 
        });
    }
});

// GET /api/warehouses/:id - Get single warehouse
app.get('/api/warehouses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const warehouse = await DataModel.SQL.Warehouse.findById(id);
        
        if (!warehouse) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy kho' 
            });
        }

        res.json({ 
            success: true, 
            data: warehouse 
        });
    } catch (error) {
        console.error('Warehouse GET by ID Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi lấy thông tin kho' 
        });
    }
});

// POST /api/warehouses - Create new warehouse
app.post('/api/warehouses', async (req, res) => {
    try {
        const warehouseData = req.body;
        
        console.log('📥 Creating warehouse:', warehouseData);

        // Validate required fields
        if (!warehouseData.ten_kho || !warehouseData.vung_id || !warehouseData.phuong_xa_id || !warehouseData.so_dien_thoai || !warehouseData.dia_chi_chi_tiet) {
            return res.status(400).json({ 
                success: false, 
                message: 'Thiếu thông tin bắt buộc (tên kho, vùng miền, phường/xã, số điện thoại, địa chỉ)' 
            });
        }

        const newWarehouse = await DataModel.SQL.Warehouse.create(warehouseData);

        console.log('✅ Warehouse created:', newWarehouse.id);

        res.status(201).json({ 
            success: true, 
            message: 'Thêm kho thành công', 
            data: newWarehouse 
        });
    } catch (error) {
        console.error('Warehouse CREATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi thêm kho: ' + error.message 
        });
    }
});

// PUT /api/warehouses/:id - Update warehouse
app.put('/api/warehouses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const warehouseData = req.body;
        
        console.log('📝 Updating warehouse:', id, warehouseData);

        const existingWarehouse = await DataModel.SQL.Warehouse.findById(id);
        if (!existingWarehouse) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy kho' 
            });
        }

        const updatedWarehouse = await DataModel.SQL.Warehouse.update(id, warehouseData);

        console.log('✅ Warehouse updated:', id);

        res.json({ 
            success: true, 
            message: 'Cập nhật kho thành công', 
            data: updatedWarehouse 
        });
    } catch (error) {
        console.error('Warehouse UPDATE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi cập nhật kho: ' + error.message 
        });
    }
});

// DELETE /api/warehouses/:id - Delete warehouse
app.delete('/api/warehouses/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        console.log('🗑️ Deleting warehouse:', id);

        const existingWarehouse = await DataModel.SQL.Warehouse.findById(id);
        if (!existingWarehouse) {
            return res.status(404).json({ 
                success: false, 
                message: 'Không tìm thấy kho' 
            });
        }

        // Check if warehouse has inventory items
        const inventoryCount = await DataModel.SQL.Inventory.countByWarehouse(id);
        if (inventoryCount > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Không thể xóa kho đang có tồn kho sản phẩm' 
            });
        }

        await DataModel.SQL.Warehouse.delete(id);

        console.log('✅ Warehouse deleted:', id);

        res.json({ 
            success: true, 
            message: 'Xóa kho thành công' 
        });
    } catch (error) {
        console.error('Warehouse DELETE Error:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Lỗi khi xóa kho' 
        });
    }
});

// =============================================
// VOUCHER API ROUTES
// =============================================

// GET /admin/voucher - Render voucher management page
app.get('/admin/voucher', requireAdmin, async (req, res) => {
    try {
        // Fetch regions from database using admin's pool
        const pool = req.dbPool;
        const regionsResult = await pool.request()
            .query('SELECT ma_vung, ten_vung FROM regions WHERE trang_thai = 1 ORDER BY ten_vung');
        
        res.render('voucher', {
            layout: 'AdminMain',
            title: 'Quản lý Voucher',
            regions: regionsResult.recordset
        });
    } catch (error) {
        console.error('Error rendering voucher page:', error);
        res.status(500).send('Internal Server Error');
    }
});

// GET /api/vouchers - Lấy danh sách vouchers
app.get('/api/vouchers', injectPoolForAdmin, async (req, res) => {
    try {
        const { page = 1, limit = 10, trang_thai, loai_giam_gia, pham_vi, search } = req.query;
        
        let queryString = `
            SELECT 
                v.*,
                r.ten_vung,
                u.ho_ten as ten_nguoi_tao,
                (v.so_luong - ISNULL(v.da_su_dung, 0)) as so_luong_con_lai
            FROM vouchers v
            LEFT JOIN regions r ON v.vung_id = r.ma_vung
            LEFT JOIN users u ON v.nguoi_tao = u.id
            WHERE 1=1
        `;
        
        const request = new sql.Request(req.dbPool);
        
        // Filter by status
        if (trang_thai === 'active') {
            queryString += ` AND v.trang_thai = 1 AND v.ngay_bat_dau <= GETDATE() AND v.ngay_ket_thuc >= GETDATE()`;
        } else if (trang_thai === 'inactive') {
            queryString += ` AND (v.trang_thai = 0 OR v.ngay_bat_dau > GETDATE())`;
        } else if (trang_thai === 'expired') {
            queryString += ` AND v.ngay_ket_thuc < GETDATE()`;
        }
        
        // Filter by discount type
        if (loai_giam_gia) {
            queryString += ` AND v.loai_giam_gia = @loai_giam_gia`;
            request.input('loai_giam_gia', sql.NVarChar(20), loai_giam_gia);
        }
        
        // Filter by scope
        if (pham_vi) {
            queryString += ` AND v.pham_vi = @pham_vi`;
            request.input('pham_vi', sql.NVarChar(20), pham_vi);
        }
        
        // Search by code or name
        if (search) {
            queryString += ` AND (v.ma_voucher LIKE @search OR v.ten_voucher LIKE @search)`;
            request.input('search', sql.NVarChar(255), `%${search}%`);
        }
        
        queryString += ` ORDER BY v.ngay_tao DESC`;
        
        const result = await request.query(queryString);
        const vouchers = result.recordset;
        
        // Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = page * limit;
        const paginatedData = vouchers.slice(startIndex, endIndex);
        
        res.json({
            success: true,
            vouchers: paginatedData,
            currentPage: parseInt(page),
            totalPages: Math.ceil(vouchers.length / limit),
            total: vouchers.length
        });
    } catch (error) {
        console.error('Vouchers API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách voucher: ' + error.message
        });
    }
});

// GET /api/vouchers/:id - Lấy thông tin voucher
app.get('/api/vouchers/:id', async (req, res) => {
    try {
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('id', sql.UniqueIdentifier, req.params.id)
            .query(`
                SELECT 
                    v.*,
                    r.ten_vung,
                    u.ho_ten as ten_nguoi_tao,
                    (v.so_luong - ISNULL(v.da_su_dung, 0)) as so_luong_con_lai
                FROM vouchers v
                LEFT JOIN regions r ON v.vung_id = r.ma_vung
                LEFT JOIN users u ON v.nguoi_tao = u.id
                WHERE v.id = @id
            `);
        
        const voucher = result.recordset[0];
        
        if (!voucher) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy voucher'
            });
        }
        
        res.json({
            success: true,
            voucher: voucher
        });
    } catch (error) {
        console.error('Voucher API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin voucher: ' + error.message
        });
    }
});

// GET /api/vouchers/:id/products - Lấy danh sách sản phẩm của voucher
app.get('/api/vouchers/:id/products', async (req, res) => {
    try {
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('voucher_id', sql.UniqueIdentifier, req.params.id)
            .query(`
                SELECT 
                    vp.voucher_id,
                    vp.san_pham_id,
                    pv.ten_hien_thi,
                    pv.gia_ban,
                    pv.anh_dai_dien,
                    pv.so_luong_ton_kho,
                    pv.ma_sku,
                    pv.san_pham_id as product_id,
                    p.ten_san_pham,
                    p.mongo_detail_id
                FROM voucher_products vp
                INNER JOIN product_variants pv ON vp.san_pham_id = pv.id
                LEFT JOIN products p ON pv.san_pham_id = p.id
                WHERE vp.voucher_id = @voucher_id
            `);
        
        console.log('📦 Voucher products query result:', result.recordset.length, 'rows');
        
        // Get MongoDB details for each variant to get full variant info
        const productsWithVariants = [];
        
        for (const item of result.recordset) {
            try {
                let variantInfo = null;
                
                // Try to get MongoDB details if mongo_detail_id exists
                if (item.mongo_detail_id) {
                    const mongoDetail = await DataModel.Mongo.ProductDetail.findById(item.mongo_detail_id);
                    
                    if (mongoDetail && mongoDetail.variants && mongoDetail.variants.variant_combinations) {
                        // Find the specific variant by variant_id (product_variants.id)
                        const variant = mongoDetail.variants.variant_combinations.find(
                            v => v.variant_id === item.san_pham_id
                        );
                        
                        if (variant) {
                            variantInfo = {
                                variant_id: variant.variant_id,
                                attributes: variant.attributes || {},
                                gia_ban: variant.gia_ban || item.gia_ban,
                                so_luong: variant.so_luong || item.so_luong_ton_kho || 0
                            };
                        }
                    }
                }
                
                // If no MongoDB variant info, use SQL data
                if (!variantInfo) {
                    variantInfo = {
                        variant_id: item.san_pham_id,
                        attributes: {},
                        gia_ban: item.gia_ban || 0,
                        so_luong: item.so_luong_ton_kho || 0
                    };
                }
                
                productsWithVariants.push({
                    voucher_id: item.voucher_id,
                    san_pham_id: item.san_pham_id,  // product_variants.id
                    product_id: item.product_id,     // products.id
                    ten_san_pham: item.ten_san_pham || item.ten_hien_thi,  // Lấy từ products hoặc variants
                    ten_hien_thi: item.ten_hien_thi,
                    ma_sku: item.ma_sku,
                    gia_ban: item.gia_ban,
                    link_anh: item.anh_dai_dien,
                    variant_info: variantInfo
                });
                
            } catch (err) {
                console.error('Error getting variant info for item:', item.san_pham_id, err);
                // Fallback to basic info
                productsWithVariants.push({
                    voucher_id: item.voucher_id,
                    san_pham_id: item.san_pham_id,
                    product_id: item.product_id,
                    ten_san_pham: item.ten_san_pham || item.ten_hien_thi,
                    ten_hien_thi: item.ten_hien_thi,
                    ma_sku: item.ma_sku,
                    gia_ban: item.gia_ban,
                    link_anh: item.anh_dai_dien,
                    variant_info: {
                        variant_id: item.san_pham_id,
                        attributes: {},
                        gia_ban: item.gia_ban || 0,
                        so_luong: item.so_luong_ton_kho || 0
                    }
                });
            }
        }
        
        console.log('✅ Returning', productsWithVariants.length, 'products with variant info');
        
        res.json({
            success: true,
            products: productsWithVariants
        });
    } catch (error) {
        console.error('❌ Voucher Products API Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy sản phẩm voucher: ' + error.message
        });
    }
});

// POST /api/vouchers - Tạo voucher mới
app.post('/api/vouchers', async (req, res) => {
    try {
        console.log('📝 Creating new voucher...', req.body);
        
        const voucherData = {
            ma_voucher: req.body.ma_voucher,
            ten_voucher: req.body.ten_voucher,
            mo_ta: req.body.mo_ta || null,
            loai_giam_gia: req.body.loai_giam_gia,
            gia_tri_giam: parseFloat(req.body.gia_tri_giam),
            gia_tri_toi_da: req.body.gia_tri_toi_da ? parseFloat(req.body.gia_tri_toi_da) : null,
            don_hang_toi_thieu: parseFloat(req.body.don_hang_toi_thieu) || 0,
            so_luong: parseInt(req.body.so_luong),
            da_su_dung: 0, // Khởi tạo = 0
            ngay_bat_dau: req.body.ngay_bat_dau,
            ngay_ket_thuc: req.body.ngay_ket_thuc,
            pham_vi: req.body.pham_vi || 'toan_cuc',
            loai_voucher: req.body.loai_voucher || null,
            vung_id: req.body.vung_id || 'bac', // Mặc định Bắc nếu không có
            trang_thai: req.body.trang_thai ? 1 : 0,
            nguoi_tao: req.body.nguoi_tao || req.session?.user?.id
        };
        
        // Validate required fields
        if (!voucherData.nguoi_tao) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin người tạo voucher (nguoi_tao)'
            });
        }
        
        if (voucherData.loai_giam_gia === 'phantram' && voucherData.gia_tri_giam > 100) {
            return res.status(400).json({
                success: false,
                message: 'Giá trị giảm theo phần trăm không được vượt quá 100%'
            });
        }
        
        if (new Date(voucherData.ngay_bat_dau) >= new Date(voucherData.ngay_ket_thuc)) {
            return res.status(400).json({
                success: false,
                message: 'Ngày bắt đầu phải nhỏ hơn ngày kết thúc'
            });
        }
        
        // Bước 1: Tạo voucher trong SQL
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('ma_voucher', sql.NVarChar(50), voucherData.ma_voucher)
            .input('ten_voucher', sql.NVarChar(255), voucherData.ten_voucher)
            .input('mo_ta', sql.NVarChar(500), voucherData.mo_ta)
            .input('loai_giam_gia', sql.NVarChar(20), voucherData.loai_giam_gia)
            .input('gia_tri_giam', sql.Decimal(15, 2), voucherData.gia_tri_giam)
            .input('gia_tri_toi_da', sql.Decimal(15, 2), voucherData.gia_tri_toi_da)
            .input('don_hang_toi_thieu', sql.Decimal(15, 2), voucherData.don_hang_toi_thieu)
            .input('so_luong', sql.Int, voucherData.so_luong)
            .input('da_su_dung', sql.Int, voucherData.da_su_dung)
            .input('ngay_bat_dau', sql.DateTime2, voucherData.ngay_bat_dau)
            .input('ngay_ket_thuc', sql.DateTime2, voucherData.ngay_ket_thuc)
            .input('pham_vi', sql.NVarChar(20), voucherData.pham_vi)
            .input('loai_voucher', sql.NVarChar(50), voucherData.loai_voucher)
            .input('vung_id', sql.NVarChar(10), voucherData.vung_id)
            .input('trang_thai', sql.Bit, voucherData.trang_thai)
            .input('nguoi_tao', sql.UniqueIdentifier, voucherData.nguoi_tao)
            .query(`
                INSERT INTO vouchers 
                (ma_voucher, ten_voucher, mo_ta, loai_giam_gia, gia_tri_giam, gia_tri_toi_da, 
                 don_hang_toi_thieu, so_luong, da_su_dung, ngay_bat_dau, ngay_ket_thuc, pham_vi, 
                 loai_voucher, vung_id, trang_thai, nguoi_tao)
                VALUES 
                (@ma_voucher, @ten_voucher, @mo_ta, @loai_giam_gia, @gia_tri_giam, @gia_tri_toi_da, 
                 @don_hang_toi_thieu, @so_luong, @da_su_dung, @ngay_bat_dau, @ngay_ket_thuc, @pham_vi, 
                 @loai_voucher, @vung_id, @trang_thai, @nguoi_tao)
            `);
        
        const selectResult = await request.query(`SELECT TOP 1 * FROM vouchers WHERE ma_voucher = @ma_voucher ORDER BY ngay_tao DESC`);
        const newVoucher = selectResult.recordset[0];
        console.log('✅ SQL created with ID:', newVoucher.id);
        
        // Bước 2: Tạo MongoDB document với _id = SQL voucher id (nếu cần mở rộng)
        const mongoData = {
            usage_history: [],
            user_restrictions: {
                eligible_user_groups: ['all'],
                excluded_users: [],
                max_uses_per_user: 1
            },
            combination_rules: {
                can_combine_with_other_vouchers: false,
                can_combine_with_flash_sale: true,
                priority: 0
            },
            analytics: {
                total_views: 0,
                total_uses: 0,
                total_revenue_impact: 0,
                conversion_rate: 0
            },
            notification_settings: {
                notify_when_near_expiry: true,
                days_before_expiry: 3,
                notify_when_limited_stock: true,
                stock_threshold: 10
            },
            tags: [],
            notes: ''
        };
        
        const mongoDoc = await DataModel.Mongo.VoucherDetail.createOrUpdate(newVoucher.id, mongoData);
        console.log('✅ MongoDB created with _id:', mongoDoc._id);
        
        // Bước 3: Update SQL để lưu mongo_voucher_detail_id
        const updateRequest = new sql.Request(db.connectionPools.default);
        await updateRequest
            .input('id', sql.UniqueIdentifier, newVoucher.id)
            .input('mongo_voucher_detail_id', sql.NVarChar(50), mongoDoc._id.toString())
            .query('UPDATE vouchers SET mongo_voucher_detail_id = @mongo_voucher_detail_id WHERE id = @id');
        console.log('✅ SQL updated with mongo_voucher_detail_id');

        // Bước 4: Thêm voucher_products nếu có products và pham_vi = 'theo_san_pham'
        if (voucherData.pham_vi === 'theo_san_pham' && req.body.products && Array.isArray(req.body.products) && req.body.products.length > 0) {
            console.log('📦 Adding voucher products...', req.body.products.length, 'variants');
            
            for (const product of req.body.products) {
                console.log('📝 Inserting product:', product);
                
                // Validate variantId (FK to product_variants table)
                if (!product.variantId) {
                    console.error('❌ Missing variantId for product:', product);
                    throw new Error(`Product "${product.productName}" thiếu variant_id`);
                }
                
                const insertRequest = new sql.Request(db.connectionPools.default);
                await insertRequest
                    .input('voucher_id', sql.UniqueIdentifier, newVoucher.id)
                    .input('san_pham_id', sql.UniqueIdentifier, product.variantId)
                    .query(`
                        INSERT INTO voucher_products 
                        (voucher_id, san_pham_id)
                        VALUES 
                        (@voucher_id, @san_pham_id)
                    `);
            }
            
            console.log('✅ Voucher products added successfully');
        }
        
        res.json({
            success: true,
            message: 'Tạo voucher thành công',
            voucher: newVoucher
        });
    } catch (error) {
        console.error('❌ Create Voucher Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo voucher: ' + error.message
        });
    }
});

// PUT /api/vouchers/:id - Cập nhật voucher
app.put('/api/vouchers/:id', async (req, res) => {
    try {
        console.log('📝 Updating voucher...', req.params.id, req.body);
        
        const voucherData = {
            ma_voucher: req.body.ma_voucher,
            ten_voucher: req.body.ten_voucher,
            mo_ta: req.body.mo_ta || null,
            loai_giam_gia: req.body.loai_giam_gia,
            gia_tri_giam: parseFloat(req.body.gia_tri_giam),
            gia_tri_toi_da: req.body.gia_tri_toi_da ? parseFloat(req.body.gia_tri_toi_da) : null,
            don_hang_toi_thieu: parseFloat(req.body.don_hang_toi_thieu) || 0,
            so_luong: parseInt(req.body.so_luong),
            ngay_bat_dau: req.body.ngay_bat_dau,
            ngay_ket_thuc: req.body.ngay_ket_thuc,
            pham_vi: req.body.pham_vi || 'toan_cuc',
            loai_voucher: req.body.loai_voucher || null,
            vung_id: req.body.vung_id || 'bac',
            trang_thai: req.body.trang_thai ? 1 : 0
        };
        
        // Validate
        if (voucherData.loai_giam_gia === 'phantram' && voucherData.gia_tri_giam > 100) {
            return res.status(400).json({
                success: false,
                message: 'Giá trị giảm theo phần trăm không được vượt quá 100%'
            });
        }
        
        if (new Date(voucherData.ngay_bat_dau) >= new Date(voucherData.ngay_ket_thuc)) {
            return res.status(400).json({
                success: false,
                message: 'Ngày bắt đầu phải nhỏ hơn ngày kết thúc'
            });
        }
        
        // Update voucher basic info
        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('id', sql.UniqueIdentifier, req.params.id)
            .input('ma_voucher', sql.NVarChar(50), voucherData.ma_voucher)
            .input('ten_voucher', sql.NVarChar(255), voucherData.ten_voucher)
            .input('mo_ta', sql.NVarChar(500), voucherData.mo_ta)
            .input('loai_giam_gia', sql.NVarChar(20), voucherData.loai_giam_gia)
            .input('gia_tri_giam', sql.Decimal(15, 2), voucherData.gia_tri_giam)
            .input('gia_tri_toi_da', sql.Decimal(15, 2), voucherData.gia_tri_toi_da)
            .input('don_hang_toi_thieu', sql.Decimal(15, 2), voucherData.don_hang_toi_thieu)
            .input('so_luong', sql.Int, voucherData.so_luong)
            .input('ngay_bat_dau', sql.DateTime2, voucherData.ngay_bat_dau)
            .input('ngay_ket_thuc', sql.DateTime2, voucherData.ngay_ket_thuc)
            .input('pham_vi', sql.NVarChar(20), voucherData.pham_vi)
            .input('loai_voucher', sql.NVarChar(50), voucherData.loai_voucher)
            .input('trang_thai', sql.Bit, voucherData.trang_thai)
            .query(`
                UPDATE vouchers 
                SET ma_voucher = @ma_voucher,
                    ten_voucher = @ten_voucher,
                    mo_ta = @mo_ta,
                    loai_giam_gia = @loai_giam_gia,
                    gia_tri_giam = @gia_tri_giam,
                    gia_tri_toi_da = @gia_tri_toi_da,
                    don_hang_toi_thieu = @don_hang_toi_thieu,
                    so_luong = @so_luong,
                    ngay_bat_dau = @ngay_bat_dau,
                    ngay_ket_thuc = @ngay_ket_thuc,
                    pham_vi = @pham_vi,
                    loai_voucher = @loai_voucher,
                    trang_thai = @trang_thai,
                    ngay_cap_nhat = GETDATE()
                WHERE id = @id
            `);
        
        const selectResult = await request.query(`SELECT * FROM vouchers WHERE id = @id`);
        const updatedVoucher = selectResult.recordset[0];
        
        if (!updatedVoucher) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy voucher'
            });
        }

        // Update voucher products if pham_vi = 'theo_san_pham' and products provided
        if (voucherData.pham_vi === 'theo_san_pham' && req.body.products && Array.isArray(req.body.products)) {
            console.log('📦 Updating voucher products...', req.body.products.length, 'variants');
            
            // Lấy vung_id từ voucher hiện tại trong DB (không cho phép update vung_id)
            const voucherVungId = updatedVoucher.vung_id;
            
            // Delete existing products
            const deleteRequest = new sql.Request(db.connectionPools.default);
            await deleteRequest
                .input('voucher_id', sql.UniqueIdentifier, req.params.id)
                .query('DELETE FROM voucher_products WHERE voucher_id = @voucher_id');

            // Insert new products
            for (const product of req.body.products) {
                console.log('📝 Inserting product:', product);
                
                // Validate variantId (FK to product_variants table)
                if (!product.variantId) {
                    console.error('❌ Missing variantId for product:', product);
                    throw new Error(`Product "${product.productName}" thiếu variant_id`);
                }
                
                // Verify variant exists and check site_origin matches voucher's vung_id
                const verifyRequest = new sql.Request(db.connectionPools.default);
                const variantCheck = await verifyRequest
                    .input('variant_id', sql.UniqueIdentifier, product.variantId)
                    .query(`SELECT id, site_origin FROM product_variants WHERE id = @variant_id`);
                
                if (variantCheck.recordset.length === 0) {
                    throw new Error(`Variant ID ${product.variantId} không tồn tại trong product_variants`);
                }
                
                const variant = variantCheck.recordset[0];
                console.log('✅ Variant verified:', variant);
                console.log('🔍 Voucher vung_id:', voucherVungId, '| Variant site_origin:', variant.site_origin);
                
                // Check if variant's site_origin matches voucher's vung_id (for merge replication)
                if (variant.site_origin !== voucherVungId) {
                    throw new Error(`Variant "${product.variantName}" thuộc vùng "${variant.site_origin}" không khớp với voucher vùng "${voucherVungId}". Merge replication không cho phép.`);
                }
                
                const insertRequest = new sql.Request(db.connectionPools.default);
                await insertRequest
                    .input('voucher_id', sql.UniqueIdentifier, req.params.id)
                    .input('san_pham_id', sql.UniqueIdentifier, product.variantId)
                    .query(`
                        INSERT INTO voucher_products 
                        (voucher_id, san_pham_id)
                        VALUES 
                        (@voucher_id, @san_pham_id)
                    `);
            }
            
            console.log('✅ Voucher products updated successfully');
        } else if (voucherData.pham_vi !== 'theo_san_pham') {
            // If pham_vi changed from 'theo_san_pham' to something else, clear products
            const deleteRequest = new sql.Request(db.connectionPools.default);
            await deleteRequest
                .input('voucher_id', sql.UniqueIdentifier, req.params.id)
                .query('DELETE FROM voucher_products WHERE voucher_id = @voucher_id');
        }
        
        res.json({
            success: true,
            message: 'Cập nhật voucher thành công',
            voucher: updatedVoucher
        });
    } catch (error) {
        console.error('❌ Update Voucher Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi cập nhật voucher: ' + error.message
        });
    }
});

// DELETE /api/vouchers/:id - Xóa voucher
app.delete('/api/vouchers/:id', async (req, res) => {
    try {
        console.log('🗑️ Deleting voucher:', req.params.id);
        
        // Get voucher info first
        const getRequest = new sql.Request(db.connectionPools.default);
        const getResult = await getRequest
            .input('id', sql.UniqueIdentifier, req.params.id)
            .query('SELECT mongo_voucher_detail_id FROM vouchers WHERE id = @id');
        
        if (getResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy voucher'
            });
        }
        
        const mongoDetailId = getResult.recordset[0].mongo_voucher_detail_id;
        
        // Delete voucher_products first (due to foreign key)
        const deleteProductsRequest = new sql.Request(db.connectionPools.default);
        await deleteProductsRequest
            .input('voucher_id', sql.UniqueIdentifier, req.params.id)
            .query('DELETE FROM voucher_products WHERE voucher_id = @voucher_id');
        
        // Delete from SQL
        const deleteRequest = new sql.Request(db.connectionPools.default);
        await deleteRequest
            .input('id', sql.UniqueIdentifier, req.params.id)
            .query('DELETE FROM vouchers WHERE id = @id');
        
        // Delete from MongoDB if exists
        if (mongoDetailId) {
            try {
                await DataModel.Mongo.VoucherDetail.deleteById(mongoDetailId);
                console.log('✅ MongoDB detail deleted');
            } catch (mongoErr) {
                console.error('⚠️ MongoDB delete error (non-critical):', mongoErr);
            }
        }
        
        console.log('✅ Voucher deleted successfully');
        
        res.json({
            success: true,
            message: 'Xóa voucher thành công'
        });
    } catch (error) {
        console.error('❌ Delete Voucher Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi xóa voucher: ' + error.message
        });
    }
});

// POST /api/vouchers/validate - Validate và apply voucher
app.post('/api/vouchers/validate', async (req, res) => {
    try {
        const { ma_voucher, userId, cartItems } = req.body;
        
        if (!ma_voucher || !userId || !cartItems || cartItems.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin cần thiết'
            });
        }
        
        // Tìm voucher
        const voucherRequest = new sql.Request(db.connectionPools.default);
        const voucherResult = await voucherRequest
            .input('ma_voucher', sql.NVarChar, ma_voucher)
            .query(`
                SELECT * FROM vouchers 
                WHERE ma_voucher = @ma_voucher 
                AND trang_thai = 1
            `);
        
        if (voucherResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Mã voucher không tồn tại hoặc đã bị vô hiệu hóa'
            });
        }
        
        const voucher = voucherResult.recordset[0];
        const now = new Date();
        const startDate = new Date(voucher.ngay_bat_dau);
        const endDate = new Date(voucher.ngay_ket_thuc);
        
        // Kiểm tra thời gian
        if (now < startDate) {
            return res.status(400).json({
                success: false,
                message: `Voucher chưa bắt đầu. Có hiệu lực từ ${startDate.toLocaleDateString('vi-VN')}`
            });
        }
        
        if (now > endDate) {
            return res.status(400).json({
                success: false,
                message: 'Voucher đã hết hạn sử dụng'
            });
        }
        
        // Kiểm tra số lượng
        if (voucher.da_su_dung >= voucher.so_luong) {
            return res.status(400).json({
                success: false,
                message: 'Voucher đã hết lượt sử dụng'
            });
        }
        
        // Kiểm tra user đã sử dụng voucher này chưa
        const usedRequest = new sql.Request(db.connectionPools.default);
        const usedResult = await usedRequest
            .input('voucher_id', sql.UniqueIdentifier, voucher.id)
            .input('user_id', sql.UniqueIdentifier, userId)
            .query(`
                SELECT * FROM used_vouchers 
                WHERE voucher_id = @voucher_id 
                AND nguoi_dung_id = @user_id
            `);
        
        if (usedResult.recordset.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'Bạn đã sử dụng voucher này rồi'
            });
        }
        
        // Tính tổng giá trị đơn hàng
        let subtotal = cartItems.reduce((sum, item) => sum + (item.gia_ban * item.so_luong), 0);
        
        // Kiểm tra đơn hàng tối thiểu
        if (subtotal < voucher.don_hang_toi_thieu) {
            return res.status(400).json({
                success: false,
                message: `Đơn hàng tối thiểu ${new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(voucher.don_hang_toi_thieu)} để sử dụng voucher này`
            });
        }
        
        // Kiểm tra phạm vi áp dụng
        if (voucher.pham_vi === 'theo_san_pham') {
            const productIdsRequest = new sql.Request(db.connectionPools.default);
            const productIdsResult = await productIdsRequest
                .input('voucher_id', sql.UniqueIdentifier, voucher.id)
                .query(`
                    SELECT san_pham_id FROM voucher_products 
                    WHERE voucher_id = @voucher_id
                `);
            
            const allowedProductIds = productIdsResult.recordset.map(p => p.san_pham_id);
            const cartProductIds = cartItems.map(item => item.san_pham_id);
            
            const hasValidProduct = cartProductIds.some(id => 
                allowedProductIds.some(allowedId => allowedId === id)
            );
            
            if (!hasValidProduct) {
                return res.status(400).json({
                    success: false,
                    message: 'Voucher này không áp dụng cho các sản phẩm trong giỏ hàng'
                });
            }
            
            // Tính tổng chỉ cho các sản phẩm được áp dụng
            subtotal = cartItems
                .filter(item => allowedProductIds.some(allowedId => allowedId === item.san_pham_id))
                .reduce((sum, item) => sum + (item.gia_ban * item.so_luong), 0);
        }
        
        // Tính giá trị giảm
        let discountAmount = 0;
        
        if (voucher.loai_giam_gia === 'phantram') {
            discountAmount = subtotal * (voucher.gia_tri_giam / 100);
            if (voucher.gia_tri_toi_da && discountAmount > voucher.gia_tri_toi_da) {
                discountAmount = voucher.gia_tri_toi_da;
            }
        } else if (voucher.loai_giam_gia === 'tiengiam') {
            discountAmount = voucher.gia_tri_giam;
            if (discountAmount > subtotal) {
                discountAmount = subtotal;
            }
        } else if (voucher.loai_giam_gia === 'mienphi') {
            // Miễn phí ship - xử lý ở frontend
            discountAmount = 0;
        }
        
        res.json({
            success: true,
            message: 'Áp dụng voucher thành công',
            voucher: {
                id: voucher.id,
                ma_voucher: voucher.ma_voucher,
                ten_voucher: voucher.ten_voucher,
                loai_giam_gia: voucher.loai_giam_gia,
                gia_tri_giam: voucher.gia_tri_giam,
                gia_tri_giam_toi_da: voucher.gia_tri_toi_da,
                pham_vi: voucher.pham_vi,
                vung_id: voucher.vung_id,
                discountAmount: discountAmount,
                isFreeShip: voucher.loai_giam_gia === 'mienphi'
            }
        });
        
    } catch (error) {
        console.error('Validate Voucher Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi kiểm tra voucher: ' + error.message
        });
    }
});

// =============================================
// ORDER API ROUTES
// =============================================

// POST /api/orders - Tạo đơn hàng mới
app.post('/api/orders', async (req, res) => {
    try {
        const { 
            userId, 
            addressId, 
            vung_khach_hang,
            items, 
            shipping_method_region_id,
            voucher_id, 
            payment_method,
            ghi_chu_order,
            tong_tien_hang,
            gia_tri_giam_voucher,
            phi_van_chuyen_khach
        } = req.body;

        // Basic validation
        if (!userId || !addressId || !items || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin đơn hàng'
            });
        }

        // Validate required IDs from new workflow
        if (!vung_khach_hang || !shipping_method_region_id) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu thông tin vùng hoặc phương thức vận chuyển'
            });
        }

        console.log('=== Creating Order ===');
        console.log('Request body:', JSON.stringify(req.body, null, 2));

        // 1. Query warehouses BEFORE starting transaction
        console.log('Step 1: Allocating warehouses...');
        const warehouseRequest = new sql.Request(db.connectionPools.default);
        const warehouseResult = await warehouseRequest
            .input('vung_id', sql.NVarChar(10), vung_khach_hang)
            .query(`
                SELECT id, ten_kho, vung_id 
                FROM warehouses 
                WHERE trang_thai = 1
                ORDER BY 
                    CASE WHEN vung_id = @vung_id THEN 1 ELSE 2 END,
                    priority_levels DESC,
                    is_primary DESC,
                    ten_kho
            `);

        const warehouses = warehouseResult.recordset;
        console.log('Warehouses found:', warehouses);
        
        if (!warehouses || warehouses.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Không tìm thấy kho hàng khả dụng'
            });
        }

        // Allocate primary warehouse (same region preferred)
        const primaryWarehouse = warehouses[0];
        const kho_giao_hang = primaryWarehouse.id;

        // Check flash sale for all variants BEFORE transaction
        console.log('Checking flash sale for variants...');
        const variantIds = items.map(item => item.variant_id);
        const flashSaleMap = new Map();
        
        if (variantIds.length > 0) {
            try {
                const flashSaleCheckRequest = new sql.Request(db.connectionPools.default);
                const flashSaleCheckResult = await flashSaleCheckRequest.query(`
                    SELECT 
                        fsi.id as flash_sale_item_id,
                        fsi.variant_id,
                        fsi.gia_flash_sale,
                        fsi.gioi_han_mua
                    FROM flash_sale_items fsi
                    INNER JOIN flash_sales fs ON fsi.flash_sale_id = fs.id
                    WHERE fsi.variant_id IN ('${variantIds.join("','")}')
                        AND fs.trang_thai = N'dang_dien_ra'
                        AND fsi.trang_thai = N'dang_ban'
                        AND GETDATE() BETWEEN fs.ngay_bat_dau AND fs.ngay_ket_thuc
                        AND (fsi.so_luong_ton - fsi.da_ban) > 0
                `);
                
                flashSaleCheckResult.recordset.forEach(fs => {
                    flashSaleMap.set(fs.variant_id, {
                        flash_sale_item_id: fs.flash_sale_item_id,
                        gia_flash_sale: fs.gia_flash_sale,
                        gioi_han_mua: fs.gioi_han_mua
                    });
                });
                
                console.log('✅ Found flash sale items:', flashSaleMap.size);
            } catch (fsError) {
                console.error('⚠️ Error checking flash sales:', fsError);
            }
        }

        // Check if items need to be fulfilled from multiple warehouses
        // Query inventory to get warehouse allocation for each item
        const itemsWithWarehouse = [];
        for (const item of items) {
            // Check if this variant has flash sale
            const flashSaleInfo = flashSaleMap.get(item.variant_id);
            
            // Get variant info with site_origin
            const variantRequest = new sql.Request(db.connectionPools.default);
            const variantResult = await variantRequest
                .input('variant_id', sql.UniqueIdentifier, item.variant_id)
                .query(`
                    SELECT pv.id, pv.site_origin, pv.san_pham_id
                    FROM product_variants pv
                    WHERE pv.id = @variant_id
                `);
            
            if (variantResult.recordset.length === 0) {
                throw new Error(`Không tìm thấy thông tin variant ${item.variant_id}`);
            }
            
            const variant = variantResult.recordset[0];
            const site_origin = variant.site_origin || vung_khach_hang; // Fallback to customer region
            
            // Query inventory to find warehouse with available stock
            const inventoryRequest = new sql.Request(db.connectionPools.default);
            const inventoryResult = await inventoryRequest
                .input('variant_id', sql.UniqueIdentifier, item.variant_id)
                .input('quantity', sql.Int, parseInt(item.so_luong))
                .input('site_origin', sql.NVarChar(10), site_origin)
                .input('vung_khach_hang', sql.NVarChar(10), vung_khach_hang)
                .query(`
                    SELECT TOP 1 
                        i.kho_id as warehouse_id,
                        w.vung_id as warehouse_region,
                        w.ten_kho,
                        i.so_luong_kha_dung
                    FROM inventory i
                    INNER JOIN warehouses w ON i.kho_id = w.id
                    WHERE i.variant_id = @variant_id
                        AND i.so_luong_kha_dung >= @quantity
                        AND w.trang_thai = 1
                    ORDER BY 
                        CASE WHEN w.vung_id = @site_origin THEN 1 ELSE 2 END,
                        CASE WHEN w.vung_id = @vung_khach_hang THEN 1 ELSE 2 END,
                        w.priority_levels DESC,
                        w.is_primary DESC,
                        i.so_luong_kha_dung DESC
                `);
            
            if (inventoryResult.recordset.length === 0) {
                throw new Error(`Không đủ hàng trong kho cho sản phẩm ${item.variant_id}`);
            }
            
            const inventory = inventoryResult.recordset[0];
            
            // Ưu tiên dùng flash sale info từ frontend nếu có, nếu không thì dùng từ database
            const finalFlashSaleItemId = item.flash_sale_item_id || (flashSaleInfo ? flashSaleInfo.flash_sale_item_id : null);
            const finalGiaFlashSale = item.gia_flash_sale || (flashSaleInfo ? flashSaleInfo.gia_flash_sale : null);
            const finalGioiHanMua = item.gioi_han_mua || (flashSaleInfo ? flashSaleInfo.gioi_han_mua : null);
            
            console.log('🔥 Flash sale info for variant', item.variant_id, ':', {
                fromFrontend: { id: item.flash_sale_item_id, price: item.gia_flash_sale },
                fromDB: flashSaleInfo,
                final: { id: finalFlashSaleItemId, price: finalGiaFlashSale }
            });
            
            itemsWithWarehouse.push({
                ...item,
                warehouse_id: inventory.warehouse_id,
                warehouse_region: inventory.warehouse_region,
                site_origin: site_origin,
                flash_sale_item_id: finalFlashSaleItemId,
                gia_flash_sale: finalGiaFlashSale,
                gioi_han_mua: finalGioiHanMua
            });
        }
        
        console.log('Items with warehouse allocation from inventory:', itemsWithWarehouse);

        // 🔥 GROUP ITEMS BY SITE_ORIGIN để tạo split orders
        const itemsBySiteOrigin = {};
        for (const item of itemsWithWarehouse) {
            const siteOrigin = item.site_origin || vung_khach_hang;
            if (!itemsBySiteOrigin[siteOrigin]) {
                itemsBySiteOrigin[siteOrigin] = [];
            }
            itemsBySiteOrigin[siteOrigin].push(item);
        }
        
        const siteOrigins = Object.keys(itemsBySiteOrigin);
        const is_split_order = siteOrigins.length > 1; // Nhiều site_origin = split order
        
        console.log('🔀 Split order analysis:', {
            totalSites: siteOrigins.length,
            sites: siteOrigins,
            isSplitOrder: is_split_order
        });

        // 🎫 Query voucher info BEFORE transaction (if voucher is used)
        let voucherInfo = null;
        if (voucher_id) {
            try {
                const voucherRequest = new sql.Request(db.connectionPools.default);
                const voucherResult = await voucherRequest
                    .input('voucher_id', sql.UniqueIdentifier, voucher_id)
                    .query(`
                        SELECT id, ma_voucher, ten_voucher, vung_id, loai_giam_gia
                        FROM vouchers
                        WHERE id = @voucher_id
                    `);
                
                if (voucherResult.recordset.length > 0) {
                    voucherInfo = voucherResult.recordset[0];
                    console.log('🎫 Voucher info:', voucherInfo);
                } else {
                    console.log('⚠️ Voucher not found:', voucher_id);
                }
            } catch (voucherError) {
                console.error('❌ Error querying voucher:', voucherError);
            }
        }

        // 🚚 Query minimum shipping fee from all regions for split order calculation
        let minShippingFee = phi_van_chuyen_khach;
        if (is_split_order && shipping_method_region_id) {
            try {
                const shippingMethodRequest = new sql.Request(db.connectionPools.default);
                const shippingMethodResult = await shippingMethodRequest
                    .input('shipping_method_region_id', sql.UniqueIdentifier, shipping_method_region_id)
                    .query(`
                        SELECT TOP 1 gia_van_chuyen
                        FROM shipping_method_regions
                        WHERE shipping_method_id = (
                            SELECT shipping_method_id 
                            FROM shipping_method_regions 
                            WHERE id = @shipping_method_region_id
                        )
                        ORDER BY gia_van_chuyen ASC
                    `);
                
                if (shippingMethodResult.recordset.length > 0) {
                    minShippingFee = shippingMethodResult.recordset[0].gia_van_chuyen;
                    console.log('🚚 Minimum shipping fee found:', minShippingFee);
                }
            } catch (shippingError) {
                console.error('⚠️ Error querying min shipping fee, using default:', shippingError);
            }
        }

        // Generate ma_don_hang (format: DH + timestamp + random) - CHUNG cho tất cả orders
        const ma_don_hang = 'DH' + Date.now() + Math.floor(Math.random() * 1000);

        // NOW start transaction with proper pool
        const transaction = new sql.Transaction(db.connectionPools.default);
        await transaction.begin();

        try {
            console.log('Step 2: Creating orders (one per site_origin)...');
            
            const createdOrders = []; // Track all created orders
            
            // 🔥 CREATE ONE ORDER PER SITE_ORIGIN
            for (const siteOrigin of siteOrigins) {
                const siteItems = itemsBySiteOrigin[siteOrigin];
                
                // ✅ 1. Query kho giao hàng cho site này (ưu tiên kho cùng vùng)
                const siteWarehouseRequest = new sql.Request(transaction);
                const siteWarehouseResult = await siteWarehouseRequest
                    .input('site_origin', sql.NVarChar(10), siteOrigin)
                    .query(`
                        SELECT TOP 1 id as warehouse_id, ten_kho, vung_id
                        FROM warehouses
                        WHERE trang_thai = 1
                          AND vung_id = @site_origin
                        ORDER BY 
                            priority_levels DESC,
                            is_primary DESC
                    `);
                
                if (siteWarehouseResult.recordset.length === 0) {
                    throw new Error(`Không tìm thấy kho hàng cho vùng ${siteOrigin}`);
                }
                
                const site_kho_giao_hang = siteWarehouseResult.recordset[0].warehouse_id;
                console.log(`📦 Kho giao hàng cho site ${siteOrigin}:`, siteWarehouseResult.recordset[0]);
                
                // ✅ 2. Phí vận chuyển: Dùng giá nhỏ nhất / số lượng split orders
                const site_shipping_method_region_id = shipping_method_region_id;
                const site_phi_van_chuyen_base = is_split_order 
                    ? (minShippingFee / siteOrigins.length)
                    : phi_van_chuyen_khach;
                
                console.log(`🚚 Phí vận chuyển cho site ${siteOrigin}:`, site_phi_van_chuyen_base, `(chia từ min: ${minShippingFee})`);
                
                // Calculate totals for this site's items
                const site_tong_tien_hang = siteItems.reduce((sum, item) => 
                    sum + (parseFloat(item.don_gia) * parseInt(item.so_luong)), 0
                );
                
                // 🎫 Chỉ áp dụng voucher cho order có sản phẩm từ vùng matching với voucher
                let site_gia_tri_giam = 0;
                const canApplyVoucher = voucherInfo && voucherInfo.vung_id === siteOrigin;
                
                if (canApplyVoucher && gia_tri_giam_voucher) {
                    // Áp dụng toàn bộ voucher cho order matching này
                    site_gia_tri_giam = gia_tri_giam_voucher;
                    console.log(`✅ Voucher áp dụng cho site ${siteOrigin} (matching vùng ${voucherInfo.vung_id}):`, site_gia_tri_giam);
                } else if (voucherInfo) {
                    console.log(`⏭️ Skip voucher cho site ${siteOrigin} (voucher từ vùng ${voucherInfo.vung_id})`);
                }
                
                // Calculate chi_phi_noi_bo if cross-region fulfillment
                const hasCrossRegion = siteItems.some(
                    item => item.warehouse_region !== siteOrigin
                );
                const site_chi_phi_noi_bo = hasCrossRegion ? (site_phi_van_chuyen_base * 0.5) : 0;
                
                const site_tong_thanh_toan = site_tong_tien_hang - site_gia_tri_giam + site_phi_van_chuyen_base;
                
                console.log(`📦 Creating order for site: ${siteOrigin}`, {
                    ma_don_hang,
                    site_processed: siteOrigin,
                    site_kho_giao_hang,
                    site_shipping_method_region_id,
                    itemCount: siteItems.length,
                    site_tong_tien_hang,
                    site_phi_van_chuyen_base,
                    site_gia_tri_giam,
                    site_chi_phi_noi_bo,
                    site_tong_thanh_toan,
                    is_split_order
                });

                // 2. Create order for this site
                // Generate UNIQUEIDENTIFIER for order ID (since orders.id is UNIQUEIDENTIFIER, not IDENTITY)
                const orderId = uuidv4();
                
                // 🎫 Chỉ order matching với vùng voucher mới được gán voucher_id
                const order_voucher_id = canApplyVoucher ? voucher_id : null;
                
                const orderRequest = new sql.Request(transaction);
                await orderRequest
                    .input('id', sql.UniqueIdentifier, orderId) // ✅ Provide ID explicitly
                    .input('ma_don_hang', sql.NVarChar(50), ma_don_hang) // ✅ SAME ma_don_hang
                    .input('nguoi_dung_id', sql.UniqueIdentifier, userId)
                    .input('vung_don_hang', sql.NVarChar(10), vung_khach_hang)
                    .input('site_processed', sql.NVarChar(10), siteOrigin) // ✅ = site_origin
                    .input('shipping_method_region_id', sql.UniqueIdentifier, site_shipping_method_region_id) // ✅ Site-specific
                    .input('dia_chi_giao_hang_id', sql.UniqueIdentifier, addressId)
                    .input('kho_giao_hang', sql.UniqueIdentifier, site_kho_giao_hang) // ✅ Site-specific warehouse
                    .input('voucher_id', sql.UniqueIdentifier, order_voucher_id) // ✅ CHỈ matching order có voucher_id
                    .input('payment_method', sql.NVarChar(50), payment_method || 'cod')
                    .input('ghi_chu_order', sql.NVarChar(sql.MAX), ghi_chu_order || null)
                    .input('tong_tien_hang', sql.Decimal(15, 2), site_tong_tien_hang)
                    .input('gia_tri_giam_voucher', sql.Decimal(15, 2), site_gia_tri_giam)
                    .input('phi_van_chuyen', sql.Decimal(15, 2), site_phi_van_chuyen_base) // ✅ Site-specific shipping
                    .input('chi_phi_noi_bo', sql.Decimal(15, 2), site_chi_phi_noi_bo)
                    .input('tong_thanh_toan', sql.Decimal(15, 2), site_tong_thanh_toan)
                    .input('is_split_order', sql.Bit, is_split_order ? 1 : 0) // ✅ = 1 if multiple sites
                    .input('trang_thai', sql.NVarChar(20), 'cho_xac_nhan')
                    .query(`
                        INSERT INTO orders (
                            id, ma_don_hang, nguoi_dung_id, vung_don_hang, site_processed, shipping_method_region_id,
                            dia_chi_giao_hang_id, kho_giao_hang, voucher_id, payment_method, ghi_chu_order,
                            tong_tien_hang, gia_tri_giam_voucher, phi_van_chuyen, chi_phi_noi_bo, 
                            tong_thanh_toan, is_split_order, trang_thai, ngay_tao
                        )
                        VALUES (
                            @id, @ma_don_hang, @nguoi_dung_id, @vung_don_hang, @site_processed, @shipping_method_region_id,
                            @dia_chi_giao_hang_id, @kho_giao_hang, @voucher_id, @payment_method, @ghi_chu_order,
                            @tong_tien_hang, @gia_tri_giam_voucher, @phi_van_chuyen, @chi_phi_noi_bo,
                            @tong_thanh_toan, @is_split_order, @trang_thai, GETDATE()
                        );
                    `);
                console.log(`✅ Order created for site ${siteOrigin}: Order ID =`, orderId);
                
                createdOrders.push({
                    orderId,
                    siteOrigin,
                    items: siteItems,
                    hasVoucher: canApplyVoucher, // 🎫 Track if this order uses voucher
                    voucherDiscount: site_gia_tri_giam
                });

                console.log(`Step 3: Creating order details for order ${orderId}...`);
                // 3. Create order details ONLY for this site's items
                for (const item of siteItems) {
                console.log('Processing item:', item);
                const itemRequest = new sql.Request(transaction);
                await itemRequest
                    .input('don_hang_id', sql.UniqueIdentifier, orderId)
                    .input('variant_id', sql.UniqueIdentifier, item.variant_id)
                    .input('warehouse_id', sql.UniqueIdentifier, item.warehouse_id)
                    .input('warehouse_region', sql.NVarChar(10), item.warehouse_region)
                    .input('so_luong', sql.Int, parseInt(item.so_luong) || 1)
                    .input('don_gia', sql.Decimal(15, 2), parseFloat(item.don_gia) || 0)
                    .input('thanh_tien', sql.Decimal(15, 2), parseFloat(item.don_gia * item.so_luong) || 0)
                    .input('flash_sale_item_id', sql.UniqueIdentifier, item.flash_sale_item_id || null)
                    .query(`
                        INSERT INTO order_details (
                            don_hang_id, variant_id, warehouse_id, warehouse_region,
                            so_luong, don_gia, thanh_tien, flash_sale_item_id
                        )
                        VALUES (
                            @don_hang_id, @variant_id, @warehouse_id, @warehouse_region,
                            @so_luong, @don_gia, @thanh_tien, @flash_sale_item_id
                        );
                    `);

                // 4. Update SQL product_variants stock
                console.log('📊 Updating product_variants - variant:', item.variant_id, 'quantity:', item.so_luong);
                
                const updateVariantStockRequest = new sql.Request(transaction);
                const variantUpdateResult = await updateVariantStockRequest
                    .input('variant_id', sql.UniqueIdentifier, item.variant_id)
                    .input('quantity', sql.Int, parseInt(item.so_luong))
                    .query(`
                        UPDATE product_variants 
                        SET 
                            so_luong_ton_kho = so_luong_ton_kho - @quantity,
                            luot_ban = luot_ban + @quantity,
                            ngay_cap_nhat = GETDATE()
                        WHERE id = @variant_id
                    `);
                
                console.log('✅ Variant update result - rows affected:', variantUpdateResult.rowsAffected[0]);

                // 5. Update SQL inventory table - trừ tồn kho từ kho được phân bổ
                console.log('📦 Updating inventory - variant:', item.variant_id, 'warehouse:', item.warehouse_id, 'quantity:', item.so_luong);
                
                const updateInventoryRequest = new sql.Request(transaction);
                const inventoryUpdateResult = await updateInventoryRequest
                    .input('variant_id', sql.UniqueIdentifier, item.variant_id)
                    .input('warehouse_id', sql.UniqueIdentifier, item.warehouse_id)
                    .input('quantity', sql.Int, parseInt(item.so_luong))
                    .query(`
                        UPDATE inventory 
                        SET 
                            so_luong_kha_dung = so_luong_kha_dung - @quantity,
                            so_luong_da_dat = so_luong_da_dat + @quantity,
                            ngay_cap_nhat = GETDATE()
                        WHERE variant_id = @variant_id
                            AND kho_id = @warehouse_id
                    `);
                
                console.log('✅ Inventory update result - rows affected:', inventoryUpdateResult.rowsAffected[0]);
                
                if (inventoryUpdateResult.rowsAffected[0] === 0) {
                    throw new Error(`Không thể cập nhật tồn kho cho variant ${item.variant_id} tại kho ${item.warehouse_id}`);
                }

                // 6. Update cart - Trừ số lượng đã đặt (chỉ trừ nếu đủ)
                if (item.cart_item_id) {
                    // Lấy số lượng hiện tại trong giỏ
                    const checkCartRequest = new sql.Request(transaction);
                    const cartItemCheck = await checkCartRequest
                        .input('cart_item_id', sql.UniqueIdentifier, item.cart_item_id)
                        .query('SELECT so_luong FROM cart_items WHERE id = @cart_item_id');
                    
                    if (cartItemCheck.recordset.length > 0) {
                        const currentQty = cartItemCheck.recordset[0].so_luong;
                        const orderedQty = parseInt(item.so_luong);
                        
                        // Chỉ lấy tối đa số lượng có trong giỏ (mua ngay luôn lấy 1)
                        const qtyToDeduct = Math.min(orderedQty, currentQty);
                        
                        if (qtyToDeduct >= currentQty) {
                            // Xóa item nếu lấy hết
                            const deleteRequest = new sql.Request(transaction);
                            await deleteRequest
                                .input('cart_item_id', sql.UniqueIdentifier, item.cart_item_id)
                                .query('DELETE FROM cart_items WHERE id = @cart_item_id');
                        } else {
                            // Trừ số lượng
                            const updateCartRequest = new sql.Request(transaction);
                            await updateCartRequest
                                .input('cart_item_id', sql.UniqueIdentifier, item.cart_item_id)
                                .input('qty_to_deduct', sql.Int, qtyToDeduct)
                                .query(`
                                    UPDATE cart_items 
                                    SET so_luong = so_luong - @qty_to_deduct
                                    WHERE id = @cart_item_id AND so_luong >= @qty_to_deduct
                                `);
                        }
                    }
                }

                // 7. Update stock in MongoDB (optional - for compatibility)
                try {
                    console.log('🔄 Updating MongoDB stock for variant:', item.variant_id);
                    
                    // Query variant info from SQL to get site_origin and product_id
                    const variantInfoRequest = new sql.Request(transaction);
                    const variantInfo = await variantInfoRequest
                        .input('variant_id', sql.UniqueIdentifier, item.variant_id)
                        .query(`
                            SELECT pv.site_origin, p.id as san_pham_id
                            FROM product_variants pv
                            INNER JOIN products p ON pv.san_pham_id = p.id
                            WHERE pv.id = @variant_id
                        `);
                    
                    if (variantInfo.recordset.length > 0) {
                        const { site_origin, san_pham_id } = variantInfo.recordset[0];
                        console.log('📍 Variant region:', site_origin, 'Product ID:', san_pham_id);
                        
                        // Find product in MongoDB by sql_product_id
                        const product = await DataModel.Mongo.ProductDetail.findOne({ 
                            sql_product_id: san_pham_id 
                        });
                        
                        if (product && product.variants && product.variants[site_origin]) {
                            const combinations = product.variants[site_origin].variant_combinations || [];
                            const variantIndex = combinations.findIndex(v => 
                                v.variant_id && v.variant_id.toLowerCase() === item.variant_id.toLowerCase()
                            );
                            
                            if (variantIndex !== -1) {
                                const currentStock = combinations[variantIndex].stock || 0;
                                const newStock = Math.max(0, currentStock - item.so_luong);
                                
                                console.log('📦 MongoDB stock update:', {
                                    region: site_origin,
                                    variantIndex,
                                    currentStock,
                                    orderQuantity: item.so_luong,
                                    newStock
                                });
                                
                                // Update stock in the correct region path
                                await DataModel.Mongo.ProductDetail.updateOne(
                                    { sql_product_id: san_pham_id },
                                    { $set: { [`variants.${site_origin}.variant_combinations.${variantIndex}.stock`]: newStock } }
                                );
                                
                                console.log('✅ MongoDB stock updated successfully');
                            } else {
                                console.log('⚠️ Variant not found in MongoDB region:', site_origin);
                            }
                        } else {
                            console.log('⚠️ Product not found in MongoDB or region not exists:', san_pham_id, site_origin);
                        }
                    } else {
                        console.log('⚠️ Variant info not found in SQL:', item.variant_id);
                    }
                } catch (mongoError) {
                    console.error('❌ Error updating MongoDB stock:', mongoError);
                    // Don't rollback transaction for MongoDB failure
                }
            } // End of site items loop
        } // End of site origins loop
            
            // 7.5. Insert flash_sale_orders for flash sale items (for all orders)
            console.log('Step 4: Recording flash sale orders for all split orders...');
            for (const orderInfo of createdOrders) {
                const { orderId, siteOrigin, items: siteItems } = orderInfo;
                
                for (const item of siteItems) {
                    if (item.flash_sale_item_id && item.gia_flash_sale) {
                        console.log('🔥 Recording flash sale order - variant:', item.variant_id, 'flash_sale_item:', item.flash_sale_item_id, 'quantity:', item.so_luong, 'for order:', orderId);
                        
                        // Kiểm tra user đã mua bao nhiêu flash_sale_item này rồi
                        const checkPurchasedRequest = new sql.Request(transaction);
                        const purchasedResult = await checkPurchasedRequest
                            .input('flash_sale_item_id', sql.UniqueIdentifier, item.flash_sale_item_id)
                            .input('nguoi_dung_id', sql.UniqueIdentifier, userId)
                            .query(`
                                SELECT ISNULL(SUM(so_luong), 0) as da_mua
                                FROM flash_sale_orders
                                WHERE flash_sale_item_id = @flash_sale_item_id
                                  AND nguoi_dung_id = @nguoi_dung_id
                            `);
                        
                        const daMua = purchasedResult.recordset[0].da_mua || 0;
                        const gioiHanMua = item.gioi_han_mua || 999;
                        
                        // Tính số lượng còn được phép mua
                        const conDuocMua = Math.max(0, gioiHanMua - daMua);
                        
                        // Tính số lượng thực tế được hưởng giá flash sale (không vượt số còn được mua)
                        const soLuongFlashSale = Math.min(item.so_luong, conDuocMua);
                        
                        console.log('  - Giới hạn mua:', gioiHanMua, '| Đã mua:', daMua, '| Còn được mua:', conDuocMua, '→ Số lượng flash sale:', soLuongFlashSale);
                        
                        // Nếu đã vượt giới hạn mua rồi, không insert vào flash_sale_orders
                        if (soLuongFlashSale <= 0) {
                            console.log('⚠️  User đã đạt giới hạn mua flash sale item này!');
                            continue;
                        }
                        
                        // Chỉ lưu số lượng được hưởng giá flash sale (không tính phần vượt giới hạn)
                        const flashSaleOrderRequest = new sql.Request(transaction);
                        await flashSaleOrderRequest
                            .input('flash_sale_item_id', sql.UniqueIdentifier, item.flash_sale_item_id)
                            .input('nguoi_dung_id', sql.UniqueIdentifier, userId)
                            .input('don_hang_id', sql.UniqueIdentifier, orderId)
                            .input('so_luong', sql.Int, soLuongFlashSale)
                            .input('gia_flash_sale', sql.Decimal(15, 2), item.gia_flash_sale)
                            .query(`
                                INSERT INTO flash_sale_orders (
                                    flash_sale_item_id, nguoi_dung_id, don_hang_id, 
                                    so_luong, gia_flash_sale, ngay_mua
                                )
                                VALUES (
                                    @flash_sale_item_id, @nguoi_dung_id, @don_hang_id,
                                    @so_luong, @gia_flash_sale, GETDATE()
                                )
                            `);
                        
                        // Cập nhật số lượng đã bán trong flash_sale_items
                        const updateFlashSaleItemRequest = new sql.Request(transaction);
                        await updateFlashSaleItemRequest
                            .input('flash_sale_item_id', sql.UniqueIdentifier, item.flash_sale_item_id)
                            .input('so_luong', sql.Int, soLuongFlashSale)
                            .query(`
                                UPDATE flash_sale_items
                                SET da_ban = da_ban + @so_luong,
                                    ngay_cap_nhat = GETDATE()
                                WHERE id = @flash_sale_item_id
                            `);
                        
                        console.log('✅ Flash sale order recorded:', soLuongFlashSale, 'items at', item.gia_flash_sale, '₫');
                    } else {
                        console.log('⏭️  Skip item (not flash sale) - variant:', item.variant_id);
                    }
                }
            }

            // 8. Update voucher usage - CHỈ cho order có hasVoucher = true
            // Tìm order có voucher
            const ordersWithVoucher = createdOrders.filter(o => o.hasVoucher && o.voucherDiscount > 0);
            
            if (voucher_id && ordersWithVoucher.length > 0 && voucherInfo) {
                console.log(`🎫 Updating voucher usage: ${voucher_id} - ${ordersWithVoucher.length} order(s) use voucher`);
                
                // Update voucher count (chỉ 1 lần)
                const voucherRequest = new sql.Request(transaction);
                await voucherRequest
                    .input('voucher_id', sql.UniqueIdentifier, voucher_id)
                    .query(`
                        UPDATE vouchers 
                        SET da_su_dung = da_su_dung + 1
                        WHERE id = @voucher_id
                    `);

                // Insert used_vouchers CHỈ cho order có hasVoucher = true
                for (const orderInfo of ordersWithVoucher) {
                    const usageRequest = new sql.Request(transaction);
                    await usageRequest
                        .input('voucher_id', sql.UniqueIdentifier, voucher_id)
                        .input('nguoi_dung_id', sql.UniqueIdentifier, userId)
                        .input('don_hang_id', sql.UniqueIdentifier, orderInfo.orderId)
                        .input('gia_tri_giam', sql.Decimal(18, 2), orderInfo.voucherDiscount)
                    .query(`
                            INSERT INTO used_vouchers (
                                voucher_id, nguoi_dung_id, don_hang_id, gia_tri_giam, ngay_su_dung
                            )
                            VALUES (
                                @voucher_id, @nguoi_dung_id, @don_hang_id, @gia_tri_giam, GETDATE()
                            )
                        `);
                    console.log(`✅ Voucher recorded for order ${orderInfo.orderId} (site: ${orderInfo.siteOrigin}, discount: ${orderInfo.voucherDiscount})`);
                }
                
                console.log(`✅ Voucher usage recorded for ${ordersWithVoucher.length}/${createdOrders.length} orders`);
            } else if (voucher_id && ordersWithVoucher.length === 0) {
                console.log('⚠️ No order matches voucher region - voucher not applied');
            }

            // Commit transaction
            console.log('💾 Committing transaction...');
            await transaction.commit();
            console.log('✅ Transaction committed successfully!');

            // Return all created orders
            res.json({
                success: true,
                message: is_split_order 
                    ? `Đặt hàng thành công! Đơn hàng của bạn được chia thành ${createdOrders.length} đơn từ các khu vực khác nhau.`
                    : 'Đặt hàng thành công',
                data: {
                    orderId: createdOrders[0].orderId, // ID của đơn hàng đầu tiên (dùng cho redirect)
                    orderCode: ma_don_hang, // Mã đơn hàng chung
                    isSplitOrder: is_split_order,
                    orders: createdOrders.map(o => ({
                        orderId: o.orderId,
                        siteOrigin: o.siteOrigin,
                        itemCount: o.items.length
                    }))
                }
            });

        } catch (error) {
            await transaction.rollback();
            console.error('Transaction Error Details:', {
                message: error.message,
                code: error.code,
                number: error.number,
                state: error.state,
                class: error.class,
                serverName: error.serverName,
                procName: error.procName,
                lineNumber: error.lineNumber,
                stack: error.stack
            });
            throw error;
        }

    } catch (error) {
        console.error('Create Order Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi tạo đơn hàng: ' + error.message,
            details: error.number ? `SQL Error ${error.number}: ${error.message}` : error.message
        });
    }
});

// GET /api/orders - Lấy danh sách đơn hàng theo user
app.get('/api/orders', async (req, res) => {
    try {
        const { userId } = req.query;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: 'Thiếu userId'
            });
        }

        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('userId', sql.UniqueIdentifier, userId)
            .query(`
                SELECT 
                    o.id,
                    o.ma_don_hang,
                    o.nguoi_dung_id,
                    o.vung_don_hang,
                    o.site_processed,
                    o.is_split_order,
                    o.tong_tien_hang,
                    o.phi_van_chuyen,
                    o.gia_tri_giam_voucher,
                    o.tong_thanh_toan,
                    o.trang_thai,
                    o.ngay_tao,
                    o.ngay_cap_nhat
                FROM orders o
                WHERE o.nguoi_dung_id = @userId
                ORDER BY o.ngay_tao DESC
            `);

        const allOrders = result.recordset;
        
        // 🔥 Group orders by ma_don_hang (gộp split orders)
        const ordersMap = new Map();
        
        for (let order of allOrders) {
            const ma_don_hang = order.ma_don_hang;
            
            if (!ordersMap.has(ma_don_hang)) {
                // First order with this ma_don_hang - use as base
                ordersMap.set(ma_don_hang, {
                    id: order.id, // Use first order's ID for detail link
                    ma_don_hang: order.ma_don_hang,
                    nguoi_dung_id: order.nguoi_dung_id,
                    vung_don_hang: order.vung_don_hang,
                    is_split_order: order.is_split_order,
                    tong_tien_hang: order.tong_tien_hang,
                    phi_van_chuyen: order.phi_van_chuyen,
                    gia_tri_giam_voucher: order.gia_tri_giam_voucher,
                    tong_thanh_toan: order.tong_thanh_toan,
                    trang_thai: order.trang_thai,
                    ngay_tao: order.ngay_tao,
                    ngay_cap_nhat: order.ngay_cap_nhat,
                    order_ids: [order.id], // Track all order IDs
                    statuses: [order.trang_thai], // Track all statuses
                    items: []
                });
            } else {
                // Split order - merge totals
                const merged = ordersMap.get(ma_don_hang);
                merged.tong_tien_hang += order.tong_tien_hang;
                merged.phi_van_chuyen += order.phi_van_chuyen;
                merged.gia_tri_giam_voucher += order.gia_tri_giam_voucher;
                merged.tong_thanh_toan += order.tong_thanh_toan;
                merged.order_ids.push(order.id);
                merged.statuses.push(order.trang_thai);
            }
        }
        
        // ✅ Determine final status for each merged order
        const statusPriority = {
            'huy': 0, // Lowest (if any order is cancelled, show cancelled)
            'cho_xac_nhan': 1,
            'dang_xu_ly': 2,
            'dang_giao': 3,
            'hoan_thanh': 4 // Highest
        };
        
        for (let [ma_don_hang, mergedOrder] of ordersMap) {
            const uniqueStatuses = [...new Set(mergedOrder.statuses)];
            
            if (uniqueStatuses.length === 1) {
                // ✅ All orders have same status
                mergedOrder.trang_thai = uniqueStatuses[0];
            } else {
                // ✅ Different statuses - show the lowest/worst one
                mergedOrder.trang_thai = uniqueStatuses.reduce((worst, current) => {
                    return statusPriority[current] < statusPriority[worst] ? current : worst;
                });
            }
        }
        
        // Get items for all orders and merge
        for (let [ma_don_hang, mergedOrder] of ordersMap) {
            for (let orderId of mergedOrder.order_ids) {
                const itemsRequest = new sql.Request(db.connectionPools.default);
                const itemsResult = await itemsRequest
                    .input('orderId', sql.UniqueIdentifier, orderId)
                    .query(`
                        SELECT 
                            od.id,
                            od.variant_id,
                            od.so_luong,
                            od.don_gia,
                            od.thanh_tien,
                            pv.ten_hien_thi as ten_bien_the,
                            pv.anh_dai_dien as hinh_anh,
                            pv.site_origin,
                            p.ten_san_pham,
                            p.id as san_pham_id
                        FROM order_details od
                        LEFT JOIN product_variants pv ON od.variant_id = pv.id
                        LEFT JOIN products p ON pv.san_pham_id = p.id
                        WHERE od.don_hang_id = @orderId
                    `);

                // Nếu không có ảnh từ SQL, tìm từ MongoDB
                for (let item of itemsResult.recordset) {
                    if (!item.hinh_anh) {
                        try {
                            const productDetail = await DataModel.Mongo.ProductDetail.findOne({
                                sql_product_id: item.san_pham_id
                            }).lean();

                            if (productDetail && productDetail.variants && item.site_origin) {
                                // Tìm trong variants của region cụ thể
                                const regionVariants = productDetail.variants[item.site_origin];
                                if (regionVariants && regionVariants.variant_combinations) {
                                    const variant = regionVariants.variant_combinations.find(
                                        v => v.variant_id && v.variant_id.toLowerCase() === item.variant_id.toLowerCase()
                                    );
                                    if (variant && variant.images && variant.images.length > 0) {
                                        item.hinh_anh = variant.images[0];
                                    }
                                }
                            }
                            
                            // Fallback: dùng ảnh chính của sản phẩm
                            if (!item.hinh_anh && productDetail && productDetail.images && productDetail.images.length > 0) {
                                item.hinh_anh = productDetail.images[0];
                            }
                        } catch (err) {
                            console.error('Error fetching image from MongoDB:', err);
                        }
                    }
                }

                mergedOrder.items.push(...itemsResult.recordset);
            }
        }

        // Convert map to array
        const orders = Array.from(ordersMap.values());

        res.json({
            success: true,
            orders: orders
        });

    } catch (error) {
        console.error('Get Orders Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy danh sách đơn hàng: ' + error.message
        });
    }
});

// GET /api/orders/:orderId - Lấy thông tin đơn hàng
app.get('/api/orders/:orderId', async (req, res) => {
    try {
        const { orderId } = req.params;

        const orderRequest = new sql.Request(db.connectionPools.default);
        const orderResult = await orderRequest
            .input('orderId', sql.UniqueIdentifier, orderId)
            .query(`
                SELECT 
                    o.*,
                    u.ho_ten as ten_khach_hang,
                    u.email as email_khach_hang,
                    ua.ten_nguoi_nhan,
                    ua.sdt_nguoi_nhan,
                    ua.dia_chi_cu_the,
                    w.ten_phuong_xa,
                    p.ten_tinh as ten_tinh_thanh,
                    r.ten_vung,
                    wh.ten_kho,
                    sm.ten_phuong_thuc,
                    smr.chi_phi_van_chuyen,
                    smr.thoi_gian_giao_du_kien
                FROM orders o
                LEFT JOIN users u ON o.nguoi_dung_id = u.id
                LEFT JOIN user_addresses ua ON o.dia_chi_giao_hang_id = ua.id
                LEFT JOIN wards w ON ua.phuong_xa_id = w.id
                LEFT JOIN provinces p ON w.tinh_thanh_id = p.id
                LEFT JOIN regions r ON o.vung_don_hang = r.ma_vung
                LEFT JOIN warehouses wh ON o.kho_giao_hang = wh.id
                LEFT JOIN shipping_method_regions smr ON o.shipping_method_region_id = smr.id
                LEFT JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
                WHERE o.id = @orderId
            `);

        if (orderResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy đơn hàng'
            });
        }

        const order = orderResult.recordset[0];
        
        // 🔥 Check if this is a split order - find all orders with same ma_don_hang
        let allOrderIds = [orderId];
        let mergedOrder = { ...order };
        
        if (order.is_split_order === 1 || order.is_split_order === true) {
            const splitOrdersRequest = new sql.Request(db.connectionPools.default);
            const splitOrdersResult = await splitOrdersRequest
                .input('ma_don_hang', sql.NVarChar(50), order.ma_don_hang)
                .query(`
                    SELECT 
                        o.*,
                        sm.ten_phuong_thuc,
                        smr.chi_phi_van_chuyen
                    FROM orders o
                    LEFT JOIN shipping_method_regions smr ON o.shipping_method_region_id = smr.id
                    LEFT JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
                    WHERE o.ma_don_hang = @ma_don_hang
                `);
            
            allOrderIds = splitOrdersResult.recordset.map(o => o.id);
            
            // Merge totals from all split orders
            mergedOrder.tong_tien_hang = 0;
            mergedOrder.phi_van_chuyen = 0;
            mergedOrder.gia_tri_giam_voucher = 0;
            mergedOrder.tong_thanh_toan = 0;
            
            // Collect all statuses
            const allStatuses = [];
            
            for (let splitOrder of splitOrdersResult.recordset) {
                mergedOrder.tong_tien_hang += splitOrder.tong_tien_hang || 0;
                mergedOrder.phi_van_chuyen += splitOrder.phi_van_chuyen || 0;
                mergedOrder.gia_tri_giam_voucher += splitOrder.gia_tri_giam_voucher || 0;
                mergedOrder.tong_thanh_toan += splitOrder.tong_thanh_toan || 0;
                allStatuses.push(splitOrder.trang_thai);
            }
            
            // ✅ Determine final status: all same → use it, different → use worst/lowest
            const uniqueStatuses = [...new Set(allStatuses)];
            const statusPriority = {
                'huy': 0,
                'cho_xac_nhan': 1,
                'dang_xu_ly': 2,
                'dang_giao': 3,
                'hoan_thanh': 4
            };
            
            if (uniqueStatuses.length === 1) {
                // All orders have same status
                mergedOrder.trang_thai = uniqueStatuses[0];
            } else {
                // Different statuses - show the lowest/worst one
                mergedOrder.trang_thai = uniqueStatuses.reduce((worst, current) => {
                    return statusPriority[current] < statusPriority[worst] ? current : worst;
                });
            }
            
            console.log(`✅ Split order detected: ${order.ma_don_hang}, merged ${allOrderIds.length} orders, final status: ${mergedOrder.trang_thai}`);
        }

        // Lấy items từ TẤT CẢ orders (nếu là split order)
        let allItems = [];
        for (let currentOrderId of allOrderIds) {
            const itemsRequest = new sql.Request(db.connectionPools.default);
            const itemsResult = await itemsRequest
                .input('orderId', sql.UniqueIdentifier, currentOrderId)
                .query(`
                    SELECT 
                        od.*
                    FROM order_details od
                    WHERE od.don_hang_id = @orderId
                `);

            allItems.push(...itemsResult.recordset);
        }

        // Lấy thông tin variant và product từ SQL
        const itemsWithDetails = await Promise.all(allItems.map(async (item) => {
            // Get variant and product info from SQL
            const variantRequest = new sql.Request(db.connectionPools.default);
            const variantResult = await variantRequest
                .input('variantId', sql.UniqueIdentifier, item.variant_id)
                .query(`
                    SELECT 
                        pv.ten_hien_thi,
                        pv.ma_sku,
                        pv.anh_dai_dien,
                        pv.site_origin,
                        p.ten_san_pham,
                        p.id as san_pham_id
                    FROM product_variants pv
                    LEFT JOIN products p ON pv.san_pham_id = p.id
                    WHERE pv.id = @variantId
                `);

            let ten_san_pham = 'Sản phẩm';
            let ten_bien_the = '';
            let hinh_anh = '/image/placeholder.png';
            let san_pham_id = null;
            let site_origin = null;

            if (variantResult.recordset.length > 0) {
                const variantData = variantResult.recordset[0];
                ten_san_pham = variantData.ten_san_pham || 'Sản phẩm';
                ten_bien_the = variantData.ten_hien_thi || '';
                hinh_anh = variantData.anh_dai_dien || hinh_anh; // ✅ Lấy ảnh từ SQL trước
                san_pham_id = variantData.san_pham_id;
                site_origin = variantData.site_origin;
            }

            // Nếu không có ảnh từ SQL, tìm từ MongoDB
            if (!hinh_anh || hinh_anh === '/image/placeholder.png') {
                try {
                    const productDetail = await DataModel.Mongo.ProductDetail.findOne({
                        sql_product_id: san_pham_id
                    }).lean();

                    if (productDetail && productDetail.variants && site_origin) {
                        // Tìm trong variants của region cụ thể
                        const regionVariants = productDetail.variants[site_origin];
                        if (regionVariants && regionVariants.variant_combinations) {
                            const variant = regionVariants.variant_combinations.find(v => 
                                v.variant_id && v.variant_id.toLowerCase() === item.variant_id.toLowerCase()
                            );
                            
                            if (variant && variant.images && variant.images.length > 0) {
                                hinh_anh = variant.images[0];
                            }
                        }
                    }
                    
                    // Fallback: dùng ảnh chính của sản phẩm
                    if ((!hinh_anh || hinh_anh === '/image/placeholder.png') && productDetail && productDetail.images && productDetail.images.length > 0) {
                        hinh_anh = productDetail.images[0];
                    }
                } catch (mongoErr) {
                    console.error('MongoDB image fetch error:', mongoErr);
                }
            }

            return {
                ...item,
                ten_san_pham,
                ten_bien_the,
                hinh_anh
            };
        }));

        res.json({
            success: true,
            order: mergedOrder, // ✅ Use merged order with combined totals
            items: itemsWithDetails // ✅ All items from all split orders
        });

    } catch (error) {
        console.error('Get Order Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin đơn hàng: ' + error.message
        });
    }
});

// PUT /api/orders/:orderId/cancel - Hủy đơn hàng
app.put('/api/orders/:orderId/cancel', async (req, res) => {
    try {
        const { orderId } = req.params;

        // Check if order exists and can be cancelled
        const checkRequest = new sql.Request(db.connectionPools.default);
        const checkResult = await checkRequest
            .input('orderId', sql.UniqueIdentifier, orderId)
            .query(`
                SELECT trang_thai 
                FROM orders 
                WHERE id = @orderId
            `);

        if (checkResult.recordset.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Không tìm thấy đơn hàng'
            });
        }

        const currentStatus = checkResult.recordset[0].trang_thai;
        if (currentStatus !== 'cho_xac_nhan') {
            return res.status(400).json({
                success: false,
                message: 'Chỉ có thể hủy đơn hàng đang chờ xác nhận'
            });
        }

        // Update order status to cancelled
        const updateRequest = new sql.Request(db.connectionPools.default);
        await updateRequest
            .input('orderId', sql.UniqueIdentifier, orderId)
            .query(`
                UPDATE orders 
                SET trang_thai = N'huy', 
                    ngay_cap_nhat = GETDATE() 
                WHERE id = @orderId
            `);

        // TODO: Restore inventory for cancelled items

        res.json({
            success: true,
            message: 'Đã hủy đơn hàng thành công'
        });

    } catch (error) {
        console.error('Cancel Order Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi hủy đơn hàng: ' + error.message
        });
    }
});

// =============================================
// WAREHOUSE & SHIPPING API ROUTES
// =============================================

// GET /api/warehouses/by-region/:regionId - Lấy kho hàng theo vùng
app.get('/api/warehouses/by-region/:regionId', async (req, res) => {
    try {
        const { regionId } = req.params;

        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('regionId', sql.NVarChar, regionId)
            .query(`
                SELECT TOP 1 id, ten_kho, vung_id
                FROM warehouses
                WHERE vung_id = @regionId AND trang_thai = 1
                ORDER BY ngay_tao ASC
            `);

        if (result.recordset.length === 0) {
            // Fallback: lấy warehouse đầu tiên nếu không tìm thấy theo vùng
            const fallbackResult = await new sql.Request(db.connectionPools.default).query(`
                SELECT TOP 1 id, ten_kho, vung_id
                FROM warehouses
                WHERE trang_thai = 1
                ORDER BY ngay_tao ASC
            `);
            
            return res.json({
                success: true,
                data: fallbackResult.recordset[0] || null
            });
        }

        res.json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        console.error('Get Warehouse Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy thông tin kho hàng: ' + error.message
        });
    }
});

// GET /api/shipping-methods/by-region/:regionId - Lấy phương thức vận chuyển theo vùng
app.get('/api/shipping-methods/by-region/:regionId', async (req, res) => {
    try {
        const { regionId } = req.params;

        const request = new sql.Request(db.connectionPools.default);
        const result = await request
            .input('regionId', sql.NVarChar, regionId)
            .query(`
                SELECT TOP 1 
                    smr.id,
                    smr.shipping_method_id,
                    smr.region_id,
                    smr.chi_phi_van_chuyen,
                    smr.thoi_gian_giao_du_kien,
                    sm.ten_phuong_thuc,
                    sm.chi_phi_co_ban
                FROM shipping_method_regions smr
                JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
                WHERE smr.region_id = @regionId AND smr.trang_thai = 1
                ORDER BY smr.chi_phi_van_chuyen ASC
            `);

        if (result.recordset.length === 0) {
            // Fallback: lấy phương thức đầu tiên
            const fallbackResult = await new sql.Request(db.connectionPools.default).query(`
                SELECT TOP 1 
                    smr.id,
                    smr.shipping_method_id,
                    smr.region_id,
                    smr.chi_phi_van_chuyen,
                    smr.thoi_gian_giao_du_kien,
                    sm.ten_phuong_thuc,
                    sm.chi_phi_co_ban
                FROM shipping_method_regions smr
                JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
                WHERE smr.trang_thai = 1
                ORDER BY smr.chi_phi_van_chuyen ASC
            `);
            
            return res.json({
                success: true,
                data: fallbackResult.recordset[0] || null
            });
        }

        res.json({
            success: true,
            data: result.recordset[0]
        });

    } catch (error) {
        console.error('Get Shipping Method Error:', error);
        res.status(500).json({
            success: false,
            message: 'Lỗi khi lấy phương thức vận chuyển: ' + error.message
        });
    }
});

// ==================== SHIPPING METHODS API ====================

// Get all regions
app.get('/api/regions', async (req, res) => {
    try {
        const result = await new sql.Request(db.connectionPools.default).query(`
            SELECT ma_vung, ten_vung, mo_ta, trang_thai
            FROM regions
            WHERE trang_thai = 1
            ORDER BY 
                CASE ma_vung 
                    WHEN 'bac' THEN 1 
                    WHEN 'trung' THEN 2 
                    WHEN 'nam' THEN 3 
                END
        `);
        
        res.json(result.recordset);
    } catch (error) {
        console.error('Get Regions Error:', error);
        res.status(500).json({ message: 'Lỗi khi lấy danh sách vùng: ' + error.message });
    }
});

// Get all shipping methods
app.get('/api/shipping-methods', async (req, res) => {
    try {
        const result = await new sql.Request(db.connectionPools.default).query(`
            SELECT 
                id,
                ten_phuong_thuc,
                mo_ta,
                chi_phi_co_ban,
                mongo_config_id,
                trang_thai,
                ngay_tao
            FROM shipping_methods
            ORDER BY ngay_tao DESC
        `);
        
        res.json(result.recordset);
    } catch (error) {
        console.error('Get Shipping Methods Error:', error);
        res.status(500).json({ message: 'Lỗi khi lấy danh sách phương thức vận chuyển: ' + error.message });
    }
});

// Get shipping method by ID
app.get('/api/shipping-methods/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await new sql.Request(db.connectionPools.default)
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                SELECT 
                    id,
                    ten_phuong_thuc,
                    mo_ta,
                    chi_phi_co_ban,
                    mongo_config_id,
                    trang_thai,
                    ngay_tao
                FROM shipping_methods
                WHERE id = @id
            `);
        
        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Không tìm thấy phương thức vận chuyển' });
        }
        
        res.json(result.recordset[0]);
    } catch (error) {
        console.error('Get Shipping Method Error:', error);
        res.status(500).json({ message: 'Lỗi khi lấy thông tin phương thức vận chuyển: ' + error.message });
    }
});

// Create new shipping method
app.post('/api/shipping-methods', async (req, res) => {
    try {
        const { ten_phuong_thuc, mo_ta, chi_phi_co_ban, trang_thai } = req.body;
        
        // Validation
        if (!ten_phuong_thuc || chi_phi_co_ban === undefined) {
            return res.status(400).json({ 
                success: false,
                message: 'Thiếu thông tin bắt buộc' 
            });
        }
        
        if (chi_phi_co_ban < 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Chi phí cơ bản phải >= 0' 
            });
        }
        
        // Convert text status to bit
        let trangThaiBit = 1;
        if (trang_thai === 'Tạm ngưng' || trang_thai === false || trang_thai === 0) {
            trangThaiBit = 0;
        }
        
        const request = new sql.Request(db.connectionPools.default);
        await request
            .input('ten_phuong_thuc', sql.NVarChar(100), ten_phuong_thuc)
            .input('mo_ta', sql.NVarChar(500), mo_ta || null)
            .input('chi_phi_co_ban', sql.Decimal(15, 2), chi_phi_co_ban)
            .input('trang_thai', sql.Bit, trangThaiBit)
            .query(`
                INSERT INTO shipping_methods (ten_phuong_thuc, mo_ta, chi_phi_co_ban, trang_thai)
                VALUES (@ten_phuong_thuc, @mo_ta, @chi_phi_co_ban, @trang_thai)
            `);
        
        const result = await request.query(`SELECT TOP 1 * FROM shipping_methods WHERE ten_phuong_thuc = @ten_phuong_thuc ORDER BY ngay_tao DESC`);
        
        res.status(201).json({
            success: true,
            data: result.recordset[0]
        });
    } catch (error) {
        console.error('Create Shipping Method Error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Lỗi khi tạo phương thức vận chuyển: ' + error.message 
        });
    }
});

// Update shipping method
app.put('/api/shipping-methods/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { ten_phuong_thuc, mo_ta, chi_phi_co_ban, trang_thai } = req.body;
        
        // Validation
        if (!ten_phuong_thuc || chi_phi_co_ban === undefined) {
            return res.status(400).json({ 
                success: false,
                message: 'Thiếu thông tin bắt buộc' 
            });
        }
        
        if (chi_phi_co_ban < 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Chi phí cơ bản phải >= 0' 
            });
        }
        
        // Convert text status to bit
        let trangThaiBit = 1;
        if (trang_thai === 'Tạm ngưng' || trang_thai === false || trang_thai === 0) {
            trangThaiBit = 0;
        }
        
        const request = new sql.Request(db.connectionPools.default);
        
        const result = await request
            .input('id', sql.UniqueIdentifier, id)
            .input('ten_phuong_thuc', sql.NVarChar(100), ten_phuong_thuc)
            .input('mo_ta', sql.NVarChar(500), mo_ta || null)
            .input('chi_phi_co_ban', sql.Decimal(15, 2), chi_phi_co_ban)
            .input('trang_thai', sql.Bit, trangThaiBit)
            .query(`
                UPDATE shipping_methods
                SET 
                    ten_phuong_thuc = @ten_phuong_thuc,
                    mo_ta = @mo_ta,
                    chi_phi_co_ban = @chi_phi_co_ban,
                    trang_thai = @trang_thai
                WHERE id = @id
            `);
        
        const selectResult = await request.query(`SELECT * FROM shipping_methods WHERE id = @id`);
        
        if (selectResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Không tìm thấy phương thức vận chuyển' 
            });
        }
        
        res.json({
            success: true,
            data: selectResult.recordset[0]
        });
    } catch (error) {
        console.error('Update Shipping Method Error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Lỗi khi cập nhật phương thức vận chuyển: ' + error.message 
        });
    }
});

// Delete shipping method
app.delete('/api/shipping-methods/:id', async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if method is being used in orders
        const checkResult = await new sql.Request(db.connectionPools.default)
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                SELECT COUNT(*) as count
                FROM orders o
                JOIN shipping_method_regions smr ON o.shipping_method_region_id = smr.id
                WHERE smr.shipping_method_id = @id
            `);
        
        if (checkResult.recordset[0].count > 0) {
            return res.status(400).json({ 
                success: false,
                message: 'Không thể xóa phương thức vận chuyển đang được sử dụng trong đơn hàng' 
            });
        }
        
        const result = await new sql.Request(db.connectionPools.default)
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                DELETE FROM shipping_methods
                WHERE id = @id
            `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Không tìm thấy phương thức vận chuyển' 
            });
        }
        
        res.json({ 
            success: true,
            message: 'Đã xóa phương thức vận chuyển' 
        });
    } catch (error) {
        console.error('Delete Shipping Method Error:', error);
        res.status(500).json({ message: 'Lỗi khi xóa phương thức vận chuyển: ' + error.message });
    }
});

// Get regional pricing for a shipping method
app.get('/api/shipping-methods/:id/regions', async (req, res) => {
    try {
        const { id } = req.params;
        
        const result = await new sql.Request(db.connectionPools.default)
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                SELECT 
                    smr.id,
                    smr.shipping_method_id,
                    smr.region_id,
                    smr.chi_phi_van_chuyen,
                    smr.thoi_gian_giao_du_kien,
                    smr.mongo_region_config_id,
                    smr.trang_thai,
                    smr.ngay_tao,
                    r.ten_vung
                FROM shipping_method_regions smr
                JOIN regions r ON smr.region_id = r.ma_vung
                WHERE smr.shipping_method_id = @id
                ORDER BY 
                    CASE smr.region_id 
                        WHEN 'bac' THEN 1 
                        WHEN 'trung' THEN 2 
                        WHEN 'nam' THEN 3 
                    END
            `);
        
        res.json(result.recordset);
    } catch (error) {
        console.error('Get Regional Pricing Error:', error);
        res.status(500).json({ message: 'Lỗi khi lấy giá theo vùng: ' + error.message });
    }
});

// Get all shipping method regions
app.get('/api/shipping-method-regions', async (req, res) => {
    try {
        const { regionId, methodId } = req.query;
        
        let query = `
            SELECT 
                smr.id,
                smr.shipping_method_id as phuong_thuc_van_chuyen_id,
                smr.region_id as vung_id,
                smr.chi_phi_van_chuyen as gia_van_chuyen,
                smr.thoi_gian_giao_du_kien as thoi_gian_du_kien,
                smr.mongo_region_config_id,
                smr.trang_thai,
                smr.ngay_tao,
                sm.ten_phuong_thuc,
                r.ten_vung
            FROM shipping_method_regions smr
            JOIN shipping_methods sm ON smr.shipping_method_id = sm.id
            JOIN regions r ON smr.region_id = r.ma_vung
            WHERE 1=1
        `;
        
        // ✅ User pages MUST use default pool (global data)
        const request = new sql.Request(db.connectionPools.default);
        
        if (regionId) {
            query += ` AND smr.region_id = @regionId`;
            request.input('regionId', sql.NVarChar(10), regionId);
        }
        
        if (methodId) {
            query += ` AND smr.shipping_method_id = @methodId`;
            request.input('methodId', sql.UniqueIdentifier, methodId);
        }
        
        query += ` ORDER BY sm.ten_phuong_thuc, smr.region_id`;
        
        const result = await request.query(query);
        
        res.json({
            success: true,
            data: result.recordset
        });
    } catch (error) {
        console.error('Get Shipping Method Regions Error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Lỗi khi lấy danh sách giá vùng: ' + error.message 
        });
    }
});

// Create shipping method region
app.post('/api/shipping-method-regions', requireAdmin, async (req, res) => {
    try {
        const { shipping_method_id, region_id, chi_phi_van_chuyen, thoi_gian_giao_du_kien, trang_thai } = req.body;
        
        // Validation
        if (!shipping_method_id || !region_id || chi_phi_van_chuyen === undefined) {
            return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
        }
        
        if (chi_phi_van_chuyen < 0) {
            return res.status(400).json({ message: 'Chi phí vận chuyển phải >= 0' });
        }
        
        if (thoi_gian_giao_du_kien !== null && thoi_gian_giao_du_kien !== undefined && thoi_gian_giao_du_kien <= 0) {
            return res.status(400).json({ message: 'Thời gian giao dự kiến phải > 0' });
        }
        
        // Check if combination already exists
        const checkResult = await new sql.Request(req.dbPool)
            .input('shipping_method_id', sql.UniqueIdentifier, shipping_method_id)
            .input('region_id', sql.NVarChar(10), region_id)
            .query(`
                SELECT id FROM shipping_method_regions
                WHERE shipping_method_id = @shipping_method_id AND region_id = @region_id
            `);
        
        if (checkResult.recordset.length > 0) {
            return res.status(400).json({ message: 'Giá cho vùng này đã tồn tại' });
        }
        
        const request = new sql.Request(req.dbPool);
        await request
            .input('shipping_method_id', sql.UniqueIdentifier, shipping_method_id)
            .input('region_id', sql.NVarChar(10), region_id)
            .input('chi_phi_van_chuyen', sql.Decimal(15, 2), chi_phi_van_chuyen)
            .input('thoi_gian_giao_du_kien', sql.Int, thoi_gian_giao_du_kien || null)
            .input('trang_thai', sql.Bit, trang_thai !== undefined ? trang_thai : true)
            .query(`
                INSERT INTO shipping_method_regions 
                    (shipping_method_id, region_id, chi_phi_van_chuyen, thoi_gian_giao_du_kien, trang_thai)
                VALUES 
                    (@shipping_method_id, @region_id, @chi_phi_van_chuyen, @thoi_gian_giao_du_kien, @trang_thai)
            `);
        
        const result = await request.query(`SELECT TOP 1 * FROM shipping_method_regions WHERE shipping_method_id = @shipping_method_id AND region_id = @region_id ORDER BY ngay_tao DESC`);
        
        res.status(201).json(result.recordset[0]);
    } catch (error) {
        console.error('Create Shipping Method Region Error:', error);
        res.status(500).json({ message: 'Lỗi khi tạo giá vùng: ' + error.message });
    }
});

// Update shipping method region
app.put('/api/shipping-method-regions/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { gia_van_chuyen, chi_phi_van_chuyen, thoi_gian_du_kien, thoi_gian_giao_du_kien, trang_thai } = req.body;
        
        // Accept both old and new field names
        const giaCuoi = gia_van_chuyen || chi_phi_van_chuyen;
        const thoiGian = thoi_gian_du_kien || thoi_gian_giao_du_kien;
        
        // Validation
        if (giaCuoi === undefined) {
            return res.status(400).json({ message: 'Thiếu thông tin bắt buộc' });
        }
        
        if (giaCuoi < 0) {
            return res.status(400).json({ message: 'Chi phí vận chuyển phải >= 0' });
        }
        
        // Convert text status to bit
        let trangThaiBit = 1;
        if (trang_thai === 'Tạm ngưng' || trang_thai === false || trang_thai === 0) {
            trangThaiBit = 0;
        }
        
        // Parse thoi_gian as INT (nullable)
        let thoiGianInt = null;
        if (thoiGian !== null && thoiGian !== undefined && thoiGian !== '') {
            const parsed = parseInt(thoiGian);
            if (!isNaN(parsed)) {
                thoiGianInt = parsed;
            }
        }
        
        const request = new sql.Request(req.dbPool);
        
        const result = await request
            .input('id', sql.UniqueIdentifier, id)
            .input('chi_phi_van_chuyen', sql.Decimal(15, 2), giaCuoi)
            .input('thoi_gian_giao_du_kien', sql.Int, thoiGianInt)
            .input('trang_thai', sql.Bit, trangThaiBit)
            .query(`
                UPDATE shipping_method_regions
                SET 
                    chi_phi_van_chuyen = @chi_phi_van_chuyen,
                    thoi_gian_giao_du_kien = @thoi_gian_giao_du_kien,
                    trang_thai = @trang_thai
                WHERE id = @id
            `);
        
        const selectResult = await request.query(`SELECT * FROM shipping_method_regions WHERE id = @id`);
        
        if (selectResult.recordset.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Không tìm thấy giá vùng' 
            });
        }
        
        res.json({
            success: true,
            data: selectResult.recordset[0]
        });
    } catch (error) {
        console.error('Update Shipping Method Region Error:', error);
        res.status(500).json({ 
            success: false,
            message: 'Lỗi khi cập nhật giá vùng: ' + error.message 
        });
    }
});

// Delete shipping method region
app.delete('/api/shipping-method-regions/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Check if being used in orders
        const checkResult = await new sql.Request(req.dbPool)
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                SELECT COUNT(*) as count
                FROM orders
                WHERE shipping_method_region_id = @id
            `);
        
        if (checkResult.recordset[0].count > 0) {
            return res.status(400).json({ 
                message: 'Không thể xóa giá vùng đang được sử dụng trong đơn hàng' 
            });
        }
        
        const result = await new sql.Request(req.dbPool)
            .input('id', sql.UniqueIdentifier, id)
            .query(`
                DELETE FROM shipping_method_regions
                WHERE id = @id
            `);
        
        if (result.rowsAffected[0] === 0) {
            return res.status(404).json({ message: 'Không tìm thấy giá vùng' });
        }
        
        res.json({ message: 'Đã xóa giá vùng' });
    } catch (error) {
        console.error('Delete Shipping Method Region Error:', error);
        res.status(500).json({ message: 'Lỗi khi xóa giá vùng: ' + error.message });
    }
});

// Start server
app.listen(3000, () => console.log('Server running on port 3000'));