# 后端同步层重构 — lwwMerge 收口 + 游标原子快照 + 集成测试

## 1. 背景与根因

复盘报告第三节「值得重构的点」中，后端同步层有三项未收口，共同根源在 `backend/internal/service/sync.go` 一个文件：

1. **6 份 `lwwMerge*` 高度重复**（`sync.go` 的 `lwwMergeLedger/Account/Tag/Category/Transaction/MemberAlias`），每份都重复「`SELECT updated_at` → `errors.Is(err, pgx.ErrNoRows)` 判空 → INSERT/UPDATE」三段式。高危修复阶段已逐一定点修掉 `err != nil` 误判与 category 的 `return err`，但样板仍复制 6 份，后续新增实体仍会重蹈覆辙。
2. **增量游标非原子**（`sync.go:45-49`）：`Sync` 里 `applyLocalChanges` 提交后，`getRemoteChanges` 用 `updated_at > since` 在 `s.pool` 上读（无事务），`ServerTime` 取样提前到了读之前作为缓解，但读与游标仍未落在同一一致快照内，注释自述「服务端权威游标另立任务」。
3. **无 DB 集成测试**：现有测试是纯函数 + 手写 `fakeQuerier`（`lwwmerge_test.go` 注释明确「避免引入 pgxmock」），抓不住真实 SQL 语义类 bug——`queryTransactions` 的 `array_agg(uuid[]) → []string` 扫描、tag 清空失效、category 同名查重分支，都只能在真 Postgres 上验证。

## 2. 目标

- 把 5 份重复的 lwwMerge 样板收口到一个通用 `mergeByKey` 骨架，从根上消灭「ErrNoRows 误判 / return err 与 return nil 混淆」这一类 bug。
- 让 `getRemoteChanges` 在单个 `REPEATABLE READ` 只读事务内完成读 + 游标取样，游标取事务快照时间，消除「读↔取游标之间的竞态」。
- 用 testcontainers 起真 Postgres 补集成测试，网住真实 SQL 语义 bug。

## 3. 范围（In / Out of scope）

**In scope：**
- `mergeByKey` 通用骨架 + 5 份 lwwMerge 收口（ledger/account/tag/memberAlias/transaction）。
- 游标原子一致快照（读 + 游标进同一 REPEATABLE READ 只读事务）。
- testcontainers 集成测试（5 条用例）。

**Out of scope（明确不做，另立任务）：**
- **客户端时钟偏移**：`updated_at` 是客户端时间戳，客户端时钟偏移会从根上破坏 `updated_at > since` 模型。彻底修需服务端权威游标，超出本任务。
- category 的 `lwwMergeCategory` 不强套 `mergeByKey`——其同名同类型查重分支是独特逻辑，硬塞闭包反而更绕；它已在修复阶段改为正确的 `errors.Is` 判定。
- 不新增 `next_cursor` 字段、不动前端、不动 model、不动迁移。

## 4. 点 2 设计 — `mergeByKey` 通用骨架

新增包内私有函数：

```go
// mergeByKey 是各实体 LWW merge 的公共骨架：
//   1) 按主键查 updated_at
//   2) 不存在(ErrNoRows) → insert()
//   3) 真实错误 → 直接透传
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

各实体映射：

| 实体 | keySQL | 特殊处理 |
|---|---|---|
| `lwwMergeLedger` | `SELECT updated_at FROM ledgers WHERE id = $1` | 无 |
| `lwwMergeAccount` | `SELECT updated_at FROM accounts WHERE id = $1` | 无 |
| `lwwMergeTag` | `SELECT updated_at FROM tags WHERE id = $1` | 无 |
| `lwwMergeMemberAlias` | `SELECT updated_at FROM member_aliases WHERE setter_user_id = $1 AND target_user_id = $2` | 复合主键，keyArgs 传 setter + target |
| `lwwMergeTransaction` | `SELECT updated_at FROM transactions WHERE id = $1` | insert/update 闭包末尾各调共享的 `syncTransactionTags`，实现「插入或更新才重建标签、跳过时不重建」 |
| `lwwMergeCategory` | **保持 bespoke，不改** | 同名查重分支独特 |

`syncTransactionTags`（从当前 `lwwMergeTransaction` 尾部抽出）：

```go
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

`lwwMergeTransaction` 重构后（INSERT/UPDATE 的列与值**不变**，同现有 `sync.go` 的 `lwwMergeTransaction`，只把「行合并」与「标签重建」拆开）：

```go
func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx dbQuerier, t model.Transaction) error {
    insert := func() error {
        _, err := tx.Exec(ctx, `INSERT INTO transactions (id, ledger_id, ...) VALUES ($1, ...)`, ...)
        if err != nil { return err }
        return syncTransactionTags(ctx, tx, t.ID, t.TagIDs)
    }
    update := func() error {
        _, err := tx.Exec(ctx, `UPDATE transactions SET amount=$1, ... WHERE id=$10`, ...)
        if err != nil { return err }
        return syncTransactionTags(ctx, tx, t.ID, t.TagIDs)
    }
    return mergeByKey(ctx, tx, t.UpdatedAt,
        "SELECT updated_at FROM transactions WHERE id = $1", []any{t.ID}, insert, update)
}
```

## 5. 点 4 设计 — 游标原子一致快照

### 5.1 查询函数收 `dbQuerier` 参数

把下列函数从 `s.pool` 改为接收 `dbQuerier q`（`dbQuerier` 接口本就同时被 `pgxpool.Pool` 与 `pgx.Tx` 满足）：

