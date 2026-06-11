<script setup lang="ts">
import { ArrowLeft } from "lucide-vue-next";

defineProps<{
  title: string;
  showBack?: boolean;
}>();

defineEmits<{
  back: [];
}>();
</script>

<template>
  <header
    class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2"
  >
    <button
      v-if="showBack"
      class="mr-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
      @click="$emit('back')"
    >
      <ArrowLeft :size="20" class="text-text" />
    </button>
    <slot name="title">
      <h1 class="flex-1 text-lg font-semibold text-text">{{ title }}</h1>
    </slot>
    <slot name="action" />
  </header>
</template>
