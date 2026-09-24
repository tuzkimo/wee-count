// src/stores/__tests__/aiChat.draftCardVisibility.test.ts
//
// **真机现象的复现尝试**（人类实测步骤，逐条）：
//   ① 连续记账成功几轮，最后一轮的草稿**已确认**；
//   ② 再说"再记一笔…"，AI 回"草稿已生成…" ⇒ **卡片没出现**；
//   ③ 用户说"没弹卡片" ⇒ 两张卡一起弹出来（含上一轮那张）；说"上一轮已经记了" ⇒ 才只剩这一轮的；
//   ④ 此后不再复现。
//
// 人类给的机制假设（本文件要证伪或证实的东西）：**草稿与消息的关联键对不上** ——
//   - 卡片按 assistant **消息 id** 分组渲染（`AiChatPage.vue:62-74` 的 `draftsByMessage` / `draftsFor`）；
//   - store 内存那份消息 id 是 `appendAssistant` 里 `crypto.randomUUID()` 造的（`aiChat.ts:638`），
//     而库里 `ai_messages.id` 是 `agent.ts` 落库时**另外**造的一个 UUID（两套身份，见 `aiChat.ts:479-482`）；
//   - 若草稿挂的是库 id、而消息流里那条消息用的是内存 id（或反过来），卡就渲染不出来，
//     要等下一次 `load()`（用库 id 重建）或后续回合才"一起出现"。
//
// 本文件用**真 sqlite + 真 session + 真 agent（只换 transport）**把这条链路整个跑一遍：
// 第一轮生成草稿并确认，**全程不调 `load()`**，第二轮再生成草稿，断言三件事：
//   (a) 第二轮的草稿**立刻**挂在本轮那条 assistant 消息上（`messageId` 命中消息流）；
//   (b) 第一轮那张**仍是 confirmed**（不许变回 pending）—— 人类实测里"已记账的又弹出来"那一半；
//   (c) 全程没有重新 `load()`（不切页、不重进）。
//
// 为什么必须用**真 agent**（而不是照 `aiChat.test.ts` 把 `runAgent` 换掉）：机器假设的**前提**就是
// "库里那行 id ≠ 内存消息 id"。mock 掉 `runAgent` 就由测试自己造行、自己决定 id 关系，
// 恰好把要检验的那个差异消掉了（`aiChat.draftDecision.dbIdentity.test.ts` 的文件头记过同一课）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { DatabaseSync } from "node:sqlite";

const state = vi.hoisted(() => ({ db: null as unknown }));
/** 假 transport 装在模块级：store 在 `runTurn` 里现调 `createTransport()`（`aiChat.ts:517`） */
const tstate = vi.hoisted(() => ({ transport: null as unknown }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => state.db as never,
    getCurrentUserId: () => "local-1",
    getTeamMembers: vi.fn(async () => [] as never),
  };
});

// 只换 createTransport：agent / tools / session 全部是真的（本文件要的就是它们之间的真身份）
vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, createTransport: () => tstate.transport as never };
});

