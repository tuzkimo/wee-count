//go:build integration

package service

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go/modules/postgres"

	"wee-count/backend/internal/database"
	"wee-count/backend/internal/model"
)

var (
	testPoolOnce sync.Once
	testPool     *pgxpool.Pool
	testPoolErr  error
)

// setupTestDB 起一个共享 postgres 容器并跑迁移，返回连接池。
// 用 sync.Once 保证包内多个测试共享同一容器，降低启动成本；不同测试用各自唯一 UUID 隔离数据。
func setupTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	testPoolOnce.Do(func() {
		ctx := context.Background()
		pg, err := postgres.Run(ctx, "postgres:16-alpine",
			postgres.WithDatabase("test"),
			postgres.WithUsername("test"),
			postgres.WithPassword("test"),
			postgres.BasicWaitStrategies(),
		)
		if err != nil {
			testPoolErr = err
			return
		}
		dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
		if err != nil {
			testPoolErr = err
			return
		}
		if err := database.RunMigrations(dsn); err != nil {
			testPoolErr = err
			return
		}
		pool, err := database.NewPool(ctx, dsn)
		if err != nil {
			testPoolErr = err
			return
		}
		testPool = pool
	})
	if testPoolErr != nil {
		t.Fatalf("setup test db: %v", testPoolErr)
	}
	return testPool
}

// seedUser 插入一个用户，返回其 id。
func seedUser(t *testing.T, pool *pgxpool.Pool, now time.Time) string {
	t.Helper()
	id := uuid.New().String()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO users (id, nickname, username, password_hash, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,$6)`,
		id, "测试", "test-"+id, "x", now, now); err != nil {
		t.Fatalf("seedUser: %v", err)
	}
	return id
}

// seedLedger 插入一个 personal 账本，owner 为 ownerID，返回其 id。
func seedLedger(t *testing.T, pool *pgxpool.Pool, ownerID string, now time.Time) string {
	t.Helper()
	id := uuid.New().String()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
		 VALUES ($1,$2,'personal',$3,$4,$5)`,
		id, "账本", ownerID, now, now); err != nil {
		t.Fatalf("seedLedger: %v", err)
	}
	return id
}

