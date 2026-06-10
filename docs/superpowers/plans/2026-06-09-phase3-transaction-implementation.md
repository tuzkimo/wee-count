# Phase 3 记账交易闭环 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现完整的记账-查看-编辑闭环：分类 + 标签 + 交易 CRUD + 底部 Tab 导航。

**Architecture:** 新增 3 个 Pinia store（category/tag/transaction），4 个页面（RecordPage/TagSheet/TransactionList/SettingsPage），重构路由和 App.vue 添加底部 Tab 栏。数据库新增 categories/tags/transaction_tags 三张表，transactions 表通过 PRAGMA 迁移新增 category_id/user_id/occurred_at 列。

**Tech Stack:** Vue 3 + TypeScript + Pinia + Vue Router + SQLite (@tauri-apps/plugin-sql) + Tailwind CSS 4

---

### Task 1: 类型定义 — 新增 Category/Tag，更新 Transaction

**Files:**
- Modify: `src/types/index.ts`

- [ ] **Step 1: 添加新类型定义**

在 `src/types/index.ts` 中，在 `AccountType` 之后、`ACCOUNT_CATEGORY` 之前插入新类型，并在文件末尾更新 `Transaction` 接口：

```typescript
// 在 "export type AccountType = AssetType | LiabilityType;" 之后插入：

export type CategoryType = "income" | "expense";
export type TransactionType = "income" | "expense" | "transfer";

export interface Category {
  id: string;
  ledger_id: string | null;
  name: string;
  type: CategoryType;
  icon: string | null;
  sort_order: number;
  updated_at: string;
  is_deleted: boolean;
}

export interface Tag {
  id: string;
  ledger_id: string;
  name: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface Transaction {
  id: string;
  ledger_id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  // 查询时 JOIN 填充
  category?: Category;
  tags?: Tag[];
  from_account?: Account;
  to_account?: Account;
}
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add Category, Tag, Transaction types"
```

---

### Task 2: 数据库 — 建表 + 迁移 + 预设分类

**Files:**
- Modify: `src/db/index.ts`

- [ ] **Step 1: 在 `initTables` 中添加 categories/tags/transaction_tags 建表语句**

在 `initTables` 函数的 `db.execute` 调用中，在 `transactions` 建表语句之后添加：

```sql
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  ledger_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  icon TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0,
  UNIQUE(ledger_id, name)
);

CREATE TABLE IF NOT EXISTS transaction_tags (
  transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
  tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (transaction_id, tag_id)
);
```

- [ ] **Step 2: 在 `migrateAccounts` 之后添加 `migrateTransactions` 函数**

```typescript
async function migrateTransactions(db: Database): Promise<void> {
  const tableInfo = await db.select<{ name: string }[]>(
    "PRAGMA table_info(transactions)"
  );
  const columns = new Set(tableInfo.map((col) => col.name));

  if (!columns.has("category_id")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(id)");
  }
  if (!columns.has("user_id")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-user-1' REFERENCES users(id)");
  }
  if (!columns.has("occurred_at")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''");
    // 将原有 transacted_at 数据复制到 occurred_at
    await db.execute("UPDATE transactions SET occurred_at = transacted_at WHERE occurred_at = ''");
  }
}
```

- [ ] **Step 3: 在 `getDb` 中调用 `migrateTransactions`**

在 `getDb` 函数中，`await migrateAccounts(database);` 之后添加：

```typescript
await migrateTransactions(database);
```

- [ ] **Step 4: 在 `ensureDefaultData` 末尾添加预设分类插入**

在 `ensureDefaultData` 函数末尾（第二个 ledgers 插入块之后）添加：

```typescript
const existingCategories = await database.select<{ count: number }[]>(
  "SELECT COUNT(*) as count FROM categories"
);
if (existingCategories[0].count === 0) {
  const now = new Date().toISOString();
  const categories = [
    ["餐饮", "expense", "🍜", 1],
    ["交通", "expense", "🚌", 2],
    ["购物", "expense", "🛒", 3],
    ["娱乐", "expense", "🎮", 4],
    ["居家", "expense", "🏠", 5],
    ["通讯", "expense", "📱", 6],
    ["医疗", "expense", "💊", 7],
    ["其他支出", "expense", "💸", 99],
    ["工资", "income", "💰", 1],
    ["奖金", "income", "🎁", 2],
    ["理财", "income", "📈", 3],
    ["退款", "income", "↩️", 4],
    ["报销", "income", "🧾", 5],
    ["其他收入", "income", "📥", 99],
  ];
  for (const [name, type, icon, sortOrder] of categories) {
    await database.execute(
      "INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), null, name, type, icon, sortOrder, now]
    );
  }
}
```

- [ ] **Step 5: 验证 Rust 编译**

```bash
cargo check
```

- [ ] **Step 6: Commit**

```bash
git add src/db/index.ts
git commit -m "feat: add categories/tags/transaction_tags tables, transactions migration, preset categories"
```

---

### Task 3: Category Store

**Files:**
- Create: `src/stores/category.ts`

- [ ] **Step 1: 创建 category store**

