# 用户数据隔离与 Onboarding 流程 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户数据物理隔离（每用户独立 SQLite）、默认分类模板拷贝模式、纯本地→在线迁移、以及 Onboarding 引导流程。

**Architecture:** `_meta.db` 管理本地用户列表，每个用户的业务数据存储在独立的 `<user_id>.db`。默认分类从前端/后端各自的代码常量中拷贝到每个账本，不再使用 `ledger_id = NULL`。本地账户通过用户名+密码登录，绑定服务端后数据归属到线上账本。

**Tech Stack:** Go + chi + pgx (后端), Vue 3 + TypeScript + Pinia + Tauri SQL Plugin (前端)

---

### Task 4-A-1: 后端 — 创建默认分类常量和 CreateLedger 函数

**Files:**
- Create: `backend/internal/service/ledger.go`
- Read: `backend/internal/service/auth.go:51-132` (参考现有账本创建逻辑)

- [ ] **Step 1: 创建 ledger service 文件**

```go
// backend/internal/service/ledger.go
package service

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DefaultCategories 创建新账本时拷贝的默认分类模板
var DefaultCategories = []struct {
	Name, Type, Icon string
	SortOrder        int
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

// DefaultAccounts 创建新账本时拷贝的默认账户模板
var DefaultAccounts = []struct {
	Name, Atype string
}{
	{"现金", "cash"},
	{"银行卡", "bank"},
	{"电子钱包", "digital"},
}

// CreateLedger 在事务中创建账本并拷贝默认分类和账户
func CreateLedger(ctx context.Context, tx pgx.Tx, ledgerID, ownerID, name, ledgerType string) error {
	now, err := getNow(ctx, tx)
	if err != nil {
		return fmt.Errorf("get now: %w", err)
	}

	// 创建账本
	_, err = tx.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		ledgerID, name, ledgerType, ownerID, now, now,
	)
	if err != nil {
		return fmt.Errorf("insert ledger: %w", err)
	}

	// 拷贝默认分类
	for _, c := range DefaultCategories {
		_, err = tx.Exec(ctx,
			`INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			uuid.New().String(), ledgerID, c.Name, c.Type, c.Icon, c.SortOrder, now,
		)
		if err != nil {
			return fmt.Errorf("insert default category: %w", err)
		}
	}

	// 拷贝默认账户
	for _, a := range DefaultAccounts {
		_, err = tx.Exec(ctx,
			`INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'asset', 0, $6, $7)`,
			uuid.New().String(), ledgerID, ownerID, a.Name, a.Atype, now, now,
		)
		if err != nil {
			return fmt.Errorf("insert default account: %w", err)
		}
	}

	return nil
}
```

- [ ] **Step 2: 验证编译**

```bash
cd backend && go build ./...
```
Expected: 如果 `getNow` 未在 service 包中定义，检查 auth.go 中如何使用 `now()` 函数。若 auth.go 中直接用 `time.Now()`，则改为：

```go
import "time"

// 在 CreateLedger 内部:
now := time.Now()
```

修改后重新运行 `go build ./...`，期望编译通过。

---

### Task 4-A-2: 后端 — 修改 Register 使用 CreateLedger

**Files:**
- Modify: `backend/internal/service/auth.go:51-132`

- [ ] **Step 1: 替换 Register 中的事务逻辑**

修改 `auth.go` 的 `Register` 函数，将第 60-128 行（user + ledger + accounts + categories 的 INSERT）替换为：

```go
// 注册事务只创建 user 和 ledger
now := time.Now()
userID := uuid.New().String()
ledgerID := uuid.New().String()

