// src/components/ai/__tests__/DraftCard.transferInScope.test.ts
//
// 转账两侧的账户候选在**卡片**上的口径（人类确认：**转出只能本人账户，转入可以用所有人的账户**，
// 与手动记账逐条一致 —— `RecordPage.vue:58-62` 转账 to 侧 `scope="all"` + `show-member`，
// from 侧 `scope="own"`；`RecordPage.vue:63-66` 支出/收入的单侧账户同样是 `own`）。
//
// 为什么单开一个文件（而不是加进 `DraftCard.edit.test.ts`）：那份文件的夹具是一个**个人**账本
// （`stores.ledgerType = "personal"`），团队账本里"别人的账户"这条分支在那里根本不可达；
// 而它那条"账户下拉排除软删/别人的账户"的用例钉的是**支出**的转出侧，本文件不动它。
//
// 本文件钉三件事：
//   ① 转账**转入**侧能看到并选中别人的账户（名字带归属，与快照/解析表同一格式）；
//   ② 转入是别人的账户的草稿，**编辑后保存**不许把 `draft.toAccount` 弄丢
//      （修复前：别人的账户不在 option 里 ⇒ `onSaveEdit` 的名字反查拿到 null ⇒ 卡上整行转入消失，
//       而 `resolved.toAccountId` 仍是别人的 id ⇒ 用户看不见这笔钱转到哪，再点一次「修改」
//       下拉是空白的，随手一选就可能把转入换成自己的账户 —— 静默改账）；
//   ③ 护栏：转出侧（转账 from / 支出扣款）与收入侧仍然**只给本人**的账户。
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

/** 别的成员（归属名走 `useMemberInfo`：别名 > 昵称 > username） */
const OTHER_USER = "user-2";

const stores = vi.hoisted(() => ({
  categories: [] as { id: string; name: string; type: string }[],
  accounts: [] as { id: string; name: string; is_deleted: number; owner_id: string }[],
  ledgerType: "personal" as "personal" | "team",
}));

