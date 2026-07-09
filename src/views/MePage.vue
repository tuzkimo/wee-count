<!-- src/views/MePage.vue -->
<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import { useLedgerStore } from "@/stores/ledger";
import { performSync, getLastSyncedAt } from "@/services/sync";
import { ChevronRight, LogOut, Plus, UserPlus, Users } from "lucide-vue-next";

const router = useRouter();
const auth = useAuthStore();
const ledger = useLedgerStore();

// 仅当存在至少一个团队账本时，「成员管理」入口才有意义
const hasTeamLedger = computed(() => ledger.ledgers.some((l) => l.type === "team"));

onMounted(async () => {
  await auth.init();
  await ledger.init();
});

async function handleSync(): Promise<void> {
  auth.isSyncing = true;
  try {
    await performSync();
  } finally {
    auth.isSyncing = false;
  }
}

async function handleUnbindOnline(): Promise<void> {
  await auth.unbindOnline();
}

function handleLogout(): void {
  auth.logout();
  router.replace('/login');
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
      <p class="text-text-secondary">创建本地账户或登录</p>
      <div class="flex gap-3">
        <button
          class="rounded-lg bg-primary px-6 py-2.5 text-white font-medium"
          @click="router.push('/welcome')"
        >
          创建账户
        </button>
        <button
          class="rounded-lg border border-primary px-6 py-2.5 text-primary font-medium"
          @click="router.push('/login')"
        >
          登录
        </button>
      </div>
    </div>

    <!-- Logged in -->
    <div v-else class="flex flex-1 flex-col">
      <!-- User info -->
      <div
        class="flex items-center gap-3 bg-surface px-4 py-4 cursor-pointer hover:bg-gray-50 transition-colors"
        @click="router.push('/profile')"
      >
        <div class="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full bg-primary text-lg text-white">
          <img
            v-if="auth.currentLocalUser?.avatar_url && (auth.currentLocalUser.avatar_url.startsWith('data:') || auth.currentLocalUser.avatar_url.startsWith('http') || auth.currentLocalUser.avatar_url.startsWith('/'))"
            :src="auth.currentLocalUser.avatar_url"
            class="h-full w-full object-cover"
            alt="头像"
          />
          <span v-else-if="auth.currentLocalUser?.avatar_url">{{ auth.currentLocalUser.avatar_url }}</span>
          <span v-else>{{ auth.currentLocalUser?.nickname?.charAt(0) || "?" }}</span>
        </div>
        <div class="flex-1">
          <p class="font-medium text-text">{{ auth.currentLocalUser?.nickname }}</p>
          <p class="text-sm text-text-secondary">
            {{ auth.isOnline ? '在线模式' : '本地模式' }}
          </p>
        </div>
        <ChevronRight :size="16" class="text-text-secondary" />
      </div>

      <!-- Sync binding status -->
      <div class="bg-surface px-4 py-3 border-b border-gray-100">
        <div class="flex items-center justify-between">
          <div>
            <p class="text-sm font-medium">
              <span v-if="auth.isOnline" class="text-green-500">● 已绑定在线同步</span>
              <span v-else class="text-gray-400">○ 纯本地模式</span>
            </p>
            <p v-if="auth.isOnline && auth.currentLocalUser?.api_url" class="text-xs text-gray-400 mt-1">
              {{ auth.currentLocalUser.api_url }}
            </p>
          </div>
          <button
            v-if="!auth.isOnline"
            class="px-4 py-2 text-sm rounded-lg bg-blue-500 text-white"
            @click="router.push('/bind-sync')"
          >
            配置在线同步
          </button>
        </div>
      </div>

      <!-- Sync status (online only) -->
      <button
        v-if="auth.isOnline"
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
            <span class="text-xs text-text-secondary">{{ ledger.currentLedger?.type === 'team' ? '团队' : '个人' }}</span>
          </div>
        </div>
      </div>

      <!-- Team management (online only) -->
      <div v-if="auth.isOnline" class="mt-3">
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
          <button v-if="hasTeamLedger" class="flex w-full items-center gap-3 border-t border-gray-100 px-4 py-3" @click="router.push('/teams/members')">
            <Users :size="18" class="text-primary" />
            <span class="flex-1 text-left text-text">成员管理</span>
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

      <!-- 退出在线同步 (仅在线模式) -->
      <div v-if="auth.isOnline" class="mt-6 px-4">
        <button
          class="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-3 text-text-secondary"
          @click="handleUnbindOnline"
        >
          <span>退出在线同步</span>
        </button>
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
