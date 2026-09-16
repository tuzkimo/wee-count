import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import DateRangePicker from "@/components/DateRangePicker.vue";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  query: {} as Record<string, string>,
  fetchAccounts: vi.fn(),
  fetchTags: vi.fn(),
  fetchCategories: vi.fn(),
  init: vi.fn(),
}));

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
  useTagStore: () => ({ tags: [], fetchAll: mocks.fetchTags }),
}));

vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({ categories: [], fetchAll: mocks.fetchCategories }),
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
