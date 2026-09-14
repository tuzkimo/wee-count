<!-- src/views/UnlockPage.vue -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import NumberPinPad from "@/components/lock/NumberPinPad.vue";
import PatternLock from "@/components/lock/PatternLock.vue";
import SetLockDialog from "@/components/lock/SetLockDialog.vue";
import { useLockStore } from "@/stores/lock";
import { sanitizeRedirect } from "@/router/lockGuard";

const route = useRoute();
const router = useRouter();
const lock = useLockStore();

const error = ref(false);
const message = ref("");
const showAccountForm = ref(false);
const username = ref("");
const password = ref("");
const busy = ref(false);
/** 账户密码验证通过后，必须就地重设锁才算真正放行。 */
const mustResetLock = ref(false);

/** 降级态（连错达阈值）强制走账户密码；非降级态由「忘记密码？」按钮主动进入。 */
const useAccountForm = computed(() => showAccountForm.value || lock.requireAccountPassword);

/**
 * 放行。只有两条路径能走到这里：锁已验过，或账户密码验过后**又设好了新锁**。
 *
 * 回跳值必须自己过一遍 `sanitizeRedirect`：守卫只消毒**它自己产出**的回跳参数，
 * 用户可以直接深链 `/unlock?redirect=<任意值>` 把未经消毒的原文送进来。
 */
function leave(): void {
  lock.unlock();
  void router.replace(sanitizeRedirect(route.query.redirect));
}

function fail(): void {
  error.value = true;
  // 只说「这一次输入不对」。降级那一刻的说明由表单里的固定说明行承担，
  // 两处摆同一句话会让人以为错了两次。
  message.value = "密码错误";
}

async function onPin(pin: string): Promise<void> {
  error.value = false;
  message.value = "";
  if (await lock.verifyPin(pin)) leave();
  else fail();
}

async function onPattern(dots: number[]): Promise<void> {
  error.value = false;
  message.value = "";
  if (await lock.verifyPattern(dots)) leave();
  else fail();
}

/**
 * 点数不足（`invalid`）= **一次未完成的输入**，不是一次失败的验证。
 *
 * `PatternLock` 的 `pointercancel` 与 `pointerup` 走同一结算路径，系统打断
 * （下拉通知栏、手势导航）也会 emit `complete`；多点触控又没跟踪 pointerId，
 * Android 上手掌误触可能 emit 一次用户并未做出的 `invalid`。
 * 这类输入若计入 `failedAttempts`，用户会白白消耗掉 5 次尝试额度、被推进降级态，
 * 所以这里只提示重新画，**不**调 `verifyPattern`（也就不会记账）。
 */
function onInvalidPattern(): void {
  error.value = true;
  message.value = "图案至少需要连接 4 个点";
}

/** 取消重设 → 关掉对话框，人仍留在锁内（R18：`close` 必须有人接）。 */
function cancelReset(): void {
  mustResetLock.value = false;
}

async function submitAccountPassword(): Promise<void> {
  busy.value = true;
  error.value = false;
  message.value = "";
  try {
    const ok = await lock.unlockWithAccountPassword(username.value.trim(), password.value);
    if (!ok) {
      error.value = true;
      message.value = "用户名或密码错误";
      return;
    }
    // 身份已证明，但仍留在锁内——设置新锁之后才放行。
    // 若在这里直接 leave()，降级路径就成了「账户密码正确即解锁」的旁路，
    // 连错 5 次的限流形同虚设。
    password.value = "";
    mustResetLock.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col items-center justify-center gap-6 bg-bg px-6">
    <div class="text-center">
      <h1 class="text-xl font-semibold text-text">一起数钱</h1>
      <p class="mt-1 text-sm text-text-secondary">
        {{ mustResetLock ? "请设置新的应用锁" : "请输入应用锁密码" }}
      </p>
    </div>

    <!-- 降级路径：账户密码 -->
    <form
      v-if="useAccountForm && !mustResetLock"
      data-test="unlock-account-form"
      class="w-full max-w-xs space-y-3"
      @submit.prevent="submitAccountPassword"
    >
      <p v-if="lock.requireAccountPassword" class="text-center text-sm text-red-500">
        错误次数过多，请用账户密码解锁
      </p>
      <input
        v-model="username"
        data-test="unlock-account-username"
        type="text"
        placeholder="用户名"
        class="w-full rounded-xl border border-gray-300 px-4 py-3"
      />
      <input
        v-model="password"
        data-test="unlock-account-password"
        type="password"
        placeholder="密码"
        class="w-full rounded-xl border border-gray-300 px-4 py-3"
      />
      <button
        type="submit"
        data-test="unlock-account-submit"
        :disabled="busy || !username.trim() || !password"
        class="w-full rounded-xl bg-primary py-3 font-medium text-white disabled:opacity-50"
      >
        解锁
      </button>
    </form>

    <!-- 正常路径 -->
    <template v-else-if="!mustResetLock">
      <!-- biometricEnabled 恒为 false（本轮不做生物识别，也没有写入入口），
           这里照传只是让语义留在界面上，恒不渲染指纹按钮。 -->
      <NumberPinPad
        v-if="lock.lockType === 'pin'"
        :error="error"
        :biometric-available="lock.biometricEnabled"
        @submit="onPin"
      />
      <PatternLock
        v-else
        :size="280"
        :error="error"
        @complete="onPattern"
        @invalid="onInvalidPattern"
      />
    </template>

    <!-- 一次输入的结算提示。两条路径共用：账户密码的失败提示若被
         `!useAccountForm` 挡掉，用户点「解锁」就会毫无反馈。 -->
    <p v-if="message" data-test="unlock-message" class="text-sm text-red-500">{{ message }}</p>

    <button
      v-if="!useAccountForm && !mustResetLock"
      type="button"
      data-test="unlock-forgot"
      class="text-sm text-text-secondary underline"
      @click="showAccountForm = true"
    >
      忘记密码？
    </button>

    <!-- 账户密码验过之后就地重设新锁；@saved 才放行，@close 只关对话框 -->
    <SetLockDialog
      :open="mustResetLock"
      mode="set"
      @saved="leave"
      @close="cancelReset"
    />
  </div>
</template>
