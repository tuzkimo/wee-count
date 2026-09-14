<!-- src/views/SecurityPage.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import SetLockDialog from "@/components/lock/SetLockDialog.vue";
import { useLockStore } from "@/stores/lock";
import { AUTO_LOCK_OPTIONS } from "@/utils/autoLock";
import { applyScreenshotProtection } from "@/services/screenshotProtection";

const router = useRouter();
const lock = useLockStore();

const dialogOpen = ref(false);
const dialogMode = ref<"set" | "change">("set");
/** 失败提示。落盘是用户主动发起的动作，失败必须说出来，不能静默。 */
const saveError = ref("");
/** 关锁落盘进行中：期间禁用总开关，避免第二次翻转把勾选态推离真实状态。 */
const clearing = ref(false);
/** 截屏防护落盘进行中：期间禁用开关，避免连续快速切换造成状态交错。 */
const savingScreenshot = ref(false);
/** 两个受控 checkbox 的模板引用：落盘失败时用它把 DOM 勾选态拉回真相。 */
const lockToggleEl = ref<HTMLInputElement | null>(null);
const screenshotToggleEl = ref<HTMLInputElement | null>(null);

onMounted(async () => {
  // 读路径永不抛错（见 lockStorage.readAppLock），不会产生未处理的 rejection。
  await lock.load();
});

const lockTypeLabel = computed(() => (lock.lockType === "pin" ? "数字密码" : "图案"));

/**
 * 把某个 checkbox 的 DOM 勾选态重设回 store 的**真实**状态。
 *
 * 浏览器原生 checkbox 在 change 事件里就已经翻转了自身勾选态，而本页的勾选态
 * 由 store 驱动（`:checked`）。落盘失败时 store 不变、Vue 也就不会重渲染，
 * 于是 DOM 会停在用户点出来的那个「新状态」上 —— 那恰恰是 R34 要消灭的假确认
 * （界面显示已关闭，锁其实还开着）。所以失败路径必须显式把 DOM 拉回真相。
 *
 * 用模板引用而不是 `document.querySelector`：组件可能挂在脱离 document 的容器里
 * （单元测试的挂载就是这样），那时全局查询恒为 null，同步会静默失效。
 */
function syncCheckbox(el: HTMLInputElement | null, actual: boolean): void {
  if (el) el.checked = actual;
}

function onToggleLock(enabled: boolean): void {
  if (enabled) {
    // 只有未配置锁时才会走到这里，因此一定是 set 模式：
    // change 模式会先验旧锁，而 hash 为空时验旧锁恒失败，会变成无出路的死循环。
    dialogMode.value = "set";
    dialogOpen.value = true;
    return;
  }
  void clearLock();
}

/**
 * 关闭应用锁。
 *
 * **不能用 `void lock.clearLock()`**：`clearLock()` 内部经 `clearAppLock()` 落盘，
 * 失败即 reject（刻意裁决——不能让 UI 对用户动作给出假确认）。`void` 会把这条
 * rejection 吞掉，于是 store 仍是「已配置、仍生效」，界面上却看不出任何异常。
 * 这里必须 try/catch：失败时保持真实状态（锁仍开启）并给出明确提示。
 */
async function clearLock(): Promise<void> {
  saveError.value = "";
  clearing.value = true;
  // await 之前不写任何成功提示：reject 的路径要在 catch 里如实报错。
  try {
    await lock.clearLock();
  } catch {
    saveError.value = "关闭失败，应用锁仍开启，请重试";
    syncCheckbox(lockToggleEl.value, lock.isLockConfigured);
  } finally {
    clearing.value = false;
  }
}

/**
 * 打开改锁对话框。
 *
 * 只允许在**已配置锁**时调用：`mode="change"` 的第一阶段是验旧锁，而
 * `verifyPin`/`verifyPattern` 在 `hash` 为空时恒返回 false，未配置锁却以 change
 * 打开会变成无限循环「密码错误」且没有出路。防呆做在调用方（入口的 v-if 与这里的
 * 早返回），不放进 SetLockDialog —— 在对话框里兜这种误用只会把调用方的错误藏起来。
 */
function openChangeDialog(): void {
  if (!lock.isLockConfigured) return;
  dialogMode.value = "change";
  dialogOpen.value = true;
}

/** 设置锁成功后的收尾：此时才允许关闭对话框并清掉旧提示。 */
function onLockSaved(): void {
  dialogOpen.value = false;
  saveError.value = "";
}

async function chooseAutoLock(seconds: number): Promise<void> {
  saveError.value = "";
  try {
    // 成功状态由 store 在落盘之后写入；这里不做任何乐观更新。
    await lock.updateSettings({ auto_lock_seconds: seconds });
  } catch {
    // 落盘失败时内存状态未被修改，如实告知即可。
    saveError.value = "设置保存失败，请重试";
  }
}

/**
 * 切换截屏防护。
 *
 * 两处顺序都不能颠倒：
 * 1. 先落盘、后动系统开关 —— 反过来的话，写失败时用户会看到一个「已经关掉截屏防护」
 *    的界面，而配置里它还开着（R57：成功提示只能在 await 之后）。
 * 2. `await nextTick()` 再落系统开关 —— change 事件里输入的 checked 已经翻成新值，
 *    若调用方在落盘完成前导航离开，本组件会被整体卸载，未执行的后续语句就永远不执行了；
 *    等状态真正提交到 DOM 之后再做，就不会留下「界面说关了、系统还没关」的窗口。
 */
