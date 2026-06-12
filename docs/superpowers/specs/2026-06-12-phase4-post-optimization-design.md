# Phase 4 后续优化设计

## 概述

Phase 4 UI 优化已开发完成并经四轮 bug 修复。本轮在此基础上做三个定向优化：自定义日期时间选择器、首页汇总卡片改造、账户详情页批量删除。

---

## 1. 自定义日期时间选择器 — `DateTimePicker.vue`

### 现状

`DateTimeSheet.vue` 从未创建。`RecordPage.vue` 用原生 `<input type="datetime-local">`，`FilterPage.vue` 用两个原生 `<input type="datetime-local">`，样式与整体设计不统一。

### 方案

**新建 `src/components/DateTimePicker.vue`**，单行四列滚轮式底部弹出组件。

### 组件接口

```typescript
// Props
props: {
  visible: boolean           // 是否显示
  modelValue: string         // ISO datetime-local 格式 "YYYY-MM-DDTHH:mm"
}

// Emits
emit: {
  confirm: [value: string]   // 用户点击确定，返回 "YYYY-MM-DDTHH:mm"
  close: []                  // 用户关闭（不保存）
}
```

### 视觉结构

```
┌──────────────────────────────────────────┐
│           选择日期时间             ✕     │  ← Header
├──────────────────────────────────────────┤
│                                          │
│   ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐│
│   │2025年│  │      │  │      │  │      ││
│   │ 6月 ▲│  │ 12日▲│  │ 14 ▲ │  │ 30 ▲ ││
│   │2025年│  │ 11日 │  │ 13   │  │ 25   ││  ← 四列滚轮
│   │ 5月  │  │ 10日 │  │ 12   │  │ 20   ││    选中行居中高亮
│   │2025年│  │  9日 │  │ 11   │  │ 15   ││    上下项渐隐
│   │ 4月 ▼│  │  8日▼│  │ 10 ▼ │  │ 10 ▼ ││
│   └──────┘  └──────┘  └──────┘  └──────┘│
│   年月      日        时       分        │  ← 列标签
│                                          │
├──────────────────────────────────────────┤
│              [ 确  定 ]                  │
└──────────────────────────────────────────┘
```

**四列内容：**

| 列 | 内容 | 范围 | 说明 |
|----|------|------|------|
| 年月 | 年+月组合 | 当前年份 ±10 年 × 12 个月 | 每条为"2025年6月"格式 |
| 日 | 日期 | 1 ~ 当月最大天数 | 随年月列联动更新 |
| 时 | 小时 | 00 ~ 23 | 两位数字 |
| 分 | 分钟 | 00 ~ 55 | 步长 5 分钟 |

### 技术实现

- 底部弹出 sheet，Teleport 到 body，遮罩 + 滑入动画
- 每列独立 `<div>` 滚动容器，CSS `scroll-snap-type: y mandatory` + `scroll-snap-align: center`
- 滚轮 item 高度固定（如 40px），容器高度 = item × 5（显示 5 行，选中行在中间）
- 日期联动：年月列变化 → 重新计算日列的最大值 → 如当前选中日超出范围则自动修正
- 初始化时根据 `modelValue` 滚动到对应位置
- 点击确定时拼接 `YYYY-MM-DDTHH:mm` 格式 emit

### 使用方

- **RecordPage**: 替换原生 `<input type="datetime-local">`，用按钮触发 DateTimePicker
- **FilterPage**: 两个独立 DateTimePicker 实例，分别绑定 `dateFrom`、`dateTo`

---

## 2. 首页汇总卡片改造 — 收入/支出/结余

### 现状

首页模式显示净资产/资产/负债，依赖 `accountStore` 的静态余额数据。没有默认时间筛选，所有流水不加日期过滤直接加载。

### 方案

**改动文件：`src/views/TransactionList.vue`**（仅首页模式 `!isAccountMode`）

### 2.1 默认筛选逻辑

进入 `/` 且无 query 参数时，自动设置当月为默认日期范围：

```typescript
function ensureDefaultFilter() {
  const q = route.query
  if (!q.dateFrom && !q.dateTo) {
    const now = new Date()
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1)
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
    router.replace({
      query: {
        ...q,
        dateFrom: toLocalDatetimeString(firstDay),
        dateTo: toLocalDatetimeString(lastDay),
      }
    })
  }
}
```

- `router.replace` 写入 URL，不产生浏览器历史
- `buildFetchOpts()` 照常从 query 读取，无需改动
- 已有筛选条件时（query 非空），按已有条件筛选

### 2.2 筛选状态栏

位于 Header 与汇总卡片之间，横向可滚动：

```
┌───────────────────────────────────────────────┐
│ 📅 2025年6月 · 📋 全部账户 · 🏷️ 全部标签  →  │
└───────────────────────────────────────────────┘
```

- 显示当前生效的筛选条件摘要
- 点击跳转 `/filter`，携带当前 query
- 无 query 时显示当月默认值

**摘要生成逻辑：**

