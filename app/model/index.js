import mongoose, { model } from "mongoose";
import sql from 'mssql';
import db from '../../server.js';
import { v4 as uuidv4 } from 'uuid';

// ✅ Helper để lấy connection pool (default hoặc từ request)
function getPool(requestPool) {
  return requestPool || db.connectionPools?.default;
}

// ✅ Helper để tạo Request với pool đúng
function createRequest(pool) {
  const activePool = pool || db.connectionPools?.default || sql.globalConnectionPool;
  if (!activePool) {
    throw new Error('No SQL connection pool available');
  }
  return new sql.Request(activePool);
}

// ==================== MONGODB MODELS ====================

const productDetailSchema = new mongoose.Schema({
  sql_product_id: { type: String, required: true, unique: true },
}, { 
  strict: false, // Cho phép lưu các trường không được định nghĩa
  timestamps: true 
});
const Data_ProductDetail_Model = mongoose.model('ProductDetail', productDetailSchema);




const flashSaleDetailSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // UUID từ SQL flash_sales.id
  banner_images: [{ type: String }], // Mảng URL ảnh banner
  promotional_videos: [{ 
    url: String,
    title: String,
    thumbnail: String,
    duration: Number
  }],
  rules: {
    max_quantity_per_user: Number,
    min_purchase_amount: Number,
    eligible_user_groups: [String],
    payment_methods: [String]
  },
  marketing: {
    seo_title: String,
    seo_description: String,
    seo_keywords: [String],
    social_share_image: String,
    hashtags: [String]
  },
  notification_settings: {
    send_email: { type: Boolean, default: true },
    send_sms: { type: Boolean, default: false },
    send_push: { type: Boolean, default: true },
    notify_before_start: Number, // phút trước khi bắt đầu
    notify_when_sold_out: { type: Boolean, default: true }
  },
  analytics: {
    total_views: { type: Number, default: 0 },
    total_clicks: { type: Number, default: 0 },
    conversion_rate: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 }
  },
  ui_settings: {
    theme_color: String,
    background_color: String,
    countdown_style: String,
    layout_type: String
  },
  custom_data: mongoose.Schema.Types.Mixed, // Dữ liệu tùy chỉnh bất kỳ
  notes: String,
  tags: [String]
}, { 
  _id: false, // Tắt auto-generate _id vì đã tự định nghĩa
  strict: false, // Cho phép lưu các trường không được định nghĩa
  timestamps: true 
});

// Thêm static methods trước khi tạo model
flashSaleDetailSchema.statics.findByFlashSaleId = async function(flashSaleId) {
  return await this.findById(flashSaleId);
};

