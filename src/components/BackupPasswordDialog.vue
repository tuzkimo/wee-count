<!-- src/components/BackupPasswordDialog.vue -->
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6" @click.self="$emit('cancel')">
    <div class="w-full max-w-sm rounded-xl bg-white p-5">
      <h3 class="text-base font-semibold text-text">设置备份密码</h3>
      <p class="mt-1 text-xs text-text-secondary">密码用于加密备份文件。忘记备份密码将无法恢复备份。</p>
      <input
        v-model="p1"
        type="password"
        placeholder="至少 8 位"
        class="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
      <input
        v-model="p2"
        type="password"
        placeholder="再输入一次"
        class="mt-2 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
      />
      <p v-if="error" class="mt-2 text-xs text-red-500">{{ error }}</p>
      <div class="mt-4 flex gap-3">
        <button class="flex-1 rounded-lg border border-gray-200 py-2 text-sm text-text-secondary" @click="$emit('cancel')">
          取消
        </button>
        <button class="flex-1 rounded-lg bg-primary py-2 text-sm text-white" @click="confirm">
          确认导出
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{ confirm: [password: string]; cancel: [] }>();
const p1 = ref("");
const p2 = ref("");
const error = ref("");

function confirm(): void {
  if (p1.value.length < 8) {
    error.value = "密码至少 8 位";
    return;
  }
  if (p1.value !== p2.value) {
    error.value = "两次输入不一致";
    return;
  }
  emit("confirm", p1.value);
}
</script>
