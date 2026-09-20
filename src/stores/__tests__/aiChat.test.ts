// src/stores/__tests__/aiChat.test.ts
//
// store 的职责是**编排**，所以这里分两层钉：
//  - `runAgent` 换掉（vi.mock）：要验的是"store 传了什么、拿回来的怎么映射"，不是 agent 的行为
//    （agent 的 6 轮/纠错/取消判决在 agent.test.ts 里）。
//  - `@/db/userDb` 只换 `getUserDb` 等入口，**session.ts 是真的**，底下挂真 `node:sqlite`
//    + 真实 `initUserTables`：`load()`/`clear()` 因此真的跑过一遍 SQL。mock 只能证明
//    "SQL 字符串长得对"，证明不了"列名真存在、DELETE 真生效"（照 session.test.ts 的约定，
//    **绝不 mock `plugin-sql`**）。
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

// 只换 runAgent：`DB_FAILURE_TEXT` / `CANCELED_TEXT` 等文案必须保持生产那一份（第二份真相不行）
vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

import { getTeamMembers, initUserTables } from "@/db/userDb";
import { appendMessage, ensureConversation, loadMessages } from "@/services/ai/session";
import {
  CANCELED_TEXT,
  DB_FAILURE_TEXT,
  runAgent,
  type AgentTurn,
} from "@/services/ai/agent";
import { PROMPT_VERSION } from "@/services/ai/prompt";
import { AGENT_FAILURE_TEXT, useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import type { Account, Category, Ledger, TagWithUsage } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";

// id 全是真 UUID 形态：这样"快照里不能出现 id"的断言才有判别力（用 "c1" 这种短串，
// 名字里随便碰上一个字符就恒真 —— Ruling 13 的同一条坑）
const CAT_ID = "11111111-1111-4111-8111-111111111111";
const ACC_ID = "22222222-2222-4222-8222-222222222222";
const TAG_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";

/** 照 `tools.ts` 草稿工具产出的 payload.drafts 条目（id 是**本地**的，绝不上行） */
const RAW_DRAFT = {
  draftId: "d-1",
  draft: {
    type: "expense",
    amount: 128,
    category: "买菜",
    fromAccount: "招行",
    toAccount: null,
    occurredAt: "2026-02-28T00:00",
    note: "盒马",
    tags: ["生鲜"],
  },
  resolved: { categoryId: CAT_ID, fromAccountId: ACC_ID, toAccountId: null, tagIds: [TAG_ID] },
};

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
}

function cat(over: Partial<Category> = {}): Category {
  return {
    id: CAT_ID, ledger_id: LEDGER_ID, owner_id: OWNER_ID, name: "买菜", type: "expense",
    icon: null, sort_order: 0, updated_at: T0, is_deleted: false, ...over,
  };
}

function acct(over: Partial<Account> = {}): Account {
  return {
    id: ACC_ID, ledger_id: LEDGER_ID, owner_id: OWNER_ID, name: "招行储蓄卡", type: "bank",
    initial_balance: 0, color: "#000", created_at: T0, updated_at: T0, is_deleted: false, ...over,
  };
}

function tag(over: Partial<TagWithUsage> = {}): TagWithUsage {
  return {
    id: TAG_ID, ledger_id: LEDGER_ID, name: "生鲜", updated_at: T0, is_deleted: false,
    usage_count: 0, ...over,
  };
}

/**
 * 把真库包成 `@tauri-apps/plugin-sql` 的 `Database` 形状；两个口都是 spy，便于断言"零写入"。
 *
 * ⚠️ `execute` 的返回值**照安装包产物**：插件恒返回 `{ lastInsertId, rowsAffected }`
 * （`node_modules/@tauri-apps/plugin-sql/dist-js/index.js:88-98`，2.4.0；`index.d.ts` 的
 * `QueryResult.rowsAffected: number`）。直接透传 `node:sqlite` 的 `{ changes, lastInsertRowid }`
 * 是**另一个形状**，会让"调用方按 `rowsAffected` 判成败"的代码在测试里永远读不到值（R86-2）。
 */
