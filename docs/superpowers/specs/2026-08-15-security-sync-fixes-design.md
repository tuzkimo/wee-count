# 安全与同步修复（桶一 + 桶三）设计

> 日期：2026-08-15　前置：`docs/2026-08-14-复盘报告.md` + 全项目 4 路只读审计
> 范围：不动数据库 schema 的定点 bug 修复 + 清理。schema 变更项（金额整数分、增量游标版本号）已拆出，另开专项。

## 范围边界

- **本次做**：桶一（17 项 bug 修复，不动 schema）+ 桶三（清理项）。
- **本次不做**（另开专项，红线）：
  - 金额浮点 → 整数分（SQLite/Postgres 迁移 + 全链路）
  - 增量游标 → 服务端单调版本号（同步协议升级）

## 三个已确认的决策

1. **金额**：本次只做「累加/展示统一 round」的轻量缓解，不改 schema。
2. **`new Function`**：改手写解析器（数字 + 四则 + 括号），彻底去掉 eval。
3. **`lwwMergeLedger` 的 INSERT 死分支**：直接删除（连带删除其单元测试 `TestLwwMergeLedgerInsertForcesOwner`），
   与「非 owner 成员不能改共享账本 name/type」一起重写。

## 工作流 W1 · 后端安全/鉴权

| 项 | 改动点 | 说明 |
|---|---|---|
| 令牌分层 | `middleware/auth.go` | 解析 claims 后强制 `typ=="access"`，否则 401；Refresh 已要求 `typ=="refresh"`，成对 |
| 非 owner 改账本 | `service/sync.go` `lwwMergeLedger` | 删 INSERT 死分支；team 型账本非 owner 跳过 name/type 更新 |
| 账号枚举 | `handler/auth.go` `Register` | 错误话术改为「用户名不可用」，不区分「已注册」 |
| body 上限 | `handler/*.go` | `Decode` 前 `http.MaxBytesReader`（1MB）+ username/nickname 长度校验 |
| 邀请码先消费 | `service/team.go` `JoinByInvite` | `redis.Del` 后移到成员校验 + INSERT 成功之后 |
| Register TOCTOU | `service/auth.go` `Register` | 捕获 `23505` 唯一冲突返回 `ErrUsernameTaken` |

## 工作流 W2 · 后端同步正确性

| 项 | 改动点 | 说明 |
|---|---|---|
| 标签同名去重 | `lwwMergeTag` | 仿 `lwwMergeCategory`：INSERT 前查 `(ledger_id,name,is_deleted=FALSE)`，命中则 UPDATE 旧行 |
| backfill 归属 | `backfillReferenced` + `query*ByIDs` | 反查 SQL 加 `AND ledger_id = ANY($2)`，传入 `ledgerIDs` |
| mergeByKey 并发 | `mergeByKey` | SELECT 加 `FOR UPDATE`；INSERT 撞 `23505` 回退 UPDATE |
| GetMe 口径 | `service/auth.go` `GetMe` | 账本查询改 owner UNION team_members，与 `getUserLedgerIDs` 一致 |
| 子实体归属 | `lwwMergeAccount/Category/Transaction` | INSERT 的 `owner_id`/`user_id` 用服务端 `userID` 覆盖（签名加 `userID` 参数） |

## 工作流 W3 · 前端同步正确性

| 项 | 改动点 | 说明 |
|---|---|---|
| 标签同名去重 | `services/sync.ts` tags 分支 | 仿 categories：查同名 → 改指 `transaction_tags.tag_id` + 删旧 + 插新 |
| note 丢失 | `services/sync.ts` transactions INSERT/UPDATE | 补 `note` 列及占位符 |
| 登出竞态 | `services/sync.ts` + `stores/auth.ts` | `doSync` 快照 uid/db 传参；`clearPendingSync` 去掉 `isSyncing=false` |
| apiFetch 单飞 | `services/api.ts` | refresh 用 in-flight Promise 单飞；`apiFetch` 统一 catch 返回 `{ok:false}` |
| mergeChanges 字典序 | `services/sync.ts` | `mergeChanges` 改走 `compareTimestamp` |

## 工作流 W4 · 前端 UI + 清理

| 项 | 改动点 | 说明 |
|---|---|---|
| AccountEdit 刷新失效 | `views/AccountEdit.vue` | `onMounted` 先 `ledgerStore.init()` + `accountStore.fetchAll()` |
| AccountCreateSheet 猜 id | `stores/account.ts` + `components/AccountCreateSheet.vue` | `add` 返回新 id，组件直接用 |
| DateTimePicker 越界 | `components/DateTimePicker.vue` | 范围外不回退年份，保留原值 |
| 金额累加精度 | `stores/transaction.ts` / `stores/account.ts` / `services/reports.ts` | 累加点统一 `Math.round(x*100)/100` |
| new Function | `utils/expression.ts` | 手写解析器 |
| AccountSheet 去重 | `components/AccountSheet.vue` | 复用 `AccountFormFields` |
| ProfilePage 死代码 | `views/ProfilePage.vue` | 删除未使用的 `saved` ref |

## 测试与验证

- 后端：`go test ./...`（含 testcontainers 集成测试，本机 Docker 已启用）。
- 前端：`npm run test`（vitest）+ `npm run build`（vue-tsc 类型检查）。
- 每项修复对应新增/更新单元测试，不删改无关已有测试（`TestLwwMergeLedgerInsertForcesOwner` 因删死代码而连带删除除外）。

## 非目标（明确不做）

- 不做 refresh token 轮换/撤销/黑名单（属「令牌分层」之外的会话治理，留待桶二或后续专项）。
- 不做限流 key 防伪造（`clientIPKey` 信任 X-Forwarded-For，注释已自认「后续收紧」，需部署层配合）。
- 不做 HTTPS 终止 / 基础镜像升级（部署层，不属代码）。
