# 后端授权原语收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽 `canReadTeam`/`canReadLedger` 两个鉴权原语并强制在每个 team/sync 入口调用，封死「账本归属字段可被 sync 覆写」的越权洞。

**Architecture:** 新建 `authz.go` 收口两个包级原语与哨兵错误（`canReadTeam` 由 `ensureTeamMember` 改名而来，`canReadLedger` 为新增单账本 EXISTS 判定）；`lwwMergeLedger` 加 `userID` 参数，入口先 `canReadLedger` 自鉴权，再把 `owner_id`/`team_id` 从 INSERT/UPDATE 中剥离（INSERT 强制 owner=当前用户、team_id=NULL，UPDATE 完全不含归属字段）。

**Tech Stack:** Go 1.25、pgx/v5、testcontainers-go（集成测试）。

**Spec:** `docs/superpowers/specs/2026-08-14-auth-primitives-design.md`

## Global Constraints

- Go 版本 `1.25.0`。
- 仅改后端 `internal/service` 包，**不碰前端、`model`、`migrations`、handler**（`ErrNotTeamMember` 从 `team.go` 迁到 `authz.go` 后仍是 `service.ErrNotTeamMember`，handler 无需改）。
- 不引入 `canManageTeam`（`CreateInvite` 的 owner 检查已正确且是单处内联，保持不动）。
- 账本归属冻结后，`owner_id`/`team_id` 只能由服务端 `Register`/`CreateTeam` 设置，sync 不得修改。
- 集成测试打 `//go:build integration`；`go test ./...`（无 Docker）保持绿。
- 每个 Task 的 commit 中文描述，不加 Co-Authored-By。

---

### Task 1: `canReadLedger` 原语 + 单测

**Files:**
- Create: `backend/internal/service/authz.go`（只含 `canReadLedger` + `ErrNotLedgerMember`）
- Test: `backend/internal/service/authz_test.go`

**Interfaces:**
- Consumes: `dbQuerier`（已定义于 `sync.go`）、`fakeQuerier`/`fakeRow`（已定义于 `lwwmerge_test.go`）
- Produces: `func canReadLedger(ctx context.Context, q dbQuerier, userID, ledgerID string) error` 与 `var ErrNotLedgerMember` —— Task 3 的 `lwwMergeLedger` 依赖它。

- [ ] **Step 1: 写失败测试**

新建 `backend/internal/service/authz_test.go`：

```go
package service

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
)

func TestCanReadLedgerAllowsOwner(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{true}}}}
	if err := canReadLedger(context.Background(), fq, "user-1", "ledger-1"); err != nil {
		t.Fatalf("owner 应通过，got %v", err)
	}
}

func TestCanReadLedgerRejectsNonMember(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}}
	err := canReadLedger(context.Background(), fq, "user-1", "ledger-1")
	if !errors.Is(err, ErrNotLedgerMember) {
		t.Fatalf("非成员应返回 ErrNotLedgerMember，got %v", err)
	}
}

func TestCanReadLedgerPropagatesRealError(t *testing.T) {
	realErr := errors.New("connection reset by peer")
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{scanErr: realErr}}}
	err := canReadLedger(context.Background(), fq, "user-1", "ledger-1")
	if !errors.Is(err, realErr) {
		t.Fatalf("真实 DB 错误应透传，got %v", err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestCanReadLedger -v`
Expected: FAIL（`canReadLedger`/`ErrNotLedgerMember` 未定义）

- [ ] **Step 3: 实现 `authz.go`**

新建 `backend/internal/service/authz.go`：

```go
// backend/internal/service/authz.go
package service

import (
	"context"
	"errors"
	"fmt"
)

// ErrNotLedgerMember 表示调用者对该账本无访问权（越权防护）。
var ErrNotLedgerMember = errors.New("not a ledger member")

// canReadLedger 校验 userID 是否可访问账本：owner 或所在团队成员。
// 这是「owner 或 team 成员」授权规则的唯一单点表达；集合版见 SyncService.getUserLedgerIDs。
func canReadLedger(ctx context.Context, q dbQuerier, userID, ledgerID string) error {
	var ok bool
	err := q.QueryRow(ctx,
		`SELECT EXISTS(
			SELECT 1 FROM ledgers l
			WHERE l.id = $1 AND l.is_deleted = FALSE
			  AND (l.owner_id = $2 OR EXISTS(
				SELECT 1 FROM team_members tm
				WHERE tm.team_id = l.team_id AND tm.user_id = $2
			  ))
		)`,
		ledgerID, userID).Scan(&ok)
	if err != nil {
		return fmt.Errorf("check ledger access: %w", err)
	}
	if !ok {
		return ErrNotLedgerMember
	}
	return nil
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestCanReadLedger -v`
Expected: PASS（3/3）

