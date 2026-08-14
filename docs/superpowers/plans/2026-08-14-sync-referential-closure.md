# 同步增量引用闭包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 根治同步外键卡死——增量同步返回流水时连带返回其引用的父行（账本/账户/分类/标签），保证父行先于子行到位。

**Architecture:** 后端 `getRemoteChanges` 在现有增量查询后新增「引用闭包」步骤：从增量结果集收集外键目标 id，按 id 反查（不看 `updated_at`），合并进 payload。前端 `applyRemoteChanges` 不改（拓扑顺序 + LWW 已幂等），只在 `performSync` 给 `applyRemoteChanges` 包 try/catch，失败时如实报错且不虚推游标。

**Tech Stack:** Go + pgx（后端）、Vue 3 + TypeScript + vitest（前端）、SQLite（本地）。

**Spec:** `docs/superpowers/specs/2026-08-14-sync-referential-closure-design.md`

## Global Constraints

- TypeScript 严格模式，禁止 `any`（测试内 mock 断言用 `as never` / `vi.mocked` 绕过类型，与现有 `sync.test.ts` 风格一致）。
- 后端 model 字段顺序与现有查询一致（`queryLedgers`/`queryAccounts`/`queryTags`/`queryCategories` 的 SELECT 列序与 Scan 顺序一一对应）。
- 每次 commit 同步更新 README.md 反映真实状态（本计划 Task 5 落地）。
- 后端无 test-db 基建：`collectReferencedIDs` 用纯函数单测，ByIDs 查询靠 `go build`/`go vet`/现有 `go test` 验证。

---

### Task 1: 后端 `collectReferencedIDs` 纯函数（TDD）

**Files:**
- Create: `backend/internal/service/sync_test.go`
- Modify: `backend/internal/service/sync.go`（新增 `collectReferencedIDs` 函数）

**Interfaces:**
- Produces: `collectReferencedIDs(accounts []model.Account, categories []model.Category, tags []model.Tag, transactions []model.Transaction) (ledgerIDs, accountIDs, categoryIDs, tagIDs map[string]bool)` —— 供 Task 2 的 `backfillReferenced` 使用。nil 指针（`FromAccountID`/`ToAccountID`/`CategoryID`）跳过，不产生空字符串 key。

- [ ] **Step 1: 写失败测试**

在 `backend/internal/service/sync_test.go` 新建：

```go
package service

import (
	"testing"

	"wee-count/backend/internal/model"
)

func TestCollectReferencedIDs(t *testing.T) {
	fromAcc := "acc-from"
	toAcc := "acc-to"
	cat := "cat-1"

	accounts := []model.Account{{ID: "a1", LedgerID: "ledger-a"}}
	categories := []model.Category{{ID: "c1", LedgerID: "ledger-c"}}
	tags := []model.Tag{{ID: "t1", LedgerID: "ledger-t"}}
	transactions := []model.Transaction{
		{
			ID:            "tx1",
			LedgerID:      "ledger-tx",
			FromAccountID: &fromAcc,
			ToAccountID:   &toAcc,
			CategoryID:    &cat,
			TagIDs:        []string{"tag-x", "tag-y"},
		},
		{
			ID:       "tx2",
			LedgerID: "ledger-tx",
			// 无 from/to/category/tag：nil 指针与空 tag 都应跳过
		},
	}

	ledgerIDs, accountIDs, categoryIDs, tagIDs := collectReferencedIDs(accounts, categories, tags, transactions)

	for _, id := range []string{"ledger-a", "ledger-c", "ledger-t", "ledger-tx"} {
		if !ledgerIDs[id] {
			t.Errorf("ledgerIDs 缺 %q: %v", id, ledgerIDs)
		}
	}
	for _, id := range []string{"acc-from", "acc-to"} {
		if !accountIDs[id] {
			t.Errorf("accountIDs 缺 %q: %v", id, accountIDs)
		}
	}
	if !categoryIDs["cat-1"] {
		t.Errorf("categoryIDs 缺 cat-1: %v", categoryIDs)
	}
	for _, id := range []string{"tag-x", "tag-y"} {
		if !tagIDs[id] {
			t.Errorf("tagIDs 缺 %q: %v", id, tagIDs)
		}
	}
	if accountIDs[""] || categoryIDs[""] {
		t.Errorf("nil 指针不应产生空 id")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend && go test ./internal/service/ -run TestCollectReferencedIDs`
Expected: 编译失败 "undefined: collectReferencedIDs"

- [ ] **Step 3: 实现 `collectReferencedIDs`**

