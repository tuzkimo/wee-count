// 默认 lookup 路径（**不注入 `lookup`**）的行为契约：成员筛选/分组必须"给出真值"或"响亮失败"。
//
// 为什么必须单独一个文件：`agent.test.ts` 把 `@/services/ai/runQuery` **整层**换成了 mock，
// 于是"编排层塞进 `LookupContext.members` 的那个 id 最终变成了 SQL 里的 `t.user_id`"这件事
// 在那一层**结构上不可见** —— mock 从来看不见发出去的 SQL，也无法分辨"id 是真的"与"id 是编的"。
// 这里只换 DB 句柄（指向**真** `node:sqlite`），`runAgent` / `executeTool` / `runQuery` /
// `querySql` / `resolve` 全是真身；断言落在"模型拿到的 refs"与"真库收到的 SQL 参数"上。
//
// 生产链路就是这条路径：`stores/aiChat.ts` 调 `runAgent` 时**不传** `lookup`（§7.1 的快照
// 刻意只有名字、没有 id），所以本文件覆盖的是默认路径 = 生产路径。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

/** 真库句柄。mock 工厂被提升到文件顶部执行，所以只能用 `vi.hoisted` 传递。 */
const state = vi.hoisted(() => ({ db: null as unknown }));

// 只换 DB 句柄：`getUserDb()` 返回一个包着真 `node:sqlite` 的适配器。
// `execute` 一调用即抛 —— 这条链路只许读（与 runQuery.test.ts / queryListParity.test.ts 同一约定）。
const sqlLog = vi.hoisted(() => ({ calls: [] as { sql: string; params: unknown[] }[] }));

vi.mock("@/db/userDb", () => ({
  getUserDb: () => state.db as never,
}));

import { runAgent, CLARIFY_FAILURE_TEXT } from "@/services/ai/agent";
import type { ChatMessage, ChatOutcome, Transport } from "@/services/ai/transport";
import type { LedgerSnapshot } from "@/services/ai/prompt";

// ---------------------------------------------------------------------------
// 夹具：id 全是真的 UUID（伪造形态 "member-0" 才可能被认出来）
// ---------------------------------------------------------------------------

const LEDGER_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const CAT_FOOD = "3f4a1b2c-9d8e-4f5a-b6c7-8d9e0f1a2b3c";
const ACC_CMB = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const MEMBER_MING = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";
const MEMBER_ME = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";

/** 本地时间 → ISO 串（本文件不用日期条件，但 `deriveFullRange` 会读 occurred_at） */
function at(y: number, mo: number, d: number): string {
  return new Date(y, mo - 1, d, 10, 0, 0).toISOString();
}

const SCHEMA = `
  CREATE TABLE categories (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE tags (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, user_id TEXT NOT NULL,
    amount REAL NOT NULL, type TEXT NOT NULL,
    from_account_id TEXT, to_account_id TEXT, category_id TEXT,
    note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE transaction_tags (transaction_id TEXT, tag_id TEXT);
`;

/** 打开一个真库并塞入两笔流水：小明 128.5、我 71.5（金额刻意不同，答案才有判别力） */
function useRealDb(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  sqlite.exec(`
    INSERT INTO categories VALUES ('${CAT_FOOD}', '${LEDGER_ID}', '买菜', 'expense', 0);
    INSERT INTO accounts VALUES ('${ACC_CMB}', '${LEDGER_ID}', '招行', 0);
  `);
  const insert = sqlite.prepare(
    `INSERT INTO transactions
       (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, 'expense', ?, NULL, ?, ?, ?, ?, ?, 0)`,
  );
  insert.run("t-ming", LEDGER_ID, MEMBER_MING, 128.5, ACC_CMB, CAT_FOOD, "小明买菜", at(2026, 3, 10), at(2026, 3, 10), at(2026, 3, 10));
  insert.run("t-me", LEDGER_ID, MEMBER_ME, 71.5, ACC_CMB, CAT_FOOD, "我买菜", at(2026, 3, 11), at(2026, 3, 11), at(2026, 3, 11));

  state.db = {
    select: (sql: string, params: unknown[] = []): Promise<unknown[]> => {
      sqlLog.calls.push({ sql, params });
      return Promise.resolve(sqlite.prepare(sql).all(...(params as never[])) as unknown[]);
    },
    execute: (): never => {
      throw new Error("不变式链路不该写库（本文件只走读路径）");
    },
  };
  return sqlite;
}

const SNAPSHOT: LedgerSnapshot = {
  kind: "team",
  categories: [{ name: "买菜", type: "expense" }],
  accounts: [{ name: "招行", type: "银行卡" }],
  tags: [],
  // §7.1：快照**只有名字**，一个 id 都没有 ⇒ 编排层不可能从它拿到真 id
  members: [{ name: "小明" }, { name: "我" }],
};

const NOW = () => new Date(2026, 2, 15, 12, 0, 0);

interface Reply {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}

/** 假 transport：按脚本依次回；脚本用尽后**重复最后一条**（避免"脚本用完抛错"混进失败原因） */
function scriptedTransport(replies: Reply[]) {
  const chat = vi.fn(
    async (_messages: ChatMessage[], _tools: unknown, _signal: AbortSignal): Promise<ChatOutcome> => {
      const index = Math.min(chat.mock.calls.length - 1, replies.length - 1);
      const reply = replies[index]!;
      return {
        ok: true,
        reply: { text: reply.text, toolCalls: reply.toolCalls, finishReason: "stop" },
      };
    },
  );
  return { transport: { chat } as Transport, chat };
}

