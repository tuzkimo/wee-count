# 后端同步层重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `sync.go` 里 5 份重复的 lwwMerge 样板收口到 `mergeByKey` 通用骨架，让 `getRemoteChanges` 在单个 REPEATABLE READ 只读事务内完成读 + 游标取样，并用 testcontainers 起真 Postgres 补集成测试。

**Architecture:** 在 `service` 包内加包级函数 `mergeByKey`（收口「查 updated_at → ErrNoRows 判空 → INSERT/UPDATE」三段式）与 `syncTransactionTags`（标签重建），5 份 `lwwMerge*` 改为传主键 SQL + insert/update 闭包复用；`query*` 系列从 `s.pool` 改为接收 `dbQuerier`，`Sync` 把 `getRemoteChanges` 包进 `REPEATABLE READ` 只读事务并用 `SELECT now()` 取快照游标；集成测试用 testcontainers 的 `postgres:16-alpine` + `database.RunMigrations` 跑真 SQL。

**Tech Stack:** Go 1.25、pgx/v5、testcontainers-go（`modules/postgres`）、PostgreSQL 16。

**Spec:** `docs/superpowers/specs/2026-08-14-backend-sync-refactor-design.md`

## Global Constraints

- Go 版本：`1.25.0`（见 `backend/go.mod`）。
- 仅改后端，**不碰前端、`model`、`migrations`**。
- **不新增** `next_cursor` 字段，复用现有 `SyncResponse.ServerTime` 当游标。
- `lwwMergeCategory` **不改**（其同名查重分支独特，保持 bespoke）。
- 客户端时钟偏移（`updated_at` 是客户端值）**不在本计划范围**。
- 集成测试打 `//go:build integration` 标签；`go test ./...`（无 Docker）必须保持绿。
- 每个 Task 的 commit 用中文描述，不加 Co-Authored-By。

---

### Task 1: `mergeByKey` 骨架 + 收口 ledger/account/tag

**Files:**
- Modify: `backend/internal/service/sync.go`（在 `dbQuerier` 接口之后、`type SyncService` 之前加 `mergeByKey`；重写 `lwwMergeLedger` `sync.go:167-189`、`lwwMergeAccount` `sync.go:191-216`、`lwwMergeTag` `sync.go:218-239`）

**Interfaces:**
- Produces: `func mergeByKey(ctx context.Context, tx dbQuerier, incoming time.Time, keySQL string, keyArgs []any, insert, update func() error) error` —— Task 2 的 memberAlias/transaction 依赖它。

**说明（本 Task 是行为保持型重构）**：已有 `lwwmerge_test.go` 的 `TestLwwMergeLedgerReturnsRealScanError`、`TestLwwMergeCategoryDuplicateOlderSkips`、`TestLwwMergeTransactionEmptyTagsStillClears`、`TestLwwMergeMemberAliasForcesSetter` 已覆盖这些分支，重构后它们就是回归网。**无需新增单测**——行为不变，新增测试是重复。

- [ ] **Step 1: 确认基线绿**

Run: `cd backend && go test ./internal/service/ -run 'LwwMerge' -v`
Expected: PASS（现有 4 个 LwwMerge 相关测试）

- [ ] **Step 2: 加 `mergeByKey` 骨架**

在 `sync.go` 的 `dbQuerier` 接口定义之后、`type SyncService struct` 之前插入：

```go
// mergeByKey 是各实体 LWW merge 的公共骨架：
//   1) 按主键查 updated_at
//   2) 不存在(ErrNoRows) → insert()
//   3) 真实错误 → 直接透传（不误判为「不存在」）
//   4) 存在但 incoming 更旧/相同 → 跳过
//   5) incoming 更新 → update()
func mergeByKey(ctx context.Context, tx dbQuerier, incoming time.Time,
	keySQL string, keyArgs []any, insert, update func() error) error {
	var remote time.Time
	err := tx.QueryRow(ctx, keySQL, keyArgs...).Scan(&remote)
	if errors.Is(err, pgx.ErrNoRows) {
		return insert()
	}
	if err != nil {
		return err
	}
	if !incoming.After(remote) {
		return nil
	}
	return update()
}
```

- [ ] **Step 3: 重写 `lwwMergeLedger`**

用 Edit 把 `sync.go:167-189` 的函数体整体替换为：

