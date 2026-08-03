<!-- src/components/charts/LineChart.vue -->
<script setup lang="ts">
import { computed, ref } from "vue";
import { computeLinePoints, niceTicks, nearestIndex } from "@/utils/chart";

const props = withDefaults(defineProps<{
  labels: string[];
  series: { name: string; color: string; values: number[] }[];
  height?: number;
  fill?: boolean;
}>(), { height: 200, fill: true });

const W = 320;
const H = 160;
const PAD = 8;
const labelH = 16;

const maxValue = computed(() =>
  Math.max(0, ...props.series.flatMap((s) => s.values)) || 1
);
const ticks = computed(() => niceTicks(maxValue.value, 3));

const linePoints = computed(() =>
  props.series.map((s) =>
    computeLinePoints(s.values, W, H, PAD, maxValue.value)
  )
);
const linePath = (pts: { x: number; y: number }[]) =>
  pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
const areaPath = (pts: { x: number; y: number }[]) =>
  `${linePath(pts)} L ${pts[pts.length - 1].x} ${H - PAD} L ${pts[0].x} ${H - PAD} Z`;

const plotH = H - PAD * 2;
const yTick = (v: number) => H - PAD - (v / maxValue.value) * plotH;
// x 轴标签：最多显示 6 个，其余跳显
const xLabelIdxs = computed(() => {
  const n = props.labels.length;
  if (n <= 6) return props.labels.map((_, i) => i);
  const step = Math.ceil(n / 6);
  return props.labels.map((_, i) => i).filter((i) => i % step === 0);
});
const xTickX = (i: number) => (props.labels.length <= 1 ? W / 2 : PAD + (i / (props.labels.length - 1)) * (W - PAD * 2));

const tooltip = ref<{ x: number; y: number; idx: number } | null>(null);

function onPointerDown(e: PointerEvent) {
  const svg = e.currentTarget as SVGSVGElement;
  const rect = svg.getBoundingClientRect();
  const px = ((e.clientX - rect.left) / rect.width) * W;
  const xs = props.labels.map((_, i) => xTickX(i));
  const idx = nearestIndex(px, xs);
  const yMin = Math.min(...props.series.map((s) => computeLinePoints(s.values, W, H, PAD, maxValue.value)[idx]?.y ?? H));
  tooltip.value = { x: xs[idx], y: yMin, idx };
}
function onPointerLeave() {
  tooltip.value = null;
}
</script>

<template>
  <div class="relative w-full select-none" :style="{ height: height + 'px' }" data-test="line-chart">
    <svg
      class="h-full w-full touch-none"
      :viewBox="`0 0 ${W} ${H + labelH}`"
      @pointerdown="onPointerDown"
      @pointerleave="onPointerLeave"
    >
      <!-- 横向网格 + y 轴刻度 -->
      <g v-for="t in ticks" :key="t">
        <line
          :x1="PAD" :x2="W - PAD" :y1="yTick(t)" :y2="yTick(t)"
          stroke="#e5e7eb" stroke-width="1"
        />
        <text :x="PAD" :y="yTick(t) - 3" class="fill-gray-400" font-size="9">{{ t }}</text>
      </g>
      <!-- x 轴标签 -->
      <g>
        <text
          v-for="i in xLabelIdxs" :key="i"
          :x="xTickX(i)" :y="H + labelH - 4" font-size="9" text-anchor="middle" class="fill-gray-400"
        >{{ labels[i] }}</text>
      </g>
      <!-- 面积 + 折线 -->
      <template v-for="s in series" :key="s.name">
        <path
          v-if="fill" :d="areaPath(linePoints[series.indexOf(s)])"
          :fill="s.color" opacity="0.1"
        />
        <path
          :d="linePath(linePoints[series.indexOf(s)])"
          :stroke="s.color" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        />
      </template>
    </svg>

    <!-- tooltip -->
    <div
      v-if="tooltip"
      data-test="tooltip"
      class="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs shadow"
      :style="{ left: `${(tooltip.x / W) * 100}%`, top: `${((tooltip.y - 8) / (H + labelH)) * 100}%` }"
    >
      <p class="mb-0.5 font-medium text-gray-600">{{ labels[tooltip.idx] }}</p>
      <p v-for="s in series" :key="s.name" class="text-gray-700">
        <span :style="{ color: s.color }">●</span>
        {{ s.name }} <span class="font-semibold">{{ Number(s.values[tooltip.idx] ?? 0).toFixed(2) }}</span>
      </p>
    </div>
  </div>
</template>
