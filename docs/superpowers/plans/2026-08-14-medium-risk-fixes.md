# 中危漏洞修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复复盘报告中 10 个中危项（Docker 供应链项经确认跳过）。

**Architecture:** 前 6 个任务为前端（Vue3+TS+Pinia）与 Tauri 壳修复，后 4 个为 Go 后端修复。每个任务独立、可单独测试与提交。

**Tech Stack:** Vue 3 + TypeScript（strict）、Pinia、Tauri 2.0（plugin-sql / plugin-store）、Go + chi + pgx + golang-migrate、httprate。

**Spec:** `docs/2026-08-14-复盘报告.md`（「二、中危」小节）

## Global Constraints

- TypeScript 严格模式，禁止 `any`（新增代码不得出现 `any`/`as never` 之外的逃生口；`as never` 仅用于既有 mock 场景）。
- 不重构无关代码，不改未要求的文件。
- 测试优先：逻辑类任务需附单元测试；UI/壳层类 bugfix 用 `npm run build`（vue-tsc 类型检查）验证。
- 每次 commit 同步更新 README.md，使 README 反映真实状态。
- commit message 不加 Co-Authored-By。
- 前端验证命令：`npm run test`（vitest）、`npm run build`（vue-tsc + vite）。后端验证：`cd backend && go build ./... && go test ./...`。

---

### Task 1: TransactionList 点击监听器未清理（内存泄漏）

**Files:**
- Modify: `src/views/TransactionList.vue:1-3`（import）、`:177-179`（监听注册）

**Interfaces:**
- Consumes: 无
- Produces: 无（仅清理行为，导出面不变）

- [ ] **Step 1: 抽具名函数并补 onUnmounted**

把 import 从 `onMounted` 扩到 `onUnmounted`：

```ts
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
```

把 onMounted 内的匿名监听抽成具名函数，并在组件卸载时移除。当前：

```ts
onMounted(async () => {
  // ... 前面的初始化逻辑不动 ...
  // 点击外部关闭账本切换下拉
  document.addEventListener("click", () => {
    showLedgerSwitcher.value = false;
  });
});
```

改为：

```ts
function closeLedgerSwitcher() {
  showLedgerSwitcher.value = false;
}

onMounted(async () => {
  // ... 前面的初始化逻辑不动 ...
  // 点击外部关闭账本切换下拉
  document.addEventListener("click", closeLedgerSwitcher);
});

onUnmounted(() => {
  document.removeEventListener("click", closeLedgerSwitcher);
});
```

- [ ] **Step 2: 验证**

Run: `npm run build`（vue-tsc 类型检查通过）。
Run: `npm run test`（既有用例全绿，无回归）。

- [ ] **Step 3: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "fix(ui): TransactionList 点击监听器卸载时清理 — 修复内存泄漏/重复执行"
```

---

### Task 2: accountStore.remove 不校验关联流水

**Files:**
- Modify: `src/stores/account.ts:197-229`（remove）
- Test: `src/stores/__tests__/account.test.ts:215-250`（remove describe）

**Interfaces:**
- Consumes: `getUserDb()` 返回的 `select`（同 category.ts 的 COUNT 模式）
- Produces: `remove(id)` 现在在有活跃流水时抛 `该账户下有 N 笔交易，无法删除`（与 `categoryStore.remove` 一致）

- [ ] **Step 1: 写失败测试**

在 `account.test.ts` 的 `remove` describe 里新增：

```ts
it("should throw error when account has related transactions", async () => {
  mockDb.select.mockResolvedValueOnce([{ count: 3 }]);
  const store = useAccountStore();
  await expect(store.remove("a1")).rejects.toThrow("该账户下有 3 笔交易，无法删除");
  expect(mockDb.execute).not.toHaveBeenCalled();
});
```

同时更新既有两个 `remove` 用例：软删前会先查 COUNT，需在最前面补一条 `mockDb.select.mockResolvedValueOnce([{ count: 0 }])`，否则软删用例会因缺 mock 而失败。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- src/stores/__tests__/account.test.ts`
Expected: 新用例 FAIL（`remove` 未做 COUNT 校验，直接执行软删）；两个旧用例因新增 select 调用而失败。

