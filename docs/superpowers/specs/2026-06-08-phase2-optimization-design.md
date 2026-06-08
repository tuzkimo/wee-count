# Phase 2 账户管理优化方案 — 设计文档

**日期**: 2026-06-08
**状态**: 待实施
**范围**: 对 Phase 2 账户管理闭环的三个维度优化

---

## 一、状态栏安全区适配

### 问题

当前视图 `min-h-screen` 从屏幕顶部（状态栏区域）开始绘制，Android 状态栏会遮盖 AppHeader 和页面内容。

### 方案

| 文件 | 改动 |
|---|---|
| `index.html` | viewport meta 添加 `viewport-fit=cover`，启用安全区 API |
| `src/assets/main.css` | body 添加 `padding-top: env(safe-area-inset-top)`，确保所有页面内容在状态栏下方 |
| `src/components/AppHeader.vue` | header 顶部添加 `pt-[env(safe-area-inset-top)]`，使背景色覆盖安全区 |

**原理**：`env(safe-area-inset-top)` 在 Android 上返回状态栏高度（通常 24px），iOS 上返回刘海/灵动岛区域高度。`viewport-fit=cover` 告诉浏览器内容可以延伸到屏幕边缘，安全区由 CSS 处理。

---

## 二、导航流程重构

### 现状

- 点击账户卡片 → 弹出 AccountSheet（底部面板）进行编辑
- 长按账户卡片 → `confirm()` 删除账户
- AccountSheet 同时承载新增和编辑两种模式

### 目标

- 点击账户卡片 → 进入该账户的流水列表页（占位）
- 流水列表页右上角显示编辑按钮 → 进入编辑页
- 编辑页右上角放删除按钮，底部放保存按钮
- 新增账户保持从账户列表底部按钮触发 AccountSheet
- 长按功能暂时不实现（拖拽排序涉及多用户偏好单独存储，留待后续）

### 页面路由

```
/                               → Home（不变）
/accounts                       → AccountList（改）
/accounts/:id/transactions      → TransactionList（新建）
/accounts/:id/edit              → AccountEdit（新建）
```

### 组件职责变化

| 组件 | 变化 |
|---|---|
| `AccountList.vue` | 点击账户卡片 → `router.push` 到流水页；移除长按删除逻辑；保留底部添加按钮触发 AccountSheet |
| `AccountCard.vue` | 移除 `longpress` emit 和 `touchstart/touchend/touchmove` 长按检测逻辑；仅保留正常的 `tap` emit |
| `AccountSheet.vue` | 去编辑化，仅用于新增账户模式；移除 `editAccount` prop 和编辑模式逻辑 |
| `TransactionList.vue` | **新建**，占位页；AppHeader 带返回 + 账户名称标题 + 右侧编辑按钮 |
| `AccountEdit.vue` | **新建**，完整编辑表单页；AppHeader 右侧放删除按钮；底部放保存按钮 |

### 新增流程

```
AccountList
  │
  ├─ 点击卡片 → TransactionList (/accounts/:id/transactions)
  │                ├─ AppHeader: 返回 + 账户名 + 编辑按钮(✏️)
  │                │       └─ 点击编辑 → AccountEdit (/accounts/:id/edit)
  │                │                        ├─ AppHeader: 返回 + "编辑账户" + 删除按钮(🗑️)
  │                │                        ├─ 表单内容：名称、类型、余额、颜色、条件字段
  │                │                        └─ 底部：保存按钮
  │                └─ 页面内容：流水为空 → 空状态占位
  │
  └─ 底部"添加账户" → AccountSheet（底部弹出面板，仅新增）
```

### 编辑页保存流程

```
AccountEdit 保存按钮点击
  → 调用 accountStore.update(id, data)
  → 成功后 router.back() 返回流水页
```

### 编辑页删除流程

```
AccountEdit 右上角删除按钮点击
  → 弹出 ConfirmDialog
    → 确认 → accountStore.remove(id) → router.replace('/accounts')
    → 取消 → 无操作
```

---

## 三、账户类型体系重构

### 新类型结构

```
AccountCategory: "asset" | "liability"

asset (资产账户) — 余额取正值
  ├─ cash             现金
  ├─ bank             银行卡/储蓄卡
  └─ digital          电子钱包（支付宝、微信零钱）

liability (负债账户) — 余额取负值
  ├─ credit_card      信用卡
  ├─ huabei           花呗
  ├─ meituan_monthly  美团月付
  └─ other_loan       其他借贷
```

### TypeScript 类型定义

```typescript
export type AccountCategory = "asset" | "liability";
export type AssetType = "cash" | "bank" | "digital";
export type LiabilityType = "credit_card" | "huabei" | "meituan_monthly" | "other_loan";
export type AccountType = AssetType | LiabilityType;

export const ACCOUNT_CATEGORY: Record<AccountType, AccountCategory> = {
  cash: "asset", bank: "asset", digital: "asset",
  credit_card: "liability", huabei: "liability", 
  meituan_monthly: "liability", other_loan: "liability",
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
```

