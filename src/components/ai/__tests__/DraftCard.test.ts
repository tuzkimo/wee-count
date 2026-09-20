import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

// ⚠️ 本文件要钉的是「草稿卡**本层零写入**」：它只许走既有记账入口，不许自己碰库、不许写 AI 会话表。
// 所以下面每一个"不该被调"的函数都换成了**一调用即断言失败**的 spy
// （不是"返回假值"，而是被调用本身就红 —— 照 runQuery.test.ts 里 `execute: 一调用即抛` 的做法）。
const sessionSpy = vi.hoisted(() => ({
  ensureConversation: vi.fn(async () => null as string | null),
  recentTurns: vi.fn(async () => []),
  appendMessage: vi.fn(async () => true),
  setTitleIfEmpty: vi.fn(async () => {}),
  loadMessages: vi.fn(async () => []),
  clearConversation: vi.fn(async () => {}),
}));

/**
 * 记账入口的替身。**参数类型写在 mock 上**：不写的话 `mock.calls[0]` 是空元组，
 * "参数逐字相等"这条断言连编译都过不去（`vue-tsc` 实测抓到）——
 * 而它的类型故意收成 `Record<string, unknown>`：本组件只该把 `buildDraftData` 的产出原样递进去，
 * 测试不该依赖 `transactionStore.add` 的完整入参类型（那是另一个模块的契约）。
 */
const addSpy = vi.hoisted(() =>
  vi.fn<(data: Record<string, unknown>) => Promise<string>>(async () => "tx-1"),
);
const removeSpy = vi.hoisted(() => vi.fn(async () => {}));

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

const props = { draft: DRAFT, resolved: IDS, source: "draft" as const, messageId: "m-1" };

beforeEach(() => {
  setActivePinia(createPinia());
  addSpy.mockClear();
  removeSpy.mockClear();
  for (const fn of Object.values(sessionSpy)) fn.mockClear();
});

describe("DraftCard", () => {
  it("渲染草稿内容（名字，不是 id）", () => {
    const w = mount(DraftCard, { props });
    expect(w.get('[data-test="draft-card"]').text()).toContain("支出");
    expect(w.get('[data-test="draft-category"]').text()).toBe("买菜");
    expect(w.get('[data-test="draft-from"]').text()).toBe("招行");
    expect(w.get('[data-test="draft-note"]').text()).toBe("盒马");
    // 真 id 只在本地，一个都不许渲染出来
    expect(w.get('[data-test="draft-card"]').text()).not.toContain(CAT);
    expect(w.get('[data-test="draft-card"]').text()).not.toContain(FROM);
  });

  it("确认走**既有**记账入口 transactionStore.add，参数与 buildDraftData 逐字相等", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(addSpy).toHaveBeenCalledTimes(1);
    // 参数不是"看着差不多"：与纯映射的输出**逐字**相等（字段来源由 draftData.test.ts 钉）
    const [data] = addSpy.mock.calls[0]!;
    expect(data).toEqual(buildDraftData(DRAFT, IDS, "L1", "local-user-1"));
    expect(w.emitted("confirm")).toHaveLength(1);
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

  it("拒绝只发事件：一次记账调用都没有，也没有 DB 写入", async () => {
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-reject"]').trigger("click");
    await flushPromises();

    expect(w.emitted("reject")).toHaveLength(1);
    expect(w.emitted("confirm")).toBeUndefined();
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
  });

  it("记账抛错时显示失败、不假装成功（也不吞掉）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    addSpy.mockRejectedValueOnce(new Error("db down"));
    const w = mount(DraftCard, { props });
    await w.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="draft-error"]').text()).toContain("记账失败");
    expect(w.emitted("confirm")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("记账进行中按钮禁用（双击不该记两笔）", async () => {
    let release = (): void => {};
    addSpy.mockImplementationOnce(
      () => new Promise<string>((res) => { release = () => res("tx-1"); }),
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
