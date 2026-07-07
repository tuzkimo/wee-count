<!-- src/views/CreateTeamPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiFetch } from "@/services/api";
import { performSync } from "@/services/sync";
import { useLedgerStore } from "@/stores/ledger";
import type { Ledger } from "@/types";

const router = useRouter();
const ledgerStore = useLedgerStore();
const name = ref("");
const error = ref("");
const loading = ref(false);
const createdCode = ref("");
const copied = ref(false);

interface CreateTeamData {
  team: { id: string; name: string };
  shared_ledger: Ledger;
}

async function handleCreate(): Promise<void> {
  error.value = "";
  if (!name.value.trim()) {
    error.value = "请输入团队名称";
    return;
  }
  loading.value = true;
  const res = await apiFetch<CreateTeamData>("/teams", {
    method: "POST",
    body: JSON.stringify({ name: name.value.trim() }),
  });
  loading.value = false;

  if (!res.ok) {
    error.value = res.error || "创建失败";
    return;
  }

  // Generate invite code
  const teamId = res.data!.team.id;
  const inviteRes = await apiFetch<{ invite_code: string }>(
    `/teams/${teamId}/invite`,
    { method: "POST" },
  );

  if (!inviteRes.ok) {
    error.value = inviteRes.error || "生成邀请码失败";
    return;
  }

  if (res.data?.shared_ledger) {
    await ledgerStore.addLedger(res.data.shared_ledger);
  }
  await performSync();
  // performSync 拉回远程 ledgers 后 store 可能把 currentLedgerId 重置回 rows[0]，
  // 这里显式切回新团队账本，确保用户落地在新建账本
  if (res.data?.shared_ledger) {
    ledgerStore.setCurrentLedger(res.data.shared_ledger.id);
  }
  createdCode.value = inviteRes.data!.invite_code;
}

async function handleCopy(): Promise<void> {
  await navigator.clipboard.writeText(createdCode.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.replace('/me')">返回</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">
        {{ createdCode ? "团队已创建" : "创建团队" }}
      </h1>
      <div class="w-10" />
    </div>

    <!-- 创建成功，展示邀请码 -->
    <div v-if="createdCode" class="flex flex-col items-center gap-6 p-6">
      <div class="mt-8 text-center">
        <p class="text-sm text-text-secondary">将邀请码发送给团队成员</p>
        <p class="mt-2 text-4xl font-bold tracking-[0.3em] text-primary">
          {{ createdCode }}
        </p>
        <p class="mt-2 text-xs text-text-secondary">邀请码 24 小时内有效</p>
      </div>

      <button
        class="w-full rounded-lg py-3 text-white font-medium transition-colors"
        :class="copied ? 'bg-green-500' : 'bg-primary'"
        @click="handleCopy"
      >
        {{ copied ? '已复制 ✓' : '复制邀请码' }}
      </button>
      <button
        class="w-full rounded-lg border border-gray-200 bg-surface py-3 text-text font-medium"
        @click="router.replace('/me')"
      >
        完成
      </button>
    </div>

    <!-- 创建表单 -->
    <form v-else class="flex flex-col gap-4 p-6" @submit.prevent="handleCreate">
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