flashSaleDetailSchema.statics.createOrUpdate = async function(flashSaleId, detailData) {
  return await this.findByIdAndUpdate(
    flashSaleId,
    { $set: { ...detailData, _id: flashSaleId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

flashSaleDetailSchema.statics.deleteByFlashSaleId = async function(flashSaleId) {
  return await this.findByIdAndDelete(flashSaleId);
};

// MongoDB Models (tạo sau khi đã định nghĩa methods)
const Data_FlashSaleDetail_Model = mongoose.model('FlashSaleDetail', flashSaleDetailSchema);

const userDetailSchema = new mongoose.Schema({
  sql_user_id: { type: String, required: true, unique: true },
}, {
  strict: false, // Cho phép lưu các trường không được định nghĩa
  timestamps: true
});
const Data_UserDetail_Model = mongoose.model('UserDetail', userDetailSchema);

// Voucher Detail Schema
const voucherDetailSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // UUID từ SQL vouchers.id
  usage_history: [{
    user_id: String,
    order_id: String,
    used_at: Date,
    discount_amount: Number,
    order_amount: Number
  }],
  user_restrictions: {
    eligible_user_groups: { type: [String], default: ['all'] },
    excluded_users: [String],
    max_uses_per_user: { type: Number, default: 1 },
    first_order_only: { type: Boolean, default: false }
  },
  combination_rules: {
    can_combine_with_other_vouchers: { type: Boolean, default: false },
    can_combine_with_flash_sale: { type: Boolean, default: true },
    can_combine_with_promotions: { type: Boolean, default: false },
    priority: { type: Number, default: 0 }
  },
  analytics: {
    total_views: { type: Number, default: 0 },
    total_uses: { type: Number, default: 0 },
    total_revenue_impact: { type: Number, default: 0 },
    total_discount_given: { type: Number, default: 0 },
    conversion_rate: { type: Number, default: 0 },
    average_order_value: { type: Number, default: 0 }
  },
  notification_settings: {
    notify_when_near_expiry: { type: Boolean, default: true },
    days_before_expiry: { type: Number, default: 3 },
    notify_when_limited_stock: { type: Boolean, default: true },
    stock_threshold: { type: Number, default: 10 },
    send_email_on_use: { type: Boolean, default: false }
  },
  marketing: {
    campaign_name: String,
    campaign_id: String,
    affiliate_code: String,
    source: String
  },
  custom_data: mongoose.Schema.Types.Mixed,
  notes: String,
  tags: [String]
}, { 
  _id: false, // Tắt auto-generate _id vì đã tự định nghĩa
  strict: false, // Cho phép lưu các trường không được định nghĩa
  timestamps: true 
});

// Thêm static methods cho VoucherDetail
voucherDetailSchema.statics.findByVoucherId = async function(voucherId) {
  return await this.findById(voucherId);
};

voucherDetailSchema.statics.createOrUpdate = async function(voucherId, detailData) {
  return await this.findByIdAndUpdate(
    voucherId,
    { $set: { ...detailData, _id: voucherId } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
};

voucherDetailSchema.statics.deleteById = async function(voucherId) {
  return await this.findByIdAndDelete(voucherId);
};

voucherDetailSchema.statics.trackUsage = async function(voucherId, usageData) {
  return await this.findByIdAndUpdate(
    voucherId,
    { 
      $push: { usage_history: usageData },
      $inc: { 
        'analytics.total_uses': 1,
        'analytics.total_discount_given': usageData.discount_amount || 0,
        'analytics.total_revenue_impact': usageData.order_amount || 0
      }
    },
    { new: true }
  );
};

const Data_VoucherDetail_Model = mongoose.model('VoucherDetail', voucherDetailSchema);

// ==================== SQL SERVER MODELS ====================

// Model cho Brand trong SQL Server
class SQLBrandModel {
  static async findAll() {
    try {
      const request = createRequest();
      const result = await request.query(`
        SELECT * FROM brands 
        WHERE trang_thai = 1
      `);
      return result.recordset;
    } catch (error) {
      console.error('SQL Brand Error:', error);
      throw error;
    }
  }
  static async findOne(conditions = {}) {
      try {
          const request = createRequest();
          let whereClause = '';
          const params = [];

          // Xử lý điều kiện where
          if (conditions.where && Object.keys(conditions.where).length > 0) {
              const whereConditions = [];
              let paramIndex = 0;

              Object.entries(conditions.where).forEach(([key, value]) => {
                  paramIndex++;
                  const paramName = `param${paramIndex}`;
                  
                  whereConditions.push(`${key} = @${paramName}`);
                  request.input(paramName, value);
                  
                  params.push({ name: paramName, value });
              });

              whereClause = `WHERE ${whereConditions.join(' AND ')}`;
          }

          const query = `
              SELECT TOP 1 * 
              FROM brands 
              ${whereClause}
              ORDER BY ngay_tao DESC
          `;

          console.log('🔍 Executing findOne Query:', query);
          if (params.length > 0) {
              console.log('📋 Query Parameters:', params);
          }

          const result = await request.query(query);
          
          return result.recordset[0] || null;
          
      } catch (error) {
          console.error('❌ SQL Brand findOne Error:', error);
          throw error;
      }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT * FROM brands WHERE id = @id');
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Brand Error:', error);
      throw error;
    }
  }

  static async create(brandData) {
    try {
      const request = createRequest();
      
      console.log('🔄 Creating brand with data:', brandData);
      
      // Insert without OUTPUT clause to avoid trigger conflict
      const insertQuery = `
        INSERT INTO brands (ten_thuong_hieu, mo_ta, logo_url, slug, trang_thai, ngay_tao)
        VALUES (@ten_thuong_hieu, @mo_ta, @logo_url, @slug, @trang_thai, @ngay_tao)
      `;
      
      console.log('🔄 Executing INSERT query:', insertQuery);
      
      await request
        .input('ten_thuong_hieu', sql.NVarChar(100), brandData.ten_thuong_hieu)
        .input('mo_ta', sql.NVarChar(500), brandData.mo_ta)
        .input('logo_url', sql.NVarChar(500), brandData.logo_url)
        .input('slug', sql.NVarChar(255), brandData.slug)
        .input('trang_thai', sql.Int, brandData.trang_thai !== undefined ? brandData.trang_thai : 1)
        .input('ngay_tao', sql.DateTime, brandData.ngay_tao || new Date())
        .query(insertQuery);
      
      // Get the newly created brand by slug (unique)
      const result = await request.query(`
        SELECT TOP 1 * FROM brands 
        WHERE slug = @slug 
        ORDER BY ngay_tao DESC
      `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Brand Error:', error);
      throw error;
    }
  }

  static async update(brandId, updateData) {
      try {
          const request = createRequest();
          
          // Thêm các parameters
          request.input('id', sql.UniqueIdentifier, brandId);
          request.input('ten_thuong_hieu', sql.NVarChar(100), updateData.ten_thuong_hieu);
          request.input('mo_ta', sql.NVarChar(500), updateData.mo_ta || null);
          request.input('logo_url', sql.NVarChar(500), updateData.logo_url || null);
          request.input('trang_thai', sql.Int, updateData.trang_thai);
          request.input('ngay_tao', sql.DateTime, new Date());

          let slugCondition = '';
          let slugJoin = '';
          
          // Nếu có slug mới thì thêm vào cập nhật
          if (updateData.slug) {
              request.input('slug', sql.NVarChar(255), updateData.slug);
              slugCondition = ', slug = @slug';
          }

          const query = `
              UPDATE brands 
              SET ten_thuong_hieu = @ten_thuong_hieu,
                  mo_ta = @mo_ta,
                  logo_url = @logo_url,
                  trang_thai = @trang_thai,
                  ngay_tao = @ngay_tao
                  ${slugCondition}
              WHERE id = @id;
              
              SELECT * FROM brands WHERE id = @id;
          `;

          console.log('🔄 Executing SQL Update Query:', query);
          
          const result = await request.query(query);
          
          if (!result.recordset || result.recordset.length === 0) {
              throw new Error('Không tìm thấy thương hiệu sau khi cập nhật');
          }

          return result.recordset[0];
          
      } catch (error) {
          console.error('❌ SQL Brand Update Error:', error);
          
          // Xử lý lỗi trùng slug (violation of unique constraint)
          if (error.message && error.message.includes('UNIQUE') || error.message.includes('slug')) {
              throw new Error('Slug đã tồn tại, vui lòng chọn tên khác');
          }
          
          throw error;
      }
  }

  static async destroy(conditions = {}) {
    try {
        const request = createRequest();
        let whereClause = '';
        const params = [];

        // Xử lý điều kiện where
        if (conditions.where && Object.keys(conditions.where).length > 0) {
            const whereConditions = [];
            let paramIndex = 0;

            Object.entries(conditions.where).forEach(([key, value]) => {
                paramIndex++;
                const paramName = `param${paramIndex}`;
                
                whereConditions.push(`${key} = @${paramName}`);
                request.input(paramName, value);
                
                params.push({ name: paramName, value });
            });

            whereClause = `WHERE ${whereConditions.join(' AND ')}`;
        }

        // 1. Kiểm tra xem thương hiệu có tồn tại không
        const checkBrandQuery = `
            SELECT id, ten_thuong_hieu 
            FROM brands 
            ${whereClause}
        `;

        console.log('🔍 Checking brand existence:', checkBrandQuery);
        const brandResult = await request.query(checkBrandQuery);
        
        if (!brandResult.recordset || brandResult.recordset.length === 0) {
            throw new Error('Không tìm thấy thương hiệu');
        }

        const brand = brandResult.recordset[0];
        const brandId = brand.id;

        // 2. Kiểm tra xem có sản phẩm nào thuộc thương hiệu này không
        const checkProductsQuery = `
            SELECT COUNT(*) as product_count 
            FROM products 
            WHERE thuong_hieu_id = @brandId AND trang_thai = 1
        `;

        const productRequest = createRequest();
        productRequest.input('brandId', sql.UniqueIdentifier, brandId);
        
        const productResult = await productRequest.query(checkProductsQuery);
        const productCount = productResult.recordset[0].product_count;

        if (productCount > 0) {
            throw new Error(`Không thể xóa thương hiệu "${brand.ten_thuong_hieu}" vì còn ${productCount} sản phẩm đang hoạt động thuộc thương hiệu này. Vui lòng chuyển hoặc xóa các sản phẩm trước.`);
        }

        // 3. Thực hiện xóa thương hiệu (soft delete - cập nhật trạng thái)
        const deleteQuery = `
            UPDATE brands 
            SET trang_thai = 0
            ${whereClause};
            
            SELECT * FROM brands ${whereClause};
        `;

        console.log('🗑️ Executing soft delete query:', deleteQuery);
        const deleteResult = await request.query(deleteQuery);

        if (!deleteResult.recordset || deleteResult.recordset.length === 0) {
            throw new Error('Không tìm thấy thương hiệu sau khi xóa');
        }

        console.log(`✅ Đã vô hiệu hóa thương hiệu: ${brand.ten_thuong_hieu}`);
        return deleteResult.recordset[0];

    } catch (error) {
        console.error('❌ SQL Brand Destroy Error:', error);
        
        // Xử lý các lỗi cụ thể
        if (error.message.includes('Không thể xóa thương hiệu')) {
            throw error; // Giữ nguyên thông báo lỗi về sản phẩm
        }
        
        if (error.message.includes('Không tìm thấy thương hiệu')) {
            throw new Error('Không tìm thấy thương hiệu để xóa');
        }
        
        throw new Error('Lỗi khi xóa thương hiệu: ' + error.message);
    }
  }
}

// Model cho Category trong SQL Server
class SQLCategoryModel {
    static async findAll() {
        try {
            const request = createRequest();
            const result = await request.query(`
                SELECT * FROM categories 
                WHERE trang_thai = 1 
                ORDER BY thu_tu ASC, ten_danh_muc ASC
            `);
            return result.recordset;
        } catch (error) {
            console.error('SQL Category Error:', error);
            throw error;
        }
    }

    static async findOne(conditions = {}) {
        try {
            const request = createRequest();
            let whereClause = '';
            const params = [];

            if (conditions.where && Object.keys(conditions.where).length > 0) {
                const whereConditions = [];
                let paramIndex = 0;

                Object.entries(conditions.where).forEach(([key, value]) => {
                    paramIndex++;
                    const paramName = `param${paramIndex}`;
                    
                    whereConditions.push(`${key} = @${paramName}`);
                    request.input(paramName, value);
                    
                    params.push({ name: paramName, value });
                });

                whereClause = `WHERE ${whereConditions.join(' AND ')}`;
            }

            const query = `
                SELECT TOP 1 * 
                FROM categories 
                ${whereClause}
                ORDER BY thu_tu ASC, ten_danh_muc ASC
            `;

            console.log('🔍 Executing Category findOne Query:', query);
            if (params.length > 0) {
                console.log('📋 Query Parameters:', params);
            }

            const result = await request.query(query);
            
            return result.recordset[0] || null;
            
        } catch (error) {
            console.error('❌ SQL Category findOne Error:', error);
            throw error;
        }
    }

    static async findById(id) {
        try {
            const request = createRequest();
            const result = await request
                .input('id', sql.UniqueIdentifier, id)
                .query('SELECT * FROM categories WHERE id = @id');
            return result.recordset[0];
        } catch (error) {
            console.error('SQL Category Error:', error);
            throw error;
        }
    }

    static async create(categoryData) {
        try {
            const request = createRequest();
            
            // Insert without OUTPUT clause to avoid trigger conflict
            const insertQuery = `
                INSERT INTO categories (ten_danh_muc, mo_ta, anh_url, thu_tu, danh_muc_cha_id, slug)
                VALUES (@ten_danh_muc, @mo_ta, @anh_url, @thu_tu, @danh_muc_cha_id, @slug)
            `;
            
            await request
                .input('ten_danh_muc', sql.NVarChar(100), categoryData.ten_danh_muc)
                .input('mo_ta', sql.NVarChar(500), categoryData.mo_ta)
                .input('anh_url', sql.NVarChar(500), categoryData.anh_url)
                .input('thu_tu', sql.Int, categoryData.thu_tu !== undefined ? categoryData.thu_tu : 0)
                .input('danh_muc_cha_id', sql.UniqueIdentifier, categoryData.danh_muc_cha_id)
                .input('slug', sql.NVarChar(255), categoryData.slug)
                .query(insertQuery);
            
            // Get the newly created category by slug (unique)
            const result = await request.query(`
                SELECT TOP 1 * FROM categories 
                WHERE slug = @slug 
                ORDER BY ngay_tao DESC
            `);
            
            return result.recordset[0];
        } catch (error) {
            console.error('SQL Category Error:', error);
            throw error;
        }
    }

    static async update(categoryId, updateData) {
        try {
            const request = createRequest();
            
            request.input('id', sql.UniqueIdentifier, categoryId);
            request.input('ten_danh_muc', sql.NVarChar(100), updateData.ten_danh_muc);
            request.input('mo_ta', sql.NVarChar(500), updateData.mo_ta || null);
            request.input('anh_url', sql.NVarChar(500), updateData.anh_url || null);
            request.input('thu_tu', sql.Int, updateData.thu_tu !== undefined ? updateData.thu_tu : 0);
            request.input('danh_muc_cha_id', sql.UniqueIdentifier, updateData.danh_muc_cha_id);
            request.input('trang_thai', sql.Int, updateData.trang_thai);

            let slugCondition = '';
            
            if (updateData.slug) {
                request.input('slug', sql.NVarChar(255), updateData.slug);
                slugCondition = ', slug = @slug';
            }

            const query = `
                UPDATE categories 
                SET ten_danh_muc = @ten_danh_muc,
                    mo_ta = @mo_ta,
                    anh_url = @anh_url,
                    thu_tu = @thu_tu,
                    danh_muc_cha_id = @danh_muc_cha_id,
                    trang_thai = @trang_thai
                    ${slugCondition}
                WHERE id = @id;
                
                SELECT * FROM categories WHERE id = @id;
            `;

            console.log('🔄 Executing Category SQL Update Query:', query);
            
            const result = await request.query(query);
            
            if (!result.recordset || result.recordset.length === 0) {
                throw new Error('Không tìm thấy danh mục sau khi cập nhật');
            }

            return result.recordset[0];
            
        } catch (error) {
            console.error('❌ SQL Category Update Error:', error);
            
            if (error.message && error.message.includes('UNIQUE') || error.message.includes('slug')) {
                throw new Error('Slug đã tồn tại, vui lòng chọn tên khác');
            }
            
            throw error;
        }
    }

    static async destroy(conditions = {}) {
      try {
          const request = createRequest();
          let whereClause = '';
          const params = [];

          if (conditions.where && Object.keys(conditions.where).length > 0) {
              const whereConditions = [];
              let paramIndex = 0;

              Object.entries(conditions.where).forEach(([key, value]) => {
                  paramIndex++;
                  const paramName = `param${paramIndex}`;
                  
                  whereConditions.push(`${key} = @${paramName}`);
                  request.input(paramName, value);
                  
                  params.push({ name: paramName, value });
              });

              whereClause = `WHERE ${whereConditions.join(' AND ')}`;
          }

          // 1. Kiểm tra danh mục tồn tại
          const checkCategoryQuery = `
              SELECT id, ten_danh_muc 
              FROM categories 
              ${whereClause}
          `;

          console.log('🔍 Checking category existence:', checkCategoryQuery);
          const categoryResult = await request.query(checkCategoryQuery);
          
          if (!categoryResult.recordset || categoryResult.recordset.length === 0) {
              throw new Error('Không tìm thấy danh mục');
          }

          const category = categoryResult.recordset[0];
          const categoryId = category.id;

          // 2. Kiểm tra có sản phẩm nào thuộc danh mục này không
          const checkProductsQuery = `
              SELECT COUNT(*) as product_count 
              FROM products 
              WHERE danh_muc_id = @categoryId AND trang_thai = 1
          `;

          const productRequest = createRequest();
          productRequest.input('categoryId', sql.UniqueIdentifier, categoryId);
          
          const productResult = await productRequest.query(checkProductsQuery);
          const productCount = productResult.recordset[0].product_count;

          if (productCount > 0) {
              throw new Error(`Không thể xóa danh mục "${category.ten_danh_muc}" vì còn ${productCount} sản phẩm đang hoạt động thuộc danh mục này.`);
          }

          // 3. KIỂM TRA CÓ DANH MỤC CON KHÔNG (QUAN TRỌNG)
          const checkChildrenQuery = `
              SELECT COUNT(*) as children_count 
              FROM categories 
              WHERE danh_muc_cha_id = @categoryId AND trang_thai = 1
          `;

          const childrenRequest = createRequest();
          childrenRequest.input('categoryId', sql.UniqueIdentifier, categoryId);
          
          const childrenResult = await childrenRequest.query(checkChildrenQuery);
          const childrenCount = childrenResult.recordset[0].children_count;

          if (childrenCount > 0) {
              // Lấy thông tin chi tiết về các danh mục con
              const childrenDetailsQuery = `
                  SELECT ten_danh_muc, thu_tu 
                  FROM categories 
                  WHERE danh_muc_cha_id = @categoryId AND trang_thai = 1
                  ORDER BY thu_tu ASC
              `;
              
              const childrenDetailsRequest = createRequest();
              childrenDetailsRequest.input('categoryId', sql.UniqueIdentifier, categoryId);
              const childrenDetails = await childrenDetailsRequest.query(childrenDetailsQuery);
              
              const childrenNames = childrenDetails.recordset.map(child => child.ten_danh_muc).join(', ');
              
              throw new Error(`Không thể xóa danh mục "${category.ten_danh_muc}" vì còn ${childrenCount} danh mục con: ${childrenNames}. Vui lòng xóa hoặc chuyển các danh mục con trước.`);
          }

          // 4. Thực hiện xóa (soft delete)
          const deleteQuery = `
              UPDATE categories 
              SET trang_thai = 0
              ${whereClause};
              
              SELECT * FROM categories ${whereClause};
          `;

          console.log('🗑️ Executing category soft delete query:', deleteQuery);
          const deleteResult = await request.query(deleteQuery);

          if (!deleteResult.recordset || deleteResult.recordset.length === 0) {
              throw new Error('Không tìm thấy danh mục sau khi xóa');
          }

          console.log(`✅ Đã vô hiệu hóa danh mục: ${category.ten_danh_muc}`);
          return deleteResult.recordset[0];

      } catch (error) {
          console.error('❌ SQL Category Destroy Error:', error);
          
          if (error.message.includes('Không thể xóa danh mục')) {
              throw error;
          }
          
          if (error.message.includes('Không tìm thấy danh mục')) {
              throw new Error('Không tìm thấy danh mục để xóa');
          }
          
          throw new Error('Lỗi khi xóa danh mục: ' + error.message);
      }
  }
}

// Model cho Product trong SQL Server - CẬP NHẬT CHO SCHEMA MỚI
class SQLProductModel {
  // Lấy tất cả products với variants
  static async findAll(pool = null) {
    try {
      const request = createRequest(pool);
      
      // Lấy products với thông tin category và brand
      const productsResult = await request.query(`
        SELECT 
          p.id,
          p.ma_san_pham,
          p.ten_san_pham,
          p.danh_muc_id,
          p.thuong_hieu_id,
          p.mo_ta_ngan,
          p.link_anh_dai_dien,
          p.mongo_detail_id,
          p.trang_thai,
          p.luot_xem,
          p.site_created,
          p.gia_ban,
          p.gia_niem_yet,
          p.ngay_tao,
          p.ngay_cap_nhat,
          c.ten_danh_muc,
          b.ten_thuong_hieu
        FROM products p
        INNER JOIN categories c ON p.danh_muc_id = c.id
        INNER JOIN brands b ON p.thuong_hieu_id = b.id
        ORDER BY p.ngay_tao DESC
      `);

      // Lấy tất cả variants
      const variantsResult = await request.query(`
        SELECT * FROM product_variants
        ORDER BY ngay_tao DESC
      `);

      // Nhóm variants theo san_pham_id
      const variantsByProduct = {};
      variantsResult.recordset.forEach(variant => {
        const productId = variant.san_pham_id.toLowerCase();
        if (!variantsByProduct[productId]) {
          variantsByProduct[productId] = [];
        }
        variantsByProduct[productId].push(variant);
      });

      // Kết hợp products với variants
      const productsWithVariants = productsResult.recordset.map(product => {
        const productId = product.id.toLowerCase();
        const variants = variantsByProduct[productId] || [];

        // Debug: Log product data để kiểm tra
        if (product.id.toLowerCase() === '96d9423e-f36b-1410-8b02-00449f2bb6f5') {
          console.log('🔍 DEBUG Product from SQL:', {
            id: product.id,
            ten_san_pham: product.ten_san_pham,
            gia_ban: product.gia_ban,
            gia_niem_yet: product.gia_niem_yet,
            all_keys: Object.keys(product)
          });
        }

        // Tính giá min/max từ variants
        let gia_ban_min = 0;
        let gia_ban_max = 0;
        let gia_niem_yet_min = 0;
        let tong_so_luong_ban = 0;

        if (variants.length > 0) {
          gia_ban_min = Math.min(...variants.map(v => v.gia_ban));
          gia_ban_max = Math.max(...variants.map(v => v.gia_ban));
          gia_niem_yet_min = Math.min(...variants.map(v => v.gia_niem_yet));
          tong_so_luong_ban = variants.reduce((sum, v) => sum + (v.so_luong_ban || 0), 0);
        }

        return {
          ...product,
          variants: variants,
          so_bien_the: variants.length,
          gia_ban_min,
          gia_ban_max,
          gia_niem_yet_min,
          tong_so_luong_ban,
          // Tính giảm giá nếu có
          giam_gia: gia_niem_yet_min && gia_ban_min ? gia_niem_yet_min - gia_ban_min : 0
        };
      });

      return productsWithVariants;
    } catch (error) {
      console.error('SQL Product Error:', error);
      throw error;
    }
  }

  // Lấy product theo ID với variants
  static async findById(id) {
    try {
      const request = createRequest();
      
      // Lấy product info
      const productResult = await request
        .input('id', sql.UniqueIdentifier, id)
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
            p.trang_thai,
            p.luot_xem,
            p.site_created,
            p.gia_ban,
            p.gia_niem_yet,
            p.ngay_tao,
            p.ngay_cap_nhat,
            c.ten_danh_muc,
            b.ten_thuong_hieu
          FROM products p
          INNER JOIN categories c ON p.danh_muc_id = c.id
          INNER JOIN brands b ON p.thuong_hieu_id = b.id
          WHERE p.id = @id
        `);

      if (productResult.recordset.length === 0) {
        return null;
      }

      const product = productResult.recordset[0];

      // Lấy variants
      const variantsResult = await request
        .input('san_pham_id', sql.UniqueIdentifier, id)
        .query(`
          SELECT * FROM product_variants
          WHERE san_pham_id = @san_pham_id
          ORDER BY ngay_tao DESC
        `);

      const variants = variantsResult.recordset;

      // Tính giá từ variants
      let gia_ban_min = 0;
      let gia_ban_max = 0;
      let gia_niem_yet_min = 0;
      let tong_so_luong_ban = 0;

      if (variants.length > 0) {
        gia_ban_min = Math.min(...variants.map(v => v.gia_ban));
        gia_ban_max = Math.max(...variants.map(v => v.gia_ban));
        gia_niem_yet_min = Math.min(...variants.map(v => v.gia_niem_yet));
        tong_so_luong_ban = variants.reduce((sum, v) => sum + (v.so_luong_ban || 0), 0);
      }

      return {
        ...product,
        variants: variants,
        so_bien_the: variants.length,
        gia_ban_min,
        gia_ban_max,
        gia_niem_yet_min,
        tong_so_luong_ban,
        giam_gia: gia_niem_yet_min && gia_ban_min ? gia_niem_yet_min - gia_ban_min : 0
      };
    } catch (error) {
      console.error('SQL Product Error:', error);
      throw error;
    }
  }

  // Lấy products theo category
  static async findByCategory(categoryId) {
    try {
      const request = createRequest();
      
      const productsResult = await request
        .input('categoryId', sql.UniqueIdentifier, categoryId)
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
            p.trang_thai,
            p.luot_xem,
            p.site_created,
            p.gia_ban,
            p.gia_niem_yet,
            p.ngay_tao,
            p.ngay_cap_nhat,
            c.ten_danh_muc,
            b.ten_thuong_hieu
          FROM products p
          INNER JOIN categories c ON p.danh_muc_id = c.id
          INNER JOIN brands b ON p.thuong_hieu_id = b.id
          WHERE p.danh_muc_id = @categoryId
          ORDER BY p.ngay_tao DESC
        `);

      // Lấy variants cho các products này
      const productIds = productsResult.recordset.map(p => p.id);
      
      if (productIds.length === 0) {
        return [];
      }

      const variantsResult = await request.query(`
        SELECT * FROM product_variants
        WHERE san_pham_id IN (${productIds.map(id => `'${id}'`).join(',')})
        ORDER BY ngay_tao DESC
      `);

      // Nhóm variants theo product
      const variantsByProduct = {};
      variantsResult.recordset.forEach(variant => {
        const productId = variant.san_pham_id.toLowerCase();
        if (!variantsByProduct[productId]) {
          variantsByProduct[productId] = [];
        }
        variantsByProduct[productId].push(variant);
      });

      // Kết hợp
      return productsResult.recordset.map(product => {
        const productId = product.id.toLowerCase();
        const variants = variantsByProduct[productId] || [];

        let gia_ban_min = 0;
        let gia_ban_max = 0;
        let gia_niem_yet_min = 0;

        if (variants.length > 0) {
          gia_ban_min = Math.min(...variants.map(v => v.gia_ban));
          gia_ban_max = Math.max(...variants.map(v => v.gia_ban));
          gia_niem_yet_min = Math.min(...variants.map(v => v.gia_niem_yet));
        }

        return {
          ...product,
          variants: variants,
          so_bien_the: variants.length,
          gia_ban_min,
          gia_ban_max,
          gia_niem_yet_min,
          giam_gia: gia_niem_yet_min && gia_ban_min ? gia_niem_yet_min - gia_ban_min : 0
        };
      });
    } catch (error) {
      console.error('SQL Product Error:', error);
      throw error;
    }
  }

  // Tạo product mới
  static async create(productData) {
    try {
      const request = createRequest();
      const result = await request
        .input('ma_san_pham', sql.NVarChar(100), productData.ma_san_pham)
        .input('ten_san_pham', sql.NVarChar(255), productData.ten_san_pham)
        .input('danh_muc_id', sql.UniqueIdentifier, productData.danh_muc_id)
        .input('thuong_hieu_id', sql.UniqueIdentifier, productData.thuong_hieu_id)
        .input('mo_ta_ngan', sql.NVarChar(500), productData.mo_ta_ngan || null)
        .input('link_anh_dai_dien', sql.NVarChar(500), productData.link_anh_dai_dien || null)
        .input('site_origin', sql.NVarChar(10), productData.site_origin || 'bac')
        .input('trang_thai', sql.Bit, productData.trang_thai !== undefined ? productData.trang_thai : 1)
        .query(`
          INSERT INTO products (
            ma_san_pham, ten_san_pham, danh_muc_id, thuong_hieu_id,
            mo_ta_ngan, link_anh_dai_dien, site_origin, trang_thai
          )
          VALUES (
            @ma_san_pham, @ten_san_pham, @danh_muc_id, @thuong_hieu_id,
            @mo_ta_ngan, @link_anh_dai_dien, @site_origin, @trang_thai
          )
        `);
      
      // Get the newly created product by ma_san_pham (unique)
      const selectResult = await request.query(`
        SELECT TOP 1 * FROM products 
        WHERE ma_san_pham = @ma_san_pham 
        ORDER BY ngay_tao DESC
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL Product Create Error:', error);
      throw error;
    }
  }

  // Cập nhật product
  static async update(productData, id) {
    try {
      console.log('🔍 Updating Product ID:', id);
      console.log('📦 Product Data:', JSON.stringify(productData, null, 2));
      
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      
      const setClauses = [];
      
      // Các trường của bảng products mới
      const validFields = [
        'ma_san_pham', 'ten_san_pham', 'danh_muc_id', 'thuong_hieu_id',
        'mo_ta_ngan', 'link_anh_dai_dien', 'mongo_detail_id',
        'site_created', 'trang_thai', 'luot_xem', 'gia_ban', 'gia_niem_yet'
      ];

      validFields.forEach(field => {
        if (productData[field] !== undefined && productData[field] !== null) {
          setClauses.push(`${field} = @${field}`);
          
          if (field === 'danh_muc_id' || field === 'thuong_hieu_id') {
            request.input(field, sql.UniqueIdentifier, productData[field]);
          } else if (field === 'trang_thai') {
            request.input(field, sql.Bit, productData[field]);
          } else if (field === 'luot_xem') {
            request.input(field, sql.Int, productData[field]);
          } else if (field === 'gia_ban' || field === 'gia_niem_yet') {
            // Parse to float to ensure valid number format
            const price = parseFloat(productData[field]) || 0;
            request.input(field, sql.Decimal(15, 2), price);
          } else {
            request.input(field, sql.NVarChar(sql.MAX), productData[field]);
          }
        }
      });
      
      if (setClauses.length === 0) {
        throw new Error('No fields to update');
      }
      
      setClauses.push('ngay_cap_nhat = GETDATE()');
      
      const sqlQuery = `
        UPDATE products 
        SET ${setClauses.join(', ')}
        WHERE id = @id
      `;
      
      console.log('📝 Update Query:', sqlQuery);
      
      await request.query(sqlQuery);
      
      // Trả về sản phẩm đã cập nhật
      return await this.findById(id);
      
    } catch (error) {
      console.error('❌ SQL Product Update Error:', error);
      throw error;
    }
  }

  // Xóa product (cascade delete variants)
  static async delete(id) {
    try {
      const request = createRequest();
      
      // Xóa variants trước
      await request
        .input('san_pham_id', sql.UniqueIdentifier, id)
        .query('DELETE FROM product_variants WHERE san_pham_id = @san_pham_id');
      
      // Xóa product
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM products WHERE id = @id');
      
      return result.rowsAffected[0] > 0;
    } catch (error) {
      console.error('SQL Product Delete Error:', error);
      throw error;
    }
  }
}

// Model cho Product Variant trong SQL Server - MỚI
class SQLProductVariantModel {
  // Lấy tất cả variants của một product
  static async findByProductId(productId) {
    try {
      const request = createRequest();
      const result = await request
        .input('san_pham_id', sql.UniqueIdentifier, productId)
        .query(`
          SELECT * FROM product_variants
          WHERE san_pham_id = @san_pham_id
          ORDER BY ngay_tao DESC
        `);
      return result.recordset;
    } catch (error) {
      console.error('SQL Product Variant Error:', error);
      throw error;
    }
  }

  // Lấy variant theo ID
  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT * FROM product_variants
          WHERE id = @id
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Product Variant Error:', error);
      throw error;
    }
  }

  // Tìm variant theo SKU
  static async findBySKU(ma_sku) {
    try {
      const request = createRequest();
      const result = await request
        .input('ma_sku', sql.NVarChar(100), ma_sku)
        .query(`
          SELECT pv.*, p.ten_san_pham
          FROM product_variants pv
          INNER JOIN products p ON pv.san_pham_id = p.id
          WHERE pv.ma_sku = @ma_sku
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Product Variant Error:', error);
      throw error;
    }
  }

  // Tạo variant mới
  static async create(variantData) {
    try {
      const request = createRequest();
      const result = await request
        .input('san_pham_id', sql.UniqueIdentifier, variantData.san_pham_id)
        .input('ma_sku', sql.NVarChar(100), variantData.ma_sku)
        .input('ten_hien_thi', sql.NVarChar(255), variantData.ten_hien_thi)
        .input('gia_niem_yet', sql.Decimal(15, 2), variantData.gia_niem_yet)
        .input('gia_ban', sql.Decimal(15, 2), variantData.gia_ban)
        .input('so_luong_ton_kho', sql.Int, variantData.so_luong_ton_kho || 0)
        .input('luot_ban', sql.Int, variantData.luot_ban || 0)
        .input('anh_dai_dien', sql.NVarChar(500), variantData.anh_dai_dien || null)
        .input('site_origin', sql.NVarChar(10), variantData.site_origin || 'bac')
        .input('trang_thai', sql.Bit, variantData.trang_thai !== undefined ? variantData.trang_thai : 1)
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
      
      // Get the newly created variant by ma_sku (unique)
      const selectResult = await request.query(`
        SELECT TOP 1 * FROM product_variants 
        WHERE ma_sku = @ma_sku 
        ORDER BY ngay_tao DESC
      `);
      const createdVariant = selectResult.recordset[0];
      
      // Tự động đồng bộ inventory cho variant vừa tạo
      if (createdVariant && createdVariant.id && variantData.site_origin) {
        try {
          await Inventory.syncInventoryForVariant(
            createdVariant.id,
            variantData.site_origin,
            variantData.so_luong_ton_kho || 0
          );
        } catch (invError) {
          console.error('⚠️ Lỗi đồng bộ inventory:', invError);
          // Không throw error - variant đã tạo thành công
        }
      }
      
      return createdVariant;
    } catch (error) {
      console.error('SQL Product Variant Create Error:', error);
      throw error;
    }
  }

  // Cập nhật variant
  static async update(variantData, id) {
    try {
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      
      const setClauses = [];
      
      const validFields = [
        'ma_sku', 'ten_hien_thi', 'gia_niem_yet', 'gia_ban',
        'so_luong_ton_kho', 'luot_ban', 'anh_dai_dien',
        'site_origin', 'trang_thai'
      ];

      validFields.forEach(field => {
        if (variantData[field] !== undefined && variantData[field] !== null) {
          setClauses.push(`${field} = @${field}`);
          
          if (field === 'gia_niem_yet' || field === 'gia_ban') {
            request.input(field, sql.Decimal(15, 2), variantData[field]);
          } else if (field === 'so_luong_ton_kho' || field === 'luot_ban') {
            request.input(field, sql.Int, variantData[field]);
          } else if (field === 'trang_thai') {
            request.input(field, sql.Bit, variantData[field]);
          } else {
            request.input(field, sql.NVarChar(sql.MAX), variantData[field]);
          }
        }
      });
      
      if (setClauses.length === 0) {
        throw new Error('No fields to update');
      }
      
      setClauses.push('ngay_cap_nhat = GETDATE()');
      
      const sqlQuery = `
        UPDATE product_variants 
        SET ${setClauses.join(', ')}
        WHERE id = @id
      `;
      
      await request.query(sqlQuery);
      
      // Get updated variant
      const selectResult = await request.query(`SELECT * FROM product_variants WHERE id = @id`);
      const updatedVariant = selectResult.recordset[0];
      
      // Đồng bộ inventory nếu so_luong_ton_kho hoặc site_origin được update
      if (updatedVariant && (variantData.so_luong_ton_kho !== undefined || variantData.site_origin)) {
        try {
          await Inventory.syncInventoryForVariant(
            updatedVariant.id,
            updatedVariant.site_origin,
            updatedVariant.so_luong_ton_kho || 0
          );
        } catch (invError) {
          console.error('⚠️ Lỗi đồng bộ inventory:', invError);
          // Không throw error - variant đã update thành công
        }
      }
      
      return updatedVariant;
    } catch (error) {
      console.error('SQL Product Variant Update Error:', error);
      throw error;
    }
  }

  // Xóa variant
  static async delete(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM product_variants WHERE id = @id');
      
      return result.rowsAffected[0] > 0;
    } catch (error) {
      console.error('SQL Product Variant Delete Error:', error);
      throw error;
    }
  }

  // Lấy khoảng giá (min/max) của một product
  static async getPriceRange(productId) {
    try {
      const request = createRequest();
      const result = await request
        .input('san_pham_id', sql.UniqueIdentifier, productId)
        .query(`
          SELECT 
            MIN(gia_ban) as gia_ban_min,
            MAX(gia_ban) as gia_ban_max,
            MIN(gia_niem_yet) as gia_niem_yet_min,
            MAX(gia_niem_yet) as gia_niem_yet_max,
            SUM(so_luong_ban) as tong_so_luong_ban
          FROM product_variants
          WHERE san_pham_id = @san_pham_id AND trang_thai = 1
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Product Variant Price Range Error:', error);
      throw error;
    }
  }

  // Kiểm tra SKU có tồn tại không (để tránh duplicate)
  static async checkSKUExists(ma_sku, excludeId = null) {
    try {
      const request = createRequest();
      request.input('ma_sku', sql.NVarChar(100), ma_sku);
      
      let query = 'SELECT COUNT(*) as count FROM product_variants WHERE ma_sku = @ma_sku';
      
      if (excludeId) {
        request.input('excludeId', sql.UniqueIdentifier, excludeId);
        query += ' AND id != @excludeId';
      }
      
      const result = await request.query(query);
      return result.recordset[0].count > 0;
    } catch (error) {
      console.error('SQL Product Variant Check SKU Error:', error);
      throw error;
    }
  }
}

// Model cho Flash Sale trong SQL Server
class SQLFlashSaleModel {
  static async findAll(pool = null, filters = {}) {
    try {
      const request = createRequest(pool);
      let whereClause = 'WHERE 1=1';
      
      if (filters.trang_thai) {
        request.input('trang_thai', sql.NVarChar(20), filters.trang_thai);
        whereClause += ' AND fs.trang_thai = @trang_thai';
      }
      
      if (filters.search) {
        request.input('search', sql.NVarChar(255), `%${filters.search}%`);
        whereClause += ' AND fs.ten_flash_sale LIKE @search';
      }
      
      const query = `
        SELECT 
          fs.*,
          (SELECT COUNT(*) FROM flash_sale_items WHERE flash_sale_id = fs.id) as variant_count,
          (SELECT COUNT(*) FROM flash_sale_items WHERE flash_sale_id = fs.id) as so_san_pham,
          (SELECT ISNULL(SUM(da_ban), 0) FROM flash_sale_items WHERE flash_sale_id = fs.id) as tong_da_ban,
          (SELECT ISNULL(SUM(da_ban * gia_flash_sale), 0) FROM flash_sale_items WHERE flash_sale_id = fs.id) as doanh_thu
        FROM flash_sales fs
        ${whereClause}
        ORDER BY fs.ngay_tao DESC
      `;
      
      const result = await request.query(query);
      return result.recordset;
    } catch (error) {
      console.error('SQL Flash Sale Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            fs.*,
            (SELECT COUNT(*) FROM flash_sale_items WHERE flash_sale_id = fs.id) as variant_count,
            (SELECT COUNT(*) FROM flash_sale_items WHERE flash_sale_id = fs.id) as so_san_pham,
            (SELECT ISNULL(SUM(da_ban), 0) FROM flash_sale_items WHERE flash_sale_id = fs.id) as tong_da_ban,
            (SELECT ISNULL(SUM(da_ban * gia_flash_sale), 0) FROM flash_sale_items WHERE flash_sale_id = fs.id) as doanh_thu
          FROM flash_sales fs
          WHERE fs.id = @id
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Error:', error);
      throw error;
    }
  }

  static async create(flashSaleData) {
    try {
      const request = createRequest();
      request
        .input('ten_flash_sale', sql.NVarChar(255), flashSaleData.ten_flash_sale)
        .input('mo_ta', sql.NVarChar(500), flashSaleData.mo_ta || null)
        .input('ngay_bat_dau', sql.DateTime2, new Date(flashSaleData.ngay_bat_dau))
        .input('ngay_ket_thuc', sql.DateTime2, new Date(flashSaleData.ngay_ket_thuc))
        .input('vung_id', sql.NVarChar(20), flashSaleData.vung_id || null)
        .input('trang_thai', sql.NVarChar(20), flashSaleData.trang_thai || 'cho');
      
      // Chỉ thêm nguoi_tao nếu có giá trị hợp lệ
      if (flashSaleData.nguoi_tao) {
        request.input('nguoi_tao', sql.UniqueIdentifier, flashSaleData.nguoi_tao);
      }
      
      const query = flashSaleData.nguoi_tao
        ? `INSERT INTO flash_sales (ten_flash_sale, mo_ta, ngay_bat_dau, ngay_ket_thuc, vung_id, trang_thai, nguoi_tao)
           VALUES (@ten_flash_sale, @mo_ta, @ngay_bat_dau, @ngay_ket_thuc, @vung_id, @trang_thai, @nguoi_tao)`
        : `INSERT INTO flash_sales (ten_flash_sale, mo_ta, ngay_bat_dau, ngay_ket_thuc, vung_id, trang_thai)
           VALUES (@ten_flash_sale, @mo_ta, @ngay_bat_dau, @ngay_ket_thuc, @vung_id, @trang_thai)`;
      
      await request.query(query);
      
      // Get newly created flash sale
      const selectResult = await request.query(`
        SELECT TOP 1 * FROM flash_sales 
        WHERE ten_flash_sale = @ten_flash_sale 
        ORDER BY ngay_tao DESC
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Create Error:', error);
      throw error;
    }
  }

  static async update(id, updateData) {
    try {
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      
      // Build dynamic UPDATE query
      const updates = [];
      
      if (updateData.ten_flash_sale !== undefined) {
        request.input('ten_flash_sale', sql.NVarChar(255), updateData.ten_flash_sale);
        updates.push('ten_flash_sale = @ten_flash_sale');
      }
      
      if (updateData.mo_ta !== undefined) {
        request.input('mo_ta', sql.NVarChar(500), updateData.mo_ta || null);
        updates.push('mo_ta = @mo_ta');
      }
      
      if (updateData.ngay_bat_dau !== undefined) {
        request.input('ngay_bat_dau', sql.DateTime2, new Date(updateData.ngay_bat_dau));
        updates.push('ngay_bat_dau = @ngay_bat_dau');
      }
      
      if (updateData.ngay_ket_thuc !== undefined) {
        request.input('ngay_ket_thuc', sql.DateTime2, new Date(updateData.ngay_ket_thuc));
        updates.push('ngay_ket_thuc = @ngay_ket_thuc');
      }
      
      if (updateData.vung_id !== undefined) {
        request.input('vung_id', sql.NVarChar(20), updateData.vung_id);
        updates.push('vung_id = @vung_id');
      }
      
      if (updateData.trang_thai !== undefined) {
        request.input('trang_thai', sql.NVarChar(20), updateData.trang_thai);
        updates.push('trang_thai = @trang_thai');
      }
      
      if (updateData.mongo_flash_sale_detail_id !== undefined) {
        request.input('mongo_flash_sale_detail_id', sql.NVarChar(255), updateData.mongo_flash_sale_detail_id);
        updates.push('mongo_flash_sale_detail_id = @mongo_flash_sale_detail_id');
      }
      
      if (updates.length === 0) {
        throw new Error('No fields to update');
      }
      
      updates.push('ngay_cap_nhat = GETDATE()');
      
      const result = await request.query(`
        UPDATE flash_sales 
        SET ${updates.join(', ')}
        WHERE id = @id;
        
        SELECT * FROM flash_sales WHERE id = @id;
      `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Update Error:', error);
      throw error;
    }
  }

  static async destroy(id) {
    try {
      const request = createRequest();
      await request
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM flash_sales WHERE id = @id');
      return { success: true };
    } catch (error) {
      console.error('SQL Flash Sale Delete Error:', error);
      throw error;
    }
  }
}

// Model cho Flash Sale Items
class SQLFlashSaleItemModel {
  // Lấy flash sale items theo flash_sale_id
  static async findByFlashSaleId(flashSaleId) {
    try {
      const request = createRequest();
      const result = await request
        .input('flashSaleId', sql.UniqueIdentifier, flashSaleId)
        .query(`
          SELECT 
            id,
            flash_sale_id,
            variant_id as san_pham_id,
            gia_goc,
            gia_flash_sale,
            so_luong_ton,
            da_ban,
            gioi_han_mua,
            thu_tu,
            trang_thai
          FROM flash_sale_items
          WHERE flash_sale_id = @flashSaleId
          ORDER BY id
        `);
      return result.recordset;
    } catch (error) {
      console.error('SQL Flash Sale Items Error:', error);
      throw error;
    }
  }

  // Tìm tất cả flash sale items đang active của 1 sản phẩm (có thể nhiều variants)
  static async findActiveByProductId(productId) {
    try {
      const request = createRequest();
      const result = await request
        .input('productId', sql.UniqueIdentifier, productId)
        .query(`
          SELECT 
            fsi.*,
            fs.ten_flash_sale,
            fs.ngay_bat_dau,
            fs.ngay_ket_thuc,
            pv.ten_hien_thi as ten_variant,
            pv.ma_sku,
            pv.so_luong_ton_kho as ton_kho_variant
          FROM flash_sale_items fsi
          INNER JOIN flash_sales fs ON fsi.flash_sale_id = fs.id
          INNER JOIN product_variants pv ON fsi.variant_id = pv.id
          WHERE pv.san_pham_id = @productId
            AND fs.trang_thai = 'dang_dien_ra'
            AND fs.ngay_bat_dau <= GETDATE()
            AND fs.ngay_ket_thuc > GETDATE()
            AND fsi.trang_thai = 'dang_ban'
            AND (fsi.so_luong_ton - fsi.da_ban) > 0
          ORDER BY fs.ngay_bat_dau DESC, pv.ten_hien_thi
        `);
      return result.recordset; // Trả về array thay vì 1 item
    } catch (error) {
      console.error('SQL Flash Sale Item findActiveByProductId Error:', error);
      throw error;
    }
  }

  // Tìm flash sale item theo variant_id cụ thể
  static async findActiveByVariantId(variantId) {
    try {
      const request = createRequest();
      const result = await request
        .input('variantId', sql.UniqueIdentifier, variantId)
        .query(`
          SELECT TOP 1
            fsi.*,
            fs.ten_flash_sale,
            fs.ngay_bat_dau,
            fs.ngay_ket_thuc
          FROM flash_sale_items fsi
          INNER JOIN flash_sales fs ON fsi.flash_sale_id = fs.id
          WHERE fsi.variant_id = @variantId
            AND fs.trang_thai = 'dang_dien_ra'
            AND fs.ngay_bat_dau <= GETDATE()
            AND fs.ngay_ket_thuc > GETDATE()
            AND fsi.trang_thai = 'dang_ban'
            AND (fsi.so_luong_ton - fsi.da_ban) > 0
          ORDER BY fs.ngay_bat_dau DESC
        `);
      return result.recordset[0] || null;
    } catch (error) {
      console.error('SQL Flash Sale Item findActiveByVariantId Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT * FROM flash_sale_items WHERE id = @id');
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Item Error:', error);
      throw error;
    }
  }

  static async create(itemData) {
    try {
      const request = createRequest();
      
      // Chỉ hỗ trợ variant_id (bỏ inventory_id)
      if (!itemData.variant_id) {
        throw new Error('Phải cung cấp variant_id');
      }
      
      const variantId = itemData.variant_id;
      
      const request2 = createRequest();
      const result = await request2
        .input('flash_sale_id', sql.UniqueIdentifier, itemData.flash_sale_id)
        .input('variant_id', sql.UniqueIdentifier, variantId)
        .input('gia_goc', sql.Decimal(15, 2), itemData.gia_goc)
        .input('gia_flash_sale', sql.Decimal(15, 2), itemData.gia_flash_sale)
        .input('so_luong_ton', sql.Int, itemData.so_luong_ton || 0)
        .input('da_ban', sql.Int, itemData.da_ban || 0)
        .input('gioi_han_mua', sql.Int, itemData.gioi_han_mua || null)
        .input('thu_tu', sql.Int, itemData.thu_tu || 0)
        .input('trang_thai', sql.NVarChar(20), itemData.trang_thai || 'dang_ban')
        .query(`
          INSERT INTO flash_sale_items 
          (flash_sale_id, variant_id, gia_goc, gia_flash_sale, so_luong_ton, da_ban, gioi_han_mua, thu_tu, trang_thai)
          VALUES (@flash_sale_id, @variant_id, @gia_goc, @gia_flash_sale, @so_luong_ton, @da_ban, @gioi_han_mua, @thu_tu, @trang_thai)
        `);
      
      // Get newly created item
      const selectResult = await request2.query(`
        SELECT TOP 1 * FROM flash_sale_items 
        WHERE flash_sale_id = @flash_sale_id AND variant_id = @variant_id 
        ORDER BY ngay_tao DESC
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Item Create Error:', error);
      throw error;
    }
  }

  static async update(id, updateData) {
    try {
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      request.input('gia_goc', sql.Decimal(15, 2), updateData.gia_goc);
      request.input('gia_flash_sale', sql.Decimal(15, 2), updateData.gia_flash_sale);
      request.input('so_luong_ton', sql.Int, updateData.so_luong_ton);
      request.input('gioi_han_mua', sql.Int, updateData.gioi_han_mua || null);
      request.input('thu_tu', sql.Int, updateData.thu_tu || 0);
      request.input('trang_thai', sql.NVarChar(20), updateData.trang_thai);
      
      const result = await request.query(`
        UPDATE flash_sale_items 
        SET 
          gia_goc = @gia_goc,
          gia_flash_sale = @gia_flash_sale,
          so_luong_ton = @so_luong_ton,
          gioi_han_mua = @gioi_han_mua,
          thu_tu = @thu_tu,
          trang_thai = @trang_thai,
          ngay_cap_nhat = GETDATE()
        WHERE id = @id;
        
        SELECT * FROM flash_sale_items WHERE id = @id;
      `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Item Update Error:', error);
      throw error;
    }
  }

  static async increaseSold(id, quantity) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .input('quantity', sql.Int, quantity)
        .query(`
          UPDATE flash_sale_items
          SET da_ban = da_ban + @quantity,
              ngay_cap_nhat = GETDATE()
          WHERE id = @id AND (so_luong_ton - da_ban) >= @quantity;
          
          SELECT * FROM flash_sale_items WHERE id = @id;
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Flash Sale Item increaseSold Error:', error);
      throw error;
    }
  }

  static async destroy(id) {
    try {
      const request = createRequest();
      await request
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM flash_sale_items WHERE id = @id');
      return { success: true };
    } catch (error) {
      console.error('SQL Flash Sale Item Delete Error:', error);
      throw error;
    }
  }

  // Delete all items for a flash sale
  static async deleteByFlashSaleId(flashSaleId) {
    try {
      const request = createRequest();
      await request
        .input('flashSaleId', sql.UniqueIdentifier, flashSaleId)
        .query('DELETE FROM flash_sale_items WHERE flash_sale_id = @flashSaleId');
      return { success: true };
    } catch (error) {
      console.error('SQL Flash Sale Item deleteByFlashSaleId Error:', error);
      throw error;
    }
  }
}

// Model cho Region trong SQL Server
class SQLRegionModel {
  static async findAll(pool = null) {
    try {
      const request = createRequest(pool);
      const result = await request.query(`
        SELECT 
          r.*,
          (SELECT COUNT(*) FROM provinces WHERE vung_id = r.ma_vung AND trang_thai = 1) as so_tinh
        FROM regions r
        ORDER BY r.ma_vung ASC
      `);
      return result.recordset;
    } catch (error) {
      console.error('SQL Region Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            r.*,
            (SELECT COUNT(*) FROM provinces WHERE vung_id = r.ma_vung AND trang_thai = 1) as so_tinh
          FROM regions r
          WHERE r.id = @id
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Region Error:', error);
      throw error;
    }
  }

  static async create(regionData) {
    try {
      const request = createRequest();
      const result = await request
        .input('ma_vung', sql.NVarChar(50), regionData.ma_vung)
        .input('ten_vung', sql.NVarChar(100), regionData.ten_vung)
        .input('mo_ta', sql.NVarChar(500), regionData.mo_ta || null)
        .input('trang_thai', sql.Int, regionData.trang_thai !== undefined ? regionData.trang_thai : 1)
        .query(`
          INSERT INTO regions (ma_vung, ten_vung, mo_ta, trang_thai)
          VALUES (@ma_vung, @ten_vung, @mo_ta, @trang_thai)
        `);
      
      // Get newly created region
      const selectResult = await request.query(`
        SELECT TOP 1 * FROM regions WHERE ma_vung = @ma_vung ORDER BY ngay_tao DESC
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL Region Create Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Mã vùng đã tồn tại');
      }
      throw error;
    }
  }

  static async update(id, updateData) {
    try {
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      request.input('ma_vung', sql.NVarChar(50), updateData.ma_vung);
      request.input('ten_vung', sql.NVarChar(100), updateData.ten_vung);
      request.input('mo_ta', sql.NVarChar(500), updateData.mo_ta || null);
      request.input('trang_thai', sql.Int, updateData.trang_thai);

      const result = await request.query(`
        UPDATE regions 
        SET 
          ma_vung = @ma_vung,
          ten_vung = @ten_vung,
          mo_ta = @mo_ta,
          trang_thai = @trang_thai
        WHERE id = @id;
        
        SELECT 
          r.*,
          (SELECT COUNT(*) FROM provinces WHERE vung_id = r.ma_vung AND trang_thai = 1) as so_tinh
        FROM regions r
        WHERE r.id = @id;
      `);

      if (!result.recordset || result.recordset.length === 0) {
        throw new Error('Không tìm thấy vùng miền');
      }

      return result.recordset[0];
    } catch (error) {
      console.error('SQL Region Update Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Mã vùng đã tồn tại');
      }
      throw error;
    }
  }

  static async delete(id) {
    try {
      const request = createRequest();
      
      // Lấy ma_vung từ id
      const regionResult = await request
        .input('id', sql.UniqueIdentifier, id)
        .query('SELECT ma_vung FROM regions WHERE id = @id');
      
      if (!regionResult.recordset || regionResult.recordset.length === 0) {
        throw new Error('Không tìm thấy vùng miền');
      }
      
      const maVung = regionResult.recordset[0].ma_vung;
      
      // Kiểm tra có tỉnh/thành thuộc vùng này không
      const checkRequest = createRequest();
      const checkProvinces = await checkRequest
        .input('ma_vung', sql.NVarChar(10), maVung)
        .query(`
          SELECT COUNT(*) as count 
          FROM provinces 
          WHERE vung_id = @ma_vung AND trang_thai = 1
        `);

      if (checkProvinces.recordset[0].count > 0) {
        throw new Error('Không thể xóa vùng miền vì còn tỉnh/thành thuộc vùng này');
      }

      // Xóa vùng miền
      const deleteRequest = createRequest();
      await deleteRequest
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM regions WHERE id = @id');

      return { success: true };
    } catch (error) {
      console.error('SQL Region Delete Error:', error);
      throw error;
    }
  }
}

// Model cho Province trong SQL Server
class SQLProvinceModel {
  static async findAll(pool = null, filters = {}) {
    try {
      const request = createRequest(pool);
      let whereClause = 'WHERE p.trang_thai = 1';

      if (filters.vung_id) {
        request.input('vung_id', sql.NVarChar(10), filters.vung_id);
        whereClause += ' AND p.vung_id = @vung_id';
      }

      if (filters.trang_thai !== undefined) {
        whereClause = whereClause.replace('WHERE p.trang_thai = 1', 'WHERE 1=1');
        request.input('trang_thai', sql.Int, filters.trang_thai);
        whereClause += ' AND p.trang_thai = @trang_thai';
      }

      const result = await request.query(`
        SELECT 
          p.*,
          r.ten_vung,
          (SELECT COUNT(*) FROM wards WHERE tinh_thanh_id = p.id AND trang_thai = 1) as so_phuong_xa
        FROM provinces p
        INNER JOIN regions r ON p.vung_id = r.ma_vung
        ${whereClause}
        ORDER BY p.thu_tu_uu_tien DESC, p.ten_tinh ASC
      `);
      return result.recordset;
    } catch (error) {
      console.error('SQL Province Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            p.*,
            r.ten_vung,
            (SELECT COUNT(*) FROM wards WHERE tinh_thanh_id = p.id AND trang_thai = 1) as so_phuong_xa
          FROM provinces p
          INNER JOIN regions r ON p.vung_id = r.ma_vung
          WHERE p.id = @id
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Province Error:', error);
      throw error;
    }
  }

  static async create(provinceData) {
    try {
      const request = createRequest();
      const result = await request
        .input('ma_tinh', sql.NVarChar(50), provinceData.ma_tinh)
        .input('ten_tinh', sql.NVarChar(100), provinceData.ten_tinh)
        .input('vung_id', sql.NVarChar(10), provinceData.vung_id)
        .input('is_major_city', sql.Bit, provinceData.is_major_city || 0)
        .input('thu_tu_uu_tien', sql.Int, provinceData.thu_tu_uu_tien || 0)
        .input('trang_thai', sql.Bit, provinceData.trang_thai !== undefined ? provinceData.trang_thai : 1)
        .query(`
          INSERT INTO provinces (ma_tinh, ten_tinh, vung_id, is_major_city, thu_tu_uu_tien, trang_thai)
          VALUES (@ma_tinh, @ten_tinh, @vung_id, @is_major_city, @thu_tu_uu_tien, @trang_thai)
        `);
      
      // Get newly created province
      const selectResult = await request.query(`
        SELECT TOP 1 * FROM provinces WHERE ma_tinh = @ma_tinh ORDER BY ngay_tao DESC
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL Province Create Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Mã tỉnh đã tồn tại');
      }
      throw error;
    }
  }

  static async update(id, updateData) {
    try {
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      request.input('ma_tinh', sql.NVarChar(50), updateData.ma_tinh);
      request.input('ten_tinh', sql.NVarChar(100), updateData.ten_tinh);
      request.input('vung_id', sql.NVarChar(10), updateData.vung_id);
      request.input('is_major_city', sql.Bit, updateData.is_major_city || 0);
      request.input('thu_tu_uu_tien', sql.Int, updateData.thu_tu_uu_tien || 0);
      request.input('trang_thai', sql.Bit, updateData.trang_thai);

      const result = await request.query(`
        UPDATE provinces 
        SET 
          ma_tinh = @ma_tinh,
          ten_tinh = @ten_tinh,
          vung_id = @vung_id,
          is_major_city = @is_major_city,
          thu_tu_uu_tien = @thu_tu_uu_tien,
          trang_thai = @trang_thai
        WHERE id = @id;
        
        SELECT 
          p.*,
          r.ten_vung,
          (SELECT COUNT(*) FROM wards WHERE tinh_thanh_id = p.id AND trang_thai = 1) as so_phuong_xa
        FROM provinces p
        INNER JOIN regions r ON p.vung_id = r.ma_vung
        WHERE p.id = @id;
      `);

      if (!result.recordset || result.recordset.length === 0) {
        throw new Error('Không tìm thấy tỉnh/thành');
      }

      return result.recordset[0];
    } catch (error) {
      console.error('SQL Province Update Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Mã tỉnh đã tồn tại');
      }
      throw error;
    }
  }

  static async delete(id) {
    try {
      const request = createRequest();
      
      // Kiểm tra có phường/xã thuộc tỉnh này không
      const checkWards = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT COUNT(*) as count 
          FROM wards 
          WHERE tinh_thanh_id = @id AND trang_thai = 1
        `);

      if (checkWards.recordset[0].count > 0) {
        throw new Error('Không thể xóa tỉnh/thành vì còn phường/xã thuộc tỉnh này');
      }

      // Xóa tỉnh/thành
      const deleteRequest = createRequest();
      await deleteRequest
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM provinces WHERE id = @id');

      return { success: true };
    } catch (error) {
      console.error('SQL Province Delete Error:', error);
      throw error;
    }
  }
}

// Model cho Ward trong SQL Server
class SQLWardModel {
  static async findAll(pool = null, filters = {}) {
    try {
      const request = createRequest(pool);
      let whereClause = 'WHERE w.trang_thai = 1';

      if (filters.tinh_thanh_id) {
        request.input('tinh_thanh_id', sql.UniqueIdentifier, filters.tinh_thanh_id);
        whereClause += ' AND w.tinh_thanh_id = @tinh_thanh_id';
      }

      if (filters.loai) {
        request.input('loai', sql.NVarChar(50), filters.loai);
        whereClause += ' AND w.loai = @loai';
      }

      if (filters.trang_thai !== undefined) {
        whereClause = whereClause.replace('WHERE w.trang_thai = 1', 'WHERE 1=1');
        request.input('trang_thai', sql.Int, filters.trang_thai);
        whereClause += ' AND w.trang_thai = @trang_thai';
      }

      const result = await request.query(`
        SELECT 
          w.*,
          p.ten_tinh,
          r.ten_vung
        FROM wards w
        INNER JOIN provinces p ON w.tinh_thanh_id = p.id
        INNER JOIN regions r ON p.vung_id = r.ma_vung
        ${whereClause}
        ORDER BY p.ten_tinh ASC, w.ten_phuong_xa ASC
      `);
      return result.recordset;
    } catch (error) {
      console.error('SQL Ward Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            w.*,
            p.ten_tinh,
            r.ten_vung
          FROM wards w
          INNER JOIN provinces p ON w.tinh_thanh_id = p.id
          INNER JOIN regions r ON p.vung_id = r.ma_vung
          WHERE w.id = @id
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Ward Error:', error);
      throw error;
    }
  }

  static async create(wardData) {
    try {
      const request = createRequest();
      const result = await request
        .input('ma_phuong_xa', sql.NVarChar(50), wardData.ma_phuong_xa)
        .input('ten_phuong_xa', sql.NVarChar(100), wardData.ten_phuong_xa)
        .input('tinh_thanh_id', sql.UniqueIdentifier, wardData.tinh_thanh_id)
        .input('loai', sql.NVarChar(50), wardData.loai)
        .input('is_inner_area', sql.Bit, wardData.is_inner_area || 0)
        .input('trang_thai', sql.Bit, wardData.trang_thai !== undefined ? wardData.trang_thai : 1)
        .query(`
          INSERT INTO wards (ma_phuong_xa, ten_phuong_xa, tinh_thanh_id, loai, is_inner_area, trang_thai)
          VALUES (@ma_phuong_xa, @ten_phuong_xa, @tinh_thanh_id, @loai, @is_inner_area, @trang_thai)
        `);
      
      // Get newly created ward
      const selectResult = await request.query(`
        SELECT TOP 1 * FROM wards WHERE ma_phuong_xa = @ma_phuong_xa ORDER BY ngay_tao DESC
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL Ward Create Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Mã phường/xã đã tồn tại');
      }
      throw error;
    }
  }

  static async update(id, updateData) {
    try {
      const request = createRequest();
      request.input('id', sql.UniqueIdentifier, id);
      request.input('ma_phuong_xa', sql.NVarChar(50), updateData.ma_phuong_xa);
      request.input('ten_phuong_xa', sql.NVarChar(100), updateData.ten_phuong_xa);
      request.input('tinh_thanh_id', sql.UniqueIdentifier, updateData.tinh_thanh_id);
      request.input('loai', sql.NVarChar(50), updateData.loai);
      request.input('is_inner_area', sql.Bit, updateData.is_inner_area || 0);
      request.input('trang_thai', sql.Bit, updateData.trang_thai);

      const result = await request.query(`
        UPDATE wards 
        SET 
          ma_phuong_xa = @ma_phuong_xa,
          ten_phuong_xa = @ten_phuong_xa,
          tinh_thanh_id = @tinh_thanh_id,
          loai = @loai,
          is_inner_area = @is_inner_area,
          trang_thai = @trang_thai
        WHERE id = @id;
        
        SELECT 
          w.*,
          p.ten_tinh,
          r.ten_vung
        FROM wards w
        INNER JOIN provinces p ON w.tinh_thanh_id = p.id
        INNER JOIN regions r ON p.vung_id = r.ma_vung
        WHERE w.id = @id;
      `);

      if (!result.recordset || result.recordset.length === 0) {
        throw new Error('Không tìm thấy phường/xã');
      }

      return result.recordset[0];
    } catch (error) {
      console.error('SQL Ward Update Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Mã phường/xã đã tồn tại');
      }
      throw error;
    }
  }

  static async delete(id) {
    try {
      const request = createRequest();
      await request
        .input('id', sql.UniqueIdentifier, id)
        .query('DELETE FROM wards WHERE id = @id');

      return { success: true };
    } catch (error) {
      console.error('SQL Ward Delete Error:', error);
      throw error;
    }
  }
}

// Model cho User trong SQL Server
class SQLUserModel {
  static async findAll(pool = null, filters = {}) {
    try {
      const request = createRequest(pool);
      let whereConditions = [];
      
      if (filters.status !== undefined) {
        request.input('status', sql.Bit, filters.status);
        whereConditions.push('u.trang_thai = @status');
      }
      
      const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
      
      const query = `
        SELECT 
          u.id,
          u.ho_ten as name,
          u.email,
          u.so_dien_thoai as phone,
          u.vung_id,
          u.mongo_profile_id,
          u.trang_thai as status,
          u.ngay_dang_ky as created_at,
          u.ngay_cap_nhat as updated_at
        FROM users u
        ${whereClause}
        ORDER BY u.ngay_dang_ky DESC
      `;
      
      const result = await request.query(query);
      return result.recordset;
    } catch (error) {
      console.error('SQL User findAll Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            u.id,
            u.ho_ten as name,
            u.email,
            u.so_dien_thoai as phone,
            u.vung_id,
            u.mongo_profile_id,
            u.trang_thai as status,
            u.ngay_dang_ky as created_at,
            u.ngay_cap_nhat as updated_at
          FROM users u
          WHERE u.id = @id
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL User findById Error:', error);
      throw error;
    }
  }

  static async findByEmail(email) {
    try {
      const request = createRequest();
      const result = await request
        .input('email', sql.NVarChar(255), email)
        .query(`
          SELECT 
            u.id,
            u.ho_ten as name,
            u.email,
            u.so_dien_thoai as phone,
            u.vung_id,
            u.trang_thai as status,
            u.ngay_dang_ky as created_at,
            u.ngay_cap_nhat as updated_at
          FROM users u
          WHERE u.email = @email
        `);
      return result.recordset[0];
    } catch (error) {
      console.error('SQL User findByEmail Error:', error);
      throw error;
    }
  }

  static async create(userData) {
    try {
      const request = createRequest();
      
      request.input('ho_ten', sql.NVarChar(100), userData.name);
      request.input('email', sql.NVarChar(255), userData.email);
      request.input('so_dien_thoai', sql.NVarChar(20), userData.phone || null);
      request.input('mat_khau', sql.NVarChar(255), userData.password); // Should be hashed
      request.input('vung_id', sql.NVarChar(10), userData.vung_id || 'bac');
      request.input('trang_thai', sql.Bit, userData.status !== undefined ? userData.status : 1);
      
      const result = await request.query(`
        INSERT INTO users (ho_ten, email, so_dien_thoai, mat_khau, vung_id, trang_thai)
        VALUES (@ho_ten, @email, @so_dien_thoai, @mat_khau, @vung_id, @trang_thai)
      `);
      
      // Get newly created user
      const selectResult = await request.query(`
        SELECT 
          id, ho_ten as name, email, so_dien_thoai as phone, vung_id,
          trang_thai as status, ngay_dang_ky as created_at
        FROM users 
        WHERE email = @email
      `);
      return selectResult.recordset[0];
    } catch (error) {
      console.error('SQL User create Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Email đã tồn tại');
      }
      throw error;
    }
  }

  static async update(id, updateData) {
    try {
      const request = createRequest();
      
      request.input('id', sql.UniqueIdentifier, id);
      request.input('ho_ten', sql.NVarChar(100), updateData.name);
      request.input('email', sql.NVarChar(255), updateData.email);
      request.input('so_dien_thoai', sql.NVarChar(20), updateData.phone || null);
      request.input('vung_id', sql.NVarChar(10), updateData.vung_id || 'bac');
      request.input('trang_thai', sql.Bit, updateData.status);
      request.input('updated_at', sql.DateTime2, new Date());
      
      let passwordUpdate = '';
      if (updateData.password) {
        request.input('mat_khau', sql.NVarChar(255), updateData.password);
        passwordUpdate = ', mat_khau = @mat_khau';
      }
      
      let mongoProfileUpdate = '';
      if (updateData.mongo_profile_id) {
        request.input('mongo_profile_id', sql.NVarChar(50), updateData.mongo_profile_id);
        mongoProfileUpdate = ', mongo_profile_id = @mongo_profile_id';
      }
      
      const query = `
        UPDATE users 
        SET ho_ten = @ho_ten,
            email = @email,
            so_dien_thoai = @so_dien_thoai,
            vung_id = @vung_id,
            trang_thai = @trang_thai,
            ngay_cap_nhat = @updated_at
            ${passwordUpdate}
            ${mongoProfileUpdate}
        WHERE id = @id;
        
        SELECT 
          id,
          ho_ten as name,
          email,
          so_dien_thoai as phone,
          vung_id,
          mongo_profile_id,
          trang_thai as status,
          ngay_dang_ky as created_at,
          ngay_cap_nhat as updated_at
        FROM users WHERE id = @id;
      `;
      
      const result = await request.query(query);
      
      if (!result.recordset || result.recordset.length === 0) {
        throw new Error('Không tìm thấy người dùng');
      }
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL User update Error:', error);
      if (error.message && error.message.includes('UNIQUE')) {
        throw new Error('Email đã tồn tại');
      }
      throw error;
    }
  }

  static async updateStatus(id, status) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .input('status', sql.Bit, status)
        .input('updated_at', sql.DateTime2, new Date())
        .query(`
          UPDATE users 
          SET trang_thai = @status,
              ngay_cap_nhat = @updated_at
          WHERE id = @id;
          
          SELECT 
            id,
            ho_ten as name,
            email,
            so_dien_thoai as phone,
            vai_tro as role,
            trang_thai as status,
            ngay_dang_ky as created_at,
            ngay_cap_nhat as updated_at
          FROM users WHERE id = @id;
        `);
      
      if (!result.recordset || result.recordset.length === 0) {
        throw new Error('Không tìm thấy người dùng');
      }
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL User updateStatus Error:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const request = createRequest();
      
      // Soft delete - set status to 0
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .input('updated_at', sql.DateTime2, new Date())
        .query(`
          UPDATE users 
          SET trang_thai = 0,
              ngay_cap_nhat = @updated_at
          WHERE id = @id;
          
          SELECT @@ROWCOUNT as affected;
        `);
      
      return result.recordset[0].affected > 0;
    } catch (error) {
      console.error('SQL User delete Error:', error);
      throw error;
    }
  }
}

// ==================== INVENTORY MODEL ====================

class SQLInventoryModel {
  static async findAll(pool = null) {
    try {
      const request = createRequest(pool);
      const result = await request.query(`
        SELECT 
          i.*,
          pv.ma_sku,
          pv.ten_hien_thi as ten_variant,
          pv.gia_ban,
          pv.gia_niem_yet,
          p.ten_san_pham,
          p.link_anh_dai_dien,
          w.ten_kho,
          w.dia_chi_chi_tiet as dia_chi_kho
        FROM inventory i
        LEFT JOIN product_variants pv ON i.variant_id = pv.id
        LEFT JOIN products p ON pv.san_pham_id = p.id
        LEFT JOIN warehouses w ON i.kho_id = w.id
        ORDER BY i.ngay_tao DESC
      `);
      
      return result.recordset;
    } catch (error) {
      console.error('SQL Inventory findAll Error:', error);
      throw error;
    }
  }

  static async findById(id, requestPool = null) {
    try {
      const pool = getPool(requestPool);
      const request = createRequest(pool);
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            i.*,
            pv.ma_sku,
            pv.ten_hien_thi as ten_variant,
            pv.gia_ban,
            pv.gia_niem_yet,
            p.ten_san_pham,
            p.link_anh_dai_dien,
            w.ten_kho,
            w.dia_chi_chi_tiet as dia_chi_kho
          FROM inventory i
          LEFT JOIN product_variants pv ON i.variant_id = pv.id
          LEFT JOIN products p ON pv.san_pham_id = p.id
          LEFT JOIN warehouses w ON i.kho_id = w.id
          WHERE i.id = @id
        `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Inventory findById Error:', error);
      throw error;
    }
  }

  static async findByProduct(productId) {
    try {
      const request = createRequest();
      const result = await request
        .input('product_id', sql.UniqueIdentifier, productId)
        .query(`
          SELECT 
            i.*,
            w.ten_kho,
            w.dia_chi_chi_tiet as dia_chi_kho
          FROM inventory i
          LEFT JOIN warehouses w ON i.kho_id = w.id
          LEFT JOIN product_variants pv ON i.variant_id = pv.id
          WHERE pv.san_pham_id = @product_id
        `);
      
      return result.recordset;
    } catch (error) {
      console.error('SQL Inventory findByProduct Error:', error);
      throw error;
    }
  }

  static async findByVariant(variantId) {
    try {
      const request = createRequest();
      const result = await request
        .input('variant_id', sql.UniqueIdentifier, variantId)
        .query(`
          SELECT 
            i.*,
            w.ten_kho,
            w.vung_id,
            w.dia_chi_chi_tiet as dia_chi_kho
          FROM inventory i
          LEFT JOIN warehouses w ON i.kho_id = w.id
          WHERE i.variant_id = @variant_id
        `);
      
      return result.recordset;
    } catch (error) {
      console.error('SQL Inventory findByVariant Error:', error);
      throw error;
    }
  }

  // Tìm inventory theo bien_the_san_pham_id (trả về 1 record đầu tiên)
  static async findByVariantId(variantId) {
    try {
      const request = createRequest();
      const result = await request
        .input('variant_id', sql.UniqueIdentifier, variantId)
        .query(`
          SELECT TOP 1
            i.*,
            w.ten_kho,
            w.vung_id,
            w.dia_chi_chi_tiet as dia_chi_kho
          FROM inventory i
          LEFT JOIN warehouses w ON i.kho_id = w.id
          WHERE i.variant_id = @variant_id
          ORDER BY i.ngay_cap_nhat DESC
        `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Inventory findByVariantId Error:', error);
      throw error;
    }
  }

  // Tính tổng tồn kho của 1 variant (tổng tất cả kho)
  static async getTotalStockByVariant(variantId) {
    try {
      const request = createRequest();
      const result = await request
        .input('variant_id', sql.UniqueIdentifier, variantId)
        .query(`
          SELECT 
            ISNULL(SUM(so_luong_kha_dung), 0) as tong_ton_kho
          FROM inventory
          WHERE variant_id = @variant_id
        `);
      
      return result.recordset[0]?.tong_ton_kho || 0;
    } catch (error) {
      console.error('SQL Inventory getTotalStockByVariant Error:', error);
      throw error;
    }
  }

  static async getTotalStockByProduct(productId) {
    try {
      const request = createRequest();
      const result = await request
        .input('product_id', sql.UniqueIdentifier, productId)
        .query(`
          SELECT 
            ISNULL(SUM(i.so_luong_kha_dung), 0) as tong_ton_kho
          FROM inventory i
          INNER JOIN product_variants pv ON i.variant_id = pv.id
          WHERE pv.san_pham_id = @product_id
        `);
      
      return result.recordset[0]?.tong_ton_kho || 0;
    } catch (error) {
      console.error('SQL Inventory getTotalStockByProduct Error:', error);
      throw error;
    }
  }

  // Đồng bộ inventory khi tạo/update variant
  // Tự động tạo/update inventory record cho kho của vùng đó
  static async syncInventoryForVariant(variantId, siteOrigin, stockQuantity) {
    try {
      // 1. Tìm kho của vùng
      const warehouseRequest = createRequest();
      const warehouseResult = await warehouseRequest
        .input('vung_id', sql.NVarChar(10), siteOrigin)
        .query(`
          SELECT id FROM warehouses WHERE vung_id = @vung_id AND trang_thai = 1
        `);
      
      if (!warehouseResult.recordset || warehouseResult.recordset.length === 0) {
        console.warn(`⚠️ Không tìm thấy kho cho vùng ${siteOrigin}`);
        return null;
      }
      
      const warehouseId = warehouseResult.recordset[0].id;
      
      // 2. Kiểm tra inventory đã tồn tại chưa
      const checkRequest = createRequest();
      const checkResult = await checkRequest
        .input('variant_id', sql.UniqueIdentifier, variantId)
        .input('kho_id', sql.UniqueIdentifier, warehouseId)
        .query(`
          SELECT id FROM inventory WHERE variant_id = @variant_id AND kho_id = @kho_id
        `);
      
      if (checkResult.recordset && checkResult.recordset.length > 0) {
        // 3a. Đã tồn tại → UPDATE
        const inventoryId = checkResult.recordset[0].id;
        const updateRequest = createRequest();
        await updateRequest
          .input('id', sql.UniqueIdentifier, inventoryId)
          .input('so_luong_kha_dung', sql.Int, stockQuantity)
          .query(`
            UPDATE inventory
            SET so_luong_kha_dung = @so_luong_kha_dung,
                lan_nhap_hang_cuoi = GETDATE(),
                ngay_cap_nhat = GETDATE()
            WHERE id = @id
          `);
        
        console.log(`✅ Updated inventory ${inventoryId} for variant ${variantId} in warehouse ${warehouseId}`);
        return { action: 'updated', inventoryId };
      } else {
        // 3b. Chưa tồn tại → CREATE
        const createRequest = createRequest();
        const createResult = await createRequest
          .input('variant_id', sql.UniqueIdentifier, variantId)
          .input('kho_id', sql.UniqueIdentifier, warehouseId)
          .input('so_luong_kha_dung', sql.Int, stockQuantity)
          .input('so_luong_da_dat', sql.Int, 0)
          .input('muc_ton_kho_toi_thieu', sql.Int, 10)
          .input('so_luong_nhap_lai', sql.Int, 50)
          .input('lan_nhap_hang_cuoi', sql.DateTime2, new Date())
          .query(`
            INSERT INTO inventory (
              variant_id, kho_id, so_luong_kha_dung, so_luong_da_dat,
              muc_ton_kho_toi_thieu, so_luong_nhap_lai, lan_nhap_hang_cuoi
            )
            VALUES (
              @variant_id, @kho_id, @so_luong_kha_dung, @so_luong_da_dat,
              @muc_ton_kho_toi_thieu, @so_luong_nhap_lai, @lan_nhap_hang_cuoi
            )
          `);
        
        // Get newly created inventory
        const selectResult = await createRequest.query(`
          SELECT TOP 1 id FROM inventory 
          WHERE variant_id = @variant_id AND kho_id = @kho_id
          ORDER BY ngay_tao DESC
        `);
        const inventoryId = selectResult.recordset[0].id;
        console.log(`✅ Created inventory ${inventoryId} for variant ${variantId} in warehouse ${warehouseId}`);
        return { action: 'created', inventoryId };
      }
    } catch (error) {
      console.error('SQL Inventory syncInventoryForVariant Error:', error);
      throw error;
    }
  }

  static async decreaseStock(inventoryId, quantity, options = {}) {
    try {
      const request = options.transaction ? new sql.Request(options.transaction) : createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, inventoryId)
        .input('quantity', sql.Int, quantity)
        .query(`
          UPDATE inventory
          SET so_luong_kha_dung = so_luong_kha_dung - @quantity,
              ngay_cap_nhat = GETDATE()
          WHERE id = @id AND so_luong_kha_dung >= @quantity;
          
          SELECT * FROM inventory WHERE id = @id;
        `);
      
      if (!result.recordset[0]) {
        throw new Error('Không đủ tồn kho');
      }
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Inventory decreaseStock Error:', error);
      throw error;
    }
  }

  static async findByWarehouse(warehouseId) {
    try {
      const request = createRequest();
      const result = await request
        .input('warehouse_id', sql.UniqueIdentifier, warehouseId)
        .query(`
          SELECT 
            i.*,
            pv.ten_hien_thi,
            pv.ma_sku,
            p.ten_san_pham
          FROM inventory i
          LEFT JOIN product_variants pv ON i.variant_id = pv.id
          LEFT JOIN products p ON pv.san_pham_id = p.id
          WHERE i.kho_id = @warehouse_id
        `);
      
      return result.recordset;
    } catch (error) {
      console.error('SQL Inventory findByWarehouse Error:', error);
      throw error;
    }
  }

  static async countByWarehouse(warehouseId) {
    try {
      const request = createRequest();
      const result = await request
        .input('warehouse_id', sql.UniqueIdentifier, warehouseId)
        .query(`
          SELECT COUNT(*) as count
          FROM inventory
          WHERE kho_id = @warehouse_id
        `);
      
      return result.recordset[0].count;
    } catch (error) {
      console.error('SQL Inventory countByWarehouse Error:', error);
      throw error;
    }
  }

  static async create(inventoryData) {
    try {
      const request = createRequest();
      const id = inventoryData.id || uuidv4();
      
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .input('variant_id', sql.UniqueIdentifier, inventoryData.variant_id)
        .input('kho_id', sql.UniqueIdentifier, inventoryData.kho_id)
        .input('so_luong_kha_dung', sql.Int, inventoryData.so_luong_kha_dung || 0)
        .input('so_luong_da_dat', sql.Int, inventoryData.so_luong_da_dat || 0)
        .input('muc_ton_kho_toi_thieu', sql.Int, inventoryData.muc_ton_kho_toi_thieu || 10)
        .input('so_luong_nhap_lai', sql.Int, inventoryData.so_luong_nhap_lai || 50)
        .input('lan_nhap_hang_cuoi', sql.DateTime2, inventoryData.lan_nhap_hang_cuoi || new Date())
        .input('ngay_tao', sql.DateTime2, new Date())
        .input('ngay_cap_nhat', sql.DateTime2, new Date())
        .query(`
          INSERT INTO inventory (
            id, variant_id, kho_id, so_luong_kha_dung, so_luong_da_dat,
            muc_ton_kho_toi_thieu, so_luong_nhap_lai, lan_nhap_hang_cuoi,
            ngay_tao, ngay_cap_nhat
          )
          VALUES (
            @id, @variant_id, @kho_id, @so_luong_kha_dung, @so_luong_da_dat,
            @muc_ton_kho_toi_thieu, @so_luong_nhap_lai, @lan_nhap_hang_cuoi,
            @ngay_tao, @ngay_cap_nhat
          );
          
          SELECT 
            i.*,
            pv.ten_hien_thi,
            w.ten_kho
          FROM inventory i
          LEFT JOIN product_variants pv ON i.variant_id = pv.id
          LEFT JOIN warehouses w ON i.kho_id = w.id
          WHERE i.id = @id;
        `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Inventory create Error:', error);
      throw error;
    }
  }

  static async update(id, inventoryData, requestPool = null) {
    try {
      const pool = getPool(requestPool);
      const request = createRequest(pool);
      
      let updateFields = [];
      
      if (inventoryData.variant_id !== undefined) {
        request.input('variant_id', sql.UniqueIdentifier, inventoryData.variant_id);
        updateFields.push('variant_id = @variant_id');
      }
      
      if (inventoryData.kho_id !== undefined) {
        request.input('kho_id', sql.UniqueIdentifier, inventoryData.kho_id);
        updateFields.push('kho_id = @kho_id');
      }
      
      if (inventoryData.so_luong_kha_dung !== undefined) {
        request.input('so_luong_kha_dung', sql.Int, inventoryData.so_luong_kha_dung);
        updateFields.push('so_luong_kha_dung = @so_luong_kha_dung');
      }
      
      if (inventoryData.so_luong_da_dat !== undefined) {
        request.input('so_luong_da_dat', sql.Int, inventoryData.so_luong_da_dat);
        updateFields.push('so_luong_da_dat = @so_luong_da_dat');
      }
      
      if (inventoryData.muc_ton_kho_toi_thieu !== undefined) {
        request.input('muc_ton_kho_toi_thieu', sql.Int, inventoryData.muc_ton_kho_toi_thieu);
        updateFields.push('muc_ton_kho_toi_thieu = @muc_ton_kho_toi_thieu');
      }
      
      if (inventoryData.so_luong_nhap_lai !== undefined) {
        request.input('so_luong_nhap_lai', sql.Int, inventoryData.so_luong_nhap_lai);
        updateFields.push('so_luong_nhap_lai = @so_luong_nhap_lai');
      }
      
      if (inventoryData.lan_nhap_hang_cuoi !== undefined) {
        request.input('lan_nhap_hang_cuoi', sql.DateTime2, inventoryData.lan_nhap_hang_cuoi);
        updateFields.push('lan_nhap_hang_cuoi = @lan_nhap_hang_cuoi');
      }
      
      updateFields.push('ngay_cap_nhat = @ngay_cap_nhat');
      request.input('ngay_cap_nhat', sql.DateTime2, new Date());
      request.input('id', sql.UniqueIdentifier, id);
      
      const result = await request.query(`
        UPDATE inventory 
        SET ${updateFields.join(', ')}
        WHERE id = @id;
        
        SELECT 
          i.*,
          pv.ten_hien_thi,
          w.ten_kho
        FROM inventory i
        LEFT JOIN product_variants pv ON i.variant_id = pv.id
        LEFT JOIN warehouses w ON i.kho_id = w.id
        WHERE i.id = @id;
      `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Inventory update Error:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const request = createRequest();
      
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          DELETE FROM inventory WHERE id = @id;
          SELECT @@ROWCOUNT as affected;
        `);
      
      return result.recordset[0].affected > 0;
    } catch (error) {
      console.error('SQL Inventory delete Error:', error);
      throw error;
    }
  }
}

// ==================== WAREHOUSE MODEL ====================

class SQLWarehouseModel {
  static async findAll(pool = null) {
    try {
      const request = createRequest(pool);
      const result = await request.query(`
        SELECT 
          w.id,
          w.ten_kho,
          w.vung_id,
          w.phuong_xa_id,
          w.dia_chi_chi_tiet,
          w.so_dien_thoai,
          w.trang_thai,
          w.priority_levels,
          w.is_primary,
          w.ngay_tao,
          w.ngay_cap_nhat,
          ward.ten_phuong_xa,
          ward.tinh_thanh_id,
          p.ten_tinh,
          p.vung_id as province_vung_id,
          r.ten_vung,
          COUNT(i.id) as so_luong_san_pham
        FROM warehouses w
        LEFT JOIN inventory i ON w.id = i.kho_id
        LEFT JOIN wards ward ON w.phuong_xa_id = ward.id
        LEFT JOIN provinces p ON ward.tinh_thanh_id = p.id
        LEFT JOIN regions r ON p.vung_id = r.ma_vung
        GROUP BY w.id, w.ten_kho, w.vung_id, w.phuong_xa_id, w.dia_chi_chi_tiet, 
                 w.so_dien_thoai, w.trang_thai, w.priority_levels, w.is_primary, 
                 w.ngay_tao, w.ngay_cap_nhat,
                 ward.ten_phuong_xa, ward.tinh_thanh_id, p.ten_tinh, p.vung_id, r.ten_vung
        ORDER BY w.ngay_tao DESC
      `);
      
      return result.recordset;
    } catch (error) {
      console.error('SQL Warehouse findAll Error:', error);
      throw error;
    }
  }

  static async findById(id) {
    try {
      const request = createRequest();
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          SELECT 
            w.id,
            w.ten_kho,
            w.vung_id,
            w.phuong_xa_id,
            w.dia_chi_chi_tiet,
            w.so_dien_thoai,
            w.trang_thai,
            w.priority_levels,
            w.is_primary,
            w.ngay_tao,
            w.ngay_cap_nhat,
            ward.ten_phuong_xa,
            ward.tinh_thanh_id,
            p.ten_tinh,
            p.vung_id as province_vung_id,
            r.ten_vung,
            COUNT(i.id) as so_luong_san_pham
          FROM warehouses w
          LEFT JOIN inventory i ON w.id = i.kho_id
          LEFT JOIN wards ward ON w.phuong_xa_id = ward.id
          LEFT JOIN provinces p ON ward.tinh_thanh_id = p.id
          LEFT JOIN regions r ON p.vung_id = r.ma_vung
          WHERE w.id = @id
          GROUP BY w.id, w.ten_kho, w.vung_id, w.phuong_xa_id, w.dia_chi_chi_tiet, 
                   w.so_dien_thoai, w.trang_thai, w.priority_levels, w.is_primary, 
                   w.ngay_tao, w.ngay_cap_nhat,
                   ward.ten_phuong_xa, ward.tinh_thanh_id, p.ten_tinh, p.vung_id, r.ten_vung
        `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Warehouse findById Error:', error);
      throw error;
    }
  }

  static async findByRegion(regionId) {
    try {
      const request = createRequest();
      const result = await request
        .input('vung_id', sql.NVarChar(10), regionId)
        .query(`
          SELECT 
            id,
            ten_kho,
            vung_id,
            phuong_xa_id,
            dia_chi_chi_tiet,
            so_dien_thoai,
            trang_thai,
            priority_levels,
            is_primary,
            ngay_tao,
            ngay_cap_nhat
          FROM warehouses 
          WHERE vung_id = @vung_id AND trang_thai = 1
          ORDER BY ngay_tao ASC
        `);
      
      return result.recordset;
    } catch (error) {
      console.error('SQL Warehouse findByRegion Error:', error);
      throw error;
    }
  }

  static async create(warehouseData) {
    try {
      const request = createRequest();
      const id = warehouseData.id || sql.UniqueIdentifier.newGuid();
      
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .input('ten_kho', sql.NVarChar(200), warehouseData.ten_kho)
        .input('vung_id', sql.NVarChar(10), warehouseData.vung_id)
        .input('phuong_xa_id', sql.UniqueIdentifier, warehouseData.phuong_xa_id)
        .input('dia_chi_chi_tiet', sql.NVarChar(500), warehouseData.dia_chi_chi_tiet)
        .input('so_dien_thoai', sql.VarChar(15), warehouseData.so_dien_thoai)
        .input('trang_thai', sql.Bit, warehouseData.trang_thai !== undefined ? warehouseData.trang_thai : 1)
        .input('ngay_tao', sql.DateTime2, new Date())
        .input('ngay_cap_nhat', sql.DateTime2, new Date())
        .query(`
          INSERT INTO warehouses (
            id, ten_kho, vung_id, phuong_xa_id, dia_chi_chi_tiet, 
            so_dien_thoai, trang_thai, ngay_tao, ngay_cap_nhat
          )
          VALUES (
            @id, @ten_kho, @vung_id, @phuong_xa_id, @dia_chi_chi_tiet,
            @so_dien_thoai, @trang_thai, @ngay_tao, @ngay_cap_nhat
          );
          
          SELECT 
            id, ten_kho, vung_id, phuong_xa_id, dia_chi_chi_tiet,
            so_dien_thoai, trang_thai, priority_levels, is_primary,
            ngay_tao, ngay_cap_nhat
          FROM warehouses WHERE id = @id;
        `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Warehouse create Error:', error);
      throw error;
    }
  }

  static async update(id, warehouseData) {
    try {
      const request = createRequest();
      
      let updateFields = [];
      
      if (warehouseData.ten_kho !== undefined) {
        request.input('ten_kho', sql.NVarChar(200), warehouseData.ten_kho);
        updateFields.push('ten_kho = @ten_kho');
      }
      
      if (warehouseData.vung_id !== undefined) {
        request.input('vung_id', sql.NVarChar(10), warehouseData.vung_id);
        updateFields.push('vung_id = @vung_id');
      }
      
      if (warehouseData.phuong_xa_id !== undefined) {
        request.input('phuong_xa_id', sql.UniqueIdentifier, warehouseData.phuong_xa_id);
        updateFields.push('phuong_xa_id = @phuong_xa_id');
      }
      
      if (warehouseData.dia_chi_chi_tiet !== undefined) {
        request.input('dia_chi_chi_tiet', sql.NVarChar(500), warehouseData.dia_chi_chi_tiet);
        updateFields.push('dia_chi_chi_tiet = @dia_chi_chi_tiet');
      }
      
      if (warehouseData.so_dien_thoai !== undefined) {
        request.input('so_dien_thoai', sql.VarChar(15), warehouseData.so_dien_thoai);
        updateFields.push('so_dien_thoai = @so_dien_thoai');
      }
      
      if (warehouseData.trang_thai !== undefined) {
        request.input('trang_thai', sql.Bit, warehouseData.trang_thai);
        updateFields.push('trang_thai = @trang_thai');
      }
      
      updateFields.push('ngay_cap_nhat = @ngay_cap_nhat');
      request.input('ngay_cap_nhat', sql.DateTime2, new Date());
      request.input('id', sql.UniqueIdentifier, id);
      
      const result = await request.query(`
        UPDATE warehouses 
        SET ${updateFields.join(', ')}
        WHERE id = @id;
        
        SELECT 
          id, ten_kho, vung_id, phuong_xa_id, dia_chi_chi_tiet,
          so_dien_thoai, trang_thai, priority_levels, is_primary,
          ngay_tao, ngay_cap_nhat
        FROM warehouses WHERE id = @id;
      `);
      
      return result.recordset[0];
    } catch (error) {
      console.error('SQL Warehouse update Error:', error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const request = createRequest();
      
      const result = await request
        .input('id', sql.UniqueIdentifier, id)
        .query(`
          DELETE FROM warehouses WHERE id = @id;
          SELECT @@ROWCOUNT as affected;
        `);
      
      return result.recordset[0].affected > 0;
    } catch (error) {
      console.error('SQL Warehouse delete Error:', error);
      throw error;
    }
  }
}

// ==================== EXPORT ALL MODELS ====================

export default {
  // MongoDB Models
  Data_ProductDetail_Model,
  
  // SQL Server Models
  SQLBrandModel,
  SQLCategoryModel,
  SQLProductModel,
  SQLProductVariantModel,
  SQLFlashSaleModel,
  SQLFlashSaleItemModel,
  SQLRegionModel,
  SQLProvinceModel,
  SQLWardModel,
  SQLUserModel,
  SQLInventoryModel,
  SQLWarehouseModel,
  
  // Hoặc export theo nhóm để dễ sử dụng
  Mongo: {
    ProductDetail: Data_ProductDetail_Model, 
    FlashSaleDetail: Data_FlashSaleDetail_Model,
    UserDetail: Data_UserDetail_Model,
    VoucherDetail: Data_VoucherDetail_Model
  },
  
  SQL: {
    Brand: SQLBrandModel,
    Category: SQLCategoryModel,
    Product: SQLProductModel,
    ProductVariant: SQLProductVariantModel,
    FlashSale: SQLFlashSaleModel,
    FlashSaleItem: SQLFlashSaleItemModel,
    Region: SQLRegionModel,
    Province: SQLProvinceModel,
    Ward: SQLWardModel,
    User: SQLUserModel,
    Inventory: SQLInventoryModel,
    Warehouse: SQLWarehouseModel
  }
};