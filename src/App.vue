<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import { Home, BarChart3, Wallet, User } from "lucide-vue-next";

const route = useRoute();

const tabs = [
  { path: "/", label: "首页", icon: Home },
  { path: "/reports", label: "报表", icon: BarChart3 },
  { path: "/accounts", label: "账户", icon: Wallet },
  { path: "/me", label: "我的", icon: User },
];

function isActive(tabPath: string): boolean {
  if (tabPath === "/") {
    return route.path === "/";
  }
  if (tabPath === "/accounts") {
    return route.path.startsWith("/accounts");
  }
  return route.path === tabPath;
}

const showTab = computed(() => !route.meta.hideTab);
</script>

<template>
  <div class="flex h-dvh flex-col bg-bg">
    <!-- 系统状态栏安全区占位 -->
    <div class="shrink-0 bg-surface" :style="{ height: `max(env(safe-area-inset-top), 1.5rem)` }" />
    <div class="flex-1 min-h-0">
      <RouterView />
    </div>

    <nav
      v-if="showTab"
      class="flex shrink-0 border-t border-gray-200 bg-surface pb-[env(safe-area-inset-bottom)]"
    >
      <router-link
        v-for="tab in tabs"
        :key="tab.path"
        :to="tab.path"
        class="flex flex-1 flex-col items-center gap-0.5 py-2 text-xs transition-colors"
        :class="isActive(tab.path) ? 'text-primary' : 'text-text-secondary'"
      >
        <component :is="tab.icon" :size="20" />
        <span>{{ tab.label }}</span>
      </router-link>
    </nav>
  </div>
</template>
