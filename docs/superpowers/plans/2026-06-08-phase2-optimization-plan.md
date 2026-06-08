# Phase 2 账户管理优化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 对 Phase 2 账户管理闭环进行三维优化：状态栏安全区适配、导航流程重构（点击→流水页→编辑页）、账户类型体系重构（资产/负债分离 + 净资产汇总）。

**Architecture:** 类型体系和数据库变更先行（底层），再依次改造 store → 组件 → 视图。新增两个页面（TransactionList 占位、AccountEdit 完整编辑表单）和一个通用组件（ConfirmDialog）。AccountSheet 去编辑化，仅保留新增模式。

**Tech Stack:** Vue 3.5 + TypeScript + Pinia + vue-router + SQLite + Tailwind CSS v4

---

## 文件变更总览

```
修改文件:
  index.html                       # viewport-fit=cover
  src/assets/main.css              # 安全区 CSS + body padding
  src/types/index.ts               # 类型体系重构
  src/db/index.ts                  # accounts 表新增 category/credit_limit/repayment_day
  src/stores/account.ts            # BALANCE_QUERY 更新，add/update 适配新字段
  src/stores/__tests__/account.test.ts  # 测试适配新类型和字段
  src/router/index.ts              # 新增两条路由
  src/components/AppHeader.vue     # 安全区 padding + 右侧操作插槽
  src/components/AccountCard.vue   # 移除长按逻辑
  src/components/AccountSheet.vue  # 去编辑化，仅新增；负债类型条件字段
  src/views/AccountList.vue        # 导航变更 + 净资产显示

新建文件:
  src/components/ConfirmDialog.vue  # 确认对话框
  src/views/TransactionList.vue     # 流水占位页
  src/views/AccountEdit.vue         # 编辑页
```

---

### Task 1: 类型体系重构

**Files:**
- Modify: `src/types/index.ts`

这是所有后续任务的基础，先改类型。

- [ ] **Step 1: 更新类型定义**

Replace `src/types/index.ts`:

```typescript
export type AccountCategory = "asset" | "liability";
export type AssetType = "cash" | "bank" | "digital";
export type LiabilityType = "credit_card" | "huabei" | "meituan_monthly" | "other_loan";
export type AccountType = AssetType | LiabilityType;

export const ACCOUNT_CATEGORY: Record<AccountType, AccountCategory> = {
  cash: "asset",
  bank: "asset",
  digital: "asset",
  credit_card: "liability",
  huabei: "liability",
  meituan_monthly: "liability",
  other_loan: "liability",
};

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: "现金",
  bank: "银行卡",
  digital: "电子钱包",
  credit_card: "信用卡",
  huabei: "花呗",
  meituan_monthly: "美团月付",
  other_loan: "其他借贷",
};

export interface Account {
  id: string;
  ledger_id: string;
  owner_id: string;
  name: string;
  type: AccountType;
  category?: AccountCategory;
  initial_balance: number;
  credit_limit?: number;
  repayment_day?: number;
  color: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  current_balance?: number;
}

export interface Ledger {
  id: string;
  name: string;
  type: "personal" | "team";
  team_id: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface User {
  id: string;
  nickname: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: 验证类型编译**

```bash
npx vue-tsc --noEmit 2>&1 | head -30
```

Expected: 会有其他文件的类型错误（因为类型变了但引用还没更新），但 `src/types/index.ts` 本身不应报错。

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "refactor: restructure account types with asset/liability categories"
```

---

### Task 2: 数据库 schema 更新

**Files:**
- Modify: `src/db/index.ts`

处于开发初期、无数据需保留，直接修改 `initTables` 中的 `CREATE TABLE`。

- [ ] **Step 1: 更新 accounts 表定义**

Edit `src/db/index.ts`，将 accounts 的 `CREATE TABLE` 替换为：

```typescript
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      ledger_id TEXT REFERENCES ledgers(id) NOT NULL,
      owner_id TEXT REFERENCES users(id) NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'bank',
      category TEXT NOT NULL DEFAULT 'asset',
      initial_balance REAL NOT NULL DEFAULT 0.00,
      credit_limit REAL,
      repayment_day INTEGER,
      color TEXT DEFAULT '#3b82f6',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );
```

原来没有 `category`、`credit_limit`、`repayment_day` 字段，现在新增。注意原来也没有 `transactions` 表的定义，需要确认 — 实际上现在的 `initTables` 已经包含了 transactions 表。只需替换 accounts 部分的 CREATE TABLE 即可。

- [ ] **Step 2: 验证 cargo check**

```bash
cargo check 2>&1 | tail -5
```

