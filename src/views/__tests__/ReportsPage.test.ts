import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref, computed } from "vue";
import type { ReportData } from "@/services/reports";

const setUnit = vi.fn(); const shift = vi.fn();
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

vi.mock("@/composables/useReports", () => ({
  useReports: () => ({
    unit: ref("month"), offset: ref(0), loading: ref(false), data,
    breakdownType: ref("expense"),
    deltas: computed(() => ({ incomeDeltaPct: 10, expenseDeltaPct: null })),
    setUnit, shift, reload: vi.fn(),
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
  it("drills down a category to /filter with preset query", async () => {
    const w = mount(ReportsPage, { global: { stubs: { LineChart: true, DonutChart: true } } });
    await flushPromises();
    await w.find(".category-list li").trigger("click");
    expect(push).toHaveBeenCalledWith({
      path: "/filter",
      query: expect.objectContaining({ categories: "c1" }),
    });
  });
});
