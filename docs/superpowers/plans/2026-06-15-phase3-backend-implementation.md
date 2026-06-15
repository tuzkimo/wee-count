# Phase 3 后端与同步 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从零搭建 Go 后端（认证/同步/团队），并接入前端实现多端数据同步和家庭团队协同。

**Architecture:** Go + chi + pgx + Redis 后端，通过 REST API 与 Vue 3 前端通信。前端新增 auth store + sync service，MePage 从占位页改造为功能页。未登录模式下行为与当前完全一致。

**Tech Stack:** Go 1.22+, chi v5, pgx v5, go-redis v9, golang-jwt v5, bcrypt, Docker Compose (postgres:16-alpine + redis:7-alpine)

---

## 文件结构

### 后端（全部新建）

```
backend/
├── cmd/server/main.go              # 入口，路由注册，启动服务器
├── internal/
│   ├── config/config.go            # 环境变量配置加载
│   ├── database/
│   │   ├── postgres.go             # pgxpool 连接池 + RunMigrations
│   │   └── redis.go                # Redis 客户端初始化
│   ├── handler/
│   │   ├── auth.go                 # POST /auth/register, /auth/login, /auth/refresh
│   │   ├── auth_test.go
│   │   ├── sync.go                 # POST /sync
│   │   ├── sync_test.go
│   │   ├── team.go                 # POST /teams, /teams/:id/invite, /teams/join
│   │   └── team_test.go
│   ├── middleware/
│   │   ├── auth.go                 # JWT 校验中间件
│   │   └── auth_test.go
│   ├── model/                      # 共享 DTO（无测试，纯数据结构）
│   │   ├── user.go
│   │   ├── ledger.go
│   │   ├── account.go
│   │   ├── transaction.go
│   │   ├── category.go
│   │   ├── tag.go
│   │   └── sync.go
│   └── service/
│       ├── auth.go                 # 注册/登录/刷新令牌业务逻辑
│       ├── auth_test.go
│       ├── sync.go                 # LWW 同步 + 远程变更拉取
│       ├── sync_test.go
│       ├── team.go                 # 团队创建/邀请/加入
│       └── team_test.go
├── migrations/
│   ├── 001_init.up.sql
│   └── 001_init.down.sql
├── Dockerfile
├── docker-compose.yml
└── go.mod
```

### 前端

```
src/
├── stores/
│   └── auth.ts                     # 新建：登录状态、token 管理
├── services/
│   └── sync.ts                     # 新建：同步队列、冲突合并
├── views/
│   ├── LoginPage.vue               # 新建
│   ├── RegisterPage.vue            # 新建
│   └── MePage.vue                  # 改造：从占位页变为功能页
├── router/index.ts                 # 修改：添加 /login, /register 路由
├── types/index.ts                  # 修改：添加同步相关类型
└── stores/transaction.ts           # 修改：记账后触发同步
```

---

## Step 1: 后端骨架

### Task 1.1: 初始化 Go 模块与目录结构

**Files:**
- Create: `backend/go.mod`
- Create: `backend/cmd/server/main.go`（占位）
- Create: `backend/internal/config/config.go`
- Create: `backend/internal/database/postgres.go`
- Create: `backend/internal/database/redis.go`

- [ ] **Step 1: 创建 go.mod**

```bash
mkdir -p backend/cmd/server backend/internal/config backend/internal/database backend/internal/handler backend/internal/middleware backend/internal/model backend/internal/service backend/migrations
cd backend && go mod init wee-count/backend
```

- [ ] **Step 2: 编写 config.go**

```go
// backend/internal/config/config.go
package config

import "os"

type Config struct {
	DatabaseURL string
	RedisURL    string
	JWTSecret   string
	Port        string
}

func Load() *Config {
	return &Config{
		DatabaseURL: getEnv("DATABASE_URL", "postgres://wee:wee@localhost:5432/wee-count?sslmode=disable"),
		RedisURL:    getEnv("REDIS_URL", "localhost:6379"),
		JWTSecret:   getEnv("JWT_SECRET", "dev-secret-change-me"),
		Port:        getEnv("PORT", "8080"),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
```

- [ ] **Step 3: 编写 config_test.go**

```go
// backend/internal/config/config_test.go
package config

import (
	"os"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	os.Unsetenv("DATABASE_URL")
	os.Unsetenv("REDIS_URL")
	os.Unsetenv("JWT_SECRET")
	os.Unsetenv("PORT")

	cfg := Load()

	if cfg.DatabaseURL != "postgres://wee:wee@localhost:5432/wee-count?sslmode=disable" {
		t.Errorf("unexpected DATABASE_URL: %s", cfg.DatabaseURL)
	}
	if cfg.Port != "8080" {
		t.Errorf("unexpected Port: %s", cfg.Port)
	}
}

func TestLoadFromEnv(t *testing.T) {
	os.Setenv("DATABASE_URL", "postgres://test:test@localhost/test")
	os.Setenv("PORT", "9090")
	defer os.Unsetenv("DATABASE_URL")
	defer os.Unsetenv("PORT")

	cfg := Load()

	if cfg.DatabaseURL != "postgres://test:test@localhost/test" {
		t.Errorf("unexpected DATABASE_URL: %s", cfg.DatabaseURL)
	}
	if cfg.Port != "9090" {
		t.Errorf("unexpected Port: %s", cfg.Port)
	}
}
```

- [ ] **Step 4: 运行 config 测试**

```bash
cd backend && go test ./internal/config/ -v
```

Expected: PASS

- [ ] **Step 5: 编写 postgres.go**

```go
// backend/internal/database/postgres.go
package database

import (
	"context"
	"embed"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	_ "github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed ../../migrations/*.sql
var migrationsFS embed.FS

func NewPool(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, fmt.Errorf("pgxpool.New: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("pool.Ping: %w", err)
	}
	return pool, nil
}

func RunMigrations(databaseURL string) error {
	d, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("iofs.New: %w", err)
	}
	m, err := migrate.NewWithSourceInstance("iofs", d, databaseURL)
	if err != nil {
		return fmt.Errorf("migrate.New: %w", err)
	}
	defer m.Close()
	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("migrate.Up: %w", err)
	}
	return nil
}
```

- [ ] **Step 6: 编写 redis.go**

```go
// backend/internal/database/redis.go
package database

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

func NewRedisClient(redisURL string) (*redis.Client, error) {
	opts, err := redis.ParseURL(fmt.Sprintf("redis://%s", redisURL))
	if err != nil {
		return nil, fmt.Errorf("redis.ParseURL: %w", err)
	}
	client := redis.NewClient(opts)
	if err := client.Ping(context.Background()).Err(); err != nil {
		return nil, fmt.Errorf("redis.Ping: %w", err)
	}
	return client, nil
}
```

- [ ] **Step 7: 编写占位 main.go**

```go
// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/database"
)

func main() {
	cfg := config.Load()

	ctx := context.Background()
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database.NewPool: %v", err)
	}
	defer pool.Close()

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatalf("database.RunMigrations: %v", err)
	}

	redisClient, err := database.NewRedisClient(cfg.RedisURL)
	if err != nil {
		log.Fatalf("database.NewRedisClient: %v", err)
	}
	defer redisClient.Close()

	log.Printf("server starting on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, nil); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
```

- [ ] **Step 8: 安装依赖**

```bash
cd backend && go get github.com/go-chi/chi/v5 github.com/jackc/pgx/v5 github.com/golang-migrate/migrate/v4 github.com/redis/go-redis/v9 github.com/golang-jwt/jwt/v5 golang.org/x/crypto github.com/google/uuid
```

- [ ] **Step 9: 验证编译**

```bash
cd backend && go build ./...
```

Expected: 编译成功，无错误

- [ ] **Step 10: Commit**

```bash
git add backend/
git commit -m "feat(backend): initialize Go module, config, database connections"
```

### Task 1.2: 数据库迁移脚本 + Docker Compose

**Files:**
- Create: `backend/migrations/001_init.up.sql`
- Create: `backend/migrations/001_init.down.sql`
- Create: `backend/Dockerfile`
- Create: `backend/docker-compose.yml`

- [ ] **Step 1: 编写 up 迁移**

```sql
-- backend/migrations/001_init.up.sql
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
    role VARCHAR(20) DEFAULT 'member',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (team_id, user_id)
);

CREATE TABLE ledgers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'personal',
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
    ledger_id UUID REFERENCES ledgers(id),
    name VARCHAR(50) NOT NULL,
    type VARCHAR(20) NOT NULL,
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
    type VARCHAR(20) NOT NULL,
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

CREATE INDEX idx_transactions_ledger_updated ON transactions(ledger_id, updated_at);
CREATE INDEX idx_accounts_ledger_updated ON accounts(ledger_id, updated_at);
CREATE INDEX idx_tags_ledger_updated ON tags(ledger_id, updated_at);
CREATE INDEX idx_categories_updated ON categories(updated_at);
CREATE INDEX idx_ledgers_owner ON ledgers(owner_id);
```

- [ ] **Step 2: 编写 down 迁移**

```sql
-- backend/migrations/001_init.down.sql
DROP TABLE IF EXISTS transaction_tags CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
DROP TABLE IF EXISTS categories CASCADE;
DROP TABLE IF EXISTS accounts CASCADE;
DROP TABLE IF EXISTS ledgers CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS users CASCADE;
```

- [ ] **Step 3: 编写 Dockerfile**

```dockerfile
# backend/Dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/server .
COPY --from=builder /app/migrations ./migrations
EXPOSE 8080
CMD ["./server"]
```

- [ ] **Step 4: 编写 docker-compose.yml**

```yaml
# backend/docker-compose.yml
version: "3.8"
services:
  api:
    build: .
    ports: ["8080:8080"]
    environment:
      DATABASE_URL: postgres://wee:wee@postgres:5432/wee-count?sslmode=disable
      REDIS_URL: redis:6379
      JWT_SECRET: change-me-in-production
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: wee
      POSTGRES_PASSWORD: wee
      POSTGRES_DB: wee-count
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U wee -d wee-count"]
      interval: 3s
      timeout: 3s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 5

volumes:
  pgdata:
```

