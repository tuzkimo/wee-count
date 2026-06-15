<!-- src/views/CreateTeamPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiFetch } from "@/services/api";
import { performSync } from "@/services/sync";

const router = useRouter();
const name = ref("");
const error = ref("");
const loading = ref(false);

async function handleCreate(): Promise<void> {
  error.value = "";
  if (!name.value.trim()) {
    error.value = "请输入团队名称";
    return;
  }
  loading.value = true;
  const res = await apiFetch("/teams", {
    method: "POST",
    body: JSON.stringify({ name: name.value.trim() }),
  });
  loading.value = false;

  if (!res.ok) {
    error.value = res.error || "创建失败";
    return;
  }

  // Trigger sync to pull team ledger after creation
  await performSync();
  router.replace("/me");
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">创建团队</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleCreate">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">团队名称</label>
        <input
          v-model="name"
          type="text"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="例如：史密斯家庭"
        />
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "创建中..." : "创建团队" }}
      </button>
    </form>
  </div>
</template>
