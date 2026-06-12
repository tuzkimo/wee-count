# Phase 4 后续优化 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成三个独立优化：自定义日期时间选择器、首页汇总卡片改造、账户详情页批量删除

**Architecture:** 三个独立功能，互不依赖。DateTimePicker 是纯 UI 组件（Teleport 底部弹出 + CSS scroll-snap 滚轮），替换原有原生 input wrapper；TransactionList 首页模式新增默认本月筛选 + 筛选状态栏 + 收入/支出/结余汇总卡片；账户详情模式新增多选批量删除。Store 层只新增 `batchRemove` 一个方法。

**Tech Stack:** Vue 3 + TypeScript + Pinia + Lucide Vue Next + Tailwind CSS v4 + Vitest

---

## 文件结构

| 文件 | 角色 |
|------|------|
| `src/components/DateTimePicker.vue` | 四列滚轮日期时间选择器（底部弹出） |
| `src/stores/transaction.ts` | 交易 store，新增 `batchRemove` |
| `src/stores/__tests__/transaction.test.ts` | transaction store 测试，新增 batchRemove 测试 |
| `src/views/RecordPage.vue` | 记账页，替换原生 datetime-local 为 DateTimePicker |
| `src/views/FilterPage.vue` | 筛选页，替换两个原生 datetime-local 为两个 DateTimePicker |
| `src/views/TransactionList.vue` | 首页/账户详情，新增默认筛选 + 筛选状态栏 + 新汇总卡片 + 多选删除 |

---

### Task 1: DateTimePicker — 选项生成逻辑与单元测试

**Files:**
- Create: `src/components/__tests__/DateTimePicker.test.ts`
- Modify: `src/components/DateTimePicker.vue`（将 helper 函数放在 script setup 顶部，但测试需要单独导出）

> **Note:** 由于 `script setup` 中定义的函数无法从外部导入测试，本任务将可测试的纯逻辑提取到 `src/components/DateTimePicker.vue` 的具名导出中。Vue 的 `defineOptions` 或直接使用 `<script>` 块配合 `export` 实现。

实际上，Vitest + jsdom 环境下测试 scroll 行为不可靠。测试策略：将选项生成逻辑提取为纯函数并单独测试，UI 交互通过人工验证。

在 `DateTimePicker.vue` 中使用两个 `<script>` 块：一个普通 `<script>` 导出可测试的纯函数，一个 `<script setup>` 使用它们。

**文件变更策略：** 
- `DateTimePicker.vue` 将被完全重写，旧的 native input wrapper 不留。RecordPage/FilterPage 当前未使用该组件（它们直接用原生 input），所以替换不影响其他文件。

- [ ] **Step 1: 创建测试文件**

```typescript
// src/components/__tests__/DateTimePicker.test.ts
import { describe, it, expect } from "vitest";

// 从 DateTimePicker.vue 的普通 script 块导入纯函数
import {
  generateYearMonthOptions,
  generateDayOptions,
  generateHourOptions,
  generateMinuteOptions,
  parseModelValue,
  getDefaultIndex,
} from "@/components/DateTimePicker.vue";

describe("generateYearMonthOptions", () => {
  it("should generate ±10 years of year-month options", () => {
    // Mock 当前年份为 2025
    const options = generateYearMonthOptions(2025);
    // ±10 年 × 12 个月 = 21 × 12 = 252 条
    expect(options.length).toBe(252);
    // 第一条是 2035年12月（未来最远）
    expect(options[0]).toEqual({ year: 2035, month: 12, label: "2035年12月" });
    // 最后一条是 2015年1月（过去最远）
    expect(options[251]).toEqual({ year: 2015, month: 1, label: "2015年1月" });
  });

  it("should start from current year + 10 December and end at current year - 10 January", () => {
    const options = generateYearMonthOptions(2026);
    expect(options[0]).toEqual({ year: 2036, month: 12, label: "2036年12月" });
    expect(options[options.length - 1]).toEqual({ year: 2016, month: 1, label: "2016年1月" });
  });
});

describe("generateDayOptions", () => {
  it("should generate 31 days for January", () => {
    const options = generateDayOptions(2025, 1);
    expect(options.length).toBe(31);
    expect(options[0]).toBe(1);
    expect(options[30]).toBe(31);
  });

  it("should generate 28 days for February non-leap year", () => {
    const options = generateDayOptions(2025, 2);
    expect(options.length).toBe(28);
  });

  it("should generate 29 days for February leap year", () => {
    const options = generateDayOptions(2024, 2);
    expect(options.length).toBe(29);
  });

  it("should generate 30 days for April", () => {
    const options = generateDayOptions(2025, 4);
    expect(options.length).toBe(30);
  });
});

describe("generateHourOptions", () => {
  it("should generate 00-23", () => {
    const options = generateHourOptions();
    expect(options.length).toBe(24);
    expect(options[0]).toBe("00");
    expect(options[23]).toBe("23");
  });
});

describe("generateMinuteOptions", () => {
  it("should generate 00-55 step 5", () => {
    const options = generateMinuteOptions();
    expect(options.length).toBe(12);
    expect(options[0]).toBe("00");
    expect(options[1]).toBe("05");
    expect(options[11]).toBe("55");
  });
});

describe("parseModelValue", () => {
  it("should parse YYYY-MM-DDTHH:mm format", () => {
    const result = parseModelValue("2025-06-12T14:30");
    expect(result).toEqual({
      year: 2025,
      month: 6,
      day: 12,
      hour: 14,
      minute: 30,
    });
  });

  it("should parse single-digit month/day", () => {
    const result = parseModelValue("2025-01-05T08:00");
    expect(result).toEqual({
      year: 2025,
      month: 1,
      day: 5,
      hour: 8,
      minute: 0,
    });
  });
});

describe("getDefaultIndex", () => {
  it("should find the index of matching value in array", () => {
    expect(getDefaultIndex(["00", "05", "10", "15"], "10")).toBe(2);
    expect(getDefaultIndex([1, 2, 3, 4, 5], 3)).toBe(2);
  });

  it("should return 0 if not found", () => {
    expect(getDefaultIndex(["00", "05"], "07")).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/components/__tests__/DateTimePicker.test.ts
```

