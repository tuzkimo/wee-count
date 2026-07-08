-- ponytail: 回退到 VARCHAR(255) 会截断已存的 data URL 头像，仅用于干净回滚
ALTER TABLE users ALTER COLUMN avatar_url TYPE VARCHAR(255);
