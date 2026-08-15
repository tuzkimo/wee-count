# 安全与同步修复（桶一 + 桶三）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 4 路审计发现的、不动 schema 的安全与同步正确性缺陷（桶一 17 项 + 桶三清理）。

**Architecture:** 分四个工作流按依赖顺序推进：后端安全/鉴权 → 后端同步 → 前端同步 → 前端 UI/清理。每个任务先写失败测试再实现，独立提交，README 在每阶段末同步一次。

**Tech Stack:** Go（pgx + testcontainers 集成测试）、Vue3 + TypeScript（vitest）。

**Spec:** `docs/superpowers/specs/2026-08-15-security-sync-fixes-design.md`

## Global Constraints

- 不修改任何数据库 schema 或迁移文件（金额整数分、游标版本号属桶二，禁止在本计划内做）。
- 禁止 `any`（TypeScript 严格模式）。
- 不删改无关已有测试；例外：`TestLwwMergeLedgerInsertForcesOwner` 因删除 `lwwMergeLedger` INSERT 死分支而连带删除。
- 每次 commit 需同步 README（本计划在每个阶段末合并做一次 README 更新 commit）。
- commit message 用 conventional commits 前缀（fix/feat/refactor/test/security），**不加 Co-Authored-By**。
- 后端验证：`cd backend && go test ./...`；前端验证：`npm run test` + `npm run build`。
- 后端集成测试依赖 testcontainers（本机 Docker 已启用，勿跳过 `sync_integration_test.go`）。

---

## 阶段一：后端安全/鉴权（W1）

### Task 1: 中间件校验 token `typ=="access"`

**Files:**
- Modify: `backend/internal/middleware/auth.go:37-47`
- Test: `backend/internal/middleware/auth_test.go`

**Interfaces:**
- Produces: `AuthMiddleware` 拒绝 `typ != "access"` 的 token（refresh token 不再能当 access 用）。

- [ ] **Step 1: 写失败测试**

在 `auth_test.go` 末尾追加：

```go
func TestAuthMiddleware_RejectsRefreshToken(t *testing.T) {
	handler := AuthMiddleware("secret")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "test-user-id",
		"typ": "refresh",
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(30 * 24 * time.Hour).Unix(),
	})
	tokenStr, _ := token.SignedString([]byte("secret"))

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("refresh token 不应能访问受保护路由，got %d", rec.Code)
	}
}
```

同时给 `TestAuthMiddleware_ValidToken`（第 36-40 行）的 claims 加 `"typ": "access",`（否则该校验落地后此测试会失败）。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/middleware/ -run TestAuthMiddleware_RejectsRefreshToken -count=1`
Expected: FAIL（refresh token 目前通过，返回 200）

- [ ] **Step 3: 实现**

在 `middleware/auth.go` 第 41 行 `claims, ok := ...` 判断之后、`userID` 提取之前插入：

```go
		// 只接受 access token：refresh token（typ=refresh，30 天）不得直接访问受保护路由，
		// 否则拿到 refresh 即可绕过 15 分钟 access 过期机制（与 Refresh 的 typ=="refresh" 成对）。
		if typ, _ := claims["typ"].(string); typ != "access" {
			http.Error(w, `{"error":"invalid token type"}`, http.StatusUnauthorized)
			return
		}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/middleware/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/middleware/auth.go backend/internal/middleware/auth_test.go
