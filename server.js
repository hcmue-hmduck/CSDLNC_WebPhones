import mongoose from "mongoose";
import sql from 'mssql';
import dotenv from 'dotenv';

// Load biến môi trường
dotenv.config();

// Base config cho SQL Server
const baseConfig = {
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: {
    encrypt: process.env.SQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === 'true',
    enableArithAbort: process.env.SQL_ENABLE_ARITH_ABORT === 'true',
    trustedConnection: process.env.SQL_TRUSTED_CONNECTION === 'true',
  },
  port: parseInt(process.env.SQL_PORT) || 1433,
  pool: {
    max: 10,
    min: 2,
    idleTimeoutMillis: 30000
  }
};

// Connection pools cho từng vùng
const connectionPools = {
  default: null,
  bac: null,
  trung: null,
  nam: null
};

// Configs cho từng vùng
const dbConfigs = {
  default: {
    ...baseConfig,
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
  },
  bac: {
    ...baseConfig,
    user: process.env.SQL_USER_BAC || process.env.SQL_USER,
    password: process.env.SQL_PASSWORD_BAC || process.env.SQL_PASSWORD,
    server: process.env.SQL_SERVER_BAC || process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE_BAC || process.env.SQL_DATABASE,
  },
  trung: {
    ...baseConfig,
    user: process.env.SQL_USER_TRUNG || process.env.SQL_USER,
    password: process.env.SQL_PASSWORD_TRUNG || process.env.SQL_PASSWORD,
    server: process.env.SQL_SERVER_TRUNG || process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE_TRUNG || process.env.SQL_DATABASE,
  },
  nam: {
    ...baseConfig,
    user: process.env.SQL_USER_NAM || process.env.SQL_USER,
    password: process.env.SQL_PASSWORD_NAM || process.env.SQL_PASSWORD,
    server: process.env.SQL_SERVER_NAM || process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE_NAM || process.env.SQL_DATABASE,
  }
};

// Kết nối SQL Server - Tạo connection pool mặc định
async function connectSQLDB() {
  try {
    connectionPools.default = await new sql.ConnectionPool(dbConfigs.default).connect();
    console.log('✅ Default SQL Server pool connected:', dbConfigs.default.server, '/', dbConfigs.default.database);
    
    // Test query
    const result = await connectionPools.default.query`SELECT @@VERSION as version`;
    console.log('SQL Server version:', result.recordset[0].version);
    
    return connectionPools.default;
  } catch (err) {
    console.error('SQL Server connection error:', err);
    throw err;
  }
}

// Lấy connection pool theo vùng
async function getConnectionByRegion(vungId) {
  try {
    // Chuẩn hóa vungId
    let region = 'default';
    
    if (vungId) {
      const normalizedVungId = typeof vungId === 'string' ? vungId.toLowerCase() : vungId;
      
      if (normalizedVungId === 'bac' || normalizedVungId === 1 || normalizedVungId === '1') {
        region = 'bac';
      } else if (normalizedVungId === 'trung' || normalizedVungId === 2 || normalizedVungId === '2') {
        region = 'trung';
      } else if (normalizedVungId === 'nam' || normalizedVungId === 3 || normalizedVungId === '3') {
        region = 'nam';
      }
    }
    
    // Tạo pool nếu chưa tồn tại
    if (!connectionPools[region]) {
      console.log(`🔄 Creating connection pool for region: ${region}`);
      connectionPools[region] = await new sql.ConnectionPool(dbConfigs[region]).connect();
      console.log(`✅ Pool connected:`, dbConfigs[region].server, '/', dbConfigs[region].database);
    }
    
    return connectionPools[region];
  } catch (err) {
    console.error('❌ Error getting connection:', err);
    throw err;
  }
}

// Middleware để inject connection vào request
function injectDBConnection() {
  return async (req, res, next) => {
    try {
      const vungId = req.session?.user?.vung_id;
      req.dbPool = await getConnectionByRegion(vungId);
      next();
    } catch (err) {
      console.error('❌ Error injecting DB connection:', err);
      req.dbPool = connectionPools.default; // Fallback to default
      next();
    }
  };
}

// ⚠️ DEPRECATED: Không dùng function này nữa vì ảnh hưởng global connection
// Giữ lại để backward compatibility, nhưng chỉ return info
async function switchDatabaseByRegion(vungId) {
  console.warn('⚠️ switchDatabaseByRegion is deprecated. Use getConnectionByRegion instead.');
  
  let region = 'default';
  const normalizedVungId = typeof vungId === 'string' ? vungId.toLowerCase() : vungId;
  
  if (normalizedVungId === 'bac' || normalizedVungId === 1 || normalizedVungId === '1') {
    region = 'bac';
  } else if (normalizedVungId === 'trung' || normalizedVungId === 2 || normalizedVungId === '2') {
    region = 'trung';
  } else if (normalizedVungId === 'nam' || normalizedVungId === 3 || normalizedVungId === '3') {
    region = 'nam';
  }
  
  const config = dbConfigs[region];
  return { server: config.server, database: config.database };
}

// Kết nối MongoDB
async function connectMongoDB() {
  try {
    const mongoURI = process.env.MONGODB_URI;
    if (!mongoURI) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }

    await mongoose.connect(mongoURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
}

// Kết nối cả hai databases
async function connectAllDB() {
  try {
    await connectSQLDB();
    await connectMongoDB();
    console.log("All databases connected successfully");
  } catch (err) {
    console.error("Error connecting to databases:", err);
    throw err;
  }
}

export default { 
  connectSQLDB, 
  connectMongoDB, 
  connectAllDB,
  switchDatabaseByRegion,  // ⚠️ Deprecated - keep for backward compatibility
  getConnectionByRegion,   // ✅ New: Get connection pool by region
  injectDBConnection,      // ✅ New: Middleware to inject connection
  connectionPools,         // ✅ Export pools for direct access if needed
  sql,
  mongoose 
};