// src/components/ai/__tests__/DraftCard.transferInDisplay.test.ts
//
// 卡片**只读展示**（非编辑态）那两行账户必须显示**解析后的账户**，而不是模型当初写的那串字。
//
// 为什么（实测复现，见下的夹具 ①）：用户说"转到现金"，而"现金"是**别人**名下的账户时，工具的
// 匹配是"精确 → 双向包含"（`resolve.ts:117-123`），转入侧的同名保护
// （`tools.ts:696-702`）**只在解析结果落在我名下**时才拦 ⇒ 这一轮解析**成功**、落到小明的账户，
// 而模型写进草稿的 `toAccount` 就是裸名「现金」。修复前卡上照抄那串字 ⇒ 用户看到「转入 现金」，
// 完全看不出这笔钱要进**谁的**账户（而确认后就写进小明的账户）。
//
// 所以展示的真相源是 `resolved.toAccountId`（确认后真要写进账的那个账户）→ 账户 → 归属名；
// 只有解析不到账户（id 为 null / 账户不在 store 里）才回落到模型写的那串字。
//
// 与 `DraftCard.transferInScope.test.ts` 分开：那份钉的是**编辑下拉**（人类已批准删除编辑功能，
// 届时整份删除）；本文件只钉只读展示，与"删掉编辑"不冲突。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const sessionSpy = vi.hoisted(() => ({
  ensureConversation: vi.fn(async () => null as string | null),
  recentTurns: vi.fn(async () => []),
  appendMessage: vi.fn(async () => true),
  setTitleIfEmpty: vi.fn(async () => {}),
  loadMessages: vi.fn(async () => []),
  clearConversation: vi.fn(async () => {}),
}));
const addSpy = vi.hoisted(() =>
  vi.fn<(data: Record<string, unknown>) => Promise<string>>(async () => "tx-new"),
);
const removeSpy = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}));

const OTHER_USER = "user-2";

const stores = vi.hoisted(() => ({
  categories: [] as { id: string; name: string; type: string }[],
  accounts: [] as { id: string; name: string; is_deleted: number; owner_id: string }[],
  ledgerType: "team" as "personal" | "team",
}));

vi.mock("@/services/ai/session", () => sessionSpy);
vi.mock("@/db/userDb", () => ({
  getUserDb: () => {
    throw new Error("只读展示是纯前端：不许碰 DB");
  },
  getCurrentUserId: () => "local-user-1",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async (userId: string) =>
    userId === OTHER_USER ? { user_id: OTHER_USER, alias_name: "小明" } : null,
}));
vi.mock("@/stores/transaction", () => ({
  useTransactionStore: () => ({ add: addSpy, remove: removeSpy, transactions: [] }),
}));
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    get currentLedger() {
      return { id: "L1", name: "账本", type: stores.ledgerType, team_id: null };
    },
    currentLedgerId: "L1",
    ledgers: [],
    setCurrentLedger: vi.fn(),
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: null, isAuthenticated: false }),
}));
vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({ get categories() { return stores.categories; } }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({ get accounts() { return stores.accounts; } }),
}));

import DraftCard from "@/components/ai/DraftCard.vue";
import { usePrefsStore } from "@/stores/prefs";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

const FROM = "a1111111-2222-4333-8444-555555555555";
const ACC_MING = "a7777777-6666-4555-8444-333333333333";
const ACC_GONE = "a2222222-3333-4444-8555-666666666666";

const DRAFT: AiDraftFields = {
  type: "transfer",
  amount: 128.5,
  category: null,
  fromAccount: "招行",
  // ⚠️ 夹具要点：这正是模型在"用户说了裸名字"时写下的那串字（D2 实测的原样）
  toAccount: "现金",
  occurredAt: "2026-08-15T09:30",
  note: "还钱",
  tags: [],
};
const IDS: AiDraftIds = {
  categoryId: null,
  fromAccountId: FROM,
  toAccountId: ACC_MING,
  tagIds: [],
};

/** 挂载并等归属名那次异步加载落地 */
async function render(draft: AiDraftFields, resolved: AiDraftIds): Promise<VueWrapper> {
  const w = mount(DraftCard, { props: { draft, resolved } });
  await flushPromises();
  return w;
}
const toText = (w: VueWrapper): string => w.get('[data-test="draft-to"]').text();

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  stores.categories = [];
  stores.accounts = [
    { id: FROM, name: "招行", is_deleted: 0, owner_id: "local-user-1" },
    { id: ACC_MING, name: "现金", is_deleted: 0, owner_id: OTHER_USER },
    { id: ACC_GONE, name: "被删的卡", is_deleted: 1, owner_id: OTHER_USER },
  ];
  stores.ledgerType = "team";
  usePrefsStore().showAmounts();
});

describe("只读展示的转入账户：以解析后的账户为准", () => {
  it("① 转入落到**别人**的账户、模型只写了裸名 ⇒ 卡上必须看得出是谁的账户", async () => {
    const w = await render(DRAFT, IDS);

    // 改哪一行能让它红：把 `:523` 的 `{{ displayTo }}` 换回 `{{ fields.toAccount }}`
    // （或让 `displayAccount` 在解析得到账户时也优先用模型那串字）⇒ 这里变回「现金」。
    expect(toText(w)).toBe("小明的现金");
  });

  it("② 转入是**我自己的**账户 ⇒ 裸名，不加归属（与快照里「我的账户不带前缀」同一口径）", async () => {
    const w = await render({ ...DRAFT, toAccount: "招行" }, { ...IDS, toAccountId: FROM });

    expect(toText(w)).toBe("招行");
  });

  it("③ 个人账本 ⇒ 裸名（没有「谁的账户」这层含义）", async () => {
    stores.ledgerType = "personal";
    const w = await render(DRAFT, IDS);

    expect(toText(w)).toBe("现金");
  });

  it("④ 模型写的就是带归属的名字 ⇒ 仍然是「小明的现金」，不叠加成「小明的小明的现金」", async () => {
    const w = await render({ ...DRAFT, toAccount: "小明的现金" }, IDS);

    // 名字取的是**账户的** name + 归属人，不是把归属前缀加到模型那串字上
    expect(toText(w)).toBe("小明的现金");
  });

  it("⑤ 解析不到账户（id 不在 store 里）⇒ 回落到模型写的那串字，那一行不能凭空消失", async () => {
    const w = await render(DRAFT, { ...IDS, toAccountId: "a0000000-0000-4000-8000-000000000000" });

    expect(toText(w)).toBe("现金");
  });

  it("⑥ 转出侧走同一个真相源：id 指向别人的账户时如实显示归属（不隐瞒钱的去向）", async () => {
    const w = await render(
      { ...DRAFT, type: "transfer", fromAccount: "现金", toAccount: "招行" },
      { ...IDS, fromAccountId: ACC_MING, toAccountId: FROM },
    );

    expect(w.get('[data-test="draft-from"]').text()).toBe("小明的现金");
  });

  it("⑦ 转入的账户是**别人的**、且已被软删 ⇒ 仍要显示归属（草稿指向的是它）", async () => {
    const w = await render({ ...DRAFT, toAccount: "被删的卡" }, { ...IDS, toAccountId: ACC_GONE });

    // 软删账户照样在 `accountStore.accounts` 里（只有选择器才过滤它）；展示不能因此丢掉归属
    expect(toText(w)).toBe("小明的被删的卡");
  });
});
