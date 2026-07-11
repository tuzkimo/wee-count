# Phase 2 基础设施 + 账户管理闭环 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 Tauri 2.0 + Vue 3 基础设施（Tailwind v4、路由、Pinia、SQLite），实现账户管理完整闭环（列表、新增、编辑、删除）。

**Architecture:** Vue 3 SPA with vue-router, Pinia stores 直接调用 `@tauri-apps/plugin-sql` 执行 SQL，无中间 ORM 层。Tailwind v4 通过 Vite 插件集成，纯 CSS 配置主题。SQLite 表在 app 启动时初始化。

**Tech Stack:** Vue 3.5 + TypeScript + Vite 6 + Tauri 2.0 + Tailwind CSS v4 + Pinia + vue-router + SQLite (`@tauri-apps/plugin-sql`)

---

## 文件结构总览

```
修改文件:
  package.json                    # 添加前端依赖
  src-tauri/Cargo.toml            # 添加 Rust 依赖
  src-tauri/src/lib.rs            # 注册 SQL + haptics 插件
  src-tauri/capabilities/default.json  # 添加 SQL 权限
  vite.config.ts                  # 添加 Tailwind 插件 + 路径别名
  tsconfig.json                   # 添加 @ 路径别名
  index.html                      # 更新标题
  src/main.ts                     # 注册 router + pinia
  src/App.vue                     # 替换为 <RouterView />

新建文件:
  src/assets/main.css             # Tailwind 入口 + 主题定制
  src/types/index.ts              # 共享类型定义
  src/router/index.ts             # 路由定义
  src/db/index.ts                 # SQLite 连接 + 建表
  src/stores/ledger.ts            # 当前账本状态
  src/stores/account.ts           # 账户 CRUD
  src/stores/__tests__/account.test.ts  # account store 单元测试
  src/views/Home.vue              # 首页占位
  src/views/AccountList.vue       # 账户列表页
  src/components/AccountCard.vue  # 账户卡片
  src/components/AccountSheet.vue # 新增/编辑底部弹出面板
  src/components/AppHeader.vue    # 顶部导航栏
```

---

### Task 1: 安装所有依赖

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: 安装前端依赖**

```bash
npm install tailwindcss @tailwindcss/vite vue-router pinia @tauri-apps/plugin-sql lucide-vue-next
```

Expected: 6 个包安装成功，`package.json` 更新。

- [ ] **Step 2: 添加 Rust 依赖**

Edit `src-tauri/Cargo.toml`，在 `[dependencies]` 末尾追加：

```toml
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-haptics = "2"
```

- [ ] **Step 3: 验证依赖安装**

```bash
npm run dev &
sleep 3
cargo check
```

Expected: `cargo check` 编译成功，无错误。然后 kill Vite 进程。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add Phase 2 dependencies (Tailwind v4, router, Pinia, SQLite, haptics)"
```

---

### Task 2: 配置 Tailwind CSS v4

**Files:**
- Create: `src/assets/main.css`
- Modify: `vite.config.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 创建 Tailwind 入口 CSS**

Create `src/assets/main.css`:

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
```

- [ ] **Step 2: 在 Vite 配置中注册 Tailwind 插件**

Edit `vite.config.ts` — 在 `plugins` 数组中添加 `tailwindcss()`：

```typescript
/// <reference types="vitest" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "happy-dom",
  },
}));
```

- [ ] **Step 3: 在 main.ts 中导入 CSS**

Edit `src/main.ts`，在文件顶部 import：

```typescript
import { createApp } from "vue";
import App from "./App.vue";
import "./assets/main.css";

createApp(App).mount("#app");
```

- [ ] **Step 4: 验证 Tailwind 生效**

在 `src/App.vue` 的 `<template>` 中临时添加 `<h1 class="text-primary text-2xl font-bold bg-bg">Tailwind Test</h1>`，运行 `npm run dev`，浏览器中确认文字有蓝色、大字号、浅灰背景。确认后恢复模板。

- [ ] **Step 5: Commit**

```bash
git add src/assets/main.css vite.config.ts src/main.ts src/App.vue
git commit -m "feat: configure Tailwind CSS v4 with custom theme"
```

---

### Task 3: 配置 TypeScript 路径别名

**Files:**
- Modify: `tsconfig.json`
- Modify: `vite.config.ts`

- [ ] **Step 1: 添加 tsconfig 路径映射**

Edit `tsconfig.json`，在 `compilerOptions` 中添加 `baseUrl` 和 `paths`：

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts", "src/**/*.d.ts", "src/**/*.tsx", "src/**/*.vue"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 2: 添加 Vite resolve alias**

Edit `vite.config.ts`，在 `defineConfig` 返回对象中添加 `resolve` 字段：

```typescript
import { fileURLToPath, URL } from "url";

