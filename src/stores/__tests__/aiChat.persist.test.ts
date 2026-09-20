// src/stores/__tests__/aiChat.persist.test.ts
//
// 真 agent + 真 session + 真 sqlite：这一文件专门验两件**只有真链路才看得见**的事 ——
//  ① `clear()` 必须等在途那一轮**落定**："幽灵消息"（复审 P6）只在 `agent.ts` 的
//     `persistAssistant` → `session.appendMessage` 真的落库时才存在；`runAgent` 一被 mock，
//     库里压根没有那条写，形态就假了。
//  ② 内存消息 id 与库行 id 是**两套独立身份**（复审 P7）：同样要真落库才比得出来。
//
// 所以这里**不** mock `@/services/ai/agent`。被换掉的只有两处：
//  - `createTransport`（agent 的行为源 ⇒ 不真发 HTTP）
//  - `appendMessage`（**加闸门**后原样委托真实现 ⇒ 复现"abort 落在 persist 的 await 里"）
// `aiChat.test.ts` 与这里的分工：那边验"store 传了什么、拿回来的怎么映射"（mock agent），
// 这里验"真链路下 store 的收口"。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { DatabaseSync } from "node:sqlite";
import { flushPromises } from "@vue/test-utils";

const state = vi.hoisted(() => ({ db: null as unknown, teamMembers: [] as unknown[] }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => state.db as never,
    getCurrentUserId: () => "local-1",
    getTeamMembers: vi.fn(async () => state.teamMembers as never),
  };
});

/** assistant 那次落库的闸门（`wait` 非 null 时挂住；`entered` 用来让用例确定"已经进去了"） */
const gate = vi.hoisted(() => ({
  wait: null as Promise<void> | null,
  entered: null as (() => void) | null,
}));

vi.mock("@/services/ai/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/session")>();
  return {
    ...actual,
    appendMessage: vi.fn(async (row: Parameters<typeof actual.appendMessage>[0]) => {
      if (row.role === "assistant" && gate.wait !== null) {
        gate.entered?.();
        await gate.wait;
      }
      return actual.appendMessage(row); // 闸门之后是**真实现**：真 INSERT
    }),
  };
});

vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return {
    ...actual,
    // 一次就收口（没有 tool_calls）⇒ agent 走到 `persistAssistant` 那一行
    createTransport: (): import("@/services/ai/transport").Transport => ({
      chat: async (): Promise<import("@/services/ai/transport").ChatOutcome> => ({
        ok: true,
        reply: { text: "答案", toolCalls: [], finishReason: "stop" },
      }),
    }),
  };
});