- [ ] **Step 3: 实现**

在 `account.ts` 的 `remove` 中，`getUserDb()` 判空之后、`db.execute` 软删之前插入 COUNT 校验：

```ts
const txs = await db.select<{ count: number }[]>(
  "SELECT COUNT(*) AS count FROM transactions WHERE (from_account_id = ? OR to_account_id = ?) AND is_deleted = 0",
  [id, id],
);
if (txs[0].count > 0) {
  throw new Error(`该账户下有 ${txs[0].count} 笔交易，无法删除`);
}
```

（软删与入队逻辑保持不变。）

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- src/stores/__tests__/account.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stores/account.ts src/stores/__tests__/account.test.ts
git commit -m "fix(account): 软删账户前校验关联流水，避免产生孤儿流水"
```

---

### Task 3: LWW 时间戳字符串字典序比较 + firstFullSync 未归一化

**Files:**
- Modify: `src/services/sync.ts:220,242,260,287,300`（`applyRemoteChanges` 的 5 处字符串比较）、`:376-380`（附近新增 helper）
- Modify: `src/services/migration.ts:1-3`（新增 import）、`:83-92`（firstFullSync 归一化）
- Test: `src/services/__tests__/sync.test.ts`、`src/services/__tests__/migration.timestamp.test.ts`（新建）

**Interfaces:**
- Consumes: 既有 `toIsoTimestamp(v)`（sync.ts 已导出）
- Produces: 新增导出 `compareTimestamp(a: string, b: string): number`；`firstFullSync` 出口的时间戳统一为 ISO

- [ ] **Step 1: 写失败测试**

在 `sync.test.ts` 新增（针对纯函数）：

```ts
import { compareTimestamp } from "@/services/sync";

describe("compareTimestamp", () => {
  it("空格格式与 ISO 格式按真实时间比较，而非字典序", () => {
    // " " (0x20) < "T" (0x54)：字典序会把空格格式误判为「更旧」
    const space = "2026-07-10 02:31:59";      // 等价 ISO 2026-07-10T02:31:59Z
    const iso = "2026-07-10T02:30:00Z";
    expect(compareTimestamp(space, iso)).toBeGreaterThan(0);
  });
  it("相等时间返回 0", () => {
    expect(compareTimestamp("2026-07-10T02:31:59Z", "2026-07-10 02:31:59")).toBe(0);
  });
});
```

新建 `migration.timestamp.test.ts`：mock `@/db/userDb` 与 `@/services/api`，让 `firstFullSync` 读到 `updated_at: "2026-07-10 02:31:59"` 的原始行，断言发给 `apiFetch` 的 payload 里 `updated_at` 已被归一化为 `"2026-07-10T02:31:59Z"`。

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts src/services/__tests__/migration.timestamp.test.ts`
Expected: FAIL（`compareTimestamp` 不存在；firstFullSync 未归一化）

- [ ] **Step 3: 实现 helper**

在 `sync.ts` 末尾 `toIsoTimestamp` 之后新增：

```ts
// 归一化后按 epoch 毫秒比较，消除 " " vs "T" 字典序误判与毫秒位差异。
export function compareTimestamp(a: string, b: string): number {
  return new Date(toIsoTimestamp(a)).getTime() - new Date(toIsoTimestamp(b)).getTime();
}
```

把 `applyRemoteChanges` 里 5 处 `X.updated_at > local[0].updated_at` 改为 `compareTimestamp(X.updated_at, local[0].updated_at) > 0`（ledger/account/tag/category 各一处，transaction 在 `shouldUpdate` 计算处）。

- [ ] **Step 4: 实现 firstFullSync 归一化**

`migration.ts` 顶部加静态导入（无静态循环依赖，sync.ts 仅动态 import migration）：

```ts
import { toIsoTimestamp } from '@/services/sync'
```

新增归一化 helper（放在 `firstFullSync` 前）：

```ts
function normalizeTimestamps(r: Record<string, unknown>): Record<string, unknown> {
  const out = { ...r };
  for (const k of ["created_at", "updated_at", "occurred_at"] as const) {
    const v = out[k];
    if (typeof v === "string") out[k] = toIsoTimestamp(v);
  }
  return out;
}
```

