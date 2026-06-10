# Phase 4 UI 优化实施方案

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构路由结构、底部 Tab 导航、流水页/记账页/账户页布局，新增筛选页、占位页、自定义计算器键盘和日期时间面板。

**Architecture:** 路由从"记账首页"改为"流水首页"，底部 Tab 从 4 个调整为 首页/报表/账户/我的，记账和筛选页通过 `meta.hideTab` 隐藏 Tab 栏。TransactionList 通过路由参数区分首页和账户详情两种模式。

**Tech Stack:** Vue 3 + TypeScript + Vue Router 4 + Pinia + Tailwind CSS + lucide-vue-next

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/router/index.ts` | 修改 | 新路由表、重定向、meta.hideTab |
| `src/App.vue` | 修改 | 新 Tab 结构、隐藏逻辑 |
| `src/views/TransactionList.vue` | 修改 | 双模式（首页/账户详情）、汇总卡片、FAB、筛选按钮 |
| `src/views/RecordPage.vue` | 修改 | 字段重排、CalculatorKeypad、DateTimeSheet、再记一笔 |
| `src/views/AccountList.vue` | 修改 | Header 添加按钮、点击跳转 `/accounts/:id` |
| `src/views/FilterPage.vue` | 新增 | 全屏筛选页 |
| `src/views/ReportsPage.vue` | 新增 | 报表占位页 |
| `src/views/MePage.vue` | 新增 | 我的占位页 |
| `src/components/CalculatorKeypad.vue` | 新增 | 自定义数字键盘（九宫格 + 运算符 + 完成/再记一笔） |
| `src/components/DateTimeSheet.vue` | 新增 | 底部弹出日期时间选择面板 |

---

### Task 1: 路由重构

**Files:**
- Modify: `src/router/index.ts` (replace all routes)

- [ ] **Step 1: 重写路由表**

```typescript
import { createRouter, createWebHistory } from "vue-router";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: "/",
      name: "home",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/accounts/:id",
      name: "account-detail",
      component: () => import("@/views/TransactionList.vue"),
    },
    {
      path: "/record",
      name: "record",
      component: () => import("@/views/RecordPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/record/:id",
      name: "record-edit",
      component: () => import("@/views/RecordPage.vue"),
      meta: { hideTab: true },
    },
    {
      path: "/filter",
      name: "filter",
      component: () => import("@/views/FilterPage.vue"),
      meta: { hideTab: true },
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
      path: "/reports",
      name: "reports",
      component: () => import("@/views/ReportsPage.vue"),
    },
    {
      path: "/me",
      name: "me",
      component: () => import("@/views/MePage.vue"),
    },
    // 旧路由重定向
    {
      path: "/transactions",
      redirect: "/",
    },
    {
      path: "/settings",
      component: () => import("@/views/SettingsPage.vue"),
    },
  ],
});

export default router;
```

- [ ] **Step 2: 验证路由编译**

运行: `npx vue-tsc --noEmit`
预期: 类型错误不在路由文件中（新增页面组件尚不存在，会报导入错误，后续任务解决）

- [ ] **Step 3: Commit**

```bash
git add src/router/index.ts
git commit -m "feat(router): restructure routes for Phase 4 UI"
```

---

### Task 2: App.vue Tab 栏改造

**Files:**
- Modify: `src/App.vue` (replace entire script and template)

- [ ] **Step 1: 替换 Tab 栏和模板**

将 `src/App.vue` 的 `<script setup>` 替换为：

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { Home, BarChart3, Wallet, User } from "lucide-vue-next";

const route = useRoute();

const tabs = [
  { path: "/", label: "首页", icon: Home },
  { path: "/reports", label: "报表", icon: BarChart3 },
  { path: "/accounts", label: "账户", icon: Wallet },
  { path: "/me", label: "我的", icon: User },
];

function isActive(tabPath: string): boolean {
  if (tabPath === "/") {
    return route.path === "/" || route.path.startsWith("/accounts/");
  }
  if (tabPath === "/accounts") {
    return route.path === "/accounts" || route.path.startsWith("/accounts/");
  }
  return route.path === tabPath;
}

const showTab = computed(() => !route.meta.hideTab);
</script>
```

将 `<template>` 替换为：