```typescript
import { defineStore } from "pinia";
import { ref } from "vue";
import { getDb } from "@/db";
import type { Category } from "@/types";

export const useCategoryStore = defineStore("category", () => {
  const categories = ref<Category[]>([]);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<(Category & { is_deleted: number | boolean })[]>(
      `SELECT id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted
       FROM categories
       WHERE (ledger_id = ? OR ledger_id IS NULL) AND is_deleted = 0
       ORDER BY sort_order ASC, name ASC`,
      [ledgerId]
    );
    categories.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  return { categories, fetchAll };
});
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/stores/category.ts
git commit -m "feat: add category store"
```

---

### Task 4: Tag Store

**Files:**
- Create: `src/stores/tag.ts`

- [ ] **Step 1: 创建 tag store**

```typescript
import { defineStore } from "pinia";
import { ref } from "vue";
import { getDb } from "@/db";
import type { Tag } from "@/types";

function generateId(): string {
  return crypto.randomUUID();
}

export const useTagStore = defineStore("tag", () => {
  const tags = ref<Tag[]>([]);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<(Tag & { is_deleted: number | boolean })[]>(
      `SELECT id, ledger_id, name, updated_at, is_deleted
       FROM tags
       WHERE ledger_id = ? AND is_deleted = 0
       ORDER BY name ASC`,
      [ledgerId]
    );
    tags.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  async function add(ledgerId: string, name: string): Promise<Tag> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = generateId();
    await db.execute(
      "INSERT INTO tags (id, ledger_id, name, updated_at) VALUES (?, ?, ?, ?)",
      [id, ledgerId, name, now]
    );
    const newTag: Tag = {
      id,
      ledger_id: ledgerId,
      name,
      updated_at: now,
      is_deleted: false,
    };
    tags.value.push(newTag);
    return newTag;
  }

  async function remove(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.execute(
      "UPDATE tags SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    tags.value = tags.value.filter((t) => t.id !== id);
  }

  return { tags, fetchAll, add, remove };
});
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/stores/tag.ts
git commit -m "feat: add tag store"
```

---

### Task 5: Transaction Store 测试

**Files:**
- Create: `src/stores/__tests__/transaction.test.ts`

- [ ] **Step 1: 编写 7 个测试用例**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

vi.mock("@/db", () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
}));

// Mock account store
const mockFetchAll = vi.fn();
vi.mock("@/stores/account", () => ({
  useAccountStore: vi.fn(() => ({
    fetchAll: mockFetchAll,
  })),
}));

import { useTransactionStore } from "@/stores/transaction";
import type { Transaction } from "@/types";

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
    occurred_at: "2026-06-09T12:00:00Z",
    created_at: "2026-06-09T12:00:00Z",
    updated_at: "2026-06-09T12:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

describe("transactionStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load transactions with joined category, tags, and accounts", async () => {
      const row = {
        id: "tx-1",
        ledger_id: "pl-1",
        user_id: "u-1",
        amount: 32.5,
        type: "expense",
        from_account_id: "acc-1",
        to_account_id: null,
        category_id: "cat-1",
        occurred_at: "2026-06-09T12:00:00Z",
        created_at: "2026-06-09T12:00:00Z",
        updated_at: "2026-06-09T12:00:00Z",
        is_deleted: 0,
        category_name: "餐饮",
        category_type: "expense",
        category_icon: "🍜",
        category_sort_order: 1,
        tag_ids: "tag-1,tag-2",
        tag_names: "午餐,工作日",
        from_account_name: "招行卡",
        from_account_type: "bank",
        from_account_color: "#ef4444",
        to_account_name: null,
        to_account_type: null,
        to_account_color: null,
      };
      mockDb.select.mockResolvedValueOnce([row]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.transactions).toHaveLength(1);
      const tx = store.transactions[0];
      expect(tx.amount).toBe(32.5);
      expect(tx.category).toEqual({
        id: "cat-1",
        name: "餐饮",
        type: "expense",
        icon: "🍜",
        sort_order: 1,
      });
      expect(tx.tags).toHaveLength(2);
      expect(tx.tags![0]).toEqual({ id: "tag-1", name: "午餐" });
      expect(tx.from_account).toEqual({
        id: "acc-1",
        name: "招行卡",
        type: "bank",
        color: "#ef4444",
      });
      expect(tx.to_account).toBeNull();
    });

    it("should filter by account when accountId is provided", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", "acc-2");

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("AND (t.from_account_id = ? OR t.to_account_id = ?)"),
        ["pl-1", "acc-2", "acc-2"]
      );
    });

    it("should return empty when no transactions", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.transactions).toHaveLength(0);
    });
  });

  describe("add", () => {
    it("should insert expense transaction and transaction_tags", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after add

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "expense",
        amount: 32.5,
        category_id: "cat-1",
        from_account_id: "acc-1",
        to_account_id: null,
        occurred_at: "2026-06-09T12:00:00Z",
        tag_ids: ["tag-1", "tag-2"],
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["pl-1", "u-1", "expense", 32.5])
      );
      // Verify transaction_tags insert
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        expect.any(Array)
      );
      // Verify account balance refresh
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });

    it("should insert transfer transaction with from and to accounts", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "transfer",
        amount: 500,
        category_id: null,
        from_account_id: "acc-1",
        to_account_id: "acc-2",
        occurred_at: "2026-06-09T12:00:00Z",
        tag_ids: [],
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["transfer", 500, "acc-1", "acc-2"])
      );
    });
  });

  describe("update", () => {
    it("should update transaction and rebuild tags", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after update

      const store = useTransactionStore();
      await store.update("tx-1", {
        amount: 50,
        category_id: "cat-2",
        tag_ids: ["tag-3"],
      });

      // Verify transaction UPDATE
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE transactions"),
        expect.arrayContaining([50, "cat-2", "tx-1"])
      );
      // Verify old tags deleted
      expect(mockDb.execute).toHaveBeenCalledWith(
        "DELETE FROM transaction_tags WHERE transaction_id = ?",
        ["tx-1"]
      );
      // Verify new tags inserted
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        expect.arrayContaining(["tx-1", "tag-3"])
      );
      // Verify account balance refresh
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });
  });

  describe("remove", () => {
    it("should soft-delete transaction", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.remove("tx-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["tx-1"])
      );
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });
  });

  describe("computed", () => {
    it("should compute totalIncome and totalExpense correctly", async () => {
      const rows = [
        {
          ...makeTx({ id: "tx-1", amount: 100, type: "expense" }),
          is_deleted: 0,
          category_name: "餐饮", category_type: "expense", category_icon: "🍜", category_sort_order: 1,
          tag_ids: null, tag_names: null,
          from_account_name: "招行", from_account_type: "bank", from_account_color: "#ef4444",
          to_account_name: null, to_account_type: null, to_account_color: null,
        },
        {
          ...makeTx({ id: "tx-2", amount: 8000, type: "income" }),
          is_deleted: 0,
          category_name: "工资", category_type: "income", category_icon: "💰", category_sort_order: 1,
          tag_ids: null, tag_names: null,
          from_account_name: null, from_account_type: null, from_account_color: null,
          to_account_name: "招行", to_account_type: "bank", to_account_color: "#ef4444",
        },
        {
          ...makeTx({ id: "tx-3", amount: 500, type: "transfer" }),
          is_deleted: 0,
          category_name: null, category_type: null, category_icon: null, category_sort_order: null,
          tag_ids: null, tag_names: null,
          from_account_name: "招行", from_account_type: "bank", from_account_color: "#ef4444",
          to_account_name: "微信", to_account_type: "digital", to_account_color: "#22c55e",
        },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.totalIncome).toBe(8000);
      expect(store.totalExpense).toBe(100);
    });
  });
});
```

- [ ] **Step 2: 确认测试失败（store 文件还不存在）**

```bash
npx vitest run src/stores/__tests__/transaction.test.ts
```

Expected: FAIL — cannot resolve `@/stores/transaction`

- [ ] **Step 3: Commit**

```bash
git add src/stores/__tests__/transaction.test.ts
git commit -m "test: add transaction store tests (7 cases)"
```

---

### Task 6: Transaction Store 实现

**Files:**
- Create: `src/stores/transaction.ts`

- [ ] **Step 1: 实现 transaction store**

```typescript
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getDb } from "@/db";
import { useAccountStore } from "@/stores/account";
import type { Transaction, TransactionType } from "@/types";