// ... 在 defineConfig 返回对象中:
export default defineConfig(async () => ({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // ... 其余配置不变
}));
```

- [ ] **Step 3: 验证路径别名**

在 `src/App.vue` 中 `import` 一个 `@/assets/main.css` 路径风格的东西（实际上 CSS 已经在 main.ts 中引入了）。改为在 `src/main.ts` 中确认 `import App from "@/App.vue"` 能正常工作。需要同时更新 `src/main.ts`：

```typescript
import { createApp } from "vue";
import App from "@/App.vue";
import "@/assets/main.css";

createApp(App).mount("#app");
```

运行 `npm run dev`，确认无报错。

- [ ] **Step 4: Commit**

```bash
git add tsconfig.json vite.config.ts src/main.ts
git commit -m "chore: configure @ path alias for TypeScript and Vite"
```

---

### Task 4: 设置路由 + 页面骨架

**Files:**
- Create: `src/router/index.ts`
- Create: `src/views/Home.vue`
- Create: `src/views/AccountList.vue`
- Modify: `src/App.vue`
- Modify: `src/main.ts`

- [ ] **Step 1: 创建路由定义**

Create `src/router/index.ts`:

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
  ],
});

export default router;
```

- [ ] **Step 2: 创建 Home 占位页**

Create `src/views/Home.vue`:

```vue
<script setup lang="ts">
</script>

<template>
  <div class="p-4">
    <h1 class="text-xl font-bold text-text">一起数钱</h1>
    <p class="text-text-secondary mt-2">首页 — 后续放记账入口和流水概览</p>
    <div class="mt-6">
      <router-link
        to="/accounts"
        class="inline-block rounded-lg bg-primary px-4 py-2 text-white"
      >
        账户管理
      </router-link>
    </div>
  </div>
</template>
```

- [ ] **Step 3: 创建 AccountList 占位页**

Create `src/views/AccountList.vue`:

```vue
<script setup lang="ts">
</script>

<template>
  <div class="p-4">
    <h1 class="text-xl font-bold text-text">账户管理</h1>
    <p class="text-text-secondary mt-2">加载中...</p>
  </div>
</template>
```

- [ ] **Step 4: 更新 App.vue 为 RouterView**

Replace `src/App.vue`:

```vue
<script setup lang="ts">
</script>

<template>
  <div class="min-h-screen bg-bg text-text">
    <RouterView />
  </div>
</template>
```

- [ ] **Step 5: 在 main.ts 中注册 router**

Edit `src/main.ts`:

```typescript
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import "@/assets/main.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
```

- [ ] **Step 6: 验证路由**

运行 `npm run dev`，浏览器访问：
- `http://localhost:1420/` → 看到"一起数钱"标题和"账户管理"链接
- `http://localhost:1420/accounts` → 看到"账户管理"标题

- [ ] **Step 7: Commit**

```bash
git add src/router/ src/views/ src/App.vue src/main.ts
git commit -m "feat: add vue-router with Home and AccountList pages"
```

---

### Task 5: 注册 Tauri SQL + Haptics 插件

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: 在 Rust 端注册插件**

Replace `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_haptics::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 2: 添加 SQL 权限到 capabilities**

Edit `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "opener:default",
    "sql:default",
    "sql:allow-load",
    "sql:allow-execute",
    "sql:allow-select",
    "haptics:default",
    "haptics:allow-vibrate"
  ]
}
```

- [ ] **Step 3: 验证编译**

```bash
cargo check
```

Expected: 编译成功。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: register tauri-plugin-sql and tauri-plugin-haptics"
```

---

### Task 6: 创建 SQLite 连接与表初始化

**Files:**
- Create: `src/db/index.ts`
- Create: `src/types/index.ts`

- [ ] **Step 1: 创建类型定义（先建，供 db 和 stores 共用）**

Create `src/types/index.ts`:

```typescript
export interface Account {
  id: string;
  ledger_id: string;
  owner_id: string;
  name: string;
  type: AccountType;
  initial_balance: number;
  color: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  current_balance?: number;
}

export type AccountType = "bank" | "credit_card" | "digital" | "debt";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  bank: "银行卡",
  credit_card: "信用卡",
  digital: "电子钱包",
  debt: "借贷",
};

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

- [ ] **Step 2: 创建 SQLite 初始化模块**

Create `src/db/index.ts`:

```typescript
import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:wee-count.db");
    await initTables(db);
  }
  return db;
}

async function initTables(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'personal',
      team_id TEXT,
      owner_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      ledger_id TEXT REFERENCES ledgers(id) NOT NULL,
      owner_id TEXT REFERENCES users(id) NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'bank',
      initial_balance REAL NOT NULL DEFAULT 0.00,
      color TEXT DEFAULT '#3b82f6',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );
  `);
}

export async function ensureDefaultData(): Promise<void> {
  const database = await getDb();

  const existingUsers = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM users"
  );
  if (existingUsers[0].count === 0) {
    const now = new Date().toISOString();
    await database.execute(
      "INSERT INTO users (id, nickname, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["local-user-1", "我", "local@wee-count.app", now, now]
    );
  }

  const existingLedgers = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ledgers"
  );
  if (existingLedgers[0].count === 0) {
    const now = new Date().toISOString();
    await database.execute(
      "INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["personal-ledger-1", "个人账本", "personal", null, "local-user-1", now, now]
    );
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/db/index.ts src/types/index.ts
git commit -m "feat: add SQLite connection, table init, and TypeScript types"
```

---

### Task 7: 创建 Pinia ledgerStore

**Files:**
- Create: `src/stores/ledger.ts`

- [ ] **Step 1: 创建 ledgerStore**

Create `src/stores/ledger.ts`:

```typescript
import { defineStore } from "pinia";
import { ref } from "vue";
import { ensureDefaultData } from "@/db";
import type { Ledger } from "@/types";

export const useLedgerStore = defineStore("ledger", () => {
  const currentLedger = ref<Ledger | null>(null);
  const initialized = ref(false);

  async function init(): Promise<void> {
    if (initialized.value) return;
    await ensureDefaultData();
    // 后续阶段从 SQLite 加载用户所属的账本列表，当前阶段硬编码默认个人账本
    currentLedger.value = {
      id: "personal-ledger-1",
      name: "个人账本",
      type: "personal",
      team_id: null,
      owner_id: "local-user-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_deleted: false,
    };
    initialized.value = true;
  }

  return { currentLedger, initialized, init };
});
```

- [ ] **Step 2: Commit**

```bash
git add src/stores/ledger.ts
git commit -m "feat: add Pinia ledgerStore with default personal ledger"
```

---

### Task 8: 创建 accountStore（含单元测试，TDD）

**Files:**
- Create: `src/stores/__tests__/account.test.ts`
- Create: `src/stores/account.ts`

- [ ] **Step 1: 写测试文件**

Create `src/stores/__tests__/account.test.ts`:

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
          initial_balance: 5000,
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

  describe("add", () => {
    it("should insert account and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);
      // 第一次是 add 里的 INSERT 后 fetchAll
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ name: "新账户" }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.add({
        ledger_id: "pl-1",
        owner_id: "u-1",
        name: "新账户",
        type: "digital",
        initial_balance: 0,
        color: "#22c55e",
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO accounts"),
        expect.arrayContaining(["新账户"])
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
  });

  describe("remove", () => {
    it("should soft-delete and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useAccountStore();
      await store.remove("a1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        ["a1"]
      );
    });
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/stores/__tests__/account.test.ts
```

Expected: 所有 6 个测试 FAIL，报 `useAccountStore` 未定义。

- [ ] **Step 3: 实现 accountStore**

Create `src/stores/account.ts`:

```typescript
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getDb } from "@/db";
import type { Account, AccountType } from "@/types";

const BALANCE_QUERY = `
  SELECT
    a.id, a.ledger_id, a.owner_id, a.name, a.type,
    a.initial_balance, a.color, a.created_at, a.updated_at, a.is_deleted,
    (a.initial_balance
     + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
     - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
    ) AS current_balance
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
    initial_balance: number;
    color: string;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = generateId();
    await db.execute(
      `INSERT INTO accounts (id, ledger_id, owner_id, name, type, initial_balance, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ledger_id,
        input.owner_id,
        input.name,
        input.type,
        input.initial_balance,
        input.color,
        now,
        now,
      ]
    );
    await fetchAll(input.ledger_id);
  }

  async function update(
    id: string,
    data: Partial<Pick<Account, "name" | "type" | "initial_balance" | "color">>
  ): Promise<void> {
    const db = await getDb();
    const sets: string[] = [];
    const values: (string | number)[] = [];

    if (data.name !== undefined) {
      sets.push("name = ?");
      values.push(data.name);
    }
    if (data.type !== undefined) {
      sets.push("type = ?");
      values.push(data.type);
    }
    if (data.initial_balance !== undefined) {
      sets.push("initial_balance = ?");
      values.push(data.initial_balance);
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
    // 重新加载 — 需要知道 ledger_id，从当前列表中获取或传入
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

  return { accounts, totalBalance, fetchAll, add, update, remove };
});
```

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/stores/__tests__/account.test.ts
```

