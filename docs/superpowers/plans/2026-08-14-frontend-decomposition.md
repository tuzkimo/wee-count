# 前端大组件拆分 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `TransactionList.vue`/`RecordPage.vue` 里的纯函数抽到 utils、表单状态与校验抽成 `useTransactionForm` composable，并补转账 `from===to` 校验。

**Architecture:** 纯函数按领域落位（事务展示→`utils/transaction.ts`、表达式求值→`utils/expression.ts`、日期展示→扩展 `utils/datetime.ts`）；表单状态+派生+校验+保存抽成 `useTransactionForm`（内部自取 store 与 `useRoute`），组件只留 Sheet 显隐、picker 流程、路由跳转与 `onMounted` 拉取。

**Tech Stack:** Vue 3 + TypeScript + Pinia + Vitest 4。

**Spec:** `docs/superpowers/specs/2026-08-14-frontend-decomposition-design.md`

## Global Constraints

- 纯脚本层重构：**不改模板结构、不改视觉/交互**，行为逐字节一致。
- 组件通过「解构 composable 返回为同名变量」保持模板引用不变（模板零改动）。
- `filterSummary`/`buildFetchOpts` 留在 `TransactionList.vue`（依赖多 store/route）。
- 存量 159 测试 + `npm run build` 必须保持绿；`recordPage.reactivity.test.ts` 是自包含复现测试，不受影响。
- 每个 Task 的 commit 中文描述，不加 Co-Authored-By。

---

### Task 1: 抽日期展示 `formatDateLabel`/`formatDateRange` 到 datetime.ts

**Files:**
- Modify: `src/utils/datetime.ts`（追加两函数）
- Modify: `src/views/TransactionList.vue`（删本地定义，改 import）
- Test: `src/utils/__tests__/datetime.test.ts`（追加用例）

**Interfaces:**
- Produces: `formatDateLabel(dateKey: string): string`、`formatDateRange(from: string, to: string): string` —— Task 2 的 `groupTransactionsByDate` 用 `formatDateLabel`。

- [ ] **Step 1: 追加两个函数到 datetime.ts**

在 `src/utils/datetime.ts` 末尾追加：

```ts
// 日期 key（"YYYY-MM-DD"）→ "M月D日 周X"
export function formatDateLabel(dateKey: string): string {
  const d = localDateKeyToDate(dateKey);
  const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekDay = weekDays[d.getDay()];
  return `${month}月${day}日 ${weekDay}`;
}

// 筛选摘要的日期范围展示（from/to 是含 "T" 的本地时间串）
export function formatDateRange(from: string, to: string): string {
  if (from && to) {
    const [fd] = from.split("T");
    const [td] = to.split("T");
    if (fd === td) return fd;
    return `${fd} ~ ${td}`;
  }
  if (from) return `${from.split("T")[0]} 起`;
  if (to) return `至 ${to.split("T")[0]}`;
  return "";
}
```

- [ ] **Step 2: TransactionList.vue 改 import + 删本地定义**

把 `src/views/TransactionList.vue:17` 的 import 从：

```ts
import { utcToLocalDateKey, localDateKeyToDate } from "@/utils/datetime";
```

改为：

```ts
import { utcToLocalDateKey, formatDateLabel, formatDateRange } from "@/utils/datetime";
```

删除本地函数 `formatDateRange`（原 346-356 行）与 `formatDateLabel`（原 381-388 行）。

- [ ] **Step 3: 追加 datetime.test.ts 用例**

在 `src/utils/__tests__/datetime.test.ts` 追加（先 import 这两个函数）：

```ts
import { formatDateLabel, formatDateRange } from "@/utils/datetime";

describe("formatDateLabel", () => {
  it("把日期 key 转成「M月D日 周X」", () => {
    // 2026-08-15 是周六
    expect(formatDateLabel("2026-08-15")).toBe("8月15日 周六");
  });
});

describe("formatDateRange", () => {
  it("同一天只显示日期", () => {
    expect(formatDateRange("2026-08-15T00:00", "2026-08-15T23:59")).toBe("2026-08-15");
  });
  it("跨天显示范围", () => {
    expect(formatDateRange("2026-08-01T00:00", "2026-08-15T23:59")).toBe("2026-08-01 ~ 2026-08-15");
  });
  it("只有起点/终点时显示 起/至", () => {
    expect(formatDateRange("2026-08-01T00:00", "")).toBe("2026-08-01 起");
    expect(formatDateRange("", "2026-08-15T23:59")).toBe("至 2026-08-15");
  });
});
```