function generateId(): string {
  return crypto.randomUUID();
}

interface TransactionRow {
  id: string;
  ledger_id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  is_deleted: number | boolean;
  category_name: string | null;
  category_type: string | null;
  category_icon: string | null;
  category_sort_order: number | null;
  tag_ids: string | null;
  tag_names: string | null;
  from_account_name: string | null;
  from_account_type: string | null;
  from_account_color: string | null;
  to_account_name: string | null;
  to_account_type: string | null;
  to_account_color: string | null;
}

function assembleTransaction(row: TransactionRow): Transaction {
  const tx: Transaction = {
    id: row.id,
    ledger_id: row.ledger_id,
    user_id: row.user_id,
    amount: row.amount,
    type: row.type,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    category_id: row.category_id,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_deleted: Boolean(row.is_deleted),
  };

  if (row.category_id && row.category_name) {
    tx.category = {
      id: row.category_id,
      ledger_id: null,
      name: row.category_name,
      type: row.category_type as "income" | "expense",
      icon: row.category_icon,
      sort_order: row.category_sort_order ?? 0,
      updated_at: "",
      is_deleted: false,
    };
  }

  if (row.tag_ids && row.tag_names) {
    const ids = row.tag_ids.split(",");
    const names = row.tag_names.split(",");
    tx.tags = ids.map((id, i) => ({ id, name: names[i] ?? "", ledger_id: "", updated_at: "", is_deleted: false }));
  } else {
    tx.tags = [];
  }

  if (row.from_account_id && row.from_account_name) {
    tx.from_account = {
      id: row.from_account_id,
      ledger_id: "",
      owner_id: "",
      name: row.from_account_name,
      type: row.from_account_type as never,
      initial_balance: 0,
      color: row.from_account_color ?? "#3b82f6",
      created_at: "",
      updated_at: "",
      is_deleted: false,
    };
  }

  if (row.to_account_id && row.to_account_name) {
    tx.to_account = {
      id: row.to_account_id,
      ledger_id: "",
      owner_id: "",
      name: row.to_account_name,
      type: row.to_account_type as never,
      initial_balance: 0,
      color: row.to_account_color ?? "#3b82f6",
      created_at: "",
      updated_at: "",
      is_deleted: false,
    };
  }

  return tx;
}

