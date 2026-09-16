import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

// 可切换的 route params：账户详情模式用例需要让 useRoute 返回 params.id
const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
// 可切换的收支合计：结余为负的用例需要构造 totalIncome - totalExpense < 0
const txTotals = vi.hoisted(() => ({ income: 3000, expense: 1234.56 }));

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
    totalIncome: txTotals.income,
    totalExpense: txTotals.expense,
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
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";

describe("TransactionList 汇总金额遮蔽", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routeParams.value = {};
    txTotals.income = 3000;
    txTotals.expense = 1234.56;
  });

  function mountPage() {
    // FAB 使用 <router-link>，而本文件 mock 掉了 vue-router；stub 掉以避免 Vue warn
    return mount(TransactionList, { global: { stubs: { RouterLink: true } } });
  }

  it("默认遮蔽收入/支出/结余，渲染结果不含真实数字", async () => {
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain(`¥${AMOUNT_PLACEHOLDER}`);
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

  it("账户详情模式默认遮蔽，当前余额与收支合计均为占位符", async () => {
    routeParams.value = { id: "acc-1" };
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain(`¥${AMOUNT_PLACEHOLDER}`);
    expect(w.text()).not.toContain("1,234.56");
    expect(w.text()).not.toContain("3,000.00");
  });

  it("默认遮蔽结余为负时结余单元格不带红色（符号不由颜色泄露）", async () => {
    txTotals.income = 1000;
    txTotals.expense = 1234.56; // 结余 -234.56
    const w = mountPage();
    await flushPromises();

    const balanceCell = w.findAll("div.flex-1.text-center").find((c) => c.text().includes("结余"));
    expect(balanceCell).toBeDefined();
    const balanceAmount = balanceCell!.find("p.mt-1");
    expect(balanceAmount.text()).toBe(`¥${AMOUNT_PLACEHOLDER}`);
    expect(balanceAmount.classes()).not.toContain("text-expense");

    // 显示态下负值仍应由符号派生红色
    usePrefsStore().showAmounts();
    await flushPromises();
    expect(balanceAmount.text()).toBe("-¥234.56");
    expect(balanceAmount.classes()).toContain("text-expense");
  });
});

describe("TransactionList 汇总金额字号自适应", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    routeParams.value = {};
    txTotals.income = 3000;
    txTotals.expense = 1234.56;
  });

  function mountShown() {
    usePrefsStore().showAmounts();
    return mount(TransactionList, { global: { stubs: { RouterLink: true } } });
  }

  /** 三列金额单元格（沿用既有测试依赖的 DOM 结构：.flex-1.text-center > p.mt-1） */
  function amountCells(w: ReturnType<typeof mountShown>) {
    return w.findAll("div.flex-1.text-center p.mt-1");
  }

  it("三列金额始终不换行，且共用同一个字号", async () => {
    const w = mountShown();
    await flushPromises();
    const cells = amountCells(w);
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.classes()).toContain("whitespace-nowrap");
    }
    const sizes = cells.map((c) => c.classes().find((cls) => cls.startsWith("text-") && cls !== "text-income" && cls !== "text-expense" && cls !== "text-text"));
    expect(new Set(sizes).size).toBe(1);
  });

  it("常见金额维持 18px（text-lg）", async () => {
    const w = mountShown();
    await flushPromises();
    for (const cell of amountCells(w)) {
      expect(cell.classes()).toContain("text-lg");
    }
  });

  it("大额金额自动降档，避免撑成两行", async () => {
    // 六位数金额：18px 下 ≈105px 会换行，降到 16px ≈93px 排得下
    txTotals.income = 123456.78; // ¥123,456.78
    const w = mountShown();
    await flushPromises();
    const cells = amountCells(w);
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.classes()).not.toContain("text-lg");
      expect(cell.classes()).toContain("text-base");
      expect(cell.classes()).toContain("whitespace-nowrap");
    }
    expect(w.text()).toContain("¥123,456.78");
  });

  it("位数再多继续降档，不会回到换行", async () => {
    txTotals.income = 99999999.99; // ¥99,999,999.99（八位数）
    const w = mountShown();
    await flushPromises();
    for (const cell of amountCells(w)) {
      expect(cell.classes()).toContain("text-xs");
      expect(cell.classes()).toContain("whitespace-nowrap");
    }
  });

  it("遮蔽态沿用 text-sm 且不因真实金额大小改变", async () => {
    txTotals.income = 123456.78;
    const w = mount(TransactionList, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    for (const cell of amountCells(w)) {
      expect(cell.classes()).toContain("text-sm");
      expect(cell.text()).toBe(`¥${AMOUNT_PLACEHOLDER}`);
    }
  });
});
