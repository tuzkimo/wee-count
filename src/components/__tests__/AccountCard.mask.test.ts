import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import type { Account } from "@/types";

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ currentLedger: ref({ id: "l1", name: "账本", type: "personal" }) }),
}));
vi.mock("@/composables/useMemberInfo", () => ({
  useMemberInfo: () => ({ getMember: vi.fn(async () => ({ displayName: "" })) }),
}));

import AccountCard from "@/components/AccountCard.vue";
import { usePrefsStore } from "@/stores/prefs";

function makeAccount(currentBalance: number): Account {
  return {
    id: "acc-1",
    ledger_id: "l1",
    owner_id: "u1",
    name: "招商银行",
    type: "bank",
    category: "asset",
    initial_balance: 0,
    color: "#3b82f6",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    is_deleted: false,
    current_balance: currentBalance,
  };
}

describe("AccountCard 金额遮蔽", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("默认遮蔽余额，渲染结果不含真实数字", async () => {
    const w = mount(AccountCard, { props: { account: makeAccount(1234.56) } });
    await flushPromises();
    expect(w.text()).toContain("¥••••••");
    expect(w.text()).not.toContain("1,234.56");
  });

  it("显示后渲染带符号的真实余额", async () => {
    usePrefsStore().showAmounts();
    const w = mount(AccountCard, { props: { account: makeAccount(1234.56) } });
    await flushPromises();
    expect(w.text()).toContain("¥1,234.56");
  });

  it("显示后负余额符号在货币符号外侧", async () => {
    usePrefsStore().showAmounts();
    const w = mount(AccountCard, { props: { account: makeAccount(-1234.56) } });
    await flushPromises();
    expect(w.text()).toContain("-¥1,234.56");
  });

  it("默认遮蔽时负债账户的负余额不带红色（符号不由颜色泄露）", async () => {
    const account = { ...makeAccount(-1234.56), category: "liability" as const };

    const masked = mount(AccountCard, { props: { account } });
    await flushPromises();
    expect(masked.find("p.text-base").text()).toBe("¥••••••");
    expect(masked.find("p.text-base").classes()).not.toContain("text-expense");

    // 显示态下负值仍应由符号派生红色
    usePrefsStore().showAmounts();
    const shown = mount(AccountCard, { props: { account } });
    await flushPromises();
    expect(shown.find("p.text-base").classes()).toContain("text-expense");
  });
});
