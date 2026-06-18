# 用户数据隔离与 Onboarding 流程 — 设计方案

日期：2026-06-18 | 状态：待评审

## 1. 背景与目标

当前三个问题根因相同——没有用户级数据隔离：

| # | 现象 | 根因 |
|---|------|------|
| ① | 每注册一个用户就重复创建 14 条默认分类 | 注册流程无条件 INSERT defaultCategories，`ledger_id = NULL` 不防重 |
| ② | 本地数据不会自动归属到注册用户 | 本地 SQLite 用硬编码 `local-user-1` / `personal-ledger-1`，与服务端 ID 无关联 |
| ③ | 退出登录后换用户仍能看到旧数据 | 所有用户共用同一个 `wee-count.db`，登出不清数据库 |

目标：

- 纯本地和多用户切换都通过账户密码隔离数据
- 本地转在线时，数据自动归属到线上账本
- 默认分类每个账本独立拷贝，互不干扰

## 2. 数据隔离模型

### 2.1 每用户独立 SQLite

```
设备本地文件:
  .wee-count/
    └── db/
        ├── _meta.db             # 全局元数据（用户列表）
        ├── <user_id_1>.db       # 用户 A 的业务数据库
        └── <user_id_2>.db       # 用户 B 的业务数据库
```

选择独立 db 文件而非单库 `WHERE user_id = ?` 过滤：

- 物理隔离，不会因漏写过滤条件导致数据泄露
- 切换用户 = 切换 db 连接，逻辑简单
- 符合"操作系统多用户"的直觉
- 未来删除用户 = 删除一个文件

### 2.2 用户数据库结构

每个 `<user_id>.db` 只包含业务表：

```sql
-- 一个用户可以有多个账本（个人 + 参与的团队）
-- 所有业务数据通过 ledger_id 区分归属

CREATE TABLE ledgers (
    id TEXT PRIMARY KEY,        -- 本地 ledger ID（绑定后 = server_ledger_id）
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'personal',  -- 'personal' | 'team'
    ...
);

CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id),
    ...
);

CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id),  -- 不再有 NULL
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    ...
);

CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id),
    ...
);

CREATE TABLE transactions (
    id TEXT PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledgers(id),
    ...
);
```

团队账本兼容：一个 `<user_id>.db` 内可包含个人账本和多个团队账本，查询时按当前选中账本的 `ledger_id` 过滤，无需额外的用户级隔离。

### 2.3 元数据库

全局的 `_meta.db` 存储本地用户列表，不依赖硬编码 ID：

```
.wee-count/
  └── db/
      └── _meta.db             # 用户注册表，启动时读取
```

```sql
CREATE TABLE local_users (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    api_url TEXT,               -- NULL = 纯本地模式
    server_user_id TEXT,        -- NULL = 未绑定服务端
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

客户端初始化流程：

```
启动 → 打开 _meta.db → 读取 local_users
  ├─ 表为空 → 显示欢迎页（创建账户）
  └─ 有用户 → 显示登录页（输入用户名 + 密码）
```

## 3. 默认分类：模板拷贝模式

### 3.1 问题分析

`ledger_id = NULL` 全局共享有两个问题：
- 每个用户注册都 INSERT 一次导致重复（bug ①）
- 如果允许修改 NULL 分类，不同用户的修改会互相覆盖

### 3.2 方案：代码常量模板 + 每种账本独立拷贝

14 条默认分类定义为代码常量（Go 后端 + TypeScript 前端各一份），不再存在数据库中：

```go
// 后端常量
var DefaultCategories = []struct{ Name, Type, Icon string; SortOrder int }{
    {"餐饮", "expense", "🍜", 1},
    {"交通", "expense", "🚌", 2},
    {"购物", "expense", "🛒", 3},
    {"娱乐", "expense", "🎮", 4},
    {"居家", "expense", "🏠", 5},
    {"通讯", "expense", "📱", 6},
    {"医疗", "expense", "💊", 7},
    {"其他支出", "expense", "💸", 99},
    {"工资", "income", "💰", 1},
    {"奖金", "income", "🎁", 2},
    {"理财", "income", "📈", 3},
    {"退款", "income", "↩️", 4},
    {"报销", "income", "🧾", 5},
    {"其他收入", "income", "📥", 99},
}
```

创建账本时（个人或团队），从常量拷贝 14 条到该账本下：

```
创建账本 X:
  for each c in DefaultCategories:
    INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
    VALUES (uuid_v4(), X, c.name, c.type, c.icon, c.sort_order, NOW())
