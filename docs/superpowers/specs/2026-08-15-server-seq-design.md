# 增量游标改服务端单调序列号（server_seq）设计

> 日期：2026-08-15　范围：后端 schema + 同步协议 + 前端游标，**不含金额整数分（已单列，本次不做）**

## 1. 目标与必要性

当前增量同步游标用**客户端提供的 `updated_at`**：`getRemoteChanges` 返回 `updated_at > since` 的实体，游标取快照时间。

**问题**：`updated_at` 是客户端时间戳，非单调。设备离线一周编辑一笔流水，`updated_at` = 一周前；上线补传时这笔 `updated_at < 其他设备已推进的游标`，于是 `updated_at > since` 恒假——**这笔流水其他设备永久收不到，且不自愈**。时钟偏移同理。这是离线优先 App 的核心正确性缺陷（静默丢数据）。

**目标**：增量游标改用服务端单调递增的序列号 `server_seq`，与 LWW 的客户端时间戳解耦。LWW 冲突解决仍用 `updated_at`，**只有「拉取增量」用 `server_seq`**。

## 2. 方案

给 6 张实体表各加 `server_seq BIGINT`（服务端内部字段，不暴露给客户端），配一个 Postgres 全局序列。每次 `applyLocalChanges` 真正写库（INSERT/UPDATE）时，给该行赋 `server_seq = 下一个序列值`。`getRemoteChanges` 改为 `server_seq > since_seq`。

**为什么是全局序列而非每表序列或变更日志表**：全局序列 + 单列最贴合现有「分表查询」结构，游标是单个整数；每表序列要复合游标，变更日志表要 join，改动面更大、收益不增。

## 3. Schema 迁移（新增迁移 008）

```sql
-- 008_server_seq.up.sql
CREATE SEQUENCE IF NOT EXISTS global_server_seq;

ALTER TABLE ledgers        ADD COLUMN server_seq BIGINT;
ALTER TABLE accounts       ADD COLUMN server_seq BIGINT;
ALTER TABLE categories     ADD COLUMN server_seq BIGINT;
ALTER TABLE tags           ADD COLUMN server_seq BIGINT;
ALTER TABLE transactions   ADD COLUMN server_seq BIGINT;
ALTER TABLE member_aliases ADD COLUMN server_seq BIGINT;

-- 回填存量行：赋单调序列即可（无需还原精确时序——硬切换后首同步全量重拉，顺序只要求单调）
UPDATE ledgers        SET server_seq = nextval('global_server_seq');
UPDATE accounts       SET server_seq = nextval('global_server_seq');
UPDATE categories     SET server_seq = nextval('global_server_seq');
UPDATE tags           SET server_seq = nextval('global_server_seq');
UPDATE transactions   SET server_seq = nextval('global_server_seq');
UPDATE member_aliases SET server_seq = nextval('global_server_seq');

ALTER TABLE ledgers        ALTER COLUMN server_seq SET NOT NULL;
-- ... 其余 5 表同 SET NOT NULL
```

`008_server_seq.down.sql`：`DROP COLUMN server_seq`（6 表）+ `DROP SEQUENCE global_server_seq`。

**要点**：只加列、不删改旧列，`updated_at` 完整保留（LWW 仍用它）。SQLite 前端库**不加** `server_seq`——它是纯服务端概念。

## 4. 同步协议变更

| 字段 | 现 | 改后 |
|---|---|---|
| 请求 | `last_synced_at`（时间戳字符串） | `last_server_seq`（int64） |
| 响应 | `server_time`（时间戳） | `server_seq`（int64） |

`model.SyncRequest.LastSyncedAt time.Time` → `LastServerSeq int64`；`model.SyncResponse.ServerTime time.Time` → `ServerSeq int64`。实体 payload（`remote_changes`）不变——客户端不需要 `server_seq`。

## 5. 服务端改动

1. **`applyLocalChanges`**：6 个 `lwwMerge*` 的 INSERT 和 UPDATE 都补 `server_seq = nextval('global_server_seq')`（INSERT 可改为列 `DEFAULT nextval(...)`，UPDATE 显式 `SET server_seq = nextval(...)`）。**LWW skip 分支不 bump**（没写库就不该有新序列号）。
2. **`getRemoteChanges`**：六个 `query*` 的 `updated_at > $since` 改为 `server_seq > $since_seq`；`since` 参数从 `time.Time` 改为 `int64`。
3. **游标快照**：仍在 REPEATABLE READ 只读事务内。游标 = 快照内 `MAX(server_seq)` 全局高水位（`SELECT MAX(s) FROM (6 表各自 MAX(server_seq) UNION ALL)`）。客户端每个用户各自持有自己的游标值；`getRemoteChanges` 同时用 `ledger_id = ANY($ledgerIDs)` 过滤，保证只返回该用户可访问的实体。

   正确性论证：全局 seq 单调；REPEATABLE READ 快照内读到的「实体 + 全局 max」一致；快照后提交的写必有更大的 seq，下次 `server_seq > cursor` 会取到；seq 空洞（回滚事务消费了 nextval）不会造成漏读。

## 6. 前端改动

1. 游标键 `last_synced_at:<uid>` → `last_server_seq:<uid>`（`cursorKeyFor`/`cursorKey`）。
2. `doSync` 读写的游标值从时间戳字符串改为整数。
3. `firstFullSync`（`migration.ts`）发的 `last_synced_at: '1970-01-01T00:00:00Z'` 改为 `last_server_seq: 0`。
4. `applyRemoteChanges` 不变（合并实体，不关心 seq）。

## 7. 迁移与硬切换（无兼容期）

用户少，采用**硬切换**，不做双读双写：

1. 部署后端 v2（加列 + 协议改）。
2. 部署前端 v2（新游标键）。
3. 前端 v2 首同步：`last_server_seq:<uid>` 为 null → 走 `firstFullSync`。`firstFullSync` **先推本地全部数据（含未同步的离线改动）再拉全量**（已核实 `migration.ts`），故**无数据丢失、无需清数据、无需用户操作**。旧 `last_synced_at` 键自动废弃。

**残留风险**：硬切换当天仍在旧 APK 的客户端，按旧协议发 `last_synced_at`（时间戳），后端 v2 会解析失败。缓解：少量用户，同一天协调升级即可；极端离线用户回来后手动清数据重登一次。

## 8. 回滚预案

- 后端：`008 down` 迁移删列 + 回退代码。`updated_at` 全程保留，LWW 不受影响。
- 前端：回退旧 APK（旧客户端仍读旧游标键）。
- 数据安全：加列不触碰旧列、`nextval` 不回滚旧数据，迁移前后 Postgres 备份。

## 9. 测试

- 集成测试：设备 A 离线旧 `updated_at` 推送一笔流水，设备 B 以新游标能拉到（server_seq 语义）。
- 迁移测试：回填后 `server_seq` 全非空、单调、无重复。
- 回归：现有 LWW 集成测试不受影响（`updated_at` 保留）。

## 10. 非目标

- 金额浮点 → 整数分（A）：本次不做，已单列。
- LWW 冲突解决本身仍用客户端 `updated_at`：server_seq 只修游标，不修「双设备时钟偏移编辑同一实体时 LWW 选错赢家」这一更小的边界（可另立专项，不影响本次价值）。
