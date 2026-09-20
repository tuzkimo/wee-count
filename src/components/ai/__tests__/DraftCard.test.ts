import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// ⚠️ 本文件要钉的是「草稿卡**本层零写入**」「撤销用的是 `add` 返回的那个 id」
// 与「换草稿时自清（防删旧账）」。所以"不该被调"的函数都换成 **一调用即断言失败** 的替身
// （`getUserDb` 直接抛，不是返回假值 —— 照 runQuery.test.ts 里 `execute: 一调用即抛` 的做法）。
const sessionSpy = vi.hoisted(() => ({
  ensureConversation: vi.fn(async () => null as string | null),
  recentTurns: vi.fn(async () => []),
  appendMessage: vi.fn(async () => true),
  setTitleIfEmpty: vi.fn(async () => {}),
  loadMessages: vi.fn(async () => []),
  clearConversation: vi.fn(async () => {}),
}));

/**
 * 两条草稿各自的交易 id。都用**真 UUID 形状**：撤销那条断言要"只能来自 `add` 的返回"，
 * 拿 `"tx-1"` 这种短串会让"猜一个 id"的变异同样通过（Ruling 13 的同族：夹具必须带真形状）。
 *
 * 两个 id 各自对应**一条草稿**（D1 / D2）：同实例换 props 的杀手要求夹具里**真有两个不同的 id**
 * —— 只放一个的话，"点撤销删的是旧账"和"删的是新账"看起来一模一样（红不了）。
 */
const ID_D1 = "7f3a1c2e-9b4d-4e6f-8a1b-2c3d4e5f6a7b";
const ID_D2 = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
/** transactionStore 里的"已有流水"：组件**不该**从这里找撤销对象（那是"猜最后一笔"） */
const OTHER_ID = "deadbeef-0000-4000-8000-000000000001";

/**
 * 记账入口的替身。**参数类型写在 mock 上**：不写的话 `mock.calls[0]` 是空元组，
 * "参数逐字相等"这条断言连编译都过不去（`vue-tsc` 抓到过）——
 * 而它的类型故意收成 `Record<string, unknown>`：本组件只该把 `buildDraftData` 的产出原样递进去。
 * 第一次 `add` 返回 `ID_D1`、第二次返回 `ID_D2`（照"每条草稿一笔"的真实时序）。
 */
const addSpy = vi.hoisted(() =>
  vi.fn<(data: Record<string, unknown>) => Promise<string>>(async () => ID_D1),
);
const removeSpy = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>(async () => {}));

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
  useTransactionStore: () => ({
    add: addSpy,
    remove: removeSpy,
    // 真实 store 有它。这里只放一条**别的**流水：实现若改成"猜最后一笔"，撤销的 id 就会是它 ⇒ 断言红
    transactions: [{ id: OTHER_ID }],
  }),
}));
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    currentLedger: { id: "L1", name: "账本", type: "personal", team_id: null },
    currentLedgerId: "L1",
    ledgers: [],
    setCurrentLedger: vi.fn(),
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: null, isAuthenticated: false }),
}));

import DraftCard from "@/components/ai/DraftCard.vue";
import { buildDraftData } from "@/components/ai/draftData";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

const CAT = "c1a7b8c9-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const FROM = "a1111111-2222-4333-8444-555555555555";

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

/** 第二份草稿：同实例换 props 用（金额/分类/备注都不同，便于肉眼确认视图真换了） */
const DRAFT2: AiDraftFields = {
  type: "expense",
  amount: 42,
  category: "打车",
  fromAccount: "现金",
  toAccount: null,
  occurredAt: "2026-09-02T08:00",
  note: "上班",
  tags: [],
};
const IDS2: AiDraftIds = {
  categoryId: "c-other",
  fromAccountId: "a-other",
  toAccountId: null,
  tagIds: [],
};

// ⚠️ 只剩 draft / resolved 两个 prop：`source`（单字面量、无从分支）与 `messageId`（组件内零读取）
// 都已按审查裁决删掉 —— 留着就是"空的保证"，且没有任何变异能因它们而红。
const props = { draft: DRAFT, resolved: IDS };

beforeEach(() => {
  setActivePinia(createPinia());
  addSpy.mockClear();
  removeSpy.mockClear();
  addSpy.mockImplementation(async () => ID_D1);
  for (const fn of Object.values(sessionSpy)) fn.mockClear();
});