// 创建用户
_, err = tx.Exec(ctx,
    `INSERT INTO users (id, nickname, email, password_hash, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    userID, req.Nickname, req.Email, string(hash), now, now,
)
if err != nil {
    return nil, fmt.Errorf("insert user: %w", err)
}

// 创建账本（含默认分类和账户）
ledgerName := req.Nickname + "的账本"
if err := CreateLedger(ctx, tx, ledgerID, userID, ledgerName, "personal"); err != nil {
    return nil, fmt.Errorf("create ledger: %w", err)
}
```

删除原有 `defaultAccounts` 和 `defaultCategories` 的定义及 INSERT 循环。

- [ ] **Step 2: 删除旧变量**

找到并删除 auth.go 中的：
- `defaultAccounts := []struct{...}` 定义（约第 81-87 行）
- `for _, a := range defaultAccounts { ... }` 循环（约第 89-97 行）
- `defaultCategories := []struct{...}` 定义（约第 100-118 行）
- `for _, c := range defaultCategories { ... }` 循环（约第 119-128 行）

- [ ] **Step 3: 验证编译和 lint**

```bash
cd backend && go build ./... && go vet ./...
```
Expected: PASS (无错误)

- [ ] **Step 4: 运行现有测试**

```bash
cd backend && go test ./...
```
Expected: PASS (如果存在测试)

---

### Task 4-A-3: 后端 — 数据库迁移

**Files:**
- Create: `backend/internal/database/migrations/002_categories_not_null.up.sql`
- Create: `backend/internal/database/migrations/002_categories_not_null.down.sql`

- [ ] **Step 1: 创建 up 迁移**

```sql
-- 002_categories_not_null.up.sql
-- 清理历史遗留的重复默认分类（如果有）
DELETE FROM categories WHERE ledger_id IS NULL;

-- 改为 NOT NULL
ALTER TABLE categories ALTER COLUMN ledger_id SET NOT NULL;
```

- [ ] **Step 2: 创建 down 迁移**

```sql
-- 002_categories_not_null.down.sql
ALTER TABLE categories ALTER COLUMN ledger_id DROP NOT NULL;
```

- [ ] **Step 3: 验证迁移可执行**

需要先确保数据库中 categories 表的 NULL 数据已清理。如果本地开发数据库有数据，先手动检查：

```bash
# 如果有 psql：
psql -h localhost -U weecount -d weecount -c "SELECT count(*) FROM categories WHERE ledger_id IS NULL"
```

---

### Task 4-A-4: 后端 — 同步中删除 NULL-ledger 特殊处理

**Files:**
- Modify: `backend/internal/service/sync.go:79-129` (applyLocalChanges)
- Modify: `backend/internal/service/sync.go:261-267` (getRemoteChanges 注释)
- Modify: `backend/internal/service/sync.go:320-339` (queryCategories)

- [ ] **Step 1: 删除 categories 的 ledgerSet 豁免**

在 `applyLocalChanges` 函数中找到 categories 处理逻辑（约第 111-116 行），删除对 categories 的特殊处理，使其与 accounts/tags/transactions 一样接受 `ledgerSet` 检查。

修改前（约第 109-116 行）：

```go
for _, c := range changes.Categories {
    // 注意：不检查 ledgerSet[c.LedgerID]，因为全局分类 ledger_id 为 NULL
    if _, exists := existingCategories[c.ID]; !exists || c.UpdatedAt.After(existingCategories[c.ID]) {
        categoriesToUpsert = append(categoriesToUpsert, c)
    }
}
```

修改后：

```go
for _, c := range changes.Categories {
    if !ledgerSet[c.LedgerID] {
        continue
    }
    if _, exists := existingCategories[c.ID]; !exists || c.UpdatedAt.After(existingCategories[c.ID]) {
        categoriesToUpsert = append(categoriesToUpsert, c)
    }
}
```

- [ ] **Step 2: 修改 queryCategories 加上 ledger_id 过滤**

`queryCategories` 函数改为接受 `ledgerIDs []string` 参数：

```go
func (s *SyncService) queryCategories(ctx context.Context, since time.Time, ledgerIDs []string) ([]model.Category, error) {
    rows, err := s.pool.Query(ctx,
        `SELECT id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted
         FROM categories WHERE updated_at > $1 AND ledger_id = ANY($2)`,
        since, ledgerIDs,
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
```

- [ ] **Step 3: 更新 getRemoteChanges 中的调用**

找到 `getRemoteChanges` 中调用 `queryCategories` 的地方，传入 `ledgerIDs`：

```go
remoteCategories, err := s.queryCategories(ctx, since, ledgerIDs)
```

删除原有注释 `// categories (system defaults ledger_id IS NULL, always include)`。

- [ ] **Step 4: 验证编译**

```bash
cd backend && go build ./...
```
Expected: PASS

---

### Task 4-A-5: 后端 — 更新 Category Model

**Files:**
- Modify: `backend/internal/model/category.go`

- [ ] **Step 1: LedgerID 改为非指针**

```go
// 修改前
type Category struct {
    LedgerID  *string   `json:"ledger_id"`
    // ...
}

// 修改后
type Category struct {
    LedgerID  string    `json:"ledger_id"`
    // ...
}
```

- [ ] **Step 2: 验证编译**

```bash
cd backend && go build ./...
```
Expected: PASS。如果有编译错误，检查所有引用 `c.LedgerID` 的地方是否做了 nil 检查——删除 nil 检查。

---

### Task 4-A-6: 提交 Phase 4-A

- [ ] **Step 1: 提交后端变更**

```bash
git add backend/internal/service/ledger.go \
        backend/internal/service/auth.go \
        backend/internal/service/sync.go \
        backend/internal/model/category.go \
        backend/internal/database/migrations/002_categories_not_null.up.sql \
        backend/internal/database/migrations/002_categories_not_null.down.sql
git commit -m "fix(backend): seed default categories on ledger create, remove NULL-ledger pattern"
```

---

### Task 4-B-1: 前端 — 创建默认分类常量

**Files:**
- Create: `src/db/defaults.ts`

- [ ] **Step 1: 创建默认数据常量文件**

```typescript
// src/db/defaults.ts

export interface DefaultCategory {
  name: string
  type: 'expense' | 'income'
  icon: string
  sortOrder: number
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: '餐饮', type: 'expense', icon: '🍜', sortOrder: 1 },
  { name: '交通', type: 'expense', icon: '🚌', sortOrder: 2 },
  { name: '购物', type: 'expense', icon: '🛒', sortOrder: 3 },
  { name: '娱乐', type: 'expense', icon: '🎮', sortOrder: 4 },
  { name: '居家', type: 'expense', icon: '🏠', sortOrder: 5 },
  { name: '通讯', type: 'expense', icon: '📱', sortOrder: 6 },
  { name: '医疗', type: 'expense', icon: '💊', sortOrder: 7 },
  { name: '其他支出', type: 'expense', icon: '💸', sortOrder: 99 },
  { name: '工资', type: 'income', icon: '💰', sortOrder: 1 },
  { name: '奖金', type: 'income', icon: '🎁', sortOrder: 2 },
  { name: '理财', type: 'income', icon: '📈', sortOrder: 3 },
  { name: '退款', type: 'income', icon: '↩️', sortOrder: 4 },
  { name: '报销', type: 'income', icon: '🧾', sortOrder: 5 },
  { name: '其他收入', type: 'income', icon: '📥', sortOrder: 99 },
]

export interface DefaultAccount {
  name: string
  type: string
}

export const DEFAULT_ACCOUNTS: DefaultAccount[] = [
  { name: '现金', type: 'cash' },
  { name: '银行卡', type: 'bank' },
  { name: '电子钱包', type: 'digital' },
]
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit src/db/defaults.ts
```
Expected: PASS (no type errors)

---

### Task 4-B-2: 前端 — 创建 _meta.db 管理模块

**Files:**
- Create: `src/db/meta.ts`
- Read: `src/db/index.ts` (参考现有数据库初始化模式)

- [ ] **Step 1: 创建元数据库管理模块**

```typescript
// src/db/meta.ts
import Database from '@tauri-apps/plugin-sql'

let metaDb: Database | null = null

export async function getMetaDb(): Promise<Database> {
  if (!metaDb) {
    metaDb = await Database.load('sqlite:_meta.db')
    await initMetaTables()
  }
  return metaDb
}

async function initMetaTables(): Promise<void> {
  const db = metaDb!
  await db.execute(`
    CREATE TABLE IF NOT EXISTS local_users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      api_url TEXT,
      server_user_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
}

