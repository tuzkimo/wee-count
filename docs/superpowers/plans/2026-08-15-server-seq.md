# 增量游标改服务端 server_seq 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增量同步游标从客户端 `updated_at` 改为服务端单调 `server_seq`，堵住离线旧时间戳补传被永久漏掉的丢数据缺陷。

**Architecture:** 6 张实体表加 `server_seq BIGINT`（`DEFAULT nextval` 全局序列）；写库时 INSERT 走 DEFAULT、UPDATE 显式 bump；读增量改 `server_seq > since`；游标取快照内全局 `MAX(server_seq)`。硬切换，无兼容期——前端换游标键触发一次全量重拉。

**Tech Stack:** Go + PostgreSQL（golang-migrate + pgx）、Vue3 + TS（Tauri + SQLite 本地，本地无 server_seq）。

**Spec:** `docs/superpowers/specs/2026-08-15-server-seq-design.md`

## Global Constraints

- 只加 `server_seq` 列，**不删改** `updated_at` 或其它旧列；LWW 冲突解决仍用 `updated_at`。
- SQLite 前端库**不加** server_seq（纯服务端概念）。
- 硬切换：前端换游标键 `last_server_seq:<uid>`，无兼容期。
- 禁止 `any`（前端 TS 严格模式）。
- 每次 commit 用 conventional commits 前缀，不加 Co-Authored-By。
- 后端验证：`go test ./...` + `go test -tags integration ./internal/service/`（testcontainers，Docker 已启用）。
- 前端验证：`npm run test` + `npm run build`。
- README 同步：阶段末合并做一次。

---

### Task 1: 迁移 008 —— 加 server_seq 列 + 全局序列

**Files:**
- Create: `backend/internal/database/migrations/008_server_seq.up.sql`
- Create: `backend/internal/database/migrations/008_server_seq.down.sql`

**Interfaces:**
- Produces: 6 张表各有 `server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq')`；全局序列 `global_server_seq`。后续 Task 2/3 依赖此列与序列。

- [ ] **Step 1: 写迁移 up**

`008_server_seq.up.sql`：

```sql
-- 增量同步游标改服务端单调序列号：加 server_seq 列 + 全局序列。
-- DEFAULT nextval 让存量行回填单调值，同时让后续 INSERT 自动赋值；UPDATE 需显式 nextval（见 Task 2）。
CREATE SEQUENCE IF NOT EXISTS global_server_seq;

ALTER TABLE ledgers        ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE accounts       ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE categories     ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE tags           ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE transactions   ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
ALTER TABLE member_aliases ADD COLUMN server_seq BIGINT NOT NULL DEFAULT nextval('global_server_seq');
```

- [ ] **Step 2: 写迁移 down**

`008_server_seq.down.sql`：

```sql
ALTER TABLE ledgers        DROP COLUMN server_seq;
ALTER TABLE accounts       DROP COLUMN server_seq;
ALTER TABLE categories     DROP COLUMN server_seq;
ALTER TABLE tags           DROP COLUMN server_seq;
ALTER TABLE transactions   DROP COLUMN server_seq;
ALTER TABLE member_aliases DROP COLUMN server_seq;
DROP SEQUENCE IF EXISTS global_server_seq;
```

- [ ] **Step 3: 跑集成测试基建验证迁移能 up/down**

Run: `cd backend && go test -tags integration ./internal/service/ -run TestIntegration_TagDedupRemapsTransactionTags -count=1`
Expected: PASS（`setupTestDB` 会跑 `RunMigrations` 到最新，若迁移 SQL 有误此处会失败）

- [ ] **Step 4: 提交**

```bash
git add backend/internal/database/migrations/008_server_seq.up.sql backend/internal/database/migrations/008_server_seq.down.sql
git commit -m "feat(db): 迁移 008 加 server_seq 列 + 全局序列"
```

---

### Task 2: applyLocalChanges 写侧 bump server_seq

