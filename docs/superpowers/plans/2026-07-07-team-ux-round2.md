# 团队账本体验优化（第二轮）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现团队账本 12 项遗留体验优化：备注字段、成员系统（昵称/头像/别名）、筛选排序与成员筛选、卡片成员标注、权限控制、创建团队自动切换、头像上传、成员管理页。

**Architecture:** 数据层前置先行（后端迁移 + 接口 + 本地 schema 统一迁 userDb），再统一成员解析 helper，然后逐块做筛选展示、权限交互、入口流程。member_aliases 与 team_members 缓存都迁到 userDb（按本地用户物理隔离，去掉 setter 列），别名 apply 按 setter=me 过滤。账户归属统一为创建者本人。头像走后端本地磁盘 + /static 静态服务。

**Tech Stack:** Vue 3 + TypeScript + Pinia + SQLite（前端），Go + Chi + PostgreSQL + golang-migrate（后端）

---

## 阶段总览

- Phase 1 数据层：后端迁移/接口 + 前端本地 schema（note 列、team_members 表、member_aliases 迁 userDb）
- Phase 2 成员解析：api 层、sync 改造、useMemberInfo composable、MemberAvatar 组件
- Phase 3 备注 + 账户归属：transaction store note、AccountList owner 修正、RecordPage 表单 note
- Phase 4 筛选与展示：FilterPage 排序+成员筛选、TransactionList 卡片、AccountPickerSheet/AccountCard 归属
- Phase 5 权限交互：账户详情模式隐藏编辑/FAB、RecordPage 只选自己账户
- Phase 6 入口流程：CreateTeamPage 切换账本修复、ProfilePage 头像上传、TeamMembersPage、MePage 入口

---

## Phase 1: 数据层前置

### Task 1.1: 后端 005 迁移 — transactions 加 note 列

**Files:**
- Create: `backend/internal/database/migrations/005_transaction_note.up.sql`
- Create: `backend/internal/database/migrations/005_transaction_note.down.sql`

- [ ] **Step 1: 创建 up 迁移**

`backend/internal/database/migrations/005_transaction_note.up.sql`:

```sql
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS note VARCHAR(255);
```

- [ ] **Step 2: 创建 down 迁移**

`backend/internal/database/migrations/005_transaction_note.down.sql`:

```sql
ALTER TABLE transactions DROP COLUMN IF EXISTS note;
```

- [ ] **Step 3: 验证迁移可加载**

Run: `cd backend && go build ./...`
Expected: 编译通过（embed 会自动包含新迁移文件）

- [ ] **Step 4: Commit**

```bash
git add backend/internal/database/migrations/005_transaction_note.up.sql backend/internal/database/migrations/005_transaction_note.down.sql
git commit -m "feat: migration 005 — add note column to transactions"
```

---

### Task 1.2: 后端 model + sync 读写 note

**Files:**
- Modify: `backend/internal/model/transaction.go:6-20`
- Modify: `backend/internal/service/sync.go:254-297`（lwwMergeTransaction）
- Modify: `backend/internal/service/sync.go:436-462`（queryTransactions）
- Test: `backend/internal/service/sync_note_test.go`（纯 SQL 构造测试，无 DB 依赖）

- [ ] **Step 1: model.Transaction 加 Note 字段**

修改 `backend/internal/model/transaction.go`，在 `CategoryID` 后加：

```go
type Transaction struct {
	ID            string    `json:"id"`
	LedgerID      string    `json:"ledger_id"`
	UserID        string    `json:"user_id"`
	Amount        float64   `json:"amount"`
	Type          string    `json:"type"`
	FromAccountID *string   `json:"from_account_id"`
	ToAccountID   *string   `json:"to_account_id"`
	CategoryID    *string   `json:"category_id"`
	Note          *string   `json:"note"`
	OccurredAt    time.Time `json:"occurred_at"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
	IsDeleted     bool      `json:"is_deleted"`
	TagIDs        []string  `json:"tag_ids,omitempty"`
}
```

- [ ] **Step 2: lwwMergeTransaction 读写 note**

修改 `backend/internal/service/sync.go` 的 `lwwMergeTransaction`，INSERT 和 UPDATE 都加 note：

```go
func (s *SyncService) lwwMergeTransaction(ctx context.Context, tx pgx.Tx, t model.Transaction) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM transactions WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if err != nil {
		_, err = tx.Exec(ctx,
			`INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			t.ID, t.LedgerID, t.UserID, t.Amount, t.Type, t.FromAccountID, t.ToAccountID,
			t.CategoryID, t.Note, t.OccurredAt, t.CreatedAt, t.UpdatedAt, t.IsDeleted,
		)
		if err != nil {
			return err
		}
	} else {
		if !t.UpdatedAt.After(remoteUpdatedAt) {
			return nil
		}
		_, err = tx.Exec(ctx,
			`UPDATE transactions SET amount=$1, type=$2, from_account_id=$3, to_account_id=$4, category_id=$5, note=$6, occurred_at=$7, updated_at=$8, is_deleted=$9 WHERE id=$10`,
			t.Amount, t.Type, t.FromAccountID, t.ToAccountID, t.CategoryID, t.Note, t.OccurredAt, t.UpdatedAt, t.IsDeleted, t.ID,
		)
		if err != nil {
			return err
		}
	}

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
```

- [ ] **Step 3: queryTransactions 读取 note**

修改 `backend/internal/service/sync.go` 的 `queryTransactions`，SELECT 加 `t.note`，Scan 加 `&t.Note`：

```go
func (s *SyncService) queryTransactions(ctx context.Context, ledgerIDs []string, since time.Time) ([]model.Transaction, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT t.id, t.ledger_id, t.user_id, t.amount, t.type, t.from_account_id, t.to_account_id, t.category_id, t.note, t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
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
		if err := rows.Scan(&t.ID, &t.LedgerID, &t.UserID, &t.Amount, &t.Type, &t.FromAccountID, &t.ToAccountID, &t.CategoryID, &t.Note, &t.OccurredAt, &t.CreatedAt, &t.UpdatedAt, &t.IsDeleted, &tagIDs); err != nil {
			return nil, err
		}
		t.TagIDs = tagIDs
		transactions = append(transactions, t)
	}
	return transactions, rows.Err()
}
```

- [ ] **Step 4: 编译验证**

Run: `cd backend && go build ./...`
Expected: 编译通过

- [ ] **Step 5: Commit**

```bash
git add backend/internal/model/transaction.go backend/internal/service/sync.go
git commit -m "feat: backend transaction note field in model and sync"
```

---

### Task 1.3: 后端 GET /teams/{id}/members 接口

**Files:**
- Modify: `backend/internal/service/team.go` — 新增 `ListMembers`
- Modify: `backend/internal/handler/team.go` — 新增 `Members` handler
- Modify: `backend/cmd/server/main.go:73-81` — 注册路由
- Test: `backend/internal/handler/team_test.go` — 补充 handler 测试

- [ ] **Step 1: 写失败测试 — handler 缺 teamID 返回 400**

在 `backend/internal/handler/team_test.go` 末尾追加：

```go
func TestMembersHandler_MissingTeamID(t *testing.T) {
	// 路由参数缺失时 chi.URLParam 返回空，service 会因空 teamID 报错或返回空
	// 这里只验证 handler 不 panic、不带 body 时不会 500
	h := &TeamHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /teams/{id}/members", h.Members)

	req := httptest.NewRequest("GET", "/teams/some-id/members", nil)
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	// 没有 DB，service 调用会失败 → handler 返回 500；只要不是 panic/404 即可
	if rec.Code == http.StatusNotFound {
		t.Errorf("route not registered, got 404")
	}
}
```

Run: `cd backend && go test ./internal/handler/ -run TestMembersHandler`
Expected: 编译失败（`h.Members` 未定义）

- [ ] **Step 2: service.ListMembers**

在 `backend/internal/service/team.go` 末尾追加：

```go
type TeamMember struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Nickname  string    `json:"nickname"`
	AvatarURL *string   `json:"avatar_url"`
	Role      string    `json:"role"`
	JoinedAt  time.Time `json:"joined_at"`
}

func (s *TeamService) ListMembers(ctx context.Context, teamID string) ([]TeamMember, error) {
	if teamID == "" {
		return nil, fmt.Errorf("team id is required")
	}
	rows, err := s.pool.Query(ctx,
		`SELECT u.id, u.username, u.nickname, u.avatar_url, tm.role, tm.joined_at
		 FROM team_members tm
		 JOIN users u ON tm.user_id = u.id
		 WHERE tm.team_id = $1
		 ORDER BY tm.joined_at ASC`,
		teamID,
	)
	if err != nil {
		return nil, fmt.Errorf("query team members: %w", err)
	}
	defer rows.Close()

	var members []TeamMember
	for rows.Next() {
		var m TeamMember
		if err := rows.Scan(&m.UserID, &m.Username, &m.Nickname, &m.AvatarURL, &m.Role, &m.JoinedAt); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}
```

- [ ] **Step 3: handler.Members**

在 `backend/internal/handler/team.go` 追加：

```go
func (h *TeamHandler) Members(w http.ResponseWriter, r *http.Request) {
	teamID := chi.URLParam(r, "id")
	members, err := h.svc.ListMembers(r.Context(), teamID)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, members)
}
```

- [ ] **Step 4: 注册路由**

修改 `backend/cmd/server/main.go`，在 protected group 内 `r.Post("/teams/join", teamH.Join)` 之后加：

```go
			r.Get("/teams/{id}/members", teamH.Members)
```

- [ ] **Step 5: 测试通过**

Run: `cd backend && go test ./internal/handler/ -run TestMembersHandler -v`
Expected: PASS

- [ ] **Step 6: go vet**

Run: `cd backend && go vet ./...`
Expected: 无错误

- [ ] **Step 7: Commit**

```bash
git add backend/internal/service/team.go backend/internal/handler/team.go backend/internal/handler/team_test.go backend/cmd/server/main.go
git commit -m "feat: GET /teams/{id}/members endpoint"
```

---

### Task 1.4: 后端 POST /auth/avatar 头像上传 + 静态服务

**Files:**
- Modify: `backend/cmd/server/main.go` — 注册 `/static` 文件服务、`/auth/avatar` 路由
- Modify: `backend/internal/handler/auth.go` — 新增 `UploadAvatar` handler
- Modify: `backend/internal/service/auth.go` — 新增 `UpdateAvatar`（复用 UPDATE avatar_url）
- Modify: `backend/internal/config/config.go` — 加 `UploadDir`
- Test: `backend/internal/handler/auth_test.go`

- [ ] **Step 1: 写失败测试 — 空文件返回 400**

在 `backend/internal/handler/auth_test.go` 末尾追加：

```go
func TestUploadAvatar_MissingFile(t *testing.T) {
	h := &AuthHandler{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /auth/avatar", h.UploadAvatar)

	req := httptest.NewRequest("POST", "/auth/avatar", bytes.NewBufferString(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req = req.WithContext(setUserID(req.Context(), "test-user"))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing file, got %d", rec.Code)
	}
}
```

Run: `cd backend && go test ./internal/handler/ -run TestUploadAvatar`
Expected: 编译失败（`h.UploadAvatar` 未定义）

- [ ] **Step 2: config 加 UploadDir**

修改 `backend/internal/config/config.go`，Config 结构体加字段，Load 里读：

```go
type Config struct {
	DatabaseURL string
	RedisURL   string
	JWTSecret  string
	Port       string
	UploadDir  string
}
```

在 Load 里 `Port: getEnv("PORT", "8080"),` 之后加：

```go
		UploadDir: getEnv("UPLOAD_DIR", "./uploads"),
```

- [ ] **Step 3: service.UpdateAvatar**

在 `backend/internal/service/auth.go` 追加：

```go
func (s *AuthService) UpdateAvatar(ctx context.Context, userID string, avatarURL string) (*model.User, error) {
	_, err := s.pool.Exec(ctx, "UPDATE users SET avatar_url = $1, updated_at = $2 WHERE id = $3",
		avatarURL, time.Now().UTC(), userID)
	if err != nil {
		return nil, fmt.Errorf("update avatar_url: %w", err)
	}

	var user model.User
	err = s.pool.QueryRow(ctx,
		`SELECT id, username, nickname, avatar_url, created_at, updated_at FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Username, &user.Nickname, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}
	return &user, nil
}
```

- [ ] **Step 4: handler.UploadAvatar**

在 `backend/internal/handler/auth.go` 顶部 import 块加 `"io"`、`"os"`、`"path/filepath"`、`"strings"`。在文件末尾追加：

```go
func (h *AuthHandler) UploadAvatar(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	if userID == "" {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	// 限制 5MB
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	if err := r.ParseMultipartForm(5 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "file too large or invalid (max 5MB)")
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "file field is required")
		return
	}
	defer file.Close()

	// 校验扩展名
	ext := strings.ToLower(filepath.Ext(header.Filename))
	allowed := map[string]bool{".jpg": true, ".jpeg": true, ".png": true, ".webp": true, ".gif": true}
	if !allowed[ext] {
		writeError(w, http.StatusBadRequest, "unsupported file type")
		return
	}

	uploadDir := os.Getenv("UPLOAD_DIR")
	if uploadDir == "" {
		uploadDir = "./uploads"
	}
	avatarDir := filepath.Join(uploadDir, "avatars")
	if err := os.MkdirAll(avatarDir, 0o755); err != nil {
		writeError(w, http.StatusInternalServerError, "create dir failed")
		return
	}

	// 用 userID 命名，覆盖旧头像
	filename := userID + ext
	dstPath := filepath.Join(avatarDir, filename)
	dst, err := os.Create(dstPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "create file failed")
		return
	}
	defer dst.Close()
	if _, err := io.Copy(dst, file); err != nil {
		writeError(w, http.StatusInternalServerError, "write file failed")
		return
	}

	avatarURL := "/static/avatars/" + filename
	user, err := h.svc.UpdateAvatar(r.Context(), userID, avatarURL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}
