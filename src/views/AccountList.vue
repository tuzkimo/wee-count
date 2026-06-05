<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useRouter } from "vue-router";
import { Plus } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import AppHeader from "@/components/AppHeader.vue";
import AccountCard from "@/components/AccountCard.vue";
import AccountSheet from "@/components/AccountSheet.vue";
import type { Account } from "@/types";

const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();

const sheetVisible = ref(false);
const editingAccount = ref<Account | null>(null);
const isLoading = ref(true);

onMounted(async () => {
  await ledgerStore.init();
  if (ledgerStore.currentLedger) {
    await accountStore.fetchAll(ledgerStore.currentLedger.id);
  }
  isLoading.value = false;
});

function openAdd() {
  editingAccount.value = null;
  sheetVisible.value = true;
}

function openEdit(account: Account) {
  editingAccount.value = account;
  sheetVisible.value = true;
}

function handleDelete(account: Account) {
  if (confirm(`确定删除账户"${account.name}"吗？`)) {
    accountStore.remove(account.id);
  }
}

async function handleSubmit(data: {
  name: string;
  type: import("@/types").AccountType;
  initial_balance: number;
  color: string;
}) {
  if (!ledgerStore.currentLedger) return;

  if (editingAccount.value) {
    await accountStore.update(editingAccount.value.id, data);
  } else {
    await accountStore.add({
      ledger_id: ledgerStore.currentLedger.id,
      owner_id: ledgerStore.currentLedger.owner_id,
      ...data,
    });
  }
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader title="账户管理" :show-back="true" @back="router.push('/')" />

    <!-- 总资产汇总 -->
    <div class="bg-surface px-4 py-4">
      <p class="text-xs text-text-secondary">总资产</p>
      <p class="mt-0.5 text-2xl font-bold text-text">
        ¥{{ accountStore.totalBalance.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
      </p>
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
          @tap="openEdit(account)"
          @longpress="handleDelete(account)"
        />
      </div>
    </div>

    <!-- 底部添加按钮 -->
    <div class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="flex w-full items-center justify-center gap-1.5 rounded-xl bg-primary py-3 text-white transition-colors hover:bg-primary-dark"
        @click="openAdd"
      >
        <Plus :size="20" />
        <span class="text-base font-medium">添加账户</span>
      </button>
    </div>

    <!-- 新增/编辑 Sheet -->
    <AccountSheet
      :visible="sheetVisible"
      :edit-account="editingAccount"
      @close="sheetVisible = false"
      @submit="handleSubmit"
    />
  </div>
</template>
