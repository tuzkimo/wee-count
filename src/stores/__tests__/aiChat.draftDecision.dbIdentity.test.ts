// src/stores/__tests__/aiChat.draftDecision.dbIdentity.test.ts
//
// Bug 3 的复现：**首次**点「确认记账 / 不要 / 撤销」必然失败，切页回来才正常。
//
// 根因（本文件就是它的杀手）：`aiChat.ts` 的 `updateDraftPayload` 把**内存消息 id** 当库键用。
//   - 本轮草稿的 `messageId` 来自 `appendTurn` → `appendAssistant`：那是 `crypto.randomUUID()`
//     造的**内存** id（`aiChat.ts:556`，store 自己的注释也写着"任何 UI 都不许把内存 id 当库键用"）；
//   - 而库里那条 assistant 行的 id 是 `agent.ts:404` **另外**造的一个 UUID；
//   - `UPDATE ... AND id = ?` 于是恒不命中 ⇒ `rowsAffected = 0` ⇒ 返回 false ⇒ 页面打 rollback 文案。
//   - 切页回来时 `load()` 用 `r.id`（库里那份）重建 `allDrafts` ⇒ `messageId` 换成库 id ⇒ 命中。
//
// ⚠️ 为什么既有的 `aiChat.draftDecision.test.ts` 抓不到它：那个文件的 `persistDrafts` 刻意用
//    **store 内存消息 id** 造 assistant 行（它自己的注释也承认"真实 agent 落库时另造 UUID，
//    这里没有那一步"）。那份"两边同 id"的夹具正是生产里不存在的前提 —— 本文件把它换回真形态。
//
// 与既有文件同法：真 sqlite + 真 session.ts + 真 store，只换 `runAgent` 与 `@/db/userDb` 入口。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { DatabaseSync } from "node:sqlite";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => state.db as never,
    getCurrentUserId: () => "local-1",
    getTeamMembers: vi.fn(async () => [] as never),
  };
});

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

import { initUserTables } from "@/db/userDb";
import { ensureConversation, loadMessages } from "@/services/ai/session";
import { runAgent, type AgentTurn } from "@/services/ai/agent";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import type { Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const TX_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

/**
 * 库里那条 assistant 行的 id：**真 UUID 形状，且与内存消息 id 不同**。
 * 形状必须真（短串会让"按 id 命中"的断言失去判别力），必须不同（这正是 bug 的触发条件）。
 */
const DB_MESSAGE_ID = "6ee2b7e0-2d64-4a2e-9b7e-3a5c8f1d0b42";

function rawDraft(n: number) {
  return {
    draftId: `d-${n}`,
    draft: {
      type: "expense",
      amount: 100 + n,
      category: "买菜",
      fromAccount: "招行",
      toAccount: null,
      occurredAt: "2026-02-28T00:00",
      note: `第${n}笔`,
      tags: [],
    },
    resolved: { categoryId: null, fromAccountId: null, toAccountId: null, tagIds: [] },
  };
}

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
}

function asTauriDb(sqlite: DatabaseSync) {
  return {
    execute: vi.fn(
      async (sql: string, params: unknown[] = []): Promise<unknown> => {
        const r = sqlite.prepare(sql).run(...(params as never[]));
        return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
      },
    ),
    select: vi.fn(
      async (sql: string, params: unknown[] = []): Promise<unknown> =>
        sqlite.prepare(sql).all(...(params as never[])),
    ),
  };
}

const opened: DatabaseSync[] = [];

async function useRealDb(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  await initUserTables(asTauriDb(sqlite) as never);
  state.db = asTauriDb(sqlite);
  opened.push(sqlite);
  return sqlite;
}

function setLedger(id: string): void {
  const ledgerStore = useLedgerStore();
  const ledger: Ledger = {
    id, name: "家", type: "personal", team_id: null, owner_id: OWNER_ID,
    created_at: T0, updated_at: T0, is_deleted: false,
  };
  ledgerStore.ledgers = [ledger];
  ledgerStore.currentLedgerId = id;
}

function openGate(): ReturnType<typeof useAiChatStore> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  return store;
}

/**
 * 造"草稿**已经落库**"的真形态：assistant 行的 id 由 `agent.ts:404` 那一侧另造（这里就是
 * `DB_MESSAGE_ID`），**与 store 内存消息 id 无关**。这是与既有 `persistDrafts` 的唯一差别，
 * 也正是生产与测试夹具唯一的差别。
 */
async function persistAssistantRow(
  sqlite: DatabaseSync,
  store: ReturnType<typeof useAiChatStore>,
  drafts: unknown[],
): Promise<void> {
  const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
  const assistantMessage = store.messages.find((m) => m.role === "assistant")!;
  sqlite
    .prepare(
      "INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)",
    )
    .run(
      DB_MESSAGE_ID,
      cid,
      assistantMessage.content,
      JSON.stringify({ chips: [], drafts, refs: {}, trace: [] }),
      T0,
    );
}

