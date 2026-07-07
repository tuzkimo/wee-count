<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Plus } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import AppHeader from "@/components/AppHeader.vue";
import AccountCard from "@/components/AccountCard.vue";
import AccountSheet from "@/components/AccountSheet.vue";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY } from "@/types";

const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const auth = useAuthStore();

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
    owner_id: auth.currentLocalUser?.server_user_id || getCurrentUserId() || "",
    category: ACCOUNT_CATEGORY[data.type],
    ...data,
  });
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
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
