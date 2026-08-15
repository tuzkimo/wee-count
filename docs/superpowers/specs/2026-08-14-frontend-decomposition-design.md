# 前端大组件拆分 — 纯函数抽 utils + useTransactionForm + 转账同账户校验

## 1. 背景与根因

复盘报告第三节第 6 点：`TransactionList.vue`（711 行）与 `RecordPage.vue`（611 行）职责过重。`<script setup>` 里混着三类东西：纯展示函数（格式化/取图标/金额/日期）、表单状态与校验、以及组件生命周期/路由/UI 显隐。功能改多了会越来越难读、难测。

当前状态（已核实）：
- 事件监听泄漏**已修**（`TransactionList.vue` 用具名 `closeLedgerSwitcher` + `onUnmounted` 移除）。
- **「转账 from===to 校验」缺失**：`RecordPage.vue` 的 `doSave` 只校验分类/账户必填，没有 `fromAccountId !== toAccountId` 检查，转账可选同账户（空操作）。
- 已有 `src/utils/`（`datetime.ts` 等）与 `src/composables/`（`useMemberInfo.ts` 等）模式可循。

## 2. 目标

- 把两个组件里的纯函数抽到 `utils`（事务展示、表达式求值、日期展示）。
- 把 `RecordPage` 的表单状态 + 校验 + 保存抽成 `useTransactionForm` composable。
- 补转账 `from===to` 校验。

## 3. 范围（In / Out of scope）

**In scope：**
- 纯函数抽取（见 §4.1）。
- `useTransactionForm` composable（见 §4.2）。
- 转账同账户校验（见 §4.3）。

**Out of scope（明确不做）：**
- **不改模板结构、不改视觉/交互**——纯脚本层重构，行为逐字节保持一致。
- 不重构 `filterSummary`（依赖多 store，留在组件）、`buildFetchOpts`（依赖 route + 组件状态，留在组件）。
- 不拆分小组件（如把列表项抽成子组件）——超出报告范围。
- 后端、迁移不改。

## 4. 设计

### 4.1 纯函数抽到 utils

从 `TransactionList.vue` 抽以下纯函数（无 store/reactive 依赖，输入→输出确定）：

**新建 `src/utils/transaction.ts`：**

| 函数 | 签名 | 原位置 |
|---|---|---|
| `getTxIcon` | `(tx: Transaction) => string` | 391-394 |
| `getTxDescription` | `(tx: Transaction) => string` | 397-405 |
| `getTxCategoryName` | `(tx: Transaction) => string` | 427-430 |
| `formatAmount` | `(tx: Transaction) => string` | 433-436 |
| `transferFromUid` | `(tx: Transaction) => string \| null` | 408-411 |
| `transferToUid` | `(tx: Transaction) => string \| null` | 412-415 |
| `isCrossMemberTransfer` | `(tx: Transaction) => boolean` | 416-420 |
| `transferMemberIds` | `(tx: Transaction) => string[]` | 421-424 |
| `groupTransactionsByDate` | `(txs: Transaction[]) => DayGroup[]` | 365-379 逻辑 |

其中 `DayGroup` 接口（`{ date, label, transactions }`）一并迁入 `transaction.ts` 并导出。`groupTransactionsByDate` 复用 `utcToLocalDateKey`（datetime.ts）与 `formatDateLabel`（见下）。

**扩展 `src/utils/datetime.ts`：**

| 函数 | 签名 | 原位置 |
|---|---|---|
| `formatDateLabel` | `(dateKey: string) => string` | 381-388 |
| `formatDateRange` | `(from: string, to: string) => string` | 346-356 |

`formatDateLabel` 复用已有 `localDateKeyToDate`。

**新建 `src/utils/expression.ts`：**

| 函数 | 签名 | 原位置 |
|---|---|---|
| `evaluateExpression` | `(expr: string) => number \| null` | RecordPage `calcResult` 逻辑（83-96） |

语义：trim 后为空或结尾是运算符 → null；只允许数字/`.`/`+`/`-`；`new Function` 安全求值；`NaN` 或 `<=0` → null；结果 `Math.round(x*100)/100`。

### 4.2 `useTransactionForm` composable

新建 `src/composables/useTransactionForm.ts`，收容 `RecordPage.vue` 的表单状态、派生、handler、校验与保存：

**进 composable：**
- 表单 ref：`txType`/`categoryId`/`fromAccountId`/`toAccountId`/`occurredAt`/`expression`/`selectedTagIds`/`note`/`saveError`/`isSaving`。
- 派生 computed：`filteredCategories`/`defaultCategoryId`/`availableAccounts`/`calcResult`（用 `evaluateExpression`）/`isValid`/`isOwner`/`selectedTags`。
- handler：`switchType`/`selectCategory`/`onTagConfirm`/`toggleTag`/`onKeypadInput`/`onAccountSelect`/`getAccountName`。
- `doSave()`（含校验与 store 写）。