function asTauriDb(sqlite: DatabaseSync) {
  const execute = vi.fn(
    async (sql: string, params: unknown[] = []): Promise<unknown> => {
      const r = sqlite.prepare(sql).run(...(params as never[]));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  );
  const select = vi.fn(
    async (sql: string, params: unknown[] = []): Promise<unknown> =>
      sqlite.prepare(sql).all(...(params as never[])),
  );
  return { execute, select };
}

const opened: DatabaseSync[] = [];

async function useRealDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = asTauriDb(sqlite);
  await initUserTables(db as never);
  state.db = db;
  opened.push(sqlite);
  return { sqlite, db };
}

function setLedger(id: string, over: Partial<Ledger> = {}): void {
  const ledgerStore = useLedgerStore();
  ledgerStore.ledgers = [
    {
      id, name: "家", type: "personal", team_id: null, owner_id: OWNER_ID,
      created_at: T0, updated_at: T0, is_deleted: false, ...over,
    },
  ];
  ledgerStore.currentLedgerId = id;
}

function countRows(sqlite: DatabaseSync, table: string): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * 记录到 `execute` 上的**写语句**（INSERT/UPDATE/DELETE）。
 * "store 零写入"这类断言的唯一读法：读语句（SELECT）不算写，也不该被算进去。
 */
function writeSqls(db: ReturnType<typeof asTauriDb>): string[] {
  return db.execute.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => /INSERT|UPDATE|DELETE/i.test(sql));
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

const runMock = () => vi.mocked(runAgent);

/**
 * 建 store 并打开 §7.3 的**意愿层门控**（它默认关闭 ⇒ 不打开的话 `send` 一个请求都不发）。
 *
 * 本文件钉的是"谁去落库 / 快照给什么 / 取消 / 切账本 / 失败也是消息"，门控自身
 * （默认 `false`、关闭时 transport 零调用、`host` 门槛、持久化）在 `aiChat.privacy.test.ts` 里钉。
 *
 * ⚠️ 调用点必须留在各用例原本的位置（`setLedger()` **之后**）：store 里那个账本 watch 会在
 * `currentLedgerId` 变化时 `cancelInFlight()` —— 提前建 store 会让用例里那次 `setLedger`
 * 掐掉紧接着的第一个 `send`（实测：消息流空、`runAgent` 没被调）。
 */
function openGate(): ReturnType<typeof useAiChatStore> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  state.teamMembers = [];
  setActivePinia(createPinia());
});

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
});

// ---------------------------------------------------------------------------
// 发送：调 runAgent + 快照白名单
// ---------------------------------------------------------------------------