**Files:**
- Modify: `backend/internal/service/sync.go`（6 个 `lwwMerge*` 的 UPDATE 语句）
- Test: `backend/internal/service/sync_integration_test.go`

**Interfaces:**
- Consumes: `global_server_seq` 序列（Task 1）。
- Produces: 每次实际 UPDATE 写库时 `server_seq = nextval('global_server_seq')`。INSERT 无需改（列 DEFAULT 已赋值）。

- [ ] **Step 1: 写失败测试**

在 `sync_integration_test.go` 追加：同步一笔流水后，该行 `server_seq` 非空且严格大于其 `updated_at` 之前已有行的 `server_seq`（验证写库 bump 了序列）。实现后 RED→GREEN。

```go
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
```

- [ ] **Step 2: 运行确认失败**

Run: `go test -tags integration ./internal/service/ -run TestIntegration_WriteBumpsServerSeq -count=1`
Expected: FAIL（编译错误——`model.SyncRequest` 尚无 `LastServerSeq` 字段；此测试与 Task 3 的模型字段耦合，故本 Step 失败信号是编译错。执行者若想在 Task 2 独立验证，可临时用 `LastSyncedAt` 字段名，但最终以 Task 3 的 `LastServerSeq` 为准）

> 说明：Task 2 与 Task 3 的模型字段有依赖——`LastServerSeq` 在 Task 3 才引入。本任务实现只改 UPDATE 的 SQL，测试可在 Task 3 之后跑。为保持各任务自洽，本测试允许在 Task 3 完成后一起 GREEN。

- [ ] **Step 3: 实现 —— 6 个 UPDATE 加 `server_seq = nextval('global_server_seq')`**

`lwwMergeLedger`（sync.go 约 227 行）：

```go
	_, err = tx.Exec(ctx,
		`UPDATE ledgers SET name=$1, type=$2, updated_at=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
		l.Name, l.Type, l.UpdatedAt, l.ID,
	)
```

`lwwMergeAccount` 的 update 闭包：

```go
		_, err := tx.Exec(ctx,
			`UPDATE accounts SET name=$1, type=$2, category=$3, initial_balance=$4, credit_limit=$5, repayment_day=$6, color=$7, updated_at=$8, is_deleted=$9, server_seq = nextval('global_server_seq') WHERE id=$10`,
			a.Name, a.Type, a.Category, a.InitialBalance, a.CreditLimit, a.RepaymentDay, a.Color, a.UpdatedAt, a.IsDeleted, a.ID,
		)
```

`lwwMergeCategory` 两处 UPDATE（dup 分支与 id 分支）都加 `server_seq = nextval('global_server_seq')`：

```go
			`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6, server_seq = nextval('global_server_seq') WHERE id=$7`,
			// 参数列表不变（7 个参数，server_seq 无占位符）
```

```go
		`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6, server_seq = nextval('global_server_seq') WHERE id=$7`,
```

`lwwMergeTag` 两处 UPDATE 同样加 `server_seq = nextval('global_server_seq')`（参数不变）：

```go
			`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
```

```go
		`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3, server_seq = nextval('global_server_seq') WHERE id=$4`,
```

`lwwMergeTransaction` 的 update 闭包：

```go
		_, err := tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, note=$6, occurred_at=$7, updated_at=$8, is_deleted=$9, server_seq = nextval('global_server_seq') WHERE id=$10`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.Note, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
```

`lwwMergeMemberAlias` 的 update 闭包：

```go
		_, err := tx.Exec(ctx,
			`UPDATE member_aliases SET alias_name=$1, updated_at=$2, server_seq = nextval('global_server_seq') WHERE setter_user_id=$3 AND target_user_id=$4`,
			ma.AliasName, ma.UpdatedAt, setterUserID, ma.TargetUserID,
		)