```

- 存储层面，默认分类和用户自建分类完全一致（`ledger_id = 账本 ID`，`id = UUIDv4`）
- 用户修改的是自己账本那份，不影响其他账本
- 不再需要 `ledger_id IS NULL` 语义
- 不再需要 UUIDv5，普通 UUIDv4 即可

### 3.3 数据库 schema 变更

```sql
-- 旧
CREATE TABLE categories (
    ...
    ledger_id UUID REFERENCES ledgers(id),   -- 可为 NULL
    ...
);

-- 新
CREATE TABLE categories (
    ...
    ledger_id UUID REFERENCES ledgers(id) NOT NULL,  -- 必须归属某个账本
    ...
);
```

### 3.4 查询简化

```sql
-- 旧: 需要处理 NULL 全局分类
SELECT * FROM categories WHERE (ledger_id = ? OR ledger_id IS NULL) AND is_deleted = 0

-- 新: 直接按账本过滤
SELECT * FROM categories WHERE ledger_id = ? AND is_deleted = 0
```

## 4. 团队权限模型

分类是账本级别的资源，权限由 `team_members.role` 决定。沿用现有表结构，不新增字段：

| 操作 | owner | member |
|------|-------|--------|
| 管理成员（邀请/踢人） | ✅ | ❌ |
| 创建/编辑账户 | ✅ | ✅ |
| 删除账户 | ✅ | ❌ |
| 创建/编辑分类 | ✅ | ✅ |
| 删除分类 | ✅ | ❌ |
| 创建/编辑/删除标签 | ✅ | ✅ |
| 创建/编辑/删除流水 | ✅ | ✅ |

核心逻辑：member 能增不能删（除流水和标签），owner 全权。不急着全做——当前先校验成员管理和删除 API，其余操作暂时放开。

## 5. 同步策略

所有业务数据（账户、分类、标签、流水）均按 `ledger_id` 过滤同步，无特殊处理：

| 数据类型 | 同步策略 |
|----------|----------|
| accounts | 按 `ledger_id` 过滤 |
| categories | 按 `ledger_id` 过滤（不再有 NULL 特殊逻辑） |
| tags | 按 `ledger_id` 过滤（维持现状） |
| transactions | 按 `ledger_id` 过滤 |

默认分类不再由同步处理——每个账本创建时已从本地常量拷贝，和服务端 ID 无关。

## 6. 用户生命周期

```
┌─────────────────────────────────────────────────────┐
│                    首次启动                          │
│              显示 WelcomePage                        │
│         "创建本地账户以开始记账"                       │
│             输入昵称 + 密码                           │
│             创建 _meta.db 用户记录                    │
│             创建 <user_id>.db + 默认账本              │
│             从常量拷贝默认分类                         │
│                                                      │
│            ┌─────────┴──────────┐                    │
│            ▼                    ▼                    │
│      暂不配置同步          配置在线同步                │
│   进入主界面             输入 API 地址                  │
│            │                    │                    │
│            │              ┌─────┴─────┐              │
│            │              ▼           ▼              │
│            │          已有账号     没有账号            │
│            │          登录         注册               │
│            │        (拉取数据)   (创建账本)            │
│            │              └─────┬─────┘              │
│            │                    │                    │
│            └────────┬───────────┘                    │
│                     ▼                                │
│              进入主界面 (记账)                        │
│                                                      │
│   ─────────── 后续操作 ───────────                    │
│                                                      │
│   纯本地用户 → "我的"页面 → "配置在线同步"              │
│       │                                              │
│       ├─ 已有账号 → 登录                              │
│       │     └─ 本地数据上传到服务端账本                 │
│       │                                              │
│       └─ 没有账号 → 注册                              │
│             └─ 服务端创建账本 → 本地数据上传           │
│                                                      │
│   在线用户 → "我的"页面 → "退出登录"                   │
│       └─ 回到登录页（不删 db）                         │
│                                                      │
│   登录页 → 输入用户名+密码 → 切换到对应 db              │
│   登录页 → "创建新用户" → 回到 WelcomePage             │
└─────────────────────────────────────────────────────┘
```

## 7. 页面与路由设计

| 页面 | 路由 | 说明 |
|------|------|------|
| WelcomePage | `/welcome` | 首次启动，创建本地账户 |
| LoginPage | `/login` | 手动输入用户名+密码（不显示用户列表） |
| RegisterPage | `/register` | 在线注册（嵌入绑定流程） |
| BindSyncPage | `/bind-sync` | 纯本地用户后期绑定在线同步 |
| MePage | `/me` | 改：显示绑定状态、"配置在线同步"入口 |

### 路由守卫

```
启动:
  _meta.db 无用户 → /welcome
  _meta.db 有用户 → /login

登录后:
  → 主界面 (正常使用)

登出后:
  → /login
