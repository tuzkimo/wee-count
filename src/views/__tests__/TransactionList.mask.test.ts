import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

// 可切换的 route params：账户详情模式用例需要让 useRoute 返回 params.id
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    init: vi.fn(async () => {}),
    currentLedger: ref({ id: "l1", name: "账本", type: "personal" }),
    currentLedgerId: ref("l1"),
    ledgers: ref([]),
    setCurrentLedger: vi.fn(),
  }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({ accounts: [], fetchAll: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({ tags: [], fetchAll: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({ categories: [], fetchAll: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/transaction", () => ({
  useTransactionStore: () => ({
    transactions: [],
    totalIncome: 3000,
    totalExpense: 1234.56,
    fetchAll: vi.fn(async () => {}),
    batchRemove: vi.fn(async () => {}),
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: ref(null) }),
}));
vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "u1",
  getTeamMembers: vi.fn(async () => []),
  upsertTeamMembers: vi.fn(async () => {}),
}));
vi.mock("@/composables/useMemberInfo", () => ({
  useMemberInfo: () => ({ getMember: vi.fn(async () => ({ displayName: "" })) }),
}));
vi.mock("@/services/api", () => ({ fetchTeamMembers: vi.fn(async () => []) }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: routeParams.value, query: {} }),
  useRouter: () => ({ push: vi.fn() }),
}));

import TransactionList from "@/views/TransactionList.vue";
import { usePrefsStore } from "@/stores/prefs";

describe("TransactionList 汇总金额遮蔽", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routeParams.value = {};
  });

  function mountPage() {
    return mount(TransactionList);
  }

  it("默认遮蔽收入/支出/结余，渲染结果不含真实数字", async () => {
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain("¥••••••");
    expect(w.text()).not.toContain("1,234.56");
    expect(w.text()).not.toContain("3,000.00");
  });

  it("显示后渲染真实金额，支出保留前置负号", async () => {
    usePrefsStore().showAmounts();
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain("¥3,000.00");
    expect(w.text()).toContain("-¥1,234.56");
    expect(w.text()).toContain("¥1,765.44"); // 结余 3000 - 1234.56
  });

  it("汇总卡片上的眼睛按钮可切换并显示真实金额", async () => {
    const w = mountPage();
    await flushPromises();
    await w.find('[data-test="amount-mask-toggle"]').trigger("click");
    expect(w.text()).toContain("¥3,000.00");
    expect(w.text()).toContain("-¥1,234.56");
  });

  it("账户详情模式显示态下支出不带前置负号", async () => {
    routeParams.value = { id: "acc-1" };
    usePrefsStore().showAmounts();
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain("支出 ¥1,234.56");
    expect(w.text()).not.toContain("-¥1,234.56");
  });
});
