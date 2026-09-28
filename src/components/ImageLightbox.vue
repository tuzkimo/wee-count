<script setup lang="ts">
// 图片全屏查看器（AI 聊天页的两处入口：历史消息缩略图、待发附件）。
//
// 四件事，各自一条边界：
//  1. **遮罩层**：`Teleport` + `Transition name="sheet-fade"`（仓库既有基座写法，见
//     `AccountPickerSheet.vue:67`、`DateTimePicker.vue:238`；动效类在 `assets/main.css:17`）。
//     `z-[60]`：**必须高于应用锁的弹层（z-50）** —— 锁屏遮不住一层看图弹窗就是一次隐私穿透。
//  2. **手势**：pointer events 手写（不引依赖），算术全在 `imageZoom.ts`（纯函数、单独单测）。
//     捏合缩放 / 放大后单指平移 / 双击 1x↔2x，限位由 `clampOffset` 兜住。
//  3. **关闭**：背板、✕、**Android 返回键**。
//  4. **不清楚的图片**：`masked` 由调用方按 `useAmountMask` / `revealed` 判好传进来
//     （与 `MessageBubble` 同一条约定：判定不属于"一个查看器"，本组件不读 store）。
//  5. **被遮时的可见性**：`masked` 时另加一层浅色描边/底 + 居中「已模糊」徽标（模板里有说明，
//     要点是描边必须落在被 `blur` 的 `<img>` 之外）。揭示后两层一起消失。
//  6. **安全区**：顶部/底部避开系统状态栏与手势条，✕ 的热区 44×44（见下面 `TAP_SLOP` 上方那段）。
//
// ⚠️ 返回键**只能自己实现**：Tauri 的 `onBackButton` 全仓没有监听，Android WebView 里的返回键
// 就是一次浏览器历史后退（`popstate`，见 `router/__tests__/lockGuard.backNavigation.test.ts:9`）。
// 做法是打开时压入一个**哨兵条目**、关闭时把它收回来：
//  - 用户按返回键 ⇒ `popstate` ⇒ 哨兵被浏览器弹掉 ⇒ 关掉自己，**不再 back()**（否则一次按键退两层）；
//  - 点 ✕ / 背板关 ⇒ 哨兵还在栈顶 ⇒ 主动 `back()` 收掉它，**下次返回键才不会被吞**；
//  - 重复关闭 / 外部前进后退 ⇒ 靠 `sentinel` 这一位标记，收过的绝不再收（收两次就会多退一层）；
//  - 组件被卸载（切页/退出）时同样收掉。
//
// ⚠️ 图片是 base64 data URL，**直接给 `<img>`**：不碰文件系统、不用 `convertFileSrc`、
// 不指望 asset 协议（CSP 没开 `asset:`）。
//
// 不做（人类明确划掉）：下滑关闭、长按保存/分享、多图左右浏览。
import { computed, onBeforeUnmount, ref, watch } from "vue";
import {
  MIN_SCALE,
  clampOffset,
  doubleTapScale,
  pinchScale,
  pointerDistance,
  type Point,
  type Size,
} from "@/components/imageZoom";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** base64 data URL，原样喂给 `<img>` */
    src: string;
    /** 金额遮蔽（调用方判定）：true ⇒ 打码，用户不可能从这张图里读出数字 */
    masked?: boolean;
  }>(),
  { masked: false },
);

const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
const image = ref<HTMLImageElement | null>(null);

const scale = ref(MIN_SCALE);
const offset = ref<Point>({ x: 0, y: 0 });
/** 手势进行中 ⇒ 关掉 transform 过渡（否则拖动会黏在手指后面） */
const gesturing = ref(false);