- [ ] **Step 5: 编译 + Commit**

Run: `cd backend && go build ./...`
Expected: 通过

```bash
cd backend
git add internal/service/authz.go internal/service/authz_test.go
git commit -m "feat(authz): 抽 canReadLedger 单账本鉴权原语"
```

---

### Task 2: `ensureTeamMember` → `canReadTeam`（迁到 authz.go）

**Files:**
- Modify: `backend/internal/service/authz.go`（追加 `canReadTeam` + `ErrNotTeamMember`）
- Modify: `backend/internal/service/team.go:22,206-219,226`（删 `ErrNotTeamMember` + `ensureTeamMember`，`ListMembers` 改用 `canReadTeam`）
- Modify: `backend/internal/service/team_members_test.go`（两测试改调 `canReadTeam`）

**Interfaces:**
- Consumes: `dbQuerier`
- Produces: `func canReadTeam(ctx context.Context, q dbQuerier, userID, teamID string) error` 与 `var ErrNotTeamMember`

- [ ] **Step 1: 确认基线绿**

Run: `cd backend && go test ./internal/service/ -run TestEnsureTeamMember -v`
Expected: PASS（2 个现有测试）

- [ ] **Step 2: 追加 `canReadTeam` + `ErrNotTeamMember` 到 authz.go**

在 `authz.go` 的 `ErrNotLedgerMember` 之后追加：

```go
// ErrNotTeamMember 表示调用者不是该团队成员（越权防护）。
var ErrNotTeamMember = errors.New("not a team member")

// canReadTeam 校验 userID 是否属于 teamID，非成员返回 ErrNotTeamMember。
func canReadTeam(ctx context.Context, q dbQuerier, userID, teamID string) error {
	var ok bool
	err := q.QueryRow(ctx,
		"SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
		teamID, userID).Scan(&ok)
	if err != nil {
		return fmt.Errorf("check team membership: %w", err)
	}
	if !ok {
		return ErrNotTeamMember
	}
	return nil
}
```

- [ ] **Step 3: 从 team.go 删除旧实现与哨兵错误**

用 Edit 删除 `team.go` 的 `ensureTeamMember` 方法（含其上方注释）与 `ErrNotTeamMember` 行（在 var 块里）。

`team.go` 的 var 块从：

```go
var (
	// ErrNotTeamMember 表示调用者不是该团队成员（越权防护）。
	ErrNotTeamMember = errors.New("not a team member")
	ErrTeamNotFound  = errors.New("team not found")
	ErrNotTeamOwner  = errors.New("only team owner can create invite")
	ErrInviteInvalid = errors.New("invalid or expired invite code")
	ErrAlreadyMember = errors.New("already a member of this team")
)
```

改为：

```go
var (
	ErrTeamNotFound  = errors.New("team not found")
	ErrNotTeamOwner  = errors.New("only team owner can create invite")
	ErrInviteInvalid = errors.New("invalid or expired invite code")
	ErrAlreadyMember = errors.New("already a member of this team")
)
```

删除整个 `ensureTeamMember` 方法（`// ensureTeamMember ...` 注释到函数结束的 `}`）。

- [ ] **Step 4: `ListMembers` 改用 `canReadTeam`**

把 `team.go` 里 `ListMembers` 中的 `s.ensureTeamMember(ctx, s.pool, userID, teamID)` 改为 `canReadTeam(ctx, s.pool, userID, teamID)`。

- [ ] **Step 5: 更新 team_members_test.go**

把两个测试改调包级 `canReadTeam`（去掉 `s := &TeamService{}`）：

```go
func TestCanReadTeamRejectsNonMember(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}} // isMember=false

	err := canReadTeam(context.Background(), fq, "user-1", "team-1")
	if !errors.Is(err, ErrNotTeamMember) {
		t.Fatalf("非成员应返回 ErrNotTeamMember，got %v", err)
	}
}

func TestCanReadTeamAcceptsMember(t *testing.T) {
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{true}}}} // isMember=true

	if err := canReadTeam(context.Background(), fq, "user-1", "team-1"); err != nil {
		t.Fatalf("成员应通过校验，got %v", err)
	}
}
```

