# Phase 3 记账交易闭环 — 设计文档

> 状态：待实现 | 日期：2026-06-09

## 1. 目标

在纯单机环境下，实现完整的记账-查看-编辑闭环：分类 + 标签 + 交易（收入/支出/转账）+ 底部 Tab 导航。数字键盘和拼音联想本期不做，用系统键盘和简单标签搜索替代。

## 2. 数据库变更

### 2.1 新建表

```sql
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  ledger_id TEXT,           -- NULL = 系统默认分类
  name TEXT NOT NULL,
  type TEXT NOT NULL,       -- 'income' | 'expense'
  icon TEXT,                -- emoji 图标
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

### 2.2 transactions 表迁移

现有 transactions 表需扩至与开发方案一致的结构：

- 新增 `category_id TEXT REFERENCES categories(id)`
- 新增 `user_id TEXT NOT NULL DEFAULT 'local-user-1' REFERENCES users(id)`
- 旧字段 `category`（文本）、`note` 因 SQLite 不支持 DROP COLUMN，保留但不使用

迁移逻辑采用与 accounts 迁移相同的 PRAGMA 检测方式（检测目标列是否存在，不存在则 ALTER TABLE ADD COLUMN ... DEFAULT ...）。

### 2.3 预设分类

在 `ensureDefaultData` 中插入系统默认分类（ledger_id = NULL）：

| name | type | icon | sort_order |
|------|------|------|------------|
| 餐饮 | expense | 🍜 | 1 |
| 交通 | expense | 🚌 | 2 |
| 购物 | expense | 🛒 | 3 |
| 娱乐 | expense | 🎮 | 4 |
| 居家 | expense | 🏠 | 5 |
| 通讯 | expense | 📱 | 6 |
| 医疗 | expense | 💊 | 7 |
| 其他支出 | expense | 💸 | 99 |
| 工资 | income | 💰 | 1 |
| 奖金 | income | 🎁 | 2 |
| 理财 | income | 📈 | 3 |
| 退款 | income | ↩️ | 4 |
| 报销 | income | 🧾 | 5 |
| 其他收入 | income | 📥 | 99 |

## 3. 类型定义

```typescript
// 新增
export type CategoryType = "income" | "expense";
export interface Category {
  id: string;
  ledger_id: string | null;  // null = 系统默认
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

// 更新
export type TransactionType = "income" | "expense" | "transfer";
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

## 4. Store 设计

### 4.1 categoryStore

```
只读。系统预设分类 + 账本自定义分类（本期只有预设）。
fetchAll(ledgerId) — 加载当前账本可用的所有分类，系统默认和账本级别 UNION
```

### 4.2 tagStore

```
tags: Tag[]
fetchAll(ledgerId) — 加载当前账本标签
add(ledgerId, name) — 创建新标签。SQLite 有 UNIQUE(ledger_id, name) 约束，同名时 db.execute 抛出异常，由调用方 catch 处理（UI 提示"标签已存在"）
remove(id) — 软删除
```

### 4.3 transactionStore

```
transactions: Transaction[]

fetchAll(ledgerId, accountId?) — 加载交易列表：
  - 联查 categories、tags（GROUP_CONCAT + 前端组装）、from/to accounts
  - 可选按 accountId 过滤（匹配 from_account_id 或 to_account_id）
  - 按 occurred_at DESC + created_at DESC 排序

add(data) — 新增交易 + 插入 transaction_tags 行
update(id, data) — 更新交易行 + DELETE + INSERT transaction_tags（全量替换）
remove(id) — 软删除（不删除关联的 transaction_tags，查询时过滤 is_deleted=0 即可）

totalIncome / totalExpense — computed，从已加载的 transactions 计算（用于汇总显示）
```

**余额联动：** add/update/remove 操作后自动调用 accountStore.fetchAll 刷新账户余额。

## 5. 路由 + Tab 导航

```
路由表：
/             → RecordPage（记账新增）
/record/:id   → RecordPage（记账编辑，复用同一组件）
/transactions → TransactionList（流水列表）
/transactions?account=:id → TransactionList（按账户过滤，可选）
/accounts     → AccountList（已有）
/settings     → SettingsPage（占位）
```

底部 Tab 栏（App.vue 中实现）：

```
[🏠 记账]  [📋 流水]  [💳 账户]  [⚙️ 设置]
```

- 当前路由激活的 Tab 高亮
- 记账/流水/账户三个 Tab 有对应页面，设置 Tab 为占位
- Tab 栏固定在底部，使用 `bg-surface border-t` 样式

## 6. 页面设计

### 6.1 记账/编辑页（RecordPage）

核心交互：类型 → 分类 → 账户 → 日期 → 金额 → 标签 → 保存。

```
┌─────────────────────────────┐
│  收入  |  支出  |  转账      │  ← 类型切换 Tab（3 个按钮横向排列）
├─────────────────────────────┤
│  分类区域：                  │
│  🍜 餐饮  🚌 交通  🛒 购物   │  ← 分类网格（3 列网格）
│  ...                        │    转账模式下隐藏此区域
├─────────────────────────────┤
│  账户：爸爸的招行卡     ▼   │  ← 账户选择器
│  （转账：转出账户 → 转入账户）│    转账模式显示两个选择器
├─────────────────────────────┤
│  📅 2026-06-09 14:30    ▼  │  ← 日期时间选择（系统 datetime-local input）
├─────────────────────────────┤
│        ¥ 1,234.56           │  ← 金额输入（type="number"）
├─────────────────────────────┤
│  标签：🍜 餐饮  🏷️ 工作日    │  ← 已选标签 chips（× 删除）
│  [+ 添加标签]               │  ← 点击打开标签 Sheet
├─────────────────────────────┤
│         [ 记一笔 ]          │  ← 保存按钮（编辑模式下显示"保存"）
└─────────────────────────────┘
```

**字段映射：**
| UI 字段 | Transaction 字段 | 必填 | 备注 |
|---------|-----------------|------|------|
| 类型 | `type` | 是 | 默认"支出" |
| 分类 | `category_id` | 收支时必填 | 转账时隐藏 |
| 账户 | `from_account_id` | 支出/转账必填 | 支出=扣款账户，转账=转出 |
| - | `to_account_id` | 收入/转账必填 | 收入=入账账户，转账=转入 |
| 日期 | `occurred_at` | 是 | 默认当前时间，不限制前后 |
| 金额 | `amount` | 是 | > 0，2 位小数 |
| 标签 | `tag_ids[]` | 否 | 多选 |

**编辑模式（路径 /record/:id）：**
- 从 transactionStore 获取已有交易，所有字段预填
- AppHeader 右侧显示删除按钮 + ConfirmDialog
- 分类/账户/标签选中状态与新增模式相同
- 保存 → transactionStore.update
- 删除 → transactionStore.remove → router.replace('/transactions')

### 6.2 标签选择 Sheet

点击"添加标签"时从底部弹出：

```
┌─────────────────────────────┐
│  添加标签                  ✕│
├─────────────────────────────┤
│  [🔍 搜索已有标签        ]  │  ← 搜索框，实时过滤
├─────────────────────────────┤
│  ☑ 午餐                     │  ← 已有标签列表（点击切换选中）
│  ☐ 通勤                     │
│  ☐ 娱乐                     │
├─────────────────────────────┤
│  + 创建标签 "新标签名"       │  ← 搜索无结果时显示，输入即创建
├─────────────────────────────┤
│         [ 确定 ]            │  ← 关闭 Sheet，回传选中标签
└─────────────────────────────┘
```

- 搜索框输入时实时过滤已有标签（简单 `LIKE '%keyword%'`）
- 已选中的标签显示 checkbox 勾选状态
- 搜索无匹配且输入内容非空，显示"创建标签"行
- 确定后回传选中的标签 ID 列表给 RecordPage

### 6.3 流水页（TransactionList）

```
┌─────────────────────────────┐
│ ← 流水                      │
├─────────────────────────────┤
│  全部账户              ▼   │  ← 下拉过滤
├─────────────────────────────┤
│  6月9日 周一                │  ← 日期分组标题
│  ┌─────────────────────┐    │
│  │ 🍜 餐饮        -¥32.50│  │  ← 点击 → /record/:id
│  │ 爸爸的招行卡          │    │
│  │ 🏷️ 午餐 工作日        │    │
│  └─────────────────────┘    │
│  ┌─────────────────────┐    │
│  │ 💰 工资       +¥8000.00│ │
│  │ 爸爸的招行卡          │    │
│  └─────────────────────┘    │
│  ┌─────────────────────┐    │
│  │ 🔄 转账        ¥500.00│  │
│  │ 招行卡 → 微信         │    │
│  └─────────────────────┘    │
│  6月8日 周日                │
│  ...                        │
├─────────────────────────────┤
│  空状态：暂无流水记录         │
└─────────────────────────────┘
```

- 按 `occurred_at` 降序排列，日期分组
- 支出金额红色（`text-expense`），收入金额绿色（`text-income`），转账默认色
- 账户过滤器从 accountStore 加载账户列表，默认"全部"
- 过滤逻辑在 store 查询层面完成（pass accountId 参数）
- 点击卡片 → 跳转 `/record/:id`（编辑）
- 支持从路由 query `?account=:id` 读取过滤条件（兼容原有 AccountList → tap → transactions 跳转）

### 6.4 设置页（SettingsPage）

占位，显示"设置"标题 + "开发中"提示。

### 6.5 首页废弃

原有 `Home.vue` 占位内容废弃，路由 `/` 改为指向 RecordPage。Home.vue 文件可以删除。

## 7. 文件变更总览

```
修改:
  src/db/index.ts                 # 建 categories/tags/transaction_tags 表 + transactions 迁移 + 预设分类
  src/types/index.ts              # 新增 Category/Tag 类型；更新 Transaction 类型
  src/router/index.ts             # 重构路由（Tab 导航 + 新页面）
  src/App.vue                     # 底部 Tab 导航布局
  src/views/TransactionList.vue   # 替换占位为完整流水页

新建:
  src/stores/category.ts          # 分类 store
  src/stores/tag.ts               # 标签 store
  src/stores/transaction.ts       # 交易 store
  src/stores/__tests__/transaction.test.ts  # 交易 store 测试（7 个用例）
  src/views/RecordPage.vue        # 记账/编辑页
  src/views/SettingsPage.vue      # 设置页占位
  src/components/TagSheet.vue     # 标签选择底部 Sheet

删除:
  src/views/Home.vue              # 废弃，路由 / 由 RecordPage 接管
```

## 8. 测试计划

### transactionStore 单元测试（7 个）

1. fetchAll — 加载所有交易，验证关联数据（category、tags、accounts）正确填充
2. fetchAll with account filter — 按账户过滤仅返回匹配交易
3. add (expense) — 新增支出交易 + transaction_tags + 刷新账户余额
4. add (transfer) — 新增转账交易（from + to）
5. update — 更新交易 + 标签重建
6. remove — 软删除
7. totalIncome / totalExpense — computed 计算正确

### 集成验证

- `npx vitest run` — 全部测试通过
- `npx vue-tsc --noEmit` — 无类型错误
- `cargo check` — Rust 编译通过
- `npm run build` — 生产构建成功

## 9. 边界与范围

**本期做：**
- 数据库建表 + 迁移 + 预设分类
- 交易 CRUD（收入/支出/转账）
- 标签 CRUD + 标签选择 Sheet（简单搜索，无拼音联想）
- 交易编辑（修改 + 删除）
- 流水列表（日期分组 + 账户过滤 + 交易卡片）
- 底部 Tab 导航（记账/流水/账户/设置）
- 日期时间选择（系统原生 input）

**本期不做：**
- 自定义数字键盘（后续迭代）
- 标签拼音联想（后续迭代）
- 流水搜索/统计图表（后续迭代）
- 批量操作（后续迭代）
- 设置页功能（后续迭代）
- 分类自定义（后续迭代）
