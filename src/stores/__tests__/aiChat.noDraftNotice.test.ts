// src/stores/__tests__/aiChat.noDraftNotice.test.ts
//
// 接线（真机缺陷的一半）：`agent` 判定"这一轮草稿工具报过错、又没有草稿"时会给一句确定性提示
// （`turn.noDraftNotice`），**判定**在 `agent.noDraftNotice.test.ts` 里钉；本文件钉**渲染**：
// 那句话必须真的进消息流（用户看得到）、卡片数仍是 0、模型那句话原样保留。
//
// 为什么渲染这半也值得钉：提示如果不落消息流，用户看到的依然只有模型那句「已生成草稿，请确认」
// —— 缺陷原样（这正是它当初被报上来的形态）。
//
// 真 `node:sqlite` + 真 session（照 `aiChat.test.ts` 的约定：**绝不 mock `plugin-sql`**），
// 只换 `runAgent` 与 `@/db/userDb` 的入口。
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
import { useAiChatStore } from "@/stores/aiChat";
import { NO_DRAFT_NOTICE_TEXT, runAgent, type AgentTurn } from "@/services/ai/agent";
import { useLedgerStore } from "@/stores/ledger";
import { DRAFT_TOOL } from "@/services/ai/toolNames";
import type { Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";

/** 模型在工具报错后照样说的那句（prompt 教的话术） */
const MODEL_CLAIM = "已生成草稿，请确认";

const runMock = () => vi.mocked(runAgent);

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

async function useRealDb(): Promise<void> {
  const sqlite = new DatabaseSync(":memory:");
  const db = asTauriDb(sqlite);
  await initUserTables(db as never);
  state.db = db;
  opened.push(sqlite);
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

/** 一轮的产物；`noDraftNotice` 由 agent 判定（这里只摆结果） */
function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: MODEL_CLAIM, chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
}

/** 草稿工具报错留下的那条 trace（判定的输入在 agent 侧，这里只是让夹具像真的） */
const failedDraftTool = { round: 1, name: DRAFT_TOOL, ok: false, note: "账户「并不存在的账户」在账本里找不到" };

beforeEach(async () => {
  vi.clearAllMocks();
  // ⚠️ `clearAllMocks` **不排空** `mockResolvedValueOnce` 队列（跨用例污染的真凶）⇒ 必须 reset
  runMock().mockReset();
  state.db = null;
  setActivePinia(createPinia());
  await useRealDb();
  setLedger(LEDGER_ID);
});

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
});

function openGate(): ReturnType<typeof useAiChatStore> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  return store;
}

describe("turn.noDraftNotice 的渲染", () => {
  it("① 有提示 ⇒ 消息流末条就是它，卡片仍是 0，模型那句话原样留着", async () => {
    runMock().mockResolvedValue(turn({ trace: [failedDraftTool], noDraftNotice: NO_DRAFT_NOTICE_TEXT }));
    const store = openGate();

    await store.send("记一笔 128 的菜");

    // 改哪一行能让它红：删掉 `aiChat.ts` `appendTurn` 里那个 `if (turn.noDraftNotice !== undefined)`
    // ⇒ 末条仍是模型那句「已生成草稿，请确认」，用户看不到"其实没生成"。
    expect(store.messages[store.messages.length - 1]!.content).toBe(NO_DRAFT_NOTICE_TEXT);
    // 0 张卡：卡片只认 `turn.drafts` ⇒ 这一轮本来就不该有卡（提示不是"把卡补出来"）
    expect(store.pendingDrafts.length).toBe(0);
    // 模型那句话**原样留着**（没有改写历史），提示是**另起**的一条
    expect(store.messages.map((m) => m.content)).toContain(MODEL_CLAIM);
  });

  it("② 没有提示（agent 判定不需要）⇒ 一条都不多", async () => {
    runMock().mockResolvedValue(turn({ text: "这个月一共花了 128 元。" }));
    const store = openGate();

    await store.send("这个月花了多少");

    expect(store.messages.map((m) => m.content)).not.toContain(NO_DRAFT_NOTICE_TEXT);
    expect(store.messages[store.messages.length - 1]!.content).toBe("这个月一共花了 128 元。");
  });
});
