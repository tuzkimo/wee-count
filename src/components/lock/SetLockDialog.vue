<!-- src/components/lock/SetLockDialog.vue -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import NumberPinPad from "@/components/lock/NumberPinPad.vue";
import PatternLock from "@/components/lock/PatternLock.vue";
import { useLockStore } from "@/stores/lock";
import { PATTERN_MIN_DOTS } from "@/utils/pattern";
import type { LockType } from "@/services/lockStorage";

const props = withDefaults(defineProps<{
  open: boolean;
  /** set = 直接设新锁；change = 先验证旧锁，再设新锁 */
  mode?: "set" | "change";
}>(), { mode: "set" });

const emit = defineEmits<{
  saved: [];
  close: [];
}>();

/** 流程阶段：verify 只出现在 mode="change"（先验旧锁）。 */
type Stage = "verify" | "first" | "confirm";

/**
 * 失败计数已满时的文案。
 *
 * 本对话框的验证走的是 `lock.verifyPin` / `verifyPattern`，与解锁页**共用同一个**
 * `failedAttempts` 计数器。连错达到阈值后 `verifySecret` 对**正确**的旧口令也返回 false，
 * 此时若继续提示「密码错误」，用户会一遍遍输入正确口令、永远进不去，且完全不知道该怎么办。
 * 所以这里必须说明**真实原因**与**出路**（去锁屏页改用账户密码验证，再重设锁）。
 */
const TOO_MANY_ATTEMPTS = "尝试次数过多，请关闭对话框后在锁屏页改用账户密码，再重新设置应用锁";

const lock = useLockStore();
const lockType = ref<LockType>("pin");
const stage = ref<Stage>("first");
/** 第一遍输入（PIN 原串，或图案的 "1-2-3-4" 归一化文本）。 */
const firstEntry = ref("");
/** 传给子组件的 error：置真时键盘/画布会清空上一次输入并标红。 */
const error = ref(false);
const message = ref("");
/** 落盘进行中：期间禁止再输入、再切换类型，也禁止「取消」（见模板上的取消按钮）。 */
const busy = ref(false);
/**
 * 输入组件的重挂载计数。
 *
 * `NumberPinPad` 只在 `error` 由假变真时自清已输入位数，而本对话框要在一次输入被接受后
 * **立刻**开始下一轮（第一遍 → 确认），此时并没有错误可言。若不换 `:key`，
 * 键盘会停在「已满 6 位」的状态、拒绝后续按键，第二遍根本输不进去。
 */
const padRound = ref(0);

/** 清空输入组件的当前一轮输入。 */
function clearPad(): void {
  padRound.value++;
}

/** 切到某个阶段，并清掉上一阶段的输入痕迹。 */
function resetTo(nextStage: Stage): void {
  stage.value = nextStage;
  firstEntry.value = "";
  error.value = false;
  // 已是「计数已满」态就直接把出路摆出来，不让用户白输一遍正确口令。
  message.value = nextStage === "verify" && lock.requireAccountPassword ? TOO_MANY_ATTEMPTS : "";
  clearPad();
}

/**
 * 回到「刚打开」的状态：类型取当前锁的类型，阶段按 mode 决定。
 * 打开时与保存成功后共用这一条复位路径，避免残留上一次的输入。
 */
function resetForOpen(): void {
  lockType.value = lock.lockType;
  resetTo(props.mode === "change" ? "verify" : "first");
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) resetForOpen();
  },
  { immediate: true },
);

function fail(text: string): void {
  message.value = text;
  error.value = true;
}

/** 两遍输入用同一种归一化文本比对：PIN 用原串，图案用 "1-2-3-4"。 */
function toSecret(entry: string | readonly number[]): string {
  return typeof entry === "string" ? entry : entry.join("-");
}

/**
 * 设置失败时的提示。
 *
 * 校验类错误（弱口令、图案点数不足）由 store 直接抛给用户看，原样透出；
 * 持久化失败的错误带 `cause`（见 `lockStorage.writeAppLock`），技术细节不该甩给用户，
 * 换成一句人话——但无论哪种都**不许**说成功：锁确实没写下去。
 */
function setLockErrorMessage(e: unknown): string {
  if (e instanceof Error && e.message !== "" && !("cause" in e)) return e.message;
  return "设置失败，锁未保存，请重试";
}