- [ ] **Step 6: 编译 + 跑测试**

Run: `cd backend && go build ./... && go test ./internal/service/ -run 'TestCanReadTeam|TestCanReadLedger' -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend
git add internal/service/authz.go internal/service/team.go internal/service/team_members_test.go
git commit -m "refactor(authz): ensureTeamMember 收口为包级 canReadTeam"
```

---

### Task 3: `lwwMergeLedger` 归属加固 + 自鉴权

**Files:**
- Modify: `backend/internal/service/sync.go:140-147,200-219`（账本循环 + `lwwMergeLedger`）
- Modify: `backend/internal/service/lwwmerge_test.go`（更新 `TestLwwMergeLedgerReturnsRealScanError` + 追加 3 个归属测试）

**Interfaces:**
- Consumes: `canReadLedger`/`ErrNotLedgerMember`（Task 1）、`mergeByKey`（已有）
- Produces: `lwwMergeLedger(ctx, tx dbQuerier, userID string, l model.Ledger) error`（新签名）

- [ ] **Step 1: 写失败测试（归属加固）**

在 `lwwmerge_test.go` 末尾追加 3 个测试（`strings` 已 import）：

```go
// 归属加固：UPDATE 不得含 owner_id/team_id。
func TestLwwMergeLedgerUpdateExcludesOwnership(t *testing.T) {
	s := &SyncService{}
	now := time.Now()
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}},                 // canReadLedger：有权限
		fakeRow{vals: []any{now.Add(-time.Hour)}},  // mergeByKey：已存在且更旧 → UPDATE
	}}

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", OwnerID: "attacker", UpdatedAt: now}

	if err := s.lwwMergeLedger(context.Background(), fq, "user-1", l); err != nil {
		t.Fatal(err)
	}
	if len(fq.execs) == 0 {
		t.Fatal("应执行 UPDATE")
	}
	upd := fq.execs[0]
	if !strings.Contains(upd.sql, "UPDATE ledgers") {
		t.Fatalf("首条应为 UPDATE，got %s", upd.sql)
	}
	if strings.Contains(upd.sql, "owner_id") || strings.Contains(upd.sql, "team_id") {
		t.Fatalf("UPDATE 不得含归属字段，got %s", upd.sql)
	}
}

// 归属加固：INSERT 强制 owner=userID、team_id=NULL（防御性，实际因 canReadLedger 拒绝不存在账本而不可达）。
func TestLwwMergeLedgerInsertForcesOwner(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}},       // canReadLedger：有权限
		fakeRow{scanErr: pgx.ErrNoRows},  // mergeByKey：不存在 → INSERT
	}}

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", OwnerID: "attacker", UpdatedAt: time.Now()}

	if err := s.lwwMergeLedger(context.Background(), fq, "user-1", l); err != nil {
		t.Fatal(err)
	}
	if len(fq.execs) == 0 {
		t.Fatal("应执行 INSERT")
	}
	ins := fq.execs[0]
	if !strings.Contains(ins.sql, "INSERT INTO ledgers") {
		t.Fatalf("首条应为 INSERT，got %s", ins.sql)
	}
	if len(ins.args) < 4 || ins.args[3] != "user-1" {
		t.Fatalf("owner_id 应强制为 user-1，got %v", ins.args)
	}
	if !strings.Contains(ins.sql, "NULL") {
		t.Fatalf("team_id 应为 NULL，got %s", ins.sql)
	}
}

// 无权限：canReadLedger 返回 ErrNotLedgerMember，merge 不执行。
func TestLwwMergeLedgerUnauthorized(t *testing.T) {
	s := &SyncService{}
	fq := &fakeQuerier{rows: []pgx.Row{fakeRow{vals: []any{false}}}} // canReadLedger：无权限

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", UpdatedAt: time.Now()}

	err := s.lwwMergeLedger(context.Background(), fq, "user-1", l)
	if !errors.Is(err, ErrNotLedgerMember) {
		t.Fatalf("无权限应返回 ErrNotLedgerMember，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("无权限不应执行任何写，execs=%v", fq.execs)
	}
}
```

同时更新 `TestLwwMergeLedgerReturnsRealScanError`（`lwwMergeLedger` 现在先走 `canReadLedger`，且签名多了 `userID`）：