const QUERY = `
  SELECT
    t.id, t.ledger_id, t.user_id, t.amount, t.type,
    t.from_account_id, t.to_account_id, t.category_id,
    t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
    c.name AS category_name, c.type AS category_type, c.icon AS category_icon, c.sort_order AS category_sort_order,
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

export const useTransactionStore = defineStore("transaction", () => {
  const transactions = ref<Transaction[]>([]);

  const totalIncome = computed(() =>
    transactions.value
      .filter((t) => t.type === "income")
      .reduce((sum, t) => sum + t.amount, 0)
  );

  const totalExpense = computed(() =>
    transactions.value
      .filter((t) => t.type === "expense")
      .reduce((sum, t) => sum + t.amount, 0)
  );

  async function fetchAll(ledgerId: string, accountId?: string): Promise<void> {
    const db = await getDb();
    let sql = QUERY;
    const params: string[] = [ledgerId];

    if (accountId) {
      sql += " AND (t.from_account_id = ? OR t.to_account_id = ?)";
      params.push(accountId, accountId);
    }

    sql += " GROUP BY t.id ORDER BY t.occurred_at DESC, t.created_at DESC";

    const rows = await db.select<TransactionRow[]>(sql, params);
    transactions.value = rows.map(assembleTransaction);
  }

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
  }): Promise<string> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = generateId();

    await db.execute(
      `INSERT INTO transactions (id, ledger_id, user_id, type, amount, category_id, from_account_id, to_account_id, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, data.ledger_id, data.user_id, data.type, data.amount, data.category_id,
        data.from_account_id, data.to_account_id, data.occurred_at, now, now,
      ]
    );

    if (data.tag_ids.length > 0) {
      for (const tagId of data.tag_ids) {
        await db.execute(
          "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [id, tagId]
        );
      }
    }

    await fetchAll(data.ledger_id);
    // 刷新账户余额
    const accountStore = useAccountStore();
    await accountStore.fetchAll(data.ledger_id);

    return id;
  }

  async function update(
    id: string,
    data: Partial<{
      type: TransactionType;
      amount: number;
      category_id: string | null;
      from_account_id: string | null;
      to_account_id: string | null;
      occurred_at: string;
      tag_ids: string[];
    }>
  ): Promise<void> {
    const db = await getDb();
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.type !== undefined) { sets.push("type = ?"); values.push(data.type); }
    if (data.amount !== undefined) { sets.push("amount = ?"); values.push(data.amount); }
    if (data.category_id !== undefined) { sets.push("category_id = ?"); values.push(data.category_id); }
    if (data.from_account_id !== undefined) { sets.push("from_account_id = ?"); values.push(data.from_account_id); }
    if (data.to_account_id !== undefined) { sets.push("to_account_id = ?"); values.push(data.to_account_id); }
    if (data.occurred_at !== undefined) { sets.push("occurred_at = ?"); values.push(data.occurred_at); }

    if (sets.length > 0) {
      sets.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      await db.execute(
        `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`,
        values
      );
    }

    if (data.tag_ids !== undefined) {
      await db.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [id]);
      for (const tagId of data.tag_ids) {
        await db.execute(
          "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [id, tagId]
        );
      }
    }

    // 找到 ledger_id 以刷新数据
    const existing = transactions.value.find((t) => t.id === id);
    const ledgerId = existing?.ledger_id;
    if (ledgerId) {
      await fetchAll(ledgerId);
      const accountStore = useAccountStore();
      await accountStore.fetchAll(ledgerId);
    }
  }

  async function remove(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.execute(
      "UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    const existing = transactions.value.find((t) => t.id === id);
    const ledgerId = existing?.ledger_id;
    if (ledgerId) {
      await fetchAll(ledgerId);
      const accountStore = useAccountStore();
      await accountStore.fetchAll(ledgerId);
    }
  }

  return { transactions, totalIncome, totalExpense, fetchAll, add, update, remove };
});
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/stores/__tests__/transaction.test.ts
```

Expected: 7 tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/stores/transaction.ts
git commit -m "feat: add transaction store with CRUD and computed totals"
```

---

### Task 7: 路由重构 + 删除 Home.vue

**Files:**
- Modify: `src/router/index.ts`
- Delete: `src/views/Home.vue`

- [ ] **Step 1: 重写路由配置**

将 `src/router/index.ts` 替换为：

```typescript
import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "record",
      component: () => import("@/views/RecordPage.vue"),
    },
    {
      path: "/record/:id",
      name: "record-edit",
      component: () => import("@/views/RecordPage.vue"),
    },
    {
      path: "/transactions",
      name: "transactions",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/accounts",
      name: "accounts",
      component: () => import("@/views/AccountList.vue"),
    },
    {
      path: "/accounts/:id/edit",
      name: "account-edit",
      component: () => import("@/views/AccountEdit.vue"),
    },
    {
      path: "/settings",
      name: "settings",
      component: () => import("@/views/SettingsPage.vue"),
    },
  ],
});

export default router;
```

- [ ] **Step 2: 删除 Home.vue**

```bash
rm src/views/Home.vue
```

- [ ] **Step 3: 验证类型检查（会有缺失模块的报错，属正常 — 后续任务会创建）**

```bash
npx vue-tsc --noEmit 2>&1 | head -20
```

Expected: 报错关于 RecordPage、SettingsPage 等缺失模块 — 这是预期的，后续任务会创建。

- [ ] **Step 4: Commit**

```bash
git add src/router/index.ts
git rm src/views/Home.vue
git commit -m "feat: refactor routes for tab navigation, remove Home.vue"
```

---

### Task 8: App.vue 底部 Tab 导航