```

- [ ] **Step 5: 注册路由 + 静态服务**

修改 `backend/cmd/server/main.go`。顶部 import 加 `"net/http"`（已有）。在 `r.Route("/api/v1", ...)` 之前加静态服务：

```go
	// 静态资源：头像文件
	uploadDir := cfg.UploadDir
	r.Handle("/static/*", http.StripPrefix("/static/", http.FileServer(http.Dir(uploadDir))))
```

在 protected group 内 `r.Put("/auth/profile", authH.UpdateProfile)` 之后加：

```go
				r.Post("/auth/avatar", authH.UploadAvatar)
```

- [ ] **Step 6: 测试通过**

Run: `cd backend && go test ./internal/handler/ -run TestUploadAvatar -v`
Expected: PASS

- [ ] **Step 7: go vet + build**

Run: `cd backend && go vet ./... && go build ./...`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add backend/internal/config/config.go backend/internal/service/auth.go backend/internal/handler/auth.go backend/internal/handler/auth_test.go backend/cmd/server/main.go
git commit -m "feat: POST /auth/avatar upload + /static file server"
```

---

### Task 1.5: 前端 types — Transaction.note、TeamMember 类型

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 加字段**

修改 `src/types/index.ts` 的 `Transaction` 接口，在 `category_id` 后加 `note`：

```typescript
export interface Transaction {
  id: string;
  ledger_id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  note: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  tag_ids?: string[];
  category?: Category;
  tags?: Tag[];
  from_account?: Account;
  to_account?: Account;
}
```

在文件末尾追加 `TeamMember` 类型：

```typescript
export interface TeamMember {
  user_id: string;
  username: string;
  nickname: string;
  avatar_url: string | null;
  role: string;
  joined_at: string;
}
```

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit`
Expected: 报多处缺 `note` —— 这是预期的，后续任务会补。先只确认 types 文件本身无语法错。

Run: `npx vue-tsc --noEmit 2>&1 | grep "src/types/index.ts"`
Expected: types 文件本身无错（其他文件的错后续修）

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add Transaction.note and TeamMember types"
```

---

### Task 1.6: 前端 userDb — note 列、team_members 表、member_aliases 表

**Files:**
- Modify: `src/db/userDb.ts`

- [ ] **Step 1: transactions 表加 note 列 + migrate**

修改 `src/db/userDb.ts` 的 `initUserTables` 中 transactions 建表，在 `category_id TEXT REFERENCES categories(id),` 之后加 `note TEXT,`：

```typescript
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
      note TEXT,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)
```

在 `migrateUserTables` 末尾追加 note 列迁移（在 occurred_at 迁移之后）：

```typescript
  if (!txCols.has("note")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN note TEXT")
  }
```

- [ ] **Step 2: 新增 team_members 表**

在 `initUserTables` 的 `transaction_tags` 建表之后追加：

```typescript
  await db.execute(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      nickname TEXT,
      avatar_url TEXT,
      role TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    )
  `)