**留组件：**
- Sheet 显隐 ref（`tagSheetVisible`/`deleteDialogVisible`/`accountPickerVisible`/`accountCreateSheetVisible`/`categorySheetVisible`/`datePickerVisible`/`accountPickerTarget`/`pickerScope`/`pickerShowMember`）。
- 路由跳转（`onDone`/`onSaveNext`/`deleteTx`/`goBack`）。
- `onMounted` 的 store 拉取（`ledgerStore.init` + `fetchAll`）与预填编排；预填时调用 composable 暴露的方法（编辑态 `prefill(tx)`，新增态 `initNew(defaults)` 或直接设 ref）。
- 账户新建流程（`handleCreateAccount`/`onAccountCreated`）。

composable 内部自行 `useLedgerStore()`/`useAccountStore()`/`useCategoryStore()`/`useTagStore()`/`useTransactionStore()`/`useAuthStore()` 与 `useRoute()`（读 `params.id` 与 `query.account`），不要求调用方传参。

### 4.3 转账 `from===to` 校验

`doSave` 在账户必填校验之后加一条：

```ts
if (txType.value === "transfer" && fromAccountId.value && fromAccountId.value === toAccountId.value) {
  saveError.value = "转出和转入账户不能相同";
  return false;
}
```

## 5. 错误处理

纯函数与 composable 均保持原有语义；`doSave` 校验失败时设 `saveError`（新增的 from===to 提示也走这一机制，UI 已在分类区展示 `saveError`）。

## 6. 测试

| 文件 | 内容 |
|---|---|
| `src/utils/__tests__/transaction.test.ts` | 每个展示函数：`getTxIcon`（transfer/income/expense/有 icon）、`getTxDescription`（transfer/income/expense）、`getTxCategoryName`、`formatAmount`（符号 + 千分位）、`transfer*`（跨成员判定）、`groupTransactionsByDate`（分组 + 排序 + 日期 key） |
| `src/utils/__tests__/expression.test.ts` | `evaluateExpression`：空/结尾运算符/非法字符/`NaN`/`<=0`/正常四则/`1+2*3` 优先级 |
| `src/composables/__tests__/useTransactionForm.test.ts` | `doSave` 校验：缺分类、缺账户、**转账 from===to 拒绝**、合法通过 |

存量 159 测试 + `npm run build`（vue-tsc + Vite）必须保持绿；`recordPage.reactivity.test.ts` 是自包含复现测试，不受影响。

## 7. 改动文件清单

| 文件 | 动作 |
|---|---|
| `src/utils/transaction.ts` | 新建（事务展示纯函数 + `DayGroup` + `groupTransactionsByDate`） |
| `src/utils/expression.ts` | 新建（`evaluateExpression`） |
| `src/utils/datetime.ts` | 扩展（`formatDateLabel`/`formatDateRange`） |
| `src/composables/useTransactionForm.ts` | 新建（表单状态 + 校验 + 保存） |
| `src/views/TransactionList.vue` | 改用抽出的纯函数 |
| `src/views/RecordPage.vue` | 改用 composable + 抽出的 `evaluateExpression` + 加 from===to 校验 |
| 3 个 `__tests__` 文件 | 新增 |

## 8. 验证

```bash
npm run test      # 全量 vitest（存量 + 新增）
npm run build     # vue-tsc 类型检查 + Vite 构建
```

## 9. 任务拆分

| # | 任务 | 产出 | 验证 |
|---|---|---|---|
| 1 | 抽日期展示 `formatDateLabel`/`formatDateRange` 到 `datetime.ts` + 单测，TransactionList 改用 | `datetime.ts` 扩展 | `vitest` |
| 2 | 抽事务展示纯函数到 `utils/transaction.ts`（复用 `formatDateLabel`）+ 单测，TransactionList 改用 | `transaction.ts` + `transaction.test.ts` | `vitest` + `build` |
| 3 | 抽 `evaluateExpression` 到 `utils/expression.ts` + 单测 | `expression.ts` + `expression.test.ts` | `vitest` |
| 4 | 抽 `useTransactionForm` composable + 单测，RecordPage 改用 | `useTransactionForm.ts` + `useTransactionForm.test.ts` | `vitest` |
| 5 | 转账 from===to 校验 + 测试 + README 同步 | `useTransactionForm.ts` + `README.md` | `vitest` + `build` |
