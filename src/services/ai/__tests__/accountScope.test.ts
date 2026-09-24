// 团队账本里"同名账户"的实机缺陷回归（AI 记账只能用自己的账户）。
//
// 实机现象：账本里我和小明各有一个「现金」，用户说"用我的现金记一笔"，AI 回"无法分辨"、记不了账。
// 根因有**两处**，都在"AI 拿到的账户清单"上：
//   1. `buildLookupContext` 的 SQL 没有按 `owner_id` 过滤 ⇒ 两个同名账户同时进解析表 ⇒
//      `resolve.ts:108` 判 ambiguous（同名两个候选）⇒ 工具响亮失败 ⇒ 模型只好反问/说无法分辨；
//   2. 提示词快照（`stores/aiChat.ts` 的 `buildSnapshot`）也把别人的账户列给了模型。
// 本文件钉第 1 处（工具层 + 编排层，走**默认 lookup 路径** = 生产路径）。
//
// ⚠️ 为什么必须用真 `node:sqlite`：本缺陷就死在 `WHERE owner_id = ?` 这一行上，mock 掉
// `select` 只能证明"SQL 字符串长得对"，证明不了"过滤真的生效"（照 agentDefaultLookup.test.ts 的约定）。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

const state = vi.hoisted(() => ({ db: null as unknown }));

// 只换 DB 句柄；`execute` 一调用即抛 —— 这条链路只许读。
vi.mock("@/db/userDb", () => ({
  getUserDb: () => state.db as never,
}));

import { runAgent } from "@/services/ai/agent";
import { buildLookupContext, executeTool, type ToolContext } from "@/services/ai/tools";
import type { ChatMessage, ChatOutcome, Transport } from "@/services/ai/transport";
import type { LedgerSnapshot } from "@/services/ai/prompt";

// ---------------------------------------------------------------------------
// 夹具：id 全是真的 UUID（"看不出真假"的短串会让隐私/身份类断言空转）
// ---------------------------------------------------------------------------

const LEDGER_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const CAT_FOOD = "3f4a1b2c-9d8e-4f5a-b6c7-8d9e0f1a2b3c";
const ACC_MINE = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const ACC_OTHER = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";
/** 当前用户（团队账本里的"我"） */
const ME = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
/** 另一位成员（小明） */
const MING = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";

const SNAPSHOT: LedgerSnapshot = {
  kind: "team",
  categories: [{ name: "买菜", type: "expense" }],
  accounts: [{ name: "现金", type: "现金" }],
  tags: [],
  members: [{ name: "我" }, { name: "小明" }],
};

const NOW = () => new Date(2026, 2, 15, 12, 0, 0);

/** 确定性文案的**规格**（写死在这里，实现改了措辞就得改规格 + 用例） */
const CREATE_ACCOUNT_HINT = "请先在账户页创建一个账户";
/** 不许再出现的旧话术：没有候选时"请反问用户是哪个账户"没有信息量，模型只会回"无法分辨" */
const OLD_REFLECT = "请反问用户是哪个账户";

const SCHEMA = `
  CREATE TABLE categories (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, owner_id TEXT, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE tags (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
`;

/** 真库：只有一个分类，账户由调用方给（owner 是主角） */
function useRealDb(accounts: { id: string; name: string; ownerId: string }[]): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  sqlite.exec(`INSERT INTO categories VALUES ('${CAT_FOOD}', '${LEDGER_ID}', '买菜', 'expense', 0);`);
  const insert = sqlite.prepare(
    "INSERT INTO accounts (id, ledger_id, name, owner_id, is_deleted) VALUES (?, ?, ?, ?, 0)",
  );
  for (const a of accounts) insert.run(a.id, LEDGER_ID, a.name, a.ownerId);
  state.db = {
    select: (sql: string, params: unknown[] = []): Promise<unknown[]> =>
      Promise.resolve(sqlite.prepare(sql).all(...(params as never[])) as unknown[]),
    execute: (): never => {
      throw new Error("不变式链路不该写库（本文件只走读路径）");
    },
  };
  return sqlite;
}

interface Reply {
  text: string;
  toolCalls: { id: string; name: string; arguments: string }[];
}

/** 假 transport：按脚本依次回；脚本用尽后**重复最后一条** */
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

function draftArgs(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "expense",
    amount: 12,
    category: "买菜",
    fromAccount: "现金",
    ...over,
  });
}

function draftReply(id: string, over: Record<string, unknown> = {}): Reply {
  return {
    text: "",
    toolCalls: [{ id, name: "create_transaction_draft", arguments: draftArgs(over) }],
  };
}

/** 跑默认 lookup 路径（**不注入 lookup**，与生产 store 同形） */
async function runDefaultPath(transport: Transport, currentUserId?: string) {
  return await runAgent({
    userText: "记一笔 12 块的菜，用我的现金",
    ledgerId: LEDGER_ID,
    snapshot: SNAPSHOT,
    ...(currentUserId === undefined ? {} : { currentUserId }),
    deps: { transport, now: NOW },
    signal: new AbortController().signal,
  });
}

function toolCtx(lookup: Awaited<ReturnType<typeof buildLookupContext>>): ToolContext {
  return { ledgerId: LEDGER_ID, lookup, now: NOW(), refIndex: 1 };
}

let opened: DatabaseSync[] = [];