- [ ] **Step 5: 验证 Docker Compose 能启动**

```bash
cd backend && docker compose up -d postgres redis
# 等待 healthy
docker compose ps
```

Expected: postgres 和 redis 服务状态为 healthy

- [ ] **Step 6: 验证迁移能执行**

```bash
cd backend && go run ./cmd/server &
# 等待启动后
docker compose exec postgres psql -U wee -d wee-count -c "\dt"
# 停止服务
kill %1
```

Expected: 列出所有表（users, teams, team_members, ledgers, accounts, categories, tags, transactions, transaction_tags）

- [ ] **Step 7: Commit**

```bash
git add backend/migrations/ backend/Dockerfile backend/docker-compose.yml
git commit -m "feat(backend): add migrations, Dockerfile, docker-compose"
```

---

## Step 2: 认证模块

### Task 2.1: 定义 model 层

**Files:**
- Create: `backend/internal/model/user.go`
- Create: `backend/internal/model/ledger.go`
- Create: `backend/internal/model/account.go`
- Create: `backend/internal/model/transaction.go`
- Create: `backend/internal/model/category.go`
- Create: `backend/internal/model/tag.go`

- [ ] **Step 1: 编写 user.go**

```go
// backend/internal/model/user.go
package model

import "time"

type User struct {
	ID           string    `json:"id"`
	Nickname     string    `json:"nickname"`
	Email        string    `json:"email"`
	PasswordHash string    `json:"-"`
	AvatarURL    *string   `json:"avatar_url"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type RegisterRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Nickname string `json:"nickname"`
}

type LoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	User         User   `json:"user"`
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
}

type RefreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}
```

- [ ] **Step 2: 编写 ledger.go**

```go
// backend/internal/model/ledger.go
package model

import "time"

type Ledger struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	TeamID    *string   `json:"team_id"`
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	IsDeleted bool      `json:"is_deleted"`
}
```

- [ ] **Step 3: 编写 account.go**

```go
// backend/internal/model/account.go
package model

import "time"

type Account struct {
	ID             string    `json:"id"`
	LedgerID       string    `json:"ledger_id"`
	OwnerID        string    `json:"owner_id"`
	Name           string    `json:"name"`
	Type           string    `json:"type"`
	Category       string    `json:"category"`
	InitialBalance float64   `json:"initial_balance"`
	CreditLimit    *float64  `json:"credit_limit"`
	RepaymentDay   *int      `json:"repayment_day"`
	Color          string    `json:"color"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	IsDeleted      bool      `json:"is_deleted"`
}
```

- [ ] **Step 4: 编写 transaction.go**

```go
// backend/internal/model/transaction.go
package model

import "time"

type Transaction struct {
	ID            string    `json:"id"`
	LedgerID      string    `json:"ledger_id"`
	UserID        string    `json:"user_id"`
	Amount        float64   `json:"amount"`
	Type          string    `json:"type"`
	FromAccountID *string   `json:"from_account_id"`
	ToAccountID   *string   `json:"to_account_id"`
	CategoryID    *string   `json:"category_id"`
	OccurredAt    time.Time `json:"occurred_at"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	IsDeleted     bool      `json:"is_deleted"`
	TagIDs        []string  `json:"tag_ids,omitempty"`
}
```

- [ ] **Step 5: 编写 category.go**

```go
// backend/internal/model/category.go
package model

import "time"

type Category struct {
	ID        string    `json:"id"`
	LedgerID  *string   `json:"ledger_id"`
	Name      string    `json:"name"`
	Type      string    `json:"type"`
	Icon      *string   `json:"icon"`
	SortOrder int       `json:"sort_order"`
	UpdatedAt time.Time `json:"updated_at"`
	IsDeleted bool      `json:"is_deleted"`
}
```

- [ ] **Step 6: 编写 tag.go**

```go
// backend/internal/model/tag.go
package model

import "time"

type Tag struct {
	ID        string    `json:"id"`
	LedgerID  string    `json:"ledger_id"`
	Name      string    `json:"name"`
	UpdatedAt time.Time `json:"updated_at"`
	IsDeleted bool      `json:"is_deleted"`
}
```

- [ ] **Step 7: 验证编译**

```bash
cd backend && go build ./...
```

- [ ] **Step 8: Commit**

```bash
git add backend/internal/model/
git commit -m "feat(backend): add model DTOs"
```

### Task 2.2: 实现 auth service

**Files:**
- Create: `backend/internal/service/auth.go`
- Create: `backend/internal/service/auth_test.go`

- [ ] **Step 1: 编写 auth service 测试**

```go
// backend/internal/service/auth_test.go
package service

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestHashAndCheckPassword(t *testing.T) {
	password := "test-password-123"
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("GenerateFromPassword: %v", err)
	}

	if err := bcrypt.CompareHashAndPassword(hash, []byte(password)); err != nil {
		t.Errorf("password should match: %v", err)
	}
	if err := bcrypt.CompareHashAndPassword(hash, []byte("wrong-password")); err == nil {
		t.Error("wrong password should not match")
	}
}
```

- [ ] **Step 2: 运行测试确认失败（service 包还不存在依赖接口）**

先只跑 bcrypt 行为测试，不涉及数据库：

```bash
cd backend && go test ./internal/service/ -v -run TestHashAndCheckPassword
```

Expected: PASS（纯 bcrypt 测试不依赖外部服务）

- [ ] **Step 3: 编写 auth.go**

```go
// backend/internal/service/auth.go
package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"wee-count/backend/internal/model"
)

var (
	ErrEmailTaken     = errors.New("email already registered")
	ErrInvalidLogin   = errors.New("invalid email or password")
	ErrInvalidToken   = errors.New("invalid or expired refresh token")
	ErrUserNotFound   = errors.New("user not found")
)

type AuthService struct {
	pool      *pgxpool.Pool
	jwtSecret []byte
}

func NewAuthService(pool *pgxpool.Pool, jwtSecret string) *AuthService {
	return &AuthService{pool: pool, jwtSecret: []byte(jwtSecret)}
}

func (s *AuthService) Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error) {
	// check duplicate email
	var exists bool
	err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1)", req.Email).Scan(&exists)
	if err != nil {
		return nil, fmt.Errorf("check email: %w", err)
	}
	if exists {
		return nil, ErrEmailTaken
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	userID := uuid.New().String()
	now := time.Now().UTC()

	_, err = tx.Exec(ctx,
		`INSERT INTO users (id, nickname, email, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, req.Nickname, req.Email, string(hash), now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert user: %w", err)
	}

	// create personal ledger
	ledgerID := uuid.New().String()
	_, err = tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
		 VALUES ($1, $2, 'personal', $3, $4, $5)`,
		ledgerID, req.Nickname+"的账本", userID, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert ledger: %w", err)
	}

	// create default accounts
	defaultAccounts := []struct {
		id, name, atype string
	}{
		{uuid.New().String(), "现金", "cash"},
		{uuid.New().String(), "银行卡", "bank"},
		{uuid.New().String(), "电子钱包", "digital"},
	}
	for _, a := range defaultAccounts {
		_, err = tx.Exec(ctx,
			`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'asset', 0, $6, $7)`,
			a.id, ledgerID, userID, a.name, a.atype, now, now,
		)
		if err != nil {
			return nil, fmt.Errorf("insert default account: %w", err)
		}
	}

	// create default categories (same as frontend ensureDefaultData)
	defaultCategories := []struct {
		name, ctype, icon string
		sortOrder         int
	}{
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
	for _, c := range defaultCategories {
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
			 VALUES ($1, NULL, $2, $3, $4, $5, $6)`,
			uuid.New().String(), c.name, c.ctype, c.icon, c.sortOrder, now,
		)
		if err != nil {
			return nil, fmt.Errorf("insert default category: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	accessToken, refreshToken, err := s.generateTokens(userID)
	if err != nil {
		return nil, err
	}

	return &model.AuthResponse{
		User: model.User{
			ID:        userID,
			Nickname:  req.Nickname,
			Email:     req.Email,
			CreatedAt: now,
			UpdatedAt: now,
		},
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

type MeResponse struct {
	User    model.User    `json:"user"`
	Ledgers []model.Ledger `json:"ledgers"`
	Teams   []model.Ledger `json:"teams"`
}

func (s *AuthService) GetMe(ctx context.Context, userID string) (*MeResponse, error) {
	var user model.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, nickname, email, avatar_url, created_at, updated_at FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Nickname, &user.Email, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}

	rows, err := s.pool.Query(ctx,
		`SELECT id, name, type, team_id, owner_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE owner_id = $1 AND is_deleted = FALSE`, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query ledgers: %w", err)
	}
	defer rows.Close()

	var ledgers []model.Ledger
	for rows.Next() {
		var l model.Ledger
		if err := rows.Scan(&l.ID, &l.Name, &l.Type, &l.TeamID, &l.OwnerID, &l.CreatedAt, &l.UpdatedAt, &l.IsDeleted); err != nil {
			return nil, err
		}
		ledgers = append(ledgers, l)
	}

	// teams are ledgers with type='team'
	var teams []model.Ledger
	for _, l := range ledgers {
		if l.Type == "team" {
			teams = append(teams, l)
		}
	}

	return &MeResponse{User: user, Ledgers: ledgers, Teams: teams}, nil
}

func (s *AuthService) Login(ctx context.Context, req model.LoginRequest) (*model.AuthResponse, error) {
	var user model.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, nickname, email, password_hash, avatar_url, created_at, updated_at
		 FROM users WHERE email = $1`, req.Email,
	).Scan(&user.ID, &user.Nickname, &user.Email, &user.PasswordHash, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrInvalidLogin
	}
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(req.Password)); err != nil {
		return nil, ErrInvalidLogin
	}

	accessToken, refreshToken, err := s.generateTokens(user.ID)
	if err != nil {
		return nil, err
	}

	return &model.AuthResponse{
		User:         user,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (s *AuthService) Refresh(ctx context.Context, req model.RefreshRequest) (*model.AuthResponse, error) {
	token, err := jwt.Parse(req.RefreshToken, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return s.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return nil, ErrInvalidToken
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, ErrInvalidToken
	}

	userID, ok := claims["sub"].(string)
	if !ok {
		return nil, ErrInvalidToken
	}

	var user model.User
	err = s.pool.QueryRow(ctx,
		`SELECT id, nickname, email, avatar_url, created_at, updated_at
		 FROM users WHERE id = $1`, userID,
	).Scan(&user.ID, &user.Nickname, &user.Email, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}

	accessToken, refreshToken, err := s.generateTokens(userID)
	if err != nil {
		return nil, err
	}

	return &model.AuthResponse{
		User:         user,
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
	}, nil
}

func (s *AuthService) generateTokens(userID string) (string, string, error) {
	now := time.Now().UTC()

	accessClaims := jwt.MapClaims{
		"sub": userID,
		"iat": now.Unix(),
		"exp": now.Add(15 * time.Minute).Unix(),
	}
	accessToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, accessClaims).SignedString(s.jwtSecret)
	if err != nil {
		return "", "", fmt.Errorf("sign access token: %w", err)
	}

	refreshClaims := jwt.MapClaims{
		"sub": userID,
		"iat": now.Unix(),
		"exp": now.Add(30 * 24 * time.Hour).Unix(),
	}
	refreshToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, refreshClaims).SignedString(s.jwtSecret)
	if err != nil {
		return "", "", fmt.Errorf("sign refresh token: %w", err)
	}

	return accessToken, refreshToken, nil
}
```

- [ ] **Step 4: 验证编译**

```bash
cd backend && go build ./...
```

Expected: 编译成功

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go
git commit -m "feat(backend): implement auth service (register/login/refresh)"
```