Expected: 所有 6 个测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/stores/account.ts src/stores/__tests__/account.test.ts
git commit -m "feat: add accountStore with CRUD and unit tests"
```

---

### Task 9: 创建 AppHeader 组件

**Files:**
- Create: `src/components/AppHeader.vue`

- [ ] **Step 1: 创建 AppHeader**

Create `src/components/AppHeader.vue`:

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
    class="flex h-14 items-center border-b border-gray-200 bg-surface px-4"
  >
    <button
      v-if="showBack"
      class="mr-3 flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
      @click="$emit('back')"
    >
      <ArrowLeft :size="20" class="text-text" />
    </button>
    <h1 class="text-lg font-semibold text-text">{{ title }}</h1>
  </header>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AppHeader.vue
git commit -m "feat: add AppHeader component with optional back button"
```

---

### Task 10: 创建 AccountCard 组件

**Files:**
- Create: `src/components/AccountCard.vue`

- [ ] **Step 1: 创建 AccountCard**

Create `src/components/AccountCard.vue`:

```vue
<script setup lang="ts">
import {
  Building2,
  CreditCard,
  Smartphone,
  Scale,
} from "lucide-vue-next";
import type { Account, AccountType } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { computed } from "vue";

const props = defineProps<{
  account: Account;
}>();

const emit = defineEmits<{
  tap: [];
  longpress: [];
}>();

const iconMap: Record<AccountType, typeof Building2> = {
  bank: Building2,
  credit_card: CreditCard,
  digital: Smartphone,
  debt: Scale,
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

// 长按检测
let pressTimer: ReturnType<typeof setTimeout> | null = null;

function onTouchStart() {
  pressTimer = setTimeout(() => {
    emit("longpress");
  }, 500);
}

function onTouchEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onClick() {
  emit("tap");
}
</script>

<template>
  <div
    class="flex cursor-pointer items-center gap-3 rounded-xl bg-surface p-4 shadow-sm transition-shadow hover:shadow-md"
    :style="{ borderLeft: `4px solid ${account.color}` }"
    @touchstart.passive="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchEnd"
    @click="onClick"
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
      <p
        class="text-base font-semibold"
        :class="(account.current_balance ?? 0) >= 0 ? 'text-text' : 'text-expense'"
      >
        {{ formatBalance(account.current_balance ?? 0) }}
      </p>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/AccountCard.vue
git commit -m "feat: add AccountCard component with long-press support"
```

---

### Task 11: 创建 AccountSheet 底部弹出面板

**Files:**
- Create: `src/components/AccountSheet.vue`

- [ ] **Step 1: 创建 AccountSheet**

Create `src/components/AccountSheet.vue`:

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { X, Building2, CreditCard, Smartphone, Scale } from "lucide-vue-next";
import type { Account, AccountType } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";

const props = defineProps<{
  visible: boolean;
  editAccount?: Account | null; // null = 新增模式, Account = 编辑模式
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    data: {
      name: string;
      type: AccountType;
      initial_balance: number;
      color: string;
    }
  ];
}>();

const name = ref("");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const color = ref("#3b82f6");

const ACCOUNT_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "bank", icon: Building2 },
  { type: "credit_card", icon: CreditCard },
  { type: "digital", icon: Smartphone },
  { type: "debt", icon: Scale },
];

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#64748b",
];