export interface LocalUser {
  id: string
  nickname: string
  password_hash: string
  api_url: string | null
  server_user_id: string | null
  created_at: string
  updated_at: string
}

export async function getLocalUsers(): Promise<LocalUser[]> {
  const db = await getMetaDb()
  return db.select<LocalUser[]>(
    'SELECT id, nickname, password_hash, api_url, server_user_id, created_at, updated_at FROM local_users ORDER BY created_at ASC'
  )
}

export async function getLocalUser(id: string): Promise<LocalUser | null> {
  const db = await getMetaDb()
  const rows = await db.select<LocalUser[]>(
    'SELECT id, nickname, password_hash, api_url, server_user_id, created_at, updated_at FROM local_users WHERE id = $1',
    [id]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function getLocalUserByNickname(nickname: string): Promise<LocalUser | null> {
  const db = await getMetaDb()
  const rows = await db.select<LocalUser[]>(
    'SELECT id, nickname, password_hash, api_url, server_user_id, created_at, updated_at FROM local_users WHERE nickname = $1',
    [nickname]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function createLocalUser(
  id: string,
  nickname: string,
  passwordHash: string
): Promise<void> {
  const db = await getMetaDb()
  await db.execute(
    `INSERT INTO local_users (id, nickname, password_hash) VALUES ($1, $2, $3)`,
    [id, nickname, passwordHash]
  )
}

export async function updateLocalUserBinding(
  id: string,
  apiUrl: string,
  serverUserId: string
): Promise<void> {
  const db = await getMetaDb()
  await db.execute(
    `UPDATE local_users SET api_url = $1, server_user_id = $2, updated_at = datetime('now') WHERE id = $3`,
    [apiUrl, serverUserId, id]
  )
}

export async function closeMetaDb(): Promise<void> {
  if (metaDb) {
    // Tauri SQL plugin 没有显式 close，将引用置空让 GC 处理
    metaDb = null
  }
}
```

---

### Task 4-B-3: 前端 — 创建用户数据库初始化模块

**Files:**
- Create: `src/db/userDb.ts`

- [ ] **Step 1: 创建用户数据库管理模块**

```typescript
// src/db/userDb.ts
import Database from '@tauri-apps/plugin-sql'
import { v4 as uuidv4 } from 'uuid' // 或使用 crypto.randomUUID()
import { DEFAULT_CATEGORIES, DEFAULT_ACCOUNTS } from './defaults'

// 当前活跃用户的 db 连接
let userDb: Database | null = null
let currentUserId: string | null = null

export function getCurrentUserId(): string | null {
  return currentUserId
}

export function getUserDb(): Database | null {
  return userDb
}

export async function openUserDb(userId: string): Promise<Database> {
  if (userDb && currentUserId === userId) {
    return userDb
  }
  // 关闭旧连接
  userDb = null

  const db = await Database.load(`sqlite:${userId}.db`)
  await initUserTables(db)

  // 确保默认数据存在
  await ensureUserDefaults(db)

  userDb = db
  currentUserId = userId
  return db
}

async function initUserTables(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'personal',
      owner_id TEXT,
      team_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cash',
      category TEXT NOT NULL DEFAULT 'asset',
      initial_balance REAL NOT NULL DEFAULT 0,
      credit_limit REAL,
      repayment_day INTEGER,
      color TEXT DEFAULT '#3b82f6',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0,
      UNIQUE(ledger_id, name)
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      from_account_id TEXT REFERENCES accounts(id),
      to_account_id TEXT REFERENCES accounts(id),
      category_id TEXT REFERENCES categories(id),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (transaction_id, tag_id)
    )
  `)
}

async function ensureUserDefaults(db: Database): Promise<void> {
  // 检查是否已有账本
  const ledgers = await db.select<{ count: number }[]>(
    'SELECT COUNT(*) as count FROM ledgers'
  )
  const count = ledgers[0]?.count ?? 0
  if (count > 0) return

  const ledgerId = uuidv4()
  const userId = currentUserId!
  const now = new Date().toISOString()

  // 创建默认个人账本
  await db.execute(
    `INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
     VALUES ($1, $2, 'personal', $3, $4, $5)`,
    [ledgerId, '个人账本', userId, now, now]
  )

  // 拷贝默认分类
  for (const c of DEFAULT_CATEGORIES) {
    await db.execute(
      `INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), ledgerId, c.name, c.type, c.icon, c.sortOrder, now]
    )
  }

  // 拷贝默认账户
  for (const a of DEFAULT_ACCOUNTS) {
    await db.execute(
      `INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'asset', 0, $6, $7)`,
      [uuidv4(), ledgerId, userId, a.name, a.type, now, now]
    )
  }
}

