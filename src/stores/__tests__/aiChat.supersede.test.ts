// src/stores/__tests__/aiChat.supersede.test.ts
//
// §4.4.6（2026-09-24 人工批准）：**新草稿生成时，把当时仍待确认的旧草稿作废（`superseded`）**。
//
// 为什么要有这条：用户在对话里改口（"不是微信，是招行"）会让 `create_transaction_draft` 再调一次
// （§4.4.3 的正当路径 (a)）⇒ 消息流里出现两张待确认卡：一张旧的错误版本、一张新的。用户只能确认
// 其中一张，另一张要么被误确认、要么一直挂在那儿骗人点。
//
// 三条**不许扩大**的边界：
//  ① 只有"当时仍处于 `pending`"的旧草稿才被作废；**已记账**（`confirmed`）与**已撤回**
//     （`rejected`）的卡是用户真实的操作记录，一律不动、照旧保留；
//  ② 作废**不是**撤回：它是独立取值，绝不显示成「已撤回」（那会让用户以为自己否决过），
//     而且**完全不渲染**（页面只收 pending / confirmed / rejected 三份）；
//  ③ 只在"这一轮**确实产出了草稿**"时作废：纯查询轮不该让用户刚拿到的草稿卡消失。
//
// 真 `node:sqlite` + 真 session（照 `aiChat.test.ts` 的约定：绝不 mock `plugin-sql`），
// 只换 `runAgent`。判定必须**落库**（否则 `load()` 之后旧卡复活 ⇒ 又是第二笔真账的风险）。
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
    getTeamMembers: vi.fn(async () => []),
  };
});

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

import { initUserTables } from "@/db/userDb";
import { appendMessage, ensureConversation } from "@/services/ai/session";
import { useAiChatStore } from "@/stores/aiChat";
import { runAgent, type AgentTurn } from "@/services/ai/agent";
import { useLedgerStore } from "@/stores/ledger";
import type { Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const CAT = "11111111-1111-4111-8111-111111111111";
const ACC = "22222222-2222-4222-8222-222222222222";

const runMock = () => vi.mocked(runAgent);

/** 一条形状完整的草稿（`readDrafts` 只认这一套字段） */
function draftFixture(draftId: string, note: string) {
  return {
    draftId,
    draft: {
      type: "expense",
      amount: 128,
      category: "买菜",
      fromAccount: "招行",
      toAccount: null,
      occurredAt: "2026-02-28T00:00",
      note,
      tags: [],
    },
    resolved: { categoryId: CAT, fromAccountId: ACC, toAccountId: null, tagIds: [] },
  };
}
const DRAFT_A = draftFixture("d-1", "旧的（说错了）");
const DRAFT_B = draftFixture("d-2", "新的（改口后）");

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "已生成草稿，请确认", chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
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
    id,
    name: "家",
    type: "personal",
    team_id: null,
    owner_id: OWNER_ID,
    created_at: T0,
    updated_at: T0,
    is_deleted: false,
  };
  ledgerStore.ledgers = [ledger];
  ledgerStore.currentLedgerId = id;
}

/**
 * 把 mock 出来的那一轮草稿**落进库**（真 agent 里这一步是 `persistAssistant`）——
 * 作废是**写库**动作，库里没有那条消息行时 `updateDraftPayload` 必然 0 行。
 *
 * ⚠️ 已经种过的消息跳过：`appendMessage` 是**真** session 函数，重复 id 会报
 * `UNIQUE constraint failed`（那会让 `console.warn` 的断言变成噪声）。
 */
const persisted = new Set<string>();

async function persistDrafts(): Promise<void> {
  const store = useAiChatStore();
  const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
  for (const m of store.messages) {
    const drafts = m.payload?.drafts;
    if (m.role !== "assistant" || !Array.isArray(drafts) || drafts.length === 0) continue;
    if (persisted.has(m.id)) continue;
    persisted.add(m.id);
    await appendMessage({
      id: m.id,
      conversation_id: cid,
      role: "assistant",
      content: m.content,
      created_at: m.createdAt,
      payload: { chips: [], drafts, refs: {}, trace: [] },
    });
  }
  store.conversationId = cid;
}

/** 库里每张草稿的 `status`（持久化的真相；内存那份只是投影） */
async function dbStatuses(sqlite: DatabaseSync): Promise<Record<string, unknown>> {
  const rows = sqlite
    .prepare("SELECT payload FROM ai_messages WHERE role = 'assistant'")
    .all() as { payload: string }[];
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const payload: unknown = JSON.parse(row.payload);
    if (typeof payload !== "object" || payload === null) continue;
    const drafts = (payload as { drafts?: unknown }).drafts;
    if (!Array.isArray(drafts)) continue;
    for (const d of drafts as { draftId?: unknown; status?: unknown }[]) {
      if (typeof d.draftId === "string") out[d.draftId] = d.status;
    }
  }
  return out;
}

let sqlite: DatabaseSync;

