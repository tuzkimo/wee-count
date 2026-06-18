-- 002_categories_not_null.up.sql
-- 清理历史遗留的重复默认分类（如果有）
DELETE FROM categories WHERE ledger_id IS NULL;

-- 改为 NOT NULL
ALTER TABLE categories ALTER COLUMN ledger_id SET NOT NULL;
