import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

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
    netAssets: 8888.88,
    assetsTotal: 8888.88,
    liabilitiesTotal: 0,
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

  it("默认遮蔽净资产与账户余额，渲染结果不含真实数字", async () => {
    const w = mountPage();
    await flushPromises();
    expect(w.text()).toContain("¥••••••");
    expect(w.text()).not.toContain("8,888.88");
    expect(w.text()).not.toContain("1,234.56");
  });

  it("点击眼睛按钮后显示真实金额", async () => {
    const w = mountPage();
    await flushPromises();
    await w.find('[data-test="amount-mask-toggle"]').trigger("click");
    expect(w.text()).toContain("¥8,888.88");
    expect(w.text()).toContain("¥1,234.56");
  });
});