```

注意：INSERT 语句**不改**（列的 `DEFAULT nextval('global_server_seq')` 已自动赋值）。

- [ ] **Step 4: 运行单测确认编译通过**

Run: `go test ./internal/service/ -count=1`
Expected: PASS（现有单测用 fakeQuerier，不碰真实序列；UPDATE SQL 加了 nextval 但 fake 不执行）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/sync.go
git commit -m "feat(sync): 写库时 bump server_seq（6 实体 UPDATE）"
```

---

### Task 3: getRemoteChanges 读侧 + 协议字段

**Files:**
- Modify: `backend/internal/model/sync.go`
- Modify: `backend/internal/service/sync.go`（`Sync`、`getRemoteChanges`、六个 `query*`）
- Test: `backend/internal/service/sync_integration_test.go`

**Interfaces:**
- Consumes: `server_seq` 列（Task 1）。
- Produces: `model.SyncRequest{LastServerSeq int64}`、`model.SyncResponse{ServerSeq int64}`；`getRemoteChanges(ctx, q, userID, ledgerIDs, sinceSeq int64)`；六个 `query*(ctx, q, ..., sinceSeq int64)`。

- [ ] **Step 1: 改 model**

`model/sync.go`：

```go
type SyncRequest struct {
	LastServerSeq int64       `json:"last_server_seq"`
	LocalChanges  SyncPayload `json:"local_changes"`
}

type SyncResponse struct {
	ServerSeq     int64       `json:"server_seq"`
	RemoteChanges SyncPayload `json:"remote_changes"`
}
```

（删除 `time` import 若不再使用——`MemberAlias.UpdatedAt time.Time` 仍用，故保留。）

- [ ] **Step 2: 改 Sync() 方法**

`sync.go` `Sync`（约 55-93 行）：

```go
	// 3. 读 + 游标推进放入单个 REPEATABLE READ 只读事务，游标取快照内的全局 MAX(server_seq)。
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin read tx: %w", err)
	}
	defer tx.Rollback(ctx)

	remoteChanges, err := s.getRemoteChanges(ctx, tx, userID, ledgerIDs, req.LastServerSeq)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}

	var cursor int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(s), 0) FROM (
		SELECT MAX(server_seq) AS s FROM ledgers
		UNION ALL SELECT MAX(server_seq) FROM accounts
		UNION ALL SELECT MAX(server_seq) FROM categories
		UNION ALL SELECT MAX(server_seq) FROM tags
		UNION ALL SELECT MAX(server_seq) FROM transactions
		UNION ALL SELECT MAX(server_seq) FROM member_aliases
	) m`).Scan(&cursor); err != nil {
		return nil, fmt.Errorf("read cursor: %w", err)
	}

	return &model.SyncResponse{
		ServerSeq:     cursor,
		RemoteChanges: remoteChanges,
	}, nil
