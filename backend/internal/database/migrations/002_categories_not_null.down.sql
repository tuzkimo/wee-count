-- 002_categories_not_null.down.sql
ALTER TABLE categories ALTER COLUMN ledger_id DROP NOT NULL;
