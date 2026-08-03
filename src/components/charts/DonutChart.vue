<!-- src/components/charts/DonutChart.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { donutAngles, arcPath } from "@/utils/chart";

type Segment = { id: string | null; name: string; total: number; color: string };

const props = withDefaults(defineProps<{
  segments: Segment[];
  centerLabel?: string;
  centerValue?: string;
}>(), { centerLabel: "总额", centerValue: "" });

const emit = defineEmits<{ "segment-click": [segment: Segment] }>();

const SIZE = 180;
const CX = SIZE / 2;
const R_OUTER = 78;
const R_INNER = 54;
const RING_W = R_OUTER - R_INNER;
const R_MID = (R_OUTER + R_INNER) / 2;
// SVG <path> 无法渲染整圆扇区（起止点重合）。跨角达整圆时退化为不可见 path，
// 需改渲染带同宽描边的整圆 <circle>（Task 1 评审遗留，硬性要求）。
const FULL_SWEEP = Math.PI * 2 - 0.01;

const arcs = computed(() =>
  donutAngles(props.segments.map((s) => s.total)).map((a, i) => {
    const full = a.end - a.start >= FULL_SWEEP;
    return {
      seg: props.segments[i],
      full,
      d: full ? "" : arcPath(CX, CX, R_OUTER, R_INNER, a.start, a.end),
    };
  })
);
</script>

<template>
  <div class="relative flex w-full items-center justify-center" data-test="donut-chart">
    <svg :viewBox="`0 0 ${SIZE} ${SIZE}`" class="w-full max-w-[220px]">
      <template v-for="(arc, i) in arcs" :key="i">
        <circle
          v-if="arc.full"
          :cx="CX" :cy="CX" :r="R_MID"
          fill="none" :stroke="arc.seg.color" :stroke-width="RING_W"
          class="cursor-pointer"
          @click="emit('segment-click', arc.seg)"
        />
        <path
          v-else
          :d="arc.d" :fill="arc.seg.color" stroke="#ffffff" stroke-width="1.5"
          class="cursor-pointer"
          @click="emit('segment-click', arc.seg)"
        />
      </template>
    </svg>
    <div class="pointer-events-none absolute flex flex-col items-center">
      <span class="text-xs text-text-secondary">{{ centerLabel }}</span>
      <span class="text-lg font-semibold text-text">{{ centerValue }}</span>
    </div>
  </div>
</template>