Expected: 编译成功（Rust 端不受影响）。

- [ ] **Step 3: Commit**

```bash
git add src/db/index.ts
git commit -m "feat: add category, credit_limit, repayment_day to accounts table"
```

---

### Task 3: 更新 accountStore (BALANCE_QUERY + add/update)

**Files:**
- Modify: `src/stores/account.ts`

这是三个维度同时修改：BALANCE_QUERY 引入 category 分支计算、add 适配新字段、update 适配新字段。

- [ ] **Step 1: 更新 BALANCE_QUERY 和 add/update 方法**

Replace `src/stores/account.ts`:

```typescript
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getDb } from "@/db";
import type { Account, AccountType } from "@/types";

const BALANCE_QUERY = `
  SELECT
    a.id, a.ledger_id, a.owner_id, a.name, a.type, a.category,
    a.initial_balance, a.credit_limit, a.repayment_day,
    a.color, a.created_at, a.updated_at, a.is_deleted,
    CASE WHEN a.category = 'liability'
      THEN -ABS(
        a.initial_balance
        + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
        - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
      )
      ELSE (
        a.initial_balance
        + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
        - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
      )
    END AS current_balance
  FROM accounts a
  WHERE a.ledger_id = ? AND a.is_deleted = 0
  ORDER BY a.created_at DESC
`;

function generateId(): string {
  return crypto.randomUUID();
}

export const useAccountStore = defineStore("account", () => {
  const accounts = ref<Account[]>([]);

  const totalBalance = computed(() =>
    accounts.value.reduce((sum, a) => sum + (a.current_balance ?? 0), 0)
  );

  const assetsTotal = computed(() =>
    accounts.value
      .filter((a) => a.category === "asset")
      .reduce((sum, a) => sum + (a.current_balance ?? 0), 0)
  );

  const liabilitiesTotal = computed(() =>
    accounts.value
      .filter((a) => a.category === "liability")
      .reduce((sum, a) => sum + (a.current_balance ?? 0), 0)
  );

  const netAssets = computed(() => assetsTotal.value + liabilitiesTotal.value);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<(Account & { is_deleted: number | boolean })[]>(
      BALANCE_QUERY,
      [ledgerId]
    );
    accounts.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  async function add(input: {
    ledger_id: string;
    owner_id: string;
    name: string;
    type: AccountType;
    category: string;
    initial_balance: number;
    credit_limit?: number;
    repayment_day?: number;
    color: string;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = generateId();
    await db.execute(
      `INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ledger_id,
        input.owner_id,
        input.name,
        input.type,
        input.category,
        input.initial_balance,
        input.credit_limit ?? null,
        input.repayment_day ?? null,
        input.color,
        now,
        now,
      ]
    );
    await fetchAll(input.ledger_id);
  }

  async function update(
    id: string,
    data: Partial<Pick<Account, "name" | "type" | "category" | "initial_balance" | "credit_limit" | "repayment_day" | "color">>
  ): Promise<void> {
    const db = await getDb();
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.name !== undefined) {
      sets.push("name = ?");
      values.push(data.name);
    }
    if (data.type !== undefined) {
      sets.push("type = ?");
      values.push(data.type);
    }
    if (data.category !== undefined) {
      sets.push("category = ?");
      values.push(data.category);
    }
    if (data.initial_balance !== undefined) {
      sets.push("initial_balance = ?");
      values.push(data.initial_balance);
    }
    if (data.credit_limit !== undefined) {
      sets.push("credit_limit = ?");
      values.push(data.credit_limit);
    }
    if (data.repayment_day !== undefined) {
      sets.push("repayment_day = ?");
      values.push(data.repayment_day);
    }
    if (data.color !== undefined) {
      sets.push("color = ?");
      values.push(data.color);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    await db.execute(
      `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`,
      values
    );
    const existing = accounts.value.find((a) => a.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id);
    }
  }

  async function remove(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.execute(
      "UPDATE accounts SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    const existing = accounts.value.find((a) => a.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id);
    }
  }

  return { accounts, totalBalance, assetsTotal, liabilitiesTotal, netAssets, fetchAll, add, update, remove };
});
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/account.ts
git commit -m "feat: update accountStore with liability balance calc and new fields"
```

---

### Task 4: 更新 accountStore 单元测试

**Files:**
- Modify: `src/stores/__tests__/account.test.ts`

适配新类型、新字段和新的 add 签名。

- [ ] **Step 1: 先运行测试确认当前状态**

```bash
npx vitest run src/stores/__tests__/account.test.ts 2>&1
```

Expected: FAIL（因为 store 的 add `input` 类型变了，测试里的 `makeAccount` 缺少 category 等字段）。

- [ ] **Step 2: 更新测试文件**

Replace `src/stores/__tests__/account.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock db 模块
const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

