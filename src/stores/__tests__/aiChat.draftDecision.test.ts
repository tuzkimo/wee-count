// src/stores/__tests__/aiChat.draftDecision.test.ts
//
// 草稿决定的**持久化**（收口修复 C-P1）。
//
// 这一文件是**唯一**能看见"重进页面草稿复活"这个缺陷的地方：它必须走
// 「真 sqlite + 真 session.ts + 真 store」——`payload` 是 TEXT 列、决定写在
// `payload.drafts[i].status` 上（不动 schema），mock 掉任何一层都证明不了
// "写进去了、读回来还是那个状态"。
//
// 只换 `runAgent`（编排循环另有自己的用例）：草稿由它喂进来，落库由真 session 做。
// `@/db/userDb` 只换入口，**绝不 mock `plugin-sql`**（同 `aiChat.test.ts` 的约定）。
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

/** 撤销要用的真交易 id（真 UUID 形状：短串会让"猜一个 id"的变异同样通过） */
const TX_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";

/**
 * 三张**不同的**草稿：夹具里有"别的同类项"，"改错那张 / 全表更新"的变异才红得起来。
 * `over` 用来造"坏决定字段"的形态。
 */
function rawDraft(n: number, over: Record<string, unknown> = {}) {
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
    ...over,
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
        // ⚠️ **形状照安装包产物**（不是照记忆，R86-2）：
        // `node_modules/@tauri-apps/plugin-sql/dist-js/index.js:88-98` 恒返回
        // `{ lastInsertId, rowsAffected }`；`index.d.ts` 的 `execute(): Promise<QueryResult>`，
        // `QueryResult.rowsAffected: number`（2.4.0）。**0 行也不是 `null`**。
        // 上一轮这里写成 `r.changes === 0 ? null : r`（`node:sqlite` 自己的字段名）——
        // 那是把**假契约写进了 mock**：它让"写不进去保持待确认"那族用例只证明了 mock 的分支。
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

/**
 * 直接读库里的 payload：断言的落点必须是**磁盘上那份**，不是内存投影。
 * 读的是当前账本会话里的全部草稿（按行序）。
 */
async function payloadDrafts(ledgerId = LEDGER_ID): Promise<Record<string, unknown>[]> {
  const cid = (await ensureConversation(ledgerId, new Date(T0)))!;
  const rows = await loadMessages(cid);
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (row.payload === null) continue;
    const parsed = JSON.parse(row.payload) as { drafts?: Record<string, unknown>[] };
    for (const d of parsed.drafts ?? []) out.push(d);
  }
  return out;
}

function openGate(): ReturnType<typeof useAiChatStore> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  return store;
}

/**
 * 造一个"草稿**已经落库**"的真实世界：`runAgent` 是 mock ⇒ 真 agent 里那两次
 * `persistMessage`（user + assistant）也得由本函数补上，否则"重进页面"根本没有可读的 payload，
 * C-P1 的复现前提不成立。
 *
 * ⚠️ 行的 id 用 **store 内存消息的 id**：`load()` 之后 `messageId` 会换成库里那份
 * （真实 agent 落库时另造 UUID，这里没有那一步），但两者必须是**同一份会话内**自洽的映射 ——
 * 用别的 id 会让"决定写到那条消息上"这条断言变成假的。
 *
 * 落的是**旧形态**（`payload.drafts` 里没有任何决定字段）—— 正是修复前生产里那份。
 */