```typescript
const filterSummary = computed(() => {
  const parts: string[] = []
  const q = route.query
  if (q.dateFrom || q.dateTo) {
    parts.push(`📅 ${formatDateRange(q.dateFrom, q.dateTo)}`)
  } else {
    // 默认当月
    const now = new Date()
    parts.push(`📅 ${now.getFullYear()}年${now.getMonth() + 1}月`)
  }
  parts.push(q.account
    ? `📋 ${accountStore.accounts.find(a => a.id === q.account)?.name || q.account}`
    : '📋 全部账户')
  parts.push(q.tags ? `🏷️ ${q.tags.split(',').length}个标签` : '🏷️ 全部标签')
  return parts.join(' · ')
})
```

### 2.3 汇总卡片

三列并排，替换原有的净资产/资产/负债：

```
        收入              支出             结余
    ¥12,500.00      -¥3,200.00      ¥9,300.00
```

**指标（均为 store 中筛选后的 computed）：**

| 指标 | 来源 | 样式 |
|------|------|------|
| 收入 | `transactionStore.totalIncome` | 绿色 `text-income` |
| 支出 | `transactionStore.totalExpense` | 红色 `text-expense` |
| 结余 | `totalIncome - totalExpense`（新增 computed 或直接用 store 差值） | 正数黑、负数红 |

### 2.4 移除内容

- 删除 `displayNetAssets`、`displayAssetsTotal`、`displayLiabilitiesTotal` 三个 computed
- 删除首页模式汇总卡片中的净资产/资产/负债模板

---

## 3. 账户详情页批量删除

### 现状

账户详情页每条流水点击进入编辑页，Header 右侧只有编辑按钮（铅笔图标）。transaction store 只有单条 `remove()`。

### 方案

**改动文件：** `src/views/TransactionList.vue`（账户详情模式）+ `src/stores/transaction.ts`

### 3.1 多选模式状态

```typescript
const isMultiSelectMode = ref(false)
const selectedTxIds = ref<Set<string>>(new Set())

function exitMultiSelectMode() {
  isMultiSelectMode.value = false
  selectedTxIds.value = new Set()
}

function toggleTxSelection(txId: string) {
  const next = new Set(selectedTxIds.value)
  if (next.has(txId)) {
    next.delete(txId)
  } else {
    next.add(txId)
  }
  selectedTxIds.value = next
}
```

### 3.2 入口

- 账户详情 Header 右侧：多选按钮（`ListChecks` 或 `CheckSquare` 图标）
- 点击进入多选模式
- 仅在 `isAccountMode` 为 true 时显示

### 3.3 多选模式 Header

```
┌──────────────────────────────────────┐
│ [取消]    已选 N 项         [🗑 删除] │
└──────────────────────────────────────┘
```

- 左侧：取消按钮，退出多选模式
- 中间：已选数量
- 右侧：删除按钮（`Trash2`，红色），N=0 时置灰不可点击

### 3.4 流水行变化

每条流水行左侧出现选择指示器：
- 未选中：空心圆（`Circle` icon，灰色）
- 选中：实心蓝底白勾（`CheckCircle` icon，primary 色）

点击行 = 切换选中状态（不跳转编辑页）。

### 3.5 FAB

多选模式下 FAB 不渲染。

### 3.6 批量删除流程

1. 用户勾选 ≥1 条后点击删除
2. ConfirmDialog："确定删除选中的 N 条流水吗？此操作不可撤销。"
3. 确认 → `transactionStore.batchRemove([...selectedTxIds])`
4. 成功后退出多选模式

### 3.7 Store 新增方法

```typescript
// src/stores/transaction.ts
async function batchRemove(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDb()
  const now = new Date().toISOString()
  const placeholders = ids.map(() => '?').join(',')
  await db.execute(
    `UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id IN (${placeholders})`,
    [now, ...ids]
  )
  if (_ledgerId) {
    await fetchAll(_ledgerId)
    const accountStore = useAccountStore()
    await accountStore.fetchAll(_ledgerId)
  }
}
```

---

## 文件变更汇总

| 文件 | 操作 | 内容 |
|------|------|------|
| `src/components/DateTimePicker.vue` | **新建** | 单行四列滚轮式日期时间选择器 |
| `src/views/TransactionList.vue` | **修改** | 默认本月筛选 + 筛选状态栏 + 收入/支出/结余汇总 + 账户详情多选删除 |
| `src/views/RecordPage.vue` | **修改** | 替换原生 datetime-local 为 DateTimePicker |
| `src/views/FilterPage.vue` | **修改** | 替换两个原生 datetime-local 为两个 DateTimePicker |
| `src/stores/transaction.ts` | **修改** | 新增 `batchRemove` 方法 |

---

## 自审

1. **Placeholder 扫描**: 无 TBD/TODO/占位符
2. **内部一致性**:
   - DateTimePicker `modelValue` 格式与 `toLocalDatetimeString()` 输出一致
   - 默认筛选日期格式与 `buildFetchOpts()` 中日期解析兼容
   - 批量删除 `batchRemove` 签名与 `selectedTxIds`（Set → Array）匹配
3. **范围**: 三个独立优化，互不依赖
4. **歧义检查**: 无不明确的实现细节
