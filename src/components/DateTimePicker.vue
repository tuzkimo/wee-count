<!-- 普通 script 块：导出可测试的纯函数 -->
<script lang="ts">
export interface YearMonthOption {
  year: number;
  month: number;
  label: string;
}

export function generateYearMonthOptions(currentYear: number): YearMonthOption[] {
  const options: YearMonthOption[] = [];
  const startYear = currentYear + 10;
  const endYear = currentYear - 10;
  for (let year = startYear; year >= endYear; year--) {
    for (let month = 12; month >= 1; month--) {
      options.push({ year, month, label: `${year}年${month}月` });
    }
  }
  return options;
}

export function generateDayOptions(year: number, month: number): number[] {
  const daysInMonth = new Date(year, month, 0).getDate();
  return Array.from({ length: daysInMonth }, (_, i) => i + 1);
}

export function generateHourOptions(): string[] {
  return Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
}

export function generateMinuteOptions(): string[] {
  return Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));
}

export function parseModelValue(value: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
} | null {
  if (!value || !value.includes("T")) return null;
  const [datePart, timePart] = value.split("T");
  const parts = datePart.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [y, m, d] = parts;
  const timeParts = timePart.split(":").map(Number);
  if (timeParts.length < 2 || timeParts.some(isNaN)) return null;
  const [hh, mm] = timeParts;
  return { year: y, month: m, day: d, hour: hh, minute: mm };
}

export function getDefaultIndex<T extends string | number>(
  options: T[],
  target: T
): number {
  const idx = options.indexOf(target);
  return idx >= 0 ? idx : 0;
}
</script>

<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { X } from "lucide-vue-next";

const props = defineProps<{
  visible: boolean;
  modelValue: string;
}>();

const emit = defineEmits<{
  confirm: [value: string];
  close: [];
}>();

// 获取当前时间的默认选中值
function getCurrentDefaults(): { year: number; month: number; day: number; hour: number; minute: number } {
  const n = new Date();
  return {
    year: n.getFullYear(),
    month: n.getMonth() + 1,
    day: n.getDate(),
    hour: n.getHours(),
    minute: Math.min(Math.round(n.getMinutes() / 5) * 5, 55),
  };
}

// 生成选项列表
const currentYear = new Date().getFullYear();
const yearMonthOptions = generateYearMonthOptions(currentYear);

// 默认选中当前年月
const defaults = getCurrentDefaults();
const defaultYearMonth = yearMonthOptions.find(
  (o) => o.year === defaults.year && o.month === defaults.month
) ?? yearMonthOptions[0];

const selectedYearMonth = ref<YearMonthOption>(defaultYearMonth);
const dayOptions = ref<number[]>(generateDayOptions(defaultYearMonth.year, defaultYearMonth.month));
const selectedDay = ref(defaults.day);
const hourOptions = generateHourOptions();
const selectedHour = ref(String(defaults.hour).padStart(2, "0"));
const minuteOptions = generateMinuteOptions();
const selectedMinute = ref(String(defaults.minute).padStart(2, "0"));

// 滚轮容器 ref，用于初始化滚动位置
const ymScrollRef = ref<HTMLElement | null>(null);
const dayScrollRef = ref<HTMLElement | null>(null);
const hourScrollRef = ref<HTMLElement | null>(null);
const minuteScrollRef = ref<HTMLElement | null>(null);

const ITEM_HEIGHT = 40;

// 年月变化时更新日选项
watch(
  () => selectedYearMonth.value,
  (ym) => {
    dayOptions.value = generateDayOptions(ym.year, ym.month);
    // 如果当前选中日超出范围，修正为最后一天
    if (selectedDay.value > dayOptions.value.length) {
      selectedDay.value = dayOptions.value.length;
    }
  }
);

// 初始化选中值
function initFromModelValue() {
  const parsed = parseModelValue(props.modelValue);
  const cur = parsed ?? getCurrentDefaults();

  const ymIdx = yearMonthOptions.findIndex(
    (o) => o.year === cur.year && o.month === cur.month
  );
  if (ymIdx >= 0) {
    selectedYearMonth.value = yearMonthOptions[ymIdx];
  } else {
    // modelValue 中的年月不在可选范围内，回退到当前年月
    const fallback = getCurrentDefaults();
    const fbIdx = yearMonthOptions.findIndex(
      (o) => o.year === fallback.year && o.month === fallback.month
    );
    selectedYearMonth.value = fbIdx >= 0 ? yearMonthOptions[fbIdx] : yearMonthOptions[0];
  }

  dayOptions.value = generateDayOptions(
    selectedYearMonth.value.year,
    selectedYearMonth.value.month
  );
  selectedDay.value = cur.day <= dayOptions.value.length ? cur.day : dayOptions.value.length;
  selectedHour.value = String(cur.hour).padStart(2, "0");
  selectedMinute.value = String(cur.minute).padStart(2, "0");
}

// 滚动到选中项
async function scrollToSelected() {
  await nextTick();
  if (ymScrollRef.value) {
    const ymIdx = yearMonthOptions.findIndex(
      (o) => o.year === selectedYearMonth.value.year && o.month === selectedYearMonth.value.month
    );
    if (ymIdx >= 0) ymScrollRef.value.scrollTop = ymIdx * ITEM_HEIGHT;
  }
  if (dayScrollRef.value) {
    const dIdx = dayOptions.value.indexOf(selectedDay.value);
    if (dIdx >= 0) dayScrollRef.value.scrollTop = dIdx * ITEM_HEIGHT;
  }
  if (hourScrollRef.value) {
    const hIdx = hourOptions.indexOf(selectedHour.value);
    if (hIdx >= 0) hourScrollRef.value.scrollTop = hIdx * ITEM_HEIGHT;
  }
  if (minuteScrollRef.value) {
    const mIdx = minuteOptions.indexOf(selectedMinute.value);
    if (mIdx >= 0) minuteScrollRef.value.scrollTop = mIdx * ITEM_HEIGHT;
  }
}

