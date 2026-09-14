<!-- src/components/AmountMaskToggle.vue -->
<script setup lang="ts">
import { Eye, EyeOff } from "lucide-vue-next";
import { useAmountMask } from "@/composables/useAmountMask";

const { amountsHidden, toggle } = useAmountMask();
</script>

<template>
  <button
    type="button"
    data-test="amount-mask-toggle"
    class="flex h-7 w-7 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-gray-100"
    :aria-label="amountsHidden ? '显示金额' : '隐藏金额'"
    @click="toggle"
  >
    <EyeOff v-if="amountsHidden" :size="16" />
    <Eye v-else :size="16" />
  </button>
</template>
