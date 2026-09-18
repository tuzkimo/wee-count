import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DateRangePicker from "@/components/DateRangePicker.vue";
import type { Category, TagWithUsage } from "@/types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  query: {} as Record<string, string>,
  fetchAccounts: vi.fn(),
  fetchTags: vi.fn(),
  fetchCategories: vi.fn(),
  init: vi.fn(),
  tags: [] as TagWithUsage[],
  categories: [] as Category[],
}));

function makeTag(over: Partial<TagWithUsage> = {}): TagWithUsage {
  return {
    id: "t1",
    ledger_id: "ledger-1",
    name: "旅行",
    updated_at: "2026-01-01T00:00:00.000Z",
    is_deleted: false,
    usage_count: 0,
    ...over,
  };
}

function makeCategory(over: Partial<Category> = {}): Category {
  return {
    id: "c1",
    ledger_id: "ledger-1",
    owner_id: "u1",
    name: "餐饮",
    type: "expense",
    icon: "☕",
    sort_order: 0,
    updated_at: "2026-01-01T00:00:00.000Z",
    is_deleted: false,
    ...over,
  };
}

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: mocks.query }),
  useRouter: () => ({ push: mocks.push, back: mocks.back }),
}));

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    init: mocks.init,
    // 个人账本：跳过团队成员分支，测试聚焦日期范围
    currentLedger: { id: "ledger-1", type: "personal", team_id: null },
  }),
}));

vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({ accounts: [], fetchAll: mocks.fetchAccounts }),
}));

vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({
    // getter 解包，保留响应式；每个用例自行填充 mocks.tags
    get tags() {
      return mocks.tags;
    },
    fetchAll: mocks.fetchTags,
  }),
}));

vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({
    get categories() {
      return mocks.categories;
    },
    fetchAll: mocks.fetchCategories,
  }),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: null }),
}));

vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "u1",
  getTeamMembers: vi.fn().mockResolvedValue([]),
  getMemberAliases: vi.fn().mockResolvedValue([]),
  upsertTeamMembers: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  fetchTeamMembers: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/composables/useMemberInfo", () => ({
  useMemberInfo: () => ({ getMember: vi.fn().mockResolvedValue({ displayName: "u1" }) }),
}));

import FilterPage from "@/views/FilterPage.vue";

function mountPage() {
  return mount(FilterPage, {
    global: {
      plugins: [createPinia()],
      // Teleport 内容在 happy-dom 下不在 wrapper 内，stub 成透传
      stubs: { Teleport: true, Transition: false },
    },
  });
}

function buttonByText(wrapper: ReturnType<typeof mountPage>, text: string) {
  return wrapper.findAll("button").find((b) => b.text() === text)!;
}

describe("FilterPage 日期范围", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.push.mockReset();
    mocks.back.mockReset();
    mocks.query = {};
  });

  it("无筛选时显示「全部时间」", async () => {
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.find('[data-test="date-range-trigger"]').text()).toContain("全部时间");
  });

  it("从 query 恢复带时分的旧链接时按 day 粒度截断展示", async () => {
    mocks.query = { dateFrom: "2026-08-01T00:00", dateTo: "2026-08-31T23:59" };
    const wrapper = mountPage();
    await flushPromises();
    expect(wrapper.find('[data-test="date-range-trigger"]').text()).toContain(
      "2026年8月1日 - 8月31日 · 31天"
    );
  });

  it("应用筛选回写不带时分的日期串", async () => {
    mocks.query = { dateFrom: "2026-08-01T00:00", dateTo: "2026-08-31T23:59" };
    const wrapper = mountPage();
    await flushPromises();
    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/",
      query: { dateFrom: "2026-08-01", dateTo: "2026-08-31" },
    });
  });

  it("点开触发器挂载选择器，确认后回填范围并回写 query", async () => {
    const wrapper = mountPage();
    await flushPromises();
    await wrapper.find('[data-test="date-range-trigger"]').trigger("click");

    const picker = wrapper.findComponent(DateRangePicker);
    expect(picker.props("visible")).toBe(true);
    expect(picker.props("modelValue")).toEqual({ start: "", end: "" });

    picker.vm.$emit("confirm", { start: "2026-08-05", end: "2026-08-20" });
    await flushPromises();
    expect(picker.props("visible")).toBe(false);
    expect(wrapper.find('[data-test="date-range-trigger"]').text()).toContain(
      "2026年8月5日 - 8月20日 · 16天"
    );

    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/",
      query: { dateFrom: "2026-08-05", dateTo: "2026-08-20" },
    });
  });

  it("支持只选一端（从某日起）", async () => {
    const wrapper = mountPage();
    await flushPromises();
    wrapper.findComponent(DateRangePicker).vm.$emit("confirm", { start: "2026-08-05", end: "" });
    await flushPromises();
    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: { dateFrom: "2026-08-05" } });
  });

  it("重置清空日期范围", async () => {
    mocks.query = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    const wrapper = mountPage();
    await flushPromises();
    await buttonByText(wrapper, "重置").trigger("click");
    expect(wrapper.find('[data-test="date-range-trigger"]').text()).toContain("全部时间");
    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: {} });
  });
});