在 `backend/internal/service/sync.go` 末尾（`queryMemberAliases` 之后）新增：

```go
// collectReferencedIDs 收集增量结果集里所有外键目标的 id。
// 增量按 updated_at > since 分表过滤会漏掉「子表记录引用的父行」，
// 这些父行需按 id 反查补齐，避免客户端外键缺失卡死。
func collectReferencedIDs(
	accounts []model.Account,
	categories []model.Category,
	tags []model.Tag,
	transactions []model.Transaction,
) (ledgerIDs, accountIDs, categoryIDs, tagIDs map[string]bool) {
	ledgerIDs = map[string]bool{}
	accountIDs = map[string]bool{}
	categoryIDs = map[string]bool{}
	tagIDs = map[string]bool{}

	for _, a := range accounts {
		ledgerIDs[a.LedgerID] = true
	}
	for _, c := range categories {
		ledgerIDs[c.LedgerID] = true
	}
	for _, t := range tags {
		ledgerIDs[t.LedgerID] = true
	}
	for _, tx := range transactions {
		ledgerIDs[tx.LedgerID] = true
		if tx.FromAccountID != nil {
			accountIDs[*tx.FromAccountID] = true
		}
		if tx.ToAccountID != nil {
			accountIDs[*tx.ToAccountID] = true
		}
		if tx.CategoryID != nil {
			categoryIDs[*tx.CategoryID] = true
		}
		for _, tagID := range tx.TagIDs {
			tagIDs[tagID] = true
		}
	}
	return
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd backend && go test ./internal/service/ -run TestCollectReferencedIDs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/sync.go backend/internal/service/sync_test.go
git commit -m "feat: sync collectReferencedIDs 纯函数 + 单测"
```

---

### Task 2: 后端引用闭包补拉（ByIDs 查询 + getRemoteChanges 集成）

**Files:**
- Modify: `backend/internal/service/sync.go`

**Interfaces:**
- Consumes: `collectReferencedIDs(...)`（Task 1）。
- Produces: `backfillReferenced(ctx context.Context, payload *model.SyncPayload) error`、`queryLedgersByIDs` / `queryAccountsByIDs` / `queryCategoriesByIDs` / `queryTagsByIDs`（`func(ctx, ids []string) ([]model.X, error)`）、`unseenKeys(m, seen map[string]bool) []string`。

- [ ] **Step 1: 新增四个 ByIDs 查询方法**

在 `backend/internal/service/sync.go` 的 `queryTransactions` 之后新增（列序与 Scan 顺序严格对齐现有 `queryLedgers`/`queryAccounts`/`queryTags`/`queryCategories`）：

```go
func (s *SyncService) queryLedgersByIDs(ctx context.Context, ids []string) ([]model.Ledger, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted
		 FROM ledgers WHERE id = ANY($1)`,
		ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ledgers []model.Ledger
	for rows.Next() {
		var l model.Ledger
		if err := rows.Scan(&l.ID, &l.Name, &l.Type, &l.OwnerID, &l.TeamID, &l.CreatedAt, &l.UpdatedAt, &l.IsDeleted); err != nil {
			return nil, err
		}
		ledgers = append(ledgers, l)
	}
	return ledgers, rows.Err()
}

func (s *SyncService) queryAccountsByIDs(ctx context.Context, ids []string) ([]model.Account, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted
		 FROM accounts WHERE id = ANY($1)`,
		ids,
	)
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

func (s *SyncService) queryCategoriesByIDs(ctx context.Context, ids []string) ([]model.Category, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted FROM categories WHERE id = ANY($1)`,
		ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var categories []model.Category
	for rows.Next() {
		var c model.Category
		if err := rows.Scan(&c.ID, &c.LedgerID, &c.OwnerID, &c.Name, &c.Type, &c.Icon, &c.SortOrder, &c.UpdatedAt, &c.IsDeleted); err != nil {
			return nil, err
		}
		categories = append(categories, c)
	}
	return categories, rows.Err()
}