describe("send：编排 agent（谁去落库、快照里给什么）", () => {
  it("传 ledgerId / 白名单快照 / session 四件套 / AbortSignal；返回的一条文本 + 草稿落进状态", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    await store.load();

    useCategoryStore().categories = [cat()];
    useAccountStore().accounts = [acct()];
    useTagStore().tags = [tag()];
    runMock().mockResolvedValue(turn({
      text: "这个月花了 128 元",
      refs: { "q1.total": "128" },
      drafts: [RAW_DRAFT],
      chips: [{ field: "categories", value: CAT_ID, label: "买菜" }],
    }));

    await store.send("  这个月花了多少  ");

    expect(runMock()).toHaveBeenCalledTimes(1);
    const args = runMock().mock.calls[0]![0];
    expect(args.userText).toBe("这个月花了多少"); // 前后空白不进 prompt，也不进消息流
    expect(args.ledgerId).toBe(LEDGER_ID);
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(args.signal.aborted).toBe(false);
    expect(args.deps.session?.ensureConversation).toBe(ensureConversation); // 落库接口必须是 session.ts 那份
    expect(args.deps.session?.appendMessage).toBe(appendMessage);
    expect(typeof args.deps.session?.recentTurns).toBe("function");
    expect(typeof args.deps.session?.setTitleIfEmpty).toBe("function");

    // §7.1 的快照：名字 + 类型；账户类型给**人话**（招行储蓄卡(银行卡)）
    expect(args.snapshot).toEqual({
      kind: "personal",
      categories: [{ name: "买菜", type: "expense" }],
      accounts: [{ name: "招行储蓄卡", type: "银行卡" }],
      tags: ["生鲜"],
      members: [{ name: "我" }],
    });
    // 杀手：`categories: categoryStore.categories`（展开实体）→ 下面这一条红
    for (const id of [CAT_ID, ACC_ID, TAG_ID, OWNER_ID, LEDGER_ID]) {
      expect(JSON.stringify(args.snapshot)).not.toContain(id);
    }
    // 成员表（真 id）走**另一路**注入：快照里绝不能有 id，解析表里则必须**有真 id** ——
    // 只给名字的形态下模型说得出"我"、链路却查不了（旧实现编过 `member-0` ⇒ 恒 0 行）。
    expect(args.members).toEqual([{ id: "local-1", name: "我" }]);

    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "这个月花了多少"],
      ["assistant", "这个月花了 128 元"],
    ]);
    expect(store.messages[0]!.payload).toBeNull();
    // ⚠️ 这一轮 payload **多了一个键** `promptVersion`（§7.1:449 的"回答是哪版提示词问出来的"）：
    // 断言跟着**加强**（多要求一个必填键），不是放宽 —— 内存这份与 `agent.persistAssistant`
    // 落库那份必须逐键相同，所以这里钉死整份形状。
    expect(store.messages[1]!.payload).toEqual({
      chips: [{ field: "categories", value: CAT_ID, label: "买菜" }],
      drafts: [RAW_DRAFT],
      refs: { "q1.total": "128" },
      trace: [],
      promptVersion: PROMPT_VERSION,
    });
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(store.pendingDrafts[0]!.messageId).toBe(store.messages[1]!.id);
    expect(store.sending).toBe(false);
    expect(store.error).toBeNull();
  });

  it("空串 / 纯空白：不发请求，也不留一条空气泡", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();

    await store.send("   ");
    await store.send("");

    expect(runMock()).not.toHaveBeenCalled();
    expect(store.messages).toEqual([]);
    expect(store.sending).toBe(false);
  });

  it("没有账本时不拿空串去建会话（Ruling 14）：不调 runAgent，给一条失败消息 + error 态", async () => {
    const { sqlite } = await useRealDb();
    const store = openGate(); // 没调 setLedger ⇒ currentLedgerId 为 null

    await store.send("这个月花了多少");

    expect(runMock()).not.toHaveBeenCalled();
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "这个月花了多少"],
      ["assistant", DB_FAILURE_TEXT],
    ]);
    expect(store.error).toBe(DB_FAILURE_TEXT);
    // 空账本会话行一条都不能有（`ensureConversation("")` 会插出一行绑空 ledger_id 的会话）
    expect(countRows(sqlite, "ai_conversations")).toBe(0);
  });

  it("团队账本：成员名来自 team_members 缓存（名字走 useMemberInfo 的别名/昵称规则），自己一定在内", async () => {
    await useRealDb();
    state.teamMembers = [
      { team_id: "T1", user_id: "u-wife", username: "alice", nickname: "老婆", avatar_url: null, role: "member", updated_at: T0 },
      { team_id: "T1", user_id: "local-1", username: "me", nickname: "我", avatar_url: null, role: "owner", updated_at: T0 },
    ];
    setLedger(LEDGER_ID, { type: "team", team_id: "T1" });
    const store = openGate();
    runMock().mockResolvedValue(turn({ text: "答" }));

    await store.send("谁花得最多");

    const snapshot = runMock().mock.calls[0]![0].snapshot;
    expect(vi.mocked(getTeamMembers)).toHaveBeenCalledWith("T1");
    expect(snapshot.kind).toBe("team");
    // 只有名字：成员 id 会拼出 `lookup.members` 的 id，但快照这一侧一个 id 都不给模型
    expect(snapshot.members).toEqual([{ name: "老婆" }, { name: "我" }]);
    // 同一份成员表的**另一半**：解析表拿到的是 team_members 里的真 user_id（`u-wife`）+
    // 自己那笔的 `server_user_id || 本地 id`（这里没有 server id ⇒ "local-1"）。
    // 两处必须同时成立：快照给名字、解析表给 id，否则成员筛选就是"响亮失败"或错答案。
    expect(runMock().mock.calls[0]![0].members).toEqual([
      { id: "u-wife", name: "老婆" },
      { id: "local-1", name: "我" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 取消（§5.2/§5.3）
// ---------------------------------------------------------------------------

describe("取消不是错误", () => {
  it("cancel()：立刻复位发送态；在途那一轮 settle 后**不追加** assistant 消息，也不设 error", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const pending = deferred<AgentTurn>();
    runMock().mockReturnValueOnce(pending.promise);

    const sending = store.send("这个月花了多少");
    expect(store.sending).toBe(true);
    await flushPromises(); // 让 send 走到 runAgent（快照要读名字表）

    const signal = runMock().mock.calls[0]![0].signal;
    store.cancel();
    expect(signal.aborted).toBe(true);
    // 杀手：cancel 只 abort、不复位 → 输入框永久禁用（这一条红）
    expect(store.sending).toBe(false);

    pending.resolve(turn({ text: "", aborted: true }));
    await sending;

    expect(store.messages.map((m) => m.role)).toEqual(["user"]);
    expect(store.error).toBeNull();
  });

  it("取消判决只看 `turn.aborted`：取消那一轮即便带着非空文本，也**不得**渲染成消息/错误", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    // 防御性 fixture：真实的 agent 取消时 text 是空串，但 store 该看的是**判决**而不是"文本是否为空"
    runMock().mockResolvedValue(turn({ text: CANCELED_TEXT, aborted: true }));

    await store.send("这个月花了多少");

    // 杀手：把 `if (turn.aborted) return` 换成 `if (turn.text === "") return` → 这句"已取消"进消息流
    expect(store.messages.map((m) => m.role)).toEqual(["user"]);
    expect(store.error).toBeNull();
    expect(store.pendingDrafts).toEqual([]);
  });

  it("生成中又发一条：掐掉在途那一轮（signal 真的 aborted），被取代的终稿不得插进列表、也不得复位发送态", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const first = deferred<AgentTurn>();
    const second = deferred<AgentTurn>();
    runMock().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const p1 = store.send("第一个问题");
    const p2 = store.send("第二个问题");
    await flushPromises(); // 让两条 send 都走到 runAgent
    expect(runMock()).toHaveBeenCalledTimes(2);

    const sig1 = runMock().mock.calls[0]![0].signal;
    const sig2 = runMock().mock.calls[1]![0].signal;
    // 杀手：把 send 开头的 `cancelInFlight()` 删掉 → 在途那一轮没被取消，这一条红
    expect(sig1.aborted).toBe(true);
    expect(sig2.aborted).toBe(false);

    // 被取代的那一轮**可能在被 abort 之前就拿到终稿**（abort 落在 persistAssistant 的 await 里）
    first.resolve(turn({ text: "答一" }));
    await flushPromises();
    // 杀手：去掉 `if (seq !== runSeq) return` → "答一"混进来
    expect(store.messages.map((m) => m.content)).toEqual(["第一个问题", "第二个问题"]);
    expect(store.sending).toBe(true); // 第二轮还在跑，第一轮的 finally 不得复位它

    second.resolve(turn({ text: "答二" }));
    await p1;
    await p2;

    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "第一个问题"],
      ["user", "第二个问题"],
      ["assistant", "答二"],
    ]);
    expect(store.sending).toBe(false);
    expect(store.error).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 失败（§5.3：错误就是消息流里的一条，不是对话框）
// ---------------------------------------------------------------------------

describe("失败", () => {
  it("agent 返回的失败文本就是一条 assistant 消息（error 态不重复一份）", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    runMock().mockResolvedValue(turn({ text: DB_FAILURE_TEXT }));

    await store.send("这个月花了多少");

    expect(store.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "这个月花了多少"],
      ["assistant", DB_FAILURE_TEXT],
    ]);
    expect(store.sending).toBe(false);
    expect(store.error).toBeNull();
  });

  it("runAgent 抛（契约被改坏）⇒ 兜成一条失败消息 + error 态，绝不 reject 到调用方", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    runMock().mockRejectedValue(new Error("boom"));

    // 杀手：去掉 send 里的 try/catch → 这一句变成 rejects
    await expect(store.send("这个月花了多少")).resolves.toBeUndefined();

    expect(store.messages[1]).toMatchObject({ role: "assistant", content: AGENT_FAILURE_TEXT });
    expect(store.error).toBe(AGENT_FAILURE_TEXT);
    // 文案与成因一致：这条路的成因是"agent 意外抛出"，**未必**是本地库故障 ⇒ 不得复用 DB 那句
    // （杀手：把 catch 里的文案换回 `DB_FAILURE_TEXT` → 上面两条红；"没有账本"那条用例仍绿）
    expect(AGENT_FAILURE_TEXT).not.toBe(DB_FAILURE_TEXT);
    expect(store.sending).toBe(false);
    expect(warn).toHaveBeenCalled(); // 不能静默：这是唯一能看到抛出原因的地方
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 读既有消息 / 清空
// ---------------------------------------------------------------------------

describe("load / clear", () => {
  it("load()：消息按时间正序读回，content 是占位符原文，**整份 payload 原样留着**，草稿从 payload 重新长出来", async () => {
    const { sqlite, db } = await useRealDb();
    setLedger(LEDGER_ID);
    const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
    await appendMessage({ id: "m1", conversation_id: cid, role: "user", content: "这个月花了多少", created_at: T0 });
    const payload = {
      refs: { "q1.total": "128" },
      chips: [{ field: "categories", value: CAT_ID, label: "买菜" }],
      drafts: [RAW_DRAFT],
    };
    await appendMessage({ id: "m2", conversation_id: cid, role: "assistant", content: "这个月花了 {{q1.total}} 元", payload, created_at: T0 });

    const store = openGate();
    // `initUserTables` 与造数据用的是同一条 execute ⇒ 先清掉，剩下的才是 load 自己发的
    db.execute.mockClear();
    await store.load();

    expect(store.conversationId).toBe(cid);
    expect(store.loading).toBe(false);
    expect(store.messages.map((m) => [m.id, m.role, m.content])).toEqual([
      ["m1", "user", "这个月花了多少"],
      // content 必须是**原文**：{{q1.total}} 的回填是渲染时的事（§4.5），store 不许提前替换
      ["m2", "assistant", "这个月花了 {{q1.total}} 元"],
    ]);
    // 杀手：`payload: null`（或只留 refs）→ 这两条红
    expect(store.messages[1]!.payload).toEqual(payload);
    expect(store.messages[0]!.payload).toBeNull();
    expect(store.pendingDrafts.map((d) => [d.draftId, d.messageId])).toEqual([["d-1", "m2"]]);

    // ⚠️ 这一形态**只能**钉"复用已有会话、不插第二条"：`:417` 已经 ensure 过 ⇒ 会话行存在时
    // 任何实现都不会 INSERT。""load() 是只读的"这句话的判别力在**空账本**那一形态上，
    // 由下一条用例负责（把只读断言写在这里 = 前提把唯一会写的形态排除掉，恒真 ✗ —— 复审第 3 节）。
    expect(countRows(sqlite, "ai_conversations")).toBe(1); // 复用已有会话，不插第二条（Ruling 14）
  });

  it("空账本 load() 是只读的（R4）：一条会话行都不建，会话推迟到首次发送才建", async () => {
    const { sqlite, db } = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    db.execute.mockClear();

    await store.load();

    // 杀手：`load()` 里调 `ensureConversation`（修前实现）→ 下面两条红（INSERT 发出去了 / 库里多一行）
    expect(writeSqls(db)).toEqual([]);
    expect(countRows(sqlite, "ai_conversations")).toBe(0);
    expect(store.conversationId).toBeNull();
    expect(store.loading).toBe(false);
    expect(store.messages).toEqual([]);
    expect(store.pendingDrafts).toEqual([]);

    // 第四条写路径（复审第 8.3 条）：`watch → load()` 与上面是**同一处代码** ⇒ 空账本切账本
    // 同样不许建会话（这两条断言与上面共用同一条防线，显式声明，不计作两条）。
    setLedger("L2");
    await flushPromises();
    expect(store.conversationId).toBeNull();
    expect(writeSqls(db)).toEqual([]);
    expect(countRows(sqlite, "ai_conversations")).toBe(0);
  });

  it("payload 是坏 JSON ⇒ 消息**不消失**（content 照常读出），payload 降级为 null", async () => {
    const { sqlite } = await useRealDb();
    setLedger(LEDGER_ID);
    const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
    sqlite
      .prepare("INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at) VALUES ('m9', ?, 'assistant', '答', '{{{不是 JSON', ?)")
      .run(cid, T0);

    const store = openGate();
    await store.load();

    expect(store.messages.map((m) => [m.id, m.content])).toEqual([["m9", "答"]]);
    expect(store.messages[0]!.payload).toBeNull();
    expect(store.pendingDrafts).toEqual([]);
  });

  it("读会话行**失败** ⇒ 降级成「没有会话」（不抛、loading 归位），但必须留痕（不许静默）", async () => {
    const { db } = await useRealDb();
    setLedger(LEDGER_ID);
    // 只让这一次查询炸（表结构坏 / 查询失败：Ruling 13 说的"DB 未就绪"之外的真实形态）
    db.select.mockRejectedValueOnce(new Error("no such table: ai_conversations"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const store = openGate();
    // 杀手①：`findConversationId` 的 catch 里改成 `throw` ⇒ 这一行直接 rejects（页面 onMounted
    //        没人接 ⇒ unhandled rejection，整页打不开）
    await store.load();

    // 杀手②：把 catch 里的 `console.warn` 删掉 ⇒ 下面那条红（"留痕"是这条降级唯一的可观测性）
    expect(warn).toHaveBeenCalledWith("[ai/store] 读会话行失败：", expect.any(Error));
    expect(store.messages).toEqual([]);
    expect(store.conversationId).toBeNull();
    expect(store.loading).toBe(false);

    // 为什么**照旧吞掉**（不 rethrow）：这一层是 `load()` 的只读探测，调用方只有两类 ——
    // `onMounted` 与 `watch(账本)`，两边都**没有**放错误的位置（面板里没有"读会话失败"这个状态）；
    // 而"读失败"与"还没有会话"对 UI 是同一种**可自愈**的降级（空列表，下次 load 会补回来），
    // 且这一层**不写任何东西** ⇒ 没有数据被破坏，最坏只是一段时间看不到历史。
    // 代价是承认它分不出"真的没说过话"与"读不到"——那需要一个第三态，超出本次范围（见报告）。
    // 反过来 rethrow 的代价是确定的：空账本/坏库直接变成整页打不开。
    warn.mockRestore();
  });

  it("clear()：调 clearConversation(ledgerId, now) —— 真库里消息真没了、会话行被软删；内存投影同时清空", async () => {
    const { sqlite } = await useRealDb();
    setLedger(LEDGER_ID);
    const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
    await appendMessage({ id: "m1", conversation_id: cid, role: "user", content: "问", created_at: T0 });

    const store = openGate();
    await store.load();
    expect(store.messages).toHaveLength(1);

    const before = Date.now();
    await store.clear();
    const after = Date.now();

    expect(store.messages).toEqual([]);
    expect(store.pendingDrafts).toEqual([]);
    // 杀手：只清内存（不调 clearConversation）→ 下面两条红（消息还读得出来、is_deleted 还是 0）
    expect(await loadMessages(cid)).toEqual([]);
    expect(sqlite.prepare("SELECT is_deleted FROM ai_conversations WHERE id = ?").get(cid)).toEqual({ is_deleted: 1 });
    // 第二个参数不能漏：时间戳必须是**这次**清空的时间（`undefined.toISOString()` 会让 session 层
    // 直接 catch 掉、库里什么都没变 —— 上面那条就红了；这里再钉时间的新鲜度）
    const row = sqlite.prepare("SELECT updated_at FROM ai_conversations WHERE id = ?").get(cid) as { updated_at: string };
    const ts = new Date(row.updated_at).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
    // 会话行 id 不变（ensureConversation 复活的是同一行，Ruling 7）⇒ 继续说话仍落到这个会话里
    expect(store.conversationId).toBe(cid);
  });

  it("clear() 先掐在途那一轮：被掐掉的终稿与草稿不得在清空之后落回状态", async () => {
    await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    const pending = deferred<AgentTurn>();
    runMock().mockReturnValueOnce(pending.promise);

    const sending = store.send("这个月花了多少");
    await flushPromises(); // 让 send 走到 runAgent
    const signal = runMock().mock.calls[0]![0].signal;

    const clearing = store.clear(); // 掐在途 → 等它落定 → clearConversation
    await flushPromises();
    expect(signal.aborted).toBe(true); // 前提：取消真的送达（与下面那条是 cancelInFlight 的**两条**子机制）

    // 被取代的那一轮**可能在被 abort 之前就拿到终稿**（abort 落在 persistAssistant 的 await 里）
    pending.resolve(turn({ text: "被掐掉的答案", drafts: [RAW_DRAFT] }));
    await clearing;
    await sending;

    // 杀手①：删掉 `clear()` 里的 `cancelInFlight()`（复审变异 M2）⇒ 令牌没作废、也没 abort，
    //   "被掐掉的答案"+草稿卡就落进刚清空的列表（下面两条红）。修前交付用例 14 条全绿 = 空的保证。
    // 杀手②：只删 `cancelInFlight` 的 `runSeq++`（保留 abort，M2b）⇒ `signal.aborted` 那条**仍绿**，
    //   而下面两条红 ⇒ 证明它们不是搭 abort 那条断言的便车。
    expect(store.messages).toEqual([]);
    expect(store.pendingDrafts).toEqual([]);
    expect(store.error).toBeNull();
    expect(store.sending).toBe(false);
  });

  it("切账本 ⇒ 会话跟着切（Ruling 14）：messages 重载成新账本的会话，且不为任何账本建第二条会话行", async () => {
    const { sqlite } = await useRealDb();
    const c1 = (await ensureConversation("L1", new Date(T0)))!;
    await appendMessage({ id: "m1", conversation_id: c1, role: "user", content: "L1 的问", created_at: T0 });
    const c2 = (await ensureConversation("L2", new Date(T0)))!;
    await appendMessage({ id: "m2", conversation_id: c2, role: "user", content: "L2 的问", created_at: T0 });

    setLedger("L1");
    const store = openGate();
    await store.load();
    expect(store.messages.map((m) => m.content)).toEqual(["L1 的问"]);

    setLedger("L2"); // 触发 watch
    await flushPromises();

    // 杀手：去掉 watch → messages 仍是 "L1 的问"、conversationId 仍是 c1
    expect(store.conversationId).toBe(c2);
    expect(store.messages.map((m) => m.content)).toEqual(["L2 的问"]);
    expect(countRows(sqlite, "ai_conversations")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 切账本：在途那一轮必须被掐掉（Ruling 14 的账本隔离不只在"读"，也在"写回内存"）
// ---------------------------------------------------------------------------

describe("切账本掐在途", () => {
  it("切走后 A 那一轮才 settle：终稿与草稿不得落进 B 的列表（杀手：watch 里去掉 cancelInFlight）", async () => {
    const { sqlite } = await useRealDb();
    // L2 自己**已经有**会话与消息：A 的答案若漏进来，会追加在 L2 的消息之后（复审 P1 的形态）
    const c2 = (await ensureConversation("L2", new Date(T0)))!;
    await appendMessage({ id: "m2", conversation_id: c2, role: "user", content: "L2 的问", created_at: T0 });

    setLedger("L1");
    const store = openGate();
    const pending = deferred<AgentTurn>();
    runMock().mockReturnValueOnce(pending.promise);

    const sending = store.send("L1 的问");
    await flushPromises(); // 让 send 走到 runAgent（L1 那一轮在飞）
    expect(runMock()).toHaveBeenCalledTimes(1);

    setLedger("L2"); // 触发 watch
    await flushPromises();
    expect(store.conversationId).toBe(c2); // 前提：真的切过去了（否则下面的断言可能只是因为压根没切）

    // A 那一轮现在才拿到终稿（LLM 的数秒窗口里离开 AI 页切一次账本即可复现）
    pending.resolve(turn({ text: "L1 的答案", drafts: [RAW_DRAFT] }));
    await sending;

    // 杀手：watch 只 `void load()`、不 `cancelInFlight()`（修前实现）⇒ 轮次令牌没作废，
    //   settle 时 `seq === runSeq` 仍成立 ⇒ 下面两条红（"L1 的答案"落进 L2 列表、草稿卡跨账本存活）。
    //   危害不止显示：6b 的草稿卡"确认"按**当前账本**调 transactionStore.add ⇒ 拿 A 的数据往 B 记账。
    expect(store.messages.map((m) => [m.role, m.content])).toEqual([["user", "L2 的问"]]);
    expect(store.pendingDrafts).toEqual([]);
    expect(store.sending).toBe(false); // 被取代的那一轮不得把发送态又立起来
    // L1 那一轮的会话行是**真 agent** 建的；这里 agent 被 mock 掉 ⇒ 一条都没建。切账本本身
    // 也不建（R4：`load()` 只读）⇒ 总数仍是 L2 那一条。
    expect(countRows(sqlite, "ai_conversations")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 草稿"待确认"：零写入
// ---------------------------------------------------------------------------

describe("草稿待确认（store 不得写库）", () => {
  it("send 收下草稿、dismissDraft 只把它移出列表：全程 db.execute 一次都不调", async () => {
    const { db } = await useRealDb();
    setLedger(LEDGER_ID);
    const store = openGate();
    await store.load();
    // runAgent 是 mock ⇒ 这一步之后的任何一条写语句都只可能来自 store 自己
    db.execute.mockClear();

    runMock().mockResolvedValue(turn({ text: "已生成草稿，请确认 {{q1.amount}} 元", drafts: [RAW_DRAFT] }));
    await store.send("昨天在盒马买菜花了 128");

    expect(store.pendingDrafts).toHaveLength(1);
    expect(store.pendingDrafts[0]!.draft).toEqual(RAW_DRAFT.draft);
    expect(store.pendingDrafts[0]!.resolved).toEqual(RAW_DRAFT.resolved);
    expect(db.execute).not.toHaveBeenCalled();

    // 杀手：让 dismissDraft 顺手落库（appendMessage / transactionStore.add）→ 这一条红
    store.dismissDraft("d-1");
    expect(store.pendingDrafts).toEqual([]);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
