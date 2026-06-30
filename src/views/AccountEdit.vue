<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Trash2,
} from "lucide-vue-next";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY } from "@/types";
import { useAccountStore } from "@/stores/account";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import AppHeader from "@/components/AppHeader.vue";
import AccountFormFields from "@/components/AccountFormFields.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";

const route = useRoute();
const router = useRouter();
const accountStore = useAccountStore();
const auth = useAuthStore();

const accountId = computed(() => route.params.id as string);
const account = computed(() =>
  accountStore.accounts.find((a) => a.id === accountId.value)
);

const isOwner = computed(() => {
  if (!account.value) return true;
  const currentUserId = auth.currentLocalUser?.server_user_id || getCurrentUserId();
  return account.value.owner_id === currentUserId;
});

const name = ref("");
const categoryTab = ref<"asset" | "liability">("asset");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const creditLimit = ref("");
const repaymentDay = ref("");
const color = ref("#3b82f6");

const deleteDialogVisible = ref(false);
const saving = ref(false);

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
  <div class="flex h-full flex-col bg-bg">
    <AppHeader
      title="编辑账户"
      :show-back="true"
      @back="router.back()"
    >
      <template #action>
        <button
          v-if="isOwner"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="deleteDialogVisible = true"
        >
          <Trash2 :size="18" class="text-expense" />
        </button>
        <span v-else class="text-xs text-text-secondary">他人账户</span>
      </template>
    </AppHeader>

    <div v-if="account" class="flex-1 overflow-auto px-4 py-4">
      <AccountFormFields
        v-model:name="name"
        v-model:category-tab="categoryTab"
        v-model:account-type="accountType"
        v-model:initial-balance="initialBalance"
        v-model:credit-limit="creditLimit"
        v-model:repayment-day="repaymentDay"
        v-model:color="color"
      />
    </div>

    <div v-else class="flex flex-1 items-center justify-center">
      <p class="text-text-secondary">账户不存在</p>
    </div>

    <!-- 底部保存按钮 -->
    <div v-if="account" class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
        :disabled="!name.trim() || saving || !isOwner"
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