```

- [ ] **Step 3: 新增 member_aliases 表（userDb，去 setter 列）**

在 team_members 建表之后追加：

```typescript
  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_aliases (
      target_user_id TEXT PRIMARY KEY,
      alias_name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
```

- [ ] **Step 4: 新增 team_members / member_aliases CRUD**

在 `src/db/userDb.ts` 文件末尾（`closeUserDb` 之前）追加：

```typescript
// --- team members 缓存（从 GET /teams/{id}/members 拉取，按本地用户隔离在 userDb） ---
export interface TeamMemberRow {
  team_id: string
  user_id: string
  username: string | null
  nickname: string | null
  avatar_url: string | null
  role: string | null
  updated_at: string
}

export async function upsertTeamMembers(teamId: string, members: { user_id: string; username: string; nickname: string; avatar_url: string | null; role: string }[]): Promise<void> {
  const db = getUserDb()
  if (!db) return
  const now = new Date().toISOString()
  for (const m of members) {
    await db.execute(
      `INSERT OR REPLACE INTO team_members (team_id, user_id, username, nickname, avatar_url, role, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [teamId, m.user_id, m.username, m.nickname, m.avatar_url, m.role, now]
    )
  }
}

export async function getTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const db = getUserDb()
  if (!db) return []
  return db.select<TeamMemberRow[]>(
    'SELECT team_id, user_id, username, nickname, avatar_url, role, updated_at FROM team_members WHERE team_id = $1',
    [teamId]
  )
}

// --- member aliases（userDb，去 setter 列；userDb 主人即唯一 setter） ---
export interface MemberAliasRow {
  target_user_id: string
  alias_name: string
  updated_at: string
}

export async function getMemberAliases(): Promise<MemberAliasRow[]> {
  const db = getUserDb()
  if (!db) return []
  return db.select<MemberAliasRow[]>(
    'SELECT target_user_id, alias_name, updated_at FROM member_aliases'
  )
}

export async function getMemberAlias(targetUserId: string): Promise<MemberAliasRow | null> {
  const db = getUserDb()
  if (!db) return null
  const rows = await db.select<MemberAliasRow[]>(
    'SELECT target_user_id, alias_name, updated_at FROM member_aliases WHERE target_user_id = $1',
    [targetUserId]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function setMemberAlias(targetUserId: string, aliasName: string): Promise<void> {
  const db = getUserDb()
  if (!db) return
  await db.execute(
    `INSERT OR REPLACE INTO member_aliases (target_user_id, alias_name, updated_at)
     VALUES ($1, $2, datetime('now'))`,
    [targetUserId, aliasName]
  )
}
```

- [ ] **Step 5: 编译验证**

Run: `npx vue-tsc --noEmit 2>&1 | grep "src/db/userDb.ts"`
Expected: userDb.ts 本身无错

- [ ] **Step 6: Commit**

```bash
git add src/db/userDb.ts
git commit -m "feat: userDb — note column, team_members & member_aliases tables"
```

---

### Task 1.7: 前端 meta.ts — 删除 member_aliases

**Files:**
- Modify: `src/db/meta.ts`

- [ ] **Step 1: 删除 member_aliases 建表**

修改 `src/db/meta.ts` 的 `initMetaTables`，删除 member_aliases 建表块：

```typescript
  // 迁移：旧表补充 username 列（不可变登录键，区别于可变的 nickname）
  if (!info.some(col => col.name === 'username')) {
    await db.execute("ALTER TABLE local_users ADD COLUMN username TEXT")
  }
  // 回填：username 为空时用当前 nickname 初始化（旧记录的 nickname 即原登录键）
  await db.execute("UPDATE local_users SET username = nickname WHERE username IS NULL")
}
```

（删除原先紧跟其后的 `CREATE TABLE IF NOT EXISTS member_aliases ...` 块）

- [ ] **Step 2: 删除 MemberAlias 接口与 CRUD 函数**

删除 `src/db/meta.ts` 中的 `export interface MemberAlias`、`getMemberAliases`、`setMemberAlias`（从 `export interface MemberAlias {` 到 `setMemberAlias` 函数结束）。

- [ ] **Step 3: 清理引用 — TransactionList.vue**

`src/views/TransactionList.vue:11` 当前从 `@/db/meta` 导入 `getMemberAliases, type MemberAlias`。改为从 `@/db/userDb` 导入（Task 2.x 会重写这块，这里先改导入避免编译断）：

```typescript
import { getMemberAliases, getCurrentUserId } from "@/db/userDb";
import type { MemberAliasRow } from "@/db/userDb";
```

把 `const memberAliases = ref<MemberAlias[]>([])` 改为 `ref<MemberAliasRow[]>([])`。

注：`getUserDisplayName` 当前用 `a.setter_user_id`，userDb 表无此列，运行时会查不到别名——这是过渡态，Task 2.4 会用 useMemberInfo 重写。先保证编译通过：把 `getUserDisplayName` 内的 `a.setter_user_id === currentUserId &&` 条件去掉，只留 `a.target_user_id === userId`：

```typescript
function getUserDisplayName(userId: string): string {
  const currentUserId = authStore.currentLocalUser?.server_user_id || getCurrentUserId();
  if (userId === currentUserId) return "我";
  const alias = memberAliases.value.find((a) => a.target_user_id === userId);
  if (alias) return alias.alias_name;
  return userId.slice(0, 8);
}
```

- [ ] **Step 4: 清理引用 — grep 检查**

Run: `grep -rn "from \"@/db/meta\"" src/ | grep -i "member"` 
Expected: 无输出（所有 member_aliases 引用已迁到 userDb）

- [ ] **Step 5: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep -E "meta.ts|TransactionList.vue" | head -20`
Expected: 无 meta.ts member_aliases 残留错误

- [ ] **Step 6: Commit**

```bash
git add src/db/meta.ts src/views/TransactionList.vue
git commit -m "refactor: remove member_aliases from meta.db (moved to userDb)"
```

---

## Phase 2: 成员解析

### Task 2.1: 前端 api.ts — fetchTeamMembers、uploadAvatar

**Files:**
- Modify: `src/services/api.ts`

- [ ] **Step 1: 加函数**

在 `src/services/api.ts` 末尾追加（需 import `src/types` 的 TeamMember，或直接内联类型）：

```typescript
import type { TeamMember } from "@/types";

export async function fetchTeamMembers(teamId: string): Promise<TeamMember[]> {
  const res = await apiFetch<TeamMember[]>(`/teams/${teamId}/members`);
  if (!res.ok || !res.data) {
    throw new Error(res.error || "获取成员失败");
  }
  return res.data;
}

export async function uploadAvatar(file: File): Promise<User> {
  const formData = new FormData();
  formData.append("file", file);
  const url = `${getBaseUrl()}/auth/avatar`;
  const headers: Record<string, string> = {};
  // accessToken 通过模块作用域访问
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  const res = await fetch(url, { method: "POST", headers, body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "上传失败");
  }
  return res.json();
}
```

注意：`accessToken` 已是模块内变量，可直接引用；不要设 `Content-Type`，让浏览器自动带 multipart boundary。

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "src/services/api.ts"`
Expected: 无错

- [ ] **Step 3: Commit**

```bash
git add src/services/api.ts
git commit -m "feat: api fetchTeamMembers + uploadAvatar"
```

---

### Task 2.2: 前端 sync.ts — member_aliases 推送带 setter、apply 过滤 setter=me 写 userDb

**Files:**
- Modify: `src/services/sync.ts:6-11`（MemberAliasPayload 不变）
- Modify: `src/services/sync.ts:134-275`（applyRemoteChanges 的 member_aliases 段）

- [ ] **Step 1: apply 过滤 setter=me，写 userDb（去 setter 列）**

修改 `src/services/sync.ts`，保持现有动态 import 模式（auth.ts 顶层 import 了 sync.ts，反向顶层 import 会成循环依赖，所以 useAuthStore 用动态 import）。在文件末尾（applyRemoteChanges 之后）加 helper：

```typescript
// 获取在线模式下的服务端 user id（别名 setter 以服务端 id 为准）。
// 动态 import 避免与 auth.ts 顶层循环依赖（auth.ts import sync.ts）。
async function authServerUserId(): Promise<string | null> {
  const { useAuthStore } = await import("@/stores/auth");
  try {
    return useAuthStore().currentLocalUser?.server_user_id ?? null;
  } catch {
    return null;
  }
}
```

替换 `applyRemoteChanges` 末尾的 member_aliases 段（255-274 行的 `for (const alias ...)` 块）为：

```typescript
  // member_aliases：本地 userDb 只存"我设的"别名（去 setter 列），
  // 服务端 payload 带 setter_user_id 标识，apply 时过滤 setter=me 再写本地
  const myUserId = getCurrentUserId() || (await authServerUserId()) || "";
  for (const alias of (remote.member_aliases || [])) {
    if (alias.setter_user_id !== myUserId) continue;
    const { getMemberAlias, setMemberAlias } = await import("@/db/userDb");
    const local = await getMemberAlias(alias.target_user_id);
    if (!local || alias.updated_at > local.updated_at) {
      await setMemberAlias(alias.target_user_id, alias.alias_name);
      // ponytail: setMemberAlias 内部用 datetime('now')，与服务端 updated_at 对齐误差可接受
    }
  }
```

- [ ] **Step 2: 推送时给本地别名补 setter_user_id**

在 `applyRemoteChanges` 之外，新增一个导出函数收集本地别名供推送。当前 `performSync` 用 `pendingChanges.member_aliases`，需要让别名变更入队。新增 `collectMemberAliasesForSync`：

在 `src/services/sync.ts` 末尾追加：

```typescript
/**
 * 收集本地 userDb 的所有别名，补上 setter_user_id，供 sync 推送。
 * 调用方在 enqueueSync 前调用，把结果放进 member_aliases。
 */
export async function collectMemberAliasesForSync(): Promise<MemberAliasPayload[]> {
  const { getMemberAliases } = await import("@/db/userDb");
  const aliases = await getMemberAliases();
  const setter = (await authServerUserId()) || getCurrentUserId() || "";
  return aliases.map((a) => ({
    setter_user_id: setter,
    target_user_id: a.target_user_id,
    alias_name: a.alias_name,
    updated_at: a.updated_at,
  }));
}
```

- [ ] **Step 3: performSync 推送前注入本地别名**

修改 `performSync`，在 `const changes = { ...pendingChanges };` 之后、`apiFetch` 之前加：

```typescript
  // 推送前补充本地 member_aliases（别名变更不经过 pendingChanges 入队，这里全量带）
  try {
    changes.member_aliases = await collectMemberAliasesForSync();
  } catch (e) {
    console.warn("[sync] collectMemberAliasesForSync failed:", e);
  }
```

- [ ] **Step 4: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "src/services/sync.ts"`
Expected: 无错

- [ ] **Step 5: 单测 — collectMemberAliasesForSync 标 setter**

创建 `src/services/__tests__/syncMemberAlias.test.ts`（单独文件，避免与现有 sync.test.ts 的文件级 vi.mock 冲突）：

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(),
  getCurrentUserId: vi.fn(() => "local-user-1"),
  getMemberAliases: vi.fn(),
  getMemberAlias: vi.fn(),
  setMemberAlias: vi.fn(),
  openUserDb: vi.fn(),
  closeUserDb: vi.fn(),
}));
vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  hasBaseUrl: vi.fn(() => true),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(() => ({ currentLocalUser: { server_user_id: "server-me" } })),
}));

import { collectMemberAliasesForSync } from "@/services/sync";
import { getMemberAliases } from "@/db/userDb";

describe("collectMemberAliasesForSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps setter_user_id with server user id", async () => {
    (getMemberAliases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_user_id: "u-other", alias_name: "阿明", updated_at: "2026-07-07T00:00:00Z" },
    ]);
    const out = await collectMemberAliasesForSync();
    expect(out).toHaveLength(1);
    expect(out[0].setter_user_id).toBe("server-me");
    expect(out[0].target_user_id).toBe("u-other");
    expect(out[0].alias_name).toBe("阿明");
  });
});
```

Run: `npx vitest run src/services/__tests__/syncMemberAlias.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "feat: sync member_aliases — filter setter=me on apply, stamp on push"
```

---

### Task 2.3: 前端 useMemberInfo composable

**Files:**
- Create: `src/composables/useMemberInfo.ts`
- Create: `src/composables/__tests__/useMemberInfo.test.ts`

- [ ] **Step 1: 写失败测试**

`src/composables/__tests__/useMemberInfo.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const mockGetMemberAlias = vi.fn();
const mockGetTeamMembers = vi.fn();

vi.mock("@/db/userDb", () => ({
  getMemberAlias: (...a: unknown[]) => mockGetMemberAlias(...a),
  getTeamMembers: (...a: unknown[]) => mockGetTeamMembers(...a),
  getCurrentUserId: vi.fn(() => "local-me"),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    currentLocalUser: {
      server_user_id: "server-me",
      avatar_url: "🐱",
      nickname: "我本人",
    },
  }),
}));

import { useMemberInfo } from "@/composables/useMemberInfo";

describe("useMemberInfo.getMember", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockGetMemberAlias.mockReset();
    mockGetTeamMembers.mockReset();
  });

  it("returns '我' for self", async () => {
    const { getMember } = useMemberInfo();
    const r = await getMember("server-me");
    expect(r.displayName).toBe("我");
    expect(r.avatarUrl).toBe("🐱");
  });

  it("prefers alias over nickname/username", async () => {
    mockGetMemberAlias.mockResolvedValueOnce({ target_user_id: "u2", alias_name: "阿明", updated_at: "" });
    mockGetTeamMembers.mockResolvedValueOnce([
      { team_id: "t1", user_id: "u2", username: "alice", nickname: "Alice", avatar_url: null, role: "member", updated_at: "" },
    ]);
    const { getMember } = useMemberInfo();
    const r = await getMember("u2");
    expect(r.displayName).toBe("阿明");
  });

  it("falls back to nickname then username (not id prefix)", async () => {
    mockGetMemberAlias.mockResolvedValueOnce(null);
    mockGetTeamMembers.mockResolvedValueOnce([
      { team_id: "t1", user_id: "u3", username: "bob", nickname: "Bob", avatar_url: "🐶", role: "member", updated_at: "" },
    ]);
    const { getMember } = useMemberInfo();
    const r = await getMember("u3");
    expect(r.displayName).toBe("Bob");
    expect(r.avatarUrl).toBe("🐶");
  });

  it("uses username when nickname missing", async () => {
    mockGetMemberAlias.mockResolvedValueOnce(null);
    mockGetTeamMembers.mockResolvedValueOnce([
      { team_id: "t1", user_id: "u4", username: "carol", nickname: null, avatar_url: null, role: "member", updated_at: "" },
    ]);
    const { getMember } = useMemberInfo();
    const r = await getMember("u4");
    expect(r.displayName).toBe("carol");
  });
});
```

Run: `npx vitest run src/composables/__tests__/useMemberInfo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2: 实现 composable**

`src/composables/useMemberInfo.ts`:

```typescript
import { getMemberAlias, getTeamMembers, getCurrentUserId } from "@/db/userDb";
import { useAuthStore } from "@/stores/auth";

export interface MemberInfo {
  displayName: string;
  avatarUrl: string | null;
}

/**
 * 统一成员解析：别名（userDb member_aliases，userDb 主人即 setter）> 昵称 > username。
 * 不再 fallback 到 id 前 8 位。
 */
export function useMemberInfo() {
  const auth = useAuthStore();

  async function getMember(userId: string): Promise<MemberInfo> {
    const myServerId = auth.currentLocalUser?.server_user_id;
    const myLocalId = getCurrentUserId();
    const selfId = myServerId || myLocalId || "";

    if (userId === selfId || userId === myServerId) {
      return {
        displayName: "我",
        avatarUrl: auth.currentLocalUser?.avatar_url ?? null,
      };
    }

    // 别名优先
    const alias = await getMemberAlias(userId);
    if (alias) {
      // 仍需 team_members 拿头像
      const member = await lookupTeamMember(userId);
      return { displayName: alias.alias_name, avatarUrl: member?.avatar_url ?? null };
    }

    const member = await lookupTeamMember(userId);
    if (member?.nickname) return { displayName: member.nickname, avatarUrl: member.avatar_url };
    if (member?.username) return { displayName: member.username, avatarUrl: member.avatar_url };

    // 无任何信息：显示 id 前 8 位（兜底，正常情况不会到这）
    return { displayName: userId.slice(0, 8), avatarUrl: null };
  }

  async function lookupTeamMember(userId: string) {
    // team_members 缓存按 team_id 存，需遍历当前团队的缓存。
    // ponytail: 取当前 ledger 的 team_id，查该 team；若无可从 ledger store 推导。
    const { useLedgerStore } = await import("@/stores/ledger");
    const ledger = useLedgerStore().currentLedger;
    if (!ledger?.team_id) return null;
    const members = await getTeamMembers(ledger.team_id);
    return members.find((m) => m.user_id === userId) ?? null;
  }

  return { getMember };
}
```

- [ ] **Step 3: 测试通过**

Run: `npx vitest run src/composables/__tests__/useMemberInfo.test.ts`
Expected: PASS

注意：测试里 mock 了 `useLedgerStore`？没 mock 会用真 store。补 mock — 在测试文件顶部 vi.mock 区加：

```typescript
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ currentLedger: { team_id: "t1" } }),
}));
```

若测试因这步失败，补上后重跑。

- [ ] **Step 4: Commit**

```bash
git add src/composables/useMemberInfo.ts src/composables/__tests__/useMemberInfo.test.ts
git commit -m "feat: useMemberInfo composable — alias>nickname>username"
```

---

### Task 2.4: 前端 MemberAvatar 组件

**Files:**
- Create: `src/components/MemberAvatar.vue`

- [ ] **Step 1: 实现**

`src/components/MemberAvatar.vue`:

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { useMemberInfo } from "@/composables/useMemberInfo";

const props = defineProps<{
  userId: string;
  size?: number;
}>();

const { getMember } = useMemberInfo();
const displayName = ref("");
const avatarUrl = ref<string | null>(null);

async function load() {
  const info = await getMember(props.userId);
  displayName.value = info.displayName;
  avatarUrl.value = info.avatarUrl;
}

watch(() => props.userId, load, { immediate: true });
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full bg-gray-200 text-text-secondary overflow-hidden"
    :style="{ width: (size ?? 20) + 'px', height: (size ?? 20) + 'px', fontSize: (size ?? 20) * 0.55 + 'px' }"
  >
    <img
      v-if="avatarUrl && avatarUrl.startsWith('http')"
      :src="avatarUrl"
      :alt="displayName"
      class="h-full w-full object-cover"
    />
    <span v-else-if="avatarUrl">{{ avatarUrl }}</span>
    <span v-else>{{ displayName.charAt(0) }}</span>
  </span>
</template>
```

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "MemberAvatar.vue"`
Expected: 无错

- [ ] **Step 3: Commit**

```bash
git add src/components/MemberAvatar.vue
git commit -m "feat: MemberAvatar component — img/emoji/initial fallback"
```

---

## Phase 3: 备注 + 账户归属

### Task 3.1: 前端 transaction store — note 支持

**Files:**
- Modify: `src/stores/transaction.ts`（QUERY、assembleTransaction、add、update）
- Modify: `src/stores/__tests__/transaction.test.ts`

- [ ] **Step 1: 写失败测试 — note 透传**

在 `src/stores/__tests__/transaction.test.ts` 的 `describe("add"` 内追加一个测试：

```typescript
    it("should insert note into transactions", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "expense",
        amount: 10,
        category_id: "cat-1",
        from_account_id: "acc-1",
        to_account_id: null,
        occurred_at: "2026-07-07T12:00:00Z",
        tag_ids: [],
        note: "午餐-面馆",
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["note", "午餐-面馆"]).includes
          ? expect.any(Array)
          : expect.any(Array)
      );
      // 直接断言第 4 个参数起的值含 note
      const insertCall = mockDb.execute.mock.calls.find((c) => String(c[0]).includes("INSERT INTO transactions"));
      expect(insertCall[1]).toContain("午餐-面馆");
    });