// visible 变化时初始化
watch(
  () => props.visible,
  async (v) => {
    if (v) {
      initFromModelValue();
      await scrollToSelected();
    }
  }
);

// 滚轮 scroll 事件处理
function onYearMonthScroll() {
  if (!ymScrollRef.value) return;
  const idx = Math.round(ymScrollRef.value.scrollTop / ITEM_HEIGHT);
  if (idx >= 0 && idx < yearMonthOptions.length) {
    selectedYearMonth.value = yearMonthOptions[idx];
  }
}

function onDayScroll() {
  if (!dayScrollRef.value) return;
  const idx = Math.round(dayScrollRef.value.scrollTop / ITEM_HEIGHT);
  if (idx >= 0 && idx < dayOptions.value.length) {
    selectedDay.value = dayOptions.value[idx];
  }
}

function onHourScroll() {
  if (!hourScrollRef.value) return;
  const idx = Math.round(hourScrollRef.value.scrollTop / ITEM_HEIGHT);
  if (idx >= 0 && idx < hourOptions.length) {
    selectedHour.value = hourOptions[idx];
  }
}

function onMinuteScroll() {
  if (!minuteScrollRef.value) return;
  const idx = Math.round(minuteScrollRef.value.scrollTop / ITEM_HEIGHT);
  if (idx >= 0 && idx < minuteOptions.length) {
    selectedMinute.value = minuteOptions[idx];
  }
}

// 确定
function onConfirm() {
  const mm = String(selectedYearMonth.value.month).padStart(2, "0");
  const dd = String(selectedDay.value).padStart(2, "0");
  const value = `${selectedYearMonth.value.year}-${mm}-${dd}T${selectedHour.value}:${selectedMinute.value}`;
  emit("confirm", value);
}

// 关闭
function onClose() {
  emit("close");
}
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
            class="flex flex-col rounded-t-2xl bg-surface shadow-xl"
          >
            <!-- Header -->
            <div class="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <span class="text-base font-semibold text-text">选择日期时间</span>
              <button
                class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
                @click="onClose"
              >
                <X :size="18" class="text-text-secondary" />
              </button>
            </div>

            <!-- 四列滚轮 -->
            <div class="relative flex gap-0 px-4 py-4" style="height: 200px">
              <!-- 年月列 -->
              <div class="relative flex-1">
                <div
                  ref="ymScrollRef"
                  class="h-full overflow-auto snap-y snap-mandatory scrollbar-hide"
                  :style="{ padding: `${ITEM_HEIGHT * 2}px 0` }"
                  @scroll="onYearMonthScroll"
                >
                  <div
                    v-for="opt in yearMonthOptions"
                    :key="`${opt.year}-${opt.month}`"
                    class="flex items-center justify-center snap-center text-sm leading-none"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedYearMonth.year === opt.year && selectedYearMonth.month === opt.month
                        ? 'text-text font-semibold'
                        : 'text-gray-300'
                    "
                  >
                    {{ opt.label }}
                  </div>
                </div>
              </div>

              <!-- 日列 -->
              <div class="relative w-16">
                <div
                  ref="dayScrollRef"
                  class="h-full overflow-auto snap-y snap-mandatory scrollbar-hide"
                  :style="{ padding: `${ITEM_HEIGHT * 2}px 0` }"
                  @scroll="onDayScroll"
                >
                  <div
                    v-for="d in dayOptions"
                    :key="d"
                    class="flex items-center justify-center snap-center text-sm leading-none"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedDay === d ? 'text-text font-semibold' : 'text-gray-300'
                    "
                  >
                    {{ d }}日
                  </div>
                </div>
              </div>

              <!-- 时列 -->
              <div class="relative w-16">
                <div
                  ref="hourScrollRef"
                  class="h-full overflow-auto snap-y snap-mandatory scrollbar-hide"
                  :style="{ padding: `${ITEM_HEIGHT * 2}px 0` }"
                  @scroll="onHourScroll"
                >
                  <div
                    v-for="h in hourOptions"
                    :key="h"
                    class="flex items-center justify-center snap-center text-sm leading-none"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedHour === h ? 'text-text font-semibold' : 'text-gray-300'
                    "
                  >
                    {{ h }}
                  </div>
                </div>
              </div>

              <!-- 分列 -->
              <div class="relative w-16">
                <div
                  ref="minuteScrollRef"
                  class="h-full overflow-auto snap-y snap-mandatory scrollbar-hide"
                  :style="{ padding: `${ITEM_HEIGHT * 2}px 0` }"
                  @scroll="onMinuteScroll"
                >
                  <div
                    v-for="m in minuteOptions"
                    :key="m"
                    class="flex items-center justify-center snap-center text-sm leading-none"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedMinute === m ? 'text-text font-semibold' : 'text-gray-300'
                    "
                  >
                    {{ m }}
                  </div>
                </div>
              </div>
            </div>

            <!-- 列标签 -->
            <div class="flex gap-0 px-4 pb-2">
              <div class="flex-1 text-center text-[10px] text-gray-400">年月</div>
              <div class="w-16 text-center text-[10px] text-gray-400">日</div>
              <div class="w-16 text-center text-[10px] text-gray-400">时</div>
              <div class="w-16 text-center text-[10px] text-gray-400">分</div>
            </div>

            <!-- 确定按钮 -->
            <div class="px-4 pb-6 pt-2">
              <button
                class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
                @click="onConfirm"
              >
                确 定
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