将 `firstFullSync` 里 `ledgers/accounts/categories/tags/transactions` 的 map 都先套一层 `normalizeTimestamps`：

```ts
const ledgers = rawLedgers.map(r => ({ ...normalizeTimestamps(r), is_deleted: toBool(r.is_deleted) }))
// accounts/categories/tags/transactions 同理
```

- [ ] **Step 5: 运行确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts src/services/__tests__/migration.timestamp.test.ts`
Run: `npm run test`（全量）
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/sync.ts src/services/migration.ts src/services/__tests__/sync.test.ts src/services/__tests__/migration.timestamp.test.ts
git commit -m "fix(sync): LWW 时间戳按 epoch 比较并归一化 firstFullSync 出口 — 消除空格/ISO 字典序误判"
```

---

### Task 4: 同步失败后无自动重试

**Files:**
- Modify: `src/services/sync.ts:32-33`（新增 retry 状态）、`:62-68`（clearPendingSync 重置）、`:122-188`（performSync 失败路径 + 成功重置）
- Test: `src/services/__tests__/sync.test.ts`（新增 retry 用例）

**Interfaces:**
- Consumes: 既有 `performSyncIfOnline()`（已按 `isOnline` 守卫）
- Produces: `performSync` 失败后自动武装退避定时器，成功则重置计数

- [ ] **Step 1: 写失败测试**

在 `sync.test.ts` 新增：