export function closeUserDb(): void {
  userDb = null
  currentUserId = null
}
```

---

### Task 4-B-4: 前端 — 修改 category store 查询

**Files:**
- Modify: `src/stores/category.ts:11-16`

- [ ] **Step 1: 删除 `OR ledger_id IS NULL`**

将第 11-16 行的查询改为：

```typescript
const rows = await db.select<CategoryRow[]>(
  `SELECT id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted
   FROM categories
   WHERE ledger_id = $1 AND is_deleted = 0
   ORDER BY sort_order ASC, name ASC`,
  [ledgerId]
)
```

删除原来的 `(ledger_id = ? OR ledger_id IS NULL)` 模式。

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-B-5: 前端 — 修改 auth store 支持本地认证

**Files:**
- Modify: `src/stores/auth.ts`

- [ ] **Step 1: 重写 auth store**

auth store 需要管理三种状态：未登录、本地用户已登录、在线用户已登录。

```typescript
// src/stores/auth.ts (关键改动)
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import {
  getLocalUserByNickname,
  createLocalUser,
  updateLocalUserBinding,
  type LocalUser,
} from '@/db/meta'
import { openUserDb, closeUserDb, getCurrentUserId } from '@/db/userDb'
import * as api from '@/services/api'

export type AuthMode = 'none' | 'local' | 'online'