import { initUserTables } from "@/db/userDb";
import type { ChatMessage, ChatOutcome, Transport } from "@/services/ai/transport";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import type { Account, Category, Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const CAT_ID = "11111111-1111-4111-8111-111111111111";
const ACC_ID = "22222222-2222-4222-8222-222222222222";
const TX_ID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const CAT_NAME = "买菜";
const ACC_NAME = "招行";

interface Reply {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}

/** 按脚本依次回的假 transport（形状照 `agent.test.ts` 的 `scriptedTransport`） */
function scriptedTransport(): { transport: Transport; push: (...replies: Reply[]) => void } {
  const queue: Reply[] = [];
  const chat = vi.fn(
    async (_m: ChatMessage[], _t: unknown[], _s: AbortSignal): Promise<ChatOutcome> => {
      const reply = queue.shift();
      if (reply === undefined) throw new Error("假 transport 的脚本用尽了");
      return {
        ok: true,
        reply: {
          text: reply.text,
          toolCalls: reply.toolCalls,
          finishReason: reply.toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      };
    },
  );
  return { transport: { chat } as Transport, push: (...replies) => queue.push(...replies) };
}

function draftCall(amount: number): Reply["toolCalls"][number] {
  return {
    id: `call-${amount}`,
    name: "create_transaction_draft",
    arguments: JSON.stringify({
      type: "expense",
      amount,
      category: CAT_NAME,
      fromAccount: ACC_NAME,
    }),
  };
}

/** 一轮"记账"的脚本：先调草稿工具，再回一句确认话术（与真机一致） */
function draftTurn(amount: number): Reply[] {
  return [
    { text: "", toolCalls: [draftCall(amount)] },
    { text: "已生成草稿，请确认：{{q1.amount}} 元", toolCalls: [] },
  ];
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

/** 真库 + 真 `initUserTables`，并把名字表种上（草稿工具要从库里解析「买菜 / 招行」） */
async function useRealDb(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  const db = asTauriDb(sqlite);
  await initUserTables(db as never);
  // 账本行必须先落库：`categories` / `accounts` 的 `ledger_id` 都是**真外键**（`PRAGMA foreign_keys` 默认开）
  sqlite
    .prepare(
      "INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at, is_deleted) VALUES (?, '家', 'personal', ?, ?, ?, 0)",
    )
    .run(LEDGER_ID, OWNER_ID, T0, T0);
  sqlite
    .prepare(
      "INSERT INTO categories (id, ledger_id, owner_id, name, type, is_deleted) VALUES (?, ?, ?, ?, 'expense', 0)",
    )
    .run(CAT_ID, LEDGER_ID, OWNER_ID, CAT_NAME);
  sqlite
    .prepare(
      "INSERT INTO accounts (id, ledger_id, owner_id, name, type, is_deleted) VALUES (?, ?, ?, ?, 'bank', 0)",
    )
    .run(ACC_ID, LEDGER_ID, OWNER_ID, ACC_NAME);
  state.db = db;
  opened.push(sqlite);
  return sqlite;
}

function setLedger(id: string): void {
  const ledgerStore = useLedgerStore();
  ledgerStore.ledgers = [
    {
      id, name: "家", type: "personal", team_id: null, owner_id: OWNER_ID,
      created_at: T0, updated_at: T0, is_deleted: false,
    } satisfies Ledger,
  ];
  ledgerStore.currentLedgerId = id;
}

function cat(): Category {
  return {
    id: CAT_ID, ledger_id: LEDGER_ID, owner_id: OWNER_ID, name: CAT_NAME, type: "expense",
    icon: null, sort_order: 0, updated_at: T0, is_deleted: false,
  };
}

function acct(): Account {
  return {
    id: ACC_ID, ledger_id: LEDGER_ID, owner_id: OWNER_ID, name: ACC_NAME, type: "bank",
    initial_balance: 0, color: "#000", created_at: T0, updated_at: T0, is_deleted: false,
  };
}

/** 库里全部 assistant 行（id + payload）——用来同时证明"真落库了"与"两套 id 真的不同" */
function assistantRows(sqlite: DatabaseSync): { id: string; payload: string }[] {
  return sqlite
    .prepare("SELECT id, payload FROM ai_messages WHERE role = 'assistant' ORDER BY rowid ASC")
    .all() as { id: string; payload: string }[];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  tstate.transport = null;
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
  tstate.transport = null;
});

describe("两轮连记：草稿卡与消息 id 的关联（真机「没弹卡片」的复现尝试）", () => {
  it("第二轮草稿立刻挂到本轮消息上；已确认的那张不许变回待确认；全程不 load()", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const script = scriptedTransport();
    tstate.transport = script.transport;

    const store = useAiChatStore();
    store.sendingEnabled = true;
    useCategoryStore().categories = [cat()];
    useAccountStore().accounts = [acct()];
    await store.load();

    // ① 第一轮：真 agent → 真草稿工具 → 真 session 落库。位置参数是**库行 id**、
    //    内存消息 id 是 store 自己造的另一个 UUID —— 下面显式钉住这个差异（假设的前提）。
    script.push(...draftTurn(32));
    await store.send("记一笔 32 买菜，用招行");

    expect(store.pendingDrafts).toHaveLength(1);
    const first = store.pendingDrafts[0]!;
    expect(first.draft.amount).toBe(32);
    const row1 = assistantRows(sqlite).find((r) => r.payload.includes(first.draftId));
    expect(row1, "第一轮的草稿没有落库（真机链路都没走通，后面的结论无意义）").toBeDefined();
    expect(
      row1!.id,
      "两套 id 应当是**不同**的（这是人类假设的前提；相同则本用例的判别力为零）",
    ).not.toBe(first.messageId);

    // ② 用户确认第一轮那张（页面路径：先 `transactionStore.add`，再把决定写进 payload）
    expect(await store.confirmDraft(first.draftId, TX_ID)).toBe(true);
    expect(store.pendingDrafts).toHaveLength(0);
    expect(store.confirmedDrafts).toHaveLength(1);

    // ③ 第二轮：**不调 load()**（不切页、不重进），直接接着说一句
    const loadSpy = vi.spyOn(store, "load");
    script.push(...draftTurn(20));
    await store.send("再记一笔 20 买菜");

    // (a) 第二轮的卡**立刻**可渲染：页面按 `messageId` 分组，那个 id 必须在消息流里存在
    expect(store.pendingDrafts).toHaveLength(1);
    const second = store.pendingDrafts[0]!;
    expect(second.draft.amount).toBe(20);
    const messageIds = store.messages.map((m) => m.id);
    expect(
      messageIds,
      `第二轮草稿挂的消息 id 不在消息流里 ⇒ 卡片渲染不出来（这正是"没弹卡片"的形态）`,
    ).toContain(second.messageId);
    // 而且挂的就是**本轮**那条 assistant 消息（不是上一轮的）
    const carrier = store.messages.find((m) => m.id === second.messageId)!;
    expect(carrier.role).toBe("assistant");
    expect(carrier.content).toContain("已生成草稿");

    // (b) 第一轮那张**仍是已记账**：既没有变回 pending，也没有从可见列表里消失
    expect(store.pendingDrafts.map((d) => d.draftId)).not.toContain(first.draftId);
    expect(store.confirmedDrafts.map((d) => d.draftId)).toEqual([first.draftId]);
    expect(store.confirmedDrafts[0]!.status).toBe("confirmed");
    expect(store.confirmedDrafts[0]!.savedTransactionId).toBe(TX_ID);

    // 库里也一致：第一轮那行的决定没被第二轮碰过
    const row1After = assistantRows(sqlite).find((r) => r.id === row1!.id)!;
    expect(row1After.payload).toContain('"status":"confirmed"');

    // (c) 全程没有重新 load()（人类说的"切页回来就好了"那条路一次都没走）
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("作废那一轮不会吞掉新草稿（9f7fd85 的回归嫌疑）：新卡立刻渲染，旧待确认消失，已确认不动", async () => {
    const sqlite = await useRealDb();
    setLedger(LEDGER_ID);
    const script = scriptedTransport();
    tstate.transport = script.transport;

    const store = useAiChatStore();
    store.sendingEnabled = true;
    useCategoryStore().categories = [cat()];
    useAccountStore().accounts = [acct()];
    await store.load();

    // 第一轮：草稿 A 待确认（模拟人类第 1 步）
    script.push(...draftTurn(32));
    await store.send("记一笔 32 买菜，用招行");
    const a = store.pendingDrafts[0]!;

    // 第二轮：改口（模型再调一次草稿工具）⇒ 走的正是 `supersedePendingDrafts()` 那条路：
    // `runTurn` 里它先于 `appendTurn` 执行，`filter(status === "pending")` 只应挑到 A。
    script.push(...draftTurn(33));
    await store.send("不是 32，是 33");

    // 新草稿**立刻**挂到本轮那条消息上（作废那一轮不该影响新卡的渲染）
    expect(store.pendingDrafts).toHaveLength(1);
    const b = store.pendingDrafts[0]!;
    expect(b.draftId).not.toBe(a.draftId);
    expect(store.messages.map((m) => m.id)).toContain(b.messageId);
    const carrier = store.messages.find((m) => m.id === b.messageId)!;
    expect(carrier.payload?.drafts).toHaveLength(1);
    // 旧卡进了 superseded：三个可渲染列表里都没有它（§4.4.6）
    expect(store.pendingDrafts.map((d) => d.draftId)).not.toContain(a.draftId);
    expect(store.confirmedDrafts).toEqual([]);
    expect(store.rejectedDrafts).toEqual([]);
    // 库里 A 也是 superseded（作废写库了，重进页面不会复活成待确认）
    const rowA = assistantRows(sqlite).find((r) => r.payload.includes(a.draftId))!;
    expect(rowA.payload).toContain('"status":"superseded"');

    // 再把 B 确认掉，然后第三轮又来一张新草稿：**已确认的 B 不许变回待确认**
    expect(await store.confirmDraft(b.draftId, TX_ID)).toBe(true);
    script.push(...draftTurn(44));
    await store.send("再记一笔 44");

    expect(store.confirmedDrafts.map((d) => d.draftId)).toEqual([b.draftId]);
    expect(store.confirmedDrafts[0]!.status).toBe("confirmed");
    expect(store.pendingDrafts).toHaveLength(1);
    expect(store.pendingDrafts[0]!.draftId).not.toBe(b.draftId);
    expect(store.messages.map((m) => m.id)).toContain(store.pendingDrafts[0]!.messageId);
  });
});
