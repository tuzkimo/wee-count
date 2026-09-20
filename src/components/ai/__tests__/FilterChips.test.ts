import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import FilterChips from "@/components/ai/FilterChips.vue";
import { appliedToQuery } from "@/services/ai/filterQuery";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
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

  it("芯片数量有上限：只渲染**前 N 条**、顺序照 payload 原序（不是挑几条、也不是倒序）", () => {
    // 11 条**互不相同**的备注芯片（同一种形状、只差文案）⇒ 能同时判别"截断了几条"与"留的是哪几条"。
    // 夹具故意多于任何合理的上限，且**不**写死那个数字（上限是产品取舍，不是规格条款）。
    const many = Array.from({ length: 11 }, (_, i) => makeApplied({ merchant: `店${i}` }));
    const w = mount(FilterChips, { props: { chips: many } });
    const texts = w.findAll('[data-test="filter-chip"]').map((c) => c.text());

    // ① 确实截断了（否则"上限"这个行为根本不存在，下面两条会恒真）
    expect(texts.length).toBeLessThan(many.length);
    // ② 留的是**前缀**且**保持原序**：杀手 —— 用 `chips.slice(-N)`（留末尾）或集合去重/排序 ⇒ 红
    expect(texts).toEqual(many.slice(0, texts.length).map((c) => `备注：${c.merchant}`));
    // ③ 至少给得出不止一条（否则"下钻入口"这个用途不成立）
    expect(texts.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// §7.4：芯片上的金额条件也是**金额出口**（历史消息跟着遮）
// ---------------------------------------------------------------------------
describe("FilterChips 金额遮罩（§7.4）", () => {
  it("masked ⇒ 上下界都换成占位符，比较符号保留（用户仍看得出「这是金额条件」）", () => {
    const w = mount(FilterChips, {
      props: { chips: [makeApplied({ amountMin: 500, amountMax: 2000 })], masked: true },
    });
    // 杀手：`otherLabels` 里不判 `masked`（照旧拼 `${a.amountMin}-${a.amountMax}`）⇒ 这条红
    expect(w.get('[data-test="filter-chip"]').text()).toBe(`${AMOUNT_PLACEHOLDER}-${AMOUNT_PLACEHOLDER}`);
    // 反向断言：真值一个字符都不许上屏（否则"只断言占位符在"可能恒真）
    expect(w.get('[data-test="filter-chip"]').text()).not.toContain("500");

    const single = mount(FilterChips, {
      props: { chips: [makeApplied({ amountMin: 500 })], masked: true },
    });
    expect(single.get('[data-test="filter-chip"]').text()).toBe(`≥${AMOUNT_PLACEHOLDER}`);
  });

  it("masked=false / 未传（历史之外）⇒ 显示真数字，与今天完全一致", () => {
    const plain = mount(FilterChips, {
      props: { chips: [makeApplied({ amountMin: 500, amountMax: 2000 })], masked: false },
    });
    expect(plain.get('[data-test="filter-chip"]').text()).toBe("500-2000");
    const legacy = mount(FilterChips, {
      props: { chips: [makeApplied({ amountMin: 500, amountMax: 2000 })] },
    });
    expect(legacy.get('[data-test="filter-chip"]').text()).toBe("500-2000");
  });

  it("遮罩只改屏幕上的字，不改跳转条件（点进去仍是那批流水）", () => {
    const chip = makeApplied({ amountMin: 500, amountMax: 2000 });
    const w = mount(FilterChips, { props: { chips: [chip], masked: true } });
    void w.get('[data-test="filter-chip"]').trigger("click");
    // 杀手：顺手把 applied 也改了 ⇒ 这条红（下钻会跳到"筛掉一切"的空白流水页）
    expect(push).toHaveBeenCalledWith({ path: "/", query: appliedToQuery(chip) });
  });
});