```

- [ ] **Step 3: 改 getRemoteChanges 签名与 query\* 过滤**

`getRemoteChanges` 签名 `since time.Time` → `sinceSeq int64`，内部六个调用传 `sinceSeq`：

```go
func (s *SyncService) getRemoteChanges(ctx context.Context, q dbQuerier, userID string, ledgerIDs []string, sinceSeq int64) (model.SyncPayload, error) {
	if len(ledgerIDs) == 0 {
		return model.SyncPayload{}, nil
	}
	payload := model.SyncPayload{}
	ledgers, err := s.queryLedgers(ctx, q, ledgerIDs, sinceSeq)
	// ... 其余 query* 同理（accounts/tags/categories/transactions/member_aliases）
}
```

六个 `query*` 签名与 WHERE 改动：

- `queryLedgers(ctx, q, ledgerIDs, sinceSeq int64)`：`WHERE id = ANY($1) AND server_seq > $2`
- `queryAccounts(ctx, q, ledgerIDs, sinceSeq int64)`：`WHERE ledger_id = ANY($1) AND server_seq > $2`
- `queryTags(ctx, q, ledgerIDs, sinceSeq int64)`：`WHERE ledger_id = ANY($1) AND server_seq > $2`
- `queryCategories(ctx, q, sinceSeq int64, ledgerIDs []string)`：`WHERE server_seq > $1 AND ledger_id = ANY($2)`
- `queryTransactions(ctx, q, ledgerIDs, sinceSeq int64)`：`WHERE t.ledger_id = ANY($1) AND t.server_seq > $2`
- `queryMemberAliases(ctx, q, userID string, sinceSeq int64)`：`WHERE setter_user_id = $1 AND server_seq > $2`

（各函数的 `since` 参数类型从 `time.Time` 改为 `int64`，SQL 里 `updated_at > $N` 改为 `server_seq > $N`，其余列与 Scan 不变。若 `time` 包在该文件其它处不再使用，注意 import。）

- [ ] **Step 4: 运行全量后端测试确认编译 + 单测通过**

Run: `go test ./... -count=1`
Expected: PASS（`TestQueryMemberAliasesFiltersBySetter` 等既有单测若断言 `updated_at` 需同步改——执行者须 `grep -n "updated_at >" internal/service/*_test.go` 排查并更新断言为 `server_seq >`）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/model/sync.go backend/internal/service/sync.go
git commit -m "feat(sync): 增量读改 server_seq 游标 + 协议字段 last_server_seq/server_seq"
```

---

### Task 4: 前端协议 + 游标键

**Files:**
- Modify: `src/services/sync.ts`（`SyncRequest`/`SyncResponse` 类型、`cursorKeyFor`、`doSync`、`setLastSyncedAt` 处）
- Modify: `src/services/migration.ts`（`firstFullSync`）
- Test: `src/services/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: 后端协议 `last_server_seq`（int）/`server_seq`（int）（Task 3）。
- Produces: 游标键 `last_server_seq:<uid>`，游标值为整数字符串。

- [ ] **Step 1: 改游标键与类型**

`sync.ts`：

```ts
interface SyncRequest {
  last_server_seq: number;
  local_changes: SyncPayload;
}

interface SyncResponse {
  server_seq: number;
  remote_changes: SyncPayload;
}
```

```ts
function cursorKeyFor(uid: string | null): string {
  return uid ? `last_server_seq:${uid}` : "last_server_seq";
}
```

- [ ] **Step 2: 改 doSync 读游标 + 发请求 + 存游标**

`doSync` 内：

```ts
  const lastSyncedAt = getLastSyncedAt();
  if (!lastSyncedAt) {
    const { firstFullSync } = await import('./migration')
    try { await firstFullSync() } catch (e) { ... }
    ...
  }
  const lastServerSeq = parseInt(lastSyncedAt, 10);
  ...
    body: JSON.stringify({
      last_server_seq: lastServerSeq,
      local_changes: changes,
    } as SyncRequest),
  ...
  setLastSyncedAt(String(res.data.server_seq));
```

（`getLastSyncedAt`/`setLastSyncedAt` 函数体不变，仍是 localStorage 读写，只是键名与值类型变了。）

- [ ] **Step 3: 改 firstFullSync 协议字段**

`migration.ts` `firstFullSync`：

```ts
  const resp = await apiFetch<{ server_seq: number; remote_changes: { ledgers: unknown[]; accounts: unknown[]; tags: unknown[]; categories: unknown[]; transactions: unknown[] } }>('/sync', {
    method: 'POST',
    body: JSON.stringify({
      last_server_seq: 0,
      local_changes: { ledgers, accounts, categories, tags, transactions },
    }),
  })
  ...
    setLastSyncedAt(String(resp.data.server_seq))
```

- [ ] **Step 4: 运行前端测试 + 类型检查**

Run: `npm run test -- src/services/__tests__/sync.test.ts` 然后 `npm run build`
Expected: PASS（若既有测试 mock 了 `/sync` 响应的 `server_time` 字段，需改为 `server_seq`——执行者 `grep -rn "server_time\|last_synced_at" src/services/__tests__` 排查）

- [ ] **Step 5: 提交**

```bash
git add src/services/sync.ts src/services/migration.ts src/services/__tests__/sync.test.ts
git commit -m "feat(sync): 前端游标改 last_server_seq + 协议字段 server_seq"
```

---

### Task 5: 集成测试（server_seq 语义）+ 迁移测试

**Files:**
- Modify: `backend/internal/service/sync_integration_test.go`
- Test: `backend/internal/service/sync_integration_test.go`

**Interfaces:**
- Consumes: Task 2/3 的写侧 bump + 读侧 server_seq 游标。

- [ ] **Step 1: 写核心语义集成测试**

追加：设备 A 用「旧 `updated_at`」（模拟离线一周编辑）推送一笔流水，设备 B 以「旧游标」同步应能拉到该笔（server_seq 语义——旧时间戳补传不再漏）。

```go
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
```

- [ ] **Step 2: 运行集成测试**

Run: `go test -tags integration ./internal/service/ -run 'TestIntegration_OldUpdatedAtStillPulledByServerSeq|TestIntegration_WriteBumpsServerSeq' -count=1`
Expected: PASS

- [ ] **Step 3: 跑全量集成测试确认无回归**

Run: `go test -tags integration ./internal/service/ -count=1`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add backend/internal/service/sync_integration_test.go
git commit -m "test(sync): 集成用例覆盖 server_seq 旧时间戳补传语义"
```

---

### Task 6: README 同步 + 全量验证

- [ ] **Step 1: 更新 README.md**

在「已知问题修复记录」的 2026-08-15 子节追加一条：

```markdown
- 增量游标非单调漏同步：增量同步用客户端 `updated_at` 做游标，设备离线编辑后 `updated_at` 落后于其他设备已推进的游标，这笔变更被永久漏掉；现给 6 张实体表加服务端单调 `server_seq`（全局序列，写库 bump、读增量按 `server_seq > since`），游标与 LWW 的客户端时间戳解耦；协议字段 `last_synced_at`/`server_time` 改 `last_server_seq`/`server_seq`（硬切换，前端换游标键触发一次全量重拉）。
```

- [ ] **Step 2: 全量后端验证**

Run: `cd backend && go test ./... -count=1 && go test -tags integration ./internal/service/ -count=1`
Expected: 全 PASS

- [ ] **Step 3: 全量前端验证**

Run: `npm run test && npm run build`
Expected: 全 PASS

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 — server_seq 增量游标"
```

---

## 自检记录（writing-plans self-review）

- **Spec 覆盖**：§3 schema → Task 1；§5.1 写侧 bump → Task 2；§5.2/5.3 读侧+游标 → Task 3；§4 协议字段 → Task 3/4；§6 前端 → Task 4；§9 测试 → Task 5；§7 硬切换 → Task 4（换游标键）；§8 回滚 → Task 1（down 迁移）。
- **占位符扫描**：无 TBD/TODO；Task 2 Step 2 标注「编译错为失败信号」是明确指令，非占位。
- **类型一致性**：`LastServerSeq int64`（Task 3 定义，Task 2 测试引用）；`sinceSeq int64`（Task 3 定义并贯穿六个 query*）；`server_seq` 列名（Task 1 定义，Task 2/3/5 引用）；游标键 `last_server_seq:<uid>`（Task 4）。
- **依赖顺序**：Task 1（列）→ Task 2（写 bump）→ Task 3（读+协议）→ Task 4（前端）→ Task 5（集成测试）→ Task 6（README+验证）。Task 2 测试引用的 `LastServerSeq` 字段在 Task 3 才引入，已在 Task 2 Step 2 显式标注「可在 Task 3 后一起 GREEN」，不阻塞执行。
