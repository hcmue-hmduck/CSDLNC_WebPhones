import mongoose from "mongoose";
import sql from 'mssql';
import dotenv from 'dotenv';

// Load biến môi trường
dotenv.config();

// Cấu hình SQL Server từ biến môi trường
const dbConfig = {
  server: process.env.SQL_SERVER_NAM || 'localhost',
  database: process.env.SQL_DATABASE_NAM || 'CSDLNC_WebPhone',
  user: process.env.SQL_USER || 'sa',
  password: process.env.SQL_PASSWORD,
  options: {
    encrypt: process.env.SQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === 'true',
    enableArithAbort: process.env.SQL_ENABLE_ARITH_ABORT === 'true',
    trustedConnection: process.env.SQL_TRUSTED_CONNECTION === 'true',
  },
  port: parseInt(process.env.SQL_PORT) || 1433,
};

// Kết nối SQL Server
async function connectSQLDB() {
  try {
    await sql.connect(dbConfig);
    console.log('SQL Server connected successfully');
    
    // Test query
    const result = await sql.query`SELECT @@VERSION as version`;
    console.log('SQL Server version:', result.recordset[0].version);
    
    return sql;
  } catch (err) {
    console.error('SQL Server connection error:', err);
    throw err;
  }
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
  dbConfig,  // Export SQL config
  sql,
  mongoose 
};