async function persistDrafts(
  sqlite: DatabaseSync,
  store: ReturnType<typeof useAiChatStore>,
  drafts: unknown[],
): Promise<void> {
  const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
  const userMessage = store.messages.find((m) => m.role === "user")!;
  const assistantMessage = store.messages.find((m) => m.role === "assistant")!;
  const insert = sqlite.prepare(
    "INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run(userMessage.id, cid, "user", userMessage.content, null, T0);
  insert.run(
    assistantMessage.id,
    cid,
    "assistant",
    assistantMessage.content,
    JSON.stringify({ chips: [], drafts, refs: {}, trace: [] }),
    T0,
  );
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

describe("C-P1：草稿决定跨 load() 存活（重进页面不复活）", () => {
  it("确认 ⇒ 写进 payload；重新 load 后仍是已确认（绝不回到待确认）", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [rawDraft(1), rawDraft(2)];
    vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
    await store.send("记一笔");

    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1", "d-2"]);
    // 真实形态：agent 落库的是**旧形态**（没有任何决定字段）—— 下面那两条因此不是恒真
    await persistDrafts(sqlite, store, drafts);
    expect((await payloadDrafts())[0]).not.toHaveProperty("status");

    await store.confirmDraft("d-1", TX_ID);
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-2"]);
    expect(store.confirmedDrafts.map((d) => [d.draftId, d.status, d.savedTransactionId])).toEqual([
      ["d-1", "confirmed", TX_ID],
    ]);
    // 落点是**磁盘上那份**（先看这里：它证明的是"决定真的写出去了"）
    const written = await payloadDrafts();
    expect(written.find((d) => d.draftId === "d-1")).toMatchObject({
      status: "confirmed",
      transactionId: TX_ID,
    });
    // 另一张**没被碰**（杀手：全表更新 / 把决定写到错的草稿上 ⇒ 这一条红）
    expect(written.find((d) => d.draftId === "d-2")).not.toHaveProperty("status");

    await store.load();

    // 杀手①：确认不写 payload（`dismissDraft` 那种纯内存）⇒ 下面第一条红（d-1 复活成待确认）
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-2"]);
    // 杀手②：写了库但读回来不认 status ⇒ 上面那条绿、这一条红（卡会被当成待确认渲染）
    expect(store.confirmedDrafts.map((d) => [d.draftId, d.status, d.savedTransactionId])).toEqual([
      ["d-1", "confirmed", TX_ID],
    ]);
  });

  it("拒绝 ⇒ 同样持久；重进页面后**不以待确认**出现", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [rawDraft(1)];
    vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
    await store.send("记一笔");
    await persistDrafts(sqlite, store, drafts);

    await store.rejectDraft("d-1");
    expect(store.pendingDrafts).toEqual([]);

    await store.load();

    // 杀手：拒绝那条路不落库 ⇒ 草稿复活成待确认（用户"不要"过的东西又回来）
    expect(store.pendingDrafts).toEqual([]);
    expect(store.rejectedDrafts.map((d) => [d.draftId, d.status])).toEqual([["d-1", "rejected"]]);
    expect((await payloadDrafts())[0]).toMatchObject({ status: "rejected" });
  });

  it("撤销 ⇒ 决定也持久：重新 load 后回到待确认（既不是已记账、也不是复活成已确认）", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [rawDraft(1)];
    vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
    await store.send("记一笔");
    await persistDrafts(sqlite, store, drafts);

    await store.confirmDraft("d-1", TX_ID);
    await store.load();
    expect(store.confirmedDrafts.map((d) => d.draftId)).toEqual(["d-1"]); // 前提

    await store.undoDraft("d-1");
    expect(store.pendingDrafts.map((d) => [d.draftId, d.status])).toEqual([["d-1", "pending"]]);

    await store.load();

    // 杀手：撤销只改内存 ⇒ 这一条红（重进页面又说"已记账"，用户以为那笔还在）
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(store.confirmedDrafts).toEqual([]);
    expect((await payloadDrafts())[0]).toMatchObject({ status: "pending" });
  });
});

describe("C-P1 要求 5：写入限定到那条消息 + 那个账本", () => {
  it("另一个账本的会话行**一个字节都不动**", async () => {
    const sqlite = await useRealDb();
    // L-2 先有一条**同 draftId** 的草稿行：漏掉账本/会话限定的 UPDATE 会把它一起改掉
    const c2 = (await ensureConversation("L-2", new Date(T0)))!;
    sqlite
      .prepare(
        "INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at) VALUES (?, ?, 'assistant', '答', ?, ?)",
      )
      .run("m-l2", c2, JSON.stringify({ drafts: [rawDraft(1)] }), T0);

    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [rawDraft(1)];
    vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
    await store.send("记一笔");
    await persistDrafts(sqlite, store, drafts);
    await store.confirmDraft("d-1", TX_ID);

    const other = sqlite
      .prepare("SELECT payload FROM ai_messages WHERE id = 'm-l2'")
      .get() as { payload: string };
    expect(JSON.parse(other.payload)).toEqual({ drafts: [rawDraft(1)] });
  });
});

describe("C-P1 要求 6：坏的 / 旧的 payload 一律当「待确认」", () => {
  it("决定字段被改坏（未知 status / 非字符串 / 空交易 id）⇒ 不崩、不静默丢卡，回到待确认", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [
      rawDraft(1, { status: "bogus" }),
      rawDraft(2, { status: 42 }),
      rawDraft(3, { status: "confirmed", transactionId: "" }),
    ];
    vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
    await store.send("记一笔");
    await persistDrafts(sqlite, store, drafts);
    await store.load();

    // 三条都要在（不许因为状态字段坏掉就把整张卡吞掉）
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1", "d-2", "d-3"]);
    expect(store.confirmedDrafts).toEqual([]);
  });

  it("旧 payload（没有 status 字段）⇒ 待确认；确认后照常写进那份旧 payload", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [rawDraft(1)];
    vi.mocked(runAgent).mockResolvedValueOnce(turn({ text: "给你一张草稿", drafts }));
    await store.send("记一笔");
    await persistDrafts(sqlite, store, drafts);

    // 前提：这就是 C-P1 复现里的旧形态（payload 里没有任何决定字段）
    expect((await payloadDrafts())[0]).not.toHaveProperty("status");
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);

    await store.confirmDraft("d-1", TX_ID);
    const after = await payloadDrafts();
    // 旧形态**照样能写**（`json_object` 把 status/transactionId 补上）
    expect(after[0]).toMatchObject({ draftId: "d-1", status: "confirmed", transactionId: TX_ID });
    // 而且草稿内容没被这次写入吃掉（只加字段，不改字段）
    expect(after[0]!.draft).toEqual(rawDraft(1).draft);
  });
});