### Account 接口新增字段

```typescript
export interface Account {
  // ... 现有字段不变
  category?: AccountCategory;     // "asset" | "liability"
  credit_limit?: number;          // 信用额度（选填，仅负债账户）
  repayment_day?: number;         // 还款日 1-31（选填，仅负债账户）
}
```

### 表单条件显示

- 类型选择区域按资产/负债分组展示
- 选中负债类型后，展开显示"信用额度"和"还款日"两个可选输入框
- 资产类型下不显示这两个字段

---

## 四、余额计算规则

### 存储原则

- `initial_balance` 始终存绝对值（正数），不区分资产/负债
- `category` 字段标记账户类别，决定显示时的符号

### SQL 计算 current_balance

```sql
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
```

### 显示规则

| 场景 | 资产账户 | 负债账户 |
|---|---|---|
| 余额正负 | 正 | 负 |
| AccountCard 余额颜色 | `text-text`（黑色） | `text-expense`（红色） |
| 总资产汇总 | 正数累加 | 负数累加 |

### 总资产汇总重构

账户列表页顶部改为"净资产"（资产合计 - 负债合计）：

```
净资产                     ← 大字号，加粗
¥12,500.00

资产 ¥50,000.00  负债 -¥37,500.00  ← 两行并列小字
```

---

## 五、数据库变更

### accounts 表新结构

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  ledger_id TEXT REFERENCES ledgers(id) NOT NULL,
  owner_id TEXT REFERENCES users(id) NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'bank',
  category TEXT NOT NULL DEFAULT 'asset',
  initial_balance REAL NOT NULL DEFAULT 0.00,
  credit_limit REAL,                  -- 新增，选填，仅负债账户
  repayment_day INTEGER,              -- 新增，选填，仅负债账户（1-31）
  color TEXT DEFAULT '#3b82f6',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  is_deleted INTEGER DEFAULT 0
);
```

由于处于开发初期、无数据需保留，直接修改 `initTables` 中的 `CREATE TABLE` 即可，无需迁移逻辑。

---

## 六、新建组件

### ConfirmDialog.vue

样式与应用整体协调的确认对话框，替代 `window.confirm()`。

**设计**：
- Teleport 到 body，半透明黑色遮罩（z-50）
- 居中白色圆角卡片，带 scale 进出动画
- 标题行（`text-text`, `font-semibold`）
- 副标题行（`text-text-secondary`，可选）
- 底部两个按钮并排：取消（灰色背景）+ 确认（红色 `bg-expense`）

**Props**：
- `visible: boolean` — 是否显示
- `title: string` — 标题文字
- `description?: string` — 副标题文字
- `confirmText?: string` — 确认按钮文字（默认"确认"）
- `cancelText?: string` — 取消按钮文字（默认"取消"）
- `danger?: boolean` — 确认按钮是否为危险操作样式（默认 false）

**Emits**：`confirm`, `cancel`

**使用示例**（编辑页删除）：
```vue
<ConfirmDialog
  :visible="deleteDialogVisible"
  title="确定删除账户&quot;招商储蓄卡&quot;吗？"
  description="删除后不可恢复"
  confirm-text="删除"
  danger
  @confirm="handleDelete"
  @cancel="deleteDialogVisible = false"
/>
```

---

## 七、受影响的现有文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `index.html` | 改 | viewport meta |
| `src/assets/main.css` | 改 | 安全区 CSS + body padding |
| `src/types/index.ts` | 改 | 类型体系重构 |
| `src/db/index.ts` | 改 | accounts 表结构更新 |
| `src/stores/account.ts` | 改 | BALANCE_QUERY 更新，add/update 适配新字段 |
| `src/stores/__tests__/account.test.ts` | 改 | 测试适配新类型和字段 |
| `src/router/index.ts` | 改 | 新增两条路由 |
| `src/components/AppHeader.vue` | 改 | 安全区 padding + 支持右侧操作槽位 |
| `src/components/AccountCard.vue` | 改 | 移除长按逻辑 |
| `src/components/AccountSheet.vue` | 改 | 去编辑化，仅新增；负债类型条件字段 |
| `src/components/ConfirmDialog.vue` | **新建** | 确认对话框 |
| `src/views/AccountList.vue` | 改 | 导航变更 + 净资产显示 |
| `src/views/TransactionList.vue` | **新建** | 流水占位页 |
| `src/views/AccountEdit.vue` | **新建** | 编辑页 |

---

## 八、不出现在本次范围内的内容

- 拖拽排序（涉及多用户偏好存储，留待后续）
- 流水列表功能（占位即可）
- 超额限制和还款提醒功能（仅保留信用额度/还款日字段）
- icons 映射更新（给新类型配上合适的 lucide 图标）