> 注意：`2026-08-15` 的星期需核对（若测试断言失败，按 `new Date("2026-08-15")` 实际 `getDay()` 修正星期文案）。

- [ ] **Step 4: 跑测试 + 构建**

Run: `cd D:/projects/my/wee-count && npx vitest run src/utils/__tests__/datetime.test.ts && npm run build`
Expected: PASS + build 通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/datetime.ts src/utils/__tests__/datetime.test.ts src/views/TransactionList.vue
git commit -m "refactor(frontend): 抽 formatDateLabel/formatDateRange 到 datetime.ts"
```

---

### Task 2: 抽事务展示纯函数到 utils/transaction.ts

**Files:**
- Create: `src/utils/transaction.ts`
- Modify: `src/views/TransactionList.vue`（删本地定义，改 import；`groupedTransactions` 改用 `groupTransactionsByDate`）
- Test: `src/utils/__tests__/transaction.test.ts`

**Interfaces:**
- Consumes: `formatDateLabel`/`utcToLocalDateKey`（datetime.ts，Task 1）、`Transaction` 类型（`@/types`）
- Produces: 8 个展示函数 + `DayGroup` + `groupTransactionsByDate`

- [ ] **Step 1: 创建 transaction.ts**

```ts
// src/utils/transaction.ts
import type { Transaction } from "@/types";
import { utcToLocalDateKey, formatDateLabel } from "@/utils/datetime";

export interface DayGroup {
  date: string;
  label: string;
  transactions: Transaction[];
}

export function getTxIcon(tx: Transaction): string {
  if (tx.type === "transfer") return "🔄";
  return tx.category?.icon ?? (tx.type === "income" ? "📥" : "💸");
}

export function getTxDescription(tx: Transaction): string {
  if (tx.type === "transfer") {
    return `${tx.from_account?.name ?? "?"} → ${tx.to_account?.name ?? "?"}`;
  }
  if (tx.type === "income") {
    return tx.to_account?.name ?? "";
  }
  return tx.from_account?.name ?? "";
}

export function getTxCategoryName(tx: Transaction): string {
  if (tx.type === "transfer") return "转账";
  return tx.category?.name ?? (tx.type === "income" ? "收入" : "支出");
}

