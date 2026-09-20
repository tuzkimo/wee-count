// src/stores/__tests__/aiChat.loadSeq.test.ts
//
// 单独一个文件、单独一套 mock：这里要验的是**旧账本的响应后到**这一形态（账本隔离），
// 而 aiChat.test.ts 跑的是真 SQLite —— 真库的两次查询没法确定性地乱序，所以那边注不进
// 这个 fixture。宁可多一个文件，也不把真库那套证据掺进 mock。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { flushPromises } from "@vue/test-utils";

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => null,
    getCurrentUserId: () => "local-1",
    getTeamMembers: async () => [],
  };
});

vi.mock("@/services/ai/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/session")>();
  return { ...actual, ensureConversation: vi.fn(), loadMessages: vi.fn() };
});

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

import { ensureConversation, loadMessages, type AiMessageRow } from "@/services/ai/session";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import type { Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";

function ledger(id: string): Ledger {
  return {
    id, name: id, type: "personal", team_id: null, owner_id: "u1",
    created_at: T0, updated_at: T0, is_deleted: false,
  };
}

function row(id: string, content: string): AiMessageRow {
  return { id, conversation_id: "x", role: "user", content, payload: null, created_at: T0 };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
});

describe("切账本时的加载竞态（账本隔离）", () => {
  it("旧账本的读后到时不得覆盖新账本的消息（杀手：去掉 load 的 seq 守卫 → 显示上一个账本的对话）", async () => {
    vi.mocked(ensureConversation).mockImplementation(async (ledgerId: string) => `conv-${ledgerId}`);
    const slowL1 = deferred<AiMessageRow[]>();
    vi.mocked(loadMessages)
      .mockImplementationOnce(() => slowL1.promise) // L1：挂在半路
      .mockImplementationOnce(async () => [row("m2", "L2 的问")]); // L2：立刻返回

    const ledgerStore = useLedgerStore();
    ledgerStore.ledgers = [ledger("L1"), ledger("L2")];
    ledgerStore.currentLedgerId = "L1"; // 在 store 之前设，避免 watch 提前插一脚

    const store = useAiChatStore();
    const p1 = store.load(); // 这一次读 L1，会被挂住
    ledgerStore.currentLedgerId = "L2"; // 触发 watch ⇒ 第二次 load（seq 递增）
    await flushPromises();

    // 前提守卫：两次读**真的**都发出去了，否则"最后一个赢"可能只是因为压根没有第二次（空转）
    expect(vi.mocked(loadMessages).mock.calls.map((c) => c[0])).toEqual(["conv-L1", "conv-L2"]);
    expect(store.conversationId).toBe("conv-L2");
    expect(store.messages.map((m) => m.content)).toEqual(["L2 的问"]);

    slowL1.resolve([row("m1", "L1 的问")]); // 旧账本的响应现在才到
    await p1;
    await flushPromises();

    expect(store.messages.map((m) => m.content)).toEqual(["L2 的问"]);
    expect(store.conversationId).toBe("conv-L2");
    expect(store.loading).toBe(false);
  });
});
