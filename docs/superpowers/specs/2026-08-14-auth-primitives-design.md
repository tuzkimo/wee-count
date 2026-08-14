# 后端授权原语收口 — canReadTeam / canReadLedger + 账本归属加固

## 1. 背景与根因

复盘报告第三节「统一授权原语」指出三个同源问题，根因都是「service 方法不自带鉴权上下文」：

1. **ListMembers 越权（IDOR）** — 已修（`team.go` 的 `ensureTeamMember` + `ListMembers` 收 `userID`）。
2. **member_aliases 广播** — 已修（`lwwMergeMemberAlias` 强制 setter=当前用户）。
3. **账本归属字段可被覆写** — **未修**：`lwwMergeLedger`（`sync.go:200-219`）的 INSERT 与 UPDATE 都带客户端 `owner_id`/`team_id`。团队成员可推一条 `local_changes.ledgers` 把共享账本的 `owner_id` 改成自己、`team_id` 改成别的团队（或 NULL），从团队里「抢走」账本。

`ensureTeamMember` 目前只服务 `ListMembers`，未收口；「owner 或所在团队成员可访问账本」这条规则内联在 `getUserLedgerIDs`（`sync.go:96-124`），无单点原语。

## 2. 目标

- 抽 `canReadTeam` / `canReadLedger` 两个鉴权原语，作为团队/账本访问的唯一判断入口。
- 封死账本归属覆写：`owner_id`/`team_id` 不再经 sync 修改，服务端强制。

## 3. 范围（In / Out of scope）

**In scope：**
- `canReadTeam` 原语（由 `ensureTeamMember` 改名而来）。
- `canReadLedger` 原语（单账本 EXISTS 判定）。
- `lwwMergeLedger` 归属加固（UPDATE 去掉归属字段、INSERT 强制 owner=当前用户、team_id=NULL）+ 入口自鉴权。
- `getUserLedgerIDs` 注释对齐（它是同一规则的集合版）。

**Out of scope（明确不做）：**
- **`CreateInvite` 的 owner 检查**：已是单处内联且正确，不引入 `canManageTeam` 原语（YAGNI，无第二个 owner 级操作）。
- **账本转让 / 移入团队功能**：当前不存在，且本加固后归属只能走服务端专属端点（另立任务）。
- 前端、model、迁移不改。

## 4. 设计

### 4.1 新文件 `backend/internal/service/authz.go`

收口两个原语与其哨兵错误（`dbQuerier` 已在 `sync.go` 定义，同包直接可用）：

