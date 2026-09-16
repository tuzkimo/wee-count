<!-- 日期范围选择器：快捷 chips + 日历连选（点起点 → 点终点）。
     产出 day 粒度（"YYYY-MM-DD"，含首尾整天）的范围，不含时分。
     手机竖屏单月，宽度 ≥ 640px 自动并排两个月。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { X } from "lucide-vue-next";
import CalendarMonth from "@/components/CalendarMonth.vue";
import {
  PRESETS,
  addMonths,
  buildPresetRange,
  formatRangeLabel,
  matchPreset,
  normalizeRange,
  toDateKey,
  type DateRange,
  type PresetKey,
} from "@/utils/dateRange";

const WIDE_QUERY = "(min-width: 640px)";
const MONTH_LABELS = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];

const props = defineProps<{
  visible: boolean;
  modelValue: DateRange;
}>();

const emit = defineEmits<{
  confirm: [range: DateRange];
  close: [];
}>();

const draftStart = ref("");
const draftEnd = ref("");
const hoverDate = ref("");
const today = ref(toDateKey(new Date()));
const viewYear = ref(new Date().getFullYear());
const viewMonth = ref(new Date().getMonth() + 1);

// 年/月快速跳转面板（否则查历史年份要点几十次上/下月）
const panel = ref<"calendar" | "month">("calendar");
const panelYear = ref(viewYear.value);

// 宽屏检测：决定渲染 1 个还是 2 个月
const isWide = ref(false);
let mql: MediaQueryList | null = null;
function onWideChange(e: MediaQueryListEvent): void {
  isWide.value = e.matches;
}

onMounted(() => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  mql = window.matchMedia(WIDE_QUERY);
  isWide.value = mql.matches;
  mql.addEventListener?.("change", onWideChange);
});

onBeforeUnmount(() => {
  mql?.removeEventListener?.("change", onWideChange);
});

const label = computed(() => formatRangeLabel(draftStart.value, draftEnd.value));

const hint = computed(() => {
  if (!draftStart.value && !draftEnd.value) return "点一天作为开始日期";
  if (draftStart.value && !draftEnd.value) return "再点一天作为结束日期；直接确定表示「从该日起」";
  return "";
});

const activePreset = computed<PresetKey | null>(() =>
  matchPreset({ start: draftStart.value, end: draftEnd.value })
);

// 只有起点时，悬停的日期作为待选终点（归一化在 CalendarMonth 内做，反向悬停同样预览）
const hoverPreview = computed(() =>
  draftStart.value && !draftEnd.value ? hoverDate.value : ""
);

const visibleMonths = computed(() => {
  const first = { year: viewYear.value, month: viewMonth.value };
  return isWide.value ? [first, addMonths(first.year, first.month, 1)] : [first];
});

const monthTitle = computed(() =>
  visibleMonths.value.map((m) => `${m.year}年${m.month}月`).join(" / ")
);

function setView(year: number, month: number): void {
  viewYear.value = year;
  viewMonth.value = month;
}

function shiftMonths(delta: number): void {
  const next = addMonths(viewYear.value, viewMonth.value, delta);
  setView(next.year, next.month);
}

function openMonthPanel(): void {
  panelYear.value = viewYear.value;
  panel.value = "month";
}

function pickMonth(month: number): void {
  setView(panelYear.value, month);
  panel.value = "calendar";
}

function pickDay(key: string): void {
  hoverDate.value = "";
  // 无起点、或已有完整范围：本次点击作为新的起点，重开选择
  if (!draftStart.value || draftEnd.value) {
    draftStart.value = key;
    draftEnd.value = "";
    return;
  }
  // 已有起点：本次点击作为终点；若早于起点则交换两端，不逼用户重来
  const r = normalizeRange(draftStart.value, key);
  draftStart.value = r.start;
  draftEnd.value = r.end;
}

function applyPreset(key: PresetKey): void {
  const r = buildPresetRange(key);
  draftStart.value = r.start;
  draftEnd.value = r.end;
  hoverDate.value = "";
  panel.value = "calendar";
  // 让选中范围落在可视月份内
  setView(Number(r.start.slice(0, 4)), Number(r.start.slice(5, 7)));
}

function clearDraft(): void {
  draftStart.value = "";
  draftEnd.value = "";
  hoverDate.value = "";
}

function onConfirm(): void {
  emit("confirm", { start: draftStart.value, end: draftEnd.value });
}

function onClose(): void {
  emit("close");
}

