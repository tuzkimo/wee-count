<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import type { Transaction } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const transactionStore = useTransactionStore();

const filterAccountId = ref<string>("");
const isLoading = ref(true);

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await accountStore.fetchAll(ledgerId);

  // 从 query 读取过滤条件
  const qAccount = route.query.account as string | undefined;
  if (qAccount) filterAccountId.value = qAccount;

  await transactionStore.fetchAll(ledgerId, filterAccountId.value || undefined);
  isLoading.value = false;
});

// 账户过滤切换
watch(filterAccountId, async (newVal) => {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isLoading.value) return;
  await transactionStore.fetchAll(ledgerId, newVal || undefined);
});

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
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="流水" />

    <!-- 账户过滤器 -->
    <div class="bg-surface px-4 py-2">
      <select
        v-model="filterAccountId"
        class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
      >
        <option value="">全部账户</option>
        <option v-for="acc in accountStore.accounts" :key="acc.id" :value="acc.id">
          {{ acc.name }}
        </option>
      </select>
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
  </div>
</template>
