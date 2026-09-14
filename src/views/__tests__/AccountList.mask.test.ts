import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";

const MASKED_CURRENCY = `¥${AMOUNT_PLACEHOLDER}`;

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    init: vi.fn(async () => {}),
    currentLedger: ref({ id: "l1", name: "账本", type: "personal" }),
  }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({
    accounts: [
      {
        id: "acc-1", ledger_id: "l1", owner_id: "u1", name: "招商银行", type: "bank",
        category: "asset", initial_balance: 0, color: "#3b82f6",
        created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
        is_deleted: false, current_balance: 1234.56,
      },
    ],
    fetchAll: vi.fn(async () => {}),
    add: vi.fn(async () => {}),
    // 三者语义自洽：netAssets = assetsTotal + liabilitiesTotal（数据层负债为负值）。
    // 三个数值互不相同，任一行漏遮蔽都会让断言失败。
    netAssets: 7777.76,
    assetsTotal: 8888.88,
    liabilitiesTotal: -1111.12,
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: ref(null) }),
}));
vi.mock("@/db/userDb", () => ({ getCurrentUserId: () => "u1" }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import AccountList from "@/views/AccountList.vue";

describe("AccountList 金额遮蔽", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  function mountPage() {
    return mount(AccountList, { global: { stubs: { AccountSheet: true } } });
  }

  type Page = ReturnType<typeof mountPage>;

  /** 净资产：标签与数值分列相邻的两个 <p>。 */
  function netAssetsText(wrapper: Page): string {
    const label = wrapper.findAll("p").find((p) => p.text() === "净资产");
    if (!label) throw new Error("未找到「净资产」标签");
    return label.element.nextElementSibling?.textContent?.trim() ?? "";
  }

  /** 资产 / 负债：标签与数值同在一个 <span> 内（「资产」不会命中「净资产」）。 */
  function totalRowText(wrapper: Page, label: string): string {
    const found = wrapper
      .findAll("span")
      .find((span) => span.text().startsWith(label));
    if (!found) throw new Error(`未找到「${label}」一行`);
    return found.text();
  }

  it("默认遮蔽净资产与账户余额，渲染结果不含真实数字", async () => {
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain(MASKED_CURRENCY);
    expect(w.text()).not.toContain("7,777.76");
    expect(w.text()).not.toContain("8,888.88");
    expect(w.text()).not.toContain("1,111.12");
    expect(w.text()).not.toContain("1,234.56");
    expect(netAssetsText(w)).toBe(MASKED_CURRENCY);
    expect(totalRowText(w, "资产")).toBe(`资产 ${MASKED_CURRENCY}`);
    expect(totalRowText(w, "负债")).toBe(`负债 ${MASKED_CURRENCY}`);
    expect(w.text()).not.toContain("-¥");
  });

  it("点击眼睛按钮后显示真实金额", async () => {
    const w = mountPage();
    await flushPromises();
    await w.find('[data-test="amount-mask-toggle"]').trigger("click");
    expect(w.text()).toContain("¥7,777.76");
    expect(w.text()).toContain("¥8,888.88");
    expect(w.text()).toContain("¥1,234.56");
    expect(netAssetsText(w)).toBe("¥7,777.76");
    expect(totalRowText(w, "资产")).toBe("资产 ¥8,888.88");
    // 负债在数据层是负值，展示层取绝对值：必须渲染为不带负号的正数金额
    expect(totalRowText(w, "负债")).toBe("负债 ¥1,111.12");
    expect(w.text()).not.toContain("-¥1,111.12");
  });
});