vi.mock("@/services/ai/session", () => sessionSpy);
vi.mock("@/db/userDb", () => ({
  getUserDb: () => {
    throw new Error("草稿卡本层零写入：不许直接拿 DB 句柄（记账走 transactionStore）");
  },
  getCurrentUserId: () => "local-user-1",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async (userId: string) =>
    userId === "user-2" ? { user_id: "user-2", alias_name: "小明" } : null,
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

// 真 UUID：这些 id 会进 `add` 的参数，短串会让"id 从下拉来"的断言失去判别力
const CAT = "c1a7b8c9-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const FROM = "a1111111-2222-4333-8444-555555555555";
const ACC2 = "a9999999-8888-4777-8666-555555555555";
const ACC_OTHER = "a7777777-6666-4555-8444-333333333333";
const ACC_DELETED = "addddddd-1111-4222-8333-444444444444";

/** 别人的账户在草稿里、在解析表里、在快照里的**同一个**名字（`otherAccountLabel`） */
const OTHER_LABEL = "小明的老婆的卡";

/** 转账：转出本人的「招行」、转入别人的「老婆的卡」（AI 侧从上一轮起就允许这么生成） */
const TRANSFER_DRAFT: AiDraftFields = {
  type: "transfer",
  amount: 128.5,
  category: null,
  fromAccount: "招行",
  toAccount: OTHER_LABEL,
  occurredAt: "2026-08-15T09:30",
  note: "还钱",
  tags: [],
};
const TRANSFER_IDS: AiDraftIds = {
  categoryId: null,
  fromAccountId: FROM,
  toAccountId: ACC_OTHER,
  tagIds: [],
};

const EXPENSE_DRAFT: AiDraftFields = {
  ...TRANSFER_DRAFT,
  type: "expense",
  category: "买菜",
  toAccount: null,
};
const INCOME_DRAFT: AiDraftFields = {
  ...TRANSFER_DRAFT,
  type: "income",
  category: "工资",
  fromAccount: null,
};
const INCOME_IDS: AiDraftIds = { ...TRANSFER_IDS, categoryId: CAT, fromAccountId: null, toAccountId: ACC2 };

function optionTexts(w: VueWrapper, test: string): string[] {
  return w.get(`[data-test="${test}"]`).findAll("option").map((o) => o.text());
}

/** 打开编辑区（归属名是异步加载的，先 flush 一次再点） */
async function openEdit(w: VueWrapper): Promise<void> {
  await flushPromises();
  await w.get('[data-test="draft-edit"]').trigger("click");
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  stores.categories = [
    { id: CAT, name: "买菜", type: "expense" },
    { id: CAT, name: "工资", type: "income" },
  ];
  stores.accounts = [
    { id: FROM, name: "招行", is_deleted: 0, owner_id: "local-user-1" },
    { id: ACC2, name: "现金", is_deleted: 0, owner_id: "local-user-1" },
    { id: ACC_OTHER, name: "老婆的卡", is_deleted: 0, owner_id: OTHER_USER },
    { id: ACC_DELETED, name: "已删账户", is_deleted: 1, owner_id: OTHER_USER },
  ];
  // 团队账本才会启用"转出只给自己名下账户"那条过滤
  stores.ledgerType = "team";
  // 默认是"遮金额"，而遮蔽态下编辑区**故意不回填金额** ⇒ 保存会卡在"金额要大于 0"
  usePrefsStore().showAmounts();
});

describe("转账转入侧：可以用所有人的账户", () => {
  it("① 转入下拉里有别人的账户（名字带归属），选中并保存后卡上仍显示它、确认写的还是那个 id", async () => {
    const w = mount(DraftCard, { props: { draft: TRANSFER_DRAFT, resolved: TRANSFER_IDS } });
    await openEdit(w);

    // 杀手：转入侧接回 `ownAccountOptions`（只给本人）⇒ 下面这条当场红（选项里没有别人的账户）
    expect(optionTexts(w, "draft-edit-to")).toEqual(["请选择账户", "招行", "现金", OTHER_LABEL]);

    // 真的能**选中**（v-model 收下这个 id）
    await w.get('[data-test="draft-edit-to"]').setValue(ACC_OTHER);
    await w.get('[data-test="draft-edit-save"]').trigger("click");

    // ② 编辑既有"他人转入"的草稿：保存后卡上必须仍然显示转入账户。
    //    杀手：名字反查用本人池 ⇒ `names.toAccount` 是 null ⇒ `applyDraftEdit` 写出
    //    `toAccount: null` 而 `resolved.toAccountId` 仍是 ACC_OTHER（`draftData.ts:162/171`）
    //    ⇒ 这一行整行消失（`DraftCard.vue:446` 的 `v-if="fields.toAccount"`），下面红。
    expect(w.get('[data-test="draft-to"]').text()).toBe(OTHER_LABEL);

    // ③ 确认时写进去的仍是**别人那个**账户的 id（账不能因为编辑被改到自己的账户上）
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0]![0].to_account_id).toBe(ACC_OTHER);
    expect(addSpy.mock.calls[0]![0].from_account_id).toBe(FROM);
  });

  it("② 转入侧不列软删账户", async () => {
    const w = mount(DraftCard, { props: { draft: TRANSFER_DRAFT, resolved: TRANSFER_IDS } });
    await openEdit(w);

    // 杀手：转入侧的过滤只判 `owner` 不判 `is_deleted` ⇒ 「已删账户」出现
    expect(optionTexts(w, "draft-edit-to")).not.toContain("已删账户");
  });

  it("③ 个人账本：两套候选一致（不因为放开转入而多出/少掉谁）", async () => {
    stores.ledgerType = "personal";
    const w = mount(DraftCard, { props: { draft: TRANSFER_DRAFT, resolved: TRANSFER_IDS } });
    await openEdit(w);

    // 个人账本没有"别人的账户"这回事：转入侧就是全部**未删**账户，名字**不带归属**
    expect(optionTexts(w, "draft-edit-to")).toEqual(["请选择账户", "招行", "现金", "老婆的卡"]);
    expect(optionTexts(w, "draft-edit-from")).toEqual(["请选择账户", "招行", "现金", "老婆的卡"]);
  });
});

describe("护栏：转出侧与收入侧仍然只给本人账户", () => {
  it("④ 转账转出侧看不到别人的账户", async () => {
    const w = mount(DraftCard, { props: { draft: TRANSFER_DRAFT, resolved: TRANSFER_IDS } });
    await openEdit(w);

    // 杀手：把 `transferInOptions` 同时接到 from 侧（"顺手放开"）⇒ 「老婆的卡」出现在转出下拉里
    expect(optionTexts(w, "draft-edit-from")).toEqual(["请选择账户", "招行", "现金"]);
  });

  it("⑤ 支出（扣款账户）与收入（入账账户）都看不到别人的账户", async () => {
    const expense = mount(DraftCard, {
      props: { draft: EXPENSE_DRAFT, resolved: { ...TRANSFER_IDS, categoryId: CAT, toAccountId: null } },
    });
    await openEdit(expense);
    expect(optionTexts(expense, "draft-edit-from")).toEqual(["请选择账户", "招行", "现金"]);

    const income = mount(DraftCard, {
      props: { draft: INCOME_DRAFT, resolved: INCOME_IDS },
    });
    await openEdit(income);
    // 收入侧也走合并池 ⇒ 「小明的老婆的卡」出现，下面红（钱不会进别人的账户，`tools.ts:870` 同一口径）
    expect(optionTexts(income, "draft-edit-to")).toEqual(["请选择账户", "招行", "现金"]);
  });
});