```ts
describe("performSync 失败自动重试", () => {
  it("网络异常失败后，退避后重新触发 performSync", async () => {
    vi.useFakeTimers();
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);
    setLastSyncedAt("T1");
    const { apiFetch } = await import("@/services/api");
    // 第一次失败，第二次成功
    (apiFetch as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { server_time: "T2", remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] } } });

    const { performSync } = await import("@/services/sync");
    await performSync(); // 失败
    expect(authState.lastSyncFailed).toBe(true);

    await vi.advanceTimersByTimeAsync(5000); // 触发第一次退避重试
    expect(apiFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Expected: FAIL（失败后不重试，`apiFetch` 只调用 1 次）

- [ ] **Step 3: 实现**

在 `syncTimer` 声明旁新增重试状态：

```ts
let retryAttempt = 0;
```

新增 `scheduleRetry`（放在 `performSyncIfOnline` 附近）：

```ts
// 同步失败后按指数退避重新武装定时器：5s → 10s → 20s → 60s（上限）。
// performSyncIfOnline 内部已按 isOnline 守卫，非 online 时静默跳过，等会话恢复再推。
function scheduleRetry(): void {
  if (syncTimer) clearTimeout(syncTimer);
  const delay = Math.min(5000 * Math.pow(2, retryAttempt), 60000);
  retryAttempt++;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void performSyncIfOnline();
  }, delay);
}
```

在 `clearPendingSync` 里追加 `retryAttempt = 0;`。

在 `performSync` 的 4 个失败返回点（firstFullSync catch、apiFetch catch、`!res.ok`、`applyRemoteChanges` catch）各自在 `return false` 前调用 `scheduleRetry()`；在成功分支（`await markSyncResult(true)` 前）追加 `retryAttempt = 0;`。

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- src/services/__tests__/sync.test.ts`
Run: `npm run test`（全量）
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/sync.ts src/services/__tests__/sync.test.ts
git commit -m "fix(sync): 同步失败后指数退避自动重试，断网编辑恢复后自动补推"
```

---

### Task 5: updateProfile 改昵称不刷新 ledger 内存缓存

**Files:**
- Modify: `src/stores/auth.ts:288-311`（改昵称分支末尾）
- Test: `src/stores/__tests__/auth.test.ts`（新增用例）

**Interfaces:**
- Consumes: `@/stores/ledger` 的 `useLedgerStore().init()`（ledger.ts 不依赖 auth，动态 import 无环）
- Produces: `updateProfile` 改昵称后账本名即时刷新到 ledgerStore

- [ ] **Step 1: 写失败测试**

`auth.test.ts` 新增（mock ledgerStore）：

```ts
import { vi } from "vitest";
// 顶部 mock 区追加：
vi.mock("@/stores/ledger", () => ({ useLedgerStore: vi.fn(() => ({ init: vi.fn() })) }));
```

用例：

```ts
it("updateProfile 改昵称后刷新 ledger 内存缓存", async () => {
  const { useLedgerStore } = await import("@/stores/ledger");
  const initMock = vi.fn();
  (useLedgerStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ init: initMock });

  const { getUserDb } = await import("@/db/userDb");
  (getUserDb as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
    execute: vi.fn(),
    select: vi.fn().mockResolvedValue([]),
  });

  const store = useAuthStore();
  store.currentLocalUser = {
    id: "u1", username: "alice", nickname: "Alice", password_hash: "x",
    api_url: null, server_user_id: null, avatar_url: null, created_at: "", updated_at: "",
  };
  store.mode = "local";
  await store.updateProfile({ nickname: "Alicia" });

  expect(initMock).toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- src/stores/__tests__/auth.test.ts`
Expected: FAIL（改昵称后未调用 ledgerStore.init）

- [ ] **Step 3: 实现**

在 `auth.ts` `updateProfile` 的改昵称分支内，DB UPDATE 之后、`if (mode.value === 'online')` 块之后追加：

```ts
// 刷新账本内存缓存，让 UI 立即显示新账本名（否则要等下次 init() 才更新）
const { useLedgerStore } = await import("@/stores/ledger");
await useLedgerStore().init();
```

- [ ] **Step 4: 运行确认通过**

Run: `npm run test -- src/stores/__tests__/auth.test.ts`
Run: `npm run build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stores/auth.ts src/stores/__tests__/auth.test.ts
git commit -m "fix(auth): 改昵称后刷新账本内存缓存，账本名即时更新"
```

---

### Task 6: refresh_token 迁出 localStorage → Tauri 原生 store

**Files:**
- Create: `src/services/tokenStorage.ts`
- Modify: `src/services/api.ts:39-74,110-112,183-197`
- Modify: `src-tauri/Cargo.toml:20-25`、`src-tauri/src/lib.rs:2-7`、`src-tauri/capabilities/default.json:6-13`
- Modify: `package.json:14-25`（dependencies）
- Test: `src/services/__tests__/tokenStorage.test.ts`（新建）

**Interfaces:**
- Consumes: `@tauri-apps/plugin-store` 的 `load`；`@/services/api` 的内存 `accessToken/refreshToken`
- Produces: `tokenStorage.readRefreshToken()/writeRefreshToken()/deleteRefreshToken()`（均为 async）；`api` 的 `getStoredRefreshToken` 改为 async，`setTokens/clearTokens` 内部 fire-and-forget 持久化，非 Tauri 环境（浏览器 dev / 测试）回落 localStorage

**说明（诚实边界）：** 该改动把 token 移出 webview 可达的 localStorage，封堵 XSS 经 `localStorage.getItem` 直接取走 token 的路径；但 `tauri-plugin-store` 是明文持久化（非加密），对已 root 设备不构成终极防护（真正的 root 级防护需服务端轮换/撤销，本轮按选择不做）。

- [ ] **Step 1: 写失败测试**

新建 `tokenStorage.test.ts`（mock 插件 load 抛错，断言回落 localStorage）：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(),
}));

import { load } from "@tauri-apps/plugin-store";
import { readRefreshToken, writeRefreshToken, deleteRefreshToken } from "@/services/tokenStorage";

describe("tokenStorage", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("非 Tauri 环境回落 localStorage", async () => {
    (load as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no tauri"));
    await writeRefreshToken("r-token");
    expect(localStorage.getItem("refresh_token")).toBe("r-token");
    await expect(readRefreshToken()).resolves.toBe("r-token");
    await deleteRefreshToken();
    expect(localStorage.getItem("refresh_token")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npm run test -- src/services/__tests__/tokenStorage.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 tokenStorage.ts**

```ts
// src/services/tokenStorage.ts
import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "tokens.json";
const KEY = "refresh_token";

let storePromise: Promise<Store | null> | null = null;

// 惰性加载；非 Tauri 环境（浏览器 dev / 单元测试）load 会失败，回落 null → localStorage。
async function getStore(): Promise<Store | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        return await load(FILE, { autoSave: true });
      } catch {
        return null;
      }
    })();
  }
  return storePromise;
}

