<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDown, Filter, Plus, Pencil, ListChecks, Trash2, Circle, CheckCircle } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import type { Transaction } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const tagStore = useTagStore();
const transactionStore = useTransactionStore();

const filterAccountId = ref<string>("");
const isLoading = ref(true);

// 多选模式（仅账户详情模式）
const isMultiSelectMode = ref(false);
const selectedTxIds = ref<Set<string>>(new Set());

function enterMultiSelectMode() {
  isMultiSelectMode.value = true;
  selectedTxIds.value = new Set();
}

function exitMultiSelectMode() {
  isMultiSelectMode.value = false;
  selectedTxIds.value = new Set();
}

function toggleTxSelection(txId: string) {
  const next = new Set(selectedTxIds.value);
  if (next.has(txId)) {
    next.delete(txId);
  } else {
    next.add(txId);
  }
  selectedTxIds.value = next;
}

const selectedCount = computed(() => selectedTxIds.value.size);

// 批量删除确认
const batchDeleteDialogVisible = ref(false);

async function doBatchDelete() {
  if (selectedCount.value === 0) return;
  await transactionStore.batchRemove([...selectedTxIds.value]);
  exitMultiSelectMode();
  batchDeleteDialogVisible.value = false;
  // batchRemove 内部 fetchAll 不带 accountId 过滤，需重新按当前账户过滤
  const ledgerId = ledgerStore.currentLedger?.id;
  if (ledgerId && accountId.value) {
    await transactionStore.fetchAll(ledgerId, { accountId: accountId.value });
    await accountStore.fetchAll(ledgerId);
  }
}

// 判断是否为账户详情模式
const isAccountMode = computed(() => !!route.params.id);
const accountId = computed(() => route.params.id as string | undefined);

// 当前账户信息
const currentAccount = computed(() => {
  if (!accountId.value) return null;
  return accountStore.accounts.find((a) => a.id === accountId.value) ?? null;
});

// 使用 store 的 totalIncome / totalExpense
const totalIncome = computed(() => transactionStore.totalIncome);
const totalExpense = computed(() => transactionStore.totalExpense);
const totalBalance = computed(() => totalIncome.value - totalExpense.value);

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await accountStore.fetchAll(ledgerId);
  await tagStore.fetchAll(ledgerId);

  // 从 route params 判断模式
  if (isAccountMode.value && accountId.value) {
    filterAccountId.value = accountId.value;
  } else {
    // 从 query 读取筛选条件
    const qAccount = route.query.account as string | undefined;
    if (qAccount) filterAccountId.value = qAccount;
  }

  const opts = buildFetchOpts();
  await transactionStore.fetchAll(ledgerId, opts);
  isLoading.value = false;
});

// 监听路由 query 变化，重新获取数据
watch(
  () => route.query,
  async () => {
    if (isLoading.value) return;
    const ledgerId = ledgerStore.currentLedger?.id;
    if (!ledgerId) return;

    const qAccount = route.query.account as string | undefined;
    filterAccountId.value = qAccount || "";
    const opts = buildFetchOpts();
    await transactionStore.fetchAll(ledgerId, opts);
    // 刷新账户余额
    await accountStore.fetchAll(ledgerId);
  }
);