```go
func (s *SyncService) lwwMergeLedger(ctx context.Context, tx dbQuerier, l model.Ledger) error {
	return mergeByKey(ctx, tx, l.UpdatedAt,
		"SELECT updated_at FROM ledgers WHERE id = $1", []any{l.ID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at, is_deleted)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
				l.ID, l.Name, l.Type, l.OwnerID, l.TeamID, l.CreatedAt, l.UpdatedAt, l.IsDeleted,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE ledgers SET name=$1, type=$2, owner_id=$3, team_id=$4, updated_at=$5, is_deleted=$6 WHERE id=$7`,
				l.Name, l.Type, l.OwnerID, l.TeamID, l.UpdatedAt, l.IsDeleted, l.ID,
			)
			return err
		},
	)
}
```

- [ ] **Step 4: 重写 `lwwMergeAccount`**

把 `sync.go:191-216` 的函数体整体替换为：

```go
func (s *SyncService) lwwMergeAccount(ctx context.Context, tx dbQuerier, a model.Account) error {
	return mergeByKey(ctx, tx, a.UpdatedAt,
		"SELECT updated_at FROM accounts WHERE id = $1", []any{a.ID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
				 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
				a.ID, a.LedgerID, a.OwnerID, a.Name, a.Type, a.Category, a.InitialBalance,
				a.CreditLimit, a.RepaymentDay, a.Color, a.CreatedAt, a.UpdatedAt, a.IsDeleted,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE accounts SET name=$1, type=$2, category=$3, initial_balance=$4, credit_limit=$5, repayment_day=$6, color=$7, updated_at=$8, is_deleted=$9 WHERE id=$10`,
				a.Name, a.Type, a.Category, a.InitialBalance, a.CreditLimit, a.RepaymentDay, a.Color, a.UpdatedAt, a.IsDeleted, a.ID,
			)
			return err
		},
	)
}
```

- [ ] **Step 5: 重写 `lwwMergeTag`**

把 `sync.go:218-239` 的函数体整体替换为：

```go
func (s *SyncService) lwwMergeTag(ctx context.Context, tx dbQuerier, t model.Tag) error {
	return mergeByKey(ctx, tx, t.UpdatedAt,
		"SELECT updated_at FROM tags WHERE id = $1", []any{t.ID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5)`,
				t.ID, t.LedgerID, t.Name, t.UpdatedAt, t.IsDeleted,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3 WHERE id=$4`,
				t.Name, t.UpdatedAt, t.IsDeleted, t.ID,
			)
			return err
		},
	)
}
```

- [ ] **Step 6: 编译 + 跑测试确认绿**

Run: `cd backend && go build ./... && go test ./internal/service/ -run 'LwwMerge' -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend
git add internal/service/sync.go
git commit -m "refactor(sync): 抽 mergeByKey 骨架，收口 ledger/account/tag 的 lwwMerge"
```

---

### Task 2: 收口 memberAlias + transaction（复合主键 + 标签重建）

**Files:**
- Modify: `backend/internal/service/sync.go`（加 `syncTransactionTags`；重写 `lwwMergeMemberAlias` `sync.go:652-676`、`lwwMergeTransaction` `sync.go:284-327`）

**Interfaces:**
- Consumes: `mergeByKey`（Task 1）
- Produces: `func syncTransactionTags(ctx context.Context, tx dbQuerier, txID string, tagIDs []string) error`

- [ ] **Step 1: 确认基线绿**

Run: `cd backend && go test ./internal/service/ -run 'LwwMerge' -v`
Expected: PASS

- [ ] **Step 2: 加 `syncTransactionTags`（从现有 `lwwMergeTransaction` 尾部抽出）**

在 `lwwMergeTransaction` 函数之后插入：

```go
// syncTransactionTags 无条件先删旧关联再插新（空标签也要清空，否则旧标签会被回传「复活」）。
func syncTransactionTags(ctx context.Context, tx dbQuerier, txID string, tagIDs []string) error {
	if _, err := tx.Exec(ctx, "DELETE FROM transaction_tags WHERE transaction_id = $1", txID); err != nil {
		return err
	}
	for _, tagID := range tagIDs {
		if _, err := tx.Exec(ctx,
			"INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
			txID, tagID); err != nil {
			return err
		}
	}
	return nil
}
```

- [ ] **Step 3: 重写 `lwwMergeMemberAlias`**

把 `sync.go:652-676` 的函数体整体替换为：

```go
func (s *SyncService) lwwMergeMemberAlias(ctx context.Context, tx dbQuerier, setterUserID string, ma model.MemberAlias) error {
	return mergeByKey(ctx, tx, ma.UpdatedAt,
		"SELECT updated_at FROM member_aliases WHERE setter_user_id = $1 AND target_user_id = $2",
		[]any{setterUserID, ma.TargetUserID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at) VALUES ($1,$2,$3,$4)`,
				setterUserID, ma.TargetUserID, ma.AliasName, ma.UpdatedAt,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE member_aliases SET alias_name=$1, updated_at=$2 WHERE setter_user_id=$3 AND target_user_id=$4`,
				ma.AliasName, ma.UpdatedAt, setterUserID, ma.TargetUserID,
			)
			return err
		},
	)
}
```

- [ ] **Step 4: 重写 `lwwMergeTransaction`**

把 `sync.go:284-327` 的函数体整体替换为（INSERT/UPDATE 的列与值**不变**，只把「行合并」与「标签重建」拆开，标签重建放进 insert/update 闭包末尾，跳过时自然不重建）：

```go
func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx dbQuerier, t model.Transaction) error {
	insert := func() error {
		_, err := tx.Exec(ctx,
			`INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			t.ID, t.LedgerID, t.UserID, t.Amount, t.Type, t.FromAccountID, t.ToAccountID,
			t.CategoryID, t.Note, t.OccurredAt, t.CreatedAt, t.UpdatedAt, t.IsDeleted,
		)
		if err != nil {
			return err
		}
		return syncTransactionTags(ctx, tx, t.ID, t.TagIDs)
	}
	update := func() error {
		_, err := tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, note=$6, occurred_at=$7, updated_at=$8, is_deleted=$9 WHERE id=$10`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.Note, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
		if err != nil {
			return err
		}
		return syncTransactionTags(ctx, tx, t.ID, t.TagIDs)
	}
	return mergeByKey(ctx, tx, t.UpdatedAt,
		"SELECT updated_at FROM transactions WHERE id = $1", []any{t.ID},
		insert, update,
	)
}
```

- [ ] **Step 5: 编译 + 跑测试确认绿**

Run: `cd backend && go build ./... && go test ./internal/service/ -run 'LwwMerge' -v`
Expected: PASS（尤其 `TestLwwMergeTransactionEmptyTagsStillClears`、`TestLwwMergeMemberAliasForcesSetter`）

- [ ] **Step 6: Commit**

```bash
cd backend
git add internal/service/sync.go
git commit -m "refactor(sync): 收口 memberAlias/transaction 到 mergeByKey，抽 syncTransactionTags"
```

---

### Task 3: `query*` 收 `dbQuerier` + `Sync` 游标原子快照

**Files:**
- Modify: `backend/internal/service/sync.go`（`getRemoteChanges` `sync.go:330-386`、`backfillReferenced` `sync.go:401-452`、`queryLedgers` `:454`、`queryAccounts` `:476`、`queryTags` `:496`、`queryCategories` `:517`、`queryTransactions` `:538`、`queryLedgersByIDs` `:566`、`queryAccountsByIDs` `:588`、`queryCategoriesByIDs` `:610`、`queryTagsByIDs` `:631`、`Sync` `:33-60`）

**Interfaces:**
- Consumes: `dbQuerier`（已定义于 `sync.go:18`，同时被 `pgxpool.Pool` 与 `pgx.Tx` 满足）
- Produces: `getRemoteChanges(ctx, q dbQuerier, userID string, ledgerIDs []string, since time.Time)` 及 `query*` 系列的新签名（Task 5 的集成测试直接调用 `queryTransactions` / `Sync` 验证）

**说明（本 Task 的改动点一致且机械）**：把所有 `query*`、`query*ByIDs`、`getRemoteChanges`、`backfillReferenced` 的 `s.pool` 替换为新增的 `q dbQuerier` 参数，并把调用链一路传下去。`queryMemberAliases` 已是 `q dbQuerier` 参数，不改。

- [ ] **Step 1: 确认基线绿**

Run: `cd backend && go test ./... -count=1`
Expected: PASS

- [ ] **Step 2: 给 9 个 query 函数加 `q dbQuerier` 参数并把 `s.pool` 换成 `q`**

逐一对下面函数做「签名加 `q dbQuerier` + 函数体内 `s.pool.Query` → `q.Query`」两处修改（`queryMemberAliases` 跳过）：

| 函数 | 旧签名 | 新签名 |
|---|---|---|
| `queryLedgers` | `(ctx, ledgerIDs []string, since time.Time)` | `(ctx, q dbQuerier, ledgerIDs []string, since time.Time)` |
| `queryAccounts` | 同上 | 同上 |
| `queryTags` | 同上 | 同上 |
| `queryCategories` | `(ctx, since time.Time, ledgerIDs []string)` | `(ctx, q dbQuerier, since time.Time, ledgerIDs []string)` |
| `queryTransactions` | `(ctx, ledgerIDs []string, since time.Time)` | `(ctx, q dbQuerier, ledgerIDs []string, since time.Time)` |
| `queryLedgersByIDs` | `(ctx, ids []string)` | `(ctx, q dbQuerier, ids []string)` |
| `queryAccountsByIDs` | 同上 | 同上 |
| `queryCategoriesByIDs` | 同上 | 同上 |
| `queryTagsByIDs` | 同上 | 同上 |

示例（`queryLedgers`）：

```go
func (s *SyncService) queryLedgers(ctx context.Context, q dbQuerier, ledgerIDs []string, since time.Time) ([]model.Ledger, error) {
	rows, err := q.Query(ctx,
		`SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE id = ANY($1) AND updated_at > $2`,
		ledgerIDs, since,
	)
	// ... 其余不变（rows.Scan / rows.Err 逻辑原样保留）
}
```

- [ ] **Step 3: 给 `getRemoteChanges` 加 `q dbQuerier` 并下传**

把 `sync.go:330` 的签名改为：

```go
func (s *SyncService) getRemoteChanges(ctx context.Context, q dbQuerier, userID string, ledgerIDs []string, since time.Time) (model.SyncPayload, error) {
```

函数体里所有 `s.queryLedgers(ctx, ...)` 改为 `s.queryLedgers(ctx, q, ...)`（accounts/tags/categories/transactions 同理）；`s.queryMemberAliases(ctx, s.pool, userID, since)` 改为 `s.queryMemberAliases(ctx, q, userID, since)`；`s.backfillReferenced(ctx, &payload)` 改为 `s.backfillReferenced(ctx, q, &payload)`。

- [ ] **Step 4: 给 `backfillReferenced` 加 `q dbQuerier` 并下传**

把 `sync.go:401` 签名改为 `func (s *SyncService) backfillReferenced(ctx context.Context, q dbQuerier, payload *model.SyncPayload) error`，函数体里 4 处 `s.queryLedgersByIDs(ctx, ids)` 改为 `s.queryLedgersByIDs(ctx, q, ids)`（accounts/categories/tags 同理）。

- [ ] **Step 5: 重写 `Sync`（包 REPEATABLE READ 只读事务 + 快照游标）**

把 `sync.go:33-60` 的 `Sync` 函数体整体替换为：

```go
func (s *SyncService) Sync(ctx context.Context, userID string, req model.SyncRequest) (*model.SyncResponse, error) {
	// 1. Get all ledger IDs the user has access to
	ledgerIDs, err := s.getUserLedgerIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getUserLedgerIDs: %w", err)
	}

	// 2. Apply local changes (LWW merge)
	if err := s.applyLocalChanges(ctx, userID, ledgerIDs, req.LocalChanges); err != nil {
		return nil, fmt.Errorf("applyLocalChanges: %w", err)
	}

	// 3. 读 + 游标推进放入单个 REPEATABLE READ 只读事务，游标取事务快照时间，
	//    消除「读完成 ↔ 取游标」之间的竞态。now() 返回事务起始时间，恒 ≤ 快照，
	//    故下次 since=cursor 只会多读、不会漏读（LWW 幂等兜底）。
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin read tx: %w", err)
	}
	defer tx.Rollback(ctx)

	remoteChanges, err := s.getRemoteChanges(ctx, tx, userID, ledgerIDs, req.LastSyncedAt)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}

	var cursor time.Time
	if err := tx.QueryRow(ctx, "SELECT now()").Scan(&cursor); err != nil {
		return nil, fmt.Errorf("read cursor: %w", err)
	}

	return &model.SyncResponse{
		ServerTime:    cursor,
		RemoteChanges: remoteChanges,
	}, nil
}
```

> 注意：删掉原来 `serverTime := time.Now().UTC()` 那行及其注释（原来「在读取之前取样」的缓解逻辑被本事务方案取代）。

- [ ] **Step 6: 编译 + vet + 全量测试确认绿**

Run: `cd backend && go build ./... && go vet ./... && go test ./... -count=1`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend
git add internal/service/sync.go
git commit -m "refactor(sync): getRemoteChanges 收 dbQuerier，游标改为 REPEATABLE READ 快照"
```

---

### Task 4: testcontainers 依赖 + `setupTestDB` 基建

**Files:**
- Modify: `backend/go.mod`、`backend/go.sum`
- Create: `backend/internal/service/sync_integration_test.go`（`//go:build integration`，含 `setupTestDB` + seed 助手 + 一个冒烟测试）

**Interfaces:**
- Produces: `func setupTestDB(t *testing.T) *pgxpool.Pool`（共享容器，Task 5 的所有测试用它）；seed 助手 `seedUser` / `seedLedger` / `seedTag` / `seedTransaction`（Task 5 复用）。

- [ ] **Step 1: 加 testcontainers 依赖**

Run: `cd backend && go get github.com/testcontainers/testcontainers-go/modules/postgres@latest && go mod tidy`
Expected: 无报错，`go.mod` 出现 `testcontainers-go` 及 `modules/postgres` 相关 require

- [ ] **Step 2: 确认依赖只影响 go.mod/go.sum、编译仍绿**

Run: `cd backend && go build ./... && go vet ./...`
Expected: PASS

- [ ] **Step 3: 创建 `sync_integration_test.go`**

写 `backend/internal/service/sync_integration_test.go`（整个文件，含 build tag + setupTestDB + seed 助手 + 冒烟测试）：

```go
//go:build integration

package service

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"

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
			testcontainers.WithWaitStrategy(
				wait.ForLog("database system is ready to accept connections").
					WithOccurrence(2).
					WithStartupTimeout(60*time.Second),
			),
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
```

- [ ] **Step 4: 跑冒烟测试**

Run: `cd backend && go test -tags integration ./internal/service/ -run TestIntegration_Smoke -v -count=1`
Expected: PASS（首次会拉取 `postgres:16-alpine` 镜像，可能较慢）

- [ ] **Step 5: 确认无 tag 时仍绿**

Run: `cd backend && go test ./... -count=1`
Expected: PASS（integration 文件被 build tag 排除，不影响无 Docker 的常规测试）

- [ ] **Step 6: Commit**

```bash
cd backend
git add go.mod go.sum internal/service/sync_integration_test.go
git commit -m "test(sync): 引入 testcontainers 集成测试基建"
```

---

### Task 5: 5 条集成用例

**Files:**
- Modify: `backend/internal/service/sync_integration_test.go`（追加 5 个 `TestIntegration_*`）

**Interfaces:**
- Consumes: `setupTestDB`、`seedUser`/`seedLedger`/`seedTag`/`seedTransaction`（Task 4）；`lwwMergeLedger`/`lwwMergeCategory`/`lwwMergeTransaction`/`queryTransactions`/`Sync`（sync.go）

- [ ] **Step 1: 追加用例 1 — `lwwMergeLedger` 真 SQL LWW（更新覆盖 / 更旧跳过）**

在文件末尾追加：

```go
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
	if err := s.lwwMergeLedger(ctx, pool, l); err != nil {
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
	if err := s.lwwMergeLedger(ctx, pool, older); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT name FROM ledgers WHERE id=$1", ledgerID).Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "新名" {
		t.Fatalf("更旧的版本应跳过，got name=%q", name)
	}
}
```

- [ ] **Step 2: 追加用例 2 — `queryTransactions` 的 `array_agg` → `TagIDs` 扫描（网住 `uuid[]→[]string`）**

```go
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
		t.Fatalf("应扫出 2 个标签，got %v（若此处失败：pgx 可能无法把 uuid[] 扫进 []string，见下一步说明）", got)
	}
}
```

> **已知风险**：若本用例失败，说明 pgx v5 无法直接把 `array_agg(tag_id)`（`uuid[]`）扫进 `[]string`——这正是本集成测试要网住的 bug。修复方向：在 `queryTransactions` 的 SQL 里把 `tg.tag_id` 改为 `tg.tag_id::text`（聚合后为 `text[]`，可稳定扫进 `[]string`），或改用 `[]pgtype.UUID` 接收后转 `[]string`。修完重跑本用例直到 PASS。

- [ ] **Step 3: 追加用例 3 — 空 `TagIDs` 真清掉 `transaction_tags`（网住 tag 清空失效）**

```go
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
	if err := s.lwwMergeTransaction(ctx, pool, tx); err != nil {
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
```

- [ ] **Step 4: 追加用例 4 — 同名同类型重复分类 + 本地更旧 → 跳过（网住 category `return err` 500）**

```go
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
	if err := s.lwwMergeCategory(ctx, pool, older); err != nil {
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
```

- [ ] **Step 5: 追加用例 5 — `Sync()` 端到端返回 remote + 非零 `ServerTime`**

```go
func TestIntegration_Sync_ReturnsCursorAndRemoteChanges(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	userID := seedUser(t, pool, now)
	ledgerID := seedLedger(t, pool, userID, now)

	resp, err := s.Sync(ctx, userID, model.SyncRequest{LastSyncedAt: now.Add(-time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if resp.ServerTime.IsZero() {
		t.Fatal("ServerTime 应为非零快照游标")
	}
	found := false
	for _, l := range resp.RemoteChanges.Ledgers {
		if l.ID == ledgerID {
			found = true
		}
	}
	if !found {
		t.Fatalf("应返回种子账本，got %+v", resp.RemoteChanges.Ledgers)
	}
}
```

> 注意：用例 2/3/4/5 用到了 `model` 包，文件顶部需加 import `"wee-count/backend/internal/model"`（若尚未有）。

- [ ] **Step 6: 跑全部集成测试**

Run: `cd backend && go test -tags integration ./internal/service/ -run TestIntegration -v -count=1`
Expected: PASS（6 个：Smoke + 5 个用例）

- [ ] **Step 7: 确认无 tag 时仍绿**

Run: `cd backend && go test ./... -count=1`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
cd backend
git add internal/service/sync_integration_test.go
git commit -m "test(sync): 补 5 条真 Postgres 集成用例（LWW/标签扫描/清空/分类查重/端到端）"
```

---

### Task 6: 全量回归 + README 同步

**Files:**
- Modify: `README.md`（在「已知问题修复记录 → 同步正确性」段末尾，补充本次架构级重构的一条记录）

- [ ] **Step 1: 全量回归（含 integration）**

Run: `cd backend && go build ./... && go vet ./... && go test ./... -count=1 && go test -tags integration ./internal/service/ -run TestIntegration -count=1`
Expected: 全部 PASS

- [ ] **Step 2: README 同步真实状态**

在 README「已知问题修复记录 → 同步正确性（2026-08-14 复盘修复）」清单末尾追加一条：

```markdown
- 后端同步层架构级收口（复盘第三节）：6 份 `lwwMerge*` 样板抽 `mergeByKey` 通用骨架（category 查重分支保留），消灭「ErrNoRows 误判/return err 混淆」类 bug；增量游标改 `REPEATABLE READ` 只读事务取快照时间，消除「读↔取游标」竞态（客户端时钟偏移仍另立服务端权威游标任务）；补 testcontainers 真 Postgres 集成测试 5 条（`go test -tags integration`）网住真实 SQL 语义类 bug。
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 同步 — 后端同步层重构记录"
```

---

## Self-Review 记录

- **Spec 覆盖**：点 2 → Task 1/2；点 4 → Task 3；点 5 → Task 4/5；README 同步 → Task 6。spec 的「范围边界」（category 不改、不新增 next_cursor、客户端时钟偏移不做）已写入 Global Constraints。
- **占位符扫描**：无 TBD/TODO；所有代码块含完整实现；用例 2 的 `uuid[]→[]string` 已知风险已附修复方向。
- **类型一致性**：`mergeByKey`/`syncTransactionTags` 签名在 Task 1/2 定义、Task 3/5 引用一致；`getRemoteChanges`/`queryTransactions` 新签名在 Task 3 定义、Task 5 调用一致；model 字段类型（`Ledger.TeamID *string` 等）与 seed 助手/用例一致。