**Files:**
- Modify: `src/App.vue`

- [ ] **Step 1: 更新 App.vue 添加 Tab 栏**

将 `src/App.vue` 替换为：

```vue
<script setup lang="ts">
import { useRoute } from "vue-router";
import { Home, List, Wallet, Settings } from "lucide-vue-next";
import { computed } from "vue";

const route = useRoute();

const tabs = [
  { path: "/", label: "记账", icon: Home },
  { path: "/transactions", label: "流水", icon: List },
  { path: "/accounts", label: "账户", icon: Wallet },
  { path: "/settings", label: "设置", icon: Settings },
];

function isActive(tabPath: string): boolean {
  if (tabPath === "/") return route.path === "/" || route.path.startsWith("/record");
  return route.path.startsWith(tabPath);
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <div class="flex-1 overflow-auto">
      <RouterView />
    </div>

    <nav class="flex shrink-0 border-t border-gray-200 bg-surface pb-[env(safe-area-inset-bottom)]">
      <router-link
        v-for="tab in tabs"
        :key="tab.path"
        :to="tab.path"
        class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors"
        :class="isActive(tab.path) ? 'text-primary' : 'text-text-secondary'"
      >
        <component :is="tab.icon" :size="20" />
        <span>{{ tab.label }}</span>
      </router-link>
    </nav>
  </div>
</template>
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/App.vue
git commit -m "feat: add bottom tab navigation to App.vue"
```

---

### Task 9: RecordPage — 记账/编辑页

**Files:**
- Create: `src/views/RecordPage.vue`

- [ ] **Step 1: 创建 RecordPage.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDown, Trash2 } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import TagSheet from "@/components/TagSheet.vue";
import type { Category, TransactionType } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const categoryStore = useCategoryStore();
const tagStore = useTagStore();
const transactionStore = useTransactionStore();

const isEdit = computed(() => !!route.params.id);
const editId = computed(() => route.params.id as string | undefined);

// 表单状态
const txType = ref<TransactionType>("expense");
const categoryId = ref<string | null>(null);
const fromAccountId = ref<string | null>(null);
const toAccountId = ref<string | null>(null);
const occurredAt = ref("");
const amount = ref("");
const selectedTagIds = ref<string[]>([]);

const tagSheetVisible = ref(false);
const deleteDialogVisible = ref(false);
const isSaving = ref(false);
const isReady = ref(false);

// 按类型过滤分类
const filteredCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === txType.value)
);

// 资产/负债账户（全部账户都可用于交易）
const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => !a.is_deleted)
);

// 当前选中交易（编辑模式）
const editingTx = computed(() =>
  editId.value
    ? transactionStore.transactions.find((t) => t.id === editId.value)
    : undefined
);

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await Promise.all([
    accountStore.fetchAll(ledgerId),
    categoryStore.fetchAll(ledgerId),
    tagStore.fetchAll(ledgerId),
  ]);

  // 编辑模式：预填数据
  if (isEdit.value && editId.value) {
    await transactionStore.fetchAll(ledgerId);
    const tx = transactionStore.transactions.find((t) => t.id === editId.value);
    if (tx) {
      txType.value = tx.type;
      categoryId.value = tx.category_id;
      fromAccountId.value = tx.from_account_id;
      toAccountId.value = tx.to_account_id;
      occurredAt.value = tx.occurred_at.slice(0, 16); // "2026-06-09T12:00" for datetime-local
      amount.value = tx.amount.toString();
      selectedTagIds.value = tx.tags?.map((t) => t.id) ?? [];
    }
  } else {
    // 新增模式：默认当前时间，默认选中第一个账户
    const now = new Date();
    occurredAt.value = now.toISOString().slice(0, 16);
    if (availableAccounts.value.length > 0) {
      fromAccountId.value = availableAccounts.value[0].id;
      toAccountId.value = availableAccounts.value[0].id;
    }
  }

  isReady.value = true;
});

// 切换交易类型
function switchType(type: TransactionType) {
  txType.value = type;
  categoryId.value = null;
}

// 选择分类
function selectCategory(cat: Category) {
  categoryId.value = cat.id;
}

// 标签 Sheet 确认
function onTagConfirm(tagIds: string[]) {
  selectedTagIds.value = tagIds;
  tagSheetVisible.value = false;
}

// 已选标签对象列表
const selectedTags = computed(() =>
  selectedTagIds.value
    .map((id) => tagStore.tags.find((t) => t.id === id))
    .filter(Boolean)
);

// 切换标签选中
function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx >= 0) {
    selectedTagIds.value.splice(idx, 1);
  } else {
    selectedTagIds.value.push(tagId);
  }
}

