<!-- src/views/MePage.vue -->
<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useLedgerStore } from "@/stores/ledger";
import { performSync, getLastSyncedAt } from "@/services/sync";
import { ChevronRight, LogOut, Plus, UserPlus } from "lucide-vue-next";

const router = useRouter();
const auth = useAuthStore();
const ledger = useLedgerStore();

onMounted(async () => {
  await auth.init();
  await ledger.init();
});

async function handleSync(): Promise<void> {
  auth.isSyncing = true;
  await performSync();
  auth.isSyncing = false;
}

function handleLogout(): void {
  auth.logout();
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <h1 class="flex-1 text-lg font-semibold text-text">我的</h1>
    </div>

    <!-- Not logged in -->
    <div v-if="!auth.isAuthenticated" class="flex flex-1 flex-col items-center justify-center gap-4 p-6">
      <p class="text-5xl">👤</p>
      <p class="text-text-secondary">登录后可同步数据到云端</p>
      <div class="flex gap-3">
        <button
          class="rounded-lg bg-primary px-6 py-2.5 text-white font-medium"
          @click="router.push('/login')"
        >
          登录
        </button>
        <button
          class="rounded-lg border border-primary px-6 py-2.5 text-primary font-medium"
          @click="router.push('/register')"
        >
          注册
        </button>
      </div>
    </div>

    <!-- Logged in -->
    <div v-else class="flex flex-1 flex-col">
      <!-- User info -->
      <div class="flex items-center gap-3 bg-surface px-4 py-4">
        <div class="flex h-12 w-12 items-center justify-center rounded-full bg-primary text-lg text-white">
          {{ auth.user?.nickname?.charAt(0) || "?" }}
        </div>
        <div class="flex-1">
          <p class="font-medium text-text">{{ auth.user?.nickname }}</p>
          <p class="text-sm text-text-secondary">{{ auth.user?.email }}</p>
        </div>
      </div>

      <!-- Sync status -->
      <button
        class="flex items-center gap-2 bg-surface px-4 py-3 border-b border-gray-100"
        :disabled="auth.isSyncing"
        @click="handleSync"
      >
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="auth.isSyncing ? 'bg-yellow-400' : 'bg-green-400'"
        />
        <span class="text-sm text-text-secondary">
          {{ auth.isSyncing ? "同步中..." : `已同步 ${getLastSyncedAt() ? new Date(getLastSyncedAt()!).toLocaleString() : "从未同步"}` }}
        </span>
      </button>

      <!-- My ledgers -->
      <div class="mt-3">
        <p class="px-4 py-2 text-xs font-medium text-text-secondary uppercase">我的账本</p>
        <div class="border-y border-gray-100 bg-surface">
          <div class="flex items-center px-4 py-3">
            <span class="flex-1 text-text">{{ ledger.currentLedger?.name || "个人账本" }}</span>
            <span class="text-xs text-text-secondary">个人</span>
          </div>
        </div>
      </div>

      <!-- Team management -->
      <div class="mt-3">
        <p class="px-4 py-2 text-xs font-medium text-text-secondary uppercase">团队管理</p>
        <div class="border-y border-gray-100 bg-surface">
          <button class="flex w-full items-center gap-3 px-4 py-3" @click="router.push('/teams/create')">
            <Plus :size="18" class="text-primary" />
            <span class="flex-1 text-left text-text">创建团队</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
          <button class="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3" @click="router.push('/teams/join')">
            <UserPlus :size="18" class="text-primary" />
            <span class="flex-1 text-left text-text">加入团队</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
        </div>
      </div>

      <!-- Settings -->
      <div class="mt-3">
        <div class="border-y border-gray-100 bg-surface">
          <button class="flex w-full items-center px-4 py-3" @click="router.push('/settings')">
            <span class="flex-1 text-left text-text">设置</span>
            <ChevronRight :size="16" class="text-text-secondary" />
          </button>
        </div>
      </div>

      <!-- Logout -->
      <div class="mt-6 px-4">
        <button
          class="flex w-full items-center justify-center gap-2 rounded-lg border border-red-200 py-3 text-red-500"
          @click="handleLogout"
        >
          <LogOut :size="16" />
          <span>退出登录</span>
        </button>
      </div>
    </div>
  </div>
</template>
