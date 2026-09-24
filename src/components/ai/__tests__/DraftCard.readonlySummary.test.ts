// src/components/ai/__tests__/DraftCard.readonlySummary.test.ts
//
// 草稿卡**只读摘要**（规格 §4.4.2 / §4.4.3 / §4.4.4，2026-09-24 人工批准的设计变更）：
//
// 1. **卡片不再承载编辑**：只有确认记账 / 撤回 / 撤销三个动作，**没有任何输入控件**，
//    也没有「修改」按钮 —— 原编辑区的职责改走两条正当路径（§4.4.3）：(a) 觉得生得不对就在
//    对话里用自然语言说 ⇒ 重新生成一张卡；(b) 要精修就去**流水列表**改那条已入账的流水。
// 2. **tags 进摘要**：草稿里的 `tags` 是**名字数组**，逐个渲染成只读徽章；空数组不出现空壳行。
//    （产品原则 tags 优先于备注：标签必须和金额、账户一样看得见，否则用户无从确认"AI 打了什么标签"。）
// 3. **撤回后留静态卡**：`status === "rejected"` 的那份**照样渲染**，摘要与待确认卡**逐字段相同**、
//    按钮为零（"摘要不缩水"：两张卡各写一份渲染就是"撤回过一次就少显示两个字段"这类缺陷的温床）。
//
// 本文件替代了随编辑功能一起删除的 `DraftCard.edit.test.ts` / `DraftCard.transferInScope.test.ts`：
// 那两份挂在 `draft-edit-*` DOM 上，其中**数据正确性**的部分（转入别人账户时确认写的是那个 id）
// 按人工要求迁到这里，继续钉在**确认 + 展示**这两条留存的路径上。
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
  ledgerType: "personal" as "personal" | "team",
}));