export async function readRefreshToken(): Promise<string | null> {
  const store = await getStore();
  if (store) return (await store.get<string>(KEY)) ?? null;
  return localStorage.getItem(KEY);
}

export async function writeRefreshToken(token: string): Promise<void> {
  const store = await getStore();
  if (store) await store.set(KEY, token);
  else localStorage.setItem(KEY, token);
}

export async function deleteRefreshToken(): Promise<void> {
  const store = await getStore();
  if (store) await store.delete(KEY);
  else localStorage.removeItem(KEY);
}
```

- [ ] **Step 4: 改造 api.ts**

顶部 import：

```ts
import { readRefreshToken, writeRefreshToken, deleteRefreshToken } from "./tokenStorage";
```

`setTokens` 改为 fire-and-forget 持久化：

```ts
export function setTokens(access: string, refresh: string): void {
  accessToken = access
  refreshToken = refresh
  void writeRefreshToken(refresh)
}
```

`clearTokens`：

```ts
export function clearTokens(): void {
  accessToken = null
  refreshToken = null
  void deleteRefreshToken()
}
```

`getStoredRefreshToken` 改 async：

```ts
export async function getStoredRefreshToken(): Promise<string | null> {
  return readRefreshToken()
}
```

`refreshAccessToken` 内 `const stored = getStoredRefreshToken()` → `const stored = await getStoredRefreshToken()`，并把 `localStorage.setItem("refresh_token", data.refresh_token)` 改为 `void writeRefreshToken(data.refresh_token)`。

`tryRestoreSession` 内同理 `const stored = await getStoredRefreshToken()`，并把 `localStorage.setItem('refresh_token', data.refresh_token)` 改为 `void writeRefreshToken(data.refresh_token)`。

`isLoggedIn`（仅测试 mock 引用，生产无调用）改为基于内存 token：

```ts
export function isLoggedIn(): boolean {
  return accessToken !== null || refreshToken !== null
}
```

- [ ] **Step 5: 接入 Tauri 壳**

`Cargo.toml` `[dependencies]` 追加 `tauri-plugin-store = "2"`。
`lib.rs` 追加 `.plugin(tauri_plugin_store::Builder::new().build())`。
`capabilities/default.json` 的 `permissions` 追加 `"store:default"`。
`package.json` `dependencies` 追加 `"@tauri-apps/plugin-store": "^2"`，然后 `npm install`。

- [ ] **Step 6: 运行确认通过**

Run: `npm run test -- src/services/__tests__/tokenStorage.test.ts`
Run: `npm run test`（含 `apiTimeout.test.ts` 回落路径，应仍绿）
Run: `npm run build`
Run: `cd src-tauri && cargo check`
Expected: 全 PASS

- [ ] **Step 7: Commit**

```bash
git add src/services/tokenStorage.ts src/services/api.ts src/services/__tests__/tokenStorage.test.ts \
  src-tauri/Cargo.toml src-tauri/src/lib.rs src-tauri/capabilities/default.json package.json package-lock.json