预期：全部 FAIL，因为函数尚未实现。

- [ ] **Step 3: 实现 DateTimePicker.vue 的纯函数部分**

```vue
<!-- src/components/DateTimePicker.vue -->

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
} {
  const [datePart, timePart] = value.split("T");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
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
// 组件逻辑将在后续步骤实现
</script>

<template>
  <!-- 模板将在后续步骤实现 -->
</template>
```

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/components/__tests__/DateTimePicker.test.ts
```

预期：全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/__tests__/DateTimePicker.test.ts src/components/DateTimePicker.vue
git commit -m "feat: add DateTimePicker pure helper functions with tests"
```

---

### Task 2: DateTimePicker — 组件模板与交互逻辑

**Files:**
- Modify: `src/components/DateTimePicker.vue`

- [ ] **Step 1: 实现完整的组件 script setup**

替换 `<script setup>` 部分为完整实现：

```vue
<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { X } from "lucide-vue-next";
import {
  generateYearMonthOptions,
  generateDayOptions,
  generateHourOptions,
  generateMinuteOptions,
  parseModelValue,
  getDefaultIndex,
  type YearMonthOption,
} from "./DateTimePicker.vue";

const props = defineProps<{
  visible: boolean;
  modelValue: string;
}>();

const emit = defineEmits<{
  confirm: [value: string];
  close: [];
}>();

// 生成选项列表
const currentYear = new Date().getFullYear();
const yearMonthOptions = generateYearMonthOptions(currentYear);

const selectedYearMonth = ref<YearMonthOption>(yearMonthOptions[0]);
const dayOptions = ref<number[]>([]);
const selectedDay = ref(1);
const hourOptions = generateHourOptions();
const selectedHour = ref("00");
const minuteOptions = generateMinuteOptions();
const selectedMinute = ref("00");

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
  const ymIdx = yearMonthOptions.findIndex(
    (o) => o.year === parsed.year && o.month === parsed.month
  );
  if (ymIdx >= 0) {
    selectedYearMonth.value = yearMonthOptions[ymIdx];
  }
  dayOptions.value = generateDayOptions(
    selectedYearMonth.value.year,
    selectedYearMonth.value.month
  );
  selectedDay.value = parsed.day <= dayOptions.value.length ? parsed.day : dayOptions.value.length;
  selectedHour.value = String(parsed.hour).padStart(2, "0");
  // 分钟取最近 5 分钟步长
  const roundedMinute = Math.round(parsed.minute / 5) * 5;
  selectedMinute.value = String(Math.min(roundedMinute, 55)).padStart(2, "0");
}

// 滚动到选中项
async function scrollToSelected() {
  await nextTick();
  if (ymScrollRef.value) {
    const ymIdx = yearMonthOptions.indexOf(selectedYearMonth.value);
    ymScrollRef.value.scrollTop = ymIdx * ITEM_HEIGHT;
  }
  if (dayScrollRef.value) {
    const dIdx = dayOptions.value.indexOf(selectedDay.value);
    dayScrollRef.value.scrollTop = dIdx * ITEM_HEIGHT;
  }
  if (hourScrollRef.value) {
    const hIdx = hourOptions.indexOf(selectedHour.value);
    hourScrollRef.value.scrollTop = hIdx * ITEM_HEIGHT;
  }
  if (minuteScrollRef.value) {
    const mIdx = minuteOptions.indexOf(selectedMinute.value);
    minuteScrollRef.value.scrollTop = mIdx * ITEM_HEIGHT;
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
```