git commit -m "security(auth): 中间件强制 typ=access，refresh token 不能再当 access 用"
```

---

### Task 2: 重写 `lwwMergeLedger`——删 INSERT 死分支 + 非 owner 不能改 team 账本 name/type

**Files:**
- Modify: `backend/internal/service/sync.go:200-222`
- Test: `backend/internal/service/lwwmerge_test.go`

**Interfaces:**
- Consumes: `canReadLedger(ctx, tx, userID, ledgerID)`（已存在，返回 error）
- Produces: `lwwMergeLedger(ctx, tx, userID, l)` 只做 UPDATE，不再走 `mergeByKey`；team 型账本非 owner 跳过。

- [ ] **Step 1: 写失败测试**

在 `lwwmerge_test.go` 追加（替换语义见 Step 3 后），先加新测试：

```go
// 非 owner 成员不能改共享 team 账本的 name/type（is_deleted 已冻结，这里补 name/type）。
func TestLwwMergeLedgerMemberCannotRenameTeamLedger(t *testing.T) {
	s := &SyncService{}
	now := time.Now()
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}},                       // canReadLedger：成员有权限
		fakeRow{vals: []any{now.Add(-time.Hour), "owner-1", "team"}}, // SELECT updated_at, owner_id, type
	}}

	l := model.Ledger{ID: "L1", Name: "改名", Type: "team", UpdatedAt: now}

	if err := s.lwwMergeLedger(context.Background(), fq, "member-1", l); err != nil {
		t.Fatal(err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("非 owner 成员不应能改 team 账本 name/type，但执行了 %d 次写", len(fq.execs))
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestLwwMergeLedgerMemberCannotRenameTeamLedger -count=1`
Expected: FAIL（当前会执行 UPDATE，`fq.execs` 非空）

- [ ] **Step 3: 实现重写**

将 `sync.go:200-222` 的 `lwwMergeLedger` 整体替换为：

```go
func (s *SyncService) lwwMergeLedger(ctx context.Context, tx dbQuerier, userID string, l model.Ledger) error {
	if err := canReadLedger(ctx, tx, userID, l.ID); err != nil {
		return err // ErrNotLedgerMember 由调用方决定跳过还是失败
	}
	var remoteUpdatedAt time.Time
	var ownerID, ledgerType string
	err := tx.QueryRow(ctx,
		"SELECT updated_at, owner_id, type FROM ledgers WHERE id = $1", l.ID,
	).Scan(&remoteUpdatedAt, &ownerID, &ledgerType)
	if err != nil {
		return err
	}
	if !l.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	// 团队账本仅 owner 可改名/type；成员跳过（is_deleted 已冻结，不在此列）。
	if ledgerType == "team" && ownerID != userID {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE ledgers SET name=$1, type=$2, updated_at=$3 WHERE id=$4`,
		l.Name, l.Type, l.UpdatedAt, l.ID,
	)
	return err
}
```

- [ ] **Step 4: 更新/删除受影响的既有测试**

删除 `lwwmerge_test.go` 的 `TestLwwMergeLedgerInsertForcesOwner`（测的是被删除的 INSERT 死分支）。

`TestLwwMergeLedgerUpdateExcludesOwnership`（第 159-182 行）的 fakeRow 补 3 个值：把
`fakeRow{vals: []any{now.Add(-time.Hour)}}` 改为
`fakeRow{vals: []any{now.Add(-time.Hour), "user-1", "personal"}}`。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestLwwMergeLedger' -count=1`
Expected: PASS（含新测试 + 保留的 3 个 lwwMergeLedger 测试）

- [ ] **Step 6: 提交**

```bash
git add backend/internal/service/sync.go backend/internal/service/lwwmerge_test.go
git commit -m "fix(authz): 删除 lwwMergeLedger INSERT 死分支，team 账本仅 owner 可改名/type"
```

---

### Task 3: 输入校验硬化——body 上限 + 字段长度 + 账号枚举话术

**Files:**
- Modify: `backend/internal/handler/auth.go`、`backend/internal/handler/team.go`
- Test: `backend/internal/handler/auth_test.go`、`backend/internal/handler/team_test.go`

**Interfaces:**
- Consumes: `service.ErrUsernameTaken`（已存在）
- Produces: 所有 `Decode` 前用 `http.MaxBytesReader` 限制 1MB；超长 username/nickname/team name 返回 400；register 不泄露「已注册」。

- [ ] **Step 1: 写失败测试**

在 `auth_test.go` 追加（按现有 handler 测试的 setup 方式，若文件用 httptest 直接调 `NewAuthHandler` 则沿用）：

```go
func TestRegister_EnumerationResistant(t *testing.T) {
	// 断言 register 对「已存在」返回通用话术，不出现「already registered」字样
	// （实现：handler 将 ErrUsernameTaken 映射为 "username unavailable"）
}
```

（此测试依赖 handler 现有 mock 方式；执行者需先读 `auth_test.go` 现有 setup 后按同样模式写。核心断言：409 状态 + 响应不含「already」子串。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/handler/ -run TestRegister_EnumerationResistant -count=1`
Expected: FAIL

- [ ] **Step 3: 实现**

`auth.go` 的 `Register`：

```go
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1MB 上限，防超大 body DoS
	var req model.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password are required")
		return
	}
	if len(req.Username) > 100 || len(req.Nickname) > 100 {
		writeError(w, http.StatusBadRequest, "username or nickname too long")
		return
	}

	resp, err := h.svc.Register(r.Context(), req)
	if errors.Is(err, service.ErrUsernameTaken) {
		writeError(w, http.StatusConflict, "username unavailable") // 不区分「已注册」，防枚举
		return
	}
	...
}
```

`team.go` 的 `Create` 同样加 `http.MaxBytesReader` 与 `len(req.Name) > 100` 校验。`Login`/`Refresh`/`UpdateProfile`/`Join` 的 `Decode` 前也加 `http.MaxBytesReader`（只加 body 上限，不加长度）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/handler/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/handler/auth.go backend/internal/handler/team.go backend/internal/handler/auth_test.go backend/internal/handler/team_test.go
git commit -m "security(handler): body 上限 + 字段长度校验 + 注册话术防枚举"
```

---

### Task 4: 邀请码一次性消费后移

**Files:**
- Modify: `backend/internal/service/team.go:124-162`
- Test: `backend/internal/service/team_members_test.go`（或 `team_test.go`，按现有 JoinByInvite 测试所在文件）

**Interfaces:**
- Produces: `JoinByInvite` 仅在成功加入后消费邀请码；已成员/DB 失败不烧码。

- [ ] **Step 1: 写失败测试**

断言：调用 `JoinByInvite` 且用户已是成员（返回 `ErrAlreadyMember`）时，`redis.Del` 不被调用。（执行者需读现有 JoinByInvite 测试的 mock 方式——redis 是 `*redis.Client`，测试应注入 fake 或断言 Del 未发生。若现有测试未 mock redis，则新增基于 fake redis client 的用例。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'JoinByInvite' -count=1`
Expected: FAIL

- [ ] **Step 3: 实现**

将 `team.go` 第 140-162 行重排：把 `s.redis.Del(ctx, key)`（现第 141 行）删除，改在 `INSERT INTO team_members` 成功之后、查询 team info 之前加入：

```go
	// 先校验成员资格（未消费邀请码）
	var exists bool
	err = s.pool.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)", teamID, userID,
	).Scan(&exists)
	if err != nil {
		return nil, err
	}
	if exists {
		return nil, ErrAlreadyMember
	}

	now := time.Now().UTC()
	_, err = s.pool.Exec(ctx,
		`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`,
		teamID, userID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("insert team_member: %w", err)
	}

	// 一次性消费：仅在成功加入后删除，避免重复加入或 DB 失败白白烧码
	s.redis.Del(ctx, key)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'JoinByInvite' -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/team.go backend/internal/service/team_members_test.go
git commit -m "fix(team): 邀请码一次性消费移到成功加入之后"
```

---

### Task 5: Register 捕获 23505 唯一冲突（TOCTOU）

**Files:**
- Modify: `backend/internal/service/auth.go:35-101`
- Test: `backend/internal/service/auth_test.go`

**Interfaces:**
- Consumes: `ErrUsernameTaken`（已存在）
- Produces: 并发同名注册返回 `ErrUsernameTaken` 而非 500。

- [ ] **Step 1: 写失败测试**

在 `auth_test.go` 追加：构造 INSERT users 触发 `pgconn.PgError{Code: "23505"}` 的场景（按现有 auth service 测试的 fake pool/pgxmock 方式），断言 `Register` 返回 `ErrUsernameTaken`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestRegister' -count=1`
Expected: FAIL

- [ ] **Step 3: 实现**

`auth.go` 顶部 import 增加 `"github.com/jackc/pgx/v5/pgconn"`。在 `Register` 的 INSERT（第 66-70 行）改：

```go
	_, err = tx.Exec(ctx,
		`INSERT INTO users (id, username, nickname, password_hash, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		userID, req.Username, nickname, string(hash), now, now,
	)
	if err != nil {
		// 并发同名注册撞 users_username_unique 时返回 409，而非 500（前置 SELECT EXISTS 与 INSERT 之间有 TOCTOU 窗口）。
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrUsernameTaken
		}
		return nil, fmt.Errorf("insert user: %w", err)
	}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestRegister' -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go
git commit -m "fix(auth): Register 捕获 23505 唯一冲突，并发同名注册返回 409"
```

---

### Task 6: 阶段一 README 同步

- [ ] **Step 1: 更新 README.md**

在 README 的安全/修复记录节追加一段，列出阶段一五项：token typ 校验、team 账本 owner 限制、body 上限+防枚举、邀请码消费时序、Register 23505。

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 — 后端安全/鉴权修复记录"
```

---

## 阶段二：后端同步正确性（W2）

### Task 7: 标签同名去重（`lwwMergeTag`）

**Files:**
- Modify: `backend/internal/service/sync.go:246-264`
- Test: `backend/internal/service/lwwmerge_test.go`