func (s *SyncService) queryTagsByIDs(ctx context.Context, ids []string) ([]model.Tag, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT id, ledger_id, name, updated_at, is_deleted FROM tags WHERE id = ANY($1)`,
		ids,
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
```

- [ ] **Step 2: 新增 `unseenKeys` 与 `backfillReferenced`**

在 `sync.go` 的 `getRemoteChanges` 之后新增：

```go
// unseenKeys 返回 m 中不在 seen 里的 key 组成的 slice（用于补拉去重）。
func unseenKeys(m, seen map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		if !seen[k] {
			out = append(out, k)
		}
	}
	return out
}

// backfillReferenced 补齐增量结果里子表记录引用的父行。
// 只反查「增量结果里还没有」的 id，避免重复返回（前端 LWW 也能幂等兜底）。
func (s *SyncService) backfillReferenced(ctx context.Context, payload *model.SyncPayload) error {
	refLedgers, refAccounts, refCategories, refTags := collectReferencedIDs(
		payload.Accounts, payload.Categories, payload.Tags, payload.Transactions,
	)

	seenLedgers := map[string]bool{}
	for _, l := range payload.Ledgers {
		seenLedgers[l.ID] = true
	}
	seenAccounts := map[string]bool{}
	for _, a := range payload.Accounts {
		seenAccounts[a.ID] = true
	}
	seenCategories := map[string]bool{}
	for _, c := range payload.Categories {
		seenCategories[c.ID] = true
	}
	seenTags := map[string]bool{}
	for _, t := range payload.Tags {
		seenTags[t.ID] = true
	}

	if ids := unseenKeys(refLedgers, seenLedgers); len(ids) > 0 {
		extra, err := s.queryLedgersByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Ledgers = append(payload.Ledgers, extra...)
	}
	if ids := unseenKeys(refAccounts, seenAccounts); len(ids) > 0 {
		extra, err := s.queryAccountsByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Accounts = append(payload.Accounts, extra...)
	}
	if ids := unseenKeys(refCategories, seenCategories); len(ids) > 0 {
		extra, err := s.queryCategoriesByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Categories = append(payload.Categories, extra...)
	}
	if ids := unseenKeys(refTags, seenTags); len(ids) > 0 {
		extra, err := s.queryTagsByIDs(ctx, ids)
		if err != nil {
			return err
		}
		payload.Tags = append(payload.Tags, extra...)
	}
	return nil
}
```

- [ ] **Step 3: 在 `getRemoteChanges` 返回前调用 `backfillReferenced`**

把 `getRemoteChanges` 末尾（`payload.MemberAliases = aliases` 之后、`return payload, nil` 之前）改为：

```go
	payload.MemberAliases = aliases

	// 引用闭包：增量返回的子表记录引用的父行（ledger/account/category/tag）
	// 可能 updated_at 早于 since 而未被增量返回，导致客户端外键缺失卡死。按 id 反查补齐。
	if err := s.backfillReferenced(ctx, &payload); err != nil {
		return payload, err
	}

	return payload, nil
```

- [ ] **Step 4: 编译 + 静态检查 + 现有测试**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: 全部通过，无编译错误。

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/sync.go
git commit -m "feat: sync 增量引用闭包 — 补齐子表引用的父行，根除外键卡死"
```

---

### Task 3: 前端 `performSync` 兜底 try/catch（TDD）

**Files:**
- Modify: `src/services/sync.ts`（`performSync` 内 `applyRemoteChanges` 包 try/catch）
- Modify: `src/services/__tests__/sync.test.ts`（新增健壮性测试 + 补 `getMemberAlias`/`getMemberAliases`/`setMemberAlias` mock）

**Interfaces:**
- Consumes: `markSyncResult(ok: boolean)`（已存在）、`getLastSyncedAt()`/`setLastSyncedAt()`（已存在）。
- Produces: 无新导出；改变 `performSync` 失败语义——`applyRemoteChanges` 抛异常时返回 `false`、`lastSyncFailed` 置 `true`、游标不推进。

- [ ] **Step 1: 补全 `@/db/userDb` 的 mock**

把 `src/services/__tests__/sync.test.ts` 顶部 mock 改为（新增三个成员方法，供 `collectMemberAliasesForSync` 与 `applyRemoteChanges` 动态 import 使用）：

```ts
vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(),
  getCurrentUserId: () => getCurrentUserId(),
  getMemberAlias: vi.fn(),
  setMemberAlias: vi.fn(),
  getMemberAliases: vi.fn().mockResolvedValue([]),
}));
```

- [ ] **Step 2: 写失败测试**

在 `src/services/__tests__/sync.test.ts` 文件末尾新增 describe 块（沿用已有 `useAuthStoreMock`、`getCurrentUserId`、`setLastSyncedAt`/`getLastSyncedAt`）：

```ts
describe("performSync 健壮性", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
  });

  it("applyRemoteChanges 抛异常时游标不推进且 lastSyncFailed 置位", async () => {
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);

    setLastSyncedAt("T1");
    const { apiFetch } = await import("@/services/api");
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        server_time: "T2",
        remote_changes: {
          ledgers: [{ id: "l1", name: "x", type: "team", owner_id: null, team_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
          accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
        },
      },
    } as never);

    // 让 applyRemoteChanges 内部的 db.select reject，模拟外键违反抛异常
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({
      select: vi.fn().mockRejectedValue(new Error("FOREIGN KEY constraint failed")),
      execute: vi.fn(),
    } as never);

    const { performSync } = await import("@/services/sync");
    await performSync();

    expect(authState.lastSyncFailed).toBe(true);
    expect(getLastSyncedAt()).toBe("T1"); // 游标未推进
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: 该测试 FAIL——`performSync` 未捕获异常，`authState.lastSyncFailed` 仍为 `false`（或 `performSync` 抛异常导致断言前中断）。