vi.mock("@/db", () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
  ensureDefaultData: vi.fn(() => Promise.resolve()),
}));

import { useAccountStore } from "@/stores/account";
import type { Account } from "@/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    ledger_id: "personal-ledger-1",
    owner_id: "local-user-1",
    name: "测试账户",
    type: "bank",
    category: "asset",
    initial_balance: 100,
    color: "#3b82f6",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    is_deleted: false,
    current_balance: 100,
    ...overrides,
  };
}

describe("accountStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load accounts from db and set current_balance", async () => {
      const rows = [
        {
          id: "acc-1",
          ledger_id: "pl-1",
          owner_id: "u-1",
          name: "招商储蓄卡",
          type: "bank",
          category: "asset",
          initial_balance: 5000,
          credit_limit: null,
          repayment_day: null,
          color: "#ef4444",
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
          is_deleted: 0,
          current_balance: 5200,
        },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.accounts).toHaveLength(1);
      expect(store.accounts[0].name).toBe("招商储蓄卡");
      expect(store.accounts[0].current_balance).toBe(5200);
      expect(mockDb.select).toHaveBeenCalledWith(expect.stringContaining("SUM"), ["pl-1"]);
    });

    it("should return empty array when no accounts exist", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.accounts).toHaveLength(0);
    });
  });

  describe("totalBalance", () => {
    it("should compute sum of all current_balance values", async () => {
      const rows = [
        { ...makeAccount({ id: "a1", current_balance: 100 }), is_deleted: 0 },
        { ...makeAccount({ id: "a2", current_balance: -50 }), is_deleted: 0 },
        { ...makeAccount({ id: "a3", current_balance: 200 }), is_deleted: 0 },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.totalBalance).toBe(250);
    });
  });

  describe("netAssets", () => {
    it("should compute net assets as assets - liabilities", async () => {
      const rows = [
        { ...makeAccount({ id: "a1", category: "asset", current_balance: 50000, type: "bank" }), is_deleted: 0 },
        { ...makeAccount({ id: "a2", category: "asset", current_balance: 10000, type: "digital" }), is_deleted: 0 },
        { ...makeAccount({ id: "a3", category: "liability", current_balance: -37500, type: "credit_card" }), is_deleted: 0 },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.assetsTotal).toBe(60000);
      expect(store.liabilitiesTotal).toBe(-37500);
      expect(store.netAssets).toBe(22500);
    });
  });

  describe("add", () => {
    it("should insert account with category and new fields, then refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);
      // 第一次是 add 里的 INSERT 后 fetchAll
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ name: "新信用卡", type: "credit_card", category: "liability" }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.add({
        ledger_id: "pl-1",
        owner_id: "u-1",
        name: "新信用卡",
        type: "credit_card",
        category: "liability",
        initial_balance: 0,
        credit_limit: 50000,
        repayment_day: 15,
        color: "#ef4444",
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO accounts"),
        expect.arrayContaining(["新信用卡", "credit_card", "liability", 50000, 15, "#ef4444"])
      );
    });
  });

  describe("update", () => {
    it("should update account and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ id: "a1", name: "改名后" }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.update("a1", { name: "改名后", color: "#000000" });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        expect.arrayContaining(["改名后", "#000000", "a1"])
      );
    });

    it("should update liability fields", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ id: "a1", type: "credit_card", category: "liability", credit_limit: 80000, repayment_day: 10 }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.update("a1", { credit_limit: 80000, repayment_day: 10 });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        expect.arrayContaining([80000, 10, "a1"])
      );
    });
  });

  describe("remove", () => {
    it("should soft-delete and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useAccountStore();
      await store.remove("a1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["a1"])
      );
    });
  });
});
```

- [ ] **Step 3: 运行测试确认通过**

```bash
npx vitest run src/stores/__tests__/account.test.ts 2>&1
```

Expected: 所有 8 个测试 PASS。

- [ ] **Step 4: Commit**

```bash
git add src/stores/__tests__/account.test.ts
git commit -m "test: update accountStore tests for new type system and liability fields"
```

---

### Task 5: 状态栏安全区适配

**Files:**
- Modify: `index.html`
- Modify: `src/assets/main.css`

- [ ] **Step 1: 更新 viewport meta**

Edit `index.html`，在 `<meta name="viewport">` 中添加 `viewport-fit=cover`：

```html
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

- [ ] **Step 2: 更新 CSS 安全区**