```

注：`expect.arrayContaining(["note", ...])` 写法不对 SQL 字符串不适用，简化为断言参数数组包含 note 值即可：

```typescript
    it("should insert note into transactions", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "expense",
        amount: 10,
        category_id: "cat-1",
        from_account_id: "acc-1",
        to_account_id: null,
        occurred_at: "2026-07-07T12:00:00Z",
        tag_ids: [],
        note: "午餐-面馆",
      });

      const insertCall = mockDb.execute.mock.calls.find((c) => String(c[0]).includes("INSERT INTO transactions"));
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain("午餐-面馆");
    });
```

Run: `npx vitest run src/stores/__tests__/transaction.test.ts -t "should insert note"`
Expected: FAIL（add 的 data 类型无 note / INSERT 不含 note）

- [ ] **Step 2: assembleTransaction + QUERY 加 note**

修改 `src/stores/transaction.ts`：

`TransactionRow` 接口加 `note: string | null;`（在 `to_account_color: string | null;` 之后）。

`assembleTransaction` 在 `is_deleted: Boolean(row.is_deleted),` 之后加 `note: row.note,`。

QUERY 的 SELECT 列表加 `t.note`：

```typescript
const QUERY = `
  SELECT
    t.id, t.ledger_id, t.user_id, t.amount, t.type,
    t.from_account_id, t.to_account_id, t.category_id, t.note,
    t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
    c.name AS category_name, c.type AS category_type, c.icon AS category_icon, c.owner_id AS category_owner_id, c.sort_order AS category_sort_order,
    GROUP_CONCAT(DISTINCT tg.tag_id) AS tag_ids,
    GROUP_CONCAT(DISTINCT tags.name) AS tag_names,
    fa.name AS from_account_name, fa.type AS from_account_type, fa.color AS from_account_color,
    ta.name AS to_account_name, ta.type AS to_account_type, ta.color AS to_account_color
  FROM transactions t
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN transaction_tags tg ON t.id = tg.transaction_id
  LEFT JOIN tags ON tg.tag_id = tags.id AND tags.is_deleted = 0
  LEFT JOIN accounts fa ON t.from_account_id = fa.id
  LEFT JOIN accounts ta ON t.to_account_id = ta.id
  WHERE t.ledger_id = ? AND t.is_deleted = 0
`;
```

- [ ] **Step 3: add 支持 note**

修改 `add` 的 data 参数类型加 `note?: string | null;`，INSERT 加 note：

```typescript
  async function add(data: {
    ledger_id: string;
    user_id: string;
    type: TransactionType;
    amount: number;
    category_id: string | null;
    from_account_id: string | null;
    to_account_id: string | null;
    occurred_at: string;
    tag_ids: string[];
    note?: string | null;
  }): Promise<string> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await db.execute(
      `INSERT INTO transactions (id, ledger_id, user_id, type, amount, category_id, from_account_id, to_account_id, note, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, data.ledger_id, data.user_id, data.type, data.amount, data.category_id,
        data.from_account_id, data.to_account_id, data.note ?? null, data.occurred_at, now, now,
      ]
    );
```

- [ ] **Step 4: update 支持 note**

修改 `update` 的 data Partial 类型加 `note?: string | null;`，在条件块加：

```typescript
    if (data.note !== undefined) { sets.push("note = ?"); values.push(data.note); }
```

- [ ] **Step 5: 测试通过**

Run: `npx vitest run src/stores/__tests__/transaction.test.ts`
Expected: PASS（含新测试）

- [ ] **Step 6: 更新已有测试 fixture**

已有测试的 `makeTx` 和 row fixture 无 note 字段，`assembleTransaction` 现在读 `row.note`，fixture 缺字段会是 `undefined`。给 `makeTx` 加 `note: null` 默认：

```typescript
function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    ledger_id: "pl-1",
    user_id: "u-1",
    amount: 100,
    type: "expense",
    from_account_id: "acc-1",
    to_account_id: null,
    category_id: "cat-1",
    note: null,
    occurred_at: "2026-06-09T12:00:00Z",
    created_at: "2026-06-09T12:00:00Z",
    updated_at: "2026-06-09T12:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}
```

给各 row fixture（"should load transactions..."、computed 测试）加 `note: null`。Run 测试确认全绿。

- [ ] **Step 7: Commit**

```bash
git add src/stores/transaction.ts src/stores/__tests__/transaction.test.ts
git commit -m "feat: transaction store note field end-to-end"
```

---

### Task 3.2: 前端 AccountList 修正 owner_id

**Files:**
- Modify: `src/views/AccountList.vue:41-56`

- [ ] **Step 1: 修正 owner_id 赋值**

修改 `src/views/AccountList.vue` 的 `handleSubmit`，`owner_id` 从 `ledgerStore.currentLedger.owner_id` 改为当前用户。顶部 script 加 import：

```typescript
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";

const auth = useAuthStore();
```

`handleSubmit` 改为：

```typescript
async function handleSubmit(data: {
  name: string;
  type: AccountType;
  initial_balance: number;
  credit_limit?: number;
  repayment_day?: number;
  color: string;
}) {
  if (!ledgerStore.currentLedger) return;
  await accountStore.add({
    ledger_id: ledgerStore.currentLedger.id,
    owner_id: auth.currentLocalUser?.server_user_id || getCurrentUserId() || "",
    category: ACCOUNT_CATEGORY[data.type],
    ...data,
  });
}
```

- [ ] **Step 2: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "AccountList.vue"`
Expected: 无错

- [ ] **Step 3: Commit**

```bash
git add src/views/AccountList.vue
git commit -m "fix: account owner_id uses current user, not ledger owner"
```

---

### Task 3.3: 前端 RecordPage — 表单加 note 字段

**Files:**
- Modify: `src/views/RecordPage.vue`

- [ ] **Step 1: 加 note 状态**

在 `src/views/RecordPage.vue` script 的 `const selectedTagIds = ref<string[]>([])` 之后加：

```typescript
const note = ref("");
```

- [ ] **Step 2: 编辑模式预填 note**

在 onMounted 编辑模式分支（`selectedTagIds.value = tx.tags?.map(...) ?? [];` 之后）加：

```typescript
      note.value = tx.note ?? "";
```

新增模式分支末尾（`categoryId.value = defaultCategoryId.value;` 之后）加：

```typescript
    note.value = "";
```

- [ ] **Step 3: doSave 传 note**

修改 `doSave` 的 `const data = {...}`，在 `tag_ids: selectedTagIds.value,` 之后加 `note: note.value.trim() || null,`：

```typescript
    const data = {
      ledger_id: ledgerId,
      user_id: auth.currentLocalUser?.server_user_id || getCurrentUserId()!,
      type: txType.value,
      amount: amt,
      category_id: txType.value === "transfer" ? null : categoryId.value,
      from_account_id: txType.value === "expense" || txType.value === "transfer" ? fromAccountId.value : null,
      to_account_id: txType.value === "income" || txType.value === "transfer" ? toAccountId.value : null,
      occurred_at: new Date(occurredAt.value).toISOString(),
      tag_ids: selectedTagIds.value,
      note: note.value.trim() || null,
    };
```

- [ ] **Step 4: onSaveNext 重置 note**

`onSaveNext` 的重置块加 `note.value = "";`：

```typescript
async function onSaveNext() {
  const ok = await doSave();
  if (ok) {
    expression.value = "";
    selectedTagIds.value = [];
    note.value = "";
    categoryId.value = defaultCategoryId.value;
    occurredAt.value = toLocalDatetimeString(new Date());
  }
}
```

- [ ] **Step 5: template 加备注输入**

在 template 的「6. 标签」块（`<!-- 6. 标签 -->` 的 `</div>` 之后、`</div>` 容器结束之前）加：

```html
      <!-- 7. 备注 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">备注</label>
        <input
          v-model="note"
          type="text"
          maxlength="100"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          placeholder="可选，最多 100 字"
        />
      </div>
```

- [ ] **Step 6: 类型检查 + 启动验证**

Run: `npx vue-tsc --noEmit 2>&1 | grep "RecordPage.vue"`
Expected: 无错

手动：`npm run dev` → 记账页填备注保存 → 流水卡片应能显示（Task 4.2 完成后）

- [ ] **Step 7: Commit**

```bash
git add src/views/RecordPage.vue
git commit -m "feat: RecordPage note field"
```

---

## Phase 4: 筛选与展示

### Task 4.1: 前端 FilterPage — 排序调整 + 成员筛选块

**Files:**
- Modify: `src/views/FilterPage.vue`

- [ ] **Step 1: script 加成员状态与加载**

修改 `src/views/FilterPage.vue` script。顶部 import 加：

```typescript
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { getTeamMembers } from "@/db/userDb";
import { fetchTeamMembers } from "@/services/api";
import type { TeamMemberRow } from "@/db/userDb";

const auth = useAuthStore();
```

在 `const selectedCategoryIds = ref<string[]>([])` 之后加：

```typescript
const selectedMemberIds = ref<string[]>([]);
const teamMembers = ref<TeamMemberRow[]>([]);
const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
const currentUserId = computed(() => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "");
```

加 `computed` import（已有 `computed`）。

onMounted 中 `await Promise.all([...])` 之后加成员加载：

```typescript
  // 团队账本：拉取并缓存成员
  if (isTeamLedger.value && ledgerStore.currentLedger?.team_id) {
    const teamId = ledgerStore.currentLedger.team_id;
    try {
      const members = await fetchTeamMembers(teamId);
      const { upsertTeamMembers } = await import("@/db/userDb");
      await upsertTeamMembers(teamId, members);
    } catch (e) {
      console.warn("[FilterPage] fetchTeamMembers failed:", e);
    }
    teamMembers.value = await getTeamMembers(teamId);
  }

  if (route.query.members) {
    selectedMemberIds.value = (route.query.members as string).split(",").filter(Boolean);
  }
```

- [ ] **Step 2: toggle/apply/reset 加成员**

在 `toggleCategory` 之后加：

```typescript
function toggleMember(memberId: string) {
  const idx = selectedMemberIds.value.indexOf(memberId);
  if (idx >= 0) {
    selectedMemberIds.value.splice(idx, 1);
  } else {
    selectedMemberIds.value.push(memberId);
  }
}
```

`apply` 加：

```typescript
  if (selectedMemberIds.value.length > 0) query.members = selectedMemberIds.value.join(",");
```

`reset` 加：

```typescript
  selectedMemberIds.value = [];
```

- [ ] **Step 3: template 排序 — 账户→日期→分类→成员→标签**

重排 template 顺序为：账户（不动）→ 日期时间范围（不动）→ 分类（上移）→ 成员（新）→ 标签（下移到最后）。

把「分类（多选）」块整体移到「日期时间范围」块之后、「标签」块之前。

在「分类」块之后、「标签」块之前插入成员块：

```html
      <!-- 成员（多选，仅团队账本） -->
      <div v-if="isTeamLedger" class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">👥 成员</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="m in teamMembers"
            :key="m.user_id"
            class="rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="selectedMemberIds.includes(m.user_id)
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'"
            @click="toggleMember(m.user_id)"
          >
            {{ selectedMemberIds.includes(m.user_id) ? '☑' : '☐' }}
            {{ m.user_id === currentUserId ? '我' : (m.nickname || m.username || m.user_id.slice(0,8)) }}
          </button>
          <p v-if="teamMembers.length === 0" class="text-xs text-text-secondary">暂无成员</p>
        </div>
      </div>
```

确认最终顺序：账户 → 日期时间范围 → 分类 → 成员 → 标签 → 操作按钮。

- [ ] **Step 4: 类型检查 + 启动验证**

Run: `npx vue-tsc --noEmit 2>&1 | grep "FilterPage.vue"`
Expected: 无错

手动：`npm run dev` → 团队账本下进筛选页 → 确认顺序与成员块出现；个人账本无成员块。

- [ ] **Step 5: Commit**

```bash
git add src/views/FilterPage.vue
git commit -m "feat: FilterPage — reorder filters, add team member filter"
```

---

### Task 4.2: 前端 TransactionList — 卡片成员标注 + 头像 + 备注 + 他人置灰

**Files:**
- Modify: `src/views/TransactionList.vue`

- [ ] **Step 1: 用 useMemberInfo 替换 getUserDisplayName**

`src/views/TransactionList.vue` 顶部 import 区，删除：

```typescript
import { getMemberAliases, getCurrentUserId } from "@/db/userDb";
import type { MemberAliasRow } from "@/db/userDb";
```

改为：

```typescript
import { getCurrentUserId } from "@/db/userDb";
import { useMemberInfo } from "@/composables/useMemberInfo";
import MemberAvatar from "@/components/MemberAvatar.vue";
import { fetchTeamMembers } from "@/services/api";
import { upsertTeamMembers, getTeamMembers } from "@/db/userDb";
```

删除 `const memberAliases = ref<MemberAliasRow[]>([])` 和整个 `getUserDisplayName` 函数。加：

```typescript
const { getMember } = useMemberInfo();
const memberDisplay = ref<Record<string, string>>({});

async function loadMemberDisplay(userIds: string[]) {
  const unique = [...new Set(userIds)];
  for (const uid of unique) {
    if (!memberDisplay.value[uid]) {
      const info = await getMember(uid);
      memberDisplay.value[uid] = info.displayName;
    }
  }
}
```

- [ ] **Step 2: onMounted / watch 中拉取成员缓存**

onMounted 中删除原 `if (isTeamLedger.value) { memberAliases.value = await getMemberAliases(); }`，替换为：

```typescript
  // 团队账本：拉取成员缓存供头像/别名展示
  if (isTeamLedger.value && ledgerStore.currentLedger?.team_id) {
    const teamId = ledgerStore.currentLedger.team_id;
    try {
      const members = await fetchTeamMembers(teamId);
      await upsertTeamMembers(teamId, members);
    } catch (e) {
      console.warn("[TransactionList] fetchTeamMembers failed:", e);
    }
  }
```

`fetchAll` 之后加 `await loadMemberDisplay(transactionStore.transactions.map(t => t.user_id));`。

watch `currentLedgerId` 块里删除 `memberAliases.value = await getMemberAliases();`，替换为同样的 fetchTeamMembers 块（封装成函数避免重复）。在 script 加 helper：

```typescript
async function refreshTeamMembers() {
  if (isTeamLedger.value && ledgerStore.currentLedger?.team_id) {
    const teamId = ledgerStore.currentLedger.team_id;
    try {
      const members = await fetchTeamMembers(teamId);
      await upsertTeamMembers(teamId, members);
    } catch (e) {
      console.warn("[TransactionList] fetchTeamMembers failed:", e);
    }
  }
  memberDisplay.value = {};
}
```

onMounted 与 watch 里都调 `await refreshTeamMembers()`。syncVersion watch 末尾也加 `await loadMemberDisplay(transactionStore.transactions.map(t => t.user_id));`。

- [ ] **Step 3: 他人流水 isTxOwner computed**

在 script 加：

```typescript
const currentUserId = computed(() => authStore.currentLocalUser?.server_user_id || getCurrentUserId() || "");

function isTxOwner(tx: Transaction): boolean {
  return tx.user_id === currentUserId.value;
}
```

- [ ] **Step 4: template — 卡片置灰 + 头像 + 别名 + 备注**

修改流水 item 的 `<button>`（509-552 行）。把 class 加条件置灰，金额不高亮，加头像，加备注。

把 `<button>` 改为：

```html
            <button
              v-for="tx in group.transactions"
              :key="tx.id"
              class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors"
              :class="isMultiSelectMode ? 'hover:bg-gray-50'
                : (isTeamLedger && !isTxOwner(tx)) ? 'opacity-60'
                : 'hover:bg-gray-50'"
              @click="isMultiSelectMode ? toggleTxSelection(tx.id) : onTxClick(tx)"
            >
```

正常模式图标后加头像（团队账本且非自己时）—— 在 `<span v-else class="text-xl">{{ getTxIcon(tx) }}</span>` 之后插入：

```html
              <MemberAvatar
                v-else-if="isTeamLedger && !isTxOwner(tx)"
                :user-id="tx.user_id"
                :size="20"
              />
              <span v-else class="text-xl">{{ getTxIcon(tx) }}</span>
```

（注：原 `<span v-else class="text-xl">{{ getTxIcon(tx) }}</span>` 的 v-else 要改为 v-else-if 兼容新分支，上面已用 `v-else-if` + 第二个 `v-else` 表达：转账/自己的仍用图标，他人团队账本用头像。但 `v-if="isMultiSelectMode"` 是第一个分支，需要重组。实际改为：保留多选模式分支，正常模式下用 `v-if="isTeamLedger && !isTxOwner(tx)"` 头像 else 图标。完整片段：）

```html
              <template v-if="isMultiSelectMode">
                <CheckCircle
                  v-if="selectedTxIds.has(tx.id)"
                  :size="20"
                  class="text-primary"
                />
                <Circle
                  v-else
                  :size="20"
                  class="text-gray-300"
                />
              </template>
              <MemberAvatar
                v-else-if="isTeamLedger && !isTxOwner(tx)"
                :user-id="tx.user_id"
                :size="20"
              />
              <span v-else class="text-xl">{{ getTxIcon(tx) }}</span>
```

成员归属行（533-535）改为用 memberDisplay + 头像已有，保留文字：

```html
                <p v-if="isTeamLedger && tx.user_id" class="text-[10px] text-text-secondary">
                  👤 {{ memberDisplay[tx.user_id] ?? tx.user_id.slice(0,8) }}
                </p>
```

标签块之后加备注：

```html
                <p v-if="tx.note" class="mt-0.5 text-[11px] text-text-secondary truncate">
                  📝 {{ tx.note }}
                </p>
```

金额不高亮（他人）：把金额 span 的 class 改为条件：

```html
              <span
                class="shrink-0 text-sm font-semibold"
                :class="(isTeamLedger && !isTxOwner(tx))
                  ? 'text-text-secondary'
                  : (tx.type === 'expense' ? 'text-expense' : tx.type === 'income' ? 'text-income' : 'text-text')"
              >
                {{ formatAmount(tx) }}
              </span>
```

- [ ] **Step 5: onTxClick — 他人不可点**

加函数（替代直接 `goRecord(tx.id)`）：

```typescript
function onTxClick(tx: Transaction) {
  if (isTeamLedger.value && !isTxOwner(tx)) {
    // 他人记录，不可编辑：不做任何跳转
    return;
  }
  goRecord(tx.id);
}
```

template 里 `@click="isMultiSelectMode ? toggleTxSelection(tx.id) : onTxClick(tx)"`（Step 4 已改）。

- [ ] **Step 6: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "TransactionList.vue"`
Expected: 无错

- [ ] **Step 7: 启动验证**

`npm run dev` → 团队账本：他人流水卡片置灰、有头像、有别名、有备注、点击无反应；自己流水正常。

- [ ] **Step 8: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: TransactionList — member avatar/alias, note, dim non-owner tx"
```

---

### Task 4.3: 前端 AccountPickerSheet — 用 useMemberInfo 显示归属

**Files:**
- Modify: `src/components/AccountPickerSheet.vue`

- [ ] **Step 1: 替换 ownerLabel**

修改 `src/components/AccountPickerSheet.vue`。删除 `ownerLabel` 函数。import 改：

```typescript
import { computed } from "vue";
import { X, Plus } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import { useLedgerStore } from "@/stores/ledger";
import { useMemberInfo } from "@/composables/useMemberInfo";
import type { Account } from "@/types";
```

删 `useAuthStore`、`getCurrentUserId` import。加：

```typescript
const { getMember } = useMemberInfo();
const ownerNames = ref<Record<string, string>>({});

async function loadOwnerName(ownerId: string) {
  if (!ownerNames.value[ownerId]) {
    const info = await getMember(ownerId);
    ownerNames.value[ownerId] = info.displayName;
  }
}
```

加 `ref` import。`availableAccounts` 用 watch 触发加载 —— 简化用 computed + onMounted。加：

```typescript
import { ref, watch } from "vue";

watch(availableAccounts, (accs) => {
  for (const a of accs) {
    if (a.owner_id) loadOwnerName(a.owner_id);
  }
}, { immediate: true });
```

- [ ] **Step 2: template 用 ownerNames**

把 `({{ ownerLabel(acc.owner_id) }})` 改为：

```html
            <span v-if="isTeamLedger && acc.owner_id" class="text-[10px] text-text-secondary">
              ({{ ownerNames[acc.owner_id] ?? acc.owner_id.slice(0,8) }})
            </span>
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "AccountPickerSheet.vue"`
Expected: 无错

- [ ] **Step 4: Commit**

```bash
git add src/components/AccountPickerSheet.vue
git commit -m "feat: AccountPickerSheet — member alias for owner"
```

---

### Task 4.4: 前端 AccountCard — 团队账本显示归属

**Files:**
- Modify: `src/components/AccountCard.vue`

- [ ] **Step 1: 加归属显示**

修改 `src/components/AccountCard.vue`。import 加：

```typescript
import { computed, ref, watch } from "vue";
import { useLedgerStore } from "@/stores/ledger";
import { useMemberInfo } from "@/composables/useMemberInfo";

const ledgerStore = useLedgerStore();
const { getMember } = useMemberInfo();
const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
const ownerName = ref("");

watch(() => props.account.owner_id, async (oid) => {
  if (oid && isTeamLedger.value) {
    const info = await getMember(oid);
    ownerName.value = info.displayName;
  } else {
    ownerName.value = "";
  }
}, { immediate: true });
```

- [ ] **Step 2: template 加归属**

在名称行后加归属（`<p class="text-xs text-text-secondary">{{ typeLabel }}</p>` 之后）：

```html
      <p v-if="isTeamLedger && ownerName" class="text-[10px] text-text-secondary">
        {{ ownerName }}
      </p>
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "AccountCard.vue"`
Expected: 无错

- [ ] **Step 4: Commit**

```bash
git add src/components/AccountCard.vue
git commit -m "feat: AccountCard — show owner in team ledger"
```

---

## Phase 5: 权限交互

### Task 5.1: 前端 TransactionList 账户详情模式 — 他人账户隐藏编辑按钮与 FAB

**Files:**
- Modify: `src/views/TransactionList.vue`

- [ ] **Step 1: 加 isAccountOwner computed**

在 `src/views/TransactionList.vue` script 加：

```typescript
const isAccountOwner = computed(() => {
  if (!isAccountMode.value || !currentAccount.value) return true;
  return currentAccount.value.owner_id === currentUserId.value;
});
```

（`currentUserId`、`currentAccount`、`isAccountMode` 已存在）

- [ ] **Step 2: template 隐藏 Pencil 按钮**

修改账户详情模式 header 的正常模式块（383-388 行），把 Pencil 按钮加 `v-if="isAccountOwner"`：

```html
        <template v-else>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="enterMultiSelectMode"
          >
            <ListChecks :size="18" class="text-text-secondary" />
          </button>
          <button
            v-if="isAccountOwner"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="router.push(`/accounts/${accountId}/edit`)"
          >
            <Pencil :size="18" class="text-text-secondary" />
          </button>
        </template>
```

- [ ] **Step 3: template 隐藏 FAB**

修改 FAB（559-566 行）加 `v-if`：

```html
    <router-link
      v-if="!isMultiSelectMode && isAccountOwner"
      :to="isAccountMode ? `/record?account=${accountId}` : '/record'"
      class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
      style="top: 75%"
    >
      <Plus :size="28" />
    </router-link>
```

注：首页模式 `isAccountMode` 为 false，`isAccountOwner` 为 true（`currentAccount` 为 null 时返回 true），FAB 正常显示。账户详情模式且他人账户时隐藏。

- [ ] **Step 4: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "TransactionList.vue"`
Expected: 无错

- [ ] **Step 5: 启动验证**

`npm run dev` → 团队账本进入他人账户详情 → 右上角无编辑铅笔、无浮动 +。自己账户正常。

- [ ] **Step 6: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: hide account edit button & FAB for non-owner in team ledger"
```

---

### Task 5.2: 前端 RecordPage + AccountPickerSheet — 团队账本只选自己账户

**Files:**
- Modify: `src/views/RecordPage.vue:67-69`
- Modify: `src/components/AccountPickerSheet.vue:35-37`

- [ ] **Step 1: RecordPage availableAccounts 过滤**

修改 `src/views/RecordPage.vue` 的 `availableAccounts`：

```typescript
const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
const currentUserId = computed(() => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "");

const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => {
    if (a.is_deleted) return false;
    if (isTeamLedger.value && a.owner_id !== currentUserId.value) return false;
    return true;
  })
);
```

- [ ] **Step 2: AccountPickerSheet availableAccounts 过滤**

修改 `src/components/AccountPickerSheet.vue` 的 `availableAccounts`：

```typescript
const currentUserId = computed(() => {
  // useMemberInfo 已有，但 owner_id 比较用 server_user_id
  // ponytail: 直接拿 currentUserId via auth
  return useAuthStore().currentLocalUser?.server_user_id || "";
});
```

实际 AccountPickerSheet 已删 useAuthStore import（Task 4.3）。重新加回：

```typescript
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";