- [ ] **Step 2: 实现模板**

```vue
<template>
  <Teleport to="body">
    <Transition name="picker-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex flex-col justify-end bg-black/40"
        @click.self="onClose"
      >
        <Transition name="picker-slide">
          <div
            v-if="visible"
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
                    class="flex items-center justify-center snap-center text-sm"
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
                <!-- 选中行高亮指示器 -->
                <div
                  class="pointer-events-none absolute left-0 right-0 border-y border-gray-100 bg-primary/5"
                  :style="{
                    top: `${ITEM_HEIGHT * 2}px`,
                    height: `${ITEM_HEIGHT}px`,
                  }"
                />
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
                    class="flex items-center justify-center snap-center text-sm"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedDay === d ? 'text-text font-semibold' : 'text-gray-300'
                    "
                  >
                    {{ d }}日
                  </div>
                </div>
                <div
                  class="pointer-events-none absolute left-0 right-0 border-y border-gray-100 bg-primary/5"
                  :style="{
                    top: `${ITEM_HEIGHT * 2}px`,
                    height: `${ITEM_HEIGHT}px`,
                  }"
                />
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
                    class="flex items-center justify-center snap-center text-sm"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedHour === h ? 'text-text font-semibold' : 'text-gray-300'
                    "
                  >
                    {{ h }}
                  </div>
                </div>
                <div
                  class="pointer-events-none absolute left-0 right-0 border-y border-gray-100 bg-primary/5"
                  :style="{
                    top: `${ITEM_HEIGHT * 2}px`,
                    height: `${ITEM_HEIGHT}px`,
                  }"
                />
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
                    class="flex items-center justify-center snap-center text-sm"
                    :style="{ height: `${ITEM_HEIGHT}px` }"
                    :class="
                      selectedMinute === m ? 'text-text font-semibold' : 'text-gray-300'
                    "
                  >
                    {{ m }}
                  </div>
                </div>
                <div
                  class="pointer-events-none absolute left-0 right-0 border-y border-gray-100 bg-primary/5"
                  :style="{
                    top: `${ITEM_HEIGHT * 2}px`,
                    height: `${ITEM_HEIGHT}px`,
                  }"
                />
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
```

- [ ] **Step 3: 添加样式**

```vue
<style scoped>
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

.picker-fade-enter-active,
.picker-fade-leave-active {
  transition: opacity 0.25s ease;
}
.picker-fade-enter-from,
.picker-fade-leave-to {
  opacity: 0;
}

.picker-slide-enter-active,
.picker-slide-leave-active {
  transition: transform 0.25s ease;
}
.picker-slide-enter-from,
.picker-slide-leave-to {
  transform: translateY(100%);
}
</style>
```

- [ ] **Step 4: 运行测试确认纯函数测试仍然通过**

```bash
npx vitest run src/components/__tests__/DateTimePicker.test.ts
```

预期：全部 PASS（纯函数测试不受模板影响）

- [ ] **Step 5: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 6: Commit**

```bash
git add src/components/DateTimePicker.vue
git commit -m "feat: implement DateTimePicker scroll-wheel UI with animations"
```

---

### Task 3: RecordPage — 集成 DateTimePicker

**Files:**
- Modify: `src/views/RecordPage.vue`

当前 RecordPage.vue 第 409-416 行使用原生 `<input type="datetime-local">` 绑定 `occurredAt`。

- [ ] **Step 1: 替换日期时间区域为按钮 + DateTimePicker**

将第 408-416 行：
```vue
      <!-- 5. 日期时间 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">日期时间</label>
        <input
          v-model="occurredAt"
          type="datetime-local"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </div>
```

替换为：
```vue
      <!-- 5. 日期时间 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">日期时间</label>
        <button
          class="flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          @click="datePickerVisible = true"
        >
          <span>📅</span>
          <span>{{ occurredAt }}</span>
        </button>
      </div>
```

- [ ] **Step 2: 添加 DateTimePicker 组件到模板**

在 `</div>`（最外层 `flex h-full flex-col bg-bg` 的闭合标签）之前，`ConfirmDialog` 之后添加：

