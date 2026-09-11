<!-- src/components/RestoreConfirmDialog.vue -->
<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6" @click.self="$emit('cancel')">
    <div class="w-full max-w-sm rounded-xl bg-white p-5">
      <h3 class="text-base font-semibold text-text">确认恢复</h3>
      <div class="mt-3 space-y-1 text-sm text-text">
        <p>账户：<span class="font-medium">{{ summary.nickname }}</span>（{{ summary.username || "无用户名" }}）</p>
        <p>
          恢复为新账户，登录名：<span class="font-semibold">{{ summary.loginUsername }}</span>
          <span v-if="summary.usernameAdjusted" class="text-orange-600">（已自动加后缀，登录时请使用它）</span>
        </p>
        <p>导出时间：{{ exportedAtText }}</p>
        <p>交易 {{ summary.transactions }} 笔 · 账户 {{ summary.accounts }} 个 · 分类 {{ summary.categories }} 个</p>
      </div>
      <p class="mt-3 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-600">
        恢复将新建一个账户，不影响现有数据；新账户的登录密码与备份中的原账户相同。
      </p>
      <div class="mt-4 flex gap-3">
        <button class="flex-1 rounded-lg border border-gray-200 py-2 text-sm text-text-secondary" @click="$emit('cancel')">
          取消
        </button>
        <button class="flex-1 rounded-lg bg-primary py-2 text-sm text-white" @click="$emit('confirm')">
          开始恢复
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

export interface RestoreSummary {
  nickname: string;
  username: string | null;
  /** 最终登录名（冲突时已加后缀），弹窗前解析并在此展示 */
  loginUsername: string;
  /** 登录名是否因冲突被加了后缀 */
  usernameAdjusted: boolean;
  exportedAt: string;
  transactions: number;
  accounts: number;
  categories: number;
}

const props = defineProps<{ summary: RestoreSummary }>();
defineEmits<{ confirm: []; cancel: [] }>();

const exportedAtText = computed(() => {
  const d = new Date(props.summary.exportedAt);
  return Number.isNaN(d.getTime()) ? props.summary.exportedAt : d.toLocaleString();
});
</script>