- [ ] **Step 4: 实现 try/catch**

把 `src/services/sync.ts` 中 `performSync` 的这一段：

```ts
  await applyRemoteChanges(res.data.remote_changes);
  setLastSyncedAt(res.data.server_time);
```

改为：

```ts
  try {
    await applyRemoteChanges(res.data.remote_changes);
  } catch (e) {
    console.warn("[sync] applyRemoteChanges failed:", e);
    await markSyncResult(false);
    return false;
  }
  setLastSyncedAt(res.data.server_time);
```

（保持其后 `notifySyncComplete()` 与 `markSyncResult(true)` 不变）

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "fix: sync applyRemoteChanges 异常不再静默吞 — 报错且不虚推游标"
```

---

### Task 4: 前端 `applyRemoteChanges` 幂等回归测试

**Files:**
- Modify: `src/services/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `applyRemoteChanges(remote: SyncPayload)`（已存在，本次不改实现）。
- Produces: 无；验证补拉重复父行时 LWW 跳过 UPDATE（方案 B 的前端前提）。

- [ ] **Step 1: 写幂等测试**

在 `src/services/__tests__/sync.test.ts` 的 `performSync 健壮性` describe 之后新增：

```ts
describe("applyRemoteChanges 幂等", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
  });

  it("补拉与增量返回同一父行（updated_at 相等）时跳过 UPDATE", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    const select = vi.fn().mockResolvedValue([{ updated_at: "2026-01-01T00:00:00Z" }]);
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    const { applyRemoteChanges } = await import("@/services/sync");
    await applyRemoteChanges({
      ledgers: [{ id: "l1", name: "x", type: "team", owner_id: null, team_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
    });

    // select 返回 updated_at 相等的本地记录 → 不应执行任何 UPDATE / INSERT
    const writeCalls = execute.mock.calls.filter((c) => {
      const sql = c[0] as string;
      return sql.startsWith("UPDATE") || sql.startsWith("INSERT");
    });
    expect(writeCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: PASS（该测试验证现有行为，不改实现即应通过）。

- [ ] **Step 3: Commit**

```bash
git add src/services/__tests__/sync.test.ts
git commit -m "test: sync applyRemoteChanges 补拉重复父行幂等回归"
```

---

### Task 5: README 同步真实状态

**Files:**
- Modify: `README.md`

**Interfaces:**
- 无。

- [ ] **Step 1: 更新 README**

定位 README 中「同步」或「Phase / 路线图」相关段落，补充一行说明本次修复后的同步行为：增量同步会连带返回流水引用的父行（账本/账户/分类/标签），消除跨表外键缺失导致的同步卡死；`applyRemoteChanges` 失败时会如实标记同步失败而非静默。若 README 已有版本号，按仓库惯例递增。

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: README 同步 — 增量引用闭包修复同步卡死"
```

---

## Self-Review 结果

- **Spec 覆盖**：spec 第 4 节（后端补拉闭包）→ Task 1+2；第 5 节（前端 try/catch）→ Task 3；第 8 节（测试）→ Task 1/3/4；第 9 节（文件清单）→ 全覆盖；第 10 节（任务拆分第 5 项 README）→ Task 5。无遗漏。
- **占位符扫描**：无 TBD/TODO/「类似 Task N」；所有代码块为真实实现。
- **类型一致性**：`collectReferencedIDs` 返回值命名（`ledgerIDs/accountIDs/categoryIDs/tagIDs`）在 Task 1 定义与 Task 2 使用处一致；`unseenKeys(m, seen map[string]bool) []string` 签名一致；前端 `markSyncResult`/`getLastSyncedAt` 复用现有导出。
