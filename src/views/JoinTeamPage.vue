<!-- src/views/JoinTeamPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiFetch } from "@/services/api";
import { performSync } from "@/services/sync";

const router = useRouter();
const inviteCode = ref("");
const error = ref("");
const loading = ref(false);

async function handleJoin(): Promise<void> {
  error.value = "";
  if (!inviteCode.value.trim()) {
    error.value = "请输入邀请码";
    return;
  }
  if (!/^\d{6}$/.test(inviteCode.value.trim())) {
    error.value = "邀请码为 6 位数字";
    return;
  }
  loading.value = true;
  const res = await apiFetch("/teams/join", {
    method: "POST",
    body: JSON.stringify({ invite_code: inviteCode.value.trim() }),
  });
  loading.value = false;

  if (!res.ok) {
    error.value = res.error || "加入失败";
    return;
  }

  await performSync();
  router.replace("/me");
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">加入团队</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleJoin">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">邀请码</label>
        <input
          v-model="inviteCode"
          type="text"
          inputmode="numeric"
          maxlength="6"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-center text-lg tracking-[0.5em] text-text"
          placeholder="000000"
        />
        <p class="mt-1 text-xs text-text-secondary">请输入团队管理员分享的 6 位邀请码</p>
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "加入中..." : "加入团队" }}
      </button>
    </form>
  </div>
</template>