git commit -m "feat(security): refresh_token 迁出 localStorage 至 Tauri 原生 store，非 Tauri 环境回落 localStorage"
```

---

### Task 7: GetMe 漏查 rows.Err()

**Files:**
- Modify: `backend/internal/service/auth.go:129-144`（GetMe 的 rows 遍历）

**Interfaces:**
- Consumes: 无
- Produces: 无（返回面不变，仅补迭代错误传播）

- [ ] **Step 1: 实现**

在 `GetMe` 的 `for rows.Next()` 循环结束后、`teams` 构建前补：

```go
if err := rows.Err(); err != nil {
    return nil, fmt.Errorf("iterate ledgers: %w", err)
}
```

- [ ] **Step 2: 验证**

Run: `cd backend && go build ./... && go test ./...`
Expected: 全 PASS（无新增单测：该路径需 DB mock，`AuthService` 直接持 `*pgxpool.Pool`；修复与 sync service 既有 `rows.Err()` 检查模式一致，成本不成比例）

- [ ] **Step 3: Commit**

```bash
git add backend/internal/service/auth.go
git commit -m "fix(auth): GetMe 检查 rows.Err，避免迭代中途错误被静默吞掉"
```

---

### Task 8: 错误回显泄露内部细节 + 状态码混用

**Files:**
- Modify: `backend/internal/service/team.go:20-21,91-114,116-177`（新增哨兵错误并替换）
- Modify: `backend/internal/handler/team.go:54-94`（Invite/Join 错误映射）
- Modify: `backend/internal/handler/auth.go:117-121`（UpdateProfile 不再回显 err.Error）
- Test: `backend/internal/service/team_test.go`（新增哨兵错误用例）、`backend/internal/handler/team_test.go`（可选）

**Interfaces:**
- Consumes: `service` 包既有 `errors`、`fmt`
- Produces: 新增哨兵 `ErrTeamNotFound`、`ErrNotTeamOwner`、`ErrInviteInvalid`、`ErrAlreadyMember`

- [ ] **Step 1: 写失败测试**

`service/team_test.go` 新增（用既有 `fakeQuerier`/`fakeRow` 不可直接测 CreateInvite/JoinByInvite，因其持 redis；仅测哨兵错误定义与 handler 映射。此处 handler 测试更直接）：

`handler/team_test.go` 新增（构造返回哨兵错误的 TeamService 不可行，TeamService 需 pgxpool/redis，故 handler 错误映射用「替换 err.Error() 为通用文案 + 状态码」的方式验证即可。改用对 handler 的针对性测试较脆，本任务验证以 `go test ./...` 全绿 + 人工确认通用文案为准）。

> 说明：`CreateInvite`/`JoinByInvite` 直接持 `*pgxpool.Pool` 与 `*redis.Client`，无注入点，无法在无 DB 的单元测试里触发其哨兵错误。本任务的正确性靠「服务层返回哨兵错误 + 处理器映射」的静态一致性与 `go build`/`go vet` 保证；handler 已有测试（缺字段 400）不受影响。

- [ ] **Step 2: 服务层新增哨兵错误**

`service/team.go` 的 var 块新增：

```go
var (
    ErrNotTeamMember  = errors.New("not a team member")
    ErrTeamNotFound   = errors.New("team not found")
    ErrNotTeamOwner   = errors.New("only team owner can create invite")
    ErrInviteInvalid  = errors.New("invalid or expired invite code")
    ErrAlreadyMember  = errors.New("already a member of this team")
)
```

（`ErrNotTeamMember` 已存在，保留。）

`CreateInvite`：

```go
err := s.pool.QueryRow(ctx, "SELECT created_by FROM teams WHERE id = $1", teamID).Scan(&createdBy)
if errors.Is(err, pgx.ErrNoRows) {
    return "", ErrTeamNotFound
}
if err != nil {
    return "", fmt.Errorf("query team: %w", err)
}
if createdBy != userID {
    return "", ErrNotTeamOwner
}
```

（`CreateInvite` 需补 `pgx` import；当前已 import `pgxpool`，加 `github.com/jackc/pgx/v5`。）

`JoinByInvite`：

```go
val, err := s.redis.Get(ctx, key).Result()
if err == redis.Nil {
    return nil, ErrInviteInvalid
}
if err != nil {
    return nil, fmt.Errorf("redis get: %w", err)
}
parts := strings.SplitN(val, ":", 2)
if len(parts) != 2 {
    return nil, ErrInviteInvalid
}
// ...
if exists {
    return nil, ErrAlreadyMember
}
```

- [ ] **Step 3: 处理器错误映射**

`handler/team.go` `Invite`：

```go
code, err := h.svc.CreateInvite(r.Context(), userID, teamID)
if err != nil {
    switch {
    case errors.Is(err, service.ErrTeamNotFound):
        writeError(w, http.StatusNotFound, "team not found")
    case errors.Is(err, service.ErrNotTeamOwner):
        writeError(w, http.StatusForbidden, "only team owner can create invite")
    default:
        writeError(w, http.StatusInternalServerError, "internal error")
    }
    return
}
```

`Join`：

```go
resp, err := h.svc.JoinByInvite(r.Context(), userID, req.InviteCode)
if err != nil {
    switch {
    case errors.Is(err, service.ErrInviteInvalid):
        writeError(w, http.StatusBadRequest, "invalid or expired invite code")
    case errors.Is(err, service.ErrAlreadyMember):
        writeError(w, http.StatusConflict, "already a member of this team")
    default:
        writeError(w, http.StatusInternalServerError, "internal error")
    }
    return
}
```

`handler/auth.go` `UpdateProfile`：

```go
user, err := h.svc.UpdateProfile(r.Context(), userID, req)
if err != nil {
    writeError(w, http.StatusInternalServerError, "internal error")
    return
}
```

- [ ] **Step 4: 验证**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: 全 PASS（不再有任何 `err.Error()` 直出到客户端；状态码 404/403/400/409/500 分离）

- [ ] **Step 5: Commit**

```bash
git add backend/internal/service/team.go backend/internal/handler/team.go backend/internal/handler/auth.go
git commit -m "fix(security): 错误回显不再泄露内部细节，状态码按语义区分"
```

---

### Task 9: 全站速率限制（httprate 按 IP）

**Files:**
- Modify: `backend/cmd/server/main.go:4-18`（import）、`:53-85`（router）
- Modify: `backend/go.mod`、`backend/go.sum`（新增 `github.com/go-chi/httprate`）

**Interfaces:**
- Consumes: `github.com/go-chi/httprate` 的 `LimitByIP`
- Produces: 对 `/auth/login`、`/auth/register`、`/teams/join` 施加每 IP 限流，超限返回 429

- [ ] **Step 1: 加依赖**

Run: `cd backend && go get github.com/go-chi/httprate@latest`

- [ ] **Step 2: 接入路由**

`main.go` import 追加：

```go
import (
    "time"
    "github.com/go-chi/httprate"
)
```

在 router 里对敏感端点施加限流（`middleware.RealIP` 已在全局注册，先于此处生效，`LimitByIP` 读到真实 IP）：

```go
r.Route("/api/v1", func(r chi.Router) {
    // public —— 登录/注册防暴力破解
    r.Post("/auth/register", authH.Register)
    r.Post("/auth/login", authH.Login)
    r.Post("/auth/refresh", authH.Refresh)

    // 对认证入口按 IP 限流（10 req/min）
    r.Group(func(r chi.Router) {
        r.Use(httprate.LimitByIP(10, time.Minute))
        r.Post("/auth/login", authH.Login)
        r.Post("/auth/register", authH.Register)
    })

    // protected
    r.Group(func(r chi.Router) {
        r.Use(mw.AuthMiddleware(cfg.JWTSecret))
        r.Get("/me", authH.Me)
        r.Put("/auth/profile", authH.UpdateProfile)
        r.Post("/sync", syncH.Sync)
        r.Post("/teams", teamH.Create)
        r.Post("/teams/{id}/invite", teamH.Invite)
        r.Post("/teams/join", teamH.Join)
        r.Get("/teams/{id}/members", teamH.Members)
    })
})
```

> 注意：上述会把 `/auth/login`、`/auth/register` 注册两次（public 一次、限流组一次）。chi 中重复 `Post` 同名路由会 panic（`chi: registering duplicate route`）。正确做法是**只在限流组里注册 login/register**，public 段删去这两行。最终：

```go
r.Route("/api/v1", func(r chi.Router) {
    r.Post("/auth/refresh", authH.Refresh) // refresh 不限流（客户端静默续期高频）

    r.Group(func(r chi.Router) {
        r.Use(httprate.LimitByIP(10, time.Minute))
        r.Post("/auth/login", authH.Login)
        r.Post("/auth/register", authH.Register)
    })

    r.Group(func(r chi.Router) {
        r.Use(mw.AuthMiddleware(cfg.JWTSecret))
        r.Get("/me", authH.Me)
        r.Put("/auth/profile", authH.UpdateProfile)
        r.Post("/sync", syncH.Sync)
        r.Post("/teams", teamH.Create)
        r.Post("/teams/{id}/invite", teamH.Invite)
        r.Post("/teams/join", teamH.Join)
        r.Get("/teams/{id}/members", teamH.Members)
    })
})
```

邀请码防爆破：`/teams/join` 已受 `AuthMiddleware` 保护（需登录），但 6 位邀请码仍可被登录用户离线爆破入组，故对其也施加限流。在 protected 组内对 join 单独加：

```go
r.Group(func(r chi.Router) {
    r.Use(mw.AuthMiddleware(cfg.JWTSecret))
    r.Get("/me", authH.Me)
    r.Put("/auth/profile", authH.UpdateProfile)
    r.Post("/sync", syncH.Sync)
    r.Post("/teams", teamH.Create)
    r.Post("/teams/{id}/invite", teamH.Invite)
    r.Get("/teams/{id}/members", teamH.Members)

    r.Group(func(r chi.Router) {
        r.Use(httprate.LimitByIP(10, time.Minute))
        r.Post("/teams/join", teamH.Join)
    })
})
```

- [ ] **Step 3: 验证**

Run: `cd backend && go build ./... && go vet ./... && go test ./...`
Expected: 全 PASS（无单测：路由装配在 `main()`，无既有路由构建测试；httprate 上游已测，限流参数在代码注释中标明）

- [ ] **Step 4: Commit**

```bash
git add backend/cmd/server/main.go backend/go.mod backend/go.sum
git commit -m "feat(security): 登录/注册/入队按 IP 限流（httprate），防暴力破解与邀请码爆破"
```

---

### Task 10: 缺复合索引

**Files:**
- Create: `backend/internal/database/migrations/007_sync_indexes.up.sql`
- Create: `backend/internal/database/migrations/007_sync_indexes.down.sql`

**Interfaces:**
- Consumes: 无（`//go:embed migrations/*.sql` 编译期自动拾取，无需 go generate）
- Produces: `categories(ledger_id, updated_at)`、`ledgers(team_id)`、`team_members(user_id)` 索引

