# Phase 3 后端与同步 — 设计方案

日期：2026-06-15 | 状态：待评审

## 1. 目标

打通"多设备数据同步"和"家庭团队协同"，从单机记账升级为真正的多端协同记账。MVP 范围：

- 用户注册/登录（JWT）
- 双向增量同步（LWW 冲突解决）
- 团队邀请码（Redis 24h TTL）
- 保留未登录纯本地模式

## 2. 技术选型

| 层 | 技术 | 理由 |
|----|------|------|
| HTTP 框架 | `net/http` + `chi` router | 标准库基础，轻量路由 |
| 数据库驱动 | `pgx/v5` | PostgreSQL 高性能纯 Go 驱动 |
| 迁移 | `golang-migrate/migrate` | 嵌入式 SQL 迁移 |
| JWT | `golang-jwt/jwt/v5` | 最常用的 Go JWT 库 |
| Redis | `go-redis/v9` | Redis 客户端 |
| 密码 | `golang.org/x/crypto/bcrypt` | 标准方案 |
| 部署 | Docker Compose (3 服务) | 一键启动 |

## 3. 项目结构

```
backend/
├── cmd/server/main.go
├── internal/
│   ├── config/config.go           # 从环境变量加载配置
│   ├── database/
│   │   ├── postgres.go            # pgxpool 连接池 + RunMigrations
│   │   └── redis.go               # redis 客户端
│   ├── handler/
│   │   ├── auth.go                # POST /auth/register, /auth/login, /auth/refresh
│   │   ├── sync.go                # POST /sync
│   │   └── team.go                # POST /teams, /teams/:id/invite, /teams/join
│   ├── middleware/
│   │   └── auth.go                # JWT 校验 + 用户注入 context
│   ├── model/                     # 共享 DTO
│   │   ├── user.go
│   │   ├── ledger.go
│   │   ├── account.go
│   │   ├── transaction.go
│   │   ├── category.go
│   │   ├── tag.go
│   │   └── sync.go
│   └── service/
│       ├── auth.go
│       ├── sync.go
│       └── team.go
├── migrations/
│   ├── 001_init.up.sql
│   └── 001_init.down.sql
├── Dockerfile
├── docker-compose.yml
└── go.mod
```

## 4. 数据库 (PostgreSQL) — 与本地 SQLite 对齐

```sql
-- 迁移时使用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nickname VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE teams (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE team_members (
    team_id UUID REFERENCES teams(id),
    user_id UUID REFERENCES users(id),
    role VARCHAR(20) DEFAULT 'member', -- 'owner', 'member'
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE ledgers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'personal', -- 'personal', 'team'
    team_id UUID REFERENCES teams(id),
    owner_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE TABLE accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ledger_id UUID REFERENCES ledgers(id) NOT NULL,
    owner_id UUID REFERENCES users(id) NOT NULL,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    category VARCHAR(20) NOT NULL DEFAULT 'asset',
    initial_balance NUMERIC(12,2) NOT NULL DEFAULT 0.00,
    credit_limit NUMERIC(12,2),
    repayment_day INTEGER,
    color VARCHAR(20) DEFAULT '#3b82f6',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE TABLE categories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ledger_id UUID REFERENCES ledgers(id),  -- NULL = 系统默认
    name VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL, -- 'income', 'expense'
    icon VARCHAR(50),
    sort_order INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ledger_id UUID REFERENCES ledgers(id) NOT NULL,
    name VARCHAR(50) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE,
    UNIQUE(ledger_id, name)
);

CREATE TABLE transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ledger_id UUID REFERENCES ledgers(id) NOT NULL,
    user_id UUID REFERENCES users(id) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    type VARCHAR(20) NOT NULL, -- 'income', 'expense', 'transfer'
    from_account_id UUID REFERENCES accounts(id),
    to_account_id UUID REFERENCES accounts(id),
    category_id UUID REFERENCES categories(id),
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_deleted BOOLEAN DEFAULT FALSE
);

CREATE TABLE transaction_tags (
    transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (transaction_id, tag_id)
);

-- 索引
CREATE INDEX idx_transactions_ledger_updated ON transactions(ledger_id, updated_at);
CREATE INDEX idx_accounts_ledger_updated ON accounts(ledger_id, updated_at);
CREATE INDEX idx_tags_ledger_updated ON tags(ledger_id, updated_at);
CREATE INDEX idx_categories_updated ON categories(updated_at);
CREATE INDEX idx_ledgers_owner ON ledgers(owner_id);
```

## 5. API 规格

所有业务接口需 `Authorization: Bearer <access_token>`（auth 接口自身除外）。

### 5.1 POST /api/v1/auth/register

