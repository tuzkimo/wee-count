import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { ref, computed } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { toLocalDatetimeString } from "@/utils/datetime";
import { usePrefsStore } from "@/stores/prefs";
import LineChart from "@/components/charts/LineChart.vue";
import DonutChart from "@/components/charts/DonutChart.vue";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
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
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    expect(w.text()).toContain("2026年8月");
    expect(w.text()).toContain("收入");
    expect(w.text()).toContain("支出");
    expect(w.text()).toContain("净资产");
  });
  it("calls shift when arrow buttons tapped", async () => {
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    await w.find('[data-test="prev-period"]').trigger("click");
    expect(shift).toHaveBeenCalledWith(-1);
  });
  it("shows empty state when data is null", async () => {
    data.value = null;
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    expect(w.text()).toContain("暂无数据");
    data.value = makeData();
  });
  it("shows loading state while loading with no data yet", async () => {
    data.value = null;
    loading.value = true;
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    expect(w.text()).toContain("加载中");
    loading.value = false;
    data.value = makeData();
  });
  it("shows error state with retry when load failed", async () => {
    data.value = null;
    error.value = "no such column: occurred_at";
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    expect(w.text()).toContain("加载失败");
    expect(w.text()).toContain("no such column: occurred_at");
    await w.find('[data-test="report-retry"]').trigger("click");
    expect(reload).toHaveBeenCalled();
    error.value = null;
    data.value = makeData();
  });
  it("drills down a category to the transaction list with preset query", async () => {
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    await w.find(".category-list li").trigger("click");
    const { start, end } = data.value!.range;
    expect(push).toHaveBeenCalledWith({
      path: "/",
      query: {
        categories: "c1",
        dateFrom: toLocalDatetimeString(start),
        dateTo: toLocalDatetimeString(end), // 排他区间 [start, end) 精确边界，非 end-1ms
      },
    });
  });

  it("默认遮蔽汇总金额，渲染结果不含真实数字", async () => {
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    // 六处汇总金额的真值都必须缺席：收入 3 / 支出 1 / 结余 2 / 期末净资产 105（netAsset 末值）
    // / 分类合计 1（breakdown.total + breakdown.list[0].total）。涨跌幅百分比渲染为 "+10%" 之类，
    // 与 "X.00" 形态不冲突，不会误伤。
    expect(w.text()).toContain(AMOUNT_PLACEHOLDER);
    expect(w.text()).not.toContain("105.00");
    expect(w.text()).not.toContain("3.00");
    expect(w.text()).not.toContain("2.00");
    expect(w.text()).not.toContain("1.00");
  });

  // 结构断言，不是布局断言：happy-dom 没有布局引擎，无法测量「省下了一行高度」或
  // 「4 个点是否真的装进卡片」。这里只钉住 DOM 结构（眼睛挂在总览 section 上、
  // 绝对定位、且不再被一个占位的 wrapper div 包着）与窄布局的收缩类名，
  // 真实观感必须靠真机/浏览器复看。
  it("眼睛按钮绝对定位在总览 section 内，不再单独占一行", async () => {
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();

    const toggle = w.find('[data-test="amount-mask-toggle"]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.classes()).toContain("absolute");

    const section = toggle.element.closest("section");
    expect(section).not.toBeNull();
    // 父节点就是 section：原来的 <div class="mb-1 flex justify-end"> 已删除
    expect(toggle.element.parentElement).toBe(section);
    expect(section!.className).toContain("relative");
    expect(section!.className).toContain("mb-4");
    // 同一个 section 里仍是那三列总览网格
    expect(section!.querySelectorAll(".grid.grid-cols-3 > div")).toHaveLength(3);
  });

  it("总览三列的子项可收缩，蔽态金额不换行", async () => {
    const w = mount(ReportsPage, {
      global: { plugins: [createPinia()], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();

    const cells = w.findAll(".grid.grid-cols-3 > div");
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.classes()).toContain("min-w-0");
      const amount = cell.find("p.mt-1");
      expect(amount.text()).toBe(AMOUNT_PLACEHOLDER);
      // 遮蔽态：降一档字号 + 不换行；leading-7 与 text-lg 默认行高同为 1.75rem，行高不变
      expect(amount.classes()).toContain("text-sm");
      expect(amount.classes()).toContain("leading-7");
      expect(amount.classes()).toContain("whitespace-nowrap");
    }
  });

  it("点击眼睛按钮后显示真实金额", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const w = mount(ReportsPage, {
      global: { plugins: [pinia], stubs: { LineChart: true, DonutChart: true } },
    });
    await flushPromises();
    // 遮蔽态先坐实，否则「点击后显示真值」可能是本来就显示
    expect(w.text()).toContain(AMOUNT_PLACEHOLDER);
    // 真实点击页面上的眼睛按钮，覆盖 <AmountMaskToggle /> 的存在性与点击联通性
    await w.find('[data-test="amount-mask-toggle"]').trigger("click");
    await flushPromises();
    expect(w.text()).toContain("105.00");
    expect(w.text()).toContain("3.00");
    expect(w.text()).toContain("1.00");
    expect(w.text()).toContain("2.00");
    expect(w.text()).not.toContain(AMOUNT_PLACEHOLDER);
  });

  // 两张图（② 收支趋势、④ 账户资产变动）的 y 轴刻度与 tooltip 都会渲染汇总金额，
  // 上面的用例把 LineChart stub 掉了，测不到 mask-values 接线，故此处用真实组件钉住。
  // DonutChart 用 stub 挂载，但其 props 仍由 VTU 保留，故同样在此断言中心值接线。
  it("两个 LineChart 的 maskValues 与 DonutChart 中心值均跟随遮蔽开关", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const w = mount(ReportsPage, { global: { plugins: [pinia], stubs: { DonutChart: true } } });
    await flushPromises();

    const masked = w.findAllComponents(LineChart);
    expect(masked).toHaveLength(2);
    for (const chart of masked) {
      expect(chart.props("maskValues")).toBe(true);
    }
    expect(w.findComponent(DonutChart).props("centerValue")).toBe(AMOUNT_PLACEHOLDER);

    usePrefsStore().showAmounts();
    await flushPromises();
    const shown = w.findAllComponents(LineChart);
    expect(shown).toHaveLength(2);
    for (const chart of shown) {
      expect(chart.props("maskValues")).toBe(false);
    }
    expect(w.findComponent(DonutChart).props("centerValue")).toBe("1.00");
  });
});