### Task 2.3: 实现 JWT 中间件

**Files:**
- Create: `backend/internal/middleware/auth.go`
- Create: `backend/internal/middleware/auth_test.go`

- [ ] **Step 1: 编写中间件测试**

```go
// backend/internal/middleware/auth_test.go
package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestAuthMiddleware_NoToken(t *testing.T) {
	handler := AuthMiddleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_ValidToken(t *testing.T) {
	handler := AuthMiddleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userID := r.Context().Value(UserIDKey)
		if userID == nil {
			t.Error("expected userID in context")
		}
		w.WriteHeader(http.StatusOK)
	}))

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "test-user-id",
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(15 * time.Minute).Unix(),
	})
	tokenStr, err := token.SignedString([]byte("secret"))
	if err != nil {
		t.Fatalf("SignedString: %v", err)
	}

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestAuthMiddleware_ExpiredToken(t *testing.T) {
	handler := AuthMiddleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "test-user-id",
		"iat": time.Now().Add(-1 * time.Hour).Unix(),
		"exp": time.Now().Add(-30 * time.Minute).Unix(),
	})
	tokenStr, _ := token.SignedString([]byte("secret"))

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for expired token, got %d", rec.Code)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && go test ./internal/middleware/ -v
```

Expected: FAIL (AuthMiddleware not defined)

- [ ] **Step 3: 编写中间件实现**

```go
// backend/internal/middleware/auth.go
package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

type contextKey string

const UserIDKey contextKey = "userID"

func AuthMiddleware(jwtSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			header := r.Header.Get("Authorization")
			if header == "" || !strings.HasPrefix(header, "Bearer ") {
				http.Error(w, `{"error":"missing or invalid Authorization header"}`, http.StatusUnauthorized)
				return
			}
			tokenStr := strings.TrimPrefix(header, "Bearer ")

			token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
				if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, jwt.ErrSignatureInvalid
				}
				return []byte(jwtSecret), nil
			})
			if err != nil || !token.Valid {
				http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
				return
			}

			claims, ok := token.Claims.(jwt.MapClaims)
			if !ok {
				http.Error(w, `{"error":"invalid token claims"}`, http.StatusUnauthorized)
				return
			}

			userID, ok := claims["sub"].(string)
			if !ok {
				http.Error(w, `{"error":"invalid user id in token"}`, http.StatusUnauthorized)
				return
			}

			ctx := context.WithValue(r.Context(), UserIDKey, userID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func GetUserID(ctx context.Context) string {
	id, _ := ctx.Value(UserIDKey).(string)
	return id
}
```

- [ ] **Step 4: 运行中间件测试**

```bash
cd backend && go test ./internal/middleware/ -v
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/middleware/
git commit -m "feat(backend): implement JWT auth middleware"
```

### Task 2.4: 实现 auth handler

**Files:**
- Create: `backend/internal/handler/auth.go`
- Create: `backend/internal/handler/auth_test.go`

- [ ] **Step 1: 编写 handler 测试**

```go
// backend/internal/handler/auth_test.go
package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterHandler_InvalidBody(t *testing.T) {
	h := &AuthHandler{} // 不注入 service，测试参数校验
	router := http.NewServeMux()
	router.HandleFunc("POST /auth/register", h.Register)

	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBufferString("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestLoginHandler_InvalidBody(t *testing.T) {
	h := &AuthHandler{}
	router := http.NewServeMux()
	router.HandleFunc("POST /auth/login", h.Login)

	req := httptest.NewRequest("POST", "/auth/login", bytes.NewBufferString("bad"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_ValidBody(t *testing.T) {
	// 用 mock service 测试
	svc := &mockAuthService{}
	h := &AuthHandler{svc: svc}
	router := http.NewServeMux()
	router.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"email": "test@test.com", "password": "pass123", "nickname": "Test",
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd backend && go test ./internal/handler/ -v -run "TestRegisterHandler|TestLoginHandler"
```

Expected: FAIL (AuthHandler not defined)

- [ ] **Step 3: 编写 auth handler**

```go
// backend/internal/handler/auth.go
package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/model"
	"wee-count/backend/internal/service"
)

type AuthHandler struct {
	svc *service.AuthService
}

func NewAuthHandler(svc *service.AuthService) *AuthHandler {
	return &AuthHandler{svc: svc}
}

func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req model.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Email == "" || req.Password == "" || req.Nickname == "" {
		writeError(w, http.StatusBadRequest, "email, password, and nickname are required")
		return
	}

	resp, err := h.svc.Register(r.Context(), req)
	if errors.Is(err, service.ErrEmailTaken) {
		writeError(w, http.StatusConflict, "email already registered")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req model.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Email == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "email and password are required")
		return
	}

	resp, err := h.svc.Login(r.Context(), req)
	if errors.Is(err, service.ErrInvalidLogin) {
		writeError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

func (h *AuthHandler) Refresh(w http.ResponseWriter, r *http.Request) {
	var req model.RefreshRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.RefreshToken == "" {
		writeError(w, http.StatusBadRequest, "refresh_token is required")
		return
	}

	resp, err := h.svc.Refresh(r.Context(), req)
	if errors.Is(err, service.ErrInvalidToken) || errors.Is(err, service.ErrUserNotFound) {
		writeError(w, http.StatusUnauthorized, "invalid or expired refresh token")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// MeResponse 返回当前用户信息及其账本/团队列表（spec 5.8）
type MeResponse struct {
	User    model.User    `json:"user"`
	Ledgers []model.Ledger `json:"ledgers"`
	Teams   []model.Ledger `json:"teams"`
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	resp, err := h.svc.GetMe(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}

// 测试用 mock
type mockAuthService struct{}

func (m *mockAuthService) Register(ctx context.Context, req model.RegisterRequest) (*model.AuthResponse, error) {
	return &model.AuthResponse{
		User: model.User{ID: "mock-id", Nickname: req.Nickname, Email: req.Email},
		AccessToken: "mock-access", RefreshToken: "mock-refresh",
	}, nil
}
func (m *mockAuthService) Login(ctx context.Context, req model.LoginRequest) (*model.AuthResponse, error) {
	return &model.AuthResponse{
		User: model.User{ID: "mock-id", Email: req.Email},
		AccessToken: "mock-access", RefreshToken: "mock-refresh",
	}, nil
}
func (m *mockAuthService) Refresh(ctx context.Context, req model.RefreshRequest) (*model.AuthResponse, error) {
	return &model.AuthResponse{
		User: model.User{ID: "mock-id"},
		AccessToken: "mock-access", RefreshToken: "mock-refresh",
	}, nil
}
func (m *mockAuthService) GetMe(ctx context.Context, userID string) (*service.MeResponse, error) {
	return &service.MeResponse{
		User:    model.User{ID: userID, Nickname: "Mock", Email: "mock@test.com"},
		Ledgers: []model.Ledger{},
		Teams:   []model.Ledger{},
	}, nil
}

// setUserID 往 context 注入 userID，绕过 auth 中间件用于测试
func setUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, middleware.UserIDKey, userID)
}
```

- [ ] **Step 4: 更新测试文件适配 mock**

由于 handler 引用了 mock，上面的测试需要更新。重新编写测试文件：

```go
// backend/internal/handler/auth_test.go
package handler

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRegisterHandler_InvalidJSON(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBufferString("not json"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_MissingFields(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{"email": "test@test.com"})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRegisterHandler_Success(t *testing.T) {
	svc := &mockAuthService{}
	h := &AuthHandler{svc: svc}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/register", h.Register)

	body, _ := json.Marshal(map[string]string{
		"email": "test@test.com", "password": "pass123", "nickname": "Test",
	})
	req := httptest.NewRequest("POST", "/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestLoginHandler_MissingFields(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/login", h.Login)

	body, _ := json.Marshal(map[string]string{"email": "test@test.com"})
	req := httptest.NewRequest("POST", "/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestRefreshHandler_MissingToken(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/refresh", h.Refresh)

	body, _ := json.Marshal(map[string]string{})
	req := httptest.NewRequest("POST", "/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}
```