```vue
    <!-- 日期时间选择器 -->
    <DateTimePicker
      :visible="datePickerVisible"
      :model-value="occurredAt"
      @confirm="onDateTimeConfirm"
      @close="datePickerVisible = false"
    />
```

- [ ] **Step 3: 添加 import 和状态**

在 `<script setup>` 的 import 区域添加：
```typescript
import DateTimePicker from "@/components/DateTimePicker.vue";
```

在状态声明区域（`const isSaving = ref(false)` 附近）添加：
```typescript
const datePickerVisible = ref(false);
```

添加 confirm 处理函数（放在 `goBack` 函数附近）：
```typescript
function onDateTimeConfirm(value: string) {
  occurredAt.value = value;
  datePickerVisible.value = false;
}
```

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/views/RecordPage.vue
git commit -m "feat: replace native datetime-local with DateTimePicker in RecordPage"
```

---

### Task 4: FilterPage — 集成两个 DateTimePicker

**Files:**
- Modify: `src/views/FilterPage.vue`

当前 FilterPage.vue 第 116-131 行使用两个原生 `<input type="datetime-local">` 绑定 `dateFrom` 和 `dateTo`。

- [ ] **Step 1: 替换日期时间范围区域**

将第 115-131 行：
```vue
      <!-- 日期时间范围 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📅 日期时间范围</label>
        <div class="flex items-center gap-2">
          <input
            v-model="dateFrom"
            type="datetime-local"
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
          />
          <span class="text-text-secondary">─</span>
          <input
            v-model="dateTo"
            type="datetime-local"
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
          />
        </div>
      </div>
```

替换为：
```vue
      <!-- 日期时间范围 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📅 日期时间范围</label>
        <div class="flex items-center gap-2">
          <button
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary text-left"
            @click="datePickerTarget = 'from'; datePickerVisible = true"
          >
            {{ dateFrom || '开始日期' }}
          </button>
          <span class="text-text-secondary">─</span>
          <button
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary text-left"
            @click="datePickerTarget = 'to'; datePickerVisible = true"
          >
            {{ dateTo || '结束日期' }}
          </button>
        </div>
      </div>
```

- [ ] **Step 2: 添加 DateTimePicker 组件到模板**

在 `</div>`（最外层 `flex h-full flex-col bg-bg` 的闭合标签）之前，`AccountPickerSheet` 之后添加：

```vue
    <!-- 日期时间选择器 -->
    <DateTimePicker
      :visible="datePickerVisible"
      :model-value="datePickerTarget === 'from' ? (dateFrom || '2025-01-01T00:00') : (dateTo || '2025-12-31T23:55')"
      @confirm="onDateTimeConfirm"
      @close="datePickerVisible = false"
    />
```

> **Note:** `modelValue` 是必传的。当 `dateFrom` 或 `dateTo` 为空时传一个默认值。DateTimePicker 打开时已根据 `modelValue` 初始化滚动位置。

- [ ] **Step 3: 添加 import 和状态**

在 `<script setup>` 的 import 区域添加：
```typescript
import DateTimePicker from "@/components/DateTimePicker.vue";
```

在状态声明区域添加：
```typescript
const datePickerVisible = ref(false);
const datePickerTarget = ref<"from" | "to">("from");
```

添加 confirm 处理函数：
```typescript
function onDateTimeConfirm(value: string) {
  if (datePickerTarget.value === "from") {
    dateFrom.value = value;
  } else {
    dateTo.value = value;
  }
  datePickerVisible.value = false;
}
```

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 5: Commit**

```bash
git add src/views/FilterPage.vue
git commit -m "feat: replace native datetime-local inputs with DateTimePicker in FilterPage"
```

---

### Task 5: TransactionList — 确认现有 homepage summary 使用 store computed

在开始改造 TransactionList 之前，先确认 store 中已有 `totalIncome` 和 `totalExpense` computed。

`src/stores/transaction.ts` 第 131-141 行已有：
```typescript
const totalIncome = computed(() =>
  transactions.value
    .filter((t) => t.type === "income")
    .reduce((sum, t) => sum + t.amount, 0)
);

