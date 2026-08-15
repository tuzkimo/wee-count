-- 增量同步游标改服务端单调序列号：加 server_seq 列 + 全局序列。
-- DEFAULT nextval 让存量行回填单调值，同时让后续 INSERT 自动赋值；UPDATE 需显式 nextval（见 Task 2）。
CREATE SEQUENCE IF NOT EXISTS global_server_seq;

ALTER TABLE ledgers        ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE accounts       ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE categories     ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE tags           ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE transactions   ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE member_aliases ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