describe("DraftCard", () => {
  it("渲染草稿内容（名字，不是 id）", () => {
    const w = mount(DraftCard, { props });
    expect(w.get('[data-test="draft-card"]').text()).toContain("支出");
    expect(w.get('[data-test="draft-category"]').text()).toBe("买菜");
    expect(w.get('[data-test="draft-from"]').text()).toBe("招行");
    expect(w.get('[data-test="draft-note"]').text()).toBe("盒马");
    expect(w.get('[data-test="draft-card"]').text()).not.toContain(CAT);
    expect(w.get('[data-test="draft-card"]').text()).not.toContain(FROM);
  });

  it("确认走**既有**记账入口 transactionStore.add，参数与 buildDraftData 逐字相等", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [data] = addSpy.mock.calls[0]!;
    expect(data).toEqual(buildDraftData(DRAFT, IDS, "L1", "local-user-1"));
  });

  it("确认后渲染「已记账 ✓ + 撤销」，并把 `add` 返回的 id 带进 confirm 事件", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 已记账态：确认/不要 收起，换成 已记账 + 撤销（§4.4）
    expect(w.attributes("data-draft-state")).toBe("saved");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(true);
    expect(w.get('[data-test="draft-saved-text"]').text()).toContain("已记账");
    expect(w.find('[data-test="draft-undo"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-confirm"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-reject"]').exists()).toBe(false);
    // id 必须**是 add 的返回值**（页面拿它去 dismissDraft；撤销也才有落点）。
    // 对外只有**一个**成功事件（曾经 confirm + saved 同 id 双发 ⇒ 页面会 dismissDraft 两次）
    expect(w.emitted("confirm")).toEqual([[ID_D1]]);
    expect(w.emitted("saved")).toBeUndefined();
  });

  it("撤销调 `transactionStore.remove(ID_D1)` —— id 来自 `add` 的返回，不是猜最后一笔", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(ID_D1);
    // 反向钉：store 里那条**别的**流水（OTHER_ID）绝不能被当成撤销对象
    expect(removeSpy).not.toHaveBeenCalledWith(OTHER_ID);
    expect(w.emitted("undo")).toEqual([[ID_D1]]);
  });

  it("撤销在途仍显示「已记账」视图、撤销按钮禁用（不翻回确认/不要）", async () => {
    let release = (): void => {};
    removeSpy.mockImplementationOnce(
      () => new Promise<void>((res) => { release = () => res(); }),
    );
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await w.vm.$nextTick();

    // 关键：点下撤销的同一帧**不许**翻回"待确认"（那会让用户以为刚才那笔还在）
    expect(w.attributes("data-draft-state")).toBe("undoing");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(true);
    expect(w.get('[data-test="draft-saved-text"]').text()).toContain("已记账");
    expect(w.find('[data-test="draft-confirm"]').exists()).toBe(false);
    expect(w.get('[data-test="draft-undo"]').attributes("disabled")).toBeDefined();

    release();
    await flushPromises();
    expect(w.attributes("data-draft-state")).toBe("pending");
  });

  it("撤销成功后回到待确认态（按钮**可用**，可以再确认一次）", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();

    expect(w.attributes("data-draft-state")).toBe("pending");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-undo"]').exists()).toBe(false);
    // 不只看 exists：`saving` 卡死时这颗按钮**仍在**（disabled）⇒ 必须断言它真能用
    expect(w.get('[data-test="draft-confirm"]').attributes("disabled")).toBeUndefined();
    // 而且现在真的还能确认第二笔（用的是第二次 add 的返回 id）
    addSpy.mockImplementation(async () => ID_D2);
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(addSpy).toHaveBeenCalledTimes(2);
    expect(w.emitted("confirm")).toEqual([[ID_D1], [ID_D2]]);
  });

  it("同实例换 draft props ⇒ 状态自清：撤销**不许**删掉上一笔（防删旧账）", async () => {
    const w = mount(DraftCard, { props });
    // 第一张草稿确认（拿到 ID_D1）⇒ 卡片进入已记账态
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(w.attributes("data-draft-state")).toBe("saved");

    // 页面复用同一实例、只换 props（没加 :key）—— 复审 ③-2 的形态
    addSpy.mockImplementation(async () => ID_D2);
    await w.setProps({ draft: DRAFT2, resolved: IDS2 });

    // 自清：回到待确认，且**不再**显示"已记账"（旧账的撤销入口必须消失）
    expect(w.attributes("data-draft-state")).toBe("pending");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-undo"]').exists()).toBe(false);
    expect(w.get('[data-test="draft-category"]').text()).toBe("打车");

    // 确认第二张 ⇒ 撤销必须是 **ID_D2**，绝不能是 ID_D1（那就是删旧账）
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(ID_D2);
    expect(removeSpy).not.toHaveBeenCalledWith(ID_D1);
  });

  it("确认**不写** AI 会话表（草稿卡不是落库方，落库在 agent → session）", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    for (const [name, fn] of Object.entries(sessionSpy)) {
      expect(fn, `草稿卡不该调 session.${name}`).not.toHaveBeenCalled();
    }
    // 且**根本没拿过 DB 句柄**（mock 的 getUserDb 一调用即抛，走到就红）
    expect(addSpy).toHaveBeenCalledTimes(1);
  });

  it("拒绝只发事件：add 与 remove 都未调用，也没有 DB 写入", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-reject"]').trigger("click");
    await flushPromises();

    expect(w.emitted("reject")).toHaveLength(1);
    expect(w.emitted("confirm")).toBeUndefined();
    expect(w.emitted("undo")).toBeUndefined();
    expect(addSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    for (const fn of Object.values(sessionSpy)) expect(fn).not.toHaveBeenCalled();
    expect(w.attributes("data-draft-state")).toBe("pending");
  });

  it("名字没解析出 id 时**不记账**，并把原因显示出来（add 不做校验，会静默记出脏账）", async () => {
    const w = mount(DraftCard, { props: { ...props, resolved: { ...IDS, categoryId: null } } });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(addSpy).not.toHaveBeenCalled();
    expect(w.get('[data-test="draft-error"]').text()).toContain("分类");
    expect(w.emitted("confirm")).toBeUndefined();
    // 守卫拦下的失败**不能**进入已记账态（那会让用户以为记上了）
    expect(w.attributes("data-draft-state")).toBe("pending");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
  });

  it("记账抛错时显示失败、回到**按钮可用**的可确认态、不进入已记账态", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSpy.mockRejectedValueOnce(new Error("db down"));
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="draft-error"]').text()).toContain("记账失败");
    expect(w.emitted("confirm")).toBeUndefined();
    expect(w.attributes("data-draft-state")).toBe("pending");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
    // ⚠️ 不只看 exists：`saving` 卡死时按钮**仍在**（disabled）⇒ 必须断言它真的能用
    // （复审 m20：只断言 exists 时"卡在记账中不可重试"全绿）
    expect(w.get('[data-test="draft-confirm"]').attributes("disabled")).toBeUndefined();
    expect(w.get('[data-test="draft-reject"]').attributes("disabled")).toBeUndefined();
    // 而且重试真能再发一次 add
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(addSpy).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("撤销抛错时不假装撤销成功（仍留在已记账态、给出提示）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    removeSpy.mockRejectedValueOnce(new Error("db down"));
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="draft-error"]').text()).toContain("撤销失败");
    expect(w.attributes("data-draft-state")).toBe("saved");
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(true);
    // 还能再点一次撤销（按钮恢复可用）
    expect(w.get('[data-test="draft-undo"]').attributes("disabled")).toBeUndefined();
    expect(w.emitted("undo")).toBeUndefined();
    warn.mockRestore();
  });

  it("记账进行中确认/不要都禁用，双击只记一笔", async () => {
    let release = (): void => {};
    addSpy.mockImplementationOnce(
      () => new Promise<string>((res) => { release = () => res(ID_D1); }),
    );
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await w.vm.$nextTick();

    expect(w.attributes("data-draft-state")).toBe("saving");
    expect(w.get('[data-test="draft-confirm"]').attributes("disabled")).toBeDefined();
    expect(w.get('[data-test="draft-reject"]').attributes("disabled")).toBeDefined();
    await w.get('[data-test="draft-confirm"]').trigger("click");
    expect(addSpy).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
  });
});
