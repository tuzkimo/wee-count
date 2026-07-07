<script setup lang="ts">
import {
  Building2,
  CreditCard,
  Smartphone,
  Banknote,
  Wallet,
  Scale,
} from "lucide-vue-next";
import type { Account, AccountType } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { computed, ref, watch } from "vue";
import { useLedgerStore } from "@/stores/ledger";
import { useMemberInfo } from "@/composables/useMemberInfo";

const props = defineProps<{
  account: Account;
}>();

defineEmits<{
  tap: [];
}>();

const iconMap: Record<AccountType, typeof Building2> = {
  cash: Banknote,
  bank: Building2,
  digital: Smartphone,
  credit_card: CreditCard,
  huabei: Wallet,
  meituan_monthly: Wallet,
  other_loan: Scale,
};

const typeLabel = computed(() => ACCOUNT_TYPE_LABELS[props.account.type]);

const ledgerStore = useLedgerStore();
const { getMember } = useMemberInfo();
const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
const ownerName = ref("");

watch(
  () => [props.account.owner_id, isTeamLedger.value] as const,
  async ([oid, team]) => {
    if (oid && team) {
      const info = await getMember(oid);
      ownerName.value = info.displayName;
    } else {
      ownerName.value = "";
    }
  },
  { immediate: true },
);

function formatBalance(value: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-¥${formatted}` : `¥${formatted}`;
}

const balanceClass = computed(() => {
  const bal = props.account.current_balance ?? 0;
  if (props.account.category === "liability" && bal < 0) {
    return "text-expense";
  }
  return "text-text";
});
</script>

<template>
  <div
    class="flex cursor-pointer items-center gap-3 rounded-xl bg-surface p-4 shadow-sm transition-shadow hover:shadow-md"
    :style="{ borderLeft: `4px solid ${account.color}` }"
    @click="$emit('tap')"
  >
    <div
      class="flex h-10 w-10 items-center justify-center rounded-full"
      :style="{ backgroundColor: `${account.color}20` }"
    >
      <component :is="iconMap[account.type]" :size="20" :style="{ color: account.color }" />
    </div>
    <div class="flex-1">
      <p class="text-sm font-medium text-text">{{ account.name }}</p>
      <p class="text-xs text-text-secondary">{{ typeLabel }}</p>
      <p v-if="isTeamLedger && ownerName" class="text-[10px] text-text-secondary">
        {{ ownerName }}
      </p>
    </div>
    <div class="text-right">
      <p class="text-base font-semibold" :class="balanceClass">
        {{ formatBalance(account.current_balance ?? 0) }}
      </p>
    </div>
  </div>
</template>