- [ ] **Step 5: 添加公共 helper（writeJSON / writeError）**

在 `backend/internal/handler/` 下新建 `helpers.go`：

```go
// backend/internal/handler/helpers.go
package handler

import (
	"encoding/json"
	"net/http"
)

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
```

- [ ] **Step 6: 运行 handler 测试**

```bash
cd backend && go test ./internal/handler/ -v
```

Expected: PASS

- [ ] **Step 7: 更新 main.go 注册路由**

```go
// backend/cmd/server/main.go
package main

import (
	"context"
	"log"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"wee-count/backend/internal/config"
	"wee-count/backend/internal/database"
	"wee-count/backend/internal/handler"
	mw "wee-count/backend/internal/middleware"
	"wee-count/backend/internal/service"
)

func main() {
	cfg := config.Load()

	ctx := context.Background()
	pool, err := database.NewPool(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("database.NewPool: %v", err)
	}
	defer pool.Close()

	if err := database.RunMigrations(cfg.DatabaseURL); err != nil {
		log.Fatalf("database.RunMigrations: %v", err)
	}

	redisClient, err := database.NewRedisClient(cfg.RedisURL)
	if err != nil {
		log.Fatalf("database.NewRedisClient: %v", err)
	}
	defer redisClient.Close()

	// services
	authSvc := service.NewAuthService(pool, cfg.JWTSecret)

	// handlers
	authH := handler.NewAuthHandler(authSvc)

	// router
	r := chi.NewRouter()
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Route("/api/v1", func(r chi.Router) {
		// public
		r.Post("/auth/register", authH.Register)
		r.Post("/auth/login", authH.Login)
		r.Post("/auth/refresh", authH.Refresh)

		// protected
		r.Group(func(r chi.Router) {
			r.Use(mw.AuthMiddleware(cfg.JWTSecret))
			r.Get("/me", authH.Me)
		})
	})

	log.Printf("server starting on :%s", cfg.Port)
	if err := http.ListenAndServe(":"+cfg.Port, r); err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
```

- [ ] **Step 8: 验证编译**

```bash
cd backend && go build ./...
```

Expected: 编译成功

- [ ] **Step 9: 启动服务并手动验证**

```bash
cd backend && docker compose up -d
go run ./cmd/server &
# 测试注册
curl -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"pass123","nickname":"测试用户"}'
# 预期返回 201 + user + tokens
```

- [ ] **Step 10: Commit**

```bash
git add backend/internal/handler/ backend/cmd/server/main.go
git commit -m "feat(backend): implement auth handlers and wire up chi router"
```

---

## Step 3: 同步模块

### Task 3.1: 定义 sync model

**Files:**
- Create: `backend/internal/model/sync.go`

- [ ] **Step 1: 编写 sync.go**

```go
// backend/internal/model/sync.go
package model

import "time"

type SyncRequest struct {
	LastSyncedAt time.Time   `json:"last_synced_at"`
	LocalChanges SyncPayload `json:"local_changes"`
}

type SyncResponse struct {
	ServerTime    time.Time  `json:"server_time"`
	RemoteChanges SyncPayload `json:"remote_changes"`
}

type SyncPayload struct {
	Accounts     []Account     `json:"accounts"`
	Tags         []Tag         `json:"tags"`
	Categories   []Category    `json:"categories"`
	Transactions []Transaction `json:"transactions"`
}
```

- [ ] **Step 2: 验证编译**

```bash
cd backend && go build ./...
```

- [ ] **Step 3: Commit**

```bash
git add backend/internal/model/sync.go
git commit -m "feat(backend): add sync model types"
```

### Task 3.2: 实现 sync service

**Files:**
- Create: `backend/internal/service/sync.go`
- Create: `backend/internal/service/sync_test.go`

- [ ] **Step 1: 编写 sync service（含账本权限校验 + LWW 逻辑）**

```go
// backend/internal/service/sync.go
package service

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"wee-count/backend/internal/model"
)

type SyncService struct {
	pool *pgxpool.Pool
}

func NewSyncService(pool *pgxpool.Pool) *SyncService {
	return &SyncService{pool: pool}
}

// Sync 执行双向增量同步
func (s *SyncService) Sync(ctx context.Context, userID string, req model.SyncRequest) (*model.SyncResponse, error) {
	// 1. 获取用户有权访问的所有账本 ID
	ledgerIDs, err := s.getUserLedgerIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getUserLedgerIDs: %w", err)
	}

	// 2. 处理本地变更（LWW 合并）
	if err := s.applyLocalChanges(ctx, ledgerIDs, req.LocalChanges); err != nil {
		return nil, fmt.Errorf("applyLocalChanges: %w", err)
	}

	// 3. 拉取远程变更
	remoteChanges, err := s.getRemoteChanges(ctx, ledgerIDs, req.LastSyncedAt)
	if err != nil {
		return nil, fmt.Errorf("getRemoteChanges: %w", err)
	}

	return &model.SyncResponse{
		ServerTime:    time.Now().UTC(),
		RemoteChanges: remoteChanges,
	}, nil
}

// getUserLedgerIDs 返回用户有权访问的所有账本 ID
func (s *SyncService) getUserLedgerIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id FROM ledgers WHERE owner_id = $1 AND is_deleted = FALSE
		 UNION
		 SELECT l.id FROM ledgers l
		 JOIN team_members tm ON l.team_id = tm.team_id
		 WHERE tm.user_id = $1 AND l.is_deleted = FALSE`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ledgerSet := make(map[string]bool)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ledgerSet[id] = true
	}

	ids := make([]string, 0, len(ledgerSet))
	for id := range ledgerSet {
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// applyLocalChanges 按 entity type 逐条 LWW 合并
func (s *SyncService) applyLocalChanges(ctx context.Context, ledgerIDs []string, changes model.SyncPayload) error {
	ledgerSet := make(map[string]bool, len(ledgerIDs))
	for _, id := range ledgerIDs {
		ledgerSet[id] = true
	}

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// accounts
	for _, a := range changes.Accounts {
		if !ledgerSet[a.LedgerID] {
			continue
		}
		if err := s.lwwMergeAccount(ctx, tx, a); err != nil {
			return err
		}
	}

	// tags
	for _, t := range changes.Tags {
		if !ledgerSet[t.LedgerID] {
			continue
		}
		if err := s.lwwMergeTag(ctx, tx, t); err != nil {
			return err
		}
	}

	// categories
	for _, c := range changes.Categories {
		if err := s.lwwMergeCategory(ctx, tx, c); err != nil {
			return err
		}
	}

	// transactions
	for _, t := range changes.Transactions {
		if !ledgerSet[t.LedgerID] {
			continue
		}
		if err := s.lwwMergeTransaction(ctx, tx, t); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (s *SyncService) lwwMergeAccount(ctx context.Context, tx pgx.Tx, a model.Account) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM accounts WHERE id = $1", a.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		// 不存在 → INSERT
		_, err = tx.Exec(ctx,
			`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			a.ID, a.LedgerID, a.OwnerID, a.Name, a.Type, a.Category, a.InitialBalance,
			a.CreditLimit, a.RepaymentDay, a.Color, a.CreatedAt, a.UpdatedAt, a.IsDeleted,
		)
		return err
	}
	// 存在 → LWW 比较
	if !a.UpdatedAt.After(remoteUpdatedAt) {
		return nil // 服务端版本更新或持平，跳过
	}
	_, err = tx.Exec(ctx,
		`UPDATE accounts SET name=$1, type=$2, category=$3, initial_balance=$4, credit_limit=$5, repayment_day=$6, color=$7, updated_at=$8, is_deleted=$9 WHERE id=$10`,
		a.Name, a.Type, a.Category, a.InitialBalance, a.CreditLimit, a.RepaymentDay, a.Color, a.UpdatedAt, a.IsDeleted, a.ID,
	)
	return err
}

func (s *SyncService) lwwMergeTag(ctx context.Context, tx pgx.Tx, t model.Tag) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM tags WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5)`,
			t.ID, t.LedgerID, t.Name, t.UpdatedAt, t.IsDeleted,
		)
		return err
	}
	if !t.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3 WHERE id=$4`,
		t.Name, t.UpdatedAt, t.IsDeleted, t.ID,
	)
	return err
}

func (s *SyncService) lwwMergeCategory(ctx context.Context, tx pgx.Tx, c model.Category) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM categories WHERE id = $1", c.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			c.ID, c.LedgerID, c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted,
		)
		return err
	}
	if !c.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE categories SET name=$1, type=$2, icon=$3, sort_order=$4, updated_at=$5, is_deleted=$6 WHERE id=$7`,
		c.Name, c.Type, c.Icon, c.SortOrder, c.UpdatedAt, c.IsDeleted, c.ID,
	)
	return err
}

