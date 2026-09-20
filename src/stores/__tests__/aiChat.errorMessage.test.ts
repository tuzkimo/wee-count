// src/stores/__tests__/aiChat.errorMessage.test.ts
//
// 不变量：**`error` 非 null ⇒ 消息流里必有一条内容就等于它的 assistant 消息**。
//
// 为什么这条值得单独钉：`error` 的唯一非 null 写入口是 `fail()`（`aiChat.ts:395-398`），而
// `fail()` **同时**落一条可见消息 —— `error` 是给 store 状态用的，用户真正看到的是那条消息
// （页面**不**渲染 `error`，这是设计：§5.3 要求错误一律走消息流，再画一个错误条就是同一个含义
// 两个出口）。将来有人把 `fail()` 改成"只设 error 不落消息"，用户那边就是**静默失败**：
// 输入框弹回来了、什么也没说。这条用例就是那个改动的红灯。
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
import { AGENT_FAILURE_TEXT, useAiChatStore } from "@/stores/aiChat";
import { DB_FAILURE_TEXT, runAgent } from "@/services/ai/agent";
import { useLedgerStore } from "@/stores/ledger";
import type { Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";

const runMock = () => vi.mocked(runAgent);

function asTauriDb(sqlite: DatabaseSync) {
  return {
    // 形状照安装包产物：plugin-sql 的 `execute` 恒返回 `{ rowsAffected, lastInsertId }`
    // （`dist-js/index.js:88-98`，2.4.0）—— 不是 `node:sqlite` 的 `{ changes }`（R86-2）。
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

async function useRealDb() {
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

/**
 * 不变量本身。
 *
 * ⚠️ 第一条断言（前提）不能省：`error` 恒为 null 时，下面"消息内容等于 error"会**空转通过**
 * —— 那正是 Ruling 38 的形态（前提把缺陷形态排除掉的用例等于没写）。
 */
function expectErrorImpliesVisibleMessage(store: ReturnType<typeof useAiChatStore>): void {
  expect(store.error).not.toBeNull();
  const same = store.messages.filter((m) => m.role === "assistant" && m.content === store.error);
  expect(same.length).toBe(1);
  // 用户看到的是**最后一条**：不变量不止"存在"，还得"就在眼前"
  expect(store.messages[store.messages.length - 1]!.content).toBe(store.error);
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.db = null;
  setActivePinia(createPinia());
  await useRealDb();
});

/**
 * 建 store 并打开 §7.3 的**意愿层门控**（默认关闭 ⇒ 不打开的话 `send` 一个请求都不发、
 * 也就没有任何 error 可言）。门控自身在 `aiChat.privacy.test.ts` 里钉。
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

describe("error 的双写不变量：非 null ⇒ 消息流里必有一条同样的 assistant 消息", () => {
  it("没有账本 ⇒ error = DB_FAILURE_TEXT，且那条消息真的在流里（不是只设状态）", async () => {
    const store = openGate();

    await store.send("记一笔");

    expect(store.error).toBe(DB_FAILURE_TEXT);
    expectErrorImpliesVisibleMessage(store);
  });

  it("agent 契约被改坏（抛）⇒ error = AGENT_FAILURE_TEXT，同样必伴随一条消息", async () => {
    setLedger(LEDGER_ID);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runMock().mockRejectedValue(new Error("agent 契约被改坏了"));
    const store = openGate();

    await store.send("记一笔");
    warn.mockRestore();

    expect(store.error).toBe(AGENT_FAILURE_TEXT);
    expectErrorImpliesVisibleMessage(store);
  });
});