// 编辑模式下预填
watch(
  () => [props.visible, props.editAccount] as const,
  ([v, acc]) => {
    if (v) {
      if (acc) {
        name.value = acc.name;
        accountType.value = acc.type;
        initialBalance.value = String(acc.initial_balance);
        color.value = acc.color;
      } else {
        name.value = "";
        accountType.value = "bank";
        initialBalance.value = "0";
        color.value = "#3b82f6";
      }
    }
  }
);

function handleSubmit() {
  if (!name.value.trim()) return;
  emit("submit", {
    name: name.value.trim(),
    type: accountType.value,
    initial_balance: parseFloat(initialBalance.value) || 0,
    color: color.value,
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
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">
            {{ editAccount ? "编辑账户" : "添加账户" }}
          </h2>
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

        <!-- 类型选择 -->
        <label class="mb-2 block text-sm font-medium text-text">账户类型</label>
        <div class="mb-4 grid grid-cols-4 gap-2">
          <button
            v-for="item in ACCOUNT_TYPES"
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
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

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
          {{ editAccount ? "保存" : "添加" }}
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
git commit -m "feat: add AccountSheet bottom panel for add/edit account"
```

---

### Task 12: 实现 AccountList 页面完整功能

**Files:**
- Modify: `src/views/AccountList.vue`

- [ ] **Step 1: 替换 AccountList 为完整实现**

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
import type { Account } from "@/types";

const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();

const sheetVisible = ref(false);
const editingAccount = ref<Account | null>(null);
const isLoading = ref(true);

onMounted(async () => {
  await ledgerStore.init();
  if (ledgerStore.currentLedger) {
    await accountStore.fetchAll(ledgerStore.currentLedger.id);
  }
  isLoading.value = false;
});

function openAdd() {
  editingAccount.value = null;
  sheetVisible.value = true;
}

function openEdit(account: Account) {
  editingAccount.value = account;
  sheetVisible.value = true;
}

function handleDelete(account: Account) {
  if (confirm(`确定删除账户"${account.name}"吗？`)) {
    accountStore.remove(account.id);
  }
}

async function handleSubmit(data: {
  name: string;
  type: import("@/types").AccountType;
  initial_balance: number;
  color: string;
}) {
  if (!ledgerStore.currentLedger) return;

  if (editingAccount.value) {
    await accountStore.update(editingAccount.value.id, data);
  } else {
    await accountStore.add({
      ledger_id: ledgerStore.currentLedger.id,
      owner_id: ledgerStore.currentLedger.owner_id,
      ...data,
    });
  }
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="账户管理" :show-back @back="router.push('/')" />

    <!-- 总资产汇总 -->
    <div class="bg-surface px-4 py-4">
      <p class="text-xs text-text-secondary">总资产</p>
      <p class="mt-0.5 text-2xl font-bold text-text">
        ¥{{ accountStore.totalBalance.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </p>
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
          @tap="openEdit(account)"
          @longpress="handleDelete(account)"
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

    <!-- 新增/编辑 Sheet -->
    <AccountSheet
      :visible="sheetVisible"
      :edit-account="editingAccount"
      @close="sheetVisible = false"
      @submit="handleSubmit"
    />
  </div>
</template>
```

- [ ] **Step 2: 验证页面渲染**

```bash
npm run dev
```

浏览器访问 `http://localhost:1420/accounts`，确认：
- 顶部栏显示"账户管理"
- 总资产显示 `¥0.00`
- 空状态引导文案和"添加第一个账户"链接
- 底部"添加账户"按钮

- [ ] **Step 3: Commit**

```bash
git add src/views/AccountList.vue
git commit -m "feat: implement AccountList page with full CRUD flow"
```

---

### Task 13: 收尾 — 更新 index.html 标题

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 更新页面标题**

Edit `index.html`，替换 `<title>`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>一起数钱 - WeeCount</title>
  </head>

  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: 运行完整验证**

```bash
# 类型检查
npx vue-tsc --noEmit

# 单元测试
npx vitest run

# 构建验证
npm run build
```

Expected: 全部通过，无报错。

- [ ] **Step 3: 最终 commit**

```bash
git add index.html
git commit -m "chore: update page title and fix lang attribute"
```