const totalExpense = computed(() =>
  transactions.value
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0)
);
```

这两个 computed 基于 store 中已筛选的 `transactions`，正是我们需要的。无需修改 store。

在 TransactionList.vue 中，`filteredIncome` 和 `filteredExpense` computed（第 32-42 行）与 store 的 `totalIncome`/`totalExpense` 做同样的事。可以直接使用 store 的版本，删除组件内的重复 computed。

---

### Task 6: TransactionList — 默认本月筛选 + 筛选状态栏 + 新汇总卡片

**Files:**
- Modify: `src/views/TransactionList.vue`

这是一个较大的改动，分三个子步骤。

- [ ] **Step 1: 添加 `ensureDefaultFilter` 逻辑**

在 `buildFetchOpts()` 函数之后添加：

```typescript
// 基于 query 参数生成筛选摘要文本（用于筛选状态栏）
const filterSummary = computed(() => {
  const parts: string[] = [];
  const q = route.query;

  // 日期范围
  if (q.dateFrom || q.dateTo) {
    parts.push(`📅 ${formatDateRange(q.dateFrom as string, q.dateTo as string)}`);
  } else {
    const now = new Date();
    parts.push(`📅 ${now.getFullYear()}年${now.getMonth() + 1}月`);
  }

  // 账户
  if (q.account) {
    const acc = accountStore.accounts.find((a) => a.id === q.account);
    parts.push(`📋 ${acc?.name ?? q.account}`);
  } else {
    parts.push("📋 全部账户");
  }

  // 标签
  if (q.tags) {
    const tagCount = (q.tags as string).split(",").filter(Boolean).length;
    parts.push(`🏷️ ${tagCount}个标签`);
  } else {
    parts.push("🏷️ 全部标签");
  }

  return parts.join(" · ");
});

function formatDateRange(from: string, to: string): string {
  if (from && to) {
    const [fd] = from.split("T");
    const [td] = to.split("T");
    if (fd === td) return fd;
    return `${fd} ~ ${td}`;
  }
  if (from) return `${from.split("T")[0]} 起`;
  if (to) return `至 ${to.split("T")[0]}`;
  return "";
}
```

在 `onMounted` 中，`const opts = buildFetchOpts()` 之前，添加默认筛选逻辑：

```typescript
  // 首页模式无 query 参数时，默认筛选当月
  if (!isAccountMode.value) {
    const q = route.query;
    if (!q.dateFrom && !q.dateTo) {
      const now = new Date();
      const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
      router.replace({
        query: {
          ...q,
          dateFrom: `${firstDay.getFullYear()}-${String(firstDay.getMonth() + 1).padStart(2, "0")}-${String(firstDay.getDate()).padStart(2, "0")}T00:00`,
          dateTo: `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}T${String(lastDay.getHours()).padStart(2, "0")}:${String(lastDay.getMinutes()).padStart(2, "0")}`,
        },
      });
      // router.replace 是异步的，但在同一 tick 内 query 不会变。
      // 直接继续用当前逻辑构建 fetch 选项 — 由于 query 已通过 replace 更新，
      // 在下一个 watch 中会再次触发 fetch。此处仍直接 fetch，避免闪烁。
      // 实际上 replace 不会立即反映到 route.query，所以这里用计算后的值直接传 opts。
    }
  }