async function accept(entry: string | readonly number[]): Promise<void> {
  if (busy.value) return;
  error.value = false;
  message.value = "";
  const secret = toSecret(entry);

  if (stage.value === "verify") {
    // 只验旧锁、**不放行**（R72）：`verifyPin`/`verifyPattern` 成功后不再动 `isLocked`。
    // 本对话框的宿主在守卫之后（`SecurityPage`），这里放行就等于「验旧锁即解锁」；
    // 真正的放行只发生在解锁页 `leave()`，且必须在设好新锁之后。
    const ok = typeof entry === "string"
      ? await lock.verifyPin(entry)
      : await lock.verifyPattern(entry);
    if (!ok) {
      // 计数已满时正确口令同样被拒：如实说明出路，而不是循环「密码错误」。
      fail(lock.requireAccountPassword ? TOO_MANY_ATTEMPTS : "密码错误");
      return;
    }
    resetTo("first");
    return;
  }

  if (stage.value === "first") {
    firstEntry.value = secret;
    stage.value = "confirm";
    // 第一遍已记账，这里只清输入组件，不能走 resetTo（那会把 firstEntry 一起清掉）。
    clearPad();
    return;
  }

  if (secret !== firstEntry.value) {
    resetTo("first");
    fail("两次输入不一致，请重新设置");
    return;
  }

  busy.value = true;
  try {
    await lock.setLock(lockType.value, entry);
  } catch (e) {
    // 写入失败必须明确报错并回到第一遍：这里若显示「设置成功」就是对用户撒谎
    // （锁其实没落盘，下次启动就没了）。
    resetTo("first");
    fail(setLockErrorMessage(e));
    return;
  } finally {
    busy.value = false;
  }

  // 成功信号只能在 await 之后发出：reject 的路径走不到这里。
  resetForOpen();
  emit("saved");
}

function onInvalidPattern(): void {
  fail(`图案至少需要连接 ${PATTERN_MIN_DOTS} 个点`);
}

/** 切换锁类型：验证阶段锁的类型是既有事实，不允许改。 */
function switchType(next: LockType): void {
  if (stage.value === "verify" || busy.value || next === lockType.value) return;
  lockType.value = next;
  resetTo("first");
}

const title = computed(() => {
  if (stage.value === "verify") return "验证当前应用锁";
  if (stage.value === "confirm") return "再次输入以确认";
  return props.mode === "change" ? "设置新应用锁" : "设置应用锁";
});
</script>

<template>
  <div
    v-if="open"
    data-test="set-lock-dialog"
    role="dialog"
    aria-modal="true"
    :aria-label="title"
    class="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 overflow-y-auto bg-bg px-6 py-6"
  >
    <h2 class="text-lg font-semibold text-text">{{ title }}</h2>

    <div v-if="stage !== 'verify'" class="flex gap-2 rounded-full bg-surface p-1">
      <button
        type="button"
        data-test="lock-type-pin"
        class="rounded-full px-4 py-1.5 text-sm"
        :class="lockType === 'pin' ? 'bg-primary text-white' : 'text-text-secondary'"
        @click="switchType('pin')"
      >
        数字密码
      </button>
      <button
        type="button"
        data-test="lock-type-pattern"
        class="rounded-full px-4 py-1.5 text-sm"
        :class="lockType === 'pattern' ? 'bg-primary text-white' : 'text-text-secondary'"
        @click="switchType('pattern')"
      >
        图案
      </button>
    </div>

    <NumberPinPad
      v-if="lockType === 'pin'"
      :key="`pin-${padRound}`"
      :disabled="busy"
      :error="error"
      @submit="accept"
    />
    <PatternLock
      v-else
      :key="`pattern-${padRound}`"
      :size="280"
      :disabled="busy"
      :error="error"
      @complete="accept"
      @invalid="onInvalidPattern"
    />

    <p v-if="message" data-test="set-lock-message" class="max-w-xs text-center text-sm text-red-500">
      {{ message }}
    </p>

    <!--
      「取消」在落盘进行中（busy）必须是禁用的：写入一旦开始就撤销不了，此时放行「取消」
      只会制造一个说不通的中间态 —— 用户以为「我没改锁」，而锁其实已经落盘，消费方又可能
      已经在 saved 之后放行（用户按了取消却被放行）。窗口只有一次 bcrypt 结算的量级，
      让用户等它由 saved 或失败提示给出真实结果。
    -->
    <button
      type="button"
      data-test="set-lock-cancel"
      class="text-sm text-text-secondary underline disabled:opacity-40"
      :disabled="busy"
      @click="emit('close')"
    >
      取消
    </button>
  </div>
</template>
