<!-- src/views/ReportsPage.vue -->
<script setup lang="ts">
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useReports } from "@/composables/useReports";
import LineChart from "@/components/charts/LineChart.vue";
import DonutChart from "@/components/charts/DonutChart.vue";
import { toLocalDatetimeString } from "@/utils/datetime";

const router = useRouter();
const { unit, data, breakdownType, deltas, setUnit, shift } = useReports();

const UNITS: { key: "month" | "quarter" | "year" | "twelveMonths"; label: string }[] = [
  { key: "month", label: "月" },
  { key: "quarter", label: "季" },
  { key: "year", label: "年" },
  { key: "twelveMonths", label: "近12月" },
];

const breakdown = computed(() =>
  breakdownType.value === "expense" ? data.value?.breakdownExpense : data.value?.breakdownIncome
);

const INCOME_COLOR = "#22c55e";
const EXPENSE_COLOR = "#ef4444";
const NET_COLOR = "#3b82f6";

// 8 槽分类色板（dataviz 校验）；"其他" 恒灰，排行超 8 项循环用色
const PALETTE = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
];
function segmentColor(seg: { id: string | null; isMerge?: boolean }, i: number): string {
  if (seg.isMerge) return "#9ca3af";
  return PALETTE[i % PALETTE.length];
}

const donutSegments = computed<{ id: string | null; name: string; total: number; color: string }[]>(
  () => (breakdown.value?.segments ?? []).map((s, i) => ({
    id: s.id, name: s.name, total: s.total, color: segmentColor(s, i),
  }))
);