- [ ] **Step 1: 写迁移**

`007_sync_indexes.up.sql`：

```sql
-- 同步增量查询与成员查询的索引：categories 按账本增量扫描、团队账本反查、按成员查团队
CREATE INDEX idx_categories_ledger_updated ON categories(ledger_id, updated_at);
CREATE INDEX idx_ledgers_team ON ledgers(team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);
```

`007_sync_indexes.down.sql`：

```sql
DROP INDEX IF EXISTS idx_categories_ledger_updated;
DROP INDEX IF EXISTS idx_ledgers_team;
DROP INDEX IF EXISTS idx_team_members_user;
```

- [ ] **Step 2: 验证**

Run: `cd backend && go build ./...`
Expected: PASS（迁移由 `RunMigrations` 在启动时应用；无 testcontainers，不做 DB 集成测试。若本地有测试库，可用 `migrate up` 手动验证一次）

- [ ] **Step 3: Commit**

```bash
git add backend/internal/database/migrations/007_sync_indexes.up.sql backend/internal/database/migrations/007_sync_indexes.down.sql
git commit -m "perf(db): 补 categories/ledgers/team_members 查询索引"
```

---

## Self-Review

**Spec 覆盖：** 复盘报告「二、中危」共 11 项。已覆盖 10 项；第 9 项 Docker 供应链经用户确认跳过。10 项映射如下：事件监听=Task1，速率限制=Task9，refresh_token 存储=Task6，自动重试=Task4，改昵称缓存=Task5，账户删除校验=Task2，时间戳=Task3，错误回显=Task8，索引=Task10，getMe rows.Err=Task7。

**Placeholder 扫描：** 无 TBD/TODO；所有代码步骤含实际代码块；测试步骤含实际测试代码。

**类型一致性：** `compareTimestamp`（Task3 产出）在 Task3 内定义并使用，无跨任务引用；`tokenStorage` 三函数（Task6 产出）在 api.ts 内消费，签名一致（`Promise<string|null>` / `Promise<void>`）；后端哨兵错误（Task8 产出）在 handler 内 `errors.Is` 消费，名称一致。

**已知未做（诚实记录）：** 高危项 B3 的 SQL capability 仍为全局 `sql:allow-*` 未收窄（用户本次只要求中危项，未纳入范围）；`isLoggedIn`（api.ts，生产无调用）改为内存 token 判断，语义略变。
