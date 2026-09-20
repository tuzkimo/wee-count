// src/components/ai/__tests__/DraftCard.edit.test.ts
//
// §4.4:162「卡片内联可改：金额 / 分类 / 账户 / 时间 / 备注。校验复用 `utils/transaction.ts`
// 的规则与 `round2`」——本文件钉**组件那半边**：编辑区真的改到了"确认时递给 add 的那份数据"。
//
// 单独成文件（而不是往 `DraftCard.test.ts` 里加）：那份文件的 mock 集合里**没有**
// 分类/账户 store（它钉的是零写入与撤销 id），而编辑区必须要候选名表；两套夹具混在一个文件里
// 会让"编辑区为什么能看到某张分类"变得不可读。纯映射规则在 `draftData.test.ts` 里另钉一份。
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

// 名表由本文件的夹具直接给（`fetchAll` 是页面的事，不是卡的事）
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
  getMemberAlias: async () => null,
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
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import { usePrefsStore } from "@/stores/prefs";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

// 真 UUID：编辑区选中的 id 会进 `add`，用 "c2" 这类假串会让"id 从下拉来"的断言恒真（Ruling 13）
const CAT = "c1a7b8c9-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const CAT2 = "c2222222-3333-4444-8555-666666666666";
const CAT_INCOME = "c3333333-4444-4555-8666-777777777777";
const FROM = "a1111111-2222-4333-8444-555555555555";
const ACC2 = "a9999999-8888-4777-8666-555555555555";
const ACC_OTHER_OWNER = "a7777777-6666-4555-8444-333333333333";
const ACC_DELETED = "addddddd-1111-4222-8333-444444444444";

const DRAFT: AiDraftFields = {
  type: "expense",
  amount: 128.5,
  category: "买菜",
  fromAccount: "招行",
  toAccount: null,
  occurredAt: "2026-08-15T09:30",
  note: "盒马",
  tags: ["生鲜"],
};
const IDS: AiDraftIds = { categoryId: CAT, fromAccountId: FROM, toAccountId: null, tagIds: ["t-1"] };

const props = { draft: DRAFT, resolved: IDS };

function optionTexts(w: VueWrapper, test: string): string[] {
  return w.get(`[data-test="${test}"]`).findAll("option").map((o) => o.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  stores.categories = [
    { id: CAT, name: "买菜", type: "expense" },
    { id: CAT2, name: "打车", type: "expense" },
    // 别的同类项：收入分类不能出现在支出的分类下拉里
    { id: CAT_INCOME, name: "工资", type: "income" },
  ];
  stores.accounts = [
    { id: FROM, name: "招行", is_deleted: 0, owner_id: "local-user-1" },
    { id: ACC2, name: "现金", is_deleted: 0, owner_id: "local-user-1" },
    { id: ACC_OTHER_OWNER, name: "老婆的卡", is_deleted: 0, owner_id: "user-2" },
    { id: ACC_DELETED, name: "已删账户", is_deleted: 1, owner_id: "local-user-1" },
  ];
  stores.ledgerType = "personal";
  // 全局金额遮蔽的默认值是"遮"（`stores/prefs.ts`），而遮蔽态下编辑区**故意不回填金额**
  // （§7.4：不许把刚遮住的数字摆回屏幕正中）⇒ 不打开它，本文件那些"改字段"的用例第一步就
  // 卡在"金额要大于 0"上。本文件钉的是编辑与遮罩**判定**，逐条自己声明遮蔽态（见下面的 §7.4 块）。
  usePrefsStore().showAmounts();
});