```

## 8. 本地转在线：数据迁移

纯本地用户绑定服务端时：

### 8.1 迁移步骤

```
1. 用户输入 API 地址 + 登录/注册
2. 服务端：
   a. 登录：返回 user_id + 已有账本列表
   b. 注册：创建 user → 创建 ledger（从常量拷贝默认分类）→ 返回 user_id + ledger_id
3. 更新 _meta.db 中该用户的记录：
   api_url = <服务端地址>
   server_user_id = <服务端 user_id>
4. 更新本地 db 中 ledger.id = server_ledger_id
5. 更新所有业务数据的 ledger_id（accounts, categories, tags, transactions）
6. 触发首次全量同步：
   a. 上传：本地所有数据 → POST /sync
   b. 下拉：服务端该账本数据 → 合并到本地
7. 记录 last_synced_at
```

### 8.2 冲突处理

本地转在线时，以本地数据为准（首次上传）。后续同步沿用现有 LWW 策略。

## 9. 登出与切换用户

### 9.1 登出

```
关闭当前用户 db 连接
清除内存中的 token + localStorage 中 refresh_token
路由跳转到 /login
```

不删除 db 文件。

### 9.2 切换用户

```
登录页输入用户名+密码
_meta.db 验证密码哈希
打开对应的 <user_id>.db
```

## 10. 后端变更

### 10.1 数据库迁移

新建迁移 `002_categories_not_null.up.sql`：

```sql
-- 如有 NULL 数据先清理（历史遗留的重复默认分类）
DELETE FROM categories WHERE ledger_id IS NULL;

-- 改为 NOT NULL
ALTER TABLE categories ALTER COLUMN ledger_id SET NOT NULL;
```

### 10.2 注册流程

`backend/internal/service/auth.go`：

- 删除 `defaultCategories` 及其 INSERT 逻辑
- 注册事务只创建 user + ledger

### 10.3 创建账本

新增 `CreateLedger` 逻辑（注册时、创建团队账本时共用）：

- 创建 ledger 记录
- 从 `DefaultCategories` 常量拷贝 14 条分类（`ledger_id = 新账本 ID`）
- 创建 3 个默认账户（现金、银行卡、电子钱包）

### 10.4 同步

`backend/internal/service/sync.go`：

- 删除 categories 的 NULL-ledger 特殊处理
- 所有实体统一按 `ledgerSet` 过滤

## 11. 前端变更清单

| 层面 | 变更 |
|------|------|
| 全局 db 管理 | 新增 `_meta.db` 管理本地用户；删除硬编码 ID |
| 用户 store | `auth.ts` 改：区分本地用户和在线用户，增加绑定状态 |
| 数据库初始化 | `db/index.ts` 改：按用户创建独立 db，从常量拷贝默认分类 |
| 分类 store | `category.ts` 改：查询删掉 `OR ledger_id IS NULL` |
| 标签 store | 无需改动（已按 ledger_id 隔离） |
| Sync 服务 | `sync.ts` 改：支持首次全量上传；删除分类 NULL 特殊逻辑 |
| 创建账本 | 新增/改：创建 ledger 时从常量拷贝默认分类 |
| WelcomePage | 新增：首次使用引导（昵称+密码 → 创建本地账户） |
| LoginPage | 改：手动输入用户名密码，不显示用户列表 |
| RegisterPage | 改：嵌入绑定流程 |
| MePage | 改：显示绑定状态 + "配置在线同步"入口 |
| 路由守卫 | 新增：根据 _meta.db 是否有用户决定跳转 |

## 12. 实施分期

| 期 | 范围 | 优先级 |
|----|------|--------|
| 4-A | 后端：迁移改为 NOT NULL + 默认分类常量 + 注册删重 + 同步删 NULL 逻辑 | 🔴 修 bug ① |
| 4-B | 前端：`_meta.db` + 独立用户 db + 创建/登录本地账户 + 登出 | 🔴 修 bug ③ |
| 4-C | Welcome 引导页 + 路由守卫 | 🟡 |
| 4-D | 本地转在线：绑定 API + 数据迁移 + 首次全量同步 | 🔴 修 bug ② |
| 4-E | 登录页改造（手动输入 + 切换用户） | 🟡 |
| 4-F | Me 页面绑定状态 + "配置在线同步"入口 | 🟡 |

## 13. 风险与注意事项

- **分类修改权限**：团队账本中按 `team_members.role` 控制，当前不强制校验删除操作，后续通过中间件统一拦截
- **向后兼容**：现有 `wee-count.db` 和 Postgres 中的 NULL 分类数据需要迁移清理
- **_meta.db 密码存储**：bcrypt 哈希
- **数据库文件清理**：暂不主动删除用户 db，未来可加"注销账户"功能
- **标签**：已按 `ledger_id` 隔离，本次设计不改动标签逻辑