function buildFetchOpts() {
  const accId = isAccountMode.value ? accountId.value : (route.query.account as string | undefined);
  const qDateFrom = route.query.dateFrom as string | undefined;
  const qDateTo = route.query.dateTo as string | undefined;
  const qTags = route.query.tags as string | undefined;

  // 首页模式无任何筛选参数时，默认查当月
  let dateFrom = qDateFrom;
  let dateTo = qDateTo;
  if (!isAccountMode.value && !qDateFrom && !qDateTo && !qTags && !accId) {
    const now = new Date();
    dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    dateTo = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}T23:59`;
  }

  return {
    accountId: accId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    tagIds: qTags ? qTags.split(",").filter(Boolean) : undefined,
  };
}

// 基于 query 参数生成筛选摘要文本（用于筛选状态栏）
const filterSummary = computed(() => {
  const parts: string[] = [];
  const q = route.query;

  // 日期范围
  if (q.dateFrom || q.dateTo) {
    parts.push(`📅 ${formatDateRange(q.dateFrom as string, q.dateTo as string)}`);
  } else {
    const now = new Date();
    parts.push(`📅 ${now.getFullYear()}年${now.getMonth() + 1}月`);
  }

  // 账户
  if (q.account) {
    const acc = accountStore.accounts.find((a) => a.id === q.account);
    parts.push(`📋 ${acc?.name ?? q.account}`);
  } else {
    parts.push("📋 全部账户");
  }

  // 标签
  if (q.tags) {
    const tagIds = (q.tags as string).split(",").filter(Boolean);
    const tagNames = tagIds
      .map((id) => tagStore.tags.find((t) => t.id === id)?.name)
      .filter(Boolean) as string[];
    const MAX_VISIBLE = 2;
    if (tagNames.length <= MAX_VISIBLE) {
      parts.push(`🏷️ ${tagNames.join(", ")}`);
    } else {
      const visible = tagNames.slice(0, MAX_VISIBLE).join(", ");
      parts.push(`🏷️ ${visible}等${tagNames.length}个标签`);
    }
  } else {
    parts.push("🏷️ 全部标签");
  }

  return parts.join(" · ");
});

function formatDateRange(from: string, to: string): string {
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
  if (isAccountMode.value && accountId.value) {
    router.push(`/record/${txId}?account=${accountId.value}`);
  } else {
    router.push(`/record/${txId}`);
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <!-- Header：账户详情模式 -->
    <AppHeader
      v-if="isAccountMode"
      :title="isMultiSelectMode ? `已选 ${selectedCount} 项` : (currentAccount?.name ?? '账户')"
      show-back
      @back="isMultiSelectMode ? exitMultiSelectMode() : router.push('/accounts')"
    >
      <template #action>
        <!-- 多选模式下的操作 -->
        <template v-if="isMultiSelectMode">
          <button
            class="mr-2 text-sm font-medium text-text-secondary"
            @click="exitMultiSelectMode"
          >
            取消
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full"
            :class="selectedCount === 0 ? 'text-gray-300' : 'text-expense hover:bg-red-50'"
            :disabled="selectedCount === 0"
            @click="batchDeleteDialogVisible = true"
          >
            <Trash2 :size="18" />
          </button>
        </template>
        <!-- 正常模式 -->
        <template v-else>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="enterMultiSelectMode"
          >
            <ListChecks :size="18" class="text-text-secondary" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="router.push(`/accounts/${accountId}/edit`)"
          >
            <Pencil :size="18" class="text-text-secondary" />
          </button>
        </template>
      </template>
    </AppHeader>

    <!-- Header：首页模式 -->
    <AppHeader v-else title="">
      <template #title>
        <button class="flex flex-1 items-center gap-1 text-lg font-semibold text-text">
          我的账本
          <ChevronDown :size="16" class="text-text-secondary" />
        </button>
      </template>
      <template #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push({ path: '/filter', query: route.query })"
        >
          <Filter :size="18" class="text-text-secondary" />
        </button>
      </template>
    </AppHeader>

    <!-- 筛选状态栏（仅首页模式） -->
    <div
      v-if="!isAccountMode"
      class="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2"
      @click="router.push({ path: '/filter', query: route.query })"
    >
      <span class="whitespace-nowrap text-xs text-text-secondary">{{ filterSummary }}</span>
      <span class="text-[10px] text-gray-400">→</span>
    </div>

    <!-- 汇总卡片 -->
    <div class="shrink-0 bg-surface px-4 py-3">
      <!-- 首页模式：收入 / 支出 / 结余 -->
      <template v-if="!isAccountMode">
        <div class="flex gap-4">
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">收入</p>
            <p class="mt-1 text-lg font-bold text-income">
              ¥{{ totalIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">支出</p>
            <p class="mt-1 text-lg font-bold text-expense">
              -¥{{ totalExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">结余</p>
            <p
              class="mt-1 text-lg font-bold"
              :class="totalBalance >= 0 ? 'text-text' : 'text-expense'"
            >
              {{ totalBalance >= 0 ? '' : '-' }}¥{{ Math.abs(totalBalance).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
        </div>
      </template>

      <!-- 账户详情模式：当前余额 + 收入/支出合计（保持不变） -->
      <template v-else>
        <p class="text-xs text-text-secondary">当前余额</p>
        <p class="mt-0.5 text-2xl font-bold text-text">
          ¥{{ (currentAccount?.current_balance ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </p>
        <div class="mt-2 flex gap-6 text-xs">
          <span class="text-text-secondary">
            收入 ¥{{ totalIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
          </span>
          <span class="text-text-secondary">
            支出 ¥{{ totalExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
          </span>
        </div>
      </template>
    </div>


    <!-- 流水列表 -->
    <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
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
              @click="isMultiSelectMode ? toggleTxSelection(tx.id) : goRecord(tx.id)"
            >
              <!-- 多选模式：选择指示器 -->
              <template v-if="isMultiSelectMode">
                <CheckCircle
                  v-if="selectedTxIds.has(tx.id)"
                  :size="20"
                  class="text-primary"
                />
                <Circle
                  v-else
                  :size="20"
                  class="text-gray-300"
                />
              </template>
              <!-- 正常模式：交易图标 -->
              <span v-else class="text-xl">{{ getTxIcon(tx) }}</span>
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

    <!-- FAB（多选模式下隐藏） -->
    <router-link
      v-if="!isMultiSelectMode"
      :to="isAccountMode ? `/record?account=${accountId}` : '/record'"
      class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
      style="top: 75%"
    >
      <Plus :size="28" />
    </router-link>

    <!-- 批量删除确认 -->
    <ConfirmDialog
      :visible="batchDeleteDialogVisible"
      title="批量删除"
      :description="`确定删除选中的 ${selectedCount} 条流水吗？此操作不可撤销。`"
      confirm-text="删除"
      :danger="true"
      @confirm="doBatchDelete"
      @cancel="batchDeleteDialogVisible = false"
    />

  </div>
</template>