export const useAuthStore = defineStore('auth', () => {
  const currentLocalUser = ref<LocalUser | null>(null)
  const onlineUser = ref<api.User | null>(null)
  const mode = ref<AuthMode>('none')
  const isInitialized = ref(false)

  const isLoggedIn = computed(() => mode.value !== 'none')
  const isOnline = computed(() => mode.value === 'online')

  // 本地登录
  async function localLogin(nickname: string, password: string): Promise<boolean> {
    const user = await getLocalUserByNickname(nickname)
    if (!user) return false

    // 验证密码 (bcrypt compare)
    const valid = await verifyPassword(password, user.password_hash)
    if (!valid) return false

    // 打开用户 db
    await openUserDb(user.id)
    currentLocalUser.value = user
    mode.value = user.server_user_id ? 'online' : 'local'

    // 如果绑定了服务端，尝试恢复在线会话
    if (user.server_user_id && user.api_url) {
      api.setBaseUrl(user.api_url)
      const restored = await api.tryRestoreSession()
      if (restored) {
        onlineUser.value = restored
        mode.value = 'online'
      }
    }

    return true
  }

  // 创建本地账户
  async function createLocalAccount(
    nickname: string,
    password: string
  ): Promise<string> {
    const id = crypto.randomUUID()
    const hash = await hashPassword(password)
    await createLocalUser(id, nickname, hash)
    await openUserDb(id)
    currentLocalUser.value = {
      id,
      nickname,
      password_hash: hash,
      api_url: null,
      server_user_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    mode.value = 'local'
    return id
  }

  // 绑定服务端 (纯本地 → 在线)
  async function bindOnline(
    apiUrl: string,
    serverUser: api.AuthResponse
  ): Promise<void> {
    api.setBaseUrl(apiUrl)
    api.setTokens(serverUser.access_token, serverUser.refresh_token)

    await updateLocalUserBinding(
      currentLocalUser.value!.id,
      apiUrl,
      serverUser.user.id
    )

    currentLocalUser.value = {
      ...currentLocalUser.value!,
      api_url: apiUrl,
      server_user_id: serverUser.user.id,
    }

    onlineUser.value = serverUser.user
    mode.value = 'online'
  }

  // 登出
  function logout(): void {
    closeUserDb()
    api.clearTokens()
    currentLocalUser.value = null
    onlineUser.value = null
    mode.value = 'none'
  }

  // 初始化
  async function init(): Promise<void> {
    // 启动时不做自动登录，交由路由守卫处理
    isInitialized.value = true
  }

  return {
    currentLocalUser,
    onlineUser,
    mode,
    isInitialized,
    isLoggedIn,
    isOnline,
    localLogin,
    createLocalAccount,
    bindOnline,
    logout,
    init,
  }
})

// 密码工具函数 (复用 bcrypt)
async function hashPassword(password: string): Promise<string> {
  // Tauri 环境中用 Rust 侧 bcrypt 或使用 bcryptjs
  const bcrypt = await import('bcryptjs')
  return bcrypt.hash(password, 10)
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import('bcryptjs')
  return bcrypt.compare(password, hash)
}
```

- [ ] **Step 2: 安装 bcryptjs**

```bash
npm install bcryptjs && npm install -D @types/bcryptjs
```
Expected: 安装成功

- [ ] **Step 3: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: 检查类型错误并修复

---

### Task 4-B-6: 前端 — 修改 ledger store 和 db/index.ts

**Files:**
- Modify: `src/stores/ledger.ts`
- Modify: `src/db/index.ts`

- [ ] **Step 1: 重写 ledger store**

```typescript
// src/stores/ledger.ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getUserDb, getCurrentUserId } from '@/db/userDb'
import type { Ledger } from '@/types'

export const useLedgerStore = defineStore('ledger', () => {
  const ledgers = ref<Ledger[]>([])
  const currentLedgerId = ref<string | null>(null)

  async function init(): Promise<void> {
    const db = getUserDb()
    if (!db) return

    const rows = await db.select<Ledger[]>(
      'SELECT id, name, type, owner_id, team_id, created_at, updated_at FROM ledgers WHERE is_deleted = 0'
    )
    ledgers.value = rows

    if (rows.length > 0 && !currentLedgerId.value) {
      currentLedgerId.value = rows[0].id
    }
  }

  function setCurrentLedger(id: string): void {
    currentLedgerId.value = id
  }

  return { ledgers, currentLedgerId, init, setCurrentLedger }
})
```

- [ ] **Step 2: 更新 db/index.ts**

`db/index.ts` 中的 `ensureDefaultData` 和 `getDb` 已不再使用，改为从 `userDb.ts` 导入。保留文件但标记废弃函数：

```typescript
// src/db/index.ts
// DEPRECATED: 使用 src/db/meta.ts 和 src/db/userDb.ts 替代
// 保留迁移函数，在 userDb.ts 中按需调用
export { migrateAccounts, migrateTransactions } from './userDb'
```

实际上将 `initTables` 和 `ensureDefaultData` 的迁移逻辑搬到 `userDb.ts` 中。检查 `transaction` 表是否需要 migration（添加新列等）。

---

### Task 4-B-7: 前端 — 更新 store 调用方使用 getUserDb()

**Files:**
- Modify: `src/stores/account.ts` (getDb 调用改为 getUserDb)
- Modify: `src/stores/transaction.ts` (同上)
- Modify: `src/stores/tag.ts` (同上)
- Modify: `src/services/sync.ts` (同上)

- [ ] **Step 1: 全局替换 getDb → getUserDb**

在所有 store 文件中：

```typescript
// 旧
import { getDb } from '@/db'
const db = await getDb()

// 新
import { getUserDb } from '@/db/userDb'
const db = getUserDb()
if (!db) throw new Error('User DB not opened')
```

文件清单：
- `src/stores/account.ts`
- `src/stores/transaction.ts`
- `src/stores/tag.ts`
- `src/services/sync.ts`

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-B-8: 前端 — 更新 api.ts 支持动态 baseUrl

**Files:**
- Modify: `src/services/api.ts`

- [ ] **Step 1: 将 BASE_URL 改为可动态设置**

```typescript
// src/services/api.ts
let baseUrl: string | null = null

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '') // 去掉末尾斜杠
}

export function getBaseUrl(): string {
  if (!baseUrl) throw new Error('API base URL not configured')
  return baseUrl
}

// 所有 fetch 调用前检查 baseUrl
function buildUrl(path: string): string {
  return `${getBaseUrl()}${path}`
}
```

- [ ] **Step 2: 添加 tryRestoreSession**

```typescript
import type { User } from '@/types'

export async function tryRestoreSession(): Promise<User | null> {
  const stored = getStoredRefreshToken()
  if (!stored) return null

  try {
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: stored }),
    })
    if (!res.ok) return null
    const data = await res.json()
    accessToken = data.access_token
    refreshToken = data.refresh_token
    localStorage.setItem('refresh_token', data.refresh_token)
    return data.user
  } catch {
    return null
  }
}
```

- [ ] **Step 3: 添加 login/register 辅助函数**

```typescript
export interface AuthResponse {
  user: User
  access_token: string
  refresh_token: string
  ledger_id: string
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || '登录失败')
  }
  const data: AuthResponse = await res.json()
  setTokens(data.access_token, data.refresh_token)
  return data
}

