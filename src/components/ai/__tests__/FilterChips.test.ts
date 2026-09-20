import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import FilterChips from "@/components/ai/FilterChips.vue";
import { appliedToQuery } from "@/services/ai/filterQuery";
import { buildPresetRange } from "@/utils/dateRange";
import type { AppliedFilter } from "@/services/ai/resolve";

/** 真 id（形状照 `tools.ts` 的 applied：chip 里的 id 是本地真值） */
const CAT_ID = "c1a7b8c9-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const ACC_ID = "a1111111-2222-4333-8444-555555555555";

// route.query 可切换：合并变异的红必须看得见"流水页带过来的 uncategorized"，所以它得是真值
const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const push = vi.hoisted(() => vi.fn());

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {}, query: routeQuery.value }),
  useRouter: () => ({ push }),
}));

function makeApplied(over: Partial<AppliedFilter> = {}): AppliedFilter {
  return {
    dateFrom: null,
    dateTo: null,
    type: null,
    categories: [],
    account: null,
    tags: [],
    members: [],
    merchant: null,
    amountMin: null,
    amountMax: null,
    ...over,
  };
}

beforeEach(() => {
  push.mockClear();
  routeQuery.value = {};
});

describe("FilterChips", () => {
  it("点击芯片 push 到流水页，query 与 appliedToQuery(芯片) 逐键相等", () => {
    // ⚠️ route.query 里**必须**有一个既有键：留着空对象时 `{...route.query, ...q}` 与 `q` 等价，
    // 这条断言对"合并 vs 替换"就是**空转**的（变异实测：空 route.query 下它照绿）。
    // 流水页的真实前置条件本来也不空（从首页过来总带着模式键），所以这不是人造场景。
    routeQuery.value = { mode: "ledger" };
    // 日期用**运行时算出来的**本月：写死 "2026-08-01"~"2026-08-31" 会在跨月时变成别的预设的标签
    // （实测：9 月跑时它同时是「上月」与「近3月」的区间，标签是不是「本月」取决于跑的日子）。
    const thisMonth = buildPresetRange("thisMonth", new Date());
    const chip = makeApplied({
      dateFrom: thisMonth.start,
      dateTo: thisMonth.end,
      type: "expense",
      categories: [{ id: CAT_ID, name: "买菜" }],
    });
    const w = mount(FilterChips, { props: { chips: [chip] } });

    expect(w.findAll('[data-test="filter-chip"]')).toHaveLength(1);
    expect(w.get('[data-test="filter-chip"]').text()).toBe("本月 · 支出 · 买菜");

    void w.get('[data-test="filter-chip"]').trigger("click");
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ path: "/", query: appliedToQuery(chip) });
    expect(Object.keys((push.mock.calls[0]![0] as { query: Record<string, string> }).query)).not.toContain("mode");
  });

  it("区间同时命中多个预设时取 PRESETS 里更靠前的那条（本月 ≈ 近3月的月初重叠）", () => {
    // 实测的歧义：跑在 9 月初时 thisMonth 与 last3Months 的区间**完全相同**，
    // 而同一个区间在 8 月跑会显示成「上月」—— 也就是说"标签是什么"取决于遍历顺序。
    // PRESETS 的顺序是仓内"高频在前"的唯一排序（`matchPreset` 用的也是它），这里钉住用的是它。
    const now = new Date();
    const thisMonth = buildPresetRange("thisMonth", now);
    const last3 = buildPresetRange("last3Months", now);
    const w = mount(FilterChips, {
      props: { chips: [makeApplied({ dateFrom: last3.start, dateTo: last3.end })] },
    });
    const label = w.get('[data-test="filter-chip"]').text();
    // 本月与近3月重叠时（月初）取「本月」（PRESETS 里本月在前）；否则近3月是唯一的命中
    const expected = thisMonth.start === last3.start && thisMonth.end === last3.end ? "本月" : "近3月";
    expect(label).toBe(expected);
  });

  it("**整体替换**：流水页已有 uncategorized=1 时，点芯片后的 query 里没有 uncategorized（M1 陷阱哨兵）", () => {
    // M1 实测：`{...route.query, ...}` 会把流水页带过来的 uncategorized=1 叠上，21 条静默变 4 条。
    // 这条用例先**制造**那个前置条件（route.query 里真有 uncategorized），再点芯片。
    routeQuery.value = { uncategorized: "1" };
    const chip = makeApplied({ dateFrom: "2026-08-01", dateTo: "2026-08-31" });

    const w = mount(FilterChips, { props: { chips: [chip] } });
    void w.get('[data-test="filter-chip"]').trigger("click");

    const arg = push.mock.calls[0]![0] as { path: string; query: Record<string, string> };
    expect(arg.path).toBe("/");
    expect(Object.keys(arg.query)).not.toContain("uncategorized");
    // 键集合与 appliedToQuery 的契约完全一致（不是"少了 uncategorized 但多了别的"）
    expect(arg.query).toEqual(appliedToQuery(chip));
    expect(arg.query).toEqual({ dateFrom: "2026-08-01", dateTo: "2026-08-31" });
  });

  it("流水页的其他既有条件也一并被替换掉（不是只挡 uncategorized 一个键）", () => {
    // 只挡 uncategorized 的实现能过上面那条、过不了这条：任何"读 side 独有"的键都不该被带过去
    routeQuery.value = { uncategorized: "1", tags: "t-stale", note: "上一个关键词", page: "3" };
    const chip = makeApplied({ type: "income" });

    const w = mount(FilterChips, { props: { chips: [chip] } });
    void w.get('[data-test="filter-chip"]').trigger("click");

    const arg = push.mock.calls[0]![0] as { query: Record<string, string> };
    expect(arg.query).toEqual({ type: "income" });
  });

  it("日期芯片用 buildPresetRange 的中文预设标签渲染", () => {
    const thisMonth = buildPresetRange("thisMonth", new Date());
    const w = mount(FilterChips, {
      props: { chips: [makeApplied({ dateFrom: thisMonth.start, dateTo: thisMonth.end })] },
    });
    expect(w.get('[data-test="filter-chip"]').text()).toBe("本月");
    // 反面对照：标签不是那个预设的两端日期串
    expect(w.get('[data-test="filter-chip"]').text()).not.toContain(thisMonth.start);
  });

  it("对不上预设的区间显示具体日期，不显示裸 id", () => {
    const w = mount(FilterChips, {
      props: {
        chips: [makeApplied({ dateFrom: "2026-08-03", dateTo: "2026-08-20", account: { id: ACC_ID, name: "招行" } })],
      },
    });
    const text = w.get('[data-test="filter-chip"]').text();
    expect(text).toContain("招行");
    expect(text).toContain("3日");
    expect(text).not.toContain(ACC_ID);
    expect(text).not.toContain("account");
  });

  it("形状不全的芯片被跳过，好的仍然渲染（一条坏芯片不该让整排消失）", () => {
    const w = mount(FilterChips, {
      props: { chips: [null, "x", { type: "expense" }, 42, makeApplied({ merchant: "盒马" })] },
    });
    const chips = w.findAll('[data-test="filter-chip"]');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.text()).toBe("备注：盒马");
  });

  it("没有可渲染的芯片时整排不出现（零条件不该给一个点了没反应的入口）", () => {
    const w = mount(FilterChips, { props: { chips: [] } });
    expect(w.find('[data-test="filter-chips"]').exists()).toBe(false);
  });

  it("金额下界为 0 时保留（0 是有效下界，真值判断会把它当「没给」丢掉）", () => {
    const w = mount(FilterChips, { props: { chips: [makeApplied({ amountMin: 0, amountMax: 500 })] } });
    expect(w.get('[data-test="filter-chip"]').text()).toBe("0-500");
    void w.get('[data-test="filter-chip"]').trigger("click");
    expect((push.mock.calls[0]![0] as { query: Record<string, string> }).query).toEqual({
      amountMin: "0",
      amountMax: "500",
    });
  });
});