Edit `src/assets/main.css`，在 `@theme` 块后添加安全区规则：

```css
@import "tailwindcss";

@theme {
  --color-primary: #3b82f6;
  --color-primary-dark: #2563eb;
  --color-expense: #ef4444;
  --color-income: #22c55e;
  --color-bg: #f8fafc;
  --color-surface: #ffffff;
  --color-text: #0f172a;
  --color-text-secondary: #64748b;
}

body {
  padding-top: env(safe-area-inset-top);
}
```

- [ ] **Step 3: Commit**

```bash
git add index.html src/assets/main.css
git commit -m "feat: add safe-area-inset-top support for status bar adaptation"
```

---

### Task 6: 路由新增两条 + AppHeader 改造

**Files:**
- Modify: `src/router/index.ts`
- Modify: `src/components/AppHeader.vue`

路由新增和 AppHeader 安全区 + 右侧插槽一起做，因为 TransactionList 和 AccountEdit 立即可用。

- [ ] **Step 1: 更新路由**

Replace `src/router/index.ts`:

```typescript
import { createRouter, createWebHistory } from "vue-router";
import Home from "@/views/Home.vue";
import AccountList from "@/views/AccountList.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: Home,
    },
    {
      path: "/accounts",
      name: "accounts",
      component: AccountList,
    },
    {
      path: "/accounts/:id/transactions",
      name: "account-transactions",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/accounts/:id/edit",
      name: "account-edit",
      component: () => import("@/views/AccountEdit.vue"),
    },
  ],
});

export default router;
```

使用懒加载 (`() => import(...)`) 避免首屏加载编辑页和流水页。

- [ ] **Step 2: 更新 AppHeader 添加安全区 padding 和右侧操作插槽**

Replace `src/components/AppHeader.vue`:

```vue
<script setup lang="ts">
import { ArrowLeft } from "lucide-vue-next";

defineProps<{
  title: string;
  showBack?: boolean;
}>();

defineEmits<{
  back: [];
}>();
</script>

<template>
  <header
    class="flex h-14 items-center border-b border-gray-200 bg-surface px-4 pt-[env(safe-area-inset-top)]"
  >
    <button
      v-if="showBack"
      class="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
      @click="$emit('back')"
    >
      <ArrowLeft :size="20" class="text-text" />
    </button>
    <h1 class="flex-1 text-lg font-semibold text-text">{{ title }}</h1>
    <slot name="action" />
  </header>
</template>
```

要点：
- `pt-[env(safe-area-inset-top)]` 让 header 的背景色（`bg-surface`）延伸到安全区
- 标题使用 `flex-1` 使其撑满中间空间
- 添加 `<slot name="action" />` 命名插槽，供编辑按钮和删除按钮使用

- [ ] **Step 3: Commit**

```bash
git add src/router/index.ts src/components/AppHeader.vue
git commit -m "feat: add TransactionList and AccountEdit routes, AppHeader safe-area + action slot"
```

---

### Task 7: 创建 ConfirmDialog 组件

**Files:**
- Create: `src/components/ConfirmDialog.vue`

- [ ] **Step 1: 创建 ConfirmDialog**

Create `src/components/ConfirmDialog.vue`:

```vue
<script setup lang="ts">
defineProps<{
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        @click.self="$emit('cancel')"
      >
        <Transition name="scale">
          <div
            v-if="visible"
            class="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
          >
            <h3 class="text-base font-semibold text-text">{{ title }}</h3>
            <p v-if="description" class="mt-2 text-sm text-text-secondary">
              {{ description }}
            </p>
            <div class="mt-6 flex gap-3">
              <button
                class="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
                @click="$emit('cancel')"
              >
                {{ cancelText || "取消" }}
              </button>
              <button
                class="flex-1 rounded-xl py-2.5 text-sm font-medium text-white transition-colors"
                :class="danger ? 'bg-expense hover:bg-red-600' : 'bg-primary hover:bg-primary-dark'"
                @click="$emit('confirm')"
              >
                {{ confirmText || "确认" }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}
.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ConfirmDialog.vue
git commit -m "feat: add ConfirmDialog component with Teleport and scale animation"
```

---

### Task 8: AccountCard 移除长按逻辑 + 负债账户余额显示适配

**Files:**
- Modify: `src/components/AccountCard.vue`

- [ ] **Step 1: 简化 AccountCard**

Replace `src/components/AccountCard.vue`:

