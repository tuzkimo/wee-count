# 同步增量引用闭包 — 根除外键卡死

## 1. 背景与根因

同步游标 `last_synced_at`（localStorage，按本地用户隔离）存的是服务端 `ServerTime = time.Now()`。后端 `getRemoteChanges` 对每张表独立按 `updated_at > since` 做增量过滤。

`transactions` 表对 `ledger_id`、`from_account_id`、`to_account_id`、`category_id` 都声明了外键（`src/db/userDb.ts:94-100`），且 SQLite 外键默认开启（sqlx `SqliteConnectOptions` 默认 `foreign_keys = ON`）。

当一笔流水的 `updated_at` 晚于游标、但它引用的账户/分类/账本的 `updated_at` 早于游标且本地从未有过该父行时，增量结果只返回流水、不返回父行。客户端 `applyRemoteChanges` 按拓扑顺序插入流水时，外键目标缺失 → 抛异常 → 游标永不推进 → 同步永久卡死，且 UI 误报「已同步」（异常未走 `markSyncResult(false)`）。

「清数据重新登录」能恢复，是因为抹掉游标后走 `firstFullSync` 全量路径，父行一并返回。

## 2. 目标

根治外键卡死：增量同步返回流水时，连带返回其引用的父行（账本/账户/分类/标签），保证父行先于子行到位。保留增量语义，不改为全量。

本次不处理设备时钟偏移、服务端游标竞态（另行记录）。

## 3. 引用关系（完整外键链）

```
account/category/tag ──ledger_id──▶ ledger
transaction ──ledger_id──▶ ledger
transaction ──from/to_account_id──▶ account
transaction ──category_id──▶ category
transaction ──tag_id(经 transaction_tags)──▶ tag
```

闭包深度只有 2 层：补拉的父行（account/category/tag）与它们所属的流水同账本，其 `ledger_id` 已在第一轮收集范围内，故一轮收集 + 一轮反查即闭合。

## 4. 后端改动 — `backend/internal/service/sync.go`

`getRemoteChanges` 在现有增量查询后新增一步：

1. **收集引用 id**（抽成纯函数 `collectReferencedIDs`，便于无 DB 单测）：
   - 从 `accounts` / `categories` / `tags` 各收集 `ledger_id`；
   - 从 `transactions` 收集 `ledger_id`、`from/to_account_id`、`category_id`、`tag_ids`（nil 指针跳过）。
2. **反查父行**：新增 `queryLedgersByIDs` / `queryAccountsByIDs` / `queryCategoriesByIDs` / `queryTagsByIDs`（`WHERE id = ANY($1)`，**不带 `since` 条件**）。
3. **合并去重**：按 id 合并进 payload 对应数组（增量结果可能已含同一条，去重后输出）。

签名建议：

```go
func collectReferencedIDs(
    accounts []model.Account,
    categories []model.Category,
    tags []model.Tag,
    transactions []model.Transaction,
) (ledgerIDs, accountIDs, categoryIDs, tagIDs map[string]bool)
```

## 5. 前端改动 — `src/services/sync.ts`

`applyRemoteChanges` **不改**：拓扑顺序（ledgers→accounts→tags→categories→transactions）+ LWW 比较已幂等，能正确消化补拉的父行（重复记录因 `updated_at` 相等被跳过）。

`performSync` 给 `await applyRemoteChanges(...)` 包 try/catch 兜底：

- 失败时 `markSyncResult(false)` 且**不推进游标**；
- 本地变更已由 `apiFetch` 成功上云（服务端 `applyLocalChanges` 事务 commit 才返回 200），**不入队重推**；
- 游标不推进 → 下次同步重新拉取相同 `remote_changes` 并重试 `applyRemoteChanges`，可自愈。

## 6. 改后数据流

```
前端 POST /sync {last_synced_at, local_changes}
  → 服务端 applyLocalChanges（LWW 事务 commit）
  → 服务端 getRemoteChanges：增量查询 + 引用闭包反查 + 合并去重
  → 返回 {server_time, remote_changes}
  → 前端 applyRemoteChanges（父先子后，LWW 幂等）
      ├─ 成功 → setLastSyncedAt(server_time)
      └─ 失败 → markSyncResult(false)，游标不动，下次重试
```

## 7. 错误处理

- 服务端补拉父行查询失败 → `getRemoteChanges` 返回 error → `Sync` 返回 500 → 前端走 `!res.ok` 分支 → `markSyncResult(false)` + 重新入队（现有逻辑 `sync.ts:145-150`）。
- 前端 `applyRemoteChanges` 失败 → 新增 try/catch → `markSyncResult(false)` + 不推游标。

## 8. 测试

- **后端** `backend/internal/service/sync_test.go`：`collectReferencedIDs` 纯函数单测——覆盖 nil 指针跳过、四类 id 集合、`tag_ids` 收集。
- **前端** `src/services/__tests__/sync.test.ts`：
  - `applyRemoteChanges` 幂等：补拉与增量重复父行不报错；
  - `performSync` 健壮性：`applyRemoteChanges` 抛异常 → `lastSyncFailed` 置位、游标不推进。

## 9. 改动文件清单

| 文件 | 改动 |
|---|---|
| `backend/internal/service/sync.go` | getRemoteChanges 补拉闭包 + 4 个 ByIDs 查询 + collectReferencedIDs |
| `backend/internal/service/sync_test.go` | collectReferencedIDs 单测 |
| `src/services/sync.ts` | performSync 给 applyRemoteChanges 包 try/catch |
| `src/services/__tests__/sync.test.ts` | 幂等 + 健壮性测试 |

## 10. 任务拆分

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| 1 | 后端 collectReferencedIDs + ByIDs 查询 + getRemoteChanges 补拉 | `sync.go` | `go test` + 单测 |
| 2 | 后端 collectReferencedIDs 单测 | `sync_test.go` | `go test` |
| 3 | 前端 performSync 兜底 try/catch | `sync.ts` | 单测 |
| 4 | 前端幂等 + 健壮性测试 | `sync.test.ts` | `npm run test` |
| 5 | README 同步真实状态 | `README.md` | 手动确认 |