```go
func TestLwwMergeLedgerReturnsRealScanError(t *testing.T) {
	s := &SyncService{}
	realErr := errors.New("connection reset by peer")
	fq := &fakeQuerier{rows: []pgx.Row{
		fakeRow{vals: []any{true}},      // canReadLedger：有权限
		fakeRow{scanErr: realErr},       // mergeByKey：真实 DB 错误
	}}

	l := model.Ledger{ID: "L1", Name: "账本", Type: "personal", UpdatedAt: time.Now()}

	err := s.lwwMergeLedger(context.Background(), fq, "user-1", l)
	if !errors.Is(err, realErr) {
		t.Fatalf("应透传真实 DB 错误，got %v", err)
	}
	if len(fq.execs) != 0 {
		t.Fatalf("真实错误不应触发 INSERT，但执行了 %d 次 Exec", len(fq.execs))
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd backend && go test ./internal/service/ -run 'TestLwwMergeLedger' -v`
Expected: FAIL（编译错——`lwwMergeLedger` 签名缺 `userID` 参数）

- [ ] **Step 3: 实现 `lwwMergeLedger` 归属加固 + 自鉴权**

把 `sync.go` 的 `lwwMergeLedger`（`sync.go:200-219`）整体替换为：

```go
func (s *SyncService) lwwMergeLedger(ctx context.Context, tx dbQuerier, userID string, l model.Ledger) error {
	if err := canReadLedger(ctx, tx, userID, l.ID); err != nil {
		return err // ErrNotLedgerMember 由调用方决定跳过还是失败
	}
	return mergeByKey(ctx, tx, l.UpdatedAt,
		"SELECT updated_at FROM ledgers WHERE id = $1", []any{l.ID},
		func() error {
			_, err := tx.Exec(ctx,
				`INSERT INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at, is_deleted)
				 VALUES ($1,$2,$3,$4,NULL,$5,$6,$7)`,
				l.ID, l.Name, l.Type, userID, l.CreatedAt, l.UpdatedAt, l.IsDeleted,
			)
			return err
		},
		func() error {
			_, err := tx.Exec(ctx,
				`UPDATE ledgers SET name=$1, type=$2, updated_at=$3, is_deleted=$4 WHERE id=$5`,
				l.Name, l.Type, l.UpdatedAt, l.IsDeleted, l.ID,
			)
			return err
		},
	)
}
```

- [ ] **Step 4: 改 `applyLocalChanges` 账本循环**

把 `sync.go` 的账本循环（`sync.go:140-147`）整体替换为：

```go
	// ledgers：lwwMergeLedger 内部 canReadLedger 自鉴权，无权限返回 ErrNotLedgerMember 跳过。
	for _, l := range changes.Ledgers {
		if err := s.lwwMergeLedger(ctx, tx, userID, l); err != nil {
			if errors.Is(err, ErrNotLedgerMember) {
				continue
			}
			return err
		}
	}
```

> 注：`errors` 已在 sync.go import（`mergeByKey` 用到），无需新增 import。

- [ ] **Step 5: 编译 + 跑测试**

Run: `cd backend && go build ./... && go vet ./... && go test ./internal/service/ -run 'TestLwwMerge' -v`
Expected: PASS（含更新的 `TestLwwMergeLedgerReturnsRealScanError` 与 3 个新归属测试）

- [ ] **Step 6: 全量单测确认绿**

