<!-- src/components/lock/AppLockPrompt.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { ShieldCheck } from "lucide-vue-next";
import SetLockDialog from "@/components/lock/SetLockDialog.vue";
import { useOnboardingStore } from "@/stores/onboarding";

/**
 * 「要不要开应用锁」的询问对话框，**全局单例**（挂在 `App.vue`）。
 *
 * 三个入口（本地创建、本地登录、在线登录/注册）都只是 `await promptAppLockIfNeeded()`，
 * UI 只有这一份。它自己不做任何判断 —— 该不该问由 store 决定。
 *
 * 形式是两层：先问要不要（本组件），选「设置应用锁」才进入 `SetLockDialog`（复用现成组件，
 * 不另写一套输密码界面）。三种“结束”都走同一个出口：
 * - 暂不开启；
 * - 设置成功（`saved`）；
 * - 进入设置后又点了取消（`close`）。
 *
 * 取消也算“问过了”，不再回头问第二遍：用户已经看见过这个功能在哪、也被给了机会，
 * 再弹一次就是纠缠。此后要开锁，`我的 → 安全` 里随时可以。
 */
const onboarding = useOnboardingStore();
/** SetLockDialog 是否打开（只有用户点了「设置应用锁」才为真）。 */
const settingLock = ref(false);

function accept(): void {
  settingLock.value = true;
}

async function decline(): Promise<void> {
  await onboarding.finishAppLockPrompt();
}

/** 锁已落盘（`SetLockDialog` 只在成功后才发这个信号）。 */
async function onLockSaved(): Promise<void> {
  settingLock.value = false;
  await onboarding.finishAppLockPrompt();
}

async function onLockDialogClose(): Promise<void> {
  settingLock.value = false;
  await onboarding.finishAppLockPrompt();
}
</script>

<template>
  <!--
    z-40：`SetLockDialog` 是 z-50 且全屏不透明，所以进入设置之后它会盖在询问面板之上，
    不必给两者排 DOM 顺序。反过来把这里也写成 z-50，就会变成两层同层级、靠 DOM 顺序决胜负。
  -->
  <div
    v-if="onboarding.promptVisible"
    data-test="app-lock-prompt"
    role="dialog"
    aria-modal="true"
    aria-label="开启应用锁"
    class="fixed inset-0 z-40 flex flex-col items-center justify-center gap-5 bg-bg px-6 py-6 text-center"
  >
    <ShieldCheck :size="40" class="text-primary" />
    <h2 class="text-lg font-semibold text-text">开启应用锁？</h2>
    <p class="max-w-xs text-sm leading-relaxed text-text-secondary">
      开启后每次冷启动都需要输入密码或图案才能进入，避免别人拿到手机直接翻看账目。
      可以随时在「我的 → 安全」里修改或关闭。
    </p>

    <div class="flex w-full max-w-xs flex-col gap-3">
      <button
        type="button"
        data-test="app-lock-prompt-accept"
        class="w-full rounded-xl bg-primary py-3 font-medium text-white"
        @click="accept"
      >
        设置应用锁
      </button>
      <button
        type="button"
        data-test="app-lock-prompt-decline"
        class="w-full rounded-xl border border-gray-200 py-3 text-text-secondary"
        @click="decline"
      >
        暂不开启
      </button>
    </div>
  </div>

  <SetLockDialog
    :open="settingLock"
    mode="set"
    @saved="onLockSaved"
    @close="onLockDialogClose"
  />
</template>