function formatMoney(n: number): string {
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function onSegmentClick(seg: { id: string | null }): void {
  if (!data.value) return;
  if (seg.id === "other") return; // 合并项不可下钻
  const { start, end } = data.value.range;
  const q: Record<string, string> = {
    dateFrom: toLocalDatetimeString(start),
    dateTo: toLocalDatetimeString(new Date(end.getTime() - 1)),
  };
  if (seg.id === null) q.uncategorized = "1";
  else q.categories = seg.id;
  void router.push({ path: "/filter", query: q });
}

function netAssetValue(): string {
  const v = data.value?.netAsset.values;
  return v && v.length > 0 ? formatMoney(v[v.length - 1]) : "0.00";
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <!-- 顶栏：周期切换 -->
    <div class="flex min-h-14 items-center gap-1 border-b border-gray-200 bg-surface px-3 py-2">
      <button
        data-test="prev-period"
        class="px-2 text-lg text-text-secondary" aria-label="上一周期"
        @click="shift(-1)"
      >‹</button>
      <div class="flex flex-1 flex-col items-center">
        <span class="text-sm font-semibold text-text">{{ data?.label ?? "—" }}</span>
        <div class="mt-0.5 flex gap-1">
          <button
            v-for="u in UNITS" :key="u.key"
            class="rounded-full px-2 py-0.5 text-xs transition-colors"
            :class="unit === u.key ? 'bg-primary text-white' : 'text-text-secondary'"
            @click="setUnit(u.key)"
          >{{ u.label }}</button>
        </div>
      </div>
      <button
        data-test="next-period"
        class="px-2 text-lg text-text-secondary" aria-label="下一周期"
        @click="shift(1)"
      >›</button>
    </div>

    <div class="flex-1 overflow-y-auto px-4 py-4">
      <!-- 空态 -->
      <div v-if="!data" class="py-20 text-center text-sm text-text-secondary">
        <p class="text-4xl">📊</p>
        <p class="mt-2">暂无数据</p>
      </div>

      <template v-else>
        <!-- ① 总览卡片 -->
        <section class="mb-4 grid grid-cols-3 gap-3">
          <div class="rounded-2xl bg-surface p-3">
            <p class="text-xs text-text-secondary">收入</p>
            <p class="mt-1 text-lg font-semibold" :style="{ color: INCOME_COLOR }">{{ formatMoney(data.totals.income) }}</p>
            <p class="mt-0.5 text-xs" :class="(deltas.incomeDeltaPct ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'">
              {{ deltas.incomeDeltaPct === null ? "—" : `${deltas.incomeDeltaPct > 0 ? "+" : ""}${deltas.incomeDeltaPct}%` }}
            </p>
          </div>
          <div class="rounded-2xl bg-surface p-3">
            <p class="text-xs text-text-secondary">支出</p>
            <p class="mt-1 text-lg font-semibold" :style="{ color: EXPENSE_COLOR }">{{ formatMoney(data.totals.expense) }}</p>
            <p class="mt-0.5 text-xs" :class="(deltas.expenseDeltaPct ?? 0) <= 0 ? 'text-green-600' : 'text-red-600'">
              {{ deltas.expenseDeltaPct === null ? "—" : `${deltas.expenseDeltaPct > 0 ? "+" : ""}${deltas.expenseDeltaPct}%` }}
            </p>
          </div>
          <div class="rounded-2xl bg-surface p-3">
            <p class="text-xs text-text-secondary">结余</p>
            <p class="mt-1 text-lg font-semibold text-text">{{ formatMoney(data.totals.balance) }}</p>
            <p class="mt-0.5 text-xs text-text-secondary">比上周期</p>
          </div>
        </section>

        <!-- ② 收支趋势 -->
        <section class="mb-4 rounded-2xl bg-surface p-4">
          <h2 class="mb-2 text-sm font-semibold text-text">收支趋势</h2>
          <LineChart
            v-if="data.trend.labels.length > 0"
            :labels="data.trend.labels"
            :series="[
              { name: '收入', color: INCOME_COLOR, values: data.trend.income },
              { name: '支出', color: EXPENSE_COLOR, values: data.trend.expense },
            ]"
          />
          <p v-else class="py-8 text-center text-xs text-text-secondary">本期暂无流水</p>
        </section>

        <!-- ③ 分类统计 -->
        <section class="mb-4 rounded-2xl bg-surface p-4">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-text">分类统计</h2>
            <div class="flex gap-1 rounded-full bg-gray-100 p-0.5">
              <button
                v-for="t in (['expense', 'income'] as const)" :key="t"
                class="rounded-full px-3 py-0.5 text-xs transition-colors"
                :class="breakdownType === t ? 'bg-primary text-white' : 'text-text-secondary'"
                @click="breakdownType = t"
              >{{ t === 'expense' ? '支出' : '收入' }}</button>
            </div>
          </div>
          <!-- 判空用 total > 0：DonutChart 按几何输入渲染，零值单扇区 [0] 会走整圆分支渲染满环（Task 3 评审遗留） -->
          <template v-if="breakdown && breakdown.total > 0">
            <DonutChart
              :segments="donutSegments"
              :center-label="breakdownType === 'expense' ? '总支出' : '总收入'"
              :center-value="formatMoney(breakdown.total)"
              @segment-click="onSegmentClick"
            />
            <ul class="category-list mt-3 space-y-2">
              <li
                v-for="(seg, i) in breakdown.list" :key="seg.id ?? 'uncat'"
                class="flex cursor-pointer items-center gap-2 text-sm"
                @click="onSegmentClick(seg)"
              >
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ backgroundColor: segmentColor(seg, i) }" />
                <span class="text-base">{{ seg.icon }}</span>
                <span class="flex-1 truncate text-text">{{ seg.name }}</span>
                <span class="text-xs text-text-secondary">{{ seg.percent }}%</span>
                <span class="w-20 text-right font-medium text-text">{{ formatMoney(seg.total) }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="py-8 text-center text-xs text-text-secondary">本期暂无数据</p>
        </section>

        <!-- ④ 账户资产变动 -->
        <section class="mb-4 rounded-2xl bg-surface p-4">
          <div class="mb-2 flex items-baseline justify-between">
            <h2 class="text-sm font-semibold text-text">账户资产变动</h2>
            <span class="text-xs text-text-secondary">
              期末净资产 <span class="font-semibold text-text">{{ netAssetValue() }}</span>
            </span>
          </div>
          <LineChart
            v-if="data.netAsset.values.length > 0"
            :labels="data.netAsset.labels"
            :series="[{ name: '净资产', color: NET_COLOR, values: data.netAsset.values }]"
          />
          <p v-else class="py-8 text-center text-xs text-text-secondary">本期暂无数据</p>
        </section>
      </template>
    </div>
  </div>
</template>