// 保存
async function save() {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isSaving.value) return;

  const amt = parseFloat(amount.value);
  if (!amt || amt <= 0) return;
  if (txType.value !== "transfer" && !categoryId.value) return;
  if (!fromAccountId.value) return;
  if (txType.value !== "expense" && !toAccountId.value) return;

  isSaving.value = true;
  try {
    const data = {
      ledger_id: ledgerId,
      user_id: "local-user-1",
      type: txType.value,
      amount: Math.round(amt * 100) / 100,
      category_id: txType.value === "transfer" ? null : categoryId.value,
      from_account_id: fromAccountId.value,
      to_account_id: txType.value === "income" || txType.value === "transfer" ? toAccountId.value : null,
      occurred_at: new Date(occurredAt.value).toISOString(),
      tag_ids: selectedTagIds.value,
    };

    if (isEdit.value && editId.value) {
      await transactionStore.update(editId.value, data);
    } else {
      await transactionStore.add(data);
    }

    router.replace("/transactions");
  } catch (e) {
    console.error("Save transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

// 删除
async function deleteTx() {
  if (!editId.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await transactionStore.remove(editId.value);
    router.replace("/transactions");
  } catch (e) {
    console.error("Delete transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

function goBack() {
  if (isEdit.value) {
    router.push("/transactions");
  } else {
    router.push("/");
  }
}

// 格式化金额显示
const amountDisplay = computed(() => {
  const v = parseFloat(amount.value);
  if (isNaN(v)) return "";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

const saveLabel = computed(() => (isEdit.value ? "保存" : "记一笔"));
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader
      :title="isEdit ? '编辑记录' : '记账'"
      :show-back="isEdit"
      @back="goBack"
    >
      <template v-if="isEdit" #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="deleteDialogVisible = true"
        >
          <Trash2 :size="18" class="text-expense" />
        </button>
      </template>
    </AppHeader>

    <div v-if="!isReady" class="flex flex-1 items-center justify-center">
      <p class="text-text-secondary">加载中...</p>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 py-4">
      <!-- 类型切换 -->
      <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
        <button
          v-for="t in (['expense', 'income', 'transfer'] as TransactionType[])"
          :key="t"
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="txType === t ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="switchType(t)"
        >
          {{ t === 'expense' ? '支出' : t === 'income' ? '收入' : '转账' }}
        </button>
      </div>

      <!-- 分类网格（转账时隐藏） -->
      <div v-if="txType !== 'transfer'" class="mb-4">
        <div class="grid grid-cols-4 gap-2">
          <button
            v-for="cat in filteredCategories"
            :key="cat.id"
            class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
            :class="categoryId === cat.id ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
            @click="selectCategory(cat)"
          >
            <span class="text-lg">{{ cat.icon }}</span>
            <span>{{ cat.name }}</span>
          </button>
        </div>
      </div>

      <!-- 账户选择器 -->
      <div class="mb-4 space-y-2">
        <div v-if="txType === 'transfer'" class="space-y-2">
          <div>
            <label class="mb-1 block text-xs text-text-secondary">转出账户</label>
            <select
              v-model="fromAccountId"
              class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            >
              <option v-for="acc in availableAccounts" :key="acc.id" :value="acc.id">
                {{ acc.name }}
              </option>
            </select>
          </div>
          <div class="flex justify-center text-text-secondary">
            <ChevronDown :size="16" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-text-secondary">转入账户</label>
            <select
              v-model="toAccountId"
              class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            >
              <option v-for="acc in availableAccounts" :key="acc.id" :value="acc.id">
                {{ acc.name }}
              </option>
            </select>
          </div>
        </div>
        <div v-else>
          <label class="mb-1 block text-xs text-text-secondary">
            {{ txType === 'expense' ? '扣款账户' : '入账账户' }}
          </label>
          <select
            :model-value="txType === 'expense' ? fromAccountId : toAccountId"
            class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            @change="(e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              if (txType === 'expense') fromAccountId = v;
              else toAccountId = v;
            }"
          >
            <option v-for="acc in availableAccounts" :key="acc.id" :value="acc.id">
              {{ acc.name }}
            </option>
          </select>
        </div>
      </div>

      <!-- 日期时间 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">日期时间</label>
        <input
          v-model="occurredAt"
          type="datetime-local"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </div>

      <!-- 金额 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">金额</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-lg font-semibold text-text">¥</span>
          <input
            v-model="amount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            class="w-full rounded-lg border border-gray-200 bg-surface py-2.5 pl-8 pr-3 text-right text-lg font-semibold text-text outline-none focus:border-primary"
          />
        </div>
        <p v-if="amountDisplay" class="mt-1 text-right text-xs text-text-secondary">
          {{ amountDisplay }}
        </p>
      </div>

      <!-- 标签 -->
      <div class="mb-6">
        <label class="mb-1 block text-xs text-text-secondary">标签</label>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="tag in selectedTags"
            :key="tag.id"
            class="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
          >
            🏷️ {{ tag.name }}
            <button class="ml-0.5 text-primary/60 hover:text-primary" @click="toggleTag(tag.id)">×</button>
          </span>
          <button
            class="inline-flex items-center gap-0.5 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-xs text-text-secondary hover:border-primary hover:text-primary"
            @click="tagSheetVisible = true"
          >
            + 添加标签
          </button>
        </div>
      </div>
    </div>

    <!-- 保存按钮 -->
    <div v-if="isReady" class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="w-full rounded-xl py-3 text-center text-base font-semibold text-white transition-colors disabled:opacity-50"
        :class="txType === 'expense' ? 'bg-expense hover:bg-red-600' : txType === 'income' ? 'bg-income hover:bg-green-600' : 'bg-primary hover:bg-primary-dark'"
        :disabled="isSaving"
        @click="save"
      >
        {{ isSaving ? '保存中...' : saveLabel }}
      </button>
    </div>

    <!-- 标签选择 Sheet -->
    <TagSheet
      :visible="tagSheetVisible"
      :selected-ids="selectedTagIds"
      @close="tagSheetVisible = false"
      @confirm="onTagConfirm"
    />

    <!-- 删除确认 -->
    <ConfirmDialog
      :visible="deleteDialogVisible"
      title="删除记录"
      description="确定要删除这条记录吗？此操作不可撤销。"
      confirm-text="删除"
      :danger="true"
      @confirm="deleteTx"
      @cancel="deleteDialogVisible = false"
    />
  </div>
</template>
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

Expected: 报错关于 TagSheet 缺失模块 — 这是预期的，Task 10 会创建。

- [ ] **Step 3: Commit**

```bash
git add src/views/RecordPage.vue
git commit -m "feat: add RecordPage with add/edit modes"
```

---

### Task 10: TagSheet — 标签选择底部 Sheet

**Files:**
- Create: `src/components/TagSheet.vue`

- [ ] **Step 1: 创建 TagSheet.vue**

```vue
<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { X } from "lucide-vue-next";
import { useTagStore } from "@/stores/tag";
import { useLedgerStore } from "@/stores/ledger";
import type { Tag } from "@/types";

const props = defineProps<{
  visible: boolean;
  selectedIds: string[];
}>();

const emit = defineEmits<{
  close: [];
  confirm: [tagIds: string[]];
}>();

const tagStore = useTagStore();
const ledgerStore = useLedgerStore();

const search = ref("");
const localSelected = ref<string[]>([]);

// 打开时同步选中状态
watch(() => props.visible, (v) => {
  if (v) {
    localSelected.value = [...props.selectedIds];
    search.value = "";
  }
});

// 过滤标签
const filteredTags = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw) return tagStore.tags;
  return tagStore.tags.filter((t) => t.name.toLowerCase().includes(kw));
});

// 搜索无结果且输入非空
const showCreate = computed(() =>
  search.value.trim().length > 0 && filteredTags.value.length === 0
);

function toggle(tag: Tag) {
  const idx = localSelected.value.indexOf(tag.id);
  if (idx >= 0) {
    localSelected.value.splice(idx, 1);
  } else {
    localSelected.value.push(tag.id);
  }
}

async function createAndSelect() {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;
  const name = search.value.trim();
  if (!name) return;
  try {
    const newTag = await tagStore.add(ledgerId, name);
    localSelected.value.push(newTag.id);
    search.value = "";
  } catch {
    // UNIQUE 约束冲突 — 忽略，可能是并发创建
  }
}

function confirm() {
  emit("confirm", localSelected.value);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <Transition name="slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[70vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">添加标签</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <!-- 搜索框 -->
        <input
          v-model="search"
          type="text"
          placeholder="搜索已有标签"
          class="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

        <!-- 标签列表 -->
        <div class="flex-1 overflow-auto">
          <button
            v-for="tag in filteredTags"
            :key="tag.id"
            class="flex w-full items-center gap-3 px-2 py-2.5 text-sm transition-colors hover:bg-gray-50"
            @click="toggle(tag)"
          >
            <span
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
              :class="localSelected.includes(tag.id) ? 'border-primary bg-primary text-white' : 'border-gray-300'"
            >
              {{ localSelected.includes(tag.id) ? '✓' : '' }}
            </span>
            <span class="text-text">{{ tag.name }}</span>
          </button>

          <!-- 创建新标签 -->
          <button
            v-if="showCreate"
            class="flex w-full items-center gap-3 px-2 py-2.5 text-sm text-primary transition-colors hover:bg-gray-50"
            @click="createAndSelect"
          >
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-primary text-xs">+</span>
            <span>创建标签 "{{ search.trim() }}"</span>
          </button>

          <div v-if="filteredTags.length === 0 && !showCreate" class="py-8 text-center text-sm text-text-secondary">
            暂无标签，输入名称创建
          </div>
        </div>

        <!-- 确定按钮 -->
        <button
          class="mt-4 w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="confirm"
        >
          确定
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

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

Expected: PASS（TagSheet 已创建，RecordPage 可以解析导入）

- [ ] **Step 3: Commit**

```bash
git add src/components/TagSheet.vue
git commit -m "feat: add TagSheet for tag selection"
```

---

### Task 11: TransactionList — 流水页重写

**Files:**
- Modify: `src/views/TransactionList.vue`

- [ ] **Step 1: 重写 TransactionList.vue**

```vue
<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import type { Transaction } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const transactionStore = useTransactionStore();

const filterAccountId = ref<string>("");
const isLoading = ref(true);

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await accountStore.fetchAll(ledgerId);

  // 从 query 读取过滤条件
  const qAccount = route.query.account as string | undefined;
  if (qAccount) filterAccountId.value = qAccount;

  await transactionStore.fetchAll(ledgerId, filterAccountId.value || undefined);
  isLoading.value = false;
});

// 账户过滤切换
watch(filterAccountId, async (newVal) => {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isLoading.value) return;
  await transactionStore.fetchAll(ledgerId, newVal || undefined);
});

// 按日期分组
interface DayGroup {
  date: string;
  label: string;
  transactions: Transaction[];
}

const groupedTransactions = computed<DayGroup[]>(() => {
  const groups: Record<string, Transaction[]> = {};
  for (const tx of transactionStore.transactions) {
    const dateKey = tx.occurred_at.slice(0, 10);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(tx);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, txs]) => ({
      date,
      label: formatDateLabel(date),
      transactions: txs,
    }));
});

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekDay = weekDays[d.getDay()];
  return `${month}月${day}日 ${weekDay}`;
}

