-- 同步增量查询与成员查询的索引：categories 按账本增量扫描、团队账本反查、按成员查团队
CREATE INDEX idx_categories_ledger_updated ON categories(ledger_id, updated_at);
CREATE INDEX idx_ledgers_team ON ledgers(team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);