export async function register(
  email: string,
  password: string,
  nickname: string
): Promise<AuthResponse> {
  const res = await fetch(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, nickname }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || '注册失败')
  }
  const data: AuthResponse = await res.json()
  setTokens(data.access_token, data.refresh_token)
  return data
}
```

- [ ] **Step 4: 删除旧的重复 `setTokens` 引用**

确保 `refreshAccessToken` 中的 `${BASE_URL}` 改为 `${baseUrl}`。

- [ ] **Step 5: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS (如有类型错误，检查 `User` 类型是否正确导入)

---

### Task 4-B-9: 提交 Phase 4-B

- [ ] **Step 1: 提交**

```bash
git add src/db/defaults.ts src/db/meta.ts src/db/userDb.ts src/db/index.ts \
        src/stores/auth.ts src/stores/category.ts src/stores/ledger.ts \
        src/stores/account.ts src/stores/transaction.ts src/stores/tag.ts \
        src/services/api.ts src/services/sync.ts package.json package-lock.json
git commit -m "feat: add per-user SQLite databases with local auth and _meta.db"
```

---

### Task 4-C-1: 前端 — 创建 WelcomePage

**Files:**
- Create: `src/views/WelcomePage.vue`
- Modify: `src/router/index.ts` (加路由)

- [ ] **Step 1: 创建欢迎页**

```vue
<!-- src/views/WelcomePage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">一起记账</h1>
      <p class="text-gray-500 text-center mb-8">创建本地账户以开始记账</p>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">昵称</label>
          <input
            v-model="nickname"
            type="text"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="你的昵称"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input
            v-model="password"
            type="password"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="设置密码"
          />
        </div>
      </div>

      <p v-if="error" class="text-red-500 text-sm mt-3">{{ error }}</p>

      <button
        :disabled="!valid || loading"
        class="w-full mt-6 py-3 rounded-xl font-medium text-white bg-blue-500 disabled:opacity-50"
        @click="handleCreateLocal"
      >
        {{ loading ? '创建中...' : '创建本地账户' }}
      </button>

      <p class="text-center text-gray-400 text-sm mt-4">
        已有账户？<router-link to="/login" class="text-blue-500">登录</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const nickname = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const valid = computed(() => nickname.value.trim().length > 0 && password.value.length >= 4)

async function handleCreateLocal(): Promise<void> {
  if (!valid.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.createLocalAccount(nickname.value.trim(), password.value)
    router.replace('/')
  } catch (e) {
    error.value = '创建失败，请重试'
  } finally {
    loading.value = false
  }
}
</script>
```

- [ ] **Step 2: 添加路由**

在 `src/router/index.ts` 中：

```typescript
{
  path: '/welcome',
  name: 'welcome',
  component: () => import('@/views/WelcomePage.vue'),
  meta: { hideTab: true },
}
```

---

### Task 4-C-2: 前端 — 添加路由守卫

**Files:**
- Modify: `src/router/index.ts`

- [ ] **Step 1: 添加全局前置守卫**

```typescript
import { getLocalUsers } from '@/db/meta'

router.beforeEach(async (to) => {
  // 公共页面 (不需要登录)
  const publicPages = ['/welcome', '/login']
  if (publicPages.includes(to.path)) return true

  // 检查是否有本地用户
  const users = await getLocalUsers()

  if (users.length === 0) {
    // 无用户 → 跳转欢迎页
    return { path: '/welcome', replace: true }
  }

  const auth = useAuthStore()
  if (!auth.isLoggedIn) {
    // 有用户但未登录 → 跳转登录页
    return { path: '/login', replace: true }
  }

  return true
})
```

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-C-3: 提交 Phase 4-C

- [ ] **Step 1: 提交**

```bash
git add src/views/WelcomePage.vue src/router/index.ts
git commit -m "feat: add WelcomePage and route guards for onboarding flow"
```

---

### Task 4-D-1: 前端 — 创建数据迁移服务

**Files:**
- Create: `src/services/migration.ts`

- [ ] **Step 1: 创建迁移服务**

```typescript
// src/services/migration.ts
import { getUserDb } from '@/db/userDb'
import { useLedgerStore } from '@/stores/ledger'
import { useAccountStore } from '@/stores/account'
import { useTransactionStore } from '@/stores/transaction'
import { useCategoryStore } from '@/stores/category'
import { useTagStore } from '@/stores/tag'
import { performSync } from '@/services/sync'
import { v4 as uuidv4 } from 'uuid'

// 将本地数据迁移到新的 server_ledger_id
export async function migrateLocalDataToServer(
  serverLedgerId: string,
  serverUserId: string
): Promise<void> {
  const db = getUserDb()
  if (!db) throw new Error('User DB not opened')

  // 更新本地 ledger id 为服务端 id
  const ledgers = await db.select<{ id: string }[]>(
    'SELECT id FROM ledgers WHERE is_deleted = 0 LIMIT 1'
  )
  if (ledgers.length === 0) return

  const oldLedgerId = ledgers[0].id

  // 更新各表的 ledger_id
  const tables = ['accounts', 'categories', 'tags', 'transactions']
  for (const table of tables) {
    await db.execute(
      `UPDATE ${table} SET ledger_id = $1 WHERE ledger_id = $2`,
      [serverLedgerId, oldLedgerId]
    )
  }

  // 更新 ledgers 表
  await db.execute(
    `UPDATE ledgers SET id = $1 WHERE id = $2`,
    [serverLedgerId, oldLedgerId]
  )

  // 更新 transactions 的 user_id
  await db.execute(
    `UPDATE transactions SET user_id = $1 WHERE user_id IN (SELECT id FROM ledgers WHERE id = $2)`,
    [serverUserId, serverLedgerId]
  )
}

