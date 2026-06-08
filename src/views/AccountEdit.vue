<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Trash2,
  Building2,
  CreditCard,
  Smartphone,
  Banknote,
  Wallet,
  Scale,
} from "lucide-vue-next";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY, ACCOUNT_TYPE_LABELS } from "@/types";
import { useAccountStore } from "@/stores/account";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";

const route = useRoute();
const router = useRouter();
const accountStore = useAccountStore();

const accountId = computed(() => route.params.id as string);
const account = computed(() =>
  accountStore.accounts.find((a) => a.id === accountId.value)
);

const name = ref("");
const categoryTab = ref<"asset" | "liability">("asset");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const creditLimit = ref("");
const repaymentDay = ref("");
const color = ref("#3b82f6");

const deleteDialogVisible = ref(false);
const saving = ref(false);

const ASSET_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "cash", icon: Banknote },
  { type: "bank", icon: Building2 },
  { type: "digital", icon: Smartphone },
];

const LIABILITY_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "credit_card", icon: CreditCard },
  { type: "huabei", icon: Wallet },
  { type: "meituan_monthly", icon: Wallet },
  { type: "other_loan", icon: Scale },
];

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#64748b",
];

const isLiability = computed(() => ACCOUNT_CATEGORY[accountType.value] === "liability");

function switchCategory(tab: "asset" | "liability") {
  categoryTab.value = tab;
  accountType.value = tab === "asset" ? "bank" : "credit_card";
}

onMounted(() => {
  if (account.value) {
    name.value = account.value.name;
    accountType.value = account.value.type;
    categoryTab.value = account.value.category ?? "asset";
    initialBalance.value = String(account.value.initial_balance);
    creditLimit.value = account.value.credit_limit ? String(account.value.credit_limit) : "";
    repaymentDay.value = account.value.repayment_day ? String(account.value.repayment_day) : "";
    color.value = account.value.color;
  }
});

async function handleSave() {
  if (!name.value.trim() || saving.value) return;
  saving.value = true;
  try {
    await accountStore.update(accountId.value, {
      name: name.value.trim(),
      type: accountType.value,
      category: ACCOUNT_CATEGORY[accountType.value],
      initial_balance: parseFloat(initialBalance.value) || 0,
      credit_limit: creditLimit.value ? parseFloat(creditLimit.value) : undefined,
      repayment_day: repaymentDay.value ? parseInt(repaymentDay.value, 10) : undefined,
      color: color.value,
    });
    router.back();
  } catch (e) {
    console.error("Save failed:", e);
  } finally {
    saving.value = false;
  }
}

async function handleDelete() {
  await accountStore.remove(accountId.value);
  router.replace("/accounts");
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader
      title="编辑账户"
      :show-back="true"
      @back="router.back()"
    >
      <template #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="deleteDialogVisible = true"
        >
          <Trash2 :size="18" class="text-expense" />
        </button>
      </template>
    </AppHeader>

    <div v-if="account" class="flex-1 overflow-auto px-4 py-4">
      <!-- 名称 -->
      <label class="mb-1 block text-sm font-medium text-text">账户名称</label>
      <input
        v-model="name"
        type="text"
        placeholder="如：招商储蓄卡"
        class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      />

      <!-- 账户类型 Tab 切换 -->
      <div class="mb-3 flex rounded-lg bg-gray-100 p-0.5">
        <button
          class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
          :class="
            categoryTab === 'asset'
              ? 'bg-surface text-text shadow-sm'
              : 'text-text-secondary'
          "
          @click="switchCategory('asset')"
        >
          资产账户
        </button>
        <button
          class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
          :class="
            categoryTab === 'liability'
              ? 'bg-surface text-text shadow-sm'
              : 'text-text-secondary'
          "
          @click="switchCategory('liability')"
        >
          负债账户
        </button>
      </div>

      <!-- 资产类型 -->
      <div v-if="categoryTab === 'asset'" class="mb-4 grid grid-cols-3 gap-2">
        <button
          v-for="item in ASSET_TYPES"
          :key="item.type"
          class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
          :class="
            accountType === item.type
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'
          "
          @click="accountType = item.type"
        >
          <component :is="item.icon" :size="18" />
          <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
        </button>
      </div>

      <!-- 负债类型 -->
      <div v-if="categoryTab === 'liability'" class="mb-4 grid grid-cols-4 gap-2">
        <button
          v-for="item in LIABILITY_TYPES"
          :key="item.type"
          class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
          :class="
            accountType === item.type
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'
          "
          @click="accountType = item.type"
        >
          <component :is="item.icon" :size="18" />
          <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
        </button>
      </div>

      <!-- 初始余额/初始欠款 -->
      <label class="mb-1 block text-sm font-medium text-text">
        {{ isLiability ? "初始欠款" : "初始余额" }}
      </label>
      <input
        v-model="initialBalance"
        type="number"
        step="0.01"
        placeholder="0.00"
        class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      />

      <!-- 负债条件字段 -->
      <template v-if="isLiability">
        <label class="mb-1 block text-sm font-medium text-text">信用额度（选填）</label>
        <input
          v-model="creditLimit"
          type="number"
          step="0.01"
          placeholder="如：50000"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
        <label class="mb-1 block text-sm font-medium text-text">还款日（选填）</label>
        <input
          v-model="repaymentDay"
          type="number"
          min="1"
          max="31"
          placeholder="如：15"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </template>

      <!-- 颜色选择 -->
      <label class="mb-2 block text-sm font-medium text-text">颜色标记</label>
      <div class="mb-6 flex gap-2">
        <button
          v-for="c in COLORS"
          :key="c"
          class="h-8 w-8 rounded-full border-2 transition-transform"
          :class="color === c ? 'scale-110 border-gray-800' : 'border-transparent'"
          :style="{ backgroundColor: c }"
          @click="color = c"
        />
      </div>
    </div>

    <div v-else class="flex flex-1 items-center justify-center">
      <p class="text-text-secondary">账户不存在</p>
    </div>

    <!-- 底部保存按钮 -->
    <div v-if="account" class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        :disabled="!name.trim() || saving"
        @click="handleSave"
      >
        {{ saving ? "保存中..." : "保存" }}
      </button>
    </div>

    <!-- 删除确认对话框 -->
    <ConfirmDialog
      :visible="deleteDialogVisible"
      :title="`确定删除账户「${account?.name ?? ''}」吗？`"
      description="删除后不可恢复"
      confirm-text="删除"
      :danger="true"
      @confirm="handleDelete"
      @cancel="deleteDialogVisible = false"
    />
  </div>
</template>