const auth = useAuthStore();
const currentUserId = computed(() => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "");

const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => {
    if (a.is_deleted) return false;
    if (isTeamLedger.value && a.owner_id !== currentUserId.value) return false;
    return true;
  })
);
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep -E "RecordPage.vue|AccountPickerSheet.vue"`
Expected: 无错

- [ ] **Step 4: 启动验证**

`npm run dev` → 团队账本记账 → 支出/收入/转账账户选择器只列自己账户。个人账本列全部。

- [ ] **Step 5: Commit**

```bash
git add src/views/RecordPage.vue src/components/AccountPickerSheet.vue
git commit -m "feat: restrict account picker to own accounts in team ledger"
```

---

## Phase 6: 入口流程

### Task 6.1: 前端 CreateTeamPage — 修复创建后切换账本

**Files:**
- Modify: `src/views/CreateTeamPage.vue`

- [ ] **Step 1: performSync 后显式切换账本**

修改 `src/views/CreateTeamPage.vue` 的 `handleCreate`，`await performSync()` 之后加显式切换：

```typescript
  if (res.data?.shared_ledger) {
    await ledgerStore.addLedger(res.data.shared_ledger);
  }
  await performSync();
  // performSync 拉回远程 ledgers 后 store 可能把 currentLedgerId 重置回 rows[0]，
  // 这里显式切回新团队账本，确保用户落地在新建账本
  if (res.data?.shared_ledger) {
    ledgerStore.setCurrentLedger(res.data.shared_ledger.id);
  }
  createdCode.value = inviteRes.data!.invite_code;