describe("C-P1 要求 5：写不进去时不许假装成功", () => {
  it("会话行不存在（payload 没落库）⇒ 决定不落地，草稿留在待确认（绝不写第二笔）", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // ⚠️ 不调 persistDrafts：库里根本没有这条 assistant 行（真链路里 = 落库失败）
    vi.mocked(runAgent).mockResolvedValueOnce(
      turn({ text: "给你一张草稿", drafts: [rawDraft(1)] }),
    );
    await store.send("记一笔");
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);

    await store.confirmDraft("d-1", TX_ID);

    // 杀手：写失败也照样从待确认里移走 ⇒ 用户以为记上了，重进页面它又回来（可再写一笔）
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(store.confirmedDrafts).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("判据必须是 `rowsAffected`：0 行 + 池里另一条连接的**陈旧** `changes()` ⇒ 不许假成功", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(runAgent).mockResolvedValueOnce(
      turn({ text: "给你一张草稿", drafts: [rawDraft(1)] }),
    );
    await store.send("记一笔");
    // ⚠️ **必须先把会话行造出来**：否则 `findConversationId` 直接返回 `null`，
    // `updateDraftPayload` 会在最上面那道守卫就 `return false` —— 那样这条用例对"判据"毫无判别力
    // （实测：不建会话行时，把判据换回旧的 `SELECT changes()` 它照样绿）。
    await ensureConversation(LEDGER_ID, new Date(T0));
    // 会话行**在**、assistant 行**不在**（真链路里 = 那条 payload 没落库）⇒ UPDATE 必然命中 0 行
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_messages").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_conversations").get()).toEqual({ n: 1 });

    // 模拟"池里另一条连接"留下的**陈旧非零**：`SELECT changes()` 在这条连接上读到 1。
    // 这就是旧判据（先判 null、再问 `SELECT changes()`）的翻车形态 —— 插件走 sqlx 默认连接池
    // （`max_connections = 10`），两次 invoke 可能落在两条连接上。
    const adapter = state.db as { select: { getMockImplementation: () => unknown; mockImplementation: (f: unknown) => void } };
    const real = adapter.select.getMockImplementation() as (sql: string, params?: unknown[]) => Promise<unknown>;
    adapter.select.mockImplementation(async (sql: string, params: unknown[] = []) =>
      /changes\(\)/.test(sql) ? [{ n: 1 }] : real(sql, params),
    );

    await store.confirmDraft("d-1", TX_ID);

    // 杀手（判据写错时必须红）：`rowsAffected = 0` ⇒ 不落库就不许改内存。
    // 旧判据（问 `changes()`）在这里会读到 1 ⇒ 内存进"已记账"、库里 0 行 ⇒ 重进复活后再确认 = 第二笔真账。
    expect(store.confirmedDrafts).toEqual([]);
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("payload 归 store 所有：决定不许改写调用方手里的 turn", () => {
  /**
   * 由来（实测踩到的）：`markDraft` 是**原地**给 payload 里的草稿打 `status`（换新对象会触发
   * 草稿卡的自清）。若 `appendTurn` 直接把 `turn.drafts` 的引用存进 payload，这个"原地"就穿透到了
   * **调用方**：agent 那一轮的 `turn`（测试里是共享夹具）会被顺手打上 `status: "rejected"`，
   * 于是后面每一条拿同一份夹具种进库的 payload 一读回来就是"已拒绝"，卡片凭空消失。
   * 生产上看不出来（真 agent 的 turn 是一次性产物），但这是 store 不该有的别名耦合。
   */
  it("confirm / reject 之后，调用方传进来的 turn.drafts 一个字段都不许多", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const drafts = [rawDraft(1), rawDraft(2)];
    const first = turn({ text: "给你一张草稿", drafts });
    vi.mocked(runAgent).mockResolvedValueOnce(first);
    await store.send("记一笔");
    await persistDrafts(sqlite, store, drafts);

    // 落库前后，调用方那份 `first` 都是**原封不动**的旧形态
    const snapshot = JSON.stringify(first.drafts);
    expect(first.drafts[0]).not.toHaveProperty("status");

    await store.confirmDraft("d-1", TX_ID);
    await store.rejectDraft("d-2");

    // 杀手：`appendTurn` 里直接写 `drafts: turn.drafts`（别名共享）⇒ 下面两条红
    expect(JSON.stringify(first.drafts)).toBe(snapshot);
    expect(first.drafts[0]).not.toHaveProperty("status");
    expect(first.drafts[1]).not.toHaveProperty("status");

    // 而 store 自己那份 payload 照旧被改了（别名切断了，决定仍然生效）
    const written = await payloadDrafts();
    expect(written.find((d) => d.draftId === "d-1")).toMatchObject({ status: "confirmed" });
    expect(written.find((d) => d.draftId === "d-2")).toMatchObject({ status: "rejected" });
  });
});