describe("DraftCard 内联可改（§4.4:162）", () => {
  it("改完保存后：卡上显示新值，且「确认记账」递进 add 的就是改后的字段", async () => {
    const w = mount(DraftCard, { props });
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(false);

    await w.get('[data-test="draft-edit"]').trigger("click");
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(true);

    await w.get('[data-test="draft-edit-amount"]').setValue("200.555");
    await w.get('[data-test="draft-edit-category"]').setValue(CAT2);
    await w.get('[data-test="draft-edit-from"]').setValue(ACC2);
    await w.get('[data-test="draft-edit-occurred-at"]').setValue("2026-09-01T08:15");
    await w.get('[data-test="draft-edit-note"]').setValue("  打的  ");
    await w.get('[data-test="draft-edit-save"]').trigger("click");

    // 编辑区收起、显示换成新值（名字来自名表，不是 id）
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(false);
    expect(w.get('[data-test="draft-category"]').text()).toBe("打车");
    expect(w.get('[data-test="draft-from"]').text()).toBe("现金");
    expect(w.get('[data-test="draft-note"]').text()).toBe("打的");
    expect(w.get('[data-test="draft-occurred-at"]').text()).toBe("2026-09-01T08:15");

    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 杀手：`onConfirm` 里把 `fields`/`ids` 换回 `props.draft`/`props.resolved`
    // ⇒ 下面这份期望里的金额/分类/账户/时间/备注**五处**同时红（编辑整个失效）
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0]![0]).toEqual({
      ledger_id: "L1",
      user_id: "local-user-1",
      type: "expense",
      amount: 200.56, // round2 到分
      category_id: CAT2,
      from_account_id: ACC2,
      to_account_id: null,
      occurred_at: new Date("2026-09-01T08:15").toISOString(),
      tag_ids: ["t-1"], // 标签不在点名范围内 ⇒ 原样保留
      note: "打的",
    });
  });

  it("金额填 0 ⇒ 留在编辑区并报错，编辑不生效（不许静默记出 0 元）", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-edit"]').trigger("click");
    await w.get('[data-test="draft-edit-amount"]').setValue("0");
    await w.get('[data-test="draft-edit-save"]').trigger("click");

    // 杀手：`onSaveEdit` 不校验（直接采用表单值）⇒ 编辑区收起、下面两条红
    expect(w.get('[data-test="draft-error"]').text()).toBe("金额要大于 0");
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(true);

    // 而且"没保存成功的编辑"不许影响确认：确认键此时不在（还在编辑区），取消后确认仍是原值
    await w.get('[data-test="draft-edit-cancel"]').trigger("click");
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(addSpy.mock.calls[0]![0].amount).toBe(128.5);
  });

  it("转账：用户把两个账户挑成同一个 ⇒ 拦下（这条规则以前不可达）", async () => {
    const transfer: AiDraftFields = {
      ...DRAFT,
      type: "transfer",
      category: null,
      toAccount: "现金",
    };
    const w = mount(DraftCard, {
      props: { draft: transfer, resolved: { ...IDS, toAccountId: ACC2 } },
    });
    await w.get('[data-test="draft-edit"]').trigger("click");
    await w.get('[data-test="draft-edit-from"]').setValue(FROM);
    await w.get('[data-test="draft-edit-to"]').setValue(FROM);
    await w.get('[data-test="draft-edit-save"]').trigger("click");

    // 杀手：删掉 `applyDraftEdit` 里的"转出≠转入"守卫 ⇒ 这条红（会记出一笔自己转给自己）
    expect(w.get('[data-test="draft-error"]').text()).toBe("转出和转入账户不能相同");
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(true);
  });

  it("候选名表：分类下拉只给同类型，账户下拉排除软删/别人的账户", async () => {
    stores.ledgerType = "team"; // 团队账本才启用"只给自己名下账户"那条过滤
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-edit"]').trigger("click");

    // 杀手：分类下拉不过滤 type ⇒ 「工资」出现在支出草稿的分类里
    expect(optionTexts(w, "draft-edit-category")).toEqual(["请选择分类", "买菜", "打车"]);
    // 杀手：账户下拉不过滤 ⇒ 「老婆的卡」「已删账户」出现（照 useTransactionForm.availableAccounts:48-54）
    expect(optionTexts(w, "draft-edit-from")).toEqual(["请选择账户", "招行", "现金"]);
  });

  it("确认时的必填校验看的是**改后**的值，不是 props（修好一张缺 id 的草稿）", async () => {
    // 夹具依据：`ResolvedDraftIds` 的字段**类型允许** null，`readDrafts` 只校验形状 ⇒ 这种草稿
    // 能到达组件。⚠️ 它**不是**今天生成链路的产物（`tools.ts:689-695` 会拒掉），不许当"生产可达"引用。
    const incomplete: AiDraftIds = { categoryId: null, fromAccountId: FROM, toAccountId: null, tagIds: [] };
    const w = mount(DraftCard, { props: { draft: DRAFT, resolved: incomplete } });

    // props 那份是**不合格**的：直接确认会被 validateDraft 拦下（钉住夹具本身的前提）
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(addSpy).not.toHaveBeenCalled();
    expect(w.get('[data-test="draft-error"]').text()).toBe("这张草稿缺分类，不能记账");

    // 用户在内联编辑里补上分类 ⇒ 确认必须放行
    await w.get('[data-test="draft-edit"]').trigger("click");
    await w.get('[data-test="draft-edit-category"]').setValue(CAT2);
    await w.get('[data-test="draft-edit-save"]').trigger("click");
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 杀手：`onConfirm` 里的 `validateDraft(fields.value, ids.value)` 换回 `props.*`
    // ⇒ 这里红（改好的草稿被判"缺分类"，用户永远记不上，且看到的是一句与事实相反的错误）
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0]![0].category_id).toBe(CAT2);
  });

  it("换草稿（props.draft 变）⇒ 编辑缓冲跟着丢，不会出现「显示 A、确认写 B」", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-edit"]').trigger("click");
    await w.get('[data-test="draft-edit-amount"]').setValue("999");
    await w.get('[data-test="draft-edit-save"]').trigger("click");

    const next: AiDraftFields = { ...DRAFT, amount: 42, category: "打车", note: null };
    await w.setProps({ draft: next, resolved: { ...IDS, categoryId: CAT2 } });
    expect(w.find('[data-test="draft-edit-form"]').exists()).toBe(false);
    expect(w.get('[data-test="draft-category"]').text()).toBe("打车");

    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    // 杀手：watch 里不清 `editedFields` ⇒ 这里仍是 999（写的是上一张草稿的值）
    expect(addSpy.mock.calls[0]![0].amount).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// §7.4：草稿卡的金额（含它的**编辑区输入框**）也是金额出口
// ---------------------------------------------------------------------------
describe("DraftCard 金额遮罩（§7.4）", () => {
  it("masked=true 压过全局开关：卡上不出现真金额，编辑区也不预填真金额", async () => {
    // 全局把遮蔽关掉（用户手动点开过）—— `masked` 仍必须赢：这是**历史消息**，跟着遮罩走
    const prefs = usePrefsStore();
    prefs.amountsHidden = false;

    const w = mount(DraftCard, { props: { ...props, masked: true } });
    // 杀手：`maskCurrency(fields.amount, hidden)` 换回不传 hidden（只读全局）⇒ 两条都红
    expect(w.get('[data-test="draft-card"]').text()).not.toContain("128");
    expect(w.get('[data-test="draft-card"]').text()).toContain(AMOUNT_PLACEHOLDER);

    await w.get('[data-test="draft-edit"]').trigger("click");
    // 杀手：`onStartEdit` 里 `amount: hidden ? "" : String(...)` 换回无条件 `String(...)`
    // ⇒ 编辑区把刚遮住的数字又摆回屏幕正中（同一屏、同一个数字）
    expect((w.get('[data-test="draft-edit-amount"]').element as HTMLInputElement).value).toBe("");
    expect((w.get('[data-test="draft-edit-amount"]').element as HTMLInputElement).placeholder).toBe(
      "请输入金额",
    );
  });

  it("masked=false ⇒ 显示真值（本轮问出来的那张卡），未传时跟随全局开关", () => {
    const prefs = usePrefsStore();
    prefs.amountsHidden = true;

    // 本轮：`masked=false` 压过全局的"遮" —— 两个方向都要能赢，才算真的按消息判
    const shown = mount(DraftCard, { props: { ...props, masked: false } });
    expect(shown.get('[data-test="draft-card"]').text()).toContain("128.5");

    // 旧调用点（不传 masked）：跟随全局（默认就是遮）
    const legacy = mount(DraftCard, { props });
    expect(legacy.get('[data-test="draft-card"]').text()).toContain(AMOUNT_PLACEHOLDER);
  });
});