```

- [ ] **Step 2: 验证**

`npm run dev` → 创建团队 → 完成后回首页 → 顶部账本名应为新建团队账本。

- [ ] **Step 3: Commit**

```bash
git add src/views/CreateTeamPage.vue
git commit -m "fix: switch to new team ledger after creation"
```

---

### Task 6.2: 前端 ProfilePage — 头像上传 UI

**Files:**
- Modify: `src/views/ProfilePage.vue`

- [ ] **Step 1: 加上传逻辑**

修改 `src/views/ProfilePage.vue` script。import 加：

```typescript
import { ref, computed } from "vue";
import * as api from "@/services/api";

const fileInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);

function triggerUpload() {
  fileInput.value?.click();
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const updated = await api.uploadAvatar(file);
    selectedEmoji.value = updated.avatar_url || "";
    // 在线模式直接更新 onlineUser；本地模式由 auth.updateProfile 处理本地
    await auth.updateProfile({ avatar_url: updated.avatar_url });
  } catch (e) {
    console.error("Upload avatar failed:", e);
  } finally {
    uploading.value = false;
    input.value = "";
  }
}
```

- [ ] **Step 2: template 加上传按钮 + 隐藏 input**

在「头像」label 之后、emoji grid 之前加：

```html
      <label class="mb-2 block text-sm font-medium text-text">头像</label>
      <div class="mb-3">
        <button
          type="button"
          :disabled="uploading"
          class="rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text-secondary hover:border-primary hover:text-primary disabled:opacity-50"
          @click="triggerUpload"
        >
          {{ uploading ? '上传中...' : '📷 上传图片头像' }}
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="hidden"
          @change="onFileChange"
        />
        <p class="mt-1 text-xs text-text-secondary">或选择下方 emoji：</p>
      </div>
      <div class="mb-6 flex flex-wrap gap-2">