const imageStyle = computed(() => ({
  transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value})`,
  transition: gesturing.value ? "none" : "transform 0.2s ease",
}));

// 安全区：系统状态栏 / 手势条压在上面的那块（实机反馈：✕ 顶到状态栏下面，被顶栏压住点不到）。
//
// 一律走 Tailwind 的 `*-[env(safe-area-inset-*)]` 任意值（仓库既有先例：`App.vue:110` 的
// `pb-[env(safe-area-inset-bottom)]`）—— 不写行内 `style`：`calc(env(...) + 1rem)` 这类值
// 在测试环境（happy-dom 的 CSS 解析器）里会被整条丢掉，钉不住。多出来的那点间距由 `mt-*` / `mb-*`
// 给（绝对定位元素的外边距照样生效）。
//
// ⚠️ 根节点的 `padding` 只推**在流内**的内容（图片）；绝对定位的层（描边、✕）的包含块是 padding box，
// `top-0` 依然是屏幕顶边 ⇒ **每一个绝对定位的元素都得自己再吃一遍安全区**。

/** 位移超过这个数就不算"点按"（双击的第二下、以及"拖完不算点背板"都靠它） */
const TAP_SLOP = 8;
/** 两次点按的间隔上限 */
const DOUBLE_TAP_MS = 300;

/** 按下的手指（pointerId ⇒ 位置） */
const pointers = new Map<number, Point>();
/** 手势开始时的框与图片尺寸（这一刻量一次就够：布局在手势期间不变） */
let frame: Size = { width: 0, height: 0 };
let base: Size = { width: 0, height: 0 };
let pinchStart: { distance: number; scale: number } | null = null;
let dragOrigin: Point | null = null;
let dragOffset: Point = { x: 0, y: 0 };
let dragMoved = false;
let lastTapAt = 0;
/** 哨兵条目还在不在（唯一的事实来源：它决定关闭时要不要 back()） */
let sentinel = false;

function sizeOf(el: HTMLElement | null): Size {
  const rect = el?.getBoundingClientRect();
  return rect === undefined ? { width: 0, height: 0 } : { width: rect.width, height: rect.height };
}

function measure(): void {
  frame = sizeOf(root.value);
  // `getBoundingClientRect()` 是**含 transform** 的 ⇒ 除掉当前倍率才是 1x 下的基准尺寸
  const s = scale.value === 0 ? 1 : scale.value;
  const rect = sizeOf(image.value);
  base = { width: rect.width / s, height: rect.height / s };
}

function resetGesture(): void {
  pointers.clear();
  pinchStart = null;
  dragOrigin = null;
  dragOffset = { x: 0, y: 0 };
  dragMoved = false;
  lastTapAt = 0;
  gesturing.value = false;
  scale.value = MIN_SCALE;
  offset.value = { x: 0, y: 0 };
}

function onPointerDown(e: PointerEvent): void {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  gesturing.value = true;
  if (pointers.size === 1) {
    measure();
    dragOrigin = { x: e.clientX, y: e.clientY };
    dragOffset = { ...offset.value };
    dragMoved = false;
    return;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = { distance: pointerDistance(a, b), scale: scale.value };
    // 双指序列一律不算"点按"（抬到最后一根手指时也不许触发双击）
    dragMoved = true;
  }
}

function onPointerMove(e: PointerEvent): void {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2 && pinchStart !== null) {
    const [a, b] = [...pointers.values()];
    scale.value = pinchScale(pinchStart.scale, pinchStart.distance, pointerDistance(a, b));
    // 倍率一变，能拖的范围也跟着变 ⇒ 立刻重新限位（不然缩回 1x 时图还偏在边上）
    offset.value = clampOffset(offset.value, scale.value, frame, base);
    return;
  }

  if (dragOrigin === null) return;
  const dx = e.clientX - dragOrigin.x;
  const dy = e.clientY - dragOrigin.y;
  if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) dragMoved = true;
  offset.value = clampOffset({ x: dragOffset.x + dx, y: dragOffset.y + dy }, scale.value, frame, base);
}

function onPointerUp(e: PointerEvent): void {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);

  // `pointercancel`（来电、系统手势把这一指抢走）不是"用户抬手"：既不算点按，也不参与双击计数
  if (e.type === "pointercancel") dragMoved = true;

  if (pointers.size === 0) {
    gesturing.value = false;
    pinchStart = null;
    dragOrigin = null;
    if (!dragMoved) registerTap();
    return;
  }

  // 捏合中抬起一指：用剩下那根重新起手拖动（否则接下来那一段位移会按"捏合前"的参照系算，图会跳）
  const [rest] = [...pointers.values()];
  dragOrigin = rest === undefined ? null : { ...rest };
  dragOffset = { ...offset.value };
  pinchStart = null;
}

/** 一次点按：与上一次够近就是双击 ⇒ 1x/2x 切换 */
function registerTap(): void {
  const now = Date.now();
  if (now - lastTapAt > DOUBLE_TAP_MS) {
    lastTapAt = now;
    return;
  }
  lastTapAt = 0;
  const next = doubleTapScale(scale.value);
  scale.value = next;
  offset.value = next === MIN_SCALE ? { x: 0, y: 0 } : clampOffset(offset.value, next, frame, base);
}

/**
 * 点背板关闭。⚠️ 拖动之后浏览器照样会补一次 `click`，那一次**不是**"点背板"：
 * 放大后随手拖一下就把查看器关掉，是这个交互最容易踩的坑。
 */
function onBackdropClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (target !== root.value) return;
  if (dragMoved) {
    dragMoved = false;
    return;
  }
  emit("close");
}

function onPopstate(): void {
  // 哨兵被浏览器弹掉 = 用户按了返回键 ⇒ 收掉自己；**不再 back()**（一次按键只退一层）
  sentinel = false;
  emit("close");
}

function pushSentinel(): void {
  if (sentinel) return;
  const prev = window.history.state as unknown;
  // 沿用既有 state：vue-router 在 `history.state` 上记着自己的 position/scroll，
  // 覆盖掉它会让这次 popstate 被当成"外来条目"而触发一次多余的 replace。
  const carried = typeof prev === "object" && prev !== null ? { ...(prev as Record<string, unknown>) } : {};
  window.history.pushState({ ...carried, weeCountImageLightbox: true }, "");
  sentinel = true;
  window.addEventListener("popstate", onPopstate);
}

function popSentinel(): void {
  window.removeEventListener("popstate", onPopstate);
  if (!sentinel) return;
  sentinel = false;
  window.history.back();
}

watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      resetGesture();
      pushSentinel();
      return;
    }
    popSentinel();
  },
  { immediate: true },
);

// 查看器开着时整页被卸载（切 tab / 退出）：哨兵不能留在历史里，否则返回键从此被吞一次
onBeforeUnmount(() => {
  popSentinel();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        ref="root"
        class="fixed inset-0 z-[60] flex touch-none items-center justify-center bg-black pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        data-test="image-lightbox"
        @click="onBackdropClick"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      >
        <!--
          被遮时必须看得出"这里有图、只是被遮住了"（实机反馈：模糊图与纯黑底糊成一片，
          看起来像图片没显示出来）。两件事缺一不可：
            1. 一层**不被模糊**的浅色描边/底 —— 说清边界在哪；
            2. 居中一句「已模糊」—— 说清它是被遮的，不是没加载出来。
          ⚠️ 描边**不能画在 `<img>` 上**：`blur-lg` 的 `filter` 会把同一元素的边框/阴影一起糊掉
          （1px 的线在 16px 模糊下等于不存在），所以它必须是 `<img>` 之外的独立一层。
          ⚠️ 这两层都得 `pointer-events-none`：描边铺满整屏，一旦吃掉指针事件，
          "点背板关闭"（`onBackdropClick` 判 `e.target === root`）与拖动/捏合手势就全断了。
        -->
        <div
          v-if="masked"
          class="pointer-events-none absolute inset-x-4 top-[env(safe-area-inset-top)] bottom-[env(safe-area-inset-bottom)] mb-4 mt-4 rounded-2xl bg-white/5 ring-1 ring-white/30"
          data-test="lightbox-masked-plate"
        />
        <img
          ref="image"
          data-test="lightbox-image"
          :src="src"
          alt="查看大图"
          draggable="false"
          class="max-h-full max-w-full select-none object-contain"
          :class="masked ? 'blur-lg' : ''"
          :style="imageStyle"
        />
        <p
          v-if="masked"
          class="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white ring-1 ring-white/30"
          data-test="lightbox-masked-badge"
        >
          已模糊
        </p>
        <button
          type="button"
          class="absolute right-3 top-[env(safe-area-inset-top)] z-10 mt-3 flex h-11 w-11 items-center justify-center rounded-full bg-black/60 text-lg text-white"
          aria-label="关闭"
          data-test="lightbox-close"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