func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx pgx.Tx, t model.Transaction) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM transactions WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, occurred_at, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			t.ID, t.LedgerID, t.UserID, t.Amount, t.Type, t.FromAccountID, t.ToAccountID,
			t.CategoryID, t.OccurredAt, t.CreatedAt, t.UpdatedAt, t.IsDeleted,
		)
		if err != nil {
			return err
		}
	} else {
		if !t.UpdatedAt.After(remoteUpdatedAt) {
			return nil
		}
		_, err = tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, occurred_at=$6, updated_at=$7, is_deleted=$8 WHERE id=$9`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
		if err != nil {
			return err
		}
	}

	// sync tags: delete old associations, insert new ones
	if len(t.TagIDs) > 0 {
		_, err = tx.Exec(ctx, "DELETE FROM transaction_tags WHERE transaction_id = $1", t.ID)
		if err != nil {
			return err
		}
		for _, tagID := range t.TagIDs {
			_, err = tx.Exec(ctx,
				"INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
				t.ID, tagID,
			)
			if err != nil {
				return err
			}
		}
	}
	return nil
}

// pgx.Tx 抽象接口，方便测试 mock
// getRemoteChanges 返回用户有权访问的所有账本中 updated_at > since 的变更
func (s *SyncService) getRemoteChanges(ctx context.Context, ledgerIDs []string, since time.Time) (model.SyncPayload, error) {
	if len(ledgerIDs) == 0 {
		return model.SyncPayload{}, nil
	}

	payload := model.SyncPayload{}

	// accounts
	accounts, err := s.queryAccounts(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Accounts = accounts

	// tags
	tags, err := s.queryTags(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Tags = tags

	// categories (system defaults ledger_id IS NULL, always include)
	categories, err := s.queryCategories(ctx, since)
	if err != nil {
		return payload, err
	}
	payload.Categories = categories

	// transactions
	transactions, err := s.queryTransactions(ctx, ledgerIDs, since)
	if err != nil {
		return payload, err
	}
	payload.Transactions = transactions

	return payload, nil
}

func (s *SyncService) queryAccounts(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Account, error) {
	query := `SELECT id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted
		FROM accounts WHERE ledger_id = ANY($1) AND updated_at > $2`
	rows, err := s.pool.Query(ctx, query, ledgerIDs, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var accounts []model.Account
	for rows.Next() {
		var a model.Account
		if err := rows.Scan(&a.ID, &a.LedgerID, &a.OwnerID, &a.Name, &a.Type, &a.Category, &a.InitialBalance, &a.CreditLimit, &a.RepaymentDay, &a.Color, &a.CreatedAt, &a.UpdatedAt, &a.IsDeleted); err != nil {
			return nil, err
		}
		accounts = append(accounts, a)
	}
	return accounts, rows.Err()
}

func (s *SyncService) queryTags(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Tag, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, name, updated_at, is_deleted FROM tags WHERE ledger_id = ANY($1) AND updated_at > $2`,
		ledgerIDs, since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tags []model.Tag
	for rows.Next() {
		var t model.Tag
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.Name, &t.UpdatedAt, &t.IsDeleted); err != nil {
			return nil, err
		}
		tags = append(tags, t)
	}
	return tags, rows.Err()
}

func (s *SyncService) queryCategories(ctx context.Context, since time.Time) ([]model.Category, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted FROM categories WHERE updated_at > $1`,
		since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []model.Category
	for rows.Next() {
		var c model.Category
		if err := rows.Scan(&c.ID, &c.LedgerID, &c.Name, &c.Type, &c.Icon, &c.SortOrder, &c.UpdatedAt, &c.IsDeleted); err != nil {
			return nil, err
		}
		categories = append(categories, c)
	}
	return categories, rows.Err()
}

func (s *SyncService) queryTransactions(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Transaction, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT t.id, t.ledger_id, t.user_id, t.amount, t.type, t.from_account_id, t.to_account_id, t.category_id, t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
		 COALESCE(array_agg(tg.tag_id) FILTER (WHERE tg.tag_id IS NOT NULL), '{}') AS tag_ids
		 FROM transactions t
		 LEFT JOIN transaction_tags tg ON t.id = tg.transaction_id
		 WHERE t.ledger_id = ANY($1) AND t.updated_at > $2
		 GROUP BY t.id`,
		ledgerIDs, since,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var transactions []model.Transaction
	for rows.Next() {
		var t model.Transaction
		var tagIDs []string
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.UserID, &t.Amount, &t.Type, &t.FromAccountID, &t.ToAccountID, &t.CategoryID, &t.OccurredAt, &t.CreatedAt, &t.UpdatedAt, &t.IsDeleted, &tagIDs); err != nil {
			return nil, err
		}
		t.TagIDs = tagIDs
		transactions = append(transactions, t)
	}
	return transactions, rows.Err()
}
```

- [ ] **Step 2: 验证编译**

```bash
cd backend && go build ./...
```

Expected: 编译成功（注意修复 `QueryRow` 接口兼容性问题——实际代码中 tx 直接用 `pgx.Tx` 类型即可）

- [ ] **Step 3: 修复 pgx.Tx 接口**

由于 `pgx.Tx` 的 `QueryRow` 和 `Exec` 方法签名与标准接口略有不同，改为直接使用 `pgx.Tx` 类型：

在 sync.go 中将 `pgx.Tx` 相关方法的参数类型改为 `pgx.Tx`，并添加 import `"github.com/jackc/pgx/v5"`。

- [ ] **Step 4: Commit**

```bash
git add backend/internal/service/sync.go
git commit -m "feat(backend): implement sync service with LWW merging"
```

### Task 3.3: 实现 sync handler

**Files:**
- Create: `backend/internal/handler/sync.go`
- Create: `backend/internal/handler/sync_test.go`

- [ ] **Step 1: 编写 sync handler**

```go
// backend/internal/handler/sync.go
package handler

import (
	"encoding/json"
	"net/http"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/model"
	"wee-count/backend/internal/service"
)

type SyncHandler struct {
	svc *service.SyncService
}

func NewSyncHandler(svc *service.SyncService) *SyncHandler {
	return &SyncHandler{svc: svc}
}

func (h *SyncHandler) Sync(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	var req model.SyncRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	resp, err := h.svc.Sync(r.Context(), userID, req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "sync failed")
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
```

- [ ] **Step 2: 编写 sync handler 测试**

```go
// backend/internal/handler/sync_test.go
package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSyncHandler_NoAuth(t *testing.T) {
	h := &SyncHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sync", h.Sync)

	req := httptest.NewRequest("POST", "/sync", bytes.NewBufferString("{}"))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestSyncHandler_InvalidBody(t *testing.T) {
	h := &SyncHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /sync", h.Sync)

	req := httptest.NewRequest("POST", "/sync", bytes.NewBufferString("bad json"))
	req.Header.Set("Content-Type", "application/json")
	// 注入 userID 到 context 绕过 auth 中间件
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}
```

- [ ] **Step 3: 运行测试**

```bash
cd backend && go test ./internal/handler/ -v -run TestSync
```

Expected: PASS

- [ ] **Step 4: 更新 main.go 注册 sync 路由**

在 `backend/cmd/server/main.go` 中，在 `main()` 函数内添加：

```go
// 在 services 部分添加
syncSvc := service.NewSyncService(pool)
syncH := handler.NewSyncHandler(syncSvc)

// 在 protected group 中添加
r.Post("/sync", syncH.Sync)
```

- [ ] **Step 5: 验证编译**

```bash
cd backend && go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/sync.go backend/internal/handler/sync_test.go backend/cmd/server/main.go
git commit -m "feat(backend): implement sync handler with auth guard"
```

---

## Step 4: 团队模块

### Task 4.1: 实现 team service

**Files:**
- Create: `backend/internal/service/team.go`
- Create: `backend/internal/service/team_test.go`

- [ ] **Step 1: 编写 team service**

```go
// backend/internal/service/team.go
package service

import (
	"context"
	"crypto/rand"
	"fmt"
	"math/big"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"wee-count/backend/internal/model"
)

type TeamService struct {
	pool  *pgxpool.Pool
	redis *redis.Client
}

func NewTeamService(pool *pgxpool.Pool, redis *redis.Client) *TeamService {
	return &TeamService{pool: pool, redis: redis}
}

type CreateTeamResponse struct {
	Team         model.Ledger `json:"team"`
	SharedLedger model.Ledger `json:"shared_ledger"`
}

func (s *TeamService) CreateTeam(ctx context.Context, userID string, name string) (*CreateTeamResponse, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	now := time.Now().UTC()
	teamID := uuid.New().String()
	ledgerID := uuid.New().String()

	// insert team
	_, err = tx.Exec(ctx,
		`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`,
		teamID, name, userID, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team: %w", err)
	}

	// add creator as owner
	_, err = tx.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`,
		teamID, userID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	// create shared ledger
	_, err = tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES ($1, $2, 'team', $3, $4, $5, $6)`,
		ledgerID, name, teamID, userID, now, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert ledger: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &CreateTeamResponse{
		Team: model.Ledger{
			ID: teamID, Name: name, Type: "team",
			TeamID: &teamID, OwnerID: userID, CreatedAt: now, UpdatedAt: now,
		},
		SharedLedger: model.Ledger{
			ID: ledgerID, Name: name, Type: "team",
			TeamID: &teamID, OwnerID: userID, CreatedAt: now, UpdatedAt: now,
		},
	}, nil
}

func (s *TeamService) CreateInvite(ctx context.Context, userID, teamID string) (string, error) {
	// 校验 team 存在且 user 是 owner
	var createdBy string
	err := s.pool.QueryRow(ctx, "SELECT created_by FROM teams WHERE id = $1", teamID).Scan(&createdBy)
	if err != nil {
		return "", fmt.Errorf("team not found: %w", err)
	}
	if createdBy != userID {
		return "", fmt.Errorf("only team owner can create invite")
	}

	code, err := generateInviteCode()
	if err != nil {
		return "", fmt.Errorf("generate code: %w", err)
	}

	key := fmt.Sprintf("invite:%s", code)
	err = s.redis.Set(ctx, key, fmt.Sprintf("%s:%s", teamID, userID), 24*time.Hour).Err()
	if err != nil {
		return "", fmt.Errorf("redis set: %w", err)
	}

	return code, nil
}

func (s *TeamService) JoinByInvite(ctx context.Context, userID, code string) (*CreateTeamResponse, error) {
	key := fmt.Sprintf("invite:%s", code)
	val, err := s.redis.Get(ctx, key).Result()
	if err == redis.Nil {
		return nil, fmt.Errorf("invalid or expired invite code")
	}
	if err != nil {
		return nil, fmt.Errorf("redis get: %w", err)
	}

	var teamID, createdBy string
	_, err = fmt.Sscanf(val, "%s:%s", &teamID, &createdBy)
	if err != nil {
		return nil, fmt.Errorf("invalid invite data")
	}

	// delete invite code (one-time use)
	s.redis.Del(ctx, key)

	// check if already a member
	var exists bool
	err = s.pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)", teamID, userID,
	).Scan(&exists)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("already a member of this team")
	}

	now := time.Now().UTC()
	_, err = s.pool.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`,
		teamID, userID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	// get team info
	var teamName string
	err = s.pool.QueryRow(ctx, "SELECT name FROM teams WHERE id = $1", teamID).Scan(&teamName)
	if err != nil {
		return nil, err
	}

	// get shared ledger
	var ledger model.Ledger
	err = s.pool.QueryRow(ctx,
		`SELECT id, name, type, team_id, owner_id, created_at, updated_at FROM ledgers WHERE team_id = $1 AND type = 'team'`,
		teamID,
	).Scan(&ledger.ID, &ledger.Name, &ledger.Type, &ledger.TeamID, &ledger.OwnerID, &ledger.CreatedAt, &ledger.UpdatedAt)
	if err != nil {
		return nil, err
	}

	return &CreateTeamResponse{
		Team:         model.Ledger{ID: teamID, Name: teamName, Type: "team"},
		SharedLedger: ledger,
	}, nil
}

func generateInviteCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}
```

