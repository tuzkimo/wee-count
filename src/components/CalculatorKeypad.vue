<script setup lang="ts">
import { Delete } from "lucide-vue-next";

defineProps<{
  expression: string;
  result: number | null;
  isValid: boolean;
}>();

const emit = defineEmits<{
  input: [key: string];
  done: [];
  saveNext: [];
}>();

const keys = [
  ["7", "8", "9", "+"],
  ["4", "5", "6", "-"],
  ["1", "2", "3", "delete"],
  [".", "0", "saveNext"],
  ["done"],
];

function onKey(key: string) {
  if (key === "done") {
    emit("done");
  } else if (key === "saveNext") {
    emit("saveNext");
  } else if (key === "delete") {
    emit("input", "delete");
  } else {
    emit("input", key);
  }
}

function keyLabel(key: string): string {
  switch (key) {
    case "done":
      return "完成";
    case "saveNext":
      return "再记一笔";
    case "delete":
      return "⌫";
    default:
      return key;
  }
}
</script>

<template>
  <div class="grid grid-cols-4 gap-0 border-t border-gray-200 bg-surface">
    <template v-for="row in keys" :key="row[0]">
      <button
        v-for="key in row"
        :key="key"
        class="flex items-center justify-center py-3 text-base font-medium transition-colors active:bg-gray-100"
        :class="{
          'text-text': key !== 'done' && key !== 'saveNext',
          'bg-primary text-white active:bg-primary-dark': key === 'done' && isValid,
          'bg-expense text-white active:bg-red-600': key === 'saveNext' && isValid,
          'bg-gray-200 text-gray-400 cursor-not-allowed': (key === 'done' || key === 'saveNext') && !isValid,
          'col-span-2': key === 'saveNext',
          'col-span-full': key === 'done',
        }"
        :disabled="(key === 'done' || key === 'saveNext') && !isValid"
        @click="onKey(key)"
      >
        <Delete v-if="key === 'delete'" :size="22" />
        <span v-else>{{ keyLabel(key) }}</span>
      </button>
    </template>
  </div>
</template>
