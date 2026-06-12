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