vi.mock("@/services/ai/session", () => sessionSpy);
vi.mock("@/db/userDb", () => ({
  getUserDb: () => {
    throw new Error("草稿卡是纯前端：不许碰 DB");
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
const OTHER_ACC = "a7777777-6666-4555-8444-333333333333";
const CAT = "c1111111-2222-4333-8444-555555555555";

/** 一条"字段齐全"的草稿：金额/类型/分类/账户/日期/备注/**标签**都有（摘要不缩水要比的就是它） */
const DRAFT: AiDraftFields = {
  type: "expense",
  amount: 128.5,
  category: "买菜",
  fromAccount: "招行",
  toAccount: null,
  occurredAt: "2026-08-15T09:30",
  note: "盒马",
  tags: ["生鲜", "报销"],
};
const IDS: AiDraftIds = {
  categoryId: CAT,
  fromAccountId: FROM,
  toAccountId: null,
  tagIds: [],
};

function render(draft: AiDraftFields = DRAFT, resolved: AiDraftIds = IDS, status?: "pending" | "confirmed" | "rejected"): VueWrapper {
  return mount(DraftCard, { props: { draft, resolved, status } });
}

/** 摘要里"看得见"的那些值（待确认卡与已撤回静态卡必须一致） */
function summaryTexts(w: VueWrapper): string[] {
  // ⚠️ 只比**摘要**：状态标题（「待确认的记账」/「已撤回」）本来就该不同，不进这一组
  return ["draft-amount", "draft-category", "draft-from", "draft-occurred-at", "draft-note", "draft-tag"]
    .flatMap((name) => w.findAll(`[data-test="${name}"]`).map((el) => el.text()));
}

const ACTION_TESTS = ["draft-confirm", "draft-reject", "draft-undo"];

beforeEach(() => {
  vi.clearAllMocks();
  addSpy.mockClear();
  removeSpy.mockClear();
  setActivePinia(createPinia());
  usePrefsStore().amountsHidden = false;
  stores.categories = [{ id: CAT, name: "买菜", type: "expense" }];
  stores.accounts = [{ id: FROM, name: "招行", is_deleted: 0, owner_id: "local-user-1" }];
  stores.ledgerType = "personal";
});

describe("tags 芯片（§4.4.2）", () => {
  it("① 每个标签一个徽章、文字与草稿里的名字逐一对应；空数组不出现空壳行", () => {
    const w = render();
    const chips = w.findAll('[data-test="draft-tag"]');
    // 改哪一行能让它红：模板里删掉那段 `v-for="t in fields.tags"` ⇒ 这里 0 个徽章
    expect(chips.map((c) => c.text())).toEqual(["生鲜", "报销"]);
    expect(w.findAll('[data-test="draft-tags"]').length).toBe(1);

    const empty = render({ ...DRAFT, tags: [] });
    expect(empty.findAll('[data-test="draft-tag"]').length).toBe(0);
    // "有才显示"：空数组时整行（含「标签」这个 dt）都不渲染，不许留空壳
    expect(empty.find('[data-test="draft-tags"]').exists()).toBe(false);
  });
});

describe("卡片不再承载编辑（§4.4.3）", () => {
  it("② 待确认卡上没有任何输入控件、也没有「修改」按钮", () => {
    const w = render();
    // 改哪一行能让它红：把编辑区那段 `v-if="editing"` 的模板加回来 ⇒ `draft-edit-*` 立刻出现
    expect(w.findAll('[data-test^="draft-edit"]').length).toBe(0);
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(false);
    expect(w.findAll("input").length).toBe(0);
    expect(w.findAll("select").length).toBe(0);
    expect(w.text()).not.toContain("修改");
    // 留下的三个动作里，待确认态就这两颗（撤销只在已记账态）
    expect(w.find('[data-test="draft-confirm"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-reject"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-undo"]').exists()).toBe(false);
  });

  it("③ 撤回按钮的文案是「撤回」（标识符仍是 draft-reject）", () => {
    const w = render();
    const button = w.get('[data-test="draft-reject"]');
    // 改哪一行能让它红：模板里把「撤回」写回「不要」（§4.4.1 把文案定为"撤回"）
    expect(button.text()).toContain("撤回");
    expect(button.text()).not.toContain("不要");
  });
});

describe("撤回后的静态卡（§4.4.4）", () => {
  it("④ status=rejected ⇒ 静态卡：写着「已撤回」、零按钮、一次 transactionStore 都不调", async () => {
    const w = render(DRAFT, IDS, "rejected");
    await flushPromises();

    // 改哪一行能让它红：模板里 rejected 仍走"两颗按钮"那条分支 ⇒ 下面的按钮断言红
    expect(w.get('[data-draft-state]').attributes("data-draft-state")).toBe("rejected");
    expect(w.find('[data-test="draft-rejected-text"]').exists()).toBe(true);
    expect(w.get('[data-test="draft-rejected-text"]').text()).toContain("已撤回");
    for (const name of ACTION_TESTS) expect(w.find(`[data-test="${name}"]`).exists()).toBe(false);
    expect(w.findAll("button").length).toBe(0);
    expect(addSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("⑤ 摘要不缩水：同一份草稿，待确认卡与已撤回静态卡看得见的字段逐个相同", async () => {
    const pending = render(DRAFT, IDS, "pending");
    const rejected = render(DRAFT, IDS, "rejected");
    await flushPromises();

    // 改哪一行能让它红：静态卡另写一份"精简摘要"（少渲染 tags / 备注 / 账户）⇒ 两个数组不等
    expect(summaryTexts(rejected)).toEqual(summaryTexts(pending));
    // 逐字段点名，失败时能直接看出少的是哪一个
    expect(summaryTexts(rejected)).toEqual([
      "支出 ¥128.50",
      "买菜",
      "招行",
      "2026-08-15T09:30",
      "盒马",
      "生鲜",
      "报销",
    ]);
  });
});

describe("转入别人账户的数据正确性（从已删除的 transferInScope 迁移过来）", () => {
  it("⑥ 转账转入是别人的账户 ⇒ 确认时写库用的是 `resolved.toAccountId`（不是模型写的那串字）", async () => {
    stores.ledgerType = "team";
    stores.accounts = [
      { id: FROM, name: "招行", is_deleted: 0, owner_id: "local-user-1" },
      { id: OTHER_ACC, name: "现金", is_deleted: 0, owner_id: OTHER_USER },
    ];
    const draft: AiDraftFields = {
      type: "transfer",
      amount: 128.5,
      category: null,
      fromAccount: "招行",
      // 模型写下的**裸名**（用户的"现金"其实落在小明名下）
      toAccount: "现金",
      occurredAt: "2026-08-15T09:30",
      note: null,
      tags: [],
    };
    const w = render(draft, { categoryId: null, fromAccountId: FROM, toAccountId: OTHER_ACC, tagIds: [] });
    await flushPromises();

    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 改哪一行能让它红：`buildDraftData` 的 `to_account_id` 改用 `draft.toAccount`（名字）⇒ 断言红
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0]![0]).toMatchObject({
      type: "transfer",
      from_account_id: FROM,
      to_account_id: OTHER_ACC,
    });
  });
});
