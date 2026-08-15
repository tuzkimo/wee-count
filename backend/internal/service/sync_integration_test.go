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

	txs, err := s.queryTransactions(ctx, pool, []string{ledgerID}, now.Add(-time.Hour))
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
	if err := s.lwwMergeCategory(ctx, pool, userID, older); err != nil {
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
	resp, err := s.Sync(ctx, ownerID, model.SyncRequest{LastSyncedAt: now.Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ServerTime.IsZero() {
		t.Fatal("ServerTime 应为非零快照游标")
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
		LastSyncedAt: now.Add(-time.Hour),
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

	var gotName string
	if err := pool.QueryRow(ctx, "SELECT name FROM ledgers WHERE id = $1", ledgerID).Scan(&gotName); err != nil {
		t.Fatal(err)
	}
	if gotName != "被抢" {
		t.Fatalf("merge 应实际执行（name 应为「被抢」），got %q", gotName)
	}
}