const MEMBER_FILTER_QUERY = JSON.stringify({
  aggregate: "sum",
  type: "expense",
  members: ["小明"],
});

/** 模型的每一轮都在按成员筛（成员筛选正是本次缺陷的主角） */
function memberQueryReply(id: string): Reply {
  return {
    text: "",
    toolCalls: [{ id, name: "query_transactions", arguments: MEMBER_FILTER_QUERY }],
  };
}

/** 跑默认路径：**不传 `lookup`**（生产 store 就是这样调的） */
async function runDefaultPath(
  transport: Transport,
  members?: { id: string; name: string }[],
) {
  return await runAgent({
    userText: "小明这个月花了多少",
    ledgerId: LEDGER_ID,
    snapshot: SNAPSHOT,
    ...(members === undefined ? {} : { members }),
    deps: { transport, now: NOW },
    signal: new AbortController().signal,
  });
}

/** 真库这次收到的全部 SQL + 参数（用来钉"不许伪造 id"） */
function sqlText(): string {
  return sqlLog.calls.map((c) => `${c.sql} -- ${JSON.stringify(c.params)}`).join("\n");
}

let opened: DatabaseSync[] = [];

beforeEach(() => {
  sqlLog.calls = [];
  state.db = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const db of opened) db.close();
  opened = [];
  state.db = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ① 成员筛选：不许伪造 id，也不许拿"0 元"当答案
// ---------------------------------------------------------------------------

describe("默认 lookup 路径 + 成员筛选（不注入 lookup）", () => {
  it("R1：解析成员用的 id 必须来自本地库 —— 拿不到就必须响亮失败，绝不伪造 id 去查", async () => {
    opened.push(useRealDb());
    // 模型第一轮按成员筛，第二轮（纠错额度已用尽后仍要工具）→ 编排层必须收口
    const { transport } = scriptedTransport([memberQueryReply("c1")]);

    const turn = await runDefaultPath(transport);

    // ① 伪造 id 的**直接**证据面：真的发出去的那条 SQL 参数里不许出现 "member-0" 这类编造值。
    //    真 id（MEMBER_MING）才是唯一合法取值。
    expect(sqlText()).not.toContain("member-");
    // ② 工具必须被记为失败（`{ok:false}` 是唯一的"响亮"信号，§5.3 的失败消息靠它）
    expect(turn.trace.map((t) => t.ok)).toEqual([false, false]);
    expect(turn.trace[0]!.note).toContain("成员");
    // ③ 失败就不能有任何数字流出去（refs 空 ⇒ 模型写不出"花了 X 元"）
    expect(turn.refs).toEqual({});
    // ④ 纠错额度用尽 ⇒ 用户拿到的是 §5.3 的人话，不是一个假数字
    expect(turn.text).toBe(CLARIFY_FAILURE_TEXT);
    expect(turn.aborted).toBe(false);
  });

  it("答案文本形态：工具失败时用户**看不到**「0 元」这个看起来合理但错误的答案", async () => {
    opened.push(useRealDb());
    // 最坏情况的模型：工具报错后照旧写 {{q1.total}}（这正是 prompt 教它写的形状）
    const { transport } = scriptedTransport([
      memberQueryReply("c1"),
      { text: "小明这个月花了 {{q1.total}} 元。", toolCalls: [] },
    ]);

    const turn = await runDefaultPath(transport);

    // 缺陷的原始形态：解析表里是编造的 id ⇒ `t.user_id IN ('member-0')` 恒 0 行 ⇒
    // 模型如实回填 refs 里的 0 ⇒ 用户看到"小明这个月花了 0 元"（静默答错）。
    expect(turn.text).not.toContain("0 元");
    // 链路上交给模型的数字：要么是真题 128.5，要么**根本没有**（工具失败）
    const total = turn.refs["q1.total"];
    if (total !== undefined) expect(total).toBe("128.5");
    expect(sqlText()).not.toContain("member-");
  });
});

// ---------------------------------------------------------------------------
// ② R1 的另一半：真 id 到手时答案必须**正确**（生产 store 注入的就是这张表）
// ---------------------------------------------------------------------------

describe("注入真成员表（store 的形态）后，成员筛选给出正确答案", () => {
  it("R1：用本地库里的真 id 解析 ⇒ SQL 命中真 UUID ⇒ 答案 128.5（不是 0）", async () => {
    opened.push(useRealDb());
    // store 的 `memberTable()` 产出的形状：id 来自本地 `team_members` / 自己那笔的
    // `server_user_id || 本地 id`，名字来自 `useMemberInfo` 的显示名
    const members = [
      { id: MEMBER_MING, name: "小明" },
      { id: MEMBER_ME, name: "我" },
    ];
    const { transport } = scriptedTransport([
      memberQueryReply("c1"),
      { text: "小明这个月花了 {{q1.total}} 元。", toolCalls: [] },
    ]);

    const turn = await runDefaultPath(transport, members);

    expect(turn.text).toBe("小明这个月花了 128.5 元。");
    expect(turn.refs["q1.total"]).toBe("128.5");
    expect(turn.trace).toEqual([{ round: 1, name: "query_transactions", ok: true }]);
    // 反空转：真 id（而不是别的什么）就是进了 SQL 的那个参数
    expect(sqlText()).toContain(MEMBER_MING);
    expect(sqlText()).not.toContain(MEMBER_ME);
  });
});