- [ ] **Step 2: 编写 team service 单元测试（只测 generateInviteCode）**

```go
// backend/internal/service/team_test.go
package service

import (
	"testing"
)

func TestGenerateInviteCode(t *testing.T) {
	code, err := generateInviteCode()
	if err != nil {
		t.Fatalf("generateInviteCode: %v", err)
	}
	if len(code) != 6 {
		t.Errorf("expected 6-digit code, got %s", code)
	}
	for _, c := range code {
		if c < '0' || c > '9' {
			t.Errorf("expected all digits, got %s", code)
		}
	}
}

func TestGenerateInviteCode_Uniqueness(t *testing.T) {
	codes := make(map[string]bool)
	for i := 0; i < 100; i++ {
		code, err := generateInviteCode()
		if err != nil {
			t.Fatalf("generateInviteCode: %v", err)
		}
		if codes[code] {
			t.Logf("collision on code %s (statistically rare, not a bug)", code)
		}
		codes[code] = true
	}
}
```

- [ ] **Step 3: 运行测试**

```bash
cd backend && go test ./internal/service/ -v -run TestGenerateInviteCode
```

Expected: PASS

- [ ] **Step 4: 验证编译**

```bash
cd backend && go build ./...
```

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/team.go backend/internal/service/team_test.go
git commit -m "feat(backend): implement team service (create/invite/join)"
```

### Task 4.2: 实现 team handler

**Files:**
- Create: `backend/internal/handler/team.go`
- Create: `backend/internal/handler/team_test.go`

- [ ] **Step 1: 编写 team handler**

```go
// backend/internal/handler/team.go
package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"wee-count/backend/internal/middleware"
	"wee-count/backend/internal/service"
)

type TeamHandler struct {
	svc *service.TeamService
}

func NewTeamHandler(svc *service.TeamService) *TeamHandler {
	return &TeamHandler{svc: svc}
}

type createTeamRequest struct {
	Name string `json:"name"`
}

func (h *TeamHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req createTeamRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "team name is required")
		return
	}

	resp, err := h.svc.CreateTeam(r.Context(), userID, req.Name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create team")
		return
	}

	writeJSON(w, http.StatusCreated, resp)
}

type inviteResponse struct {
	InviteCode string `json:"invite_code"`
	ExpiresIn  int    `json:"expires_in"`
}

func (h *TeamHandler) Invite(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	teamID := chi.URLParam(r, "id")

	code, err := h.svc.CreateInvite(r.Context(), userID, teamID)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, inviteResponse{
		InviteCode: code,
		ExpiresIn:  86400,
	})
}

type joinRequest struct {
	InviteCode string `json:"invite_code"`
}