Run: `cd backend && go test ./... -count=1`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd backend
git add internal/service/sync.go internal/service/lwwmerge_test.go
git commit -m "feat(sync): lwwMergeLedger 归属加固 + canReadLedger 自鉴权"
```

---

### Task 4: 集成用例 — 团队成员不能改账本归属

**Files:**
- Modify: `backend/internal/service/sync_integration_test.go`（追加 1 个 `TestIntegration_*`）

**Interfaces:**
- Consumes: `setupTestDB`/`seedUser`（Task 4 前已存在，见上一个计划）；`Sync`/`model`（sync.go/model 包）

- [ ] **Step 1: 追加集成用例**

在 `sync_integration_test.go` 末尾追加：

```go
func TestIntegration_MemberCannotChangeLedgerOwnership(t *testing.T) {
	pool := setupTestDB(t)
	s := &SyncService{pool: pool}
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Millisecond)

	ownerID := seedUser(t, pool, now)
	memberID := seedUser(t, pool, now)

	teamID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)`,
		teamID, "团队", ownerID, now, now); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{ownerID, memberID} {
		if _, err := pool.Exec(ctx,
			`INSERT INTO team_members (team_id, user_id, role, joined_at) VALUES ($1,$2,'member',$3)`,
			teamID, uid, now); err != nil {
			t.Fatal(err)
		}
	}
	ledgerID := uuid.New().String()
	if _, err := pool.Exec(ctx,
		`INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES ($1,$2,'team',$3,$4,$5,$6)`,
		ledgerID, "共享账本", teamID, ownerID, now, now); err != nil {
		t.Fatal(err)
	}

	// member 推送一条试图改归属的账本变更：owner_id 改成自己、team_id 改成另一个团队
	evilTeamID := uuid.New().String()
	evilLedger := model.Ledger{
		ID: ledgerID, Name: "被抢", Type: "personal",
		OwnerID: memberID, TeamID: &evilTeamID,
		CreatedAt: now, UpdatedAt: now.Add(time.Hour), IsDeleted: false,
	}
	if _, err := s.Sync(ctx, memberID, model.SyncRequest{
		LastSyncedAt: now.Add(-time.Hour),
		LocalChanges: model.SyncPayload{Ledgers: []model.Ledger{evilLedger}},
	}); err != nil {
		t.Fatal(err)
	}

	// 归属不得改变
	var gotOwner string
	var gotTeam *string
	if err := pool.QueryRow(ctx, "SELECT owner_id, team_id FROM ledgers WHERE id = $1", ledgerID).Scan(&gotOwner, &gotTeam); err != nil {
		t.Fatal(err)
	}
	if gotOwner != ownerID {
		t.Fatalf("owner_id 应保持 %s，got %s", ownerID, gotOwner)
	}
	if gotTeam == nil || *gotTeam != teamID {
		t.Fatalf("team_id 应保持 %s，got %v", teamID, gotTeam)
	}
}
```

- [ ] **Step 2: 跑集成测试**

Run: `cd backend && go test -tags integration ./internal/service/ -run TestIntegration -v -count=1`
Expected: PASS（全部 `TestIntegration_*`，含新增用例；Docker 需运行）

- [ ] **Step 3: 确认无 tag 时仍绿**

Run: `cd backend && go test ./... -count=1`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
cd backend
git add internal/service/sync_integration_test.go
git commit -m "test(sync): 集成用例——团队成员不能改账本归属"
```

---

### Task 5: 全量回归 + README 同步

**Files:**
- Modify: `README.md`（「安全 / 越权」段末尾追加一条）

- [ ] **Step 1: 全量回归（含 integration）**

Run: `cd backend && go build ./... && go vet ./... && go test ./... -count=1 && go test -tags integration ./internal/service/ -run TestIntegration -count=1`
Expected: 全部 PASS

- [ ] **Step 2: README 同步真实状态**

在 README「已知问题修复记录 → 安全 / 越权（2026-08-14 复盘修复）」清单末尾追加：

```markdown
- 授权原语收口：抽 `canReadTeam`/`canReadLedger` 两个鉴权原语（`authz.go`），`ListMembers` 与同步写路径强制调用；封死账本归属覆写——`lwwMergeLedger` 不再接受客户端 `owner_id`/`team_id`，归属只由服务端 Register/CreateTeam 决定。
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 同步 — 授权原语收口记录"
```

---

## Self-Review 记录

- **Spec 覆盖**：`canReadTeam`（§4.2）→ Task 2；`canReadLedger`（§4.1）→ Task 1；`lwwMergeLedger` 归属加固 + 自鉴权（§4.3/4.4）→ Task 3；集成用例（§6）→ Task 4；README（§9）→ Task 5。范围边界（不做 canManageTeam、归属只由服务端定）已入 Global Constraints。
- **占位符扫描**：无 TBD/TODO；所有代码块完整。
- **类型一致性**：`canReadLedger`/`ErrNotLedgerMember` 在 Task 1 定义、Task 3 调用一致；`canReadTeam`/`ErrNotTeamMember` 在 Task 2 定义、Task 2 测试与 `ListMembers` 一致；`lwwMergeLedger` 新签名 `(ctx, tx, userID, l)` 在 Task 3 定义、测试一致；`model.Ledger.TeamID *string` 与集成用例 `&evilTeamID` 一致。
