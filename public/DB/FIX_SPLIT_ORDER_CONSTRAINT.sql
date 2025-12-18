-- =============================================
-- FIX SPLIT ORDER: Remove UNIQUE constraint on ma_don_hang
-- Lý do: Split order cần nhiều orders có cùng ma_don_hang
-- =============================================

USE DB_WebPhone;
GO

-- 1. Drop UNIQUE constraint trên ma_don_hang
-- Check nếu constraint tồn tại trước khi drop
IF EXISTS (
    SELECT 1 
    FROM sys.objects 
    WHERE object_id = OBJECT_ID(N'[dbo].[UQ__orders__0246C5EB2F9A4445]') 
      AND type = 'UQ'
)
BEGIN
    ALTER TABLE orders DROP CONSTRAINT [UQ__orders__0246C5EB2F9A4445];
    PRINT '✅ Dropped UNIQUE constraint: UQ__orders__0246C5EB2F9A4445';
END
ELSE
BEGIN
    PRINT '⚠️ UNIQUE constraint UQ__orders__0246C5EB2F9A4445 not found (might be already dropped)';
END
GO

-- 2. Tạo index NON-UNIQUE để vẫn có performance khi query theo ma_don_hang
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IDX_orders_ma_don_hang')
BEGIN
    CREATE INDEX IDX_orders_ma_don_hang ON orders(ma_don_hang);
    PRINT '✅ Created non-unique index: IDX_orders_ma_don_hang';
END
ELSE
BEGIN
    PRINT '⚠️ Index IDX_orders_ma_don_hang already exists';
END
GO

-- 3. Verify: Kiểm tra indexes trên ma_don_hang
SELECT 
    i.name AS IndexName,
    i.type_desc AS IndexType,
    i.is_unique AS IsUnique,
    i.is_primary_key AS IsPrimaryKey
FROM sys.indexes i
INNER JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
INNER JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
WHERE i.object_id = OBJECT_ID('orders')
  AND c.name = 'ma_don_hang';
GO

PRINT '✅ Split order fix completed! ma_don_hang can now have duplicates for split orders.';
GO
