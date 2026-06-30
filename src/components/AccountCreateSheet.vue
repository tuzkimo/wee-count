<script setup lang="ts">
import { ref } from "vue";
import { X } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import { useLedgerStore } from "@/stores/ledger";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY } from "@/types";
import AccountFormFields from "@/components/AccountFormFields.vue";

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  created: [accountId: string];
}>();

const accountStore = useAccountStore();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();

const name = ref("");
const categoryTab = ref<"asset" | "liability">("asset");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const creditLimit = ref("");
const repaymentDay = ref("");
const color = ref("#3b82f6");
const saving = ref(false);
const error = ref("");

async function handleSave() {
  if (!name.value.trim() || saving.value) return;
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  saving.value = true;
  error.value = "";
  try {
    await accountStore.add({
      ledger_id: ledgerId,
      owner_id: auth.currentLocalUser?.server_user_id || getCurrentUserId() || "",
      name: name.value.trim(),
      type: accountType.value,
      category: ACCOUNT_CATEGORY[accountType.value],
      initial_balance: parseFloat(initialBalance.value) || 0,
      credit_limit: creditLimit.value ? parseFloat(creditLimit.value) : undefined,
      repayment_day: repaymentDay.value ? parseInt(repaymentDay.value, 10) : undefined,
      color: color.value,
    });
    const created = accountStore.accounts.find(
      (a) => a.name === name.value.trim() && a.type === accountType.value
    );
    emit("created", created?.id || "");
    emit("close");
  } catch (e) {
    error.value = "创建失败，请重试";
    console.error("Create account failed:", e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface pb-8 pt-4 shadow-xl max-h-[85vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between px-4">
          <h2 class="text-lg font-semibold text-text">新建账户</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="flex-1 overflow-auto px-4">
          <AccountFormFields
            v-model:name="name"
            v-model:category-tab="categoryTab"
            v-model:account-type="accountType"
            v-model:initial-balance="initialBalance"
            v-model:credit-limit="creditLimit"
            v-model:repayment-day="repaymentDay"
            v-model:color="color"
          />

          <p v-if="error" class="mb-3 text-sm text-expense">{{ error }}</p>
        </div>

        <div class="px-4">
          <button
            class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white disabled:opacity-50"
          :disabled="!name.trim() || saving"
          @click="handleSave"
        >
          {{ saving ? '创建中...' : '创建账户' }}
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
