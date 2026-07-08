-- 头像改为 data URL 内联存储（与 emoji 同路），VARCHAR(255) 装不下，改 TEXT
ALTER TABLE users ALTER COLUMN avatar_url TYPE TEXT;
