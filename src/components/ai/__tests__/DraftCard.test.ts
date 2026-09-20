import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// ⚠️ 本文件要钉的是「草稿卡**本层零写入**」与「撤销用的是 `add` 返回的那个 id」。
// 所以"不该被调"的函数都换成 **一调用即断言失败** 的替身
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
 * `add` 返回的**新交易 id**。用真 UUID 形状：撤销那条断言要"只能来自 add 的返回"，
 * 拿 `"tx-1"` 这种短串会让"猜一个 id"的变异同样通过（Ruling 13 的同族：夹具必须带真形状）。
 */
const ADDED_ID = "7f3a1c2e-9b4d-4e6f-8a1b-2c3d4e5f6a7b";
/** transactionStore 里的"已有流水"：组件**不该**从这里找撤销对象（那是"猜最后一笔"） */
const OTHER_ID = "deadbeef-0000-4000-8000-000000000001";

/**
 * 记账入口的替身。**参数类型写在 mock 上**：不写的话 `mock.calls[0]` 是空元组，
 * "参数逐字相等"这条断言连编译都过不去（`vue-tsc` 实测抓到）——
 * 而它的类型故意收成 `Record<string, unknown>`：本组件只该把 `buildDraftData` 的产出原样递进去，
 * 测试不该依赖 `transactionStore.add` 的完整入参类型（那是另一个模块的契约）。
 */
const addSpy = vi.hoisted(() =>
  vi.fn<(data: Record<string, unknown>) => Promise<string>>(async () => ADDED_ID),
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

// ⚠️ 只剩 draft / resolved 两个 prop：`source`（单字面量、无从分支）与 `messageId`（组件内零读取）
// 都已按审查裁决删掉 —— 留着就是"空的保证"，且没有任何变异能因它们而红。
const props = { draft: DRAFT, resolved: IDS };

beforeEach(() => {
  setActivePinia(createPinia());
  addSpy.mockClear();
  removeSpy.mockClear();
  addSpy.mockImplementation(async () => ADDED_ID);
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

  it("确认后渲染「已记账 ✓ + 撤销」，并把 `add` 返回的 id 带进 confirm/saved 事件", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 已记账态：确认/不要 收起，换成 已记账 + 撤销（§4.4）
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(true);
    expect(w.get('[data-test="draft-saved-text"]').text()).toContain("已记账");
    expect(w.find('[data-test="draft-undo"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-confirm"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-reject"]').exists()).toBe(false);
    // id 必须**是 add 的返回值**（页面拿它去 dismissDraft；撤销也才有落点）
    expect(w.emitted("confirm")).toEqual([[ADDED_ID]]);
    expect(w.emitted("saved")).toEqual([[ADDED_ID]]);
    expect(w.emitted("undo")).toBeUndefined();
  });

  it("撤销调 `transactionStore.remove(ADDED_ID)` —— id 来自 `add` 的返回，不是猜最后一笔", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();

    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(ADDED_ID);
    // 反向钉：store 里那条**别的**流水（OTHER_ID）绝不能被当成撤销对象
    expect(removeSpy).not.toHaveBeenCalledWith(OTHER_ID);
    expect(w.emitted("undo")).toEqual([[ADDED_ID]]);
  });

  it("撤销成功后回到待确认态（可以再确认一次）", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await w.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-confirm"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-undo"]').exists()).toBe(false);
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
  });

  it("名字没解析出 id 时**不记账**，并把原因显示出来（add 不做校验，会静默记出脏账）", async () => {
    const w = mount(DraftCard, { props: { ...props, resolved: { ...IDS, categoryId: null } } });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(addSpy).not.toHaveBeenCalled();
    expect(w.get('[data-test="draft-error"]').text()).toContain("分类");
    expect(w.emitted("confirm")).toBeUndefined();
    // 守卫拦下的失败**不能**进入已记账态（那会让用户以为记上了）
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
  });

  it("记账抛错时显示失败、回到可确认态、不进入已记账态", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSpy.mockRejectedValueOnce(new Error("db down"));
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="draft-error"]').text()).toContain("记账失败");
    expect(w.emitted("confirm")).toBeUndefined();
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-confirm"]').exists()).toBe(true);
    expect(warn).toHaveBeenCalled();
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
    expect(w.find('[data-test="draft-saved"]').exists()).toBe(true);
    expect(w.emitted("undo")).toBeUndefined();
    warn.mockRestore();
  });

  it("记账进行中按钮禁用，双击只记一笔", async () => {
    let release = (): void => {};
    addSpy.mockImplementationOnce(
      () => new Promise<string>((res) => { release = () => res(ADDED_ID); }),
    );
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await w.vm.$nextTick();

    expect(w.get('[data-test="draft-confirm"]').attributes("disabled")).toBeDefined();
    await w.get('[data-test="draft-confirm"]').trigger("click");
    expect(addSpy).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
  });
});