beforeEach(() => {
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
// ① 同名账户：必须落到**我自己**的那个，不许判歧义、不许"无法分辨"
// ---------------------------------------------------------------------------

describe("团队账本：同名账户只解析到当前用户自己的那个", () => {
  it("① 我和小明各有一个「现金」⇒ 草稿落到我的账户（不是歧义、不是失败）", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_OTHER, name: "现金", ownerId: MING },
      ]),
    );
    const { transport } = scriptedTransport([
      draftReply("c1"),
      { text: "已生成草稿，请确认", toolCalls: [] },
    ]);

    const turn = await runDefaultPath(transport, ME);

    // 改哪一行能让它红：`tools.ts` 的账户 SQL 少了 `AND owner_id = ?` ⇒ 两个同名候选 ⇒
    // resolve 判 ambiguous ⇒ 这里 trace 变成两次 ok:false、drafts 为空。
    expect(turn.trace).toEqual([{ round: 1, name: "create_transaction_draft", ok: true }]);
    const draft = turn.drafts[0] as { resolved: { fromAccountId: string | null } } | undefined;
    expect(draft?.resolved.fromAccountId).toBe(ACC_MINE);
    // 候选里不该有别人的账户：唯一能解释"同名却解析成功"的，就是别人的那份被排除了
    expect(JSON.stringify(turn.drafts)).not.toContain(ACC_OTHER);
  });
});

// ---------------------------------------------------------------------------
// ② 候选清单：别人的账户既不能进解析表，也不能进给模型的那句话
// ---------------------------------------------------------------------------

describe("团队账本：账户候选只含当前用户自己的账户", () => {
  it("② `buildLookupContext` 按 owner_id 过滤（别人的「小金库」不进解析表）", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_OTHER, name: "小金库", ownerId: MING },
      ]),
    );

    const lookup = await buildLookupContext(LEDGER_ID, [], { kind: "team", viewerUserId: ME });

    // 改哪一行能让它红：把 `buildLookupContext` 里那条 owner 过滤去掉（或作用域判据改错）。
    expect(lookup.accounts).toEqual([{ id: ACC_MINE, name: "现金" }]);
  });

  it("③ 没指定账户时，反问给模型的候选里没有别人的账户", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_OTHER, name: "小金库", ownerId: MING },
      ]),
    );
    const lookup = await buildLookupContext(LEDGER_ID, [], { kind: "team", viewerUserId: ME });

    const out = await executeTool(
      "create_transaction_draft",
      { type: "expense", amount: 12, category: "买菜" },
      toolCtx(lookup),
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("现金");
    expect(out.error).toContain(OLD_REFLECT); // 有候选 ⇒ 照旧请模型反问（这一条不变）
    expect(out.error).not.toContain("小金库");
  });

  it("guard：个人账本不做 owner 过滤（照 useTransactionForm:46-54 的口径，不扩大改动面）", async () => {
    // 这一条**不是**红转绿的用例：它钉的是"别顺手把个人账本也改了"（个人账本里 owner_id
    // 可能因历史数据与当前身份不一致，过滤会把用户自己的账户藏掉）。
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_OTHER, name: "小金库", ownerId: MING },
      ]),
    );

    const lookup = await buildLookupContext(LEDGER_ID, [], { kind: "personal", viewerUserId: ME });

    expect(lookup.accounts.map((a) => a.name)).toEqual(["现金", "小金库"]);
  });
});

// ---------------------------------------------------------------------------
// ③ 一个可用账户都没有：给**确定性**的"先去创建账户"，不交给模型发挥
// ---------------------------------------------------------------------------

describe("过滤后没有可用账户：确定性提示「请先在账户页创建一个账户」", () => {
  it("④ 只有小明有账户 ⇒ 工具给出确定性的「先创建」，不是「请反问用户」", async () => {
    opened.push(useRealDb([{ id: ACC_OTHER, name: "现金", ownerId: MING }]));
    const lookup = await buildLookupContext(LEDGER_ID, [], { kind: "team", viewerUserId: ME });

    const out = await executeTool(
      "create_transaction_draft",
      { type: "expense", amount: 12, category: "买菜", fromAccount: "现金" },
      toolCtx(lookup),
    );

    // 改哪一行能让它红：`tools.ts` 里"过滤后没有账户 ⇒ 立刻回确定性文案"那条短路。
    // 修复前：小明那份「现金」没被过滤 ⇒ 草稿**成功** ⇒ 下面第一条断言当场红。
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain(CREATE_ACCOUNT_HINT);
    expect(out.error).not.toContain(OLD_REFLECT);
  });

  it("④b 没指定账户（连名字都没有）⇒ 同样是确定性的「先创建」", async () => {
    opened.push(useRealDb([{ id: ACC_OTHER, name: "现金", ownerId: MING }]));
    const lookup = await buildLookupContext(LEDGER_ID, [], { kind: "team", viewerUserId: ME });

    const out = await executeTool(
      "create_transaction_draft",
      { type: "expense", amount: 12, category: "买菜" },
      toolCtx(lookup),
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain(CREATE_ACCOUNT_HINT);
    expect(out.error).not.toContain(OLD_REFLECT);
  });

  it("⑤ 那句话真的到了模型手里（纠错轮的工具结果里是确定性文案）", async () => {
    opened.push(useRealDb([{ id: ACC_OTHER, name: "现金", ownerId: MING }]));
    const { transport, chat } = scriptedTransport([
      draftReply("c1"),
      { text: "好", toolCalls: [] },
    ]);

    await runDefaultPath(transport, ME);

    // 改哪一行能让它红：同 ④ 的那条短路（修复前第二轮拿到的是"草稿已生成"而不是这句提示）。
    expect(chat.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondRound = JSON.stringify(chat.mock.calls[1]?.[0] ?? []);
    expect(secondRound).toContain(CREATE_ACCOUNT_HINT);
    expect(secondRound).not.toContain(OLD_REFLECT);
  });
});