```

（原 emoji grid 的 `<div class="mb-6 flex flex-wrap gap-2">` 已在上面，合并即可）

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep "ProfilePage.vue"`
Expected: 无错

- [ ] **Step 4: 启动验证**

`npm run dev` → 个人信息页 → 上传图片 → 头像显示为图片；emoji 仍可选。

- [ ] **Step 5: Commit**

```bash
git add src/views/ProfilePage.vue
git commit -m "feat: ProfilePage avatar upload UI"
```

---

### Task 6.3: 前端 TeamMembersPage 成员管理页 + 路由

**Files:**
- Create: `src/views/TeamMembersPage.vue`
- Modify: `src/router/index.ts`

- [ ] **Step 1: 创建页面**

`src/views/TeamMembersPage.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import AppHeader from "@/components/AppHeader.vue";
import MemberAvatar from "@/components/MemberAvatar.vue";
import { useLedgerStore } from "@/stores/ledger";
import { fetchTeamMembers } from "@/services/api";
import { upsertTeamMembers, getTeamMembers, setMemberAlias, getMemberAlias } from "@/db/userDb";
import { enqueueSync } from "@/services/sync";
import type { TeamMemberRow } from "@/db/userDb";

const ledgerStore = useLedgerStore();
const teamLedgers = computed(() => ledgerStore.ledgers.filter((l) => l.type === "team"));
const selectedLedgerId = ref<string>("");
const members = ref<TeamMemberRow[]>([]);
const loading = ref(false);

// 别名编辑
const editingUserId = ref<string | null>(null);
const editingAlias = ref("");

const selectedLedger = computed(() => ledgerStore.ledgers.find((l) => l.id === selectedLedgerId.value));
const selectedTeamId = computed(() => selectedLedger.value?.team_id ?? null);

async function loadMembers() {
  if (!selectedTeamId.value) return;
  loading.value = true;
  try {
    const teamId = selectedTeamId.value;
    const remote = await fetchTeamMembers(teamId);
    await upsertTeamMembers(teamId, remote);
    members.value = await getTeamMembers(teamId);
  } catch (e) {
    console.warn("[TeamMembersPage] load failed:", e);
    members.value = await getTeamMembers(selectedTeamId.value);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await ledgerStore.init();
  if (teamLedgers.value.length > 0) {
    // 默认选当前账本（若是团队账本）或第一个团队账本
    const current = ledgerStore.currentLedger;
    selectedLedgerId.value = (current?.type === "team" ? current.id : teamLedgers.value[0].id);
    await loadMembers();
  }
});

watch(selectedLedgerId, () => { loadMembers(); });

async function startEdit(userId: string) {
  const existing = await getMemberAlias(userId);
  editingUserId.value = userId;
  editingAlias.value = existing?.alias_name ?? "";
}

function cancelEdit() {
  editingUserId.value = null;
  editingAlias.value = "";
}

async function saveAlias() {
  if (!editingUserId.value) return;
  await setMemberAlias(editingUserId.value, editingAlias.value.trim());
  enqueueSync({ member_aliases: [] }); // 触发 sync，performSync 会全量带本地别名
  cancelEdit();
}

function goBack() {
  history.back();
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="成员管理" :show-back="true" @back="goBack" />

    <div class="flex-1 overflow-auto px-4 py-4">
      <!-- 团队账本切换 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">团队账本</label>
        <select
          v-model="selectedLedgerId"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        >
          <option v-for="l in teamLedgers" :key="l.id" :value="l.id">
            {{ l.name }}的账本
          </option>
        </select>
      </div>

      <p v-if="teamLedgers.length === 0" class="py-8 text-center text-sm text-text-secondary">
        还没有团队账本
      </p>

      <div v-else-if="loading" class="py-8 text-center text-text-secondary">加载中...</div>

      <!-- 成员列表 -->
      <div v-else class="space-y-2">
        <div
          v-for="m in members"
          :key="m.user_id"
          class="flex items-center gap-3 rounded-xl bg-surface p-3"
        >
          <MemberAvatar :user-id="m.user_id" :size="40" />
          <div class="flex-1">
            <p class="text-sm font-medium text-text">{{ m.nickname || m.username || m.user_id.slice(0,8) }}</p>
            <p class="text-xs text-text-secondary">
              {{ m.role === 'owner' ? '管理员' : '成员' }}
              <span v-if="m.username" class="ml-1">@{{ m.username }}</span>
            </p>
          </div>
          <!-- 别名编辑 -->
          <template v-if="editingUserId === m.user_id">
            <input
              v-model="editingAlias"
              type="text"
              maxlength="20"
              placeholder="别名"
              class="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <button class="text-sm text-primary" @click="saveAlias">保存</button>
            <button class="text-sm text-text-secondary" @click="cancelEdit">取消</button>
          </template>
          <template v-else>
            <button class="text-sm text-primary" @click="startEdit(m.user_id)">改别名</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 加路由**

修改 `src/router/index.ts`，在 `/teams/join` 路由之后加：

```typescript
    {
      path: "/teams/members",
      name: "team-members",
      component: () => import("@/views/TeamMembersPage.vue"),
      meta: { hideTab: true },
    },