```
请求: { "email": "...", "password": "...", "nickname": "..." }
响应 201: { "user": {...}, "access_token": "...", "refresh_token": "..." }
```

注册成功后自动创建：
- 一个 `type='personal'` 的账本
- 三个默认 asset 账户（现金、银行卡、电子钱包）
- 一套系统默认分类（与前端 ensureDefaultData 一致）

### 5.2 POST /api/v1/auth/login

```
请求: { "email": "...", "password": "..." }
响应 200: { "user": {...}, "access_token": "...", "refresh_token": "..." }
```

- access_token: 15 分钟有效
- refresh_token: 30 天有效，存于 users 表（可选，也可 Redis）

### 5.3 POST /api/v1/auth/refresh

```
请求: { "refresh_token": "..." }
响应 200: { "access_token": "...", "refresh_token": "..." }
```

轮换刷新，旧 refresh_token 立即作废。

### 5.4 POST /api/v1/sync

核心同步接口。

```
请求:
{
  "last_synced_at": "2026-06-15T00:00:00Z",
  "local_changes": {
    "accounts":     [ { "id": "uuid", ...fields, "updated_at": "..." } ],
    "tags":         [ { "id": "uuid", ...fields, "updated_at": "..." } ],
    "categories":   [ { "id": "uuid", ...fields, "updated_at": "..." } ],
    "transactions": [
      {
        "id": "uuid", "amount": 100, "type": "expense",
        "from_account_id": "...", "category_id": "...",
        "tag_ids": ["tag-uuid-1", "tag-uuid-2"],
        "updated_at": "..."
      }
    ]
  }
}

响应 200:
{
  "server_time": "2026-06-15T12:00:00Z",
  "remote_changes": {
    "accounts":     [...],
    "tags":         [...],
    "categories":   [...],
    "transactions": [{ "id": "...", "tag_ids": [...], ... }]
  }
}
```

**同步逻辑（LWW）：**

对 `local_changes` 中的每条实体：
1. 校验该实体所属 ledger 是否属于当前用户
2. SELECT `updated_at` FROM 对应表 WHERE id = ?
3. 若服务端不存在 → INSERT
4. 若服务端 `updated_at` >= 本地 `updated_at` → 跳过（服务端更新或持平）
5. 若本地更新 → UPDATE + 更新 `updated_at`

对 `transactions` 的 tag_ids：
- DELETE FROM `transaction_tags` WHERE `transaction_id` = ?
- 批量 INSERT 新的关联

**拉取远程变更：**

```sql
-- 伪代码：查询用户有权访问的所有账本
WITH user_ledgers AS (
  SELECT id FROM ledgers WHERE owner_id = $1 AND is_deleted = FALSE
  UNION
  SELECT l.id FROM ledgers l
  JOIN team_members tm ON l.team_id = tm.team_id
  WHERE tm.user_id = $1 AND l.is_deleted = FALSE
)
SELECT * FROM transactions WHERE ledger_id IN (SELECT id FROM user_ledgers)
  AND updated_at > $2;
```

返回所有 entity type 中 `updated_at > last_synced_at` 的记录。

### 5.5 POST /api/v1/teams

```
请求: { "name": "史密斯家庭" }
响应 201: { "team": {...}, "shared_ledger": {...} }
```

创建 team 的同时创建对应的 `type='team'` 账本，并将创建者加入 `team_members` (role='owner')。

### 5.6 POST /api/v1/teams/:id/invite

```
响应 200: { "invite_code": "583920", "expires_in": 86400 }
```

- 生成 6 位随机数字码
- Redis: `SET invite:583920 {team_id: uuid, created_by: uuid} EX 86400`
- 重复生成会覆盖旧码

### 5.7 POST /api/v1/teams/join

```
请求: { "invite_code": "583920" }
响应 200: { "team": {...}, "ledger": {...} }
```

1. Redis GET `invite:583920` → 拿到 `team_id`
2. 写入 `team_members`
3. 删除 Redis key（一次性使用）
4. 前端接到返回后触发 `/sync`，拉取该团队账本历史数据

### 5.8 GET /api/v1/me

```
响应 200: { "user": {...}, "ledgers": [...], "teams": [...] }
```

返回当前用户信息、所有账本、所有团队，供客户端初始化。

## 6. 前端适配设计

### 6.1 运行模式

```
┌─────────────┐    点"登录"    ┌──────────────┐
│  未登录模式   │ ──────────►  │  已登录模式    │
│              │              │               │
│ 本地记账     │   ◄────────── │ 本地记账 + 同步 │
│ 无用户概念   │    退出登录   │ 有用户身份     │
└─────────────┘              └──────────────┘
```