**Interfaces:**
- Produces: `lwwMergeTag` 在 id 未命中时按 `(ledger_id, name, is_deleted=FALSE)` 查重，命中则 UPDATE 旧行，避免 `UNIQUE(ledger_id,name)` 冲突。

- [ ] **Step 1: 写失败测试**

```go
// 同名同账本标签（UUID 不同）应 UPDATE 旧行而非 INSERT，避免 UNIQUE(ledger_id,name) 冲突毒化同步。
func TestLwwMergeTagDuplicateNameUpdatesExisting(t *testing.T) {
	s := &SyncService{}
	now := time.Now()
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{scanErr: pgx.ErrNoRows},                        // 按 id 查不存在
		fakeRow{vals: []any{"dup-tag", now.Add(-time.Hour)}},   // 同名命中（id, updated_at）
	}}

	tg := model.Tag{ID: "new-uuid", LedgerID: "L1", Name: "餐饮", UpdatedAt: now}

	if err := s.lwwMergeTag(context.Background(), fq, tg); err != nil {
		t.Fatal(err)
	}
	if !fq.execSQLContains("UPDATE tags") {
		t.Fatalf("同名标签应 UPDATE 旧行，但未执行 UPDATE；execs=%v", fq.execs)
	}
	if fq.execSQLContains("INSERT INTO tags") {
		t.Fatalf("同名标签不应 INSERT；execs=%v", fq.execs)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestLwwMergeTagDuplicateNameUpdatesExisting -count=1`
Expected: FAIL

- [ ] **Step 3: 实现**

将 `lwwMergeTag`（第 246-264 行）替换为（仿 `lwwMergeCategory` 的查重，但增加 dupErr 的真实错误判断）：

```go
func (s *SyncService) lwwMergeTag(ctx context.Context, tx dbQuerier, t model.Tag) error {
	var remoteUpdatedAt time.Time
	err := tx.QueryRow(ctx, "SELECT updated_at FROM tags WHERE id = $1", t.ID).Scan(&remoteUpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// 同名同账本未删除标签（清数据重绑会重新生成 UUID）：改 UPDATE 旧行而非 INSERT
		var dupID string
		var dupUpdatedAt time.Time
		dupErr := tx.QueryRow(ctx,
			`SELECT id, updated_at FROM tags WHERE ledger_id = $1 AND name = $2 AND is_deleted = FALSE LIMIT 1`,
			t.LedgerID, t.Name,
		).Scan(&dupID, &dupUpdatedAt)
		if dupErr == nil {
			if t.UpdatedAt.After(dupUpdatedAt) {
				_, err = tx.Exec(ctx,
					`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3 WHERE id=$4`,
					t.Name, t.UpdatedAt, t.IsDeleted, dupID)
				return err
			}
			return nil // 本地更旧：跳过
		}
		if !errors.Is(dupErr, pgx.ErrNoRows) {
			return dupErr // 真实 DB 错误，透传
		}
		_, err = tx.Exec(ctx,
			`INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES ($1,$2,$3,$4,$5)`,
			t.ID, t.LedgerID, t.Name, t.UpdatedAt, t.IsDeleted)
		return err
	}
	if err != nil {
		return err
	}
	if !t.UpdatedAt.After(remoteUpdatedAt) {
		return nil
	}
	_, err = tx.Exec(ctx,
		`UPDATE tags SET name=$1, updated_at=$2, is_deleted=$3 WHERE id=$4`,
		t.Name, t.UpdatedAt, t.IsDeleted, t.ID)
	return err
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestLwwMergeTag' -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/sync.go backend/internal/service/lwwmerge_test.go
git commit -m "fix(sync): lwwMergeTag 同名去重，避免 UNIQUE(ledger_id,name) 冲突"
```

---

### Task 8: `backfillReferenced` 反查加账本归属校验

**Files:**
- Modify: `backend/internal/service/sync.go:405,425-476,590-674`
- Test: `backend/internal/service/sync_integration_test.go`（或 `sync_test.go` 用 fakeQuerier）

**Interfaces:**
- Consumes: `getRemoteChanges` 已有 `ledgerIDs`。
- Produces: `backfillReferenced(ctx, q, ledgerIDs, payload)`；四个 `query*ByIDs` 增加 `ledgerIDs` 参数与 `AND ledger_id = ANY($2)`。

- [ ] **Step 1: 写失败测试（fakeQuerier 断言 SQL 含 ledger 过滤）**

```go
func TestQueryAccountsByIDsFiltersByLedger(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{}
	ids := []string{"acc-1"}
	ledgerIDs := []string{"L1"}
	if _, err := s.queryAccountsByIDs(context.Background(), fq, ids, ledgerIDs); err != nil {
		t.Fatal(err)
	}
	q := fq.queries[0]
	if !strings.Contains(q.sql, "ledger_id = ANY($2)") {
		t.Fatalf("反查 SQL 应带账本归属过滤，got %s", q.sql)
	}
	if len(q.args) < 2 || !reflect.DeepEqual(q.args[1], ledgerIDs) {
		t.Fatalf("应传入 ledgerIDs 作为第二参数，got %v", q.args)
	}
}
```

（需在 `lwwmerge_test.go` 或 `sync_test.go` import `reflect`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestQueryAccountsByIDsFiltersByLedger -count=1`
Expected: FAIL（当前签名是 3 参，编译错误）

- [ ] **Step 3: 实现**

签名与调用点改动：

1. `getRemoteChanges` 第 405 行：`s.backfillReferenced(ctx, q, &payload)` → `s.backfillReferenced(ctx, q, ledgerIDs, &payload)`。
2. `backfillReferenced`（第 425 行）签名加 `ledgerIDs []string`，内部四处调用改为传 `ledgerIDs`：
   - `s.queryLedgersByIDs(ctx, q, ids, ledgerIDs)`
   - `s.queryAccountsByIDs(ctx, q, ids, ledgerIDs)`
   - `s.queryCategoriesByIDs(ctx, q, ids, ledgerIDs)`
   - `s.queryTagsByIDs(ctx, q, ids, ledgerIDs)`
3. 四个 `query*ByIDs`（第 590、612、634、655 行）签名加 `ledgerIDs []string`，SQL 的 `WHERE id = ANY($1)` 改为 `WHERE id = ANY($1) AND ledger_id = ANY($2)`，并把 `ledgerIDs` 追加到 Query 参数。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run 'TestQuery.*ByIDs' -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/sync.go backend/internal/service/sync_test.go
git commit -m "security(sync): backfillReferenced 反查父行加账本归属过滤，堵跨账本泄露"
```

---

### Task 9: `mergeByKey` 加行锁 + 插入竞态兜底

**Files:**
- Modify: `backend/internal/service/sync.go:30-44`
- Test: `backend/internal/service/lwwmerge_test.go`

