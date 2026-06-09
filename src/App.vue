<script setup lang="ts">
import { useRoute } from "vue-router";
import { Home, List, Wallet, Settings } from "lucide-vue-next";
import { computed } from "vue";

const route = useRoute();

const tabs = [
  { path: "/", label: "记账", icon: Home },
  { path: "/transactions", label: "流水", icon: List },
  { path: "/accounts", label: "账户", icon: Wallet },
  { path: "/settings", label: "设置", icon: Settings },
];

function isActive(tabPath: string): boolean {
  if (tabPath === "/") return route.path === "/" || route.path.startsWith("/record");
  return route.path.startsWith(tabPath);
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <div class="flex-1 overflow-auto">
      <RouterView />
    </div>

    <nav class="flex shrink-0 border-t border-gray-200 bg-surface pb-[env(safe-area-inset-bottom)]">
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