- `getRemoteChanges`、`backfillReferenced`
- `queryLedgers` / `queryAccounts` / `queryTags` / `queryCategories` / `queryTransactions`
- `queryLedgersByIDs` / `queryAccountsByIDs` / `queryCategoriesByIDs` / `queryTagsByIDs`
- `queryMemberAliases` 已是 `dbQuerier q` 参数，无需改。

### 5.2 `Sync` 包裹读事务

`applyLocalChanges` 保持自己的 READ COMMITTED 写事务不变；`getRemoteChanges` 改为在独立 REPEATABLE READ 只读事务内执行：

```go
// applyLocalChanges 提交后：
tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
    IsoLevel:   pgx.RepeatableRead,
    AccessMode: pgx.ReadOnly,
})
if err != nil { return nil, fmt.Errorf("begin read tx: %w", err) }
defer tx.Rollback(ctx)

remote, err := s.getRemoteChanges(ctx, tx, userID, ledgerIDs, req.LastSyncedAt)
if err != nil { return nil, fmt.Errorf("getRemoteChanges: %w", err) }

var cursor time.Time
if err := tx.QueryRow(ctx, "SELECT now()").Scan(&cursor); err != nil {
    return nil, fmt.Errorf("read cursor: %w", err)
}

return &model.SyncResponse{ServerTime: cursor, RemoteChanges: remote}, nil
```

关键点：

- `now()` 在 PG 返回 `transaction_timestamp()`（事务起始时刻），**恒 ≤ 快照**，故 `since = cursor` 下次只会多读、不会漏读，LWW 幂等兜底。
- **复用 `ServerTime` 字段**当游标，客户端 `setLastSyncedAt(res.data.server_time)` 无需改。
- 事务结束时 `defer tx.Rollback(ctx)` 释放快照即可（只读，无需 Commit）。

## 6. 点 5 设计 — 集成测试

- 工具：`testcontainers-go` + `testcontainers-go/modules/postgres`。**不用 pgxmock**——它不跑真 SQL，抓不住 `uuid[]→[]string` 扫描与真实 SQL 语义，且现有注释已声明避免该依赖。
- 文件：`backend/internal/service/sync_integration_test.go`，打 `//go:build integration` 标签，保证无 Docker 时 `go test ./...` 仍绿。
- 基建：`setupTestDB(t)` 用 `sync.Once` 共享一个 `postgres:16-alpine` 容器，跑 `database.RunMigrations`，返回 `*pgxpool.Pool`。

用例（每条对应报告「没被网住」的 bug）：

| # | 用例 | 网住的 bug |
|---|---|---|
| 1 | `lwwMergeLedger` 更新者覆盖、更旧者跳过（真 SQL LWW） | LWW 时序 |
| 2 | `queryTransactions` 的 `array_agg` → `TagIDs` 扫描正确 | `uuid[]→[]string` 扫描（fake 测不出） |
| 3 | 空 `TagIDs` 真的清掉 `transaction_tags` | tag 清空失效 |
| 4 | 同名同类型重复分类 + 本地更旧 → 跳过不报错 | category `return err` 500 |
| 5 | `Sync()` 端到端：种子账本 + 他人变更 → 返回 remote + `ServerTime` 已设 | 游标 + 端到端 |

## 7. 错误处理

- `mergeByKey` 对非 `ErrNoRows` 的真实错误直接透传（对应已修的 `TestLwwMergeLedgerReturnsRealScanError`，行为不变）。
- `Sync` 读事务内 `getRemoteChanges` 或 `SELECT now()` 失败 → 返回 error → handler 500 → 前端走 `!res.ok` 分支 → 回队 + 退避重试（现有逻辑，不改）。
- 只读事务结束 `Rollback` 释放快照，不产生锁滞留。

## 8. 改动文件清单

| 文件 | 改动 |
|---|---|
| `backend/internal/service/sync.go` | 加 `mergeByKey`/`syncTransactionTags`；5 份 lwwMerge 收口；`getRemoteChanges`+`query*` 改收 `dbQuerier`；`Sync` 加 REPEATABLE READ 只读事务 + 快照游标 |
| `backend/internal/service/sync_integration_test.go` | 新增（integration tag，5 条用例 + `setupTestDB`） |
| `backend/go.mod` / `go.sum` | 加 testcontainers 依赖 |

不碰前端、`model`、迁移、`README`（README 由 commit 时统一同步，见 CLAUDE.md）。

## 9. 验证

```bash
cd backend
go build ./... && go vet ./... && go test ./...                       # 存量单元测试必须绿
go test -tags integration ./internal/service/ -run Integration       # 新集成测试，需 Docker
```

## 10. 任务拆分

| # | 任务 | 产出 | 验证 |
|---|---|---|---|
| 1 | 加 `mergeByKey`/`syncTransactionTags`，收口 ledger/account/tag/memberAlias/transaction 五份 lwwMerge | `sync.go` | `go test` 存量 lwwmerge_test 全绿 |
| 2 | `getRemoteChanges`+`query*` 收 `dbQuerier`，`Sync` 加 REPEATABLE READ 只读事务 + 快照游标 | `sync.go` | `go build` + `go vet` + 存量测试 |
| 3 | 加 testcontainers 依赖 + `setupTestDB` 基建 | `go.mod`/`go.sum`/`sync_integration_test.go` | `go test -tags integration` 可起容器 |
| 4 | 写 5 条集成用例 | `sync_integration_test.go` | `go test -tags integration ./internal/service/` |
| 5 | 全量回归 + README 同步 | `README.md` | `go test ./...` + `go test -tags integration` |