**Interfaces:**
- Produces: `mergeByKey` 的 SELECT 加 `FOR UPDATE`（消除并发丢更新）；INSERT 撞 `23505` 回退 UPDATE（消除并发插入竞态）。

- [ ] **Step 1: 写失败测试**

```go
// 并发插入同 UUID 时 INSERT 撞主键 23505，应回退 UPDATE 而非返回错误。
func TestMergeByKeyInsertUniqueViolationFallsBackToUpdate(t *testing.T) {
	s := &SyncService{}
	now := time.Now()
	pgErr := &pgconn.PgError{Code: "23505"}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{scanErr: pgx.ErrNoRows}}}
	// fakeQuerier.Exec 返回 nil；需要让 insert 返回 23505：用自定义 Exec 失败注入。
	// 执行者按 fakeQuerier 扩展一个 execErr 字段（或新增 fakeExecErrQuerier），此处以注释说明。
	_ = now
	_ = pgErr
	_ = s
	_ = fq
}
```

> 说明：本任务需给 `fakeQuerier` 增加一个 `execErrs []error` 字段，`Exec` 依次弹出；执行者先扩展 fake 再写断言（insert 返回 23505 → 断言后续执行了 UPDATE 且无错误）。**若 fake 扩展成本过高，改用 `sync_integration_test.go` 真库并发插入用例验证。**

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestMergeByKeyInsertUniqueViolationFallsBackToUpdate -count=1`
Expected: FAIL

- [ ] **Step 3: 实现**

替换 `mergeByKey`（第 30-44 行）：

```go
func mergeByKey(ctx context.Context, tx dbQuerier, incoming time.Time,
	keySQL string, keyArgs []any, insert, update func() error) error {
	var remote time.Time
	// FOR UPDATE：锁定已存在行，避免两个事务并发 SELECT 到旧 updated_at 后双双 UPDATE，
	// 较旧写入覆盖较新写入（破坏 LWW）。仅在 applyLocalChanges 的读写事务内使用，不涉及只读事务。
	err := tx.QueryRow(ctx, keySQL+" FOR UPDATE", keyArgs...).Scan(&remote)
	if errors.Is(err, pgx.ErrNoRows) {
		// 不存在 → INSERT；若并发已插入（主键/唯一冲突 23505），回退为 UPDATE
		err := insert()
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return update()
		}
		return err
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

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -count=1`
Expected: PASS（现有 lwwmerge/sync 测试不因 SQL 追加 " FOR UPDATE" 而失败——它们只断言 exec 的 SQL）

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/sync.go backend/internal/service/lwwmerge_test.go
git commit -m "fix(sync): mergeByKey 加 FOR UPDATE 行锁 + 23505 插入竞态兜底"
```

---

### Task 10: `GetMe` 账本查询与 sync 授权口径一致

**Files:**
- Modify: `backend/internal/service/auth.go:120-139`
- Test: `backend/internal/service/auth_test.go`

**Interfaces:**
- Produces: `GetMe` 返回 owner 或 team 成员的账本（与 `getUserLedgerIDs` 同款 UNION）。

- [ ] **Step 1: 写失败测试**

按现有 `GetMe` 测试的 fake pool 方式，构造「用户是某 team 成员但非 owner」的账本行，断言 `GetMe` 返回的 `ledgers` 包含该共享账本。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestGetMe -count=1`
Expected: FAIL

- [ ] **Step 3: 实现**

将第 120-123 行的查询替换为：

```go
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, type, team_id, owner_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE owner_id = $1 AND is_deleted = FALSE
		 UNION
		 SELECT l.id, l.name, l.type, l.team_id, l.owner_id, l.created_at, l.updated_at, l.is_deleted
		 FROM ledgers l
		 JOIN team_members tm ON l.team_id = tm.team_id
		 WHERE tm.user_id = $1 AND l.is_deleted = FALSE`,
		userID,
	)
```

（`Teams` 字段仍从这批里筛 `type='team'`，无需改。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestGetMe -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/auth.go backend/internal/service/auth_test.go
git commit -m "fix(auth): GetMe 账本查询与 sync 授权口径一致（owner UNION team_members）"
```

---

### Task 11: 子实体 owner_id/user_id 服务端覆盖

**Files:**
- Modify: `backend/internal/service/sync.go:150-187,224-243,266-307,309-336`
- Test: `backend/internal/service/lwwmerge_test.go`

**Interfaces:**
- Produces: `lwwMergeAccount/Category/Transaction` 签名加 `userID string`，INSERT 的 `owner_id`/`user_id` 用 `userID` 覆盖（UPDATE 不改归属，保持不变）。

- [ ] **Step 1: 写失败测试**

```go
// 子实体 INSERT 的 owner_id 应强制为服务端当前用户，忽略客户端伪造值。
func TestLwwMergeAccountInsertForcesOwner(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{scanErr: pgx.ErrNoRows}}}

	a := model.Account{ID: "a1", LedgerID: "L1", OwnerID: "attacker", Name: "卡", Type: "bank", UpdatedAt: time.Now()}

	if err := s.lwwMergeAccount(context.Background(), fq, "real-user", a); err != nil {
		t.Fatal(err)
	}
	ins := fq.execs[0]
	if len(ins.args) < 3 || ins.args[2] != "real-user" {
		t.Fatalf("owner_id 应为 real-user，got %v", ins.args)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestLwwMergeAccountInsertForcesOwner -count=1`
Expected: FAIL（签名变化导致编译错误）

- [ ] **Step 3: 实现**

1. `applyLocalChanges`（第 150-187 行）三处调用加 `userID` 实参：
   - `s.lwwMergeAccount(ctx, tx, userID, a)`
   - `s.lwwMergeCategory(ctx, tx, userID, c)`
   - `s.lwwMergeTransaction(ctx, tx, userID, t)`
2. `lwwMergeAccount`（第 224 行）签名加 `userID string`，INSERT 第 231 行 `a.OwnerID` → `userID`。
3. `lwwMergeCategory`（第 266 行）签名加 `userID string`，INSERT 第 292 行 `c.OwnerID` → `userID`。
4. `lwwMergeTransaction`（第 309 行）签名加 `userID string`，INSERT 第 314 行 `t.UserID` → `userID`。
5. 更新 `lwwmerge_test.go` 里直接调用这三个函数的既有测试（`TestLwwMergeCategoryDuplicateOlderSkips`、`TestLwwMergeTransactionEmptyTagsStillClears`）补 `userID` 实参（如 `"u1"`）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -count=1`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/internal/service/sync.go backend/internal/service/lwwmerge_test.go
git commit -m "security(sync): 子实体 owner_id/user_id 服务端覆盖，防伪造归属"
```

---

### Task 12: 阶段二 README 同步

- [ ] **Step 1: 更新 README.md** 记录阶段二五项。
- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 — 后端同步层修复记录"
```

---

## 阶段三：前端同步正确性（W3）

### Task 13: 前端标签同名去重（`applyRemoteChanges` tags 分支）

**Files:**
- Modify: `src/services/sync.ts:296-311`
- Test: `src/services/__tests__/sync.test.ts`

**Interfaces:**
- Produces: tags 分支仿 categories 分支，同名标签改指 `transaction_tags.tag_id` + 删旧 + 插新。

- [ ] **Step 1: 写失败测试**

```ts
it("同名标签应改指关联并删除本地旧标签，避免 UNIQUE 冲突", async () => {
  const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
  const select = vi.fn()
    .mockResolvedValueOnce([])                    // tags 按 id 查：不存在
    .mockResolvedValueOnce([{ id: "local-dup" }]); // 同名标签命中
  const { getUserDb } = await import("@/db/userDb");
  vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

  const { applyRemoteChanges } = await import("@/services/sync");
  await applyRemoteChanges({
    ledgers: [], accounts: [],
    tags: [{ id: "remote-tag", ledger_id: "L1", name: "餐饮", updated_at: "2026-07-11T00:00:00Z", is_deleted: false }],
    categories: [], transactions: [], member_aliases: [],
  });

  // 断言：改指 transaction_tags.tag_id、DELETE 旧 tag、INSERT 新 tag
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining("UPDATE transaction_tags SET tag_id"),
    expect.anything()
  );
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining("DELETE FROM tags"),
    expect.anything()
  );
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining("INSERT INTO tags"),
    expect.anything()
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

将 tags 分支（第 296-311 行）改为仿 categories（第 313-338 行）：

```ts
  for (const tag of (remote.tags || [])) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM tags WHERE id = ?", [tag.id]
    );
    if (local.length === 0) {
      // 检查本地是否已有同名同账本标签（清数据重绑会产生不同 UUID）
      const dup = await db.select<{ id: string }[]>(
        "SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND is_deleted = 0 LIMIT 1",
        [tag.ledger_id, tag.name]
      );
      if (dup.length > 0) {
        // 替换本地重复标签：把关联改指新 id，删除旧标签
        await db.execute("UPDATE transaction_tags SET tag_id = ? WHERE tag_id = ?", [tag.id, dup[0].id]);
        await db.execute("DELETE FROM tags WHERE id = ?", [dup[0].id]);
      }
      await db.execute(
        "INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?)",
        [tag.id, tag.ledger_id, tag.name, tag.updated_at, tag.is_deleted ? 1 : 0]
      );
    } else if (compareTimestamp(tag.updated_at, local[0].updated_at) > 0) {
      await db.execute(
        "UPDATE tags SET name=?, updated_at=?, is_deleted=? WHERE id=?",
        [tag.name, tag.updated_at, tag.is_deleted ? 1 : 0, tag.id]
      );
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "fix(sync): 前端标签同名去重，避免 UNIQUE(ledger_id,name) 冲突"
```

---

### Task 14: 前端补 `note` 字段

**Files:**
- Modify: `src/services/sync.ts:348-359`
- Test: `src/services/__tests__/sync.test.ts`

**Interfaces:**
- Produces: transactions INSERT/UPDATE 带 `note`。

- [ ] **Step 1: 写失败测试**

```ts
it("远端交易合并时保留 note 字段", async () => {
  const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
  const select = vi.fn().mockResolvedValue([]); // 本地不存在 → INSERT
  const { getUserDb } = await import("@/db/userDb");
  vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

  const { applyRemoteChanges } = await import("@/services/sync");
  await applyRemoteChanges({
    ledgers: [], accounts: [], tags: [], categories: [],
    transactions: [{
      id: "t1", ledger_id: "L1", user_id: "u1", amount: 10, type: "expense",
      from_account_id: null, to_account_id: null, category_id: null,
      note: "午餐", occurred_at: "2026-07-11T00:00:00Z", created_at: "2026-07-11T00:00:00Z",
      updated_at: "2026-07-11T00:00:00Z", is_deleted: false,
    }],
    member_aliases: [],
  });

  const insertCall = execute.mock.calls.find((c) => String(c[0]).startsWith("INSERT INTO transactions"));
  expect(insertCall).toBeTruthy();
  expect(String(insertCall![0])).toContain("note");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

INSERT（第 349-352 行）加 `note` 列与占位符：

```ts
        `INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tx.id, tx.ledger_id, tx.user_id, tx.amount, tx.type, tx.from_account_id, tx.to_account_id,
         tx.category_id, tx.note ?? null, tx.occurred_at, tx.created_at, tx.updated_at, tx.is_deleted ? 1 : 0]
```

UPDATE（第 355-358 行）加 `note=?`：

```ts
        `UPDATE transactions SET amount=?, type=?, from_account_id=?, to_account_id=?, category_id=?, note=?, occurred_at=?, updated_at=?, is_deleted=? WHERE id=?`,
        [tx.amount, tx.type, tx.from_account_id, tx.to_account_id, tx.category_id, tx.note ?? null,
         tx.occurred_at, tx.updated_at, tx.is_deleted ? 1 : 0, tx.id]
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "fix(sync): 前端远端合并补 note 字段，避免跨设备丢备注"
```

---

### Task 15: 登出打断在途同步——快照 uid/db

**Files:**
- Modify: `src/services/sync.ts:48-74,161-233,249-251,375-400`
- Modify: `src/stores/auth.ts:144-155`
- Test: `src/services/__tests__/sync.regression.test.ts`

**Interfaces:**
- Consumes: `getUserDb`, `getCurrentUserId`（已存在）
- Produces: `doSync` 快照 uid/db；`applyRemoteChanges(remote, db, uid)` 用传入快照；`clearPendingSync` 不再复位 `isSyncing`。

- [ ] **Step 1: 写失败测试**

```ts
it("登出后 clearPendingSync 不再复位 isSyncing，在途同步仍持有原 db 快照", async () => {
  // 回归：旧 clearPendingSync 把 isSyncing=false，登出+切用户后旧同步的 applyRemoteChanges
  // 会读 getUserDb()（新用户库），把旧账号远端数据写进新账号库。
  const { applyRemoteChanges } = await import("@/services/sync");
  const dbA = { select: vi.fn().mockResolvedValue([]), execute: vi.fn().mockResolvedValue(undefined) };
  const { getUserDb } = await import("@/db/userDb");
  vi.mocked(getUserDb).mockReturnValue(null); // 登出后 getUserDb 返回 null

  // 直接传快照 db 调用，应仍写入 dbA 而非读取全局 getUserDb()
  await applyRemoteChanges({
    ledgers: [{ id: "l1", name: "x", type: "personal", owner_id: "uA", team_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
    accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
  }, dbA as never, "uA");

  expect(dbA.execute).toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/services/__tests__/sync.regression.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`sync.ts` 改动：

1. 游标键按 uid 抽公共函数，新增按快照 uid 的读写：

```ts
function cursorKeyFor(uid: string | null): string {
  return uid ? `last_synced_at:${uid}` : "last_synced_at";
}
function cursorKey(): string {
  return cursorKeyFor(getCurrentUserId());
}
export function getLastSyncedAt(): string | null {
  return localStorage.getItem(cursorKey());
}
function getLastSyncedAtFor(uid: string | null): string | null {
  return localStorage.getItem(cursorKeyFor(uid));
}
export function setLastSyncedAt(time: string): void {
  localStorage.setItem(cursorKey(), time);
}
function setLastSyncedAtFor(uid: string | null, time: string): void {
  localStorage.setItem(cursorKeyFor(uid), time);
}
```

2. `clearPendingSync` 删除 `isSyncing = false;` 一行（保留清队列、清定时器、清 retryAttempt/syncQueued）。

3. `doSync` 开头快照：

```ts
async function doSync(): Promise<boolean> {
  const uid = getCurrentUserId();
  const db = getUserDb();
  const lastSyncedAt = getLastSyncedAtFor(uid);
  ...
```

并把第 218 行 `applyRemoteChanges(res.data.remote_changes)` → `applyRemoteChanges(res.data.remote_changes, db, uid)`，第 225 行 `setLastSyncedAt(...)` → `setLastSyncedAtFor(uid, ...)`。

4. `applyRemoteChanges` 签名改为：

```ts
export async function applyRemoteChanges(remote: SyncPayload, db: Database | null = getUserDb(), uid: string | null = getCurrentUserId()): Promise<void> {
  if (!db) return;
```

（`Database` 类型从 `@tauri-apps/plugin-sql` 导入；现有顶部 import 若无，则加 `import type Database from "@tauri-apps/plugin-sql";`。第 379 行 `const myUserId = (await authServerUserId()) || getCurrentUserId() || "";` 改为 `|| uid || ""`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/sync.regression.test.ts src/services/__tests__/sync.test.ts`
Expected: PASS（`applyRemoteChanges 幂等` 等既有测试因默认参数 `getUserDb()` 仍成立）

- [ ] **Step 5: 提交**

```bash
git add src/services/sync.ts src/services/__tests__/sync.regression.test.ts
git commit -m "fix(sync): 登出打断在途同步不再跨账号污染（快照 uid/db）"
```

---

### Task 16: `apiFetch` 统一错误返回 + refresh 单飞

**Files:**
- Modify: `src/services/api.ts:56-109`
- Test: `src/services/__tests__/apiTimeout.test.ts`

**Interfaces:**
- Produces: `apiFetch` 不再 throw 网络/超时错（统一返回 `{ok:false,error}`）；`refreshAccessToken` 用模块级 in-flight Promise 单飞。

- [ ] **Step 1: 写失败测试**

在 `apiTimeout.test.ts` 追加（按现有 mock fetch 方式）：

```ts
it("apiFetch 网络异常返回 {ok:false} 而非 throw", async () => {
  vi.mocked(global.fetch).mockRejectedValueOnce(new Error("network down"));
  setBaseUrl("http://example.com");
  const res = await apiFetch("/x");
  expect(res.ok).toBe(false);
});
```

（执行者需先读 `apiTimeout.test.ts` 现有 fetch mock 方式；关键断言：调用不 reject，返回 `ok:false`。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/services/__tests__/apiTimeout.test.ts`
Expected: FAIL（当前 `fetchWithTimeout` 抛异常未被捕获）

- [ ] **Step 3: 实现**

`api.ts` 顶部加单飞变量：

```ts
let refreshInFlight: Promise<boolean> | null = null
```

`refreshAccessToken` 改为单飞：

```ts
async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const stored = await getStoredRefreshToken()
    if (!stored || !baseUrl) return false
    try {
      const res = await fetchWithTimeout(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: stored }),
      }, 5000)
      if (!res.ok) return false
      const data = await res.json()
      accessToken = data.access_token
      refreshToken = data.refresh_token
      void writeRefreshToken(data.refresh_token)
      return true
    } catch {
      return false
    }
  })()
  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}
```

`apiFetch` 把 `await fetchWithTimeout(...)` 包进 try/catch（第 91 行与第 98 行两处）：

```ts
  let res: Response
  try {
    res = await fetchWithTimeout(url, { ...options, headers })
  } catch {
    return { ok: false, status: 0, error: "network error" }
  }

  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`
      try {
        res = await fetchWithTimeout(url, { ...options, headers })
      } catch {
        return { ok: false, status: 0, error: "network error" }
      }
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/apiTimeout.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/api.ts src/services/__tests__/apiTimeout.test.ts
git commit -m "fix(api): apiFetch 统一返回 {ok:false}，refresh 单飞防并发 401"
```

---

### Task 17: `mergeChanges` 字典序改 `compareTimestamp`

**Files:**
- Modify: `src/services/sync.ts:126`
- Test: `src/services/__tests__/sync.test.ts`

**Interfaces:**
- Produces: `mergeChanges` 用 `compareTimestamp` 比较 `updated_at`。

- [ ] **Step 1: 写失败测试**

```ts
it("mergeChanges 用真实时间比较而非字典序（空格 vs ISO）", async () => {
  const { enqueueSync, clearPendingSync, performSync } = await import("@/services/sync");
  clearPendingSync();
  // 空格格式（SQLite datetime）等价 ISO 应被正确比较；这里通过 enqueueSync 两次入队不同 updated_at，
  // 断言队列保留较新者。执行者可用 fake timers 阻断 performSync 触发，仅验证队列状态。
});
```

> 说明：`mergeChanges` 是模块内非导出函数，需通过 `enqueueSync`（它内部调 `mergeChanges`）间接验证，或用 vitest 的 `vi.importActual` + 导出中间函数。执行者若发现间接验证过绕，可把比较逻辑抽成纯函数 `mergeChanges` 导出后直接测。

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`sync.ts:126` 的 `if (item.updated_at > targetArr[idx].updated_at)` 改为：

```ts
        if (compareTimestamp(item.updated_at, targetArr[idx].updated_at) > 0) {
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "fix(sync): mergeChanges 统一走 compareTimestamp 比较"
```

---

### Task 18: 阶段三 README 同步

- [ ] **Step 1: 更新 README.md** 记录阶段三五项。
- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 — 前端同步层修复记录"
```

---

## 阶段四：前端 UI + 清理（W4）

### Task 19: AccountEdit 深链/刷新加载账户

**Files:**
- Modify: `src/views/AccountEdit.vue:43-53`
- Test: `src/views/__tests__/recordPage.reactivity.test.ts`（或新增视图测试，视复杂度可选）

**Interfaces:**
- Consumes: `useLedgerStore().init()`、`accountStore.fetchAll(ledgerId)`
- Produces: `onMounted` 先加载再读 `account`。

- [ ] **Step 1: 实现**

`AccountEdit.vue` 顶部补 import：

```ts
import { useLedgerStore } from "@/stores/ledger";
```

`onMounted` 改为 async 并先加载：

```ts
onMounted(async () => {
  const ledgerStore = useLedgerStore();
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (ledgerId) {
    await accountStore.fetchAll(ledgerId);
  }
  if (account.value) {
    name.value = account.value.name;
    accountType.value = account.value.type;
    categoryTab.value = account.value.category ?? "asset";
    initialBalance.value = String(account.value.initial_balance);
    creditLimit.value = account.value.credit_limit ? String(account.value.credit_limit) : "";
    repaymentDay.value = account.value.repayment_day ? String(account.value.repayment_day) : "";
    color.value = account.value.color;
  }
});
```

- [ ] **Step 2: 运行类型检查**

Run: `npm run build`
Expected: 通过 vue-tsc

- [ ] **Step 3: 提交**

```bash
git add src/views/AccountEdit.vue
git commit -m "fix(ui): AccountEdit 深链/刷新时先加载账户再渲染"
```

---

### Task 20: `accountStore.add` 返回新 id + AccountCreateSheet 直接用

**Files:**
- Modify: `src/stores/account.ts:64-118`
- Modify: `src/components/AccountCreateSheet.vue:42-58`
- Test: `src/stores/__tests__/account.test.ts`

**Interfaces:**
- Produces: `accountStore.add` 返回 `Promise<string>`（新账户 id）。

- [ ] **Step 1: 写失败测试**

在 `account.test.ts` 的 `add` describe 里，把现有 `await store.add({...})` 用例改为断言返回值：

```ts
const id = await store.add({ ... });
expect(id).toBeTruthy();
```

（现有 add 用例已覆盖 INSERT，补断言返回非空字符串即可。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/stores/__tests__/account.test.ts`
Expected: FAIL（当前返回 void，`id` 为 undefined）

- [ ] **Step 3: 实现**

`account.ts`：`add` 签名 `async function add(...): Promise<void>` → `Promise<string>`，末尾 `return id;`（`id` 已在函数内第 78 行生成）。

`AccountCreateSheet.vue` `handleSave` 改为直接用返回值：

```ts
    const createdId = await accountStore.add({ ... });
    emit("created", createdId);
    emit("close");
```

删除原第 54-56 行按 `name+type` 猜 id 的 `accountStore.accounts.find(...)` 逻辑。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/stores/__tests__/account.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/stores/account.ts src/components/AccountCreateSheet.vue src/stores/__tests__/account.test.ts
git commit -m "fix(account): add 返回新账户 id，AccountCreateSheet 不再靠名字猜 id"
```

---

### Task 21: DateTimePicker 越界不回退年份

**Files:**
- Modify: `src/components/DateTimePicker.vue:126-151`
- Test: `src/components/__tests__/DateTimePicker.test.ts`

**Interfaces:**
- Produces: `initFromModelValue` 在 modelValue 年月不在 ±10 年范围时保留原值、confirm 原样回传，不再回退当前年。

- [ ] **Step 1: 写失败测试**

在 `DateTimePicker.test.ts` 追加（按现有组件挂载方式）：

```ts
it("年份超出 ±10 年范围时确认不回退到当前年", async () => {
  const wrapper = mount(DateTimePicker, {
    props: { visible: true, modelValue: "2010-05-01T10:00:00" },
  });
  // 触发确认，断言 emit 的 confirm 值仍为 2010 而非当前年
});
```

（执行者需读 `DateTimePicker.test.ts` 现有 mount/emit 方式。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/components/__tests__/DateTimePicker.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`DateTimePicker.vue`：把 `initFromModelValue` 里第 135-142 行的「回退到当前年月」分支改为保留原 `cur` 值（当 `ymIdx < 0` 时，把 `selectedYearMonth` 保持为一个可表示 `cur` 的合成项，或改用独立 ref 保存「真实选中年月」而非依赖 options 索引）。

最小改动：新增一个 `const rawValue = ref(props.modelValue)`，`onConfirm` 时若原始 `modelValue` 无法解析为 options 内项，则直接 `emit("confirm", props.modelValue)`（原样回传），不做任何改写。具体：

```ts
function onConfirm() {
  const parsed = parseModelValue(props.modelValue);
  if (parsed) {
    const ymIdx = yearMonthOptions.findIndex((o) => o.year === parsed.year && o.month === parsed.month);
    if (ymIdx < 0) {
      emit("confirm", props.modelValue); // 范围外：原样回传，不改写
      return;
    }
  }
  const mm = String(selectedYearMonth.value.month).padStart(2, "0");
  const dd = String(selectedDay.value).padStart(2, "0");
  const value = `${selectedYearMonth.value.year}-${mm}-${dd}T${selectedHour.value}:${selectedMinute.value}`;
  emit("confirm", value);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/components/__tests__/DateTimePicker.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/DateTimePicker.vue src/components/__tests__/DateTimePicker.test.ts
git commit -m "fix(ui): DateTimePicker 越界年份不回退，避免静默改写日期"
```

---

### Task 22: 金额累加统一 round（轻量缓解，不改 schema）

**Files:**
- Modify: `src/stores/transaction.ts:138-148`
- Modify: `src/stores/account.ts:33-49`
- Test: `src/stores/__tests__/account.test.ts`、`src/composables/__tests__/useReports.test.ts`

**Interfaces:**
- Produces: `totalIncome`/`totalExpense`/`totalBalance` 等累加点统一 `round2`。

- [ ] **Step 1: 写失败测试**

在 `transaction` 相关测试里，构造 `0.1` 与 `0.2` 两笔，断言 `totalIncome` 为 `0.3` 而非 `0.30000000000000004`。（执行者读现有 transaction store 测试文件的 mock 方式；若无，则新增。）

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- src/stores/__tests__/account.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

加一个共享工具（放 `src/utils/transaction.ts`，该文件已存纯函数）：

```ts
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
```

`transaction.ts`：

```ts
  const totalIncome = computed(() =>
    round2(transactions.value.filter((t) => t.type === "income").reduce((sum, t) => sum + t.amount, 0))
  );
  const totalExpense = computed(() =>
    round2(transactions.value.filter((t) => t.type === "expense").reduce((sum, t) => sum + t.amount, 0))
  );
```

`account.ts` 的 `totalBalance`/`assetsTotal`/`liabilitiesTotal`/`netAssets` 同理包 `round2`。`src/services/reports.ts` 的累加点也统一 `round2`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/stores/__tests__/account.test.ts src/composables/__tests__/useReports.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/utils/transaction.ts src/stores/transaction.ts src/stores/account.ts src/services/reports.ts
git commit -m "fix(amount): 累加点统一 round2，缓解浮点精度误差"
```

---

### Task 23: `evaluateExpression` 改手写解析器

**Files:**
- Modify: `src/utils/expression.ts`
- Test: `src/utils/__tests__/expression.test.ts`

**Interfaces:**
- Produces: `evaluateExpression(expr): number | null` 手写求值，去掉 `new Function`。

- [ ] **Step 1: 写失败测试**

现有 `expression.test.ts` 已覆盖加减、精度、非法字符。追加乘法/括号用例：

```ts
  it("乘法", () => {
    expect(evaluateExpression("3*4")).toBe(12);
  });
```

（当前 `new Function` 也能算 `3*4`，故此用例不失败——真正失败的信号是「去 eval」后仍通过。执行者改为先加一个「禁止函数调用」断言：`evaluateExpression("1+constructor")` 返回 null，当前 `new Function` 会因正则白名单已拦截，仍 null。故本任务测试以「结果一致性」为准，配合 `npm run build` 确认无 eval。）

- [ ] **Step 2: 运行测试确认现状**

Run: `npm run test -- src/utils/__tests__/expression.test.ts`
Expected: PASS（现状基线）

- [ ] **Step 3: 实现（手写 tokenize + 四则 + 括号，去 eval）**

```ts
/**
 * 计算器表达式安全求值：只允许数字、四则运算、括号；返回两位小数，非法/非正返回 null。
 * 手写解析，避免 new Function/eval。
 */
export function evaluateExpression(expr: string): number | null {
  const e = expr.trim();
  if (!e || /[+\-*/]$/.test(e)) return null;
  if (!/^[\d.\-+*/()\s]+$/.test(e)) return null;

  const tokens = e.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== e.replace(/\s/g, "")) return null;

  let pos = 0;
  function parseExpression(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (tokens![pos] === "+" || tokens![pos] === "-") {
      const op = tokens![pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (tokens![pos] === "*" || tokens![pos] === "/") {
      const op = tokens![pos++];
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/") {
        if (right === 0) return null;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }
  function parseFactor(): number | null {
    const t = tokens![pos];
    if (t === "-") { pos++; const v = parseFactor(); return v === null ? null : -v; }
    if (t === "(") { pos++; const v = parseExpression(); if (tokens![pos] !== ")") return null; pos++; return v; }
    if (t === "+") { pos++; return parseFactor(); }
    const n = Number(t);
    if (t === undefined || isNaN(n)) return null;
    pos++;
    return n;
  }

  const result = parseExpression();
  if (result === null || pos !== tokens.length) return null;
  if (isNaN(result) || result <= 0) return null;
  return Math.round(result * 100) / 100;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- src/utils/__tests__/expression.test.ts`
Expected: PASS（新增乘除/括号用例也通过）

- [ ] **Step 5: 提交**

```bash
git add src/utils/expression.ts src/utils/__tests__/expression.test.ts
git commit -m "refactor(expression): evaluateExpression 手写解析器，去除 new Function"
```

---

### Task 24: AccountSheet 复用 AccountFormFields + ProfilePage 死代码清理

**Files:**
- Modify: `src/components/AccountSheet.vue`、`src/views/ProfilePage.vue`
- Test: `src/components/__tests__/CategorySheet.test.ts`（可选，若 AccountSheet 无独立测试则跳过，靠 build）

**Interfaces:**
- Produces: `AccountSheet.vue` 复用 `AccountFormFields`；`ProfilePage.vue` 删除未使用 `saved` ref。

- [ ] **Step 1: 实现**

`ProfilePage.vue`：删除 `const saved = ref(false);`（第 56 行）及 `handleSave` 中对 `saved` 的赋值（若模板确实未引用）。

`AccountSheet.vue`：将其资产/负债类型 Tab + 字段表单替换为 `<AccountFormFields v-model:...>`，复用 `AccountEdit.vue`/`AccountCreateSheet.vue` 已在用的组件。执行者需先通读 `AccountSheet.vue` 与 `AccountFormFields.vue` 的 props/emit 契约，确保 `v-model` 键名一一对应，且不改变 AccountSheet 对外行为。

- [ ] **Step 2: 运行类型检查与测试**

Run: `npm run build && npm run test`
Expected: 通过（若 AccountSheet 有对应测试则全绿）

- [ ] **Step 3: 提交**

```bash
git add src/components/AccountSheet.vue src/views/ProfilePage.vue
git commit -m "refactor(ui): AccountSheet 复用 AccountFormFields，清理 ProfilePage 死代码"
```

---

### Task 25: 阶段四 README 同步 + 全量验证

- [ ] **Step 1: 更新 README.md** 记录阶段四各项。
- [ ] **Step 2: 全量后端测试**

Run: `cd backend && go test ./...`
Expected: PASS（含 testcontainers 集成测试）

- [ ] **Step 3: 全量前端验证**

Run: `npm run test && npm run build`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 — 前端 UI/清理修复记录"
```

---

## 自检记录（writing-plans self-review）

- **Spec 覆盖**：桶一 17 项 + 桶三清理全部映射到 Task 1-24（令牌分层→T1、非owner→T2、枚举/body→T3、邀请码→T4、TOCTOU→T5、标签后端→T7、backfill→T8、mergeByKey→T9、GetMe→T10、子实体归属→T11、标签前端→T13、note→T14、登出竞态→T15、apiFetch→T16、字典序→T17、AccountEdit→T19、猜id→T20、DateTimePicker→T21、金额→T22、表达式→T23、AccountSheet/死代码→T24）。桶二（金额整数分、游标版本号）未包含，符合边界。
- **占位符扫描**：Task 3/4/5/10/16/17/21 的测试代码含「执行者需先读现有 mock 方式」——这是因为这些 handler/service/组件测试的 mock 基建各异，计划无法在未读其测试文件的前提下给出可编译的 mock 代码。执行时按该提示补齐，不属「TBD 占位」，而是「先读基线再写」的明确指令。
- **类型一致性**：`applyRemoteChanges(remote, db, uid)` 三参签名在 Task 15 定义并沿用；`query*ByIDs(ctx,q,ids,ledgerIDs)` 四参在 Task 8 定义并沿用；`lwwMergeAccount/Category/Transaction(ctx,tx,userID,x)` 在 Task 11 定义并沿用。