beforeEach(async () => {
  vi.clearAllMocks();
  // ⚠️ `clearAllMocks` 不排空 `mockResolvedValueOnce` 队列 ⇒ 必须 reset
  runMock().mockReset();
  state.db = null;
  setActivePinia(createPinia());
  sqlite = await useRealDb();
  persisted.clear();
  setLedger(LEDGER_ID);
});

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  state.db = null;
});

/** 开门 + 发一句（发之前先摆好 `runAgent` 这一轮的产物） */
async function send(text: string): Promise<void> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  await store.send(text);
}

async function sendDraft(draftId: string, aTurn: Partial<AgentTurn> = {}): Promise<void> {
  runMock().mockResolvedValue(turn({ drafts: [draftId === "d-1" ? DRAFT_A : DRAFT_B], ...aTurn }));
  await send("记一笔 128 的菜");
  await persistDrafts();
}

describe("§4.4.6 新草稿作废旧的待确认草稿", () => {
  it("① 新草稿生成 ⇒ 旧待确认草稿落库为 superseded、不再待确认、也不算「已撤回」", async () => {
    const store = useAiChatStore();
    await sendDraft("d-1");
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);

    runMock().mockResolvedValue(turn({ drafts: [DRAFT_B] }));
    await send("不是微信，是招行");
    await persistDrafts();

    // 改哪一行能让它红：删掉 `runTurn` 里那次 `await supersedePendingDrafts()`
    // ⇒ d-1 仍在 `pendingDrafts`（两张待确认卡同时挂着），下面第一条断言红。
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-2"]);
    expect(await dbStatuses(sqlite)).toMatchObject({ "d-1": "superseded", "d-2": undefined });
    // 作废**不是**撤回（语义不同：用户没有否决过它）
    expect(store.rejectedDrafts).toEqual([]);
  });

  it("② 已记账的卡照旧保留在历史里（它不是「还没决定的草稿」）", async () => {
    const store = useAiChatStore();
    await sendDraft("d-1");
    await store.confirmDraft("d-1", "7f3a1c2e-9b4d-4e6f-8a1b-2c3d4e5f6a7b");

    // ⚠️ 这条断言是**选草稿那份判据**的杀手（实测过一版更弱的写法）：把 `supersedePendingDrafts`
    // 的筛选从 `status === "pending"` 放宽成"所有旧草稿"时，`d-1` 的 DB 状态**仍然**是 confirmed
    // —— 因为 `updateDraftPayload` 的 SQL 守卫本来就不许给已确认的草稿改决定（`aiChat.ts:717-721`），
    // 它会返回 false 并走 `console.warn` 那条路。也就是说"状态没变"这半被两层判据同时挡住了，
    // 只有"**根本没试过**"这半能单独钉住 store 层的筛选 ⇒ 必须断言没有发过那条警告。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runMock().mockResolvedValue(turn({ drafts: [DRAFT_B] }));
    await send("再记一笔别的");
    await persistDrafts();

    // 改哪一行能让它红：把筛选放宽成"所有旧草稿" ⇒ 已记账的 d-1 会被送去作废、
    // SQL 守卫拒绝、这里就多出一条「作废旧草稿没写进库」的警告（断言红）。
    expect(warn.mock.calls.flat().map((it) => String(it)).join(" ")).not.toContain("作废旧草稿没写进库");
    warn.mockRestore();

    expect(store.confirmedDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-2"]);
    expect((await dbStatuses(sqlite))["d-1"]).toBe("confirmed");
  });

  it("③ 已撤回的静态卡照旧保留在历史里", async () => {
    const store = useAiChatStore();
    await sendDraft("d-1");
    await store.rejectDraft("d-1");

    runMock().mockResolvedValue(turn({ drafts: [DRAFT_B] }));
    await send("再记一笔别的");
    await persistDrafts();

    expect(store.rejectedDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-2"]);
    expect((await dbStatuses(sqlite))["d-1"]).toBe("rejected");
  });

  it("④ 重进页面（load()）之后作废的卡仍不渲染（判定必须落库）", async () => {
    const store = useAiChatStore();
    await sendDraft("d-1");
    runMock().mockResolvedValue(turn({ drafts: [DRAFT_B] }));
    await send("不是微信，是招行");
    await persistDrafts();

    await store.load();

    // 改哪一行能让它红：`supersedePendingDrafts` 只改内存（不调 `updateDraftPayload`）
    // ⇒ 库里 d-1 还是 pending，`load()` 之后它又回到 `pendingDrafts`，这条红。
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-2"]);
    expect(store.rejectedDrafts).toEqual([]);
  });

  it("⑤ 纯查询轮（这一轮没有草稿）不作废任何东西", async () => {
    const store = useAiChatStore();
    await sendDraft("d-1");

    runMock().mockResolvedValue(turn({ text: "这个月一共花了 328 元。" }));
    await send("这个月花了多少");

    // 改哪一行能让它红：把触发条件从 `turn.drafts.length > 0` 去掉 ⇒ 用户问一句余额，
    // 手里那张待确认卡就凭空消失（下面这条红）。
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect((await dbStatuses(sqlite))["d-1"]).toBeUndefined();
  });
});