async function toggleScreenshot(enabled: boolean): Promise<void> {
  saveError.value = "";
  savingScreenshot.value = true;
  try {
    await lock.updateSettings({ screenshot_protection: enabled });
  } catch {
    saveError.value = "设置保存失败，请重试";
    syncCheckbox(screenshotToggleEl.value, lock.screenshotProtection);
    return;
  } finally {
    savingScreenshot.value = false;
  }

  await nextTick();
  try {
    await applyScreenshotProtection(enabled);
  } catch {
    // 配置已落盘、系统调用失败：如实说明，不谎称已生效。
    saveError.value = "截屏防护设置失败，请重试";
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="安全" :show-back="true" @back="router.back()" />

    <div class="flex-1 overflow-auto">
      <!-- 应用锁 -->
      <div class="mt-3">
        <p class="px-4 py-2 text-xs font-medium uppercase text-text-secondary">应用锁</p>
        <div class="border-y border-gray-100 bg-surface">
          <label class="flex items-center gap-3 px-4 py-3">
            <span class="flex-1 text-text">启用应用锁</span>
            <input
              ref="lockToggleEl"
              data-test="lock-enabled"
              type="checkbox"
              class="h-5 w-5"
              :checked="lock.isLockConfigured"
              :disabled="clearing"
              @change="onToggleLock(($event.target as HTMLInputElement).checked)"
            />
          </label>

          <template v-if="lock.isLockConfigured">
            <div class="flex items-center gap-3 border-t border-gray-100 px-4 py-3">
              <span class="flex-1 text-text">解锁方式</span>
              <span class="text-sm text-text-secondary">{{ lockTypeLabel }}</span>
            </div>
            <button
              type="button"
              data-test="change-lock"
              class="w-full border-t border-gray-100 px-4 py-3 text-left text-primary"
              @click="openChangeDialog"
            >
              修改应用锁
            </button>
          </template>
        </div>
      </div>

      <!-- 自动锁定 -->
      <div v-if="lock.isLockConfigured" class="mt-3">
        <p class="px-4 py-2 text-xs font-medium uppercase text-text-secondary">
          切到后台后自动锁定
        </p>
        <div class="border-y border-gray-100 bg-surface">
          <button
            v-for="option in AUTO_LOCK_OPTIONS"
            :key="option.seconds"
            type="button"
            :data-test="`auto-lock-${option.seconds}`"
            class="flex w-full items-center gap-3 border-b border-gray-100 px-4 py-3 last:border-b-0"
            @click="chooseAutoLock(option.seconds)"
          >
            <!-- 选项标签必须是按钮里的**第一个且唯一承载文字的**元素：
                 选中标记另起一个 span，否则选项自身的文案会与「✓」粘在一起。 -->
            <span class="flex-1 text-left text-text">{{ option.label }}</span>
            <span
              v-if="lock.autoLockSeconds === option.seconds"
              :data-test="`auto-lock-check-${option.seconds}`"
              class="text-primary"
            >
              ✓
            </span>
          </button>
        </div>
        <p class="px-4 py-2 text-xs text-text-secondary">
          冷启动始终需要解锁，不受此项影响。
        </p>
      </div>

      <!-- 隐私 -->
      <div class="mt-3">
        <p class="px-4 py-2 text-xs font-medium uppercase text-text-secondary">隐私</p>
        <div class="border-y border-gray-100 bg-surface">
          <label class="flex items-center gap-3 px-4 py-3">
            <span class="flex-1">
              <span class="block text-text">禁止截屏</span>
              <span class="block text-xs text-text-secondary">
                开启后截图全黑，最近任务列表不显示内容
              </span>
            </span>
            <input
              ref="screenshotToggleEl"
              data-test="screenshot-protection"
              type="checkbox"
              class="h-5 w-5"
              :checked="lock.screenshotProtection"
              :disabled="savingScreenshot"
              @change="toggleScreenshot(($event.target as HTMLInputElement).checked)"
            />
          </label>
        </div>
      </div>

      <!-- 失败提示必须在成功提示的位置上说真话 -->
      <p
        v-if="saveError"
        data-test="security-error"
        role="alert"
        class="px-4 pt-3 text-sm text-red-500"
      >
        {{ saveError }}
      </p>

      <!--
        必须如实描述保护边界：本锁是 UI 门禁，不做任何数据保密处理，
        数据文件本身仍是明文。文案里刻意不出现任何「保密处理完成」式的
        措辞（本页是用户可见的安全设置页，措辞不当会直接制造安全错觉）。
      -->
      <p class="px-4 py-4 text-xs leading-relaxed text-text-secondary">
        应用锁用于阻止他人直接翻看本机数据。它不改变本地数据库文件本身，
        能够读取设备存储的人仍可绕过应用锁访问数据文件。
      </p>
    </div>

    <SetLockDialog
      :open="dialogOpen"
      :mode="dialogMode"
      @saved="onLockSaved"
      @close="dialogOpen = false"
    />
  </div>
</template>
