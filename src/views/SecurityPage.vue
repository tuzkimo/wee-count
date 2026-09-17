<!-- src/views/SecurityPage.vue -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import SetLockDialog from "@/components/lock/SetLockDialog.vue";
import { useLockStore } from "@/stores/lock";
import { usePrivacyStore } from "@/stores/privacy";
import { AUTO_LOCK_OPTIONS } from "@/utils/autoLock";
import { applyScreenshotProtection } from "@/services/screenshotProtection";

const router = useRouter();
const lock = useLockStore();
const privacy = usePrivacyStore();

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

/**
 * 本页**不**在这里重新读盘（R71）。
 *
 * store 已在 `main.ts` 的启动门禁里 `load()` 过一次，这里再读一次不是「刷新」而是
 * 一次**覆盖**：`readAppLock` 的契约是任何读失败都 fail-open 返回 `null`
 * （冷启动语境下的刻意裁决，R26），于是 `load()` → `applyConfig(null)` 会把本会话里
 * 已经生效的锁**静默降级**成「未配置 + 默认值」——`lock()` 因 `isLockConfigured=false`
 * 直接空转、总开关显示关闭、没有任何提示。
 *
 * 同一条理由对隐私设置也成立：`readScreenshotProtection` 在任何读不到的情况下都回落
 * 从严默认 `true`，本页再读一次就会拿这个默认值把用户特意关掉的系统级截屏防护重新打开。
 * 所以本页只认会话内的真实状态，系统层重放照旧。
 *
 * `replayScreenshotProtection` 自己吞掉失败（见其文档），这里不必也不该 await 它的
 * rejection：`void` 掉即可，不存在未处理的 rejection。
 */
onMounted(() => {
  void replayScreenshotProtection();
});

/**
 * 把 store 当前的截屏防护值重放到系统层（与 `main.ts` 启动时同一个动作）。
 *
 * 配置以**落盘**为真相源，系统层不会自己跟上：用户切换时系统调用失败（R69 会如实提示），
 * 或本次会话里系统层被别的东西改过，都可能留下「配置说开启、系统其实关着」的缝。
 * 冷启动时 `main.ts` 会重放一次纠正它，但那要等用户重启应用；进本页就顺手对齐一次。
 *
 * 重放是幂等的：同一个值重复下发没有副作用，所以 `main.ts` 做过一次也不冲突。
 *
 * 失败只留警告、不弹页面提示：这条路径不是用户动作触发的（开页面时的重放），
 * 在界面上凭空冒一条红色错误没有对应用户动作；真正由用户切换而失败的那条路径
 * （`toggleScreenshot`）会如实报错，不靠这里兜。
 */
async function replayScreenshotProtection(): Promise<void> {
  try {
    await applyScreenshotProtection(privacy.screenshotProtection);
  } catch (cause) {
    console.warn("截屏防护重放失败", cause);
  }
}

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
 *
 * 关锁**不再牵动截屏防护**：那个设置有自己的键（`stores/privacy.ts`），
 * 关掉应用锁不会把它复位成开。此前那步「按复位后的新值重放系统层」随之取消 ——
 * 值没变，就没有要重放的新值。
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

/**
 * 关闭设置锁对话框（点「取消」、或落盘失败后放弃）。R66。
 *
 * 总开关是**受控** checkbox（`:checked` + `@change`，不是 `v-model`），而 Vue 只在
 * prop 值变化时回写 DOM：用户点开关那一刻浏览器已经把它原生翻成 `true`，而 store 里
 * `isLockConfigured` 仍是 `false`、prop 也就**没有变化**，Vue 不会去纠正这个 DOM。
 * 于是「打开对话框 → 点取消」之后总开关会停在「已开启」，而锁其实没配置：
 * 三段配置全不渲染、也没有任何提示 —— 正是 R34 认定不可接受的假确认。
 *
 * 所以关闭路径必须显式同步一次。放在这里（而不是只在 `onToggleLock(true)` 里）是因为
 * 对话框的任何退出方式都会经过它：**包括 `setLock` 落盘失败之后再取消**——
 * 那条路径上 store 依然是未配置态，DOM 同样停在勾选态。
 */
async function onDialogClose(): Promise<void> {
  dialogOpen.value = false;
  await nextTick();
  syncCheckbox(lockToggleEl.value, lock.isLockConfigured);
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
 *
 * 本开关**不要求已配置应用锁**：它写的是自己的键，未配锁时同样落盘。
 */
async function toggleScreenshot(enabled: boolean): Promise<void> {
  saveError.value = "";
  savingScreenshot.value = true;
  try {
    await privacy.setScreenshotProtection(enabled);
  } catch {
    saveError.value = "设置保存失败，请重试";
    syncCheckbox(screenshotToggleEl.value, privacy.screenshotProtection);
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

      <!--
        隐私区：**恒渲染**，不受「是否已配置应用锁」约束。
        截屏防护和应用锁本来就是两件事（一个拦系统截屏，一个做 UI 门禁），
        它写在自己的键里，未配锁时同样可读可写。此前它挂在 AppLockConfig 里，
        而那份结构的 hash 必填、`updateSettings` 无 hash 时静默 return ——
        于是开关只能跟着藏起来（那是当时唯一不说谎的做法），
        而默认值又是开启，用户想关就必须先建一把应用锁。
      -->
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
              :checked="privacy.screenshotProtection"
              :disabled="savingScreenshot"
              @change="toggleScreenshot(($event.target as HTMLInputElement).checked)"
            />
          </label>
        </div>
        <p class="px-4 py-2 text-xs text-text-secondary">
          与「应用锁」无关：不开应用锁也能单独开关。
        </p>
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
      @close="onDialogClose"
    />
  </div>
</template>