describe("FilterPage 标签搜索", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.push.mockReset();
    mocks.query = {};
    mocks.tags = [
      makeTag({ id: "t1", name: "旅行", usage_count: 5 }),
      makeTag({ id: "t2", name: "工作", usage_count: 1 }),
      makeTag({ id: "t3", name: "工作餐", usage_count: 0 }),
    ];
  });

  function chipTexts(wrapper: ReturnType<typeof mountPage>) {
    return wrapper.findAll('[data-test="tag-chip"]').map((c) => c.text());
  }

  it("关键词只保留命中的标签", async () => {
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="tag-search"]').setValue("工作");

    expect(chipTexts(wrapper)).toHaveLength(2);
    expect(wrapper.text()).not.toContain("旅行");
  });

  it("无命中时提示未找到标签", async () => {
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="tag-search"]').setValue("不存在的标签");

    expect(chipTexts(wrapper)).toHaveLength(0);
    expect(wrapper.text()).toContain("未找到标签");
  });

  it("已选标签不命中关键词时仍可见且排在最前", async () => {
    mocks.query = { tags: "t1" };
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="tag-search"]').setValue("工作");

    const texts = chipTexts(wrapper);
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain("旅行");
  });

  it("清空按钮清掉已选标签，应用筛选后 query 不含 tags", async () => {
    mocks.query = { tags: "t1,t2" };
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.text()).toContain("已选 2 个");
    await buttonByText(wrapper, "清空").trigger("click");
    expect(wrapper.text()).not.toContain("已选 2 个");

    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: {} });
  });
});

describe("FilterPage 分类分组", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.push.mockReset();
    mocks.query = {};
    mocks.categories = [
      makeCategory({ id: "c-exp", name: "餐饮", type: "expense", sort_order: 0 }),
      makeCategory({ id: "c-inc", name: "工资", type: "income", sort_order: 0 }),
    ];
  });

  it("收入与支出分类各自成组，不混在一起", async () => {
    const wrapper = mountPage();
    await flushPromises();

    const expense = wrapper.find('[data-test="category-group-expense"]');
    const income = wrapper.find('[data-test="category-group-income"]');
    expect(expense.exists()).toBe(true);
    expect(income.exists()).toBe(true);
    expect(expense.text()).toContain("支出");
    expect(expense.text()).toContain("餐饮");
    expect(expense.text()).not.toContain("工资");
    expect(income.text()).toContain("收入");
    expect(income.text()).toContain("工资");
    expect(income.text()).not.toContain("餐饮");
  });

  it("某类型没有分类时隐藏该组", async () => {
    mocks.categories = [makeCategory({ id: "c-exp", name: "餐饮", type: "expense" })];
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find('[data-test="category-group-expense"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="category-group-income"]').exists()).toBe(false);
    // 收入分组的标题也不该出现。这里只扫**分类区**而不是整页：
    // 整页范围过宽——类型筛选芯片的文案就是「收入」
    //（与 RecordPage.vue:198、TransactionList.vue:383 的收支类型叫法一致），它必然出现在页面上。
    // 收窄的是**扫描范围**，不是严格程度：收入分组若被渲染，它的标题仍会落在这个容器里。
    expect(wrapper.find('[data-test="category-section"]').text()).not.toContain("收入");
  });

  it("两侧都没有分类时显示暂无分类", async () => {
    mocks.categories = [];
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find('[data-test="category-group-expense"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="category-group-income"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("暂无分类");
  });

  it("未分类独立于两个分组", async () => {
    const wrapper = mountPage();
    await flushPromises();

    const uncategorized = wrapper.find('[data-test="uncategorized-chip"]');
    expect(uncategorized.exists()).toBe(true);
    expect(wrapper.find('[data-test="category-group-expense"]').text()).not.toContain("未分类");
    expect(wrapper.find('[data-test="category-group-income"]').text()).not.toContain("未分类");
  });

  it("勾选收入分类后应用筛选回写该分类 id", async () => {
    const wrapper = mountPage();
    await flushPromises();

    const chip = wrapper
      .findAll('[data-test="category-chip"]')
      .find((c) => c.text().includes("工资"))!;
    await chip.trigger("click");
    await wrapper.find('[data-test="uncategorized-chip"]').trigger("click");
    // 未分类选中态也走 ☑，与其它分类 chip 一致
    expect(wrapper.find('[data-test="uncategorized-chip"]').text()).toContain("☑");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({
      path: "/",
      query: { categories: "c-inc", uncategorized: "1" },
    });
  });
});