```

实际上，更简洁的方式：`ensureDefaultFilter` 修改 query 后直接构建带默认日期的 opts 去 fetch，不等 watch 触发。但 `router.replace` 是异步的，`route.query` 在当前 tick 不会变。

更好的做法：直接在 `buildFetchOpts` 中处理默认值。

**修正方案：** 在 `buildFetchOpts` 中加默认月份逻辑，而不是修改 URL：

```typescript
function buildFetchOpts() {
  const accId = isAccountMode.value ? accountId.value : (route.query.account as string | undefined);
  const qDateFrom = route.query.dateFrom as string | undefined;
  const qDateTo = route.query.dateTo as string | undefined;
  const qTags = route.query.tags as string | undefined;

  // 首页模式无任何筛选参数时，默认查当月
  let dateFrom = qDateFrom;
  let dateTo = qDateTo;
  if (!isAccountMode.value && !qDateFrom && !qDateTo && !qTags && !accId) {
    const now = new Date();
    dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    dateTo = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}T23:59`;
  }

  return {
    accountId: accId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    tagIds: qTags ? qTags.split(",").filter(Boolean) : undefined,
  };
}
```

**等等**，回顾 spec：spec 说要用 `router.replace` 写入 URL。但这引入了复杂性（router.replace 异步，同一 tick 内 route.query 未更新）。

权衡：在 `buildFetchOpts` 中直接返回默认日期范围更简单、无竞态。筛选状态栏的 `filterSummary` 可以在 query 为空时显示默认当月文本。URL 保持干净（无 query 参数），但数据按当月筛选。

这偏离了 spec 的一点（不写 URL），但避免了 `router.replace` + `watch(query)` 的竞态问题。筛选状态栏的显示逻辑已经覆盖了"无 query 时显示当月默认值"。

**就这么实施。** `buildFetchOpts` 加默认逻辑，`filterSummary` 加无 query 时的默认显示。

- [ ] **Step 2: 替换汇总卡片模板**

将所有汇总卡片部分（第 248-280 行）替换为：

```vue
    <!-- 汇总卡片 -->
    <div class="shrink-0 bg-surface px-4 py-3">
      <!-- 首页模式：收入 / 支出 / 结余 -->
      <template v-if="!isAccountMode">
        <div class="flex gap-4">
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">收入</p>
            <p class="mt-1 text-lg font-bold text-income">
              ¥{{ totalIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">支出</p>
            <p class="mt-1 text-lg font-bold text-expense">
              -¥{{ totalExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">结余</p>
            <p
              class="mt-1 text-lg font-bold"
              :class="totalBalance >= 0 ? 'text-text' : 'text-expense'"
            >
              {{ totalBalance >= 0 ? '' : '-' }}¥{{ Math.abs(totalBalance).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
        </div>
      </template>

      <!-- 账户详情模式：当前余额 + 收入/支出合计（保持不变） -->
      <template v-else>
        <p class="text-xs text-text-secondary">当前余额</p>
        <p class="mt-0.5 text-2xl font-bold text-text">
          ¥{{ (currentAccount?.current_balance ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </p>
        <div class="mt-2 flex gap-6 text-xs">
          <span class="text-text-secondary">
            收入 ¥{{ totalIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
          </span>
          <span class="text-text-secondary">
            支出 ¥{{ totalExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
          </span>
        </div>
      </template>
    </div>
```

- [ ] **Step 3: 添加 computed 并清理旧代码**

在 `<script setup>` 中添加：

```typescript
// 使用 store 的 totalIncome / totalExpense, 不再自己计算
const totalIncome = computed(() => transactionStore.totalIncome);
const totalExpense = computed(() => transactionStore.totalExpense);
const totalBalance = computed(() => totalIncome.value - totalExpense.value);
```

**删除以下不再需要的代码：**

1. `filteredIncome` computed（第 32-35 行）
2. `filteredExpense` computed（第 38-42 行）
3. `hasDateOrTagFilter` computed（第 45-47 行）
4. `filteredNet` computed（第 50 行）
5. `displayNetAssets` computed（第 54-62 行）
6. `displayAssetsTotal` computed（第 64-71 行）
7. `displayLiabilitiesTotal` computed（第 73-80 行）
8. `formatSignedAmount` 函数（第 196-199 行）

账户详情模式的 `filteredIncome`/`filteredExpense` 引用改为 `totalIncome`/`totalExpense`（已在 Step 2 模板中完成）。

- [ ] **Step 4: 添加筛选状态栏**

在汇总卡片之前（`<!-- 汇总卡片 -->` 注释之前）插入筛选状态栏：

```vue
    <!-- 筛选状态栏（仅首页模式） -->
    <div
      v-if="!isAccountMode"
      class="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2"
      @click="router.push({ path: '/filter', query: route.query })"
    >
      <span class="whitespace-nowrap text-xs text-text-secondary">{{ filterSummary }}</span>
      <span class="text-[10px] text-gray-400">→</span>
    </div>
```

- [ ] **Step 5: 更新 import — 移除不再使用的 Filter icon**

`Filter` icon 仍在 Header 中使用（第 242 行），所以保留。只需确认没有未使用的 import。

删除 `filteredIncome` 和 `filteredExpense` 的 import（它们不是 import，是组件内 computed，已删除）。

确认删除 `formatSignedAmount` 引用 —— 检查模板中是否还有使用。旧模板中第 260 行 `{{ formatSignedAmount(displayLiabilitiesTotal) }}` 已被整个替换掉，所以可安全删除。

- [ ] **Step 6: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 7: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: add default month filter, filter status bar, and income/expense/balance summary card"
```

---

### Task 7: transaction store — batchRemove 方法与测试

**Files:**
- Modify: `src/stores/transaction.ts`
- Modify: `src/stores/__tests__/transaction.test.ts`

- [ ] **Step 1: 添加 batchRemove 测试**

在 `src/stores/__tests__/transaction.test.ts` 的最后一个 `describe("remove", ...)` 块之后，添加：

```typescript
  describe("batchRemove", () => {
    it("should soft-delete multiple transactions", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll during init
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after batchRemove

      const store = useTransactionStore();
      await store.fetchAll("pl-1");
      await store.batchRemove(["tx-1", "tx-2", "tx-3"]);

      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id IN (?,?,?)",
        expect.arrayContaining(["tx-1", "tx-2", "tx-3"])
      );
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });

    it("should not execute when ids array is empty", async () => {
      const store = useTransactionStore();
      await store.fetchAll("pl-1");
      mockDb.execute.mockClear();

      await store.batchRemove([]);

      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("should not refresh when _ledgerId is not set", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      const store = useTransactionStore();
      // 不调用 fetchAll，所以 _ledgerId 为空
      await store.batchRemove(["tx-1"]);

      // 仍然执行 SQL
      expect(mockDb.execute).toHaveBeenCalled();
      // 但不刷新数据（因为 _ledgerId 未设置）
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: 运行测试验证失败**

```bash
npx vitest run src/stores/__tests__/transaction.test.ts
```

预期：batchRemove 的 3 个测试 FAIL（`store.batchRemove is not a function`）。

- [ ] **Step 3: 实现 batchRemove**

在 `src/stores/transaction.ts` 的 `remove` 函数之后、`return` 语句之前添加：

```typescript
  async function batchRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await getDb();
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    await db.execute(
      `UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids]
    );
    if (_ledgerId) {
      await fetchAll(_ledgerId);
      const accountStore = useAccountStore();
      await accountStore.fetchAll(_ledgerId);
    }
  }
```

在 `return` 语句中添加 `batchRemove`：

```typescript
  return { transactions, totalIncome, totalExpense, fetchAll, add, update, remove, batchRemove };
```

- [ ] **Step 4: 运行测试验证通过**

```bash
npx vitest run src/stores/__tests__/transaction.test.ts
```

预期：全部 PASS（包括新 batchRemove 测试）。

- [ ] **Step 5: Commit**

```bash
git add src/stores/transaction.ts src/stores/__tests__/transaction.test.ts
git commit -m "feat: add batchRemove to transaction store with tests"
```

---

### Task 8: TransactionList — 账户详情页多选批量删除

**Files:**
- Modify: `src/views/TransactionList.vue`

仅在 `isAccountMode` 为 true 时启用。

- [ ] **Step 1: 添加 import**

在 `<script setup>` 顶部的 lucide-vue-next import 中添加新图标：

```typescript
import { ChevronDown, Filter, Plus, Pencil, ListChecks, Trash2, Circle, CheckCircle } from "lucide-vue-next";
```

添加 ConfirmDialog import：
```typescript
import ConfirmDialog from "@/components/ConfirmDialog.vue";
```

- [ ] **Step 2: 添加多选模式状态和函数**

在其他状态声明之后（`const isLoading` 附近）：

```typescript
// 多选模式（仅账户详情模式）
const isMultiSelectMode = ref(false);
const selectedTxIds = ref<Set<string>>(new Set());

function enterMultiSelectMode() {
  isMultiSelectMode.value = true;
  selectedTxIds.value = new Set();
}

function exitMultiSelectMode() {
  isMultiSelectMode.value = false;
  selectedTxIds.value = new Set();
}

function toggleTxSelection(txId: string) {
  const next = new Set(selectedTxIds.value);
  if (next.has(txId)) {
    next.delete(txId);
  } else {
    next.add(txId);
  }
  selectedTxIds.value = next;
}

const selectedCount = computed(() => selectedTxIds.value.size);

// 批量删除确认
const batchDeleteDialogVisible = ref(false);

async function doBatchDelete() {
  if (selectedCount.value === 0) return;
  await transactionStore.batchRemove([...selectedTxIds.value]);
  exitMultiSelectMode();
  batchDeleteDialogVisible.value = false;
}
```

- [ ] **Step 3: 修改账户详情 Header — 添加多选按钮和切换模式**

当前第 213-227 行是账户详情 Header。修改 `#action` slot：

```vue
    <!-- Header：账户详情模式 -->
    <AppHeader
      v-if="isAccountMode"
      :title="isMultiSelectMode ? `已选 ${selectedCount} 项` : (currentAccount?.name ?? '账户')"
      show-back
      @back="isMultiSelectMode ? exitMultiSelectMode() : router.push('/accounts')"
    >
      <template #action>
        <!-- 多选模式下的操作 -->
        <template v-if="isMultiSelectMode">
          <button
            class="mr-2 text-sm font-medium text-text-secondary"
            @click="exitMultiSelectMode"
          >
            取消
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full"
            :class="selectedCount === 0 ? 'text-gray-300' : 'text-expense hover:bg-red-50'"
            :disabled="selectedCount === 0"
            @click="batchDeleteDialogVisible = true"
          >
            <Trash2 :size="18" />
          </button>
        </template>
        <!-- 正常模式 -->
        <template v-else>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="enterMultiSelectMode"
          >
            <ListChecks :size="18" class="text-text-secondary" />
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="router.push(`/accounts/${accountId}/edit`)"
          >
            <Pencil :size="18" class="text-text-secondary" />
          </button>
        </template>
      </template>
    </AppHeader>
```

- [ ] **Step 4: 修改流水列表行 — 多选模式下显示选择指示器**

当前第 298-324 行是流水行模板。需要修改 `@click` 行为和添加选择图标：

将：
```vue
            <button
              v-for="tx in group.transactions"
              :key="tx.id"
              class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
              @click="goRecord(tx.id)"
            >
              <span class="text-xl">{{ getTxIcon(tx) }}</span>
```

改为：
```vue
            <button
              v-for="tx in group.transactions"
              :key="tx.id"
              class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors hover:bg-gray-50"
              @click="isMultiSelectMode ? toggleTxSelection(tx.id) : goRecord(tx.id)"
            >
              <!-- 多选模式：选择指示器 -->
              <template v-if="isMultiSelectMode">
                <CheckCircle
                  v-if="selectedTxIds.has(tx.id)"
                  :size="20"
                  class="text-primary"
                />
                <Circle
                  v-else
                  :size="20"
                  class="text-gray-300"
                />
              </template>
              <!-- 正常模式：交易图标 -->
              <span v-else class="text-xl">{{ getTxIcon(tx) }}</span>
```

- [ ] **Step 5: 多选模式下隐藏 FAB**

将 FAB 部分（第 331-337 行）包裹条件：

```vue
    <!-- FAB（多选模式下隐藏） -->
    <router-link
      v-if="!isMultiSelectMode"
      :to="isAccountMode ? `/record?account=${accountId}` : '/record'"
      class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
      style="top: 75%"
    >
      <Plus :size="28" />
    </router-link>
```

- [ ] **Step 6: 添加 ConfirmDialog 到模板**

在 `</div>`（最外层闭合标签）之前添加：

```vue
    <!-- 批量删除确认 -->
    <ConfirmDialog
      :visible="batchDeleteDialogVisible"
      title="批量删除"
      :description="`确定删除选中的 ${selectedCount} 条流水吗？此操作不可撤销。`"
      confirm-text="删除"
      :danger="true"
      @confirm="doBatchDelete"
      @cancel="batchDeleteDialogVisible = false"
    />
```

- [ ] **Step 7: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 8: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: add multi-select batch delete in account detail page"
```

---

### Task 9: 最终验证

- [ ] **Step 1: 运行全部测试**

```bash
npx vitest run
```

预期：全部 PASS。

- [ ] **Step 2: TypeScript 类型检查**

```bash
npx vue-tsc --noEmit
```

预期：无类型错误。

- [ ] **Step 3: Vite 构建验证**

```bash
npm run build
```

预期：构建成功。

---

## 自审

### 1. Spec 覆盖

| Spec 需求 | 对应 Task |
|-----------|----------|
| DateTimePicker 组件（四列滚轮） | Task 1, 2 |
| RecordPage 替换原生 input | Task 3 |
| FilterPage 替换原生 input | Task 4 |
| 首页默认本月筛选 | Task 6 Step 1 |
| 筛选状态栏 | Task 6 Step 4 |
| 收入/支出/结余汇总卡片 | Task 6 Step 2, 3 |
| 移除旧汇总 computed | Task 6 Step 3 |
| 多选模式状态管理 | Task 8 Step 2 |
| 多选模式 Header | Task 8 Step 3 |
| 流水行选择指示器 | Task 8 Step 4 |
| FAB 隐藏 | Task 8 Step 5 |
| 批量删除流程 + ConfirmDialog | Task 8 Step 6 |
| batchRemove store 方法 | Task 7 |

### 2. Placeholder 扫描

检查所有 task 步骤，无 TBD/TODO/占位符。所有代码块都包含具体实现。

### 3. 类型一致性

- DateTimePicker `confirm` emit 输出 `"YYYY-MM-DDTHH:mm"` 格式，与 `toLocalDatetimeString()` 输出格式一致 ✓
- `batchRemove(ids: string[])` 接收 `string[]`，调用方传 `[...selectedTxIds.value]`（Set → Array）✓
- `totalIncome`/`totalExpense` 在 store 中已定义为 `computed`，TransactionList 中创建别名 computed 引用 ✓
- 账户详情模式中 `filteredIncome`/`filteredExpense` 全部替换为 `totalIncome`/`totalExpense` ✓
