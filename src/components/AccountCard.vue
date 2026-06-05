<script setup lang="ts">
import {
  Building2,
  CreditCard,
  Smartphone,
  Scale,
} from "lucide-vue-next";
import type { Account, AccountType } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";
import { computed } from "vue";

const props = defineProps<{
  account: Account;
}>();

const emit = defineEmits<{
  tap: [];
  longpress: [];
}>();

const iconMap: Record<AccountType, typeof Building2> = {
  bank: Building2,
  credit_card: CreditCard,
  digital: Smartphone,
  debt: Scale,
};

const typeLabel = computed(() => ACCOUNT_TYPE_LABELS[props.account.type]);

function formatBalance(value: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return value < 0 ? `-¥${formatted}` : `¥${formatted}`;
}

// 长按检测
let pressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressed = false;

function onTouchStart() {
  longPressed = false;
  pressTimer = setTimeout(() => {
    longPressed = true;
    emit("longpress");
  }, 500);
}

function onTouchEnd() {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onClick() {
  if (longPressed) return;
  emit("tap");
}
</script>

<template>
  <div
    class="flex cursor-pointer items-center gap-3 rounded-xl bg-surface p-4 shadow-sm transition-shadow hover:shadow-md"
    :style="{ borderLeft: `4px solid ${account.color}` }"
    @touchstart.passive="onTouchStart"
    @touchend="onTouchEnd"
    @touchmove="onTouchEnd"
    @click="onClick"
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
    </div>
    <div class="text-right">
      <p
        class="text-base font-semibold"
        :class="(account.current_balance ?? 0) >= 0 ? 'text-text' : 'text-expense'"
      >
        {{ formatBalance(account.current_balance ?? 0) }}
      </p>
    </div>
  </div>
</template>