```

- [ ] **Step 3: 类型检查**

Run: `npx vue-tsc --noEmit 2>&1 | grep -E "TeamMembersPage.vue|router/index.ts"`
Expected: 无错

- [ ] **Step 4: 启动验证**

`npm run dev` → 手动导航到 `/teams/members`（Task 6.4 加入口后可点） → 切换团队、看成员、改别名。

- [ ] **Step 5: Commit**

```bash
git add src/views/TeamMembersPage.vue src/router/index.ts
git commit -m "feat: TeamMembersPage — list members, edit alias"
```

---

### Task 6.4: 前端 MePage — 加成员管理入口

**Files:**
- Modify: `src/views/MePage.vue`

- [ ] **Step 1: 加入口**

修改 `src/views/MePage.vue` 的「团队管理」块，在「加入团队」按钮之后加「成员管理」按钮。import 加 `Users` 图标：

```typescript
import { ChevronRight, LogOut, Plus, UserPlus, Users } from "lucide-vue-next";
```

在「加入团队」button 之后加：

```html
          <button class="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3" @click="router.push('/teams/members')">
            <Users :size="18" class="text-primary" />
            <span class="flex-1 text-left text-text">成员管理</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
```

- [ ] **Step 2: 类型检查 + 启动验证**

Run: `npx vue-tsc --noEmit 2>&1 | grep "MePage.vue"`
Expected: 无错

`npm run dev` → 我的页 → 团队管理分组有「成员管理」→ 点击进入成员管理页。

- [ ] **Step 3: Commit**

```bash
git add src/views/MePage.vue
git commit -m "feat: MePage — add member management entry"
```

---

## 最终验证

```bash
# 前端
npm run build            # vue-tsc 类型检查 + Vite 构建
npm run test             # 前端单元测试

# 后端
cd backend && go test ./...
cd backend && go vet ./...
```

确认清单：
1. 筛选项顺序：账户→日期→分类→成员→标签；成员块仅团队账本出现
2. 流水记录可填备注、卡片展示备注
3. 创建团队后首页 currentLedger 为新团队账本
4. ProfilePage 可上传图片头像，emoji 仍可选
5. 团队账本 FilterPage 有成员筛选
6. 团队账本账户卡片/选择器标注归属成员
7. 流水/账户卡片成员头像用 MemberAvatar 渲染
8. 成员 displayName 为 别名>昵称>username，不出现 id 前 8 位（除非无缓存）
9. 团队账本他人流水卡片置灰不可点
10. 他人账户详情页隐藏编辑按钮与浮动添加按钮
11. 团队账本记账时支出/收入/转账账户选择器只列自己账户
12. MePage 有成员管理入口，页面可切换团队、查看成员、改别名
13. 多用户切机：切账号后 team_members / member_aliases 不串

## README 同步

每次 commit 涉及功能变化时，按 CLAUDE.md 约定同步更新 `README.md`，确保反映真实项目状态。最终验证阶段统一检查 README 是否覆盖新增的团队成员管理、头像上传、备注字段等功能。
