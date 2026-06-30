<script setup lang="ts">
import { ref } from "vue";
import { X, Building2, CreditCard, Smartphone, Banknote, Wallet, Scale } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import { useLedgerStore } from "@/stores/ledger";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY, ACCOUNT_TYPE_LABELS } from "@/types";

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
const color = ref("#3b82f6");
const saving = ref(false);
const error = ref("");

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

function switchCategory(tab: "asset" | "liability") {
  categoryTab.value = tab;
  accountType.value = tab === "asset" ? "bank" : "credit_card";
}

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
      color: color.value,
    });
    // 找到刚创建的账户
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
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[85vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">新建账户</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="flex-1 overflow-auto">
          <!-- 名称 -->
          <label class="mb-1 block text-sm font-medium text-text">账户名称</label>
          <input
            v-model="name"
            type="text"
            placeholder="如：招商储蓄卡"
            class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />

          <!-- 账户类型 Tab -->
          <div class="mb-3 flex rounded-lg bg-gray-100 p-0.5">
            <button
              class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
              :class="categoryTab === 'asset' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
              @click="switchCategory('asset')"
            >资产账户</button>
            <button
              class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
              :class="categoryTab === 'liability' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
              @click="switchCategory('liability')"
            >负债账户</button>
          </div>

          <!-- 资产类型 -->
          <div v-if="categoryTab === 'asset'" class="mb-4 grid grid-cols-3 gap-2">
            <button
              v-for="item in ASSET_TYPES"
              :key="item.type"
              class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
              :class="accountType === item.type ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
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
              :class="accountType === item.type ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
              @click="accountType = item.type"
            >
              <component :is="item.icon" :size="18" />
              <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
            </button>
          </div>

          <!-- 初始余额 -->
          <label class="mb-1 block text-sm font-medium text-text">初始余额</label>
          <input
            v-model="initialBalance"
            type="number"
            step="0.01"
            placeholder="0.00"
            class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />

          <!-- 颜色 -->
          <label class="mb-2 block text-sm font-medium text-text">颜色标记</label>
          <div class="mb-4 flex gap-2">
            <button
              v-for="c in COLORS"
              :key="c"
              class="h-8 w-8 rounded-full border-2 transition-transform"
              :class="color === c ? 'scale-110 border-gray-800' : 'border-transparent'"
              :style="{ backgroundColor: c }"
              @click="color = c"
            />
          </div>

          <p v-if="error" class="mb-3 text-sm text-expense">{{ error }}</p>
        </div>

        <!-- 保存按钮 -->
        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white disabled:opacity-50"
          :disabled="!name.trim() || saving"
          @click="handleSave"
        >
          {{ saving ? '创建中...' : '创建账户' }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