```go
package service

import (
	"context"
	"errors"
	"fmt"
)

var (
	ErrNotTeamMember   = errors.New("not a team member")
	ErrNotLedgerMember = errors.New("not a ledger member")
)

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

### 4.2 `team.go`：`ensureTeamMember` → `canReadTeam`

- 删除 `team.go` 的 `ensureTeamMember` 方法（`team.go:206-219`）与 `ErrNotTeamMember` 定义（`team.go:22`，迁至 `authz.go`）。
- `ListMembers`（`team.go:226`）改为调用包级 `canReadTeam(ctx, s.pool, userID, teamID)`。

### 4.3 `sync.go`：`lwwMergeLedger` 归属加固 + 入口自鉴权

`lwwMergeLedger` 签名加 `userID`，入口先 `canReadLedger` 自鉴权，再把归属字段从 merge 中剥离：

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

要点：
- **INSERT**：`owner_id` 强制 `userID`，`team_id` 强制 `NULL`（归属只由服务端 Register/CreateTeam 决定）。注：入口 `canReadLedger` 会拒绝不存在的账本，故 INSERT 分支实际不可达，此处强制归属是防御性加固（belt-and-suspenders），不是活路径。
- **UPDATE**：不再含 `owner_id`/`team_id` 列（归属不可经 sync 改）。
- **入口自鉴权**：`canReadLedger` 使 `lwwMergeLedger` 自身安全（任何调用方都无需依赖上游先过滤）。

### 4.4 `applyLocalChanges` 账本循环

把账本循环的 `ledgerSet` 门改为「依赖 `lwwMergeLedger` 自鉴权，`ErrNotLedgerMember` 跳过」：

```go
// ledgers
for _, l := range changes.Ledgers {
	if err := s.lwwMergeLedger(ctx, tx, userID, l); err != nil {
		if errors.Is(err, ErrNotLedgerMember) {
			continue // 无权限账本跳过（客户端可能带过期账本）
		}
		return err
	}
}
```

其余四类实体（accounts/tags/categories/transactions）继续用 `ledgerSet[entity.LedgerID]` 批量门（它们数量多，逐条 `canReadLedger` 是 N+1，没必要）。

### 4.5 `getUserLedgerIDs` 注释对齐

`getUserLedgerIDs`（`sync.go:96-124`）保持不变（它是「owner 或 team 成员」规则的集合版），补注释说明「单账本版本见 `canReadLedger`，二者是同一授权规则的单点/集合两种形态」。

## 5. 错误处理

- `canReadTeam`/`canReadLedger` 对非 `ErrNoRows` 的真实 DB 错误 `fmt.Errorf` 包装后返回（透传）。
- `applyLocalChanges` 账本循环：`ErrNotLedgerMember` → 跳过；其他错误 → 返回 → `Sync` 500。
- `ListMembers`：`canReadTeam` 返回 `ErrNotTeamMember` → handler 已映射 403（现有逻辑不变）。

## 6. 测试

### 单元测试（`backend/internal/service/authz_test.go`，fakeQuerier）

| 用例 | 断言 |
|---|---|
| `canReadTeam` 成员 | `isMember=true` → nil |
| `canReadTeam` 非成员 | `isMember=false` → `ErrNotTeamMember` |
| `canReadLedger` owner | owner 命中 → nil |
| `canReadLedger` 非成员 | 非 owner 非成员 → `ErrNotLedgerMember` |
| `lwwMergeLedger` UPDATE 不含归属 | fakeQuerier 记录 exec，断言 UPDATE SQL 无 `owner_id`/`team_id` |
| `lwwMergeLedger` INSERT 强制归属 | 断言 INSERT 的 owner_id arg = userID、team_id arg = nil |
| `lwwMergeLedger` 无权限 | `canReadLedger` 返回 `ErrNotLedgerMember` → merge 不执行、错误透传 |

### 集成测试（扩展 `backend/internal/service/sync_integration_test.go`）

| 用例 | 断言 |
|---|---|
| 团队成员不能改账本归属 | seed 团队 + 团队账本（owner=A, member=B）；B 推送带 `owner_id=B`/`team_id=其他` 的账本变更 → 断言 DB 的 `owner_id`/`team_id` 不变 |

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `backend/internal/service/authz.go` | 新增：`canReadTeam`/`canReadLedger`/`ErrNotTeamMember`/`ErrNotLedgerMember` |
| `backend/internal/service/team.go` | 删 `ensureTeamMember` + `ErrNotTeamMember`；`ListMembers` 改用 `canReadTeam` |
| `backend/internal/service/sync.go` | `lwwMergeLedger` 加 `userID` + 自鉴权 + 归属加固；`applyLocalChanges` 账本循环改用错误跳过；`getUserLedgerIDs` 注释 |
| `backend/internal/service/authz_test.go` | 新增单测 |
| `backend/internal/service/sync_integration_test.go` | 新增团队成员不能改归属的集成用例 |

## 8. 验证

```bash
cd backend
go build ./... && go vet ./... && go test ./...                       # 存量 + 新单测
go test -tags integration ./internal/service/ -run TestIntegration    # 集成（含新用例，需 Docker）
```

## 9. 任务拆分

| # | 任务 | 产出 | 验证 |
|---|---|---|---|
| 1 | 加 `authz.go`（canReadTeam/canReadLedger + 哨兵错误） | `authz.go` | `go build` |
| 2 | `team.go` 迁移到 `canReadTeam` | `team.go` | `go test` 存量 team 测试 |
| 3 | `lwwMergeLedger` 归属加固 + 自鉴权 + `applyLocalChanges` 改造 | `sync.go` | `go test` 存量 lwwmerge 测试 |
| 4 | `authz_test.go` 单测 | `authz_test.go` | `go test` |
| 5 | 集成用例：团队成员不能改归属 | `sync_integration_test.go` | `go test -tags integration` |
| 6 | 全量回归 + README 同步 | `README.md` | 全量 |