```vue
<script setup lang="ts">
import {
  Building2,
  CreditCard,
  Smartphone,
  Banknote,
  Wallet,
  Scale,
} from "lucide-vue-next";
import type { Account, AccountType } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { computed } from "vue";

const props = defineProps<{
  account: Account;
}>();

defineEmits<{
  tap: [];
}>();

const iconMap: Record<AccountType, typeof Building2> = {
  cash: Banknote,
  bank: Building2,
  digital: Smartphone,
  credit_card: CreditCard,
  huabei: Wallet,
  meituan_monthly: Wallet,
  other_loan: Scale,
};

const typeLabel = computed(() => ACCOUNT_TYPE_LABELS[props.account.type]);

function formatBalance(value: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-¥${formatted}` : `¥${formatted}`;
}

const balanceClass = computed(() => {
  const bal = props.account.current_balance ?? 0;
  if (props.account.category === "liability" && bal < 0) {
    return "text-expense";
  }
  return "text-text";
});
</script>

<template>
  <div
    class="flex cursor-pointer items-center gap-3 rounded-xl bg-surface p-4 shadow-sm transition-shadow hover:shadow-md"
    :style="{ borderLeft: `4px solid ${account.color}` }"
    @click="$emit('tap')"
  >
    <div
      class="flex h-10 w-10 items-center justify-center rounded-full"
      :style="{ backgroundColor: `${account.color}20` }"
    >
      <component :is="iconMap[account.type]" :size="20" :style="{ color: account.color }" />
    </div>
    <div class="flex-1">
      <p class="text-sm font-medium text-text">{{ account.name }}</p>
      <p class="text-xs text-text-secondary">{{ typeLabel }}</p>
    </div>
    <div class="text-right">
      <p class="text-base font-semibold" :class="balanceClass">
        {{ formatBalance(account.current_balance ?? 0) }}
      </p>
    </div>
  </div>
</template>
```

要点：
- 移除 `longpress` emit 和所有 touch 事件处理
- 移除 `longPressed` 变量和 `onTouchStart/onTouchEnd/onClick` 函数
- `@click` 直接 emit `tap`
- 新增 icon 映射：`cash=Bannote`、`huabei/meituan_monthly=Wallet`、`other_loan=Scale`
- 余额颜色判断改为基于 `category === "liability"` 而非 `balance < 0`

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountCard.vue
git commit -m "refactor: remove long-press from AccountCard, add liability icons and color logic"
```

---

### Task 9: AccountSheet 去编辑化 + 资产/负债分组

**Files:**
- Modify: `src/components/AccountSheet.vue`

仅保留新增模式，类型选择按资产/负债分组，选中负债类型后显示信用额度和还款日字段。

- [ ] **Step 1: 重写 AccountSheet**

Replace `src/components/AccountSheet.vue`:

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import {
  X,
  Building2,
  CreditCard,
  Smartphone,
  Banknote,
  Wallet,
  Scale,
} from "lucide-vue-next";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY, ACCOUNT_TYPE_LABELS } from "@/types";
import { computed } from "vue";

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    data: {
      name: string;
      type: AccountType;
      initial_balance: number;
      credit_limit?: number;
      repayment_day?: number;
      color: string;
    }
  ];
}>();

const name = ref("");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const creditLimit = ref("");
const repaymentDay = ref("");
const color = ref("#3b82f6");

const ASSET_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "cash", icon: Banknote },
  { type: "bank", icon: Building2 },
  { type: "digital", icon: Smartphone },
];

const LIABILITY_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "credit_card", icon: CreditCard },
  { type: "huabei", icon: Wallet },
  { type: "meituan_monthly", icon: Wallet },
  { type: "other_loan", icon: Scale },
];

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#64748b",
];

const isLiability = computed(() => ACCOUNT_CATEGORY[accountType.value] === "liability");

// 重置表单
watch(() => props.visible, (v) => {
  if (v) {
    name.value = "";
    accountType.value = "bank";
    initialBalance.value = "0";
    creditLimit.value = "";
    repaymentDay.value = "";
    color.value = "#3b82f6";
  }
});