export function formatAmount(tx: Transaction): string {
  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "-" : "";
  return `${sign}¥${tx.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function transferFromUid(tx: Transaction): string | null {
  if (tx.type !== "transfer") return null;
  return tx.from_account?.owner_id ?? null;
}

export function transferToUid(tx: Transaction): string | null {
  if (tx.type !== "transfer") return null;
  return tx.to_account?.owner_id ?? null;
}

export function isCrossMemberTransfer(tx: Transaction): boolean {
  const from = transferFromUid(tx);
  const to = transferToUid(tx);
  return !!from && !!to && from !== to;
}

export function transferMemberIds(tx: Transaction): string[] {
  if (!isCrossMemberTransfer(tx)) return [];
  return [transferFromUid(tx)!, transferToUid(tx)!];
}

export function groupTransactionsByDate(txs: Transaction[]): DayGroup[] {
  const groups: Record<string, Transaction[]> = {};
  for (const tx of txs) {
    const dateKey = utcToLocalDateKey(tx.occurred_at);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(tx);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, txs]) => ({ date, label: formatDateLabel(date), transactions: txs }));
}
```

- [ ] **Step 2: TransactionList.vue 改 import + 删本地定义**

在 import 区加：

```ts
import { getTxIcon, getTxDescription, getTxCategoryName, formatAmount, transferFromUid, transferToUid, isCrossMemberTransfer, transferMemberIds, groupTransactionsByDate } from "@/utils/transaction";
```

删除本地定义：`DayGroup` 接口（原 359-363）、`groupedTransactions` computed 里 `groupTransactionsByDate` 的重复逻辑、`formatAmount`（433-436）、`getTxIcon`（391-394）、`getTxDescription`（397-405）、`getTxCategoryName`（427-430）、`transferFromUid`/`transferToUid`/`isCrossMemberTransfer`/`transferMemberIds`（408-424）、以及 `groupedTransactions` 内部的 `formatDateLabel` 引用（已由 Task 1 移除本地定义）。

把 `groupedTransactions` computed 改为：

```ts
const groupedTransactions = computed(() => groupTransactionsByDate(transactionStore.transactions));
```

> 模板里 `getTxIcon`/`getTxDescription`/`getTxCategoryName`/`formatAmount`/`isCrossMemberTransfer`/`transferFromUid`/`transferToUid` 仍在被引用，import 后模板不变。

- [ ] **Step 3: 创建 transaction.test.ts**

```ts
// src/utils/__tests__/transaction.test.ts
import { describe, it, expect } from "vitest";
import { getTxIcon, getTxDescription, getTxCategoryName, formatAmount, isCrossMemberTransfer, transferMemberIds, groupTransactionsByDate } from "@/utils/transaction";
import type { Transaction } from "@/types";

function tx(partial: Partial<Transaction>): Transaction {
  return { id: "t1", ledger_id: "l1", user_id: "u1", amount: 0, type: "expense", occurred_at: "", created_at: "", updated_at: "", is_deleted: false, ...partial };
}

describe("getTxIcon", () => {
  it("转账返回 🔄", () => expect(getTxIcon(tx({ type: "transfer" }))).toBe("🔄"));
  it("有分类图标用图标，无则按类型回退", () => {
    expect(getTxIcon(tx({ type: "expense", category: { id: "c", ledger_id: "l", owner_id: "u", name: "餐饮", type: "expense", icon: "🍜", sort_order: 0, updated_at: "", is_deleted: false } }))).toBe("🍜");
    expect(getTxIcon(tx({ type: "income" }))).toBe("📥");
    expect(getTxIcon(tx({ type: "expense" }))).toBe("💸");
  });
});

describe("getTxDescription", () => {
  it("转账显示 from → to", () => {
    expect(getTxDescription(tx({ type: "transfer", from_account: { id: "a", ledger_id: "l", owner_id: "u", name: "现金", type: "asset", initial_balance: 0, created_at: "", updated_at: "", is_deleted: false }, to_account: { id: "b", ledger_id: "l", owner_id: "u", name: "银行卡", type: "asset", initial_balance: 0, created_at: "", updated_at: "", is_deleted: false } }))).toBe("现金 → 银行卡");
  });
  it("收入取 to 账户，支出取 from 账户", () => {
    expect(getTxDescription(tx({ type: "income", to_account: { id: "b", ledger_id: "l", owner_id: "u", name: "银行卡", type: "asset", initial_balance: 0, created_at: "", updated_at: "", is_deleted: false } }))).toBe("银行卡");
    expect(getTxDescription(tx({ type: "expense", from_account: { id: "a", ledger_id: "l", owner_id: "u", name: "现金", type: "asset", initial_balance: 0, created_at: "", updated_at: "", is_deleted: false } }))).toBe("现金");
  });
});

describe("formatAmount", () => {
  it("income + / expense - / transfer 无符号，千分位两位小数", () => {
    expect(formatAmount(tx({ type: "income", amount: 1234.5 }))).toBe("+¥1,234.50");
    expect(formatAmount(tx({ type: "expense", amount: 1234.5 }))).toBe("-¥1,234.50");
    expect(formatAmount(tx({ type: "transfer", amount: 100 }))).toBe("¥100.00");
  });
});

describe("transfer* helpers", () => {
  const acc = (owner_id: string) => ({ id: "a", ledger_id: "l", owner_id, name: "x", type: "asset" as const, initial_balance: 0, created_at: "", updated_at: "", is_deleted: false });
  it("跨成员转账判定", () => {
    expect(isCrossMemberTransfer(tx({ type: "transfer", from_account: acc("u1"), to_account: acc("u2") }))).toBe(true);
    expect(isCrossMemberTransfer(tx({ type: "transfer", from_account: acc("u1"), to_account: acc("u1") }))).toBe(false);
    expect(transferMemberIds(tx({ type: "transfer", from_account: acc("u1"), to_account: acc("u2") }))).toEqual(["u1", "u2"]);
  });
});

describe("groupTransactionsByDate", () => {
  it("按 UTC 本地日期 key 分组并倒序", () => {
    const txs = [
      tx({ id: "a", occurred_at: "2026-08-15T10:00:00Z" }),
      tx({ id: "b", occurred_at: "2026-08-14T10:00:00Z" }),
      tx({ id: "c", occurred_at: "2026-08-15T11:00:00Z" }),
    ];
    const groups = groupTransactionsByDate(txs);
    expect(groups.map((g) => g.transactions.map((t) => t.id))).toEqual([["a", "c"], ["b"]]);
  });
});
```

- [ ] **Step 4: 跑测试 + 构建**

Run: `cd D:/projects/my/wee-count && npx vitest run src/utils/__tests__/transaction.test.ts && npm run build`
Expected: PASS + build 通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/transaction.ts src/utils/__tests__/transaction.test.ts src/views/TransactionList.vue
git commit -m "refactor(frontend): 抽事务展示纯函数到 utils/transaction.ts"
```

---

### Task 3: 抽 `evaluateExpression` 到 utils/expression.ts

**Files:**
- Create: `src/utils/expression.ts`
- Modify: `src/views/RecordPage.vue`（`calcResult` 改用）
- Test: `src/utils/__tests__/expression.test.ts`

**Interfaces:**
- Produces: `evaluateExpression(expr: string): number | null` —— Task 4 的 composable 用。

- [ ] **Step 1: 创建 expression.ts**

```ts
// src/utils/expression.ts

// 计算器表达式安全求值：只允许数字、+、-、.；返回两位小数，非法/非正返回 null。
export function evaluateExpression(expr: string): number | null {
  const e = expr.trim();
  if (!e || /[+\-.]$/.test(e)) return null;
  if (!/^[\d.\-+]+$/.test(e)) return null;
  try {
    const result = new Function(`return (${e})`)() as number;
    if (isNaN(result) || result <= 0) return null;
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: RecordPage.vue 改用**

在 import 区加 `import { evaluateExpression } from "@/utils/expression";`，把 `calcResult` computed（原 83-96）改为：

```ts
const calcResult = computed(() => evaluateExpression(expression.value));
```

- [ ] **Step 3: 创建 expression.test.ts**

```ts
// src/utils/__tests__/expression.test.ts
import { describe, it, expect } from "vitest";
import { evaluateExpression } from "@/utils/expression";

describe("evaluateExpression", () => {
  it("空/结尾运算符返回 null", () => {
    expect(evaluateExpression("")).toBeNull();
    expect(evaluateExpression("1+")).toBeNull();
    expect(evaluateExpression("1.")).toBeNull();
  });
  it("非法字符返回 null", () => {
    expect(evaluateExpression("1;alert(1)")).toBeNull();
    expect(evaluateExpression("abc")).toBeNull();
  });
  it("非正数返回 null", () => {
    expect(evaluateExpression("0")).toBeNull();
    expect(evaluateExpression("-5")).toBeNull();
  });
  it("正常四则 + 优先级", () => {
    expect(evaluateExpression("1+2*3")).toBe(7);
    expect(evaluateExpression("10.5-0.5")).toBe(10);
  });
  it("结果四舍五入到两位", () => {
    expect(evaluateExpression("1.005")).toBe(1.01);
  });
});
```

- [ ] **Step 4: 跑测试 + 构建**

Run: `cd D:/projects/my/wee-count && npx vitest run src/utils/__tests__/expression.test.ts && npm run build`
Expected: PASS + build 通过

- [ ] **Step 5: Commit**

```bash
git add src/utils/expression.ts src/utils/__tests__/expression.test.ts src/views/RecordPage.vue
git commit -m "refactor(frontend): 抽 evaluateExpression 到 utils/expression.ts"
```

---

### Task 4: 抽 `useTransactionForm` composable

**Files:**
- Create: `src/composables/useTransactionForm.ts`
- Modify: `src/views/RecordPage.vue`（改用 composable）
- Test: `src/composables/__tests__/useTransactionForm.test.ts`

**Interfaces:**
- Consumes: `evaluateExpression`（Task 3）、store（ledger/account/category/tag/transaction/auth）、`useRoute`、`getCurrentUserId`、`utcToLocalDatetimeString`/`toLocalDatetimeString`
- Produces: composable 返回值（见下）

- [ ] **Step 1: 创建 useTransactionForm.ts**

```ts
// src/composables/useTransactionForm.ts
import { ref, computed } from "vue";
import { useRoute } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { evaluateExpression } from "@/utils/expression";
import { toLocalDatetimeString, utcToLocalDatetimeString } from "@/utils/datetime";
import type { Account, Category, Tag, Transaction, TransactionType } from "@/types";

export function useTransactionForm() {
  const route = useRoute();
  const ledgerStore = useLedgerStore();
  const accountStore = useAccountStore();
  const categoryStore = useCategoryStore();
  const tagStore = useTagStore();
  const transactionStore = useTransactionStore();
  const auth = useAuthStore();

  const isEdit = computed(() => !!route.params.id);
  const editId = computed(() => route.params.id as string | undefined);

  // 表单状态
  const txType = ref<TransactionType>("expense");
  const categoryId = ref<string | null>(null);
  const fromAccountId = ref<string | null>(null);
  const toAccountId = ref<string | null>(null);
  const occurredAt = ref("");
  const expression = ref("");
  const selectedTagIds = ref<string[]>([]);
  const note = ref("");
  const saveError = ref("");
  const isSaving = ref(false);

  // 派生
  const filteredCategories = computed(() =>
    categoryStore.categories.filter((c) => c.type === txType.value)
  );
  const defaultCategoryId = computed(() => {
    const cats = [...filteredCategories.value].sort((a, b) => a.sort_order - b.sort_order);
    return cats[0]?.id ?? null;
  });
  const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
  const currentUserId = computed(() => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "");
  const availableAccounts = computed(() =>
    accountStore.accounts.filter((a) => {
      if (a.is_deleted) return false;
      if (isTeamLedger.value && a.owner_id !== currentUserId.value) return false;
      return true;
    })
  );
  const calcResult = computed(() => evaluateExpression(expression.value));
  const isValid = computed(() => calcResult.value !== null);
  const isOwner = computed(() => {
    if (!isEdit.value || !editId.value) return true;
    const tx = transactionStore.transactions.find((t) => t.id === editId.value);
    if (!tx) return true;
    const uid = auth.currentLocalUser?.server_user_id || getCurrentUserId();
    return tx.user_id === uid;
  });
  const selectedTags = computed(() =>
    selectedTagIds.value
      .map((id) => tagStore.tags.find((t) => t.id === id))
      .filter((t): t is Tag => t != null)
  );

  // handler
  function switchType(t: TransactionType) {
    txType.value = t;
    categoryId.value = defaultCategoryId.value;
  }
  function selectCategory(cat: Category) {
    categoryId.value = cat.id;
  }
  function onTagConfirm(tagIds: string[]) {
    selectedTagIds.value = tagIds;
  }
  function toggleTag(tagId: string) {
    const idx = selectedTagIds.value.indexOf(tagId);
    if (idx >= 0) selectedTagIds.value.splice(idx, 1);
    else selectedTagIds.value.push(tagId);
  }
  function getAccountName(id: string | null): string {
    if (!id) return "";
    return accountStore.accounts.find((a) => a.id === id)?.name ?? "";
  }
  function onKeypadInput(key: string) {
    if (key === "delete") {
      expression.value = expression.value.slice(0, -1);
    } else {
      const last = expression.value.slice(-1);
      if ((key === "+" || key === "-") && (last === "+" || last === "-")) {
        expression.value = expression.value.slice(0, -1) + key;
      } else if (key === "." && last === ".") {
        return;
      } else {
        expression.value += key;
      }
    }
  }

  // 编辑预填
  function prefill(tx: Transaction) {
    txType.value = tx.type;
    categoryId.value = tx.category_id;
    fromAccountId.value = tx.from_account_id;
    toAccountId.value = tx.to_account_id;
    occurredAt.value = utcToLocalDatetimeString(tx.occurred_at);
    expression.value = tx.amount.toString();
    selectedTagIds.value = tx.tags?.map((t) => t.id) ?? [];
    note.value = tx.note ?? "";
  }

  // 新增初始化
  function initNew() {
    occurredAt.value = toLocalDatetimeString(new Date());
    const qAccount = route.query.account as string | undefined;
    const defaultAcc = qAccount
      ? availableAccounts.value.find((a) => a.id === qAccount)
      : availableAccounts.value[0];
    if (defaultAcc) {
      fromAccountId.value = defaultAcc.id;
      toAccountId.value = defaultAcc.id;
    }
    categoryId.value = defaultCategoryId.value;
    note.value = "";
  }

  async function doSave(): Promise<boolean> {
    const ledgerId = ledgerStore.currentLedger?.id;
    if (!isOwner.value || !ledgerId || isSaving.value || !isValid.value) return false;

    saveError.value = "";
    const amt = calcResult.value!;

    if (txType.value !== "transfer" && !categoryId.value) {
      saveError.value = "请选择分类";
      return false;
    }
    if ((txType.value === "expense" || txType.value === "transfer") && !fromAccountId.value) {
      return false;
    }
    if ((txType.value === "income" || txType.value === "transfer") && !toAccountId.value) {
      return false;
    }

    isSaving.value = true;
    try {
      const data = {
        ledger_id: ledgerId,
        user_id: auth.currentLocalUser?.server_user_id || getCurrentUserId()!,
        type: txType.value,
        amount: amt,
        category_id: txType.value === "transfer" ? null : categoryId.value,
        from_account_id: txType.value === "expense" || txType.value === "transfer" ? fromAccountId.value : null,
        to_account_id: txType.value === "income" || txType.value === "transfer" ? toAccountId.value : null,
        occurred_at: new Date(occurredAt.value).toISOString(),
        tag_ids: selectedTagIds.value,
        note: note.value.trim() || null,
      };

      if (isEdit.value && editId.value) {
        await transactionStore.update(editId.value, data);
      } else {
        await transactionStore.add(data);
      }
      return true;
    } catch (e) {
      console.error("Save transaction failed:", e);
      return false;
    } finally {
      isSaving.value = false;
    }
  }

  return {
    txType, categoryId, fromAccountId, toAccountId, occurredAt, expression,
    selectedTagIds, note, saveError, isSaving,
    filteredCategories, defaultCategoryId, availableAccounts, calcResult, isValid, isOwner, selectedTags,
    isEdit, editId,
    switchType, selectCategory, onTagConfirm, toggleTag, getAccountName, onKeypadInput,
    doSave, prefill, initNew,
  };
}
```

- [ ] **Step 2: RecordPage.vue 改用 composable**

把 `<script setup>` 里的「表单状态 ref（35-56）+ 派生 computed（59-106 里的 filteredCategories/defaultCategoryId/availableAccounts/calcResult/isValid/isOwner/selectedTags）+ handler（switchType/selectCategory/onTagConfirm/toggleTag/getAccountName/onKeypadInput）+ doSave + 预填逻辑」删除，改为解构 composable。新的 `<script setup>` 顶部与关键段：

```ts
<script setup lang="ts">
import { ref, onMounted } from "vue";
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
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import AccountCreateSheet from "@/components/AccountCreateSheet.vue";
import CalculatorKeypad from "@/components/CalculatorKeypad.vue";
import DateTimePicker from "@/components/DateTimePicker.vue";
import CategorySheet from "@/components/CategorySheet.vue";
import { useTransactionForm } from "@/composables/useTransactionForm";
import { toLocalDatetimeString } from "@/utils/datetime";
import type { Account } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const categoryStore = useCategoryStore();
const tagStore = useTagStore();
const transactionStore = useTransactionStore();

const {
  txType, categoryId, fromAccountId, toAccountId, occurredAt, expression,
  selectedTagIds, note, saveError, isSaving,
  filteredCategories, defaultCategoryId, availableAccounts, calcResult, isValid, isOwner, selectedTags,
  isEdit, editId,
  switchType, selectCategory, onTagConfirm, toggleTag, getAccountName, onKeypadInput,
  doSave, prefill, initNew,
} = useTransactionForm();

// —— 以下留组件：Sheet 显隐 + picker 流程 + 路由 + onMounted ——

const tagSheetVisible = ref(false);
const deleteDialogVisible = ref(false);
const accountPickerVisible = ref(false);
const accountCreateSheetVisible = ref(false);
const accountPickerTarget = ref<"from" | "to">("from");
const pickerScope = ref<"own" | "all">("own");
const pickerShowMember = ref(false);
const categorySheetVisible = ref(false);
const datePickerVisible = ref(false);
const isReady = ref(false);

function openAccountPicker(target: "from" | "to") {
  accountPickerTarget.value = target;
  if (target === "to" && txType.value === "transfer") {
    pickerScope.value = "all";
    pickerShowMember.value = true;
  } else {
    pickerScope.value = "own";
    pickerShowMember.value = false;
  }
  accountPickerVisible.value = true;
}

function onAccountSelect(acc: Account) {
  if (accountPickerTarget.value === "from") {
    fromAccountId.value = acc.id;
  } else {
    toAccountId.value = acc.id;
  }
  accountPickerVisible.value = false;
}

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await Promise.all([
    accountStore.fetchAll(ledgerId),
    categoryStore.fetchAll(ledgerId),
    tagStore.fetchAll(ledgerId),
  ]);

  if (isEdit.value && editId.value) {
    await transactionStore.fetchAll(ledgerId);
    const tx = transactionStore.transactions.find((t) => t.id === editId.value);
    if (tx) prefill(tx);
  } else {
    initNew();
  }

  isReady.value = true;
});

async function onDone() {
  const ok = await doSave();
  if (ok) {
    const qAccount = route.query.account as string | undefined;
    if (qAccount) router.replace(`/accounts/${qAccount}`);
    else router.replace("/");
  }
}

async function onSaveNext() {
  const ok = await doSave();
  if (ok) {
    expression.value = "";
    selectedTagIds.value = [];
    note.value = "";
    categoryId.value = defaultCategoryId.value;
    occurredAt.value = toLocalDatetimeString(new Date());
  }
}

async function deleteTx() {
  if (!editId.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await transactionStore.remove(editId.value);
    const qAccount = route.query.account as string | undefined;
    if (qAccount) router.replace(`/accounts/${qAccount}`);
    else router.replace("/");
  } catch (e) {
    console.error("Delete transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

function onDateTimeConfirm(value: string) {
  occurredAt.value = value;
  datePickerVisible.value = false;
}

function handleCreateAccount(): void {
  accountPickerVisible.value = false;
  accountCreateSheetVisible.value = true;
}

function onAccountCreated(accountId: string) {
  accountCreateSheetVisible.value = false;
  const ledgerId = ledgerStore.currentLedger?.id;
  if (ledgerId) {
    accountStore.fetchAll(ledgerId).then(() => {
      if (accountPickerTarget.value === "from") {
        fromAccountId.value = accountId;
      } else {
        toAccountId.value = accountId;
      }
    });
  }
}

function goBack() {
  router.back();
}
</script>
```

> 模板保持不变——它引用的 `txType`/`switchType`/`getAccountName`/`openAccountPicker`/`onDone` 等，现在由解构的 composable 返回值或组件本地函数提供，名字一致。

- [ ] **Step 3: 创建 useTransactionForm.test.ts**

```ts
// src/composables/__tests__/useTransactionForm.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const currentLedger = { id: "l1", type: "personal" };
const accounts = ref([] as { id: string; name: string; is_deleted: boolean; owner_id: string }[]);
const categories = ref([] as { id: string; name: string; type: string; sort_order: number }[]);
const transactionAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ init: vi.fn(), currentLedger }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({ accounts: accounts.value, fetchAll: vi.fn() }),
}));
vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({ categories: categories.value, fetchAll: vi.fn() }),
}));
vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({ tags: [], fetchAll: vi.fn() }),
}));
vi.mock("@/stores/transaction", () => ({
  useTransactionStore: () => ({ transactions: [], add: transactionAdd, update: vi.fn(), remove: vi.fn(), fetchAll: vi.fn() }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: { server_user_id: "u1" } }),
}));
vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "u1",
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {}, query: {} }),
}));

import { useTransactionForm } from "@/composables/useTransactionForm";

describe("useTransactionForm.doSave 校验", () => {
  beforeEach(() => {
    accounts.value = [];
    categories.value = [];
    transactionAdd.mockClear();
  });

  it("缺分类：expense 无分类返回 false 且 saveError=请选择分类", async () => {
    const f = useTransactionForm();
    f.expression.value = "10";
    f.fromAccountId.value = "a1";
    const ok = await f.doSave();
    expect(ok).toBe(false);
    expect(f.saveError.value).toBe("请选择分类");
    expect(transactionAdd).not.toHaveBeenCalled();
  });

  it("缺账户：expense 无 from 账户返回 false", async () => {
    const f = useTransactionForm();
    f.expression.value = "10";
    f.categoryId.value = "c1";
    const ok = await f.doSave();
    expect(ok).toBe(false);
    expect(transactionAdd).not.toHaveBeenCalled();
  });

  it("合法 expense：调 add 且返回 true", async () => {
    const f = useTransactionForm();
    f.expression.value = "10";
    f.categoryId.value = "c1";
    f.fromAccountId.value = "a1";
    const ok = await f.doSave();
    expect(ok).toBe(true);
    expect(transactionAdd).toHaveBeenCalledTimes(1);
    const data = transactionAdd.mock.calls[0][0];
    expect(data.type).toBe("expense");
    expect(data.amount).toBe(10);
    expect(data.category_id).toBe("c1");
    expect(data.from_account_id).toBe("a1");
    expect(data.to_account_id).toBeNull();
  });
});
```

- [ ] **Step 4: 跑测试 + 构建**

Run: `cd D:/projects/my/wee-count && npx vitest run src/composables/__tests__/useTransactionForm.test.ts && npm run build`
Expected: PASS + build 通过

- [ ] **Step 5: Commit**

```bash
git add src/composables/useTransactionForm.ts src/composables/__tests__/useTransactionForm.test.ts src/views/RecordPage.vue
git commit -m "refactor(frontend): 抽 useTransactionForm composable"
```

---

### Task 5: 转账 from===to 校验 + 测试 + README

**Files:**
- Modify: `src/composables/useTransactionForm.ts`（doSave 加校验）
- Modify: `src/composables/__tests__/useTransactionForm.test.ts`（加用例）
- Modify: `README.md`

- [ ] **Step 1: doSave 加 from===to 校验**

在 `useTransactionForm.ts` 的 `doSave` 里，账户必填校验之后、`isSaving.value = true` 之前插入：

```ts
    if (txType.value === "transfer" && fromAccountId.value && fromAccountId.value === toAccountId.value) {
      saveError.value = "转出和转入账户不能相同";
      return false;
    }
```

- [ ] **Step 2: 加测试用例**

在 `useTransactionForm.test.ts` 的 describe 里追加：

```ts
  it("转账 from===to：返回 false 且 saveError=转出和转入账户不能相同", async () => {
    const f = useTransactionForm();
    f.txType.value = "transfer";
    f.expression.value = "10";
    f.fromAccountId.value = "a1";
    f.toAccountId.value = "a1";
    const ok = await f.doSave();
    expect(ok).toBe(false);
    expect(f.saveError.value).toBe("转出和转入账户不能相同");
    expect(transactionAdd).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: 跑测试 + 构建**

Run: `cd D:/projects/my/wee-count && npx vitest run src/composables/__tests__/useTransactionForm.test.ts && npm run build`
Expected: PASS + build 通过

- [ ] **Step 4: README 同步**

在 README「已知问题修复记录」末尾（或「功能状态」之上）追加一条：

```markdown
- 前端大组件拆分（复盘第三节第 6 点）：`TransactionList.vue`/`RecordPage.vue` 的纯展示函数（事务展示/金额/日期/表达式求值）抽到 `utils/`，表单状态与校验抽成 `useTransactionForm` composable；补转账 `from===to` 校验（转出转入账户相同则拒绝）。
```

- [ ] **Step 5: Commit**

```bash
git add src/composables/useTransactionForm.ts src/composables/__tests__/useTransactionForm.test.ts README.md
git commit -m "feat(frontend): 转账 from===to 校验"
```

---

## Self-Review 记录

- **Spec 覆盖**：§4.1 纯函数 → Task 1/2/3；§4.2 composable → Task 4；§4.3 from===to → Task 5；README → Task 5。范围边界（不改模板/视觉、filterSummary/buildFetchOpts 留组件）已入 Global Constraints。
- **占位符扫描**：无 TBD；所有代码块完整。
- **类型一致性**：`formatDateLabel`（Task 1 定义）被 `groupTransactionsByDate`（Task 2）引用一致；`evaluateExpression`（Task 3）被 composable（Task 4）引用一致；composable 返回字段与 RecordPage 解构、模板引用一致。
- **任务顺序**：datetime（Task 1）→ transaction 依赖它（Task 2）→ expression（Task 3）→ composable 依赖它（Task 4）→ 校验（Task 5），依赖已排序。