func (h *TeamHandler) Join(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())

	var req joinRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.InviteCode == "" {
		writeError(w, http.StatusBadRequest, "invite_code is required")
		return
	}

	resp, err := h.svc.JoinByInvite(r.Context(), userID, req.InviteCode)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeJSON(w, http.StatusOK, resp)
}
```

- [ ] **Step 2: 编写 team handler 测试**

```go
// backend/internal/handler/team_test.go
package handler

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCreateTeamHandler_MissingName(t *testing.T) {
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams", h.Create)

	req := httptest.NewRequest("POST", "/teams", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}

func TestJoinHandler_MissingCode(t *testing.T) {
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /teams/join", h.Join)

	req := httptest.NewRequest("POST", "/teams/join", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", rec.Code)
	}
}
```

- [ ] **Step 3: 运行测试**

```bash
cd backend && go test ./internal/handler/ -v -run "TestCreateTeam|TestJoin"
```

Expected: PASS

- [ ] **Step 4: 更新 main.go 注册 team 路由**

```go
// 在 services 部分添加
teamSvc := service.NewTeamService(pool, redisClient)
teamH := handler.NewTeamHandler(teamSvc)

// 在 protected group 中添加
r.Post("/teams", teamH.Create)
r.Post("/teams/{id}/invite", teamH.Invite)
r.Post("/teams/join", teamH.Join)
```

- [ ] **Step 5: 验证编译**

```bash
cd backend && go build ./...
```

- [ ] **Step 6: Commit**

```bash
git add backend/internal/handler/team.go backend/internal/handler/team_test.go backend/cmd/server/main.go
git commit -m "feat(backend): implement team handlers and routes"
```

---

## Step 5: 前端认证 + 同步接入

### Task 5.1: 添加 API 基础配置

**Files:**
- Create: `src/services/api.ts`

- [ ] **Step 1: 编写 API 基础模块**

```typescript
// src/services/api.ts
const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080/api/v1";

let accessToken: string | null = null;
let refreshToken: string | null = null;

export function setTokens(access: string, refresh: string): void {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem("refresh_token", refresh);
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem("refresh_token");
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem("refresh_token");
}

async function refreshAccessToken(): Promise<boolean> {
  const stored = getStoredRefreshToken();
  if (!stored) return false;

  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: stored }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    localStorage.setItem("refresh_token", data.refresh_token);
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  let res = await fetch(url, { ...options, headers });

  // 401 → try refresh
  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`;
      res = await fetch(url, { ...options, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body.error || res.statusText };
  }

  const data = await res.json().catch(() => undefined);
  return { ok: true, status: res.status, data };
}

export function isLoggedIn(): boolean {
  return accessToken !== null || getStoredRefreshToken() !== null;
}
```

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit --project tsconfig.json 2>&1 | head -20
```

Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add src/services/api.ts
git commit -m "feat: add API base module with JWT refresh logic"
```

### Task 5.2: 实现 auth store

**Files:**
- Create: `src/stores/auth.ts`
- Create: `src/stores/__tests__/auth.test.ts`

- [ ] **Step 1: 编写 auth store 测试**

```typescript
// src/stores/__tests__/auth.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "../auth";

// mock api module
vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getStoredRefreshToken: vi.fn(() => null),
  isLoggedIn: vi.fn(() => false),
}));

describe("useAuthStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("初始状态为未登录", () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
  });

  it("初始状态 isInitialized 为 false", () => {
    const store = useAuthStore();
    expect(store.isInitialized).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/stores/__tests__/auth.test.ts
```

Expected: FAIL (auth store 不存在)

- [ ] **Step 3: 编写 auth store**

```typescript
// src/stores/auth.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { apiFetch, setTokens, clearTokens, getStoredRefreshToken, isLoggedIn } from "@/services/api";
import type { User } from "@/types";

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | null>(null);
  const isInitialized = ref(false);
  const isSyncing = ref(false);
  const lastSyncedAt = ref<string | null>(null);

  const isAuthenticated = computed(() => user.value !== null);

  async function init(): Promise<void> {
    if (isInitialized.value) return;

    const storedRefresh = getStoredRefreshToken();
    if (storedRefresh) {
      // 尝试用 refresh_token 恢复登录
      const res = await apiFetch<{ user: User }>("/me");
      if (res.ok && res.data) {
        user.value = res.data.user;
      } else {
        clearTokens();
      }
    }

    isInitialized.value = true;
  }

  async function register(email: string, password: string, nickname: string): Promise<string | null> {
    const res = await apiFetch<{ user: User; access_token: string; refresh_token: string }>(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ email, password, nickname }),
      }
    );

    if (!res.ok) {
      return res.error || "注册失败";
    }

    setTokens(res.data!.access_token, res.data!.refresh_token);
    user.value = res.data!.user;
    return null;
  }

  async function login(email: string, password: string): Promise<string | null> {
    const res = await apiFetch<{ user: User; access_token: string; refresh_token: string }>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }
    );

    if (!res.ok) {
      return res.error || "登录失败";
    }

    setTokens(res.data!.access_token, res.data!.refresh_token);
    user.value = res.data!.user;
    return null;
  }

  function logout(): void {
    clearTokens();
    user.value = null;
    lastSyncedAt.value = null;
  }

  return {
    user,
    isInitialized,
    isSyncing,
    lastSyncedAt,
    isAuthenticated,
    init,
    register,
    login,
    logout,
  };
});
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/stores/__tests__/auth.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stores/auth.ts src/stores/__tests__/auth.test.ts
git commit -m "feat: add auth store with login/register/logout"
```

### Task 5.3: 实现 sync service

**Files:**
- Create: `src/services/sync.ts`

- [ ] **Step 1: 编写 sync service**

```typescript
// src/services/sync.ts
import { apiFetch } from "./api";
import { getDb } from "@/db";
import type { Account, Transaction, Category, Tag } from "@/types";

interface SyncPayload {
  accounts: Account[];
  tags: Tag[];
  categories: Category[];
  transactions: Transaction[];
}

interface SyncRequest {
  last_synced_at: string;
  local_changes: SyncPayload;
}

interface SyncResponse {
  server_time: string;
  remote_changes: SyncPayload;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingChanges: SyncPayload = {
  accounts: [],
  tags: [],
  categories: [],
  transactions: [],
};

export function getLastSyncedAt(): string | null {
  return localStorage.getItem("last_synced_at");
}

export function setLastSyncedAt(time: string): void {
  localStorage.setItem("last_synced_at", time);
}

/**
 * 将本地变更加入同步队列，3 秒防抖后触发同步
 */
export function enqueueSync(changes: SyncPayload): void {
  // 合并变更（同 ID 的实体以最新为准）
  mergeChanges(pendingChanges, changes);

  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    performSync();
  }, 3000);
}

function mergeChanges(target: SyncPayload, source: SyncPayload): void {
  for (const key of ["accounts", "tags", "categories", "transactions"] as const) {
    const targetArr = target[key] as Array<{ id: string; updated_at: string }>;
    const sourceArr = source[key] as Array<{ id: string; updated_at: string }>;
    for (const item of sourceArr) {
      const idx = targetArr.findIndex((t) => t.id === item.id);
      if (idx >= 0) {
        // 保留 updated_at 更新的版本
        if (item.updated_at > targetArr[idx].updated_at) {
          targetArr[idx] = item;
        }
      } else {
        targetArr.push(item);
      }
    }
  }
}

/**
 * 执行同步：
 * 1. 发送本地变更到服务端
 * 2. 接收远程变更并合并到本地 SQLite
 */
export async function performSync(): Promise<void> {
  const lastSyncedAt = getLastSyncedAt() || "1970-01-01T00:00:00Z";

  const changes = { ...pendingChanges };
  // 清空队列
  pendingChanges = { accounts: [], tags: [], categories: [], transactions: [] };

  const res = await apiFetch<SyncResponse>("/sync", {
    method: "POST",
    body: JSON.stringify({
      last_synced_at: lastSyncedAt,
      local_changes: changes,
    } as SyncRequest),
  });

  if (!res.ok || !res.data) {
    // 同步失败，把变更加回队列
    mergeChanges(pendingChanges, changes);
    return;
  }

  // 合并远程变更到本地
  await applyRemoteChanges(res.data.remote_changes);

  // 更新同步时间
  setLastSyncedAt(res.data.server_time);
}

/**
 * 将远程变更写入本地 SQLite（LWW 合并）
 */
async function applyRemoteChanges(remote: SyncPayload): Promise<void> {
  const db = await getDb();

  for (const account of remote.accounts) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM accounts WHERE id = ?",
      [account.id]
    );
    if (local.length === 0) {
      await db.execute(
        `INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [account.id, account.ledger_id, account.owner_id, account.name, account.type,
         account.category, account.initial_balance, account.credit_limit, account.repayment_day,
         account.color, account.created_at, account.updated_at, account.is_deleted ? 1 : 0]
      );
    } else if (account.updated_at > local[0].updated_at) {
      await db.execute(
        `UPDATE accounts SET name=?, type=?, category=?, initial_balance=?, credit_limit=?, repayment_day=?, color=?, updated_at=?, is_deleted=? WHERE id=?`,
        [account.name, account.type, account.category, account.initial_balance, account.credit_limit,
         account.repayment_day, account.color, account.updated_at, account.is_deleted ? 1 : 0, account.id]
      );
    }
  }

  for (const tag of remote.tags) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM tags WHERE id = ?", [tag.id]
    );
    if (local.length === 0) {
      await db.execute(
        "INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?)",
        [tag.id, tag.ledger_id, tag.name, tag.updated_at, tag.is_deleted ? 1 : 0]
      );
    } else if (tag.updated_at > local[0].updated_at) {
      await db.execute(
        "UPDATE tags SET name=?, updated_at=?, is_deleted=? WHERE id=?",
        [tag.name, tag.updated_at, tag.is_deleted ? 1 : 0, tag.id]
      );
    }
  }

  for (const cat of remote.categories) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM categories WHERE id = ?", [cat.id]
    );
    if (local.length === 0) {
      await db.execute(
        "INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [cat.id, cat.ledger_id, cat.name, cat.type, cat.icon, cat.sort_order, cat.updated_at, cat.is_deleted ? 1 : 0]
      );
    } else if (cat.updated_at > local[0].updated_at) {
      await db.execute(
        "UPDATE categories SET name=?, type=?, icon=?, sort_order=?, updated_at=?, is_deleted=? WHERE id=?",
        [cat.name, cat.type, cat.icon, cat.sort_order, cat.updated_at, cat.is_deleted ? 1 : 0, cat.id]
      );
    }
  }

  for (const tx of remote.transactions) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM transactions WHERE id = ?", [tx.id]
    );
    if (local.length === 0) {
      await db.execute(
        `INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, occurred_at, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tx.id, tx.ledger_id, tx.user_id, tx.amount, tx.type, tx.from_account_id, tx.to_account_id,
         tx.category_id, tx.occurred_at, tx.created_at, tx.updated_at, tx.is_deleted ? 1 : 0]
      );
    } else if (tx.updated_at > local[0].updated_at) {
      await db.execute(
        `UPDATE transactions SET amount=?, type=?, from_account_id=?, to_account_id=?, category_id=?, occurred_at=?, updated_at=?, is_deleted=? WHERE id=?`,
        [tx.amount, tx.type, tx.from_account_id, tx.to_account_id, tx.category_id, tx.occurred_at,
         tx.updated_at, tx.is_deleted ? 1 : 0, tx.id]
      );
    }

    // sync transaction tags
    if (tx.tag_ids) {
      await db.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [tx.id]);
      for (const tagID of tx.tag_ids) {
        await db.execute(
          "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [tx.id, tagID]
        );
      }
    }
  }
}
```

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: 无新增类型错误（注意 Transaction 类型中有 `tag_ids`，需要在 types 中添加可选字段）

- [ ] **Step 3: 更新 Transaction 类型**

在 `src/types/index.ts` 的 `Transaction` 接口中添加：

```typescript
tag_ids?: string[];
```

- [ ] **Step 4: Commit**

```bash
git add src/services/sync.ts src/types/index.ts
git commit -m "feat: add sync service with LWW merge and debounce queue"
```

### Task 5.4: 创建 LoginPage 和 RegisterPage

**Files:**
- Create: `src/views/LoginPage.vue`
- Create: `src/views/RegisterPage.vue`
- Modify: `src/router/index.ts`

- [ ] **Step 1: 添加路由**

在 `src/router/index.ts` 中添加：

```typescript
{
  path: "/login",
  name: "login",
  component: () => import("@/views/LoginPage.vue"),
  meta: { hideTab: true },
},
{
  path: "/register",
  name: "register",
  component: () => import("@/views/RegisterPage.vue"),
  meta: { hideTab: true },
},
```

- [ ] **Step 2: 编写 LoginPage.vue**

```vue
<!-- src/views/LoginPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const error = ref("");
const loading = ref(false);

async function handleLogin(): Promise<void> {
  error.value = "";
  if (!email.value || !password.value) {
    error.value = "请输入邮箱和密码";
    return;
  }
  loading.value = true;
  const err = await auth.login(email.value, password.value);
  loading.value = false;
  if (err) {
    error.value = err;
  } else {
    router.replace("/me");
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">登录</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleLogin">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">邮箱</label>
        <input
          v-model="email"
          type="email"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入邮箱"
          autocomplete="email"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-text-secondary">密码</label>
        <input
          v-model="password"
          type="password"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入密码"
          autocomplete="current-password"
        />
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "登录中..." : "登录" }}
      </button>

      <p class="text-center text-sm text-text-secondary">
        还没有账号？
        <router-link to="/register" class="text-primary">注册</router-link>
      </p>
    </form>
  </div>
</template>
```

- [ ] **Step 3: 编写 RegisterPage.vue**

```vue
<!-- src/views/RegisterPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const nickname = ref("");
const error = ref("");
const loading = ref(false);

async function handleRegister(): Promise<void> {
  error.value = "";
  if (!email.value || !password.value || !nickname.value) {
    error.value = "请填写所有字段";
    return;
  }
  if (password.value.length < 6) {
    error.value = "密码至少 6 位";
    return;
  }
  loading.value = true;
  const err = await auth.register(email.value, password.value, nickname.value);
  loading.value = false;
  if (err) {
    error.value = err;
  } else {
    router.replace("/me");
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">注册</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleRegister">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">昵称</label>
        <input
          v-model="nickname"
          type="text"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入昵称"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-text-secondary">邮箱</label>
        <input
          v-model="email"
          type="email"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入邮箱"
          autocomplete="email"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-text-secondary">密码</label>
        <input
          v-model="password"
          type="password"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入密码（至少 6 位）"
          autocomplete="new-password"
        />
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "注册中..." : "注册" }}
      </button>

      <p class="text-center text-sm text-text-secondary">
        已有账号？
        <router-link to="/login" class="text-primary">登录</router-link>
      </p>
    </form>
  </div>
</template>
```

- [ ] **Step 4: 验证编译**

```bash
npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add src/views/LoginPage.vue src/views/RegisterPage.vue src/router/index.ts
git commit -m "feat: add LoginPage and RegisterPage with routes"
```

### Task 5.5: 改造 MePage 为功能页

**Files:**
- Modify: `src/views/MePage.vue`

- [ ] **Step 1: 重写 MePage.vue**

```vue
<!-- src/views/MePage.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useLedgerStore } from "@/stores/ledger";
import { performSync, getLastSyncedAt } from "@/services/sync";
import { ChevronRight, LogOut, Users, Plus, UserPlus } from "lucide-vue-next";

const router = useRouter();
const auth = useAuthStore();
const ledger = useLedgerStore();

onMounted(async () => {
  await auth.init();
  await ledger.init();
});

async function handleSync(): Promise<void> {
  auth.isSyncing = true;
  await performSync();
  auth.isSyncing = false;
}

function handleLogout(): void {
  auth.logout();
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <h1 class="flex-1 text-lg font-semibold text-text">我的</h1>
    </div>

    <!-- 未登录 -->
    <div v-if="!auth.isAuthenticated" class="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <p class="text-5xl">👤</p>
      <p class="text-text-secondary">登录后可同步数据到云端</p>
      <div class="flex gap-3">
        <button
          class="rounded-lg bg-primary px-6 py-2.5 text-white font-medium"
          @click="router.push('/login')"
        >
          登录
        </button>
        <button
          class="rounded-lg border border-primary px-6 py-2.5 text-primary font-medium"
          @click="router.push('/register')"
        >
          注册
        </button>
      </div>
    </div>

    <!-- 已登录 -->
    <div v-else class="flex flex-1 flex-col">
      <!-- 用户信息 -->
      <div class="flex items-center gap-3 bg-surface px-4 py-4">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg text-white">
          {{ auth.user?.nickname?.charAt(0) || "?" }}
        </div>
        <div class="flex-1">
          <p class="font-medium text-text">{{ auth.user?.nickname }}</p>
          <p class="text-sm text-text-secondary">{{ auth.user?.email }}</p>
        </div>
      </div>

      <!-- 同步状态 -->
      <button
        class="flex items-center gap-2 bg-surface px-4 py-3 border-b border-gray-100"
        :disabled="auth.isSyncing"
        @click="handleSync"
      >
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="auth.isSyncing ? 'bg-yellow-400' : 'bg-green-400'"
        />
        <span class="text-sm text-text-secondary">
          {{ auth.isSyncing ? "同步中..." : `已同步 ${getLastSyncedAt() ? new Date(getLastSyncedAt()!).toLocaleString() : "从未同步"}` }}
        </span>
      </button>

      <!-- 我的账本 -->
      <div class="mt-3">
        <p class="px-4 py-2 text-xs font-medium text-text-secondary uppercase">我的账本</p>
        <div class="border-y border-gray-100 bg-surface">
          <div class="flex items-center px-4 py-3">
            <span class="flex-1 text-text">{{ ledger.currentLedger?.name || "个人账本" }}</span>
            <span class="text-xs text-text-secondary">个人</span>
          </div>
        </div>
      </div>

      <!-- 团队管理 -->
      <div class="mt-3">
        <p class="px-4 py-2 text-xs font-medium text-text-secondary uppercase">团队管理</p>
        <div class="border-y border-gray-100 bg-surface">
          <button class="flex w-full items-center gap-3 px-4 py-3" @click="router.push('/teams/create')">
            <Plus :size="18" class="text-primary" />
            <span class="flex-1 text-left text-text">创建团队</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
          <button class="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3" @click="router.push('/teams/join')">
            <UserPlus :size="18" class="text-primary" />
            <span class="flex-1 text-left text-text">加入团队</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
        </div>
      </div>

      <!-- 设置 -->
      <div class="mt-3">
        <div class="border-y border-gray-100 bg-surface">
          <button class="flex w-full items-center px-4 py-3" @click="router.push('/settings')">
            <span class="flex-1 text-left text-text">设置</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
        </div>
      </div>

      <!-- 退出登录 -->
      <div class="mt-6 px-4">
        <button
          class="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 py-3 text-red-500"
          @click="handleLogout"
        >
          <LogOut :size="16" />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add src/views/MePage.vue
git commit -m "feat: transform MePage from placeholder to functional auth/sync hub"
```

### Task 5.6: 记账操作触发同步

**Files:**
- Modify: `src/stores/transaction.ts`

- [ ] **Step 1: 在 transaction store 中添加同步触发**

在 `src/stores/transaction.ts` 的 `add`、`update`、`remove`、`batchRemove` 方法末尾（`fetchAll` 调用之后），添加同步触发逻辑：

```typescript
import { enqueueSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";

// 在每个写操作成功后触发同步
// 在 add() 方法中，return id 之前：
const authStore = useAuthStore();
if (authStore.isAuthenticated) {
  const tx = transactions.value.find(t => t.id === id);
  if (tx) {
    enqueueSync({ accounts: [], tags: [], categories: [], transactions: [tx] });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/transaction.ts
git commit -m "feat: trigger sync enqueue after transaction write operations"
```

---

## Step 6: 前端团队功能

### Task 6.1: 创建团队页面

**Files:**
- Create: `src/views/CreateTeamPage.vue`
- Create: `src/views/JoinTeamPage.vue`
- Modify: `src/router/index.ts`

- [ ] **Step 1: 添加路由**

在 `src/router/index.ts` 中添加：

```typescript
{
  path: "/teams/create",
  name: "create-team",
  component: () => import("@/views/CreateTeamPage.vue"),
  meta: { hideTab: true },
},
{
  path: "/teams/join",
  name: "join-team",
  component: () => import("@/views/JoinTeamPage.vue"),
  meta: { hideTab: true },
},
```

- [ ] **Step 2: 编写 CreateTeamPage.vue**

```vue
<!-- src/views/CreateTeamPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiFetch } from "@/services/api";
import { performSync } from "@/services/sync";

const router = useRouter();
const name = ref("");
const error = ref("");
const loading = ref(false);

async function handleCreate(): Promise<void> {
  error.value = "";
  if (!name.value.trim()) {
    error.value = "请输入团队名称";
    return;
  }
  loading.value = true;
  const res = await apiFetch("/teams", {
    method: "POST",
    body: JSON.stringify({ name: name.value.trim() }),
  });
  loading.value = false;

  if (!res.ok) {
    error.value = res.error || "创建失败";
    return;
  }

  // 创建成功后触发同步，拉取团队账本
  await performSync();
  router.replace("/me");
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">创建团队</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleCreate">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">团队名称</label>
        <input
          v-model="name"
          type="text"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="例如：史密斯家庭"
        />
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "创建中..." : "创建团队" }}
      </button>
    </form>
  </div>
</template>
```

- [ ] **Step 3: 编写 JoinTeamPage.vue**

```vue
<!-- src/views/JoinTeamPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiFetch } from "@/services/api";
import { performSync } from "@/services/sync";

const router = useRouter();
const inviteCode = ref("");
const error = ref("");
const loading = ref(false);

async function handleJoin(): Promise<void> {
  error.value = "";
  if (!inviteCode.value.trim()) {
    error.value = "请输入邀请码";
    return;
  }
  if (!/^\d{6}$/.test(inviteCode.value.trim())) {
    error.value = "邀请码为 6 位数字";
    return;
  }
  loading.value = true;
  const res = await apiFetch("/teams/join", {
    method: "POST",
    body: JSON.stringify({ invite_code: inviteCode.value.trim() }),
  });
  loading.value = false;

  if (!res.ok) {
    error.value = res.error || "加入失败";
    return;
  }

  await performSync();
  router.replace("/me");
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">加入团队</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleJoin">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">邀请码</label>
        <input
          v-model="inviteCode"
          type="text"
          inputmode="numeric"
          maxlength="6"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-center text-lg tracking-[0.5em] text-text"
          placeholder="000000"
        />
        <p class="mt-1 text-xs text-text-secondary">请输入团队管理员分享的 6 位邀请码</p>
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "加入中..." : "加入团队" }}
      </button>
    </form>
  </div>
</template>
```

- [ ] **Step 4: 验证编译**

```bash
npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add src/views/CreateTeamPage.vue src/views/JoinTeamPage.vue src/router/index.ts
git commit -m "feat: add CreateTeam and JoinTeam pages with routes"
```

---

## 验证计划

全部步骤完成后，逐项验证：

### 后端

```bash
cd backend
# 单元测试
go test ./... -v

# 集成测试（需要本地 postgres + redis）
docker compose up -d
go run ./cmd/server &
# 1. 注册
curl -s -X POST http://localhost:8080/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"a@test.com","password":"pass123","nickname":"Alice"}'
# 2. 登录
curl -s -X POST http://localhost:8080/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"a@test.com","password":"pass123"}'
# 3. 使用 access_token 调用 /sync
# 4. 创建团队、生成邀请码、另一个用户加入
```

### 前端

```bash
npm run test          # 前端单元测试
npm run dev           # 启动验证：
                      # - 未登录 MePage 显示登录/注册按钮
                      # - 点击登录 → LoginPage → 登录成功跳回 MePage
                      # - MePage 显示用户信息、同步状态、团队入口
                      # - 记账后自动触发 sync（检查 Network 面板）
```

---

## 依赖关系

```
Step 1 (后端骨架)
  └── Step 2 (认证模块)
        └── Step 3 (同步模块)
              └── Step 4 (团队模块)
                    └── Step 5 (前端认证+同步)
                          └── Step 6 (前端团队功能)
```

Steps 1-4 必须严格按顺序执行（后端）。Step 5 可在 Step 2 完成后开始前端 auth 部分，Step 3 完成后补充 sync 部分。Step 6 依赖 Step 4。

---

## 风险与备注

1. **SQLite 与 PostgreSQL 差异**：本地 SQLite 用 TEXT 存时间，PostgreSQL 用 TIMESTAMPTZ。同步时需要确保时间格式一致（统一 ISO 8601 UTC）。
2. **pgx.Tx 接口**：sync service 中的 `pgx.Tx` 接口方法签名可能与 `pgx.Tx` 不完全匹配。实施时若遇到编译问题，改为直接使用 `pgx.Tx` 类型，测试用 mock pool 替代。
3. **前端 `transaction_tags` 同步**：本地 SQLite 的 `transactions` 表没有 `occurred_at` 列（schema 中是 `transacted_at`），检查 `db/index.ts` 中的迁移是否已添加。spec 中提到 `user_id` 和 `occurred_at` 两列，需要在实施前确认本地 schema 是否对齐。
4. **`sessionStorage` vs `localStorage`**：按讨论结果，refresh_token 使用 localStorage，access_token 在内存中。
5. **Tauri 环境 API 地址**：正式 Android 构建时需要配置生产环境 API 地址。开发阶段默认 `localhost:8080`。
