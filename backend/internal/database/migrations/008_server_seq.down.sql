ALTER TABLE ledgers        DROP COLUMN server_seq;
ALTER TABLE accounts       DROP COLUMN server_seq;
ALTER TABLE categories     DROP COLUMN server_seq;
ALTER TABLE tags           DROP COLUMN server_seq;
ALTER TABLE transactions   DROP COLUMN server_seq;
ALTER TABLE member_aliases DROP COLUMN server_seq;
DROP SEQUENCE IF EXISTS global_server_seq;