import { initUserTables } from "@/db/userDb";
import { ensureConversation, loadMessages } from "@/services/ai/session";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import type { Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";

function asTauriDb(sqlite: DatabaseSync) {
  return {
    execute: vi.fn(
      async (sql: string, params: unknown[] = []): Promise<unknown> =>
        sqlite.prepare(sql).run(...(params as never[])),
    ),
    select: vi.fn(
      async (sql: string, params: unknown[] = []): Promise<unknown> =>
        sqlite.prepare(sql).all(...(params as never[])),
    ),
  };
}

const opened: DatabaseSync[] = [];

async function useRealDb(): Promise<{ sqlite: DatabaseSync }> {
  const sqlite = new DatabaseSync(":memory:");
  await initUserTables(asTauriDb(sqlite) as never);
  state.db = asTauriDb(sqlite);
  opened.push(sqlite);
  return { sqlite };
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

function countRows(sqlite: DatabaseSync, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function conversationId(sqlite: DatabaseSync, ledgerId: string): string {
  const row = sqlite.prepare("SELECT id FROM ai_conversations WHERE ledger_id = ?").get(ledgerId) as
    | { id: string }
    | undefined;
  if (row === undefined) throw new Error(`没有 ledger_id=${ledgerId} 的会话行（用例前提不成立）`);
  return row.id;
}

function holdAssistantPersist(): { entered: Promise<void>; release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((res) => { release = res; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((res) => { entered = res; });
  gate.wait = wait;
  gate.entered = entered;
  return { entered: enteredPromise, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  state.teamMembers = [];
  gate.wait = null;
  gate.entered = null;
  setActivePinia(createPinia());
});

/**
 * 建 store 并打开 §7.3 的**意愿层门控**（默认关闭 ⇒ 不打开的话 `send` 一个请求都不发，
 * 也就没有可等的落库窗口）。门控自身在 `aiChat.privacy.test.ts` 里钉。
 * ⚠️ 必须在 `setLedger()` **之后**调（见 `aiChat.test.ts` 里 `openGate` 的注释）。
 */
function openGate(): ReturnType<typeof useAiChatStore> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  return store;
}

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
});

describe("clear() 与在途那一轮的落库窗口", () => {
  it("被掐掉的那一轮在落库 await 里：clear() 等它落定后一起删掉 ⇒ 复活后没有幽灵消息", async () => {
    const { sqlite } = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const held = holdAssistantPersist();

    const sending = store.send("这个月花了多少");
    await held.entered; // 已经进到 assistant 的 `appendMessage` 里（= 复审 P6 的"落库窗口"）
    // 前提守卫：这一轮真的进了窗口（user 已落库、assistant 还挂在闸门上）
    expect(countRows(sqlite, "ai_conversations")).toBe(1);
    expect(countRows(sqlite, "ai_messages")).toBe(1);
    const cid = conversationId(sqlite, LEDGER_ID);

    const clearing = store.clear(); // abort + 等在途落定 + clearConversation
    await flushPromises();
    held.release(); // 迟到的写现在才真的落地
    await clearing;
    await sending;

    expect(store.messages).toEqual([]);
    expect(store.pendingDrafts).toEqual([]);
    expect(store.error).toBeNull();
    expect(store.sending).toBe(false);

    // 杀手：`clear()` 不等在途那一轮（修前实现：abort + 立刻 clearConversation）⇒ 迟到的写落在
    //   软删之后 ⇒ 下面两条红（真库里多一条消息行 / 复活后读得到它）。
    expect(countRows(sqlite, "ai_messages")).toBe(0);
    expect(await loadMessages(cid)).toEqual([]);

    // 幽灵消息**唯一可观测的形态**：下一次发言前 `ensureConversation` 复活同一行（Ruling 7）
    const revived = await ensureConversation(LEDGER_ID, new Date());
    expect(revived).toBe(cid);
    expect(await loadMessages(revived!)).toEqual([]);
  });
});

describe("内存消息 id 与库行 id", () => {
  it("是两套独立身份：谁都不许当对方的替代；重开后换成库里的 id，payload 往返整份相等", async () => {
    const { sqlite } = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();

    await store.send("这个月花了多少");

    const cid = conversationId(sqlite, LEDGER_ID);
    const rows = await loadMessages(cid);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ["user", "这个月花了多少"],
      ["assistant", "答案"],
    ]);

    const memIds = store.messages.map((m) => m.id);
    const dbIds = rows.map((r) => r.id);
    // 两套都必须是真 UUID 形态，否则"互不相等"可能是碰巧（空串 == 空串 等等）
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    for (const id of [...memIds, ...dbIds]) expect(id).toMatch(uuid);

    // store 乐观消息用自己造的 UUID，agent 落库时另造一个 ⇒ 同一条消息"刚发完"与"重开"id 不同。
    // ⚠️ 主动声明：这一条的判别力有限（store 无从知道库行 id，几乎改不红），它是**契约注释**；
    //    真正的判别力在下面"load 之后必须换成库里的 id"那一条。
    for (const id of dbIds) expect(memIds).not.toContain(id);

    const memPayloads = store.messages.map((m) => m.payload);
    await store.load();
    // 杀手：`load()` 里 `id: r.id` 改成自己再生成一个 UUID（或按索引复用内存 id）→ 这两条红
    expect(store.messages.map((m) => m.id)).toEqual(dbIds);
    // payload 往返**整份**相等：换身份不许改内容（refs/chips/drafts/trace 全留着）
    expect(store.messages.map((m) => m.payload)).toEqual(memPayloads);
  });
});
