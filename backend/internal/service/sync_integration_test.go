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
		id, ledgerID, "标签", now); err != nil {
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
