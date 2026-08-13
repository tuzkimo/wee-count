import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref, computed } from "vue";
import { toLocalDatetimeString } from "@/utils/datetime";
import type { ReportData } from "@/services/reports";

const setUnit = vi.fn(); const shift = vi.fn(); const reload = vi.fn();
const push = vi.fn();

function makeData(): ReportData {
  return {
    label: "2026年8月",
    range: { start: new Date(2026, 7, 1), end: new Date(2026, 8, 1) },
    prevRange: { start: new Date(2026, 6, 1), end: new Date(2026, 7, 1) },
    granularity: "day",
    trend: { labels: ["2026-08-01", "2026-08-02"], income: [1, 2], expense: [0, 1] },
    totals: { income: 3, expense: 1, balance: 2 },
    prevTotals: { income: 3, expense: 1, balance: 2 },
    breakdownExpense: {
      segments: [{ id: "c1", name: "餐饮", icon: "🍜", total: 1, percent: 100 }],
      list: [{ id: "c1", name: "餐饮", icon: "🍜", total: 1, percent: 100 }],
      total: 1,
    },
    breakdownIncome: { segments: [], list: [], total: 0 },
    netAsset: { labels: ["2026-08-01", "2026-08-02"], values: [100, 105] },
  };
}
const data = ref<ReportData | null>(makeData());
const loading = ref(false);
const error = ref<string | null>(null);

vi.mock("@/composables/useReports", () => ({
  useReports: () => ({
    unit: ref("month"), offset: ref(0), loading, data, error,
    breakdownType: ref("expense"),
    deltas: computed(() => ({ incomeDeltaPct: 10, expenseDeltaPct: null })),
    setUnit, shift, reload,
  }),
}));
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ currentLedger: ref({ id: "l1", name: "账本", type: "personal" }) }),
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));

import ReportsPage from "@/views/ReportsPage.vue";

describe("ReportsPage", () => {
  it("renders the period label and all four sections", async () => {
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    expect(w.text()).toContain("2026年8月");
    expect(w.text()).toContain("收入");
    expect(w.text()).toContain("支出");
    expect(w.text()).toContain("净资产");
  });
  it("calls shift when arrow buttons tapped", async () => {
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    await w.find('[data-test="prev-period"]').trigger("click");
    expect(shift).toHaveBeenCalledWith(-1);
  });
  it("shows empty state when data is null", async () => {
    data.value = null;
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    expect(w.text()).toContain("暂无数据");
    data.value = makeData();
  });
  it("shows loading state while loading with no data yet", async () => {
    data.value = null;
    loading.value = true;
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    expect(w.text()).toContain("加载中");
    loading.value = false;
    data.value = makeData();
  });
  it("shows error state with retry when load failed", async () => {
    data.value = null;
    error.value = "no such column: occurred_at";
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    expect(w.text()).toContain("加载失败");
    expect(w.text()).toContain("no such column: occurred_at");
    await w.find('[data-test="report-retry"]').trigger("click");
    expect(reload).toHaveBeenCalled();
    error.value = null;
    data.value = makeData();
  });
  it("drills down a category to /filter with preset query", async () => {
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    await w.find(".category-list li").trigger("click");
    const { start, end } = data.value!.range;
    expect(push).toHaveBeenCalledWith({
      path: "/filter",
      query: {
        categories: "c1",
        dateFrom: toLocalDatetimeString(start),
        dateTo: toLocalDatetimeString(end), // 排他区间 [start, end) 精确边界，非 end-1ms
      },
    });
  });
});
