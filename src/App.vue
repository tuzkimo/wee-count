<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Home, BarChart3, Wallet, User } from "lucide-vue-next";
import { useAutoLock } from "@/composables/useAutoLock";
import { useLockStore } from "@/stores/lock";
import { sanitizeRedirect } from "@/router/lockGuard";

const route = useRoute();
const router = useRouter();
const lock = useLockStore();

// 前后台切换自动锁定：挂在根组件上，随应用生命周期只注册一次。
useAutoLock();

/**
 * 锁定态必须**立刻**把人赶到解锁页（R70）。
 *
 * 路由守卫只在**导航发生时**跑，而自动上锁不是一次导航：`lock()` 之后当前页面
 * 既不卸载、也不重渲染、更不跳转，屏幕上已经画出来的真实数字原样留着，页面也仍然
 * 可交互（连眼睛图标都能把 `lock()` 刚隐藏的金额再点开）——用户要等到下一次点 tab
 * 才会被守卫弹到 `/unlock`。「锁定态下业务页面根本不渲染」这句安全主张，在自动锁这
 * 条路径上只能由这里兜住。
 *
 * 三点是刻意的：
 * - 回跳值自己过一遍 `sanitizeRedirect`，与 `lockGuard` 产出回跳值时是同一套规则；
 * - 取 `route.fullPath` 而不是 `route.path`，解锁后回到用户原来看的页面（含 query）；
 * - 已经在 `/unlock` 上时不再跳：它是锁定态唯一的放行页，再 `replace` 一次只会把
 *   redirect 覆盖成 `/`（`sanitizeRedirect` 会拦掉 `/unlock` 自身），等于丢掉用户
 *   原本的去处。
 */
watch(
  () => lock.isLocked,
  (locked) => {
    if (!locked) return;
    if (route.path === "/unlock") return;
    void router.replace({ path: "/unlock", query: { redirect: sanitizeRedirect(route.fullPath) } });
  },
);

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