// seedTag 插入一个标签，返回其 id。
func seedTag(t *testing.T, pool *pgxpool.Pool, ledgerID string, now time.Time) string {
	t.Helper()
	id := uuid.New().String()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,false)`,
		id, ledgerID, "标签-"+id, now); err != nil {
		t.Fatalf("seedTag: %v", err)
	}
	return id
}

// seedTransaction 插入一笔无关联标签的流水，返回其 id。
func seedTransaction(t *testing.T, pool *pgxpool.Pool, ledgerID, userID string, now time.Time) string {
	t.Helper()
	id := uuid.New().String()
	if _, err := pool.Exec(context.Background(),
		`INSERT INTO transactions (id, ledger_id, user_id, amount, type, occurred_at, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,'expense',$5,$5,$5)`,
		id, ledgerID, userID, 10, now); err != nil {
		t.Fatalf("seedTransaction: %v", err)
	}
	return id
}

// 冒烟测试：确认容器能起、迁移能跑通（跑通即代表 001~007 迁移全部成功）。
func TestIntegration_Smoke(t *testing.T) {
	pool := setupTestDB(t)
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM information_schema.tables WHERE table_name = 'transactions'").Scan(&n); err != nil {
		t.Fatalf("query schema: %v", err)
	}
	if n != 1 {
		t.Fatalf("transactions 表应存在，count=%d", n)
	}
}

func TestIntegration_LwwMergeLedger_NewerWins(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)

	// 更新的版本覆盖
	newer := now.Add(time.Hour)
	l := model.Ledger{ID: ledgerID, Name: "新名", Type: "personal", OwnerID: userID, CreatedAt: now, UpdatedAt: newer, IsDeleted: false}
	if err := s.lwwMergeLedger(ctx, pool, userID, l); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := pool.QueryRow(ctx, "SELECT name FROM ledgers WHERE id=$1", ledgerID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "新名" {
		t.Fatalf("更新的版本应覆盖，got name=%q", name)
	}

	// 更旧的版本跳过
	older := model.Ledger{ID: ledgerID, Name: "旧名", Type: "personal", OwnerID: userID, CreatedAt: now, UpdatedAt: now.Add(-time.Hour), IsDeleted: false}
	if err := s.lwwMergeLedger(ctx, pool, userID, older); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT name FROM ledgers WHERE id=$1", ledgerID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "新名" {
		t.Fatalf("更旧的版本应跳过，got name=%q", name)
	}
}

func TestIntegration_QueryTransactions_TagIDs(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)
	txID := seedTransaction(t, pool, ledgerID, userID, now)
	tag1 := seedTag(t, pool, ledgerID, now)
	tag2 := seedTag(t, pool, ledgerID, now)
	if _, err := pool.Exec(ctx,
		`INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1,$2),($1,$3)`,
		txID, tag1, tag2); err != nil {
		t.Fatal(err)
	}

	txs, err := s.queryTransactions(ctx, pool, []string{ledgerID}, 0)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, tx := range txs {
		if tx.ID == txID {
			got = tx.TagIDs
		}
	}
	if len(got) != 2 {
		t.Fatalf("应扫出 2 个标签，got %v", got)
	}
	gotSet := map[string]bool{}
	for _, id := range got {
		gotSet[id] = true
	}
	if !gotSet[tag1] || !gotSet[tag2] {
		t.Fatalf("TagIDs 应包含 tag1 和 tag2，got %v", got)
	}
}

func TestIntegration_LwwMergeTransaction_EmptyTagsClears(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)
	txID := seedTransaction(t, pool, ledgerID, userID, now)
	tag := seedTag(t, pool, ledgerID, now)
	if _, err := pool.Exec(ctx, `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1,$2)`, txID, tag); err != nil {
		t.Fatal(err)
	}

	// 带空标签的新版本 merge，应清掉旧关联
	tx := model.Transaction{ID: txID, LedgerID: ledgerID, UserID: userID, Type: "expense", Amount: 10, OccurredAt: now, CreatedAt: now, UpdatedAt: now.Add(time.Hour), TagIDs: []string{}}
	if err := s.lwwMergeTransaction(ctx, pool, userID, tx); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM transaction_tags WHERE transaction_id=$1", txID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("空标签应清空旧关联，残留 %d 条", n)
	}
}

func TestIntegration_LwwMergeCategory_DuplicateOlderSkips(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)
	if _, err := pool.Exec(ctx,
		`INSERT INTO categories (id, ledger_id, owner_id, name, type, updated_at, is_deleted)
		 VALUES ($1,$2,$3,'餐饮','expense',$4,false)`,
		uuid.New().String(), ledgerID, userID, now); err != nil {
		t.Fatal(err)
	}

	// 新 UUID、同名同类型、但更旧 → 应跳过且不报错、不新增行
	older := model.Category{ID: uuid.New().String(), LedgerID: ledgerID, OwnerID: userID, Name: "餐饮", Type: "expense", UpdatedAt: now.Add(-time.Hour)}
	if _, err := s.lwwMergeCategory(ctx, pool, userID, older); err != nil {
		t.Fatalf("更旧的重复分类应跳过不报错，got %v", err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM categories WHERE ledger_id=$1 AND name='餐饮'", ledgerID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("不应新增重复分类，count=%d", n)
	}
}

func TestIntegration_Sync_ReturnsCursorAndRemoteChanges(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	ownerID := seedUser(t, pool, now)
	memberID := seedUser(t, pool, now)

	// 建团队 + 团队账本，owner 与 member 都是成员
	teamID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)`,
		teamID, "团队", ownerID, now, now); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{ownerID, memberID} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,'member',$3)`,
			teamID, uid, now); err != nil {
			t.Fatal(err)
		}
	}
	ledgerID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES ($1,$2,'team',$3,$4,$5,$6)`,
		ledgerID, "共享账本", teamID, ownerID, now, now); err != nil {
		t.Fatal(err)
	}

	// member 往团队账本写一笔流水（他人的变更）
	txID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO transactions (id, ledger_id, user_id, amount, type, occurred_at, created_at, updated_at) VALUES ($1,$2,$3,$4,'expense',$5,$5,$5)`,
		txID, ledgerID, memberID, 20, now); err != nil {
		t.Fatal(err)
	}

	// owner 同步，游标早于这笔流水，应收到这笔「他人变更」
	resp, err := s.Sync(ctx, ownerID, model.SyncRequest{LastServerSeq: 0})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ServerSeq == 0 {
		t.Fatal("ServerSeq 应为非零快照游标")
	}
	foundTx := false
	for _, tx := range resp.RemoteChanges.Transactions {
		if tx.ID == txID {
			foundTx = true
		}
	}
	if !foundTx {
		t.Fatalf("应返回成员写的流水，got %+v", resp.RemoteChanges.Transactions)
	}
}

func TestIntegration_MemberCannotChangeLedgerOwnership(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	ownerID := seedUser(t, pool, now)
	memberID := seedUser(t, pool, now)

	teamID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)`,
		teamID, "团队", ownerID, now, now); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{ownerID, memberID} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,'member',$3)`,
			teamID, uid, now); err != nil {
			t.Fatal(err)
		}
	}
	ledgerID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES ($1,$2,'team',$3,$4,$5,$6)`,
		ledgerID, "共享账本", teamID, ownerID, now, now); err != nil {
		t.Fatal(err)
	}

	// member 推送一条试图改归属的账本变更：owner_id 改成自己、team_id 改成另一个团队
	evilTeamID := uuid.New().String()
	evilLedger := model.Ledger{
		ID: ledgerID, Name: "被抢", Type: "personal",
		OwnerID: memberID, TeamID: &evilTeamID,
		CreatedAt: now, UpdatedAt: now.Add(time.Hour), IsDeleted: false,
	}
	if _, err := s.Sync(ctx, memberID, model.SyncRequest{
		LastServerSeq: 0,
		LocalChanges: model.SyncPayload{Ledgers: []model.Ledger{evilLedger}},
	}); err != nil {
		t.Fatal(err)
	}

	// 归属不得改变
	var gotOwner string
	var gotTeam *string
	if err := pool.QueryRow(ctx, "SELECT owner_id, team_id FROM ledgers WHERE id = $1", ledgerID).Scan(&gotOwner, &gotTeam); err != nil {
		t.Fatal(err)
	}
	if gotOwner != ownerID {
		t.Fatalf("owner_id 应保持 %s，got %s", ownerID, gotOwner)
	}
	if gotTeam == nil || *gotTeam != teamID {
		t.Fatalf("team_id 应保持 %s，got %v", teamID, gotTeam)
	}

	var gotName, gotType string
	if err := pool.QueryRow(ctx, "SELECT name, type FROM ledgers WHERE id = $1", ledgerID).Scan(&gotName, &gotType); err != nil {
		t.Fatal(err)
	}
	// 成员不能改共享账本的 name/type（is_deleted 亦冻结），只有 owner 可改。
	// 因此「被抢」改名与 type 改 personal 都不得生效。
	if gotName != "共享账本" {
		t.Fatalf("成员不应能改共享账本名，name 应保持「共享账本」，got %q", gotName)
	}
	if gotType != "team" {
		t.Fatalf("成员不应能改共享账本类型，type 应保持「team」，got %q", gotType)
	}
}

