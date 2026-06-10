<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDown, Filter, Plus } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import type { Transaction } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const transactionStore = useTransactionStore();

const filterAccountId = ref<string>("");
const isLoading = ref(true);

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

// 账户过滤切换
watch(filterAccountId, async (newVal) => {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isLoading.value) return;
  await transactionStore.fetchAll(ledgerId, newVal || undefined);
});

const accountPickerVisible = ref(false);

function getAccountName(id: string): string {
  if (!id) return "全部账户";
  return accountStore.accounts.find((a) => a.id === id)?.name ?? id;
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
  router.push(`/record/${txId}`);
}
</script>

<template>
  <div class="flex flex-1 flex-col bg-bg">
    <!-- Header：账户详情模式 -->
    <AppHeader
      v-if="isAccountMode"
      :title="currentAccount?.name ?? '账户'"
      show-back
      @back="router.push('/accounts')"
    >
      <template #action>
        <span
          class="h-3 w-3 shrink-0 rounded-full"
          :style="{ backgroundColor: currentAccount?.color || '#3b82f6' }"
        />
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push('/filter')"
        >
          <Filter :size="18" class="text-text-secondary" />
        </button>
      </template>
    </AppHeader>

    <!-- Header：首页模式 -->
    <AppHeader v-else title="">
      <template #title>
        <button class="flex items-center gap-1 text-lg font-semibold text-text">
          我的账本
          <ChevronDown :size="16" class="text-text-secondary" />
        </button>
      </template>
      <template #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push('/filter')"
        >
          <Filter :size="18" class="text-text-secondary" />
        </button>
      </template>
    </AppHeader>

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

    <!-- 账户过滤器（仅首页模式，且未指定账户时显示） -->
    <div v-if="!isAccountMode && !route.query.account" class="bg-surface px-4 pb-2">
      <button
        class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        @click="accountPickerVisible = true"
      >
        <span class="flex items-center gap-2">
          <span
            v-if="filterAccountId"
            class="h-2.5 w-2.5 shrink-0 rounded-full"
            :style="{ backgroundColor: accountStore.accounts.find(a => a.id === filterAccountId)?.color || '#3b82f6' }"
          />
          {{ getAccountName(filterAccountId) }}
        </span>
        <ChevronDown :size="14" class="text-text-secondary" />
      </button>
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

    <!-- FAB -->
    <router-link
      :to="isAccountMode ? `/record?account=${accountId}` : '/record'"
      class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
      style="top: 75%"
    >
      <Plus :size="28" />
    </router-link>

    <!-- 账户选择 Sheet -->
    <AccountPickerSheet
      :visible="accountPickerVisible"
      :show-all-option="true"
      @close="accountPickerVisible = false"
      @select="(acc) => { filterAccountId = acc.id; accountPickerVisible = false }"
      @select-all="filterAccountId = ''; accountPickerVisible = false"
    />
  </div>
</template>