/** 磁盘上那份草稿（判据落在库里，不在内存投影） */
async function storedDraft(draftId = "d-1"): Promise<Record<string, unknown>> {
  const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
  const rows = await loadMessages(cid);
  for (const row of rows) {
    if (row.payload === null) continue;
    const parsed = JSON.parse(row.payload) as { drafts?: Record<string, unknown>[] };
    for (const d of parsed.drafts ?? []) {
      if (d.draftId === draftId) return d;
    }
  }
  throw new Error(`库里没有 ${draftId}`);
}

/** 一条"刚问出来、已落库"的草稿，并在落库后先钉住那个真形态（id 两套身份） */
async function givenPersistedDraft(
  sqlite: DatabaseSync,
  drafts = [rawDraft(1)],
): Promise<ReturnType<typeof useAiChatStore>> {
  const store = openGate();
  vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
  await store.send("记一笔");
  await persistAssistantRow(sqlite, store, drafts);
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
});

describe("Bug 3：库里那条行的 id 与内存消息 id 不是同一个（真形态）", () => {
  it("前提：内存消息 id 与库里 assistant 行的 id **不同**（同 id 的夹具才是假形态）", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = await givenPersistedDraft(sqlite);

    const memoryId = store.messages.find((m) => m.role === "assistant")!.id;
    expect(memoryId).not.toBe(DB_MESSAGE_ID);
    // 而库里那条行确实在（否则下面几条测的就不是"定位键错了"，而是"根本没落库"）
    expect(sqlite.prepare("SELECT id FROM ai_messages WHERE role = 'assistant'").get()).toEqual({
      id: DB_MESSAGE_ID,
    });
  });

  it("首次「确认记账」必须成功（不是切页回来才成功）", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = await givenPersistedDraft(sqlite);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // 杀手：`updateDraftPayload` 的 WHERE 里留着 `id = <内存消息 id>`（或用它当库键）⇒ 返回 false
    const ok = await store.confirmDraft("d-1", TX_ID);

    expect(ok).toBe(true);
    expect(store.confirmedDrafts.map((d) => [d.draftId, d.savedTransactionId])).toEqual([
      ["d-1", TX_ID],
    ]);
    expect(store.pendingDrafts).toEqual([]);
    // 落点是磁盘上那份（否则"重进页面草稿复活 ⇒ 再确认 = 第二笔真账"）
    expect(await storedDraft()).toMatchObject({ status: "confirmed", transactionId: TX_ID });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("首次「不要」必须成功（同一条定位键的另一个出口）", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = await givenPersistedDraft(sqlite);

    const ok = await store.rejectDraft("d-1");

    expect(ok).toBe(true);
    expect(store.pendingDrafts).toEqual([]);
    expect(store.rejectedDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(await storedDraft()).toMatchObject({ status: "rejected" });
  });

  it("首次「确认 → 撤销」必须成功（撤销那条写的是 confirmed → pending，同样按这条键定位）", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = await givenPersistedDraft(sqlite);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await store.confirmDraft("d-1", TX_ID)).toBe(true);
    const ok = await store.undoDraft("d-1");

    expect(ok).toBe(true);
    expect(store.confirmedDrafts).toEqual([]);
    expect(store.pendingDrafts.map((d) => [d.draftId, d.status])).toEqual([["d-1", "pending"]]);
    expect(await storedDraft()).toMatchObject({ status: "pending" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("决定仍然只落在**那个账本**的那张草稿上（定位键放宽后不许误伤）", async () => {
    const sqlite = await useRealDb();
    // 另一个账本里有一条**同 draftId** 的草稿：漏掉会话限定就会把它一起改掉
    const cid2 = (await ensureConversation("L-2", new Date(T0)))!;
    sqlite
      .prepare(
        "INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at) VALUES (?, ?, 'assistant', '答', ?, ?)",
      )
      .run(
        "m-l2",
        cid2,
        JSON.stringify({ drafts: [rawDraft(1), rawDraft(2)] }),
        T0,
      );

    setLedger(LEDGER_ID);
    const store = await givenPersistedDraft(sqlite, [rawDraft(1), rawDraft(2)]);

    expect(await store.confirmDraft("d-1", TX_ID)).toBe(true);
    expect(await store.rejectDraft("d-2")).toBe(true);

    // 本账本两张都按各自的决定写进去了（同一行里只 patch 命中的那张）
    expect(await storedDraft("d-1")).toMatchObject({ status: "confirmed", transactionId: TX_ID });
    expect(await storedDraft("d-2")).toMatchObject({ status: "rejected" });

    // 另一个账本：**一个字节都不动**
    const other = sqlite
      .prepare("SELECT payload FROM ai_messages WHERE id = 'm-l2'")
      .get() as { payload: string };
    expect(JSON.parse(other.payload)).toEqual({ drafts: [rawDraft(1), rawDraft(2)] });
  });
});
