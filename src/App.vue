<script setup lang="ts">
import { computed, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Home, BarChart3, Wallet, User, Sparkles } from "lucide-vue-next";
import { useAutoLock } from "@/composables/useAutoLock";
import { useLockStore } from "@/stores/lock";
import { useAuthStore } from "@/stores/auth";
import { useAiChatStore } from "@/stores/aiChat";
import { sanitizeRedirect } from "@/router/lockGuard";
import AppLockPrompt from "@/components/lock/AppLockPrompt.vue";

const route = useRoute();
const router = useRouter();
const lock = useLockStore();
const auth = useAuthStore();
const ai = useAiChatStore();

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

/**
 * 探一次 AI 能力（M2 契约第 4 条：**不要轮询** —— `/ai/status` 与 `/ai/chat` 共用一个
 * 每分钟桶）。这次探测**不再挂在 `onMounted`**：地址（`setBaseUrl`）由 auth 的异步初始化
 * 写入，挂载那一刻必然还没配 ⇒ `apiFetch` 里的 `getBaseUrl()` 直接抛、被 transport 吞成
 * `failure:network`、`host` 恒为 null，而三种观测手段同时隐身（真机事故的完整链路，C6）。
 *
 * 现在只在**地址就绪后**探，且一个就绪窗口内只探一次：`watch` 只在 `false → true` 那次
 * 触发（`immediate` 覆盖"挂载前地址就已配好"的冷启动），不轮询、不重入。用户显式点
 * 「重新检测」（隐私区）走 `aiChat.refreshStatus()`，不受这里约束（C6.3）。
 *
 * "地址就绪"这道判据**只在这一处**（触发点）：`refreshStatus()` 自己不带守卫，否则所有直接
 * 调它的既有用例（fixture 从不配 base URL）会一起红 —— 那些用例钉的是"探测结果怎么写进 store"。
 *
 * 能力探测与入口显隐已经**解耦**：tab 是否出现只看本地意愿层（`entryEnabled`），
 * 探测结果只影响 AI 页内文案与"发送开关"是否可用（G1/C1）。
 */
watch(
  () => auth.baseUrlReady,
  (ready) => {
    if (!ready) return;
    void ai.refreshStatus();
  },
  { immediate: true },
);

/**
 * tab 列表。`/ai` 只在**用户自己开启过 AI 助手**时才出现（G1：入口的唯一判据是本地意愿层，
 * 不是探测结果）。服务端没配 AI 时不再"整个 tab 不显示"—— 那正是把"客户端不掌握的状态"
 * 当成渲染判据的老毛病；已知没配只影响 AI 页内的说明与发送开关。
 * 位置在「报表」与「账户」之间。
 */
const TABS = [
  { path: "/", label: "首页", icon: Home },
  { path: "/reports", label: "报表", icon: BarChart3 },
  { path: "/ai", label: "AI", icon: Sparkles },
  { path: "/accounts", label: "账户", icon: Wallet },
  { path: "/me", label: "我的", icon: User },
];

const tabs = computed(() => TABS.filter((tab) => tab.path !== "/ai" || ai.entryEnabled));

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

    <!--
      新用户引导（问一次要不要开应用锁）挂在这里，而不是散在三个登录/注册页里：
      它是全局单例 UI，由 `stores/onboarding.ts` 决定该不该出现。
      放在 tab 栏之后，保证两层对话框都盖在页面与 tab 栏之上。
    -->
    <AppLockPrompt />
  </div>
</template>
