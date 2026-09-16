<!-- 单月日历网格：无状态，年月/范围/hover 预览全部走 props，点击与悬停走 emit。
     手机单月、宽屏双月复用同一组件（DateRangePicker 决定渲染几个）。 -->
<script setup lang="ts">
import { computed } from "vue";
import { buildMonthGrid, normalizeRange, weekdayHeaders, type DateRange } from "@/utils/dateRange";

const props = defineProps<{
  year: number;
  /** 1-12 */
  month: number;
  /** 已选起点，"" 表示未选 */
  start: string;
  /** 已选终点，"" 表示未选 */
  end: string;
  /** 仅有起点时的悬停日期（原始值，未归一化；移动端恒为 ""） */
  hoverDate: string;
  /** 今天的日期 key，用于弱标记 */
  today: string;
}>();

const emit = defineEmits<{
  pick: [dateKey: string];
  hover: [dateKey: string];
  leave: [];
}>();

const cells = computed(() => buildMonthGrid(props.year, props.month));
const headers = computed(() => weekdayHeaders());

// 预览结束日只补位「已选起点、未选终点」的空档；归一化后即可是反向拖选
const previewEnd = computed(() =>
  props.start && !props.end ? props.hoverDate : ""
);

const band = computed<DateRange | null>(() => {
  const e = props.end || previewEnd.value;
  if (!props.start || !e) return null;
  return normalizeRange(props.start, e);
});

// 端点实心圆：没有可见范围时只标起点（含单边「从该日起」）
const markedStart = computed(() => band.value?.start ?? props.start);
const markedEnd = computed(() => band.value?.end ?? props.end);

function dayOf(cell: string): number {
  return Number(cell.slice(8, 10));
}

// 浅色带：两端各带半圆角，与端点实心圆拼成胶囊
function bandClass(cell: string): string {
  const b = band.value;
  if (!b || b.start === b.end) return "";
  if (cell === b.start) return "rounded-l-full bg-primary/10";
  if (cell === b.end) return "rounded-r-full bg-primary/10";
  if (cell > b.start && cell < b.end) return "bg-primary/10";
  return "";
}

function dayClass(cell: string): string {
  if (cell === markedStart.value || cell === markedEnd.value) {
    return "bg-primary font-semibold text-white";
  }
  if (cell === props.today) return "font-semibold text-primary";
  return "text-text";
}

</script>

<template>
  <div class="min-w-0 flex-1">
    <!-- 星期表头 -->
    <div class="grid grid-cols-7">
      <div
        v-for="(h, i) in headers"
        :key="i"
        class="py-1 text-center text-[11px] text-text-secondary"
      >
        {{ h }}
      </div>
    </div>

    <!-- 固定 6 行网格，切月不跳高度 -->
    <div class="grid grid-cols-7 gap-y-0.5">
      <div
        v-for="(cell, i) in cells"
        :key="i"
        :data-cell="cell"
        class="flex h-9 items-center justify-center"
        :class="cell ? bandClass(cell) : ''"
      >
        <button
          v-if="cell"
          type="button"
          :data-date="cell"
          class="flex h-8 w-8 items-center justify-center rounded-full text-sm transition-colors"
          :class="dayClass(cell)"
          @click="emit('pick', cell)"
          @mouseenter="emit('hover', cell)"
          @mouseleave="emit('leave')"
        >
          {{ dayOf(cell) }}
        </button>
      </div>
    </div>
  </div>
</template>