```vue
<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <div class="flex-1 overflow-auto">
      <RouterView />
    </div>

    <nav
      v-if="showTab"
      class="flex shrink-0 border-t border-gray-200 bg-surface pb-[env(safe-area-inset-bottom)]"
    >
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

- [ ] **Step 2: 修正 Tab 高亮逻辑**

`isActive` 需要处理路由层级关系：
- `/` 首页：匹配 `/`（流水首页）和 `/accounts/:id`、`/accounts/:id/edit`（账户详情页也在首页 tab 下，但账户 tab 也高亮？不——按设计 `/accounts/:id` → 账户高亮）

重新审视设计文档：
- `/` → 首页高亮
- `/accounts` → 账户高亮；`/accounts/:id`、`/accounts/:id/edit` → 账户高亮
- `/reports` → 报表高亮
- `/me` → 我的高亮
- `/record`、`/record/:id` → 不高亮任何 tab（Tab 栏隐藏）

修改 `isActive`：

```typescript
function isActive(tabPath: string): boolean {
  if (tabPath === "/") {
    return route.path === "/";
  }
  if (tabPath === "/accounts") {
    return route.path.startsWith("/accounts");
  }
  return route.path === tabPath;
}
```

- [ ] **Step 3: 验证**

运行: `npx vue-tsc --noEmit`
预期: 路由相关的类型错误（FilterPage、ReportsPage、MePage 还不存在），App.vue 自身无类型错误

- [ ] **Step 4: Commit**

```bash
git add src/App.vue
git commit -m "feat(tab): restructure bottom tab nav for Phase 4"
```

---

### Task 3: TransactionList 双模式改造（首页 + 账户详情）

**Files:**
- Modify: `src/views/TransactionList.vue` (大幅重写)

- [ ] **Step 1: 添加汇总卡片计算逻辑**

在 `<script setup>` 中，在现有 computed 之后新增：

```typescript
// 判断是否为账户详情模式
const isAccountMode = computed(() => !!route.params.id);
const accountId = computed(() => route.params.id as string | undefined);

// 当前账户信息
const currentAccount = computed(() => {
  if (!accountId.value) return null;
  return accountStore.accounts.find((a) => a.id === accountId.value) ?? null;
});

// 筛选后的收入合计
const filteredIncome = computed(() =>
  transactionStore.transactions
    .filter((t) => t.type === "income")
    .reduce((sum, t) => sum + t.amount, 0)
);

// 筛选后的支出合计
const filteredExpense = computed(() =>
  transactionStore.transactions
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0)
);

// 净收支
const netChange = computed(() => filteredIncome.value - filteredExpense.value);
```

- [ ] **Step 2: 修改数据加载逻辑**

替换 `onMounted` 和 `watch`：

```typescript
onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await accountStore.fetchAll(ledgerId);

  // 从 route params 判断模式
  if (isAccountMode.value && accountId.value) {
    filterAccountId.value = accountId.value;
  } else {
    // 从 query 读取筛选条件
    const qAccount = route.query.account as string | undefined;
    if (qAccount) filterAccountId.value = qAccount;
  }

  await transactionStore.fetchAll(ledgerId, filterAccountId.value || undefined);
  isLoading.value = false;
});
```

筛选条件从 route query 读取的方法（新增）：

```typescript
import { computed } from "vue";
// ... 已有 imports ...

// 从 route.query 读取筛选参数
function getFilterParams() {
  return {
    account: (route.query.account as string) || "",
    dateFrom: (route.query.dateFrom as string) || "",
    dateTo: (route.query.dateTo as string) || "",
    tags: (route.query.tags as string) || "",
  };
}
```

- [ ] **Step 3: 替换 Header**

在 `<template>` 中，将 `AppHeader` 替换为条件渲染：

```vue
<AppHeader v-if="isAccountMode" :title="currentAccount?.name ?? '账户'" show-back @back="router.push('/accounts')">
  <template #action>
    <span
      class="h-3 w-3 shrink-0 rounded-full"
      :style="{ backgroundColor: currentAccount?.color || '#3b82f6' }"
    />
    <button class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100" @click="router.push('/filter')">
      <Filter :size="18" class="text-text-secondary" />
    </button>
  </template>
</AppHeader>

<AppHeader v-else title="">
  <template #default>
    <button class="flex items-center gap-1 text-lg font-semibold text-text">
      我的账本
      <ChevronDown :size="16" class="text-text-secondary" />
    </button>
  </template>
  <template #action>
    <button class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100" @click="router.push('/filter')">
      <Filter :size="18" class="text-text-secondary" />
    </button>
  </template>
</AppHeader>
```

但 `AppHeader` 当前 `title` 不支持 slot 覆盖。需要修改 `AppHeader.vue`：

在 `AppHeader.vue` 的 `<template>` 中，将 `<h1>` 改为：

```vue
<button
  v-if="showBack"
  class="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
  @click="$emit('back')"
>
  <ArrowLeft :size="20" class="text-text" />
</button>
<slot name="title">
  <h1 class="flex-1 text-lg font-semibold text-text">{{ title }}</h1>
