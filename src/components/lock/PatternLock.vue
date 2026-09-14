<!-- src/components/lock/PatternLock.vue -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { appendDot, dotCenter, hitTest, isValidPattern } from "@/utils/pattern";

const props = withDefaults(defineProps<{
  size?: number;
  disabled?: boolean;
  error?: boolean;
}>(), { size: 280, disabled: false, error: false });

const emit = defineEmits<{
  complete: [dots: number[]];
  invalid: [];
}>();

/** 命中半径 = 点位半径 × 1.5（触屏手指有宽度，命中区比视觉半径大） */
const HIT_RADIUS_RATIO = 1.5;
const DOT_RADIUS_RATIO = 1 / 18;

const dotRadius = computed(() => props.size * DOT_RADIUS_RATIO);
const hitRadius = computed(() => dotRadius.value * HIT_RADIUS_RATIO);

const sequence = ref<number[]>([]);
const dragging = ref(false);
const cursor = ref<{ x: number; y: number } | null>(null);

const centers = computed(() =>
  Array.from({ length: 9 }, (_, i) => dotCenter(i + 1, props.size)),
);

const segments = computed(() =>
  sequence.value.map((dot) => dotCenter(dot, props.size)),
);

/** 指针坐标换算到画布坐标系：happy-dom 下 rect 为 0 时退化为 1:1。 */
function toLocal(e: PointerEvent): { x: number; y: number } {
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const scale = rect.width === 0 ? 1 : props.size / rect.width;
  return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
}

function addAt(x: number, y: number): void {
  const dot = hitTest(x, y, props.size, hitRadius.value);
  if (dot === null) return;
  // appendDot 会忽略重复点：长度不变说明本次没有新增，保持原引用不动。
  const next = appendDot(sequence.value, dot);
  if (next.length !== sequence.value.length) sequence.value = next;
}

function onPointerDown(e: PointerEvent): void {
  if (props.disabled) return;
  // 捕获指针，手指滑出画布后仍能收到 move/up。
  (e.currentTarget as SVGSVGElement).setPointerCapture?.(e.pointerId);
  dragging.value = true;
  sequence.value = [];
  const { x, y } = toLocal(e);
  cursor.value = { x, y };
  addAt(x, y);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value || props.disabled) return;
  const { x, y } = toLocal(e);
  cursor.value = { x, y };
  addAt(x, y);
}

/** 抬手（或系统取消手势）时结算：点数不足由 isValidPattern 按 PATTERN_MIN_DOTS 判定。 */
function onPointerUp(): void {
  if (!dragging.value) return;
  dragging.value = false;
  cursor.value = null;

  const finalSequence = sequence.value;
  sequence.value = [];

  if (!isValidPattern(finalSequence)) {
    emit("invalid");
    return;
  }
  emit("complete", finalSequence);
}
</script>

<template>
  <svg
    class="touch-none select-none"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${size} ${size}`"
    :class="error ? 'animate-pulse' : ''"
    data-test="pattern-lock"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <!-- 已连线段 -->
    <polyline
      v-if="segments.length > 1"
      :points="segments.map((p) => `${p.x},${p.y}`).join(' ')"
      fill="none"
      :stroke="error ? '#ef4444' : '#3b82f6'"
      stroke-width="4"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <!-- 拖拽中的橡皮筋线 -->
    <line
      v-if="dragging && cursor && segments.length > 0"
      :x1="segments[segments.length - 1].x"
      :y1="segments[segments.length - 1].y"
      :x2="cursor.x"
      :y2="cursor.y"
      :stroke="error ? '#ef4444' : '#93c5fd'"
      stroke-width="3"
      stroke-linecap="round"
    />
    <!-- 点位 -->
    <g v-for="(c, i) in centers" :key="i">
      <circle
        :data-test="`pattern-dot-${i + 1}`"
        :cx="c.x"
        :cy="c.y"
        :r="dotRadius"
        :fill="sequence.includes(i + 1) ? (error ? '#ef4444' : '#3b82f6') : '#d1d5db'"
      />
      <circle
        v-if="sequence.includes(i + 1)"
        :cx="c.x"
        :cy="c.y"
        :r="dotRadius * 0.42"
        fill="#ffffff"
      />
    </g>
  </svg>
</template>
