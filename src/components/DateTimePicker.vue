<script setup lang="ts">
defineProps<{
  modelValue: string;
  label?: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function onInput(e: Event) {
  emit("update:modelValue", (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div>
    <label v-if="label" class="mb-1 block text-xs text-text-secondary">{{ label }}</label>
    <input
      :value="modelValue"
      type="datetime-local"
      class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      @input="onInput"
    />
  </div>
</template>