describe("新增筛选条件", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mocks.push.mockReset();
    mocks.back.mockReset();
    mocks.query = {};
  });

  it("从 query 恢复关键词、金额区间与类型", async () => {
    mocks.query = { note: "盒马", amountMin: "10", amountMax: "500", type: "income" };
    const wrapper = mountPage();
    await flushPromises();

    expect((wrapper.find('[data-test="note-input"]').element as HTMLInputElement).value).toBe("盒马");
    expect((wrapper.find('[data-test="amount-min-input"]').element as HTMLInputElement).value).toBe("10");
    expect((wrapper.find('[data-test="amount-max-input"]').element as HTMLInputElement).value).toBe("500");
    expect(wrapper.find('[data-test="type-income"]').classes()).toContain("bg-primary");
    expect(wrapper.find('[data-test="type-expense"]').classes()).not.toContain("bg-primary");
  });

  it("日期筛选不被新控件的加入破坏：仍能恢复并回写", async () => {
    // 回归护栏：这一整个任务只是在日期块【之后】插新控件，日期块本身不该被动到
    mocks.query = { dateFrom: "2026-08-01", dateTo: "2026-08-31" };
    const wrapper = mountPage();
    await flushPromises();

    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/",
      query: { dateFrom: "2026-08-01", dateTo: "2026-08-31" },
    });
  });

  it("应用筛选时把新条件写进 query", async () => {
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="note-input"]').setValue("盒马");
    await wrapper.find('[data-test="amount-min-input"]').setValue("10");
    await wrapper.find('[data-test="type-expense"]').trigger("click");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({
      path: "/",
      query: { amountMin: "10", type: "expense", note: "盒马" },
    });
  });

  it("往返不丢条件：带着 AI 的四个筛选进筛选栏，再点「应用筛选」后它们仍在", async () => {
    // 这条钉的是任务 10 实现者提出的**用户可见**风险（R55）：
    // `apply()` 是**从零重建** query 对象的，只写它认识的那几个参数。
    // 在补齐控件之前，AI 跳转带的 note/amountMin/amountMax/type 会在用户
    // 「点筛选栏 → 应用筛选」之后被**静默丢掉**，而且列表随后会退回默认当月
    // —— 用户看到的是一份完全不同的数据，全程没有任何提示。
    // 单看"能恢复"和"能写出"两条用例都过不了这个风险（各自只测了一半），
    // 必须**串起来**测一次：URL → 控件回填 → 不改动直接应用 → 四个参数仍在。
    mocks.query = { note: "盒马", amountMin: "0", amountMax: "500", type: "expense" };
    const wrapper = mountPage();
    await flushPromises();

    // 先确认回填真的发生了（否则下面"参数仍在"可能只是因为 apply 原样透传了 URL）
    expect((wrapper.find('[data-test="note-input"]').element as HTMLInputElement).value).toBe("盒马");
    expect((wrapper.find('[data-test="amount-min-input"]').element as HTMLInputElement).value).toBe("0");

    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({
      path: "/",
      // amountMin 是 "0"：它必须原样回写（0 是有效下界，不能被当成"没给"而丢掉）
      query: { note: "盒马", amountMin: "0", amountMax: "500", type: "expense" },
    });
  });

  it("再点一次同一类型即取消选择", async () => {
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="type-expense"]').trigger("click");
    await wrapper.find('[data-test="type-expense"]').trigger("click");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: {} });
  });

  it("关键词首尾空白被裁掉，纯空白不产生参数", async () => {
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="note-input"]').setValue("   ");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: {} });
  });

  it("重置清空全部新条件", async () => {
    mocks.query = { note: "盒马", amountMin: "10", type: "income" };
    const wrapper = mountPage();
    await flushPromises();

    await buttonByText(wrapper, "重置").trigger("click");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: {} });
  });

  it("重置清空全部四个新条件（含简报漏带的 amountMax）", async () => {
    // 简报那条重置用例的 URL 只带 note/amountMin/type，amountMax 恒为空串——
    // 实测「只删 reset 里的 amountMax 清空」时它仍然全绿，抓不住这条。
    // 这条把四个条件全带上，四个清空行各自删掉都会红。
    mocks.query = { note: "盒马", amountMin: "10", amountMax: "500", type: "income" };
    const wrapper = mountPage();
    await flushPromises();

    await buttonByText(wrapper, "重置").trigger("click");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: {} });
  });

  // 以下两条为补覆盖（简报外的追加，见 task-11-report.md）：
  // R55 记录了「transfer 零覆盖 ⇒ 某一侧漏掉它时静默查成别的」，
  // 本轮新控件的 type 芯片同样包含「转账」，故按同一判据补上。
  it("关键词的 trim 落在写出的值上：带空白进来，写出的是裁好的串", async () => {
    // 只断言"纯空白不产生参数"抓不住「守卫用 trim、写出的值不 trim」这个变体：
    // 那样 note=" 盒马 " 会原样进 URL，读方 LIKE '% 盒马 %' 静默查空。
    const wrapper = mountPage();
    await flushPromises();

    await wrapper.find('[data-test="note-input"]').setValue("  盒马  ");
    await buttonByText(wrapper, "应用筛选").trigger("click");

    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: { note: "盒马" } });
  });

  it("往返不丢 transfer：只带 type=transfer 进来，应用后仍在", async () => {
    mocks.query = { type: "transfer" };
    const wrapper = mountPage();
    await flushPromises();

    expect(wrapper.find('[data-test="type-transfer"]').classes()).toContain("bg-primary");

    await buttonByText(wrapper, "应用筛选").trigger("click");
    expect(mocks.push).toHaveBeenCalledWith({ path: "/", query: { type: "transfer" } });
  });
});
