# Phase 2 单机纯净版 — 基础设施 + 账户管理闭环

## 1. 目标

补齐开发环境基础设施，完成账户管理的完整闭环：查看账户列表、动态余额计算、新增/编辑账户、软删除。

## 2. UI 技术选型

- **样式**：Tailwind CSS v4（`@tailwindcss/vite`），不使用 UI 组件库
- **图标**：Lucide（`lucide-vue-next`），tree-shakable，线条风格

## 3. 依赖清单

### 前端新增

```
tailwindcss @tailwindcss/vite
vue-router
pinia
@tauri-apps/plugin-sql
lucide-vue-next
```

### Rust 新增

```toml
[dependencies]
tauri-plugin-sql = { version = "2", features = ["sqlite"] }
tauri-plugin-haptics = "2"
```

## 4. 目录结构

```
src/
  main.ts              # createApp → router → pinia → mount
  App.vue              # <RouterView />
  router/index.ts      # 路由定义
  stores/
    account.ts         # useAccountStore
    ledger.ts          # useLedgerStore（当前账本）
  db/
    index.ts           # SQLite 连接 + 表初始化
  views/
    Home.vue           # 首页占位
    AccountList.vue    # 账户列表页

components/            # 按需创建
```

## 5. 路由

| 路径 | 页面 | 说明 |
|---|---|---|
| `/` | Home | 首页占位 |
| `/accounts` | AccountList | 账户列表 + 新增/编辑 Sheet |

## 6. SQLite 表结构

在 `db/index.ts` 中，连接 SQLite 后执行 `CREATE TABLE IF NOT EXISTS`：

```sql
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
    type TEXT NOT NULL,          -- 'personal' | 'team'
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
    type TEXT NOT NULL,          -- 'bank' | 'credit_card' | 'digital' | 'debt'
    initial_balance REAL NOT NULL DEFAULT 0.00,
    color TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_deleted INTEGER DEFAULT 0
);

-- 预留，第二阶段不建表
-- CREATE TABLE IF NOT EXISTS transactions ( ... );
-- CREATE TABLE IF NOT EXISTS categories ( ... );
-- CREATE TABLE IF NOT EXISTS tags ( ... );
-- CREATE TABLE IF NOT EXISTS transaction_tags ( ... );
```

初始化时插入默认个人账本和默认用户（本地占位）。

## 7. 账户余额计算 SQL

余额动态聚合，不维护 `balance` 字段：

```sql
SELECT 
    a.id, a.name, a.type, a.initial_balance,
    (a.initial_balance 
     + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
     - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
    ) AS current_balance
FROM accounts a
WHERE a.ledger_id = ? AND a.is_deleted = 0;
```

当前阶段 `transactions` 表不存在，子查询返回 0（COALESCE），不影响结果。

## 8. Pinia Store — accountStore

```typescript
// stores/account.ts
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { Account } from '@/types';

export const useAccountStore = defineStore('account', () => {
  const accounts = ref<Account[]>([]);

  const totalBalance = computed(() =>
    accounts.value.reduce((sum, a) => sum + a.current_balance, 0)
  );

  async function fetchAll(ledgerId: string): Promise<void> {
    // SQLite query → accounts.value
  }

  async function add(account: Omit<Account, 'id' | 'created_at' | 'updated_at'>): Promise<void> {
    // INSERT INTO accounts ...
    // then fetchAll()
  }

  async function update(id: string, data: Partial<Account>): Promise<void> {
    // UPDATE accounts SET ... WHERE id = ?
    // then fetchAll()
  }

  async function remove(id: string): Promise<void> {
    // UPDATE accounts SET is_deleted = 1 WHERE id = ?
    // then fetchAll()
  }

  return { accounts, totalBalance, fetchAll, add, update, remove };
});
```

## 9. 页面交互设计

### AccountList 页面

- **列表区域**：账户卡片，左侧颜色条 + 图标 + 账户名 + 余额
- **底部按钮**：`+ 添加账户`
- **空状态**：当账户列表为空，显示引导文案

### 新增/编辑底部 Sheet

- 从底部滑入面板，不跳路由
- 表单字段：名称（必填）、类型（四选一按钮组）、初始余额（数字键盘输入）、颜色选择
- 编辑时预填当前值
- 提交后 Sheet 收起，列表刷新

### 删除

- 长按卡片 → 确认弹窗 → 软删除（`is_deleted = 1`）
- 不做物理删除

## 10. 任务拆分

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| 1 | 安装所有依赖 | npm + Cargo 依赖到位 | `npm run dev` + `cargo check` |
| 2 | Tailwind v4 配置 | Vite 插件 + 全局 CSS | Tailwind 样式生效 |
| 3 | 路由 + 页面骨架 | `/` 和 `/accounts` 可导航 | 手动切路由 |
| 4 | SQLite 连接 + 表初始化 | `db/index.ts` 连接并建表 | 无报错，表存在 |
| 5 | Pinia accountStore | `stores/account.ts` | 单元测试覆盖 CRUD |
| 6 | 账户列表 UI | AccountList 页面 + 卡片 | 浏览器中卡片可见 |
| 7 | 新增/编辑 Sheet | 底部弹出表单面板 | 新增 → 列表刷新 |
| 8 | 删除 + 长按交互 | 长按弹确认 → 删除 | 长按删除 → 列表刷新 |