// 同名标签去重时，同批次交易引用的新 id 应被重映射到旧 id，否则 transaction_tags 外键 23503 会回滚整次同步。
func TestIntegration_TagDedupRemapsTransactionTags(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)

	// 已存在同名标签「餐饮」（旧 id）
	existingTagID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,'餐饮',$3,FALSE)`,
		existingTagID, ledgerID, now); err != nil {
		t.Fatal(err)
	}

	// 客户端推送：新 id 的同名标签「餐饮」+ 一笔引用新 id 的流水
	incomingTagID := uuid.New().String()
	txID := uuid.New().String()
	if _, err := s.Sync(ctx, userID, model.SyncRequest{
		LastServerSeq: 0,
		LocalChanges: model.SyncPayload{
			Tags: []model.Tag{{ID: incomingTagID, LedgerID: ledgerID, Name: "餐饮", UpdatedAt: now.Add(time.Hour), IsDeleted: false}},
			Transactions: []model.Transaction{{
				ID: txID, LedgerID: ledgerID, UserID: userID, Amount: 10, Type: "expense",
				OccurredAt: now, CreatedAt: now, UpdatedAt: now.Add(time.Hour),
				TagIDs: []string{incomingTagID},
			}},
		},
	}); err != nil {
		t.Fatalf("同步不应失败（同名标签去重后交易应重映射到旧 id），got %v", err)
	}

	// transaction_tags 应指向旧标签，而非被丢弃的新 id
	var gotTagID string
	if err := pool.QueryRow(ctx,
		"SELECT tag_id FROM transaction_tags WHERE transaction_id = $1", txID).Scan(&gotTagID); err != nil {
		t.Fatal(err)
	}
	if gotTagID != existingTagID {
		t.Fatalf("transaction_tags 应重映射到旧标签 %s，got %s", existingTagID, gotTagID)
	}
}

// 写库应给行 bump 新的 server_seq（单调递增）。
func TestIntegration_WriteBumpsServerSeq(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)

	var before int64
	if err := pool.QueryRow(ctx,
		"SELECT COALESCE(MAX(server_seq), 0) FROM transactions").Scan(&before); err != nil {
		t.Fatal(err)
	}

	txID := uuid.New().String()
	if _, err := s.Sync(ctx, userID, model.SyncRequest{
		LastServerSeq: before,
		LocalChanges: model.SyncPayload{
			Transactions: []model.Transaction{{
				ID: txID, LedgerID: ledgerID, UserID: userID, Amount: 10, Type: "expense",
				OccurredAt: now, CreatedAt: now, UpdatedAt: now,
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	var seq int64
	if err := pool.QueryRow(ctx,
		"SELECT server_seq FROM transactions WHERE id = $1", txID).Scan(&seq); err != nil {
		t.Fatal(err)
	}
	if seq <= before {
		t.Fatalf("写库应 bump server_seq，got %d（before=%d）", seq, before)
	}
}

// 离线编辑的旧 updated_at 流水，因写库 bump 了 server_seq，其他设备仍能增量拉到。
func TestIntegration_OldUpdatedAtStillPulledByServerSeq(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)

	// 设备 B 当前游标 = 此刻全局最大 server_seq
	var cursor int64
	if err := pool.QueryRow(ctx, `SELECT COALESCE(MAX(s),0) FROM (
		SELECT MAX(server_seq) s FROM ledgers UNION ALL SELECT MAX(server_seq) FROM accounts
		UNION ALL SELECT MAX(server_seq) FROM categories UNION ALL SELECT MAX(server_seq) FROM tags
		UNION ALL SELECT MAX(server_seq) FROM transactions UNION ALL SELECT MAX(server_seq) FROM member_aliases
	) m`).Scan(&cursor); err != nil {
		t.Fatal(err)
	}

	// 设备 A 离线一周的编辑：updated_at 是很久以前
	oldTime := now.Add(-7 * 24 * time.Hour)
	txID := uuid.New().String()
	if _, err := s.Sync(ctx, userID, model.SyncRequest{
		LastServerSeq: cursor,
		LocalChanges: model.SyncPayload{
			Transactions: []model.Transaction{{
				ID: txID, LedgerID: ledgerID, UserID: userID, Amount: 20, Type: "expense",
				OccurredAt: oldTime, CreatedAt: oldTime, UpdatedAt: oldTime,
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}

	// 设备 B 以旧游标增量拉，应拉到这笔（即使 updated_at 远早于游标）
	resp, err := s.Sync(ctx, userID, model.SyncRequest{LastServerSeq: cursor, LocalChanges: model.SyncPayload{}})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, tx := range resp.RemoteChanges.Transactions {
		if tx.ID == txID {
			found = true
		}
	}
	if !found {
		t.Fatalf("旧 updated_at 流水应通过 server_seq 被拉到，got %+v", resp.RemoteChanges.Transactions)
	}
}