- 默认进入未登录模式，行为与当前完全一致
- "我的"页提供登录入口
- 登录后自动触发首次全量同步（`last_synced_at = "1970-01-01T00:00:00Z"`）
- 后续每次记账操作后自动触发增量同步
- 同步失败不阻塞本地操作，静默重试

### 6.2 新增前端模块

```
src/
├── stores/
│   └── auth.ts              # 登录状态、token 管理、当前用户
├── services/
│   └── sync.ts              # 同步队列、冲突合并、重试逻辑
├── views/
│   ├── LoginPage.vue        # 登录
│   ├── RegisterPage.vue     # 注册
│   └── MePage.vue           # 改造：用户信息、同步状态、团队入口
```

### 6.3 MePage 改造

从占位页改造为功能页：

```
┌──────────────────────┐
│  [未登录]              │
│  ┌──────────────────┐ │
│  │   登录 / 注册      │ │
│  └──────────────────┘ │
│  设置  ⚙️              │
│  关于  ℹ️             │
└──────────────────────┘

┌──────────────────────┐
│  [已登录] 爸爸         │
│  同步状态 ● 已同步      │
│                       │
│  我的账本              │
│  ├ 个人账本            │
│  └ 史密斯家庭           │
│                       │
│  团队管理              │
│  ├ 创建团队            │
│  ├ 邀请成员            │
│  └ 加入团队            │
│                       │
│  设置  ⚙️              │
│  退出登录              │
└──────────────────────┘
```

### 6.4 同步流程

```
[本地记账操作完成]
       │
       ▼
[写入 SQLite (正常流程)]
       │
       ▼
[已登录?] ──No──► 结束
       │
      Yes
       │
       ▼
[加入同步队列]
       │
       ▼ (debounce 3s，合并连续快速记账)
[POST /api/v1/sync]
       │
       ▼
[本地 UPSERT remote_changes]
  - 按 entity type 逐表合并
  - 仅当 remote.updated_at > local.updated_at 时覆盖
  - 删除的实体设 is_deleted = true
       │
       ▼
[更新 last_synced_at]
       │
       ▼
[刷新 UI 数据]
```

## 7. 部署与开发环境

### docker-compose.yml

```yaml
version: "3.8"
services:
  api:
    build: .
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://wee:wee@postgres:5432/wee-count?sslmode=disable
      REDIS_URL: redis:6379
      JWT_SECRET: change-me-in-production
    depends_on: [postgres, redis]

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: wee
      POSTGRES_PASSWORD: wee
      POSTGRES_DB: wee-count
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

volumes:
  pgdata:
```

### 开发工作流

```bash
# 启动后端
cd backend && docker-compose up -d

# 启动前端 (端口 1420，连后端 localhost:8080)
npm run dev

# 运行后端测试
cd backend && go test ./...

# 运行前端测试
npm run test
```

## 8. 安全

- 密码：Bcrypt cost=12
- JWT：HS256，access_token 15min / refresh_token 30d
- 所有业务接口验证 ledger 归属权，禁止跨账本访问
- 邀请码：6 位数字，24h 过期，一次性使用
- 生产环境 JWT_SECRET 从环境变量注入，不进代码
- Token 本地存 `sessionStorage`（关闭 App 后需重新登录或用 refresh_token 恢复）

## 9. 开发顺序

```
Step 1: 后端骨架
  ├── go mod init, 目录结构
  ├── config + database 连接
  ├── 数据库迁移脚本
  └── Dockerfile + docker-compose.yml ✓ 可启动

Step 2: 认证模块
  ├── POST /auth/register
  ├── POST /auth/login
  ├── POST /auth/refresh
  ├── JWT 中间件
  └── 单元测试 ✓ curl 可验证

Step 3: 同步模块
  ├── POST /sync
  ├── LWW 冲突处理
  ├── 账本权限校验
  └── 单元测试 ✓ curl 可验证

Step 4: 团队模块
  ├── POST /teams
  ├── POST /teams/:id/invite
  ├── POST /teams/join
  └── 单元测试 ✓ curl 可验证

Step 5: 前端认证 + 同步接入
  ├── auth store
  ├── LoginPage / RegisterPage
  ├── 改造 MePage
  └── sync service + 自动同步

Step 6: 前端团队功能
  ├── 创建/加入团队 UI
  └── 多账本切换
```

## 10. 未纳入本次 MVP 的内容

以下留在 Phase 4 或之后：

- 报表统计（ReportsPage 功能实现）
- 数据导出/备份
- 指纹锁/生物识别
- 定时提醒通知
- 多账本间转账
- 自定义分类
- 密码找回/邮箱验证
- 头像上传
- Tauri 生产打包发布