function handleSubmit() {
  if (!name.value.trim()) return;
  emit("submit", {
    name: name.value.trim(),
    type: accountType.value,
    initial_balance: parseFloat(initialBalance.value) || 0,
    color: color.value,
    credit_limit: creditLimit.value ? parseFloat(creditLimit.value) : undefined,
    repayment_day: repaymentDay.value ? parseInt(repaymentDay.value, 10) : undefined,
  });
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
    <Transition name="fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <!-- 面板 -->
    <Transition name="slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">添加账户</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <!-- 名称 -->
        <label class="mb-1 block text-sm font-medium text-text">账户名称</label>
        <input
          v-model="name"
          type="text"
          placeholder="如：招商储蓄卡"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

        <!-- 资产类型 -->
        <label class="mb-2 block text-sm font-medium text-text">资产账户</label>
        <div class="mb-2 grid grid-cols-3 gap-2">
          <button
            v-for="item in ASSET_TYPES"
            :key="item.type"
            class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
            :class="
              accountType === item.type
                ? 'bg-primary text-white'
                : 'bg-gray-100 text-text-secondary'
            "
            @click="accountType = item.type"
          >
            <component :is="item.icon" :size="18" />
            <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
          </button>
        </div>

        <!-- 负债类型 -->
        <label class="mb-2 block text-sm font-medium text-text">负债账户</label>
        <div class="mb-4 grid grid-cols-4 gap-2">
          <button
            v-for="item in LIABILITY_TYPES"
            :key="item.type"
            class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
            :class="
              accountType === item.type
                ? 'bg-primary text-white'
                : 'bg-gray-100 text-text-secondary'
            "
            @click="accountType = item.type"
          >
            <component :is="item.icon" :size="18" />
            <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
          </button>
        </div>

        <!-- 初始余额 -->
        <label class="mb-1 block text-sm font-medium text-text">初始余额</label>
        <input
          v-model="initialBalance"
          type="number"
          step="0.01"
          placeholder="0.00"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

        <!-- 负债条件字段 -->
        <template v-if="isLiability">
          <label class="mb-1 block text-sm font-medium text-text">信用额度（选填）</label>
          <input
            v-model="creditLimit"
            type="number"
            step="0.01"
            placeholder="如：50000"
            class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
          <label class="mb-1 block text-sm font-medium text-text">还款日（选填）</label>
          <input
            v-model="repaymentDay"
            type="number"
            min="1"
            max="31"
            placeholder="如：15"
            class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
        </template>

        <!-- 颜色选择 -->
        <label class="mb-2 block text-sm font-medium text-text">颜色标记</label>
        <div class="mb-4 flex gap-2">
          <button
            v-for="c in COLORS"
            :key="c"
            class="h-8 w-8 rounded-full border-2 transition-transform"
            :class="color === c ? 'scale-110 border-gray-800' : 'border-transparent'"
            :style="{ backgroundColor: c }"
            @click="color = c"
          />
        </div>

        <!-- 提交 -->
        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          :disabled="!name.trim()"
          @click="handleSubmit"
        >
          添加
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.25s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountSheet.vue
git commit -m "refactor: simplify AccountSheet to create-only mode with asset/liability groups"
```

---

### Task 10: 创建 TransactionList 占位页

**Files:**
- Create: `src/views/TransactionList.vue`

- [ ] **Step 1: 创建 TransactionList**

Create `src/views/TransactionList.vue`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Pencil } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import AppHeader from "@/components/AppHeader.vue";

const route = useRoute();
const router = useRouter();
const accountStore = useAccountStore();

const accountId = computed(() => route.params.id as string);
const account = computed(() =>
  accountStore.accounts.find((a) => a.id === accountId.value)
);

function goBack() {
  router.push("/accounts");
}

function goEdit() {
  router.push(`/accounts/${accountId.value}/edit`);
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader
      :title="account?.name ?? '流水'"
      :show-back="true"
      @back="goBack"
    >
      <template #action>
        <button
          v-if="account"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="goEdit"
        >
          <Pencil :size="18" class="text-text-secondary" />
        </button>
      </template>
    </AppHeader>

    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <p class="text-4xl">📋</p>
        <p class="mt-3 text-text-secondary">暂无流水记录</p>
        <p class="mt-1 text-xs text-text-secondary">
          记账功能将在后续版本中开放
        </p>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: add TransactionList placeholder page with edit button"
```

---

### Task 11: 创建 AccountEdit 编辑页

**Files:**
- Create: `src/views/AccountEdit.vue`

- [ ] **Step 1: 创建 AccountEdit**

Create `src/views/AccountEdit.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Trash2,
  Building2,
  CreditCard,
  Smartphone,
  Banknote,
  Wallet,
  Scale,
} from "lucide-vue-next";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY, ACCOUNT_TYPE_LABELS } from "@/types";
import { useAccountStore } from "@/stores/account";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";

const route = useRoute();
const router = useRouter();
const accountStore = useAccountStore();

const accountId = computed(() => route.params.id as string);
const account = computed(() =>
  accountStore.accounts.find((a) => a.id === accountId.value)
);

const name = ref("");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const creditLimit = ref("");
const repaymentDay = ref("");
const color = ref("#3b82f6");

const deleteDialogVisible = ref(false);
const saving = ref(false);

const ASSET_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "cash", icon: Banknote },
  { type: "bank", icon: Building2 },
  { type: "digital", icon: Smartphone },
];

const LIABILITY_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "credit_card", icon: CreditCard },
  { type: "huabei", icon: Wallet },
  { type: "meituan_monthly", icon: Wallet },
  { type: "other_loan", icon: Scale },
];

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#64748b",
];

const isLiability = computed(() => ACCOUNT_CATEGORY[accountType.value] === "liability");

onMounted(() => {
  if (account.value) {
    name.value = account.value.name;
    accountType.value = account.value.type;
    initialBalance.value = String(account.value.initial_balance);
    creditLimit.value = account.value.credit_limit ? String(account.value.credit_limit) : "";
    repaymentDay.value = account.value.repayment_day ? String(account.value.repayment_day) : "";
    color.value = account.value.color;
  }
});

async function handleSave() {
  if (!name.value.trim() || saving.value) return;
  saving.value = true;
  try {
    await accountStore.update(accountId.value, {
      name: name.value.trim(),
      type: accountType.value,
      category: ACCOUNT_CATEGORY[accountType.value],
      initial_balance: parseFloat(initialBalance.value) || 0,
      credit_limit: creditLimit.value ? parseFloat(creditLimit.value) : undefined,
      repayment_day: repaymentDay.value ? parseInt(repaymentDay.value, 10) : undefined,
      color: color.value,
    });
    router.back();
  } catch (e) {
    console.error("Save failed:", e);
  } finally {
    saving.value = false;
  }
}

async function handleDelete() {
  await accountStore.remove(accountId.value);
  router.replace("/accounts");
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader
      title="编辑账户"
      :show-back="true"
      @back="router.back()"
    >
      <template #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="deleteDialogVisible = true"
        >
          <Trash2 :size="18" class="text-expense" />
        </button>
      </template>
    </AppHeader>

    <div v-if="account" class="flex-1 overflow-auto px-4 py-4">
      <!-- 名称 -->
      <label class="mb-1 block text-sm font-medium text-text">账户名称</label>
      <input
        v-model="name"
        type="text"
        placeholder="如：招商储蓄卡"
        class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      />

      <!-- 资产类型 -->
      <label class="mb-2 block text-sm font-medium text-text">资产账户</label>
      <div class="mb-2 grid grid-cols-3 gap-2">
        <button
          v-for="item in ASSET_TYPES"
          :key="item.type"
          class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
          :class="
            accountType === item.type
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'
          "
          @click="accountType = item.type"
        >
          <component :is="item.icon" :size="18" />
          <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
        </button>
      </div>

      <!-- 负债类型 -->
      <label class="mb-2 block text-sm font-medium text-text">负债账户</label>
      <div class="mb-4 grid grid-cols-4 gap-2">
        <button
          v-for="item in LIABILITY_TYPES"
          :key="item.type"
          class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
          :class="
            accountType === item.type
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'
          "
          @click="accountType = item.type"
        >
          <component :is="item.icon" :size="18" />
          <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
        </button>
      </div>

      <!-- 初始余额 -->
      <label class="mb-1 block text-sm font-medium text-text">初始余额</label>
      <input
        v-model="initialBalance"
        type="number"
        step="0.01"
        placeholder="0.00"
        class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      />

      <!-- 负债条件字段 -->
      <template v-if="isLiability">
        <label class="mb-1 block text-sm font-medium text-text">信用额度（选填）</label>
        <input
          v-model="creditLimit"
          type="number"
          step="0.01"
          placeholder="如：50000"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
        <label class="mb-1 block text-sm font-medium text-text">还款日（选填）</label>
        <input
          v-model="repaymentDay"
          type="number"
          min="1"
          max="31"
          placeholder="如：15"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </template>

      <!-- 颜色选择 -->
      <label class="mb-2 block text-sm font-medium text-text">颜色标记</label>
      <div class="mb-6 flex gap-2">
        <button
          v-for="c in COLORS"
          :key="c"
          class="h-8 w-8 rounded-full border-2 transition-transform"
          :class="color === c ? 'scale-110 border-gray-800' : 'border-transparent'"
          :style="{ backgroundColor: c }"
          @click="color = c"
        />
      </div>
    </div>

    <div v-else class="flex flex-1 items-center justify-center">
      <p class="text-text-secondary">账户不存在</p>
    </div>

    <!-- 底部保存按钮 -->
    <div v-if="account" class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        :disabled="!name.trim() || saving"
        @click="handleSave"
      >
        {{ saving ? "保存中..." : "保存" }}
      </button>
    </div>

    <!-- 删除确认对话框 -->
    <ConfirmDialog
      :visible="deleteDialogVisible"
      :title="`确定删除账户\"${account?.name ?? ''}\"吗？`"
      description="删除后不可恢复"
      confirm-text="删除"
      :danger="true"
      @confirm="handleDelete"
      @cancel="deleteDialogVisible = false"
    />
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/AccountEdit.vue
git commit -m "feat: add AccountEdit page with full form, save and delete flow"
```

---

### Task 12: 更新 AccountList — 导航 + 净资产汇总

**Files:**
- Modify: `src/views/AccountList.vue`

- [ ] **Step 1: 重写 AccountList 导航和汇总逻辑**

Replace `src/views/AccountList.vue`:

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Plus } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import AppHeader from "@/components/AppHeader.vue";
import AccountCard from "@/components/AccountCard.vue";
import AccountSheet from "@/components/AccountSheet.vue";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY } from "@/types";

const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();

const sheetVisible = ref(false);
const isLoading = ref(true);

onMounted(async () => {
  try {
    await ledgerStore.init();
    if (ledgerStore.currentLedger) {
      await accountStore.fetchAll(ledgerStore.currentLedger.id);
    }
  } catch (e) {
    console.error("Failed to load accounts:", e);
  } finally {
    isLoading.value = false;
  }
});

function openAdd() {
  sheetVisible.value = true;
}

function goTransactions(accountId: string) {
  router.push(`/accounts/${accountId}/transactions`);
}

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
    owner_id: ledgerStore.currentLedger.owner_id,
    category: ACCOUNT_CATEGORY[data.type],
    ...data,
  });
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="账户管理" :show-back="true" @back="router.push('/')" />

    <!-- 净资产汇总 -->
    <div class="bg-surface px-4 py-4">
      <p class="text-xs text-text-secondary">净资产</p>
      <p class="mt-0.5 text-2xl font-bold text-text">
        ¥{{ accountStore.netAssets.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </p>
      <div class="mt-2 flex gap-6 text-xs">
        <span class="text-text-secondary">
          资产 ¥{{ accountStore.assetsTotal.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </span>
        <span class="text-text-secondary">
          负债 ¥{{ Math.abs(accountStore.liabilitiesTotal).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </span>
      </div>
    </div>

    <!-- 账户列表 -->
    <div class="flex-1 overflow-auto px-4 py-3">
      <div v-if="isLoading" class="py-12 text-center text-text-secondary">
        加载中...
      </div>

      <div v-else-if="accountStore.accounts.length === 0" class="py-12 text-center">
        <p class="text-text-secondary">还没有账户</p>
        <button
          class="mt-3 text-sm text-primary underline"
          @click="openAdd"
        >
          添加第一个账户
        </button>
      </div>

      <div v-else class="flex flex-col gap-2">
        <AccountCard
          v-for="account in accountStore.accounts"
          :key="account.id"
          :account="account"
          @tap="goTransactions(account.id)"
        />
      </div>
    </div>

    <!-- 底部添加按钮 -->
    <div class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary py-3 text-white transition-colors hover:bg-primary-dark"
        @click="openAdd"
      >
        <Plus :size="20" />
        <span class="text-base font-medium">添加账户</span>
      </button>
    </div>

    <!-- 新增 Sheet -->
    <AccountSheet
      :visible="sheetVisible"
      @close="sheetVisible = false"
      @submit="handleSubmit"
    />
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add src/views/AccountList.vue
git commit -m "feat: update AccountList with net asset summary and tap-to-transactions navigation"
```

---

### Task 13: 收尾 — 全链路验证

**Files:** 无新建，验证所有变更。

- [ ] **Step 1: 运行单元测试**

```bash
npx vitest run 2>&1
```

Expected: 全部 8 个测试 PASS。

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx vue-tsc --noEmit 2>&1
```

Expected: 无类型错误。

- [ ] **Step 3: Rust 编译检查**

```bash
cargo check 2>&1 | tail -5
```

Expected: 编译成功。

- [ ] **Step 4: 生产构建验证**

```bash
npm run build 2>&1
```

Expected: Vite build 成功，`dist/` 目录生成。

- [ ] **Step 5: 最终 commit**

```bash
git add README.md
git commit -m "docs: update README with Phase 2 optimization changes"
```

---

## 验证清单

所有任务完成后，逐项验证：
1. `npx vitest run` — 所有测试通过
2. `npx vue-tsc --noEmit` — 无类型错误
3. `cargo check` — Rust 端编译成功
4. `npm run build` — 生产构建成功