// 首次全量上传
export async function firstFullSync(): Promise<void> {
  const db = getUserDb()
  if (!db) throw new Error('User DB not opened')

  // 拉取所有本地数据
  const accounts = await db.select('SELECT * FROM accounts WHERE is_deleted = 0')
  const categories = await db.select('SELECT * FROM categories WHERE is_deleted = 0')
  const tags = await db.select('SELECT * FROM tags WHERE is_deleted = 0')
  const transactions = await db.select('SELECT * FROM transactions WHERE is_deleted = 0')

  // 以本地数据为准，全量推送到服务端
  await performSync({
    last_synced_at: null,
    local_changes: {
      accounts,
      categories,
      tags,
      transactions,
    },
  })
}
```

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-D-2: 前端 — 创建 BindSyncPage

**Files:**
- Create: `src/views/BindSyncPage.vue`
- Modify: `src/router/index.ts` (加路由)

- [ ] **Step 1: 创建绑定同步页面**

```vue
<!-- src/views/BindSyncPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-2xl font-bold text-center mb-8">配置在线同步</h1>

      <!-- API 地址 -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-1">服务器地址</label>
        <input
          v-model="apiUrl"
          type="text"
          class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://api.example.com/api/v1"
        />
      </div>

      <p v-if="error" class="text-red-500 text-sm mb-3">{{ error }}</p>

      <!-- 登录已有账号 -->
      <div class="border-t pt-4 mb-4">
        <h2 class="text-sm font-medium text-gray-700 mb-3">已有在线账号</h2>
        <div class="space-y-3">
          <input v-model="email" type="email" placeholder="邮箱" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <input v-model="loginPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <button :disabled="loginLoading" class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium" @click="handleLogin">
            {{ loginLoading ? '登录中...' : '登录并同步' }}
          </button>
        </div>
      </div>

      <!-- 注册新账号 -->
      <div class="border-t pt-4">
        <h2 class="text-sm font-medium text-gray-700 mb-3">没有账号</h2>
        <div class="space-y-3">
          <input v-model="regNickname" type="text" placeholder="昵称" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <input v-model="regEmail" type="email" placeholder="邮箱" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <input v-model="regPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <button :disabled="regLoading" class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium" @click="handleRegister">
            {{ regLoading ? '注册中...' : '注册并同步' }}
          </button>
        </div>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/" class="text-blue-500">暂不配置，继续使用本地模式</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/services/api'
import { migrateLocalDataToServer, firstFullSync } from '@/services/migration'

const router = useRouter()
const auth = useAuthStore()

const apiUrl = ref('')
const error = ref('')
const loginLoading = ref(false)
const regLoading = ref(false)

const email = ref('')
const loginPassword = ref('')

const regNickname = ref('')
const regEmail = ref('')
const regPassword = ref('')

async function handleLogin(): Promise<void> {
  loginLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.login(email.value, loginPassword.value)
    await migrateLocalDataToServer(resp.ledger_id, resp.user.id)
    await auth.bindOnline(apiUrl.value, resp)
    await firstFullSync()
    router.replace('/')
  } catch (e: any) {
    error.value = e?.message || '登录失败'
  } finally {
    loginLoading.value = false
  }
}

