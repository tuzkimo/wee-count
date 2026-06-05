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
    class="flex h-14 items-center border-b border-gray-200 bg-surface px-4"
  >
    <button
      v-if="showBack"
      class="mr-3 flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
      @click="$emit('back')"
    >
      <ArrowLeft :size="20" class="text-text" />
    </button>
    <h1 class="text-lg font-semibold text-text">{{ title }}</h1>
  </header>
</template>