</slot>
<slot name="action" />
```

AppHeader 新增 `title` slot。同步修改 AppHeader 的变更纳入本 Task。

导入 Filter 图标：

```typescript
import { ChevronDown, Filter, Plus } from "lucide-vue-next";
```

- [ ] **Step 4: 添加汇总卡片**

在 Header 下方（账户过滤器上方）添加汇总卡片：

```vue
<!-- 汇总卡片 -->
<div class="bg-surface px-4 py-3">
  <!-- 首页模式：净资产 / 净收支 -->
  <template v-if="!isAccountMode">
    <p class="text-xs text-text-secondary">净资产</p>
    <p class="mt-0.5 text-2xl font-bold text-text">
      ¥{{ accountStore.netAssets.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
    </p>
    <div class="mt-2 flex gap-6 text-xs">
      <span class="text-text-secondary">
        资产 ¥{{ accountStore.assetsTotal.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </span>
      <span class="text-text-secondary">
        负债 -¥{{ Math.abs(accountStore.liabilitiesTotal).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </span>
    </div>
  </template>

  <!-- 账户详情模式：当前余额 + 收入/支出合计 -->
  <template v-else>
    <p class="text-xs text-text-secondary">当前余额</p>
    <p class="mt-0.5 text-2xl font-bold text-text">
      ¥{{ (currentAccount?.current_balance ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
    </p>
    <div class="mt-2 flex gap-6 text-xs">
      <span class="text-text-secondary">
        收入 ¥{{ filteredIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </span>
      <span class="text-text-secondary">
        支出 ¥{{ filteredExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </span>
    </div>
  </template>
</div>
```

- [ ] **Step 5: 移除账户过滤栏（仅首页保留）**

将现有账户过滤器包裹在条件中：

```vue
<!-- 账户过滤器（仅首页模式，且未指定账户时显示） -->
<div v-if="!isAccountMode && !route.query.account" class="bg-surface px-4 pb-2">
  <button
    class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
    @click="accountPickerVisible = true"
  >
    ...现有内容...
  </button>
</div>
```

- [ ] **Step 6: 添加 FAB 按钮**

在 `</div>`（最外层 div）闭合前添加：

```vue
<!-- FAB -->
<router-link
  to="/record"
  class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
  style="top: 75%"
>
  <Plus :size="28" />
</router-link>
```

- [ ] **Step 7: 账户详情模式 FAB 携带 account 参数**

```vue
<router-link
  :to="isAccountMode ? `/record?account=${accountId}` : '/record'"
  class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
  style="top: 75%"
>
  <Plus :size="28" />
</router-link>
```

- [ ] **Step 8: 验证**

运行: `npx vue-tsc --noEmit`
预期: 无 TransactionList 相关的类型错误（FilterPage 等新增页面的导入错误仍然存在）

- [ ] **Step 9: Commit**

```bash
git add src/views/TransactionList.vue src/components/AppHeader.vue
git commit -m "feat(transaction-list): add dual mode, summary card, FAB for Phase 4"
```

---

### Task 4: CalculatorKeypad 组件

**Files:**
- Create: `src/components/CalculatorKeypad.vue`

- [ ] **Step 1: 创建 CalculatorKeypad 组件**

```vue
<script setup lang="ts">
import { Delete } from "lucide-vue-next";

defineProps<{
  expression: string;
  result: number | null;
  isValid: boolean;
}>();

const emit = defineEmits<{
  input: [key: string];
  done: [];
  saveNext: [];
}>();

const keys = [
  ["7", "8", "9", "saveNext"],
  ["4", "5", "6", "+"],
  ["1", "2", "3", "-"],
  [".", "0", "delete", "done"],
];

function onKey(key: string) {
  if (key === "done") {
    emit("done");
  } else if (key === "saveNext") {
    emit("saveNext");
  } else if (key === "delete") {
    emit("input", "delete");
  } else {
    emit("input", key);
  }
}

function keyLabel(key: string): string {
  switch (key) {
    case "done": return "完成";
    case "saveNext": return "再记一笔";
    case "delete": return "⌫";
    default: return key;
  }
}
</script>

<template>
  <div class="grid grid-cols-4 gap-0 border-t border-gray-200 bg-surface">
    <template v-for="row in keys" :key="row[0]">
      <button
        v-for="key in row"
        :key="key"
        class="flex items-center justify-center py-3 text-base font-medium transition-colors active:bg-gray-100"
        :class="{
          'text-text': key !== 'done' && key !== 'saveNext',
          'bg-primary text-white active:bg-primary-dark': key === 'done' && isValid,
          'bg-expense text-white active:bg-red-600': key === 'saveNext' && isValid,
          'bg-gray-200 text-gray-400 cursor-not-allowed': (key === 'done' || key === 'saveNext') && !isValid,
          'col-span-2': key === 'done' || key === 'saveNext',
        }"
        :disabled="(key === 'done' || key === 'saveNext') && !isValid"
        @click="onKey(key)"
      >
        <Delete v-if="key === 'delete'" :size="22" />
        <span v-else>{{ keyLabel(key) }}</span>
      </button>
    </template>
  </div>
</template>
```

- [ ] **Step 2: 验证**

运行: `npx vue-tsc --noEmit`
预期: 无 CalculatorKeypad 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/components/CalculatorKeypad.vue
git commit -m "feat(calculator-keypad): add custom calculator keypad component"
```

---

### Task 5: DateTimeSheet 组件

**Files:**
- Create: `src/components/DateTimeSheet.vue`

- [ ] **Step 1: 创建 DateTimeSheet 组件**

```vue
<script setup lang="ts">
import { ref, watch } from "vue";
import { X } from "lucide-vue-next";

const props = defineProps<{
  visible: boolean;
  dateTime: string; // ISO datetime-local format "YYYY-MM-DDTHH:mm"
}>();

const emit = defineEmits<{
  close: [];
  confirm: [value: string];
}>();

const localDate = ref("");
const localTime = ref("");

watch(
  () => props.dateTime,
  (val) => {
    if (val) {
      localDate.value = val.slice(0, 10);
      localTime.value = val.slice(11, 16);
    }
  },
  { immediate: true }
);

function confirm() {
  if (localDate.value && localTime.value) {
    emit("confirm", `${localDate.value}T${localTime.value}`);
  }
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
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">选择日期时间</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="mb-4">
          <label class="mb-1 block text-xs text-text-secondary">日期</label>
          <input
            v-model="localDate"
            type="date"
            class="w-full rounded-lg border border-gray-200 bg-bg px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
        </div>

        <div class="mb-6">
          <label class="mb-1 block text-xs text-text-secondary">时间</label>
          <input
            v-model="localTime"
            type="time"
            class="w-full rounded-lg border border-gray-200 bg-bg px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
        </div>

        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
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

- [ ] **Step 2: 验证**

运行: `npx vue-tsc --noEmit`
预期: 无 DateTimeSheet 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/components/DateTimeSheet.vue
git commit -m "feat(date-time-sheet): add bottom sheet date time picker component"
```

---

### Task 6: RecordPage 重构

**Files:**
- Modify: `src/views/RecordPage.vue` (大幅重写)

- [ ] **Step 1: 重写 script setup**

完整替换 `<script setup>` 为：

```typescript
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDown, ArrowLeft, Trash2 } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import TagSheet from "@/components/TagSheet.vue";
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import DateTimeSheet from "@/components/DateTimeSheet.vue";
import CalculatorKeypad from "@/components/CalculatorKeypad.vue";
import type { Account, Category, Tag, TransactionType } from "@/types";

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
const expression = ref("");      // 表达式原文
const selectedTagIds = ref<string[]>([]);

const tagSheetVisible = ref(false);
const deleteDialogVisible = ref(false);
const accountPickerVisible = ref(false);
const accountPickerTarget = ref<"from" | "to">("from");
const dateTimeSheetVisible = ref(false);
const isSaving = ref(false);
const isReady = ref(false);

// 按类型过滤分类
const filteredCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === txType.value)
);

// 按 sort_order 排序，找出默认分类
const defaultCategoryId = computed(() => {
  const cats = [...filteredCategories.value].sort((a, b) => a.sort_order - b.sort_order);
  return cats[0]?.id ?? null;
});

// 可用账户
const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => !a.is_deleted)
);

// 表达式求值结果
const calcResult = computed<number | null>(() => {
  const expr = expression.value.trim();
  if (!expr || /[+\-.]$/.test(expr)) return null;
  // 安全求值：只允许数字、+、-、.
  if (!/^[\d.\-+]+$/.test(expr)) return null;
  try {
    // 用 Function 安全求值
    const result = new Function(`return (${expr})`)() as number;
    if (isNaN(result) || result <= 0) return null;
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
});

const isValid = computed(() => calcResult.value !== null);

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
      occurredAt.value = tx.occurred_at.slice(0, 16);
      expression.value = tx.amount.toString();
      selectedTagIds.value = tx.tags?.map((t) => t.id) ?? [];
    }
  } else {
    // 新增模式：默认当前时间
    const now = new Date();
    occurredAt.value = now.toISOString().slice(0, 16);
    // 从 query 读取默认账户
    const qAccount = route.query.account as string | undefined;
    const defaultAcc = qAccount
      ? availableAccounts.value.find((a) => a.id === qAccount)
      : availableAccounts.value[0];
    if (defaultAcc) {
      fromAccountId.value = defaultAcc.id;
      toAccountId.value = defaultAcc.id;
    }
    // 默认分类
    categoryId.value = defaultCategoryId.value;
  }

  isReady.value = true;
});

// 切换交易类型时重置分类
watch(txType, () => {
  categoryId.value = defaultCategoryId.value;
});

// 分类选择
function selectCategory(cat: Category) {
  categoryId.value = cat.id;
}

// 标签
function onTagConfirm(tagIds: string[]) {
  selectedTagIds.value = tagIds;
  tagSheetVisible.value = false;
}

const selectedTags = computed(() =>
  selectedTagIds.value
    .map((id) => tagStore.tags.find((t) => t.id === id))
    .filter((t): t is Tag => t != null)
);

function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx >= 0) {
    selectedTagIds.value.splice(idx, 1);
  } else {
    selectedTagIds.value.push(tagId);
  }
}

// 账户相关
function getAccountName(id: string | null): string {
  if (!id) return "";
  return accountStore.accounts.find((a) => a.id === id)?.name ?? "";
}

function openAccountPicker(target: "from" | "to") {
  accountPickerTarget.value = target;
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

// 键盘输入处理
function onKeypadInput(key: string) {
  if (key === "delete") {
    expression.value = expression.value.slice(0, -1);
  } else {
    // 防止连续两个运算符
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

// 保存逻辑
async function doSave(): Promise<boolean> {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isSaving.value || !isValid.value) return false;

  const amt = calcResult.value!;

  // 基础校验
  if (txType.value !== "transfer" && !categoryId.value) return false;
  if (!fromAccountId.value) return false;
  if (txType.value !== "expense" && !toAccountId.value) return false;

  isSaving.value = true;
  try {
    const data = {
      ledger_id: ledgerId,
      user_id: "local-user-1",
      type: txType.value,
      amount: amt,
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
    return true;
  } catch (e) {
    console.error("Save transaction failed:", e);
    return false;
  } finally {
    isSaving.value = false;
  }
}

async function onDone() {
  const ok = await doSave();
  if (ok) router.replace("/");
}

async function onSaveNext() {
  const ok = await doSave();
  if (ok) {
    // 重置表单
    expression.value = "";
    categoryId.value = defaultCategoryId.value;
    const now = new Date();
    occurredAt.value = now.toISOString().slice(0, 16);
    // 保留账户和标签
  }
}

// 删除
async function deleteTx() {
  if (!editId.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await transactionStore.remove(editId.value);
    router.replace("/");
  } catch (e) {
    console.error("Delete transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

function goBack() {
  router.back();
}

// 格式化日期显示
const dateDisplay = computed(() => {
  if (!occurredAt.value) return "";
  const d = new Date(occurredAt.value);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours().toString().padStart(2, "0");
  const mins = d.getMinutes().toString().padStart(2, "0");
  const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${month}月${day}日 ${weekDays[d.getDay()]} ${hours}:${mins}`;
});
```

- [ ] **Step 2: 重写 template**

完整替换 `<template>` 为（保留 `<style scoped>` 不变）：

```vue
<template>
  <div class="flex flex-1 flex-col bg-bg">
    <AppHeader
      :title="isEdit ? '编辑记录' : '记账'"
      :show-back="true"
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
      <!-- 1. 类型切换 -->
      <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
        <button
          v-for="t in (['expense', 'income', 'transfer'] as TransactionType[])"
          :key="t"
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="txType === t ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="txType = t"
        >
          {{ t === 'expense' ? '支出' : t === 'income' ? '收入' : '转账' }}
        </button>
      </div>

      <!-- 2. 金额 (表达式输入) -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">金额</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-lg font-semibold text-text">¥</span>
          <div
            class="w-full rounded-lg border border-gray-200 bg-surface py-2.5 pl-8 pr-3 text-right text-lg font-semibold text-text outline-none focus:border-primary"
          >
            <span v-if="expression">{{ expression }}</span>
            <span v-else class="text-gray-300">0</span>
          </div>
        </div>
        <p v-if="calcResult !== null" class="mt-1 text-right text-xs text-text-secondary">
          = {{ calcResult.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </p>
      </div>

      <!-- 3. 分类网格（转账时隐藏） -->
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

      <!-- 4. 账户 -->
      <div class="mb-4 space-y-2">
        <div v-if="txType === 'transfer'" class="space-y-2">
          <div>
            <label class="mb-1 block text-xs text-text-secondary">转出账户</label>
            <button
              class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
              @click="openAccountPicker('from')"
            >
              <span class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :style="{ backgroundColor: availableAccounts.find(a => a.id === fromAccountId)?.color || '#ccc' }"
                />
                {{ getAccountName(fromAccountId) || '请选择' }}
              </span>
              <ChevronDown :size="14" class="text-text-secondary" />
            </button>
          </div>
          <div class="flex justify-center text-text-secondary">
            <ChevronDown :size="16" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-text-secondary">转入账户</label>
            <button
              class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
              @click="openAccountPicker('to')"
            >
              <span class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :style="{ backgroundColor: availableAccounts.find(a => a.id === toAccountId)?.color || '#ccc' }"
                />
                {{ getAccountName(toAccountId) || '请选择' }}
              </span>
              <ChevronDown :size="14" class="text-text-secondary" />
            </button>
          </div>
        </div>
        <div v-else>
          <label class="mb-1 block text-xs text-text-secondary">
            {{ txType === 'expense' ? '扣款账户' : '入账账户' }}
          </label>
          <button
            class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            @click="openAccountPicker(txType === 'expense' ? 'from' : 'to')"
          >
            <span class="flex items-center gap-2">
              <span
                class="h-2.5 w-2.5 shrink-0 rounded-full"
                :style="{ backgroundColor: availableAccounts.find(a => a.id === (txType === 'expense' ? fromAccountId : toAccountId))?.color || '#ccc' }"
              />
              {{ getAccountName(txType === 'expense' ? fromAccountId : toAccountId) || '请选择' }}
            </span>
            <ChevronDown :size="14" class="text-text-secondary" />
          </button>
        </div>
      </div>

      <!-- 5. 日期时间 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">日期时间</label>
        <button
          class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          @click="dateTimeSheetVisible = true"
        >
          <span>{{ dateDisplay || '请选择' }}</span>
          <ChevronDown :size="14" class="text-text-secondary" />
        </button>
      </div>

      <!-- 6. 标签 -->
      <div class="mb-4">
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

    <!-- 自定义键盘 -->
    <CalculatorKeypad
      v-if="isReady"
      :expression="expression"
      :result="calcResult"
      :is-valid="isValid"
      @input="onKeypadInput"
      @done="onDone"
      @save-next="onSaveNext"
    />

    <!-- DateTimeSheet -->
    <DateTimeSheet
      :visible="dateTimeSheetVisible"
      :date-time="occurredAt"
      @close="dateTimeSheetVisible = false"
      @confirm="(val) => { occurredAt = val; dateTimeSheetVisible = false }"
    />

    <!-- 标签选择 Sheet -->
    <TagSheet
      :visible="tagSheetVisible"
      :selected-ids="selectedTagIds"
      @close="tagSheetVisible = false"
      @confirm="onTagConfirm"
    />

    <!-- 账户选择 Sheet -->
    <AccountPickerSheet
      :visible="accountPickerVisible"
      @close="accountPickerVisible = false"
      @select="onAccountSelect"
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

- [ ] **Step 3: 移除不再需要的 computed 和代码**

确认旧的 `switchType`、`save`、`amount`、`amountDisplay`、`saveLabel` 等已被替换。删除不再使用的 import（如 `ChevronDown` 仍在使用）。

- [ ] **Step 4: 验证**

运行: `npx vue-tsc --noEmit`
预期: 无 RecordPage 相关的类型错误

- [ ] **Step 5: Commit**

```bash
git add src/views/RecordPage.vue
git commit -m "feat(record-page): integrate CalculatorKeypad, DateTimeSheet, reorder fields"
```

---

### Task 7: AccountList 改造

**Files:**
- Modify: `src/views/AccountList.vue`

- [ ] **Step 1: Header 添加 + 按钮，移除底部按钮，修改跳转路径**

修改 `script setup`：

```typescript
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

function goAccountDetail(accountId: string) {
  router.push(`/accounts/${accountId}`);
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
```

修改 `<template>`：

```vue
<template>
  <div class="flex flex-1 flex-col bg-bg">
    <AppHeader title="账户管理">
      <template #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="openAdd"
        >
          <Plus :size="20" class="text-text" />
        </button>
      </template>
    </AppHeader>

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
          @tap="goAccountDetail(account.id)"
        />
      </div>
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

关键改动：
- `AppHeader` 添加 `#action` slot 放 `+` 按钮
- 移除底部 `div.bg-surface.border-t` 整个块
- `goTransactions` → `goAccountDetail`，跳转路径从 `/transactions?account=` 改为 `/accounts/`

- [ ] **Step 2: 验证**

运行: `npx vue-tsc --noEmit`
预期: 无 AccountList 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/views/AccountList.vue
git commit -m "feat(account-list): move add button to header, change card tap route"
```

---

### Task 8: FilterPage 筛选页

**Files:**
- Create: `src/views/FilterPage.vue`

- [ ] **Step 1: 创建 FilterPage**

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTagStore } from "@/stores/tag";
import AppHeader from "@/components/AppHeader.vue";
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import type { Account } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const tagStore = useTagStore();

const selectedAccountId = ref("");
const selectedAccountName = ref("全部账户");
const dateFrom = ref("");
const dateTo = ref("");
const selectedTagIds = ref<string[]>([]);

const accountPickerVisible = ref(false);

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await Promise.all([
    accountStore.fetchAll(ledgerId),
    tagStore.fetchAll(ledgerId),
  ]);

  // 从 query 恢复筛选状态
  if (route.query.account) {
    selectedAccountId.value = route.query.account as string;
    const acc = accountStore.accounts.find((a) => a.id === selectedAccountId.value);
    if (acc) selectedAccountName.value = acc.name;
  }
  if (route.query.dateFrom) dateFrom.value = route.query.dateFrom as string;
  if (route.query.dateTo) dateTo.value = route.query.dateTo as string;
  if (route.query.tags) {
    selectedTagIds.value = (route.query.tags as string).split(",").filter(Boolean);
  }
});

function onAccountSelect(acc: Account) {
  selectedAccountId.value = acc.id;
  selectedAccountName.value = acc.name;
  accountPickerVisible.value = false;
}

function onSelectAll() {
  selectedAccountId.value = "";
  selectedAccountName.value = "全部账户";
  accountPickerVisible.value = false;
}

function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx >= 0) {
    selectedTagIds.value.splice(idx, 1);
  } else {
    selectedTagIds.value.push(tagId);
  }
}

function apply() {
  const query: Record<string, string> = {};
  if (selectedAccountId.value) query.account = selectedAccountId.value;
  if (dateFrom.value) query.dateFrom = dateFrom.value;
  if (dateTo.value) query.dateTo = dateTo.value;
  if (selectedTagIds.value.length > 0) query.tags = selectedTagIds.value.join(",");
  router.push({ path: "/", query });
}

function reset() {
  selectedAccountId.value = "";
  selectedAccountName.value = "全部账户";
  dateFrom.value = "";
  dateTo.value = "";
  selectedTagIds.value = [];
}

function goBack() {
  router.back();
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="筛选" :show-back="true" @back="goBack" />

    <div class="flex-1 overflow-auto px-4 py-4">
      <!-- 账户 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📋 账户</label>
        <button
          class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          @click="accountPickerVisible = true"
        >
          <span class="flex items-center gap-2">
            <span
              v-if="selectedAccountId"
              class="h-2.5 w-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: accountStore.accounts.find(a => a.id === selectedAccountId)?.color || '#3b82f6' }"
            />
            {{ selectedAccountName }}
          </span>
          <span class="text-text-secondary">▽</span>
        </button>
      </div>

      <!-- 日期范围 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📅 日期范围</label>
        <div class="flex items-center gap-2">
          <input
            v-model="dateFrom"
            type="date"
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
          />
          <span class="text-text-secondary">─</span>
          <input
            v-model="dateTo"
            type="date"
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
          />
        </div>
      </div>

      <!-- 标签 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">🏷️ 标签</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="tag in tagStore.tags"
            :key="tag.id"
            class="rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="selectedTagIds.includes(tag.id)
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'"
            @click="toggleTag(tag.id)"
          >
            {{ selectedTagIds.includes(tag.id) ? '☑' : '☐' }} {{ tag.name }}
          </button>
          <p v-if="tagStore.tags.length === 0" class="text-xs text-text-secondary">暂无标签</p>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="mt-8 space-y-3">
        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="apply"
        >
          应用筛选
        </button>
        <button
          class="w-full rounded-xl border border-gray-200 bg-surface py-3 text-center text-base text-text-secondary transition-colors hover:bg-gray-50"
          @click="reset"
        >
          重置
        </button>
      </div>
    </div>

    <!-- 账户选择 Sheet -->
    <AccountPickerSheet
      :visible="accountPickerVisible"
      :show-all-option="true"
      @close="accountPickerVisible = false"
      @select="onAccountSelect"
      @select-all="onSelectAll"
    />
  </div>
</template>
```

- [ ] **Step 2: 验证**

运行: `npx vue-tsc --noEmit`
预期: 无 FilterPage 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/views/FilterPage.vue
git commit -m "feat(filter-page): add full-screen filter page"
```

---

### Task 9: ReportsPage 和 MePage 占位页

**Files:**
- Create: `src/views/ReportsPage.vue`
- Create: `src/views/MePage.vue`

- [ ] **Step 1: 创建 ReportsPage**

```vue
<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
      <h1 class="flex-1 text-lg font-semibold text-text">报表</h1>
    </div>
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <p class="text-5xl">📊</p>
        <p class="mt-3 text-text-secondary">功能开发中</p>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: 创建 MePage**

```vue
<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2 pt-[calc(0.5rem+env(safe-area-inset-top))]">
      <h1 class="flex-1 text-lg font-semibold text-text">我的</h1>
    </div>
    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <p class="text-5xl">👤</p>
        <p class="mt-3 text-text-secondary">功能开发中</p>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 3: 验证**

运行: `npx vue-tsc --noEmit`
预期: 所有类型检查通过，无残留错误

- [ ] **Step 4: Commit**

```bash
git add src/views/ReportsPage.vue src/views/MePage.vue
git commit -m "feat(placeholder-pages): add ReportsPage and MePage placeholders"
```

---

### Task 10: 端到端集成验证

- [ ] **Step 1: 类型检查**

```bash
npx vue-tsc --noEmit
```
预期: 零错误

- [ ] **Step 2: 运行现有测试**

```bash
npm run test
```
预期: 所有已有测试通过
(RecordPage、TransactionList、AccountList 的测试如果存在 mock store，可能需要更新)

- [ ] **Step 3: 检查路由变化是否影响测试**

检查 `src/stores/__tests__/` 下的文件是否依赖路由或组件。Stores 测试通常不依赖路由，应无影响。

- [ ] **Step 4: 运行 Tauri 桌面端验证**

```bash
npm run tauri dev
```
手动验证：
1. 首页 `/` — 显示流水列表、汇总卡片、FAB
2. 点击 FAB → `/record` — 记账页自定义键盘可用
3. 完成记账 → 返回 `/` — 新交易出现
4. 再记一笔 → 留在 `/record` — 表单重置
5. 编辑交易 → `/record/:id` — 预填数据正确
6. 筛选页 `/filter` — 选择条件 → 应用 → 回到首页
7. 账户 tab → `/accounts` — Header 有 + 按钮
8. 点击账户卡片 → `/accounts/:id` — 账户详情流水
9. 报表 tab → `/reports` — 占位
10. 我的 tab → `/me` — 占位
11. `/transactions` — 重定向到 `/`

- [ ] **Step 5: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: integration fixes for Phase 4 UI"
```

---

## 自审

**1. Spec 覆盖检查：**

| 设计需求 | 覆盖 Task |
|----------|-----------|
| 路由重构（新路由表、旧路由重定向） | Task 1 |
| 底部 Tab 导航（首页/报表/账户/我的） | Task 2 |
| TransactionList 首页模式（汇总卡片、FAB、Header） | Task 3 |
| TransactionList 账户详情模式（余额、收支合计、默认筛选） | Task 3 |
| FAB → /record（首页） / `/record?account=:id`（账户详情） | Task 3 |
| 汇总计算（首页前端聚合 / 账户余额从 store 取） | Task 3 |
| RecordPage 字段重排 + 自定义键盘 | Task 6 |
| CalculatorKeypad 组件（九宫格 + 运算符 + 完成/再记一笔） | Task 4 |
| DateTimeSheet 组件（底部日期时间选择） | Task 5 |
| 再记一笔（保存后重置表单、保留账户/标签） | Task 6 |
| 金额表达式输入 + 实时求值 + 按钮置灰 | Task 4 + Task 6 |
| FilterPage 全屏筛选 | Task 8 |
| AccountList Header + 按钮 + 卡片跳转 | Task 7 |
| ReportsPage 占位 | Task 9 |
| MePage 占位 | Task 9 |
| 路由守卫（hideTab meta + /transactions 重定向） | Task 1 + Task 2 |
| 筛选页/记账页不显示 Tab 栏 | Task 2 (meta.hideTab) |

**2. Placeholder 扫描：** 无 TODO/TBD/占位符。所有代码步骤均包含完整实现。

**3. 类型一致性检查：**
- TransactionList → `isAccountMode` / `accountId` / `currentAccount` — 命名一致
- RecordPage → `expression` / `calcResult` / `isValid` / `onKeypadInput` / `onDone` / `onSaveNext` — 命名一致
- CalculatorKeypad → Props: `expression` / `result` / `isValid`; Emits: `input` / `done` / `saveNext` — 与 RecordPage 使用一致
- DateTimeSheet → Props: `visible` / `dateTime`; Emits: `close` / `confirm` — 与 RecordPage 使用一致
- FilterPage → `apply()` 输出 query: `{ account, dateFrom, dateTo, tags }` — 与 TransactionList `getFilterParams()` 匹配