async function handleRegister(): Promise<void> {
  regLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.register(regEmail.value, regPassword.value, regNickname.value)
    await migrateLocalDataToServer(resp.ledger_id, resp.user.id)
    await auth.bindOnline(apiUrl.value, resp)
    await firstFullSync()
    router.replace('/')
  } catch (e: any) {
    error.value = e?.message || '注册失败'
  } finally {
    regLoading.value = false
  }
}
</script>
```

- [ ] **Step 2: 加路由**

```typescript
{
  path: '/bind-sync',
  name: 'bind-sync',
  component: () => import('@/views/BindSyncPage.vue'),
  meta: { hideTab: true },
}
```

- [ ] **Step 3: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-D-3: 后端 — 登录/注册接口返回 ledger_id

**Files:**
- Modify: `backend/internal/model/user.go` (AuthResponse)
- Modify: `backend/internal/service/auth.go` (Login, Register)

- [ ] **Step 1: AuthResponse 增加 ledger_id**

```go
type AuthResponse struct {
    User       User   `json:"user"`
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`
    LedgerID   string `json:"ledger_id"`
}
```

- [ ] **Step 2: Register 和 Login 返回 ledger_id**

在 `Register` 函数中，创建账本后，将 `ledgerID` 填入 `AuthResponse.LedgerID`。

在 `Login` 函数中，查询用户个人账本后填入：

```go
// 登录成功后查询个人账本
var ledgerID string
err = s.pool.QueryRow(ctx,
    `SELECT id FROM ledgers WHERE owner_id = $1 AND type = 'personal' AND is_deleted = FALSE LIMIT 1`,
    userID,
).Scan(&ledgerID)
```

- [ ] **Step 3: 验证编译**

```bash
cd backend && go build ./...
```
Expected: PASS

---

### Task 4-D-4: 提交 Phase 4-D

- [ ] **Step 1: 提交**

```bash
git add src/services/migration.ts src/views/BindSyncPage.vue src/router/index.ts \
        backend/internal/model/user.go backend/internal/service/auth.go
git commit -m "feat: add local-to-online data migration and bind sync page"
```

---

### Task 4-E-1: 前端 — 改造 LoginPage

**Files:**
- Modify: `src/views/LoginPage.vue`

- [ ] **Step 1: 重写 LoginPage 为手动输入**

```vue
<!-- src/views/LoginPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">一起记账</h1>
      <p class="text-gray-500 text-center mb-8">输入账户信息登录</p>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">用户名</label>
          <input
            v-model="nickname"
            type="text"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="输入用户名"
            @keyup.enter="handleLogin"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input
            v-model="password"
            type="password"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="输入密码"
            @keyup.enter="handleLogin"
          />
        </div>
      </div>

      <p v-if="error" class="text-red-500 text-sm mt-3">{{ error }}</p>

      <button
        :disabled="!valid || loading"
        class="w-full mt-6 py-3 rounded-xl font-medium text-white bg-blue-500 disabled:opacity-50"
        @click="handleLogin"
      >
        {{ loading ? '登录中...' : '登录' }}
      </button>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/welcome" class="text-blue-500">创建新用户</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const nickname = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const valid = computed(() => nickname.value.trim().length > 0 && password.value.length > 0)

async function handleLogin(): Promise<void> {
  if (!valid.value) return
  loading.value = true
  error.value = ''
  try {
    const ok = await auth.localLogin(nickname.value.trim(), password.value)
    if (!ok) {
      error.value = '用户名或密码错误'
      return
    }
    router.replace('/')
  } catch (e) {
    error.value = '登录失败，请重试'
  } finally {
    loading.value = false
  }
}
</script>
```

- [ ] **Step 2: 删除旧的 LoginPage 内容**（如果原有的需要保留在线登录逻辑，合并到本页面）

- [ ] **Step 3: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-E-2: 提交 Phase 4-E

- [ ] **Step 1: 提交**

```bash
git add src/views/LoginPage.vue
git commit -m "feat: redesign LoginPage with manual username input for privacy"
```

---

### Task 4-F-1: 前端 — MePage 显示绑定状态

**Files:**
- Modify: `src/views/MePage.vue`

- [ ] **Step 1: 添加绑定状态显示和操作入口**

在 MePage 的现有模板中增加：

```vue
<!-- 添加到 MePage 模板中 -->
<div class="bg-white rounded-2xl p-4 shadow-sm">
  <h3 class="text-sm font-medium text-gray-500 mb-3">同步设置</h3>
  <div class="flex items-center justify-between">
    <div>
      <p class="font-medium">
        <span v-if="auth.isOnline" class="text-green-500">● 已绑定在线同步</span>
        <span v-else class="text-gray-400">○ 纯本地模式</span>
      </p>
      <p v-if="auth.isOnline && auth.currentLocalUser?.api_url" class="text-xs text-gray-400 mt-1">
        {{ auth.currentLocalUser.api_url }}
      </p>
    </div>
    <button
      v-if="!auth.isOnline"
      class="px-4 py-2 text-sm rounded-lg bg-blue-500 text-white"
      @click="$router.push('/bind-sync')"
    >
      配置在线同步
    </button>
  </div>
</div>

<!-- 登出按钮 -->
<button
  class="w-full mt-6 py-3 rounded-xl bg-red-50 text-red-500 font-medium"
  @click="handleLogout"
>
  退出登录
</button>
```

```typescript
// 在 script setup 中
import { useRouter } from 'vue-router'
const auth = useAuthStore()
const router = useRouter()

async function handleLogout(): Promise<void> {
  auth.logout()
  router.replace('/login')
}
```

- [ ] **Step 2: 验证编译**

```bash
npx vue-tsc --noEmit
```
Expected: PASS

---

### Task 4-F-2: 提交 Phase 4-F

- [ ] **Step 1: 提交**

```bash
git add src/views/MePage.vue
git commit -m "feat: add sync binding status and logout to MePage"
```

---

## 验证清单

完成所有 Task 后：

- [ ] **后端测试**: `cd backend && go test ./...`
- [ ] **后端编译**: `cd backend && go build ./...`
- [ ] **前端编译**: `npx vue-tsc --noEmit`
- [ ] **前端测试**: `npm run test`
- [ ] **桌面端验证**: `npm run tauri dev` → WelcomePage 创建账户 → 登录 → 记账 → 登出 → 切换用户
- [ ] **后端验证**: 启动 Docker Compose → 注册 2 个用户 → 检查 categories 表无重复 NULL 数据 → categories.ledger_id 列 NOT NULL