// 每次打开都从外部值重建草稿：取消不应留下上次的临时选择
watch(
  () => props.visible,
  (v) => {
    if (!v) return;
    const now = new Date();
    today.value = toDateKey(now);
    draftStart.value = props.modelValue.start;
    draftEnd.value = props.modelValue.end;
    hoverDate.value = "";
    panel.value = "calendar";
    const anchor = draftStart.value || draftEnd.value || today.value;
    setView(Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7)));
    panelYear.value = viewYear.value;
  },
  { immediate: true }
);
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-show="visible"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/40"
        @click.self="onClose"
      >
        <Transition name="sheet-slide-up">
          <div
            v-show="visible"
            class="flex max-h-[90vh] flex-col rounded-t-2xl bg-surface shadow-xl"
          >
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <span class="text-base font-semibold text-text">选择日期范围</span>
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
                aria-label="关闭"
                @click="onClose"
              >
                <X :size="18" class="text-text-secondary" />
              </button>
            </div>

            <div class="flex-1 overflow-y-auto">
              <!-- 已选范围 + 清除 -->
              <div class="flex items-start justify-between gap-3 px-4 pt-3">
                <div class="min-w-0">
                  <p
                    class="text-sm font-semibold"
                    :class="label ? 'text-text' : 'text-text-secondary'"
                    data-test="range-label"
                  >
                    {{ label || "请选择日期范围" }}
                  </p>
                  <p v-if="hint" class="mt-0.5 text-[11px] text-text-secondary">{{ hint }}</p>
                </div>
                <button
                  v-if="draftStart || draftEnd"
                  type="button"
                  data-test="range-clear"
                  class="shrink-0 text-xs text-text-secondary"
                  @click="clearDraft"
                >
                  清除
                </button>
              </div>

              <!-- 快捷范围 -->
              <div class="scrollbar-hide flex gap-2 overflow-x-auto px-4 py-3">
                <button
                  v-for="p in PRESETS"
                  :key="p.key"
                  type="button"
                  :data-preset="p.key"
                  class="shrink-0 rounded-full px-3 py-1 text-xs transition-colors"
                  :class="
                    activePreset === p.key
                      ? 'bg-primary text-white'
                      : 'bg-gray-100 text-text-secondary'
                  "
                  @click="applyPreset(p.key)"
                >
                  {{ p.label }}
                </button>
              </div>

              <!-- 月份标题 / 翻月 -->
              <div class="flex items-center gap-1 px-2 pb-1">
                <button
                  type="button"
                  data-test="prev-month"
                  class="flex h-8 w-8 items-center justify-center rounded-full text-lg text-text-secondary hover:bg-gray-100"
                  aria-label="上个月"
                  @click="shiftMonths(-1)"
                >
                  ‹
                </button>
                <button
                  type="button"
                  data-test="month-title"
                  class="flex-1 rounded-lg py-1 text-sm font-semibold text-text hover:bg-gray-50"
                  @click="openMonthPanel"
                >
                  {{ monthTitle }}
                </button>
                <button
                  type="button"
                  data-test="next-month"
                  class="flex h-8 w-8 items-center justify-center rounded-full text-lg text-text-secondary hover:bg-gray-100"
                  aria-label="下个月"
                  @click="shiftMonths(1)"
                >
                  ›
                </button>
              </div>

              <!-- 年/月快速跳转 -->
              <div v-if="panel === 'month'" class="px-4 pb-3" data-test="month-panel">
                <div class="flex items-center justify-center gap-1 py-2">
                  <button
                    type="button"
                    data-test="prev-decade"
                    class="h-8 w-8 rounded-full text-sm text-text-secondary hover:bg-gray-100"
                    aria-label="上十年"
                    @click="panelYear -= 10"
                  >
                    «
                  </button>
                  <button
                    type="button"
                    data-test="prev-year"
                    class="h-8 w-8 rounded-full text-sm text-text-secondary hover:bg-gray-100"
                    aria-label="上一年"
                    @click="panelYear -= 1"
                  >
                    ‹
                  </button>
                  <span class="w-20 text-center text-sm font-semibold text-text" data-test="panel-year">
                    {{ panelYear }}年
                  </span>
                  <button
                    type="button"
                    data-test="next-year"
                    class="h-8 w-8 rounded-full text-sm text-text-secondary hover:bg-gray-100"
                    aria-label="下一年"
                    @click="panelYear += 1"
                  >
                    ›
                  </button>
                  <button
                    type="button"
                    data-test="next-decade"
                    class="h-8 w-8 rounded-full text-sm text-text-secondary hover:bg-gray-100"
                    aria-label="下十年"
                    @click="panelYear += 10"
                  >
                    »
                  </button>
                </div>
                <div class="grid grid-cols-4 gap-2">
                  <button
                    v-for="(m, i) in MONTH_LABELS"
                    :key="i"
                    type="button"
                    :data-month="i + 1"
                    class="rounded-lg py-2 text-xs transition-colors"
                    :class="
                      panelYear === viewYear && i + 1 === viewMonth
                        ? 'bg-primary text-white'
                        : 'bg-gray-100 text-text-secondary'
                    "
                    @click="pickMonth(i + 1)"
                  >
                    {{ m }}
                  </button>
                </div>
              </div>

              <!-- 日历（宽屏双月） -->
              <div
                v-else
                class="flex gap-6 px-4 pb-2"
                @mouseleave="hoverDate = ''"
              >
                <CalendarMonth
                  v-for="m in visibleMonths"
                  :key="`${m.year}-${m.month}`"
                  :year="m.year"
                  :month="m.month"
                  :start="draftStart"
                  :end="draftEnd"
                  :hover-date="hoverPreview"
                  :today="today"
                  @pick="pickDay"
                  @hover="hoverDate = $event"
                  @leave="hoverDate = ''"
                />
              </div>
            </div>

            <!-- 操作 -->
            <div class="flex gap-3 border-t border-gray-100 px-4 pb-6 pt-3">
              <button
                type="button"
                data-test="range-cancel"
                class="flex-1 rounded-xl border border-gray-200 bg-surface py-3 text-center text-base text-text-secondary transition-colors hover:bg-gray-50"
                @click="onClose"
              >
                取消
              </button>
              <button
                type="button"
                data-test="range-confirm"
                class="flex-1 rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
                @click="onConfirm"
              >
                确定
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
</style>