// 获取交易图标
function getTxIcon(tx: Transaction): string {
  if (tx.type === "transfer") return "🔄";
  return tx.category?.icon ?? (tx.type === "income" ? "📥" : "💸");
}

// 获取交易描述
function getTxDescription(tx: Transaction): string {
  if (tx.type === "transfer") {
    return `${tx.from_account?.name ?? "?"} → ${tx.to_account?.name ?? "?"}`;
  }
  if (tx.type === "income") {
    return tx.to_account?.name ?? "";
  }
  return tx.from_account?.name ?? "";
}

// 获取交易分类名
function getTxCategoryName(tx: Transaction): string {
  if (tx.type === "transfer") return "转账";
  return tx.category?.name ?? (tx.type === "income" ? "收入" : "支出");
}

// 金额显示
function formatAmount(tx: Transaction): string {
  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "-" : "";
  return `${sign}¥${tx.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function goRecord(txId: string) {
  router.push(`/record/${txId}`);
}

function goBack() {
  router.push("/");
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="流水" />

    <!-- 账户过滤器 -->
    <div class="bg-surface px-4 py-2">
      <select
        v-model="filterAccountId"
        class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
      >
        <option value="">全部账户</option>
        <option v-for="acc in accountStore.accounts" :key="acc.id" :value="acc.id">
          {{ acc.name }}
        </option>
      </select>
    </div>

    <!-- 流水列表 -->
    <div class="flex-1 overflow-auto px-4 py-3">
      <div v-if="isLoading" class="py-12 text-center text-text-secondary">
        加载中...
      </div>

      <div v-else-if="transactionStore.transactions.length === 0" class="py-12 text-center">
        <p class="text-4xl">📋</p>
        <p class="mt-3 text-text-secondary">暂无流水记录</p>
      </div>

      <template v-else>
        <div v-for="group in groupedTransactions" :key="group.date" class="mb-4">
          <p class="mb-2 text-xs font-medium text-text-secondary">{{ group.label }}</p>
          <div class="space-y-1.5">
            <button
              v-for="tx in group.transactions"
              :key="tx.id"
              class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
              @click="goRecord(tx.id)"
            >
              <span class="text-xl">{{ getTxIcon(tx) }}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-text">{{ getTxCategoryName(tx) }}</p>
                <p class="text-xs text-text-secondary">{{ getTxDescription(tx) }}</p>
                <p v-if="tx.tags && tx.tags.length > 0" class="mt-0.5 flex gap-1">
                  <span
                    v-for="tag in tx.tags"
                    :key="tag.id"
                    class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-text-secondary"
                  >
                    🏷️ {{ tag.name }}
                  </span>
                </p>
              </div>
              <span
                class="shrink-0 text-sm font-semibold"
                :class="tx.type === 'expense' ? 'text-expense' : tx.type === 'income' ? 'text-income' : 'text-text'"
              >
                {{ formatAmount(tx) }}
              </span>
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: rewrite TransactionList with date grouping and account filter"
```

---

### Task 12: SettingsPage 占位

**Files:**
- Create: `src/views/SettingsPage.vue`

- [ ] **Step 1: 创建设置页占位**

```vue
<script setup lang="ts">
import AppHeader from "@/components/AppHeader.vue";
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="设置" />
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <p class="text-4xl">⚙️</p>
        <p class="mt-3 text-text-secondary">设置功能开发中</p>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/views/SettingsPage.vue
git commit -m "feat: add SettingsPage placeholder"
```

---

### Task 13: 更新 AccountList 跳转链接

**Files:**
- Modify: `src/views/AccountList.vue`

- [ ] **Step 1: 更新 goTransactions 函数和返回链接**

修改 `src/views/AccountList.vue` 中的两处：

第 37-39 行，将：
```typescript
function goTransactions(accountId: string) {
  router.push(`/accounts/${accountId}/transactions`);
}
```
改为：
```typescript
function goTransactions(accountId: string) {
  router.push(`/transactions?account=${accountId}`);
}
```

第 61 行，将：
```html
<AppHeader title="账户管理" :show-back="true" @back="router.push('/')" />
```
改为（Tab 导航模式下不需要返回按钮）：
```html
<AppHeader title="账户管理" />
```

- [ ] **Step 2: 验证类型检查**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/views/AccountList.vue
git commit -m "fix: update AccountList transaction link to new route"
```

---

### Task 14: 最终集成验证

- [ ] **Step 1: 运行所有前端测试**

```bash
npx vitest run
```

Expected: All tests PASS (including 7 transaction store tests)

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx vue-tsc --noEmit
```

Expected: No errors

- [ ] **Step 3: Rust 编译检查**

```bash
cargo check
```

Expected: No errors

- [ ] **Step 4: 生产构建**

```bash
npm run build
```

Expected: Build succeeds

- [ ] **Step 5: 提交最终状态**

```bash
git add -A
git commit -m "chore: final integration verification for Phase 3"
```

- [ ] **Step 6: 更新 README.md**

确保 README 反映 Phase 3 已完成的功能状态。

---

## 验证清单

- [ ] `npx vitest run` — 全部测试通过（含 7 个 transaction store 测试）
- [ ] `npx vue-tsc --noEmit` — 无类型错误
- [ ] `cargo check` — Rust 编译通过
- [ ] `npm run build` — 生产构建成功
