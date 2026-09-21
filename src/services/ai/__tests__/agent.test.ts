// 任务 5：`agent.ts`（编排循环）的行为契约。规格 §5.2 / §5.3 / §4.5 / §7.2。
//
// 这份文件的组织方式：**每条硬约束至少一条能红的用例**，并且每条守卫都有一个杀手形态
// （见各 describe 的注释）。三条最容易假绿的地方单独成组：
//  - 「接线」：`ensureConversation` 必须在 `appendMessage` 之前、`setTitleIfEmpty` 必须在
//    每条 user 消息之后 —— 靠"清空会话后继续说话，消息要落进**被复活**的会话"来钉（真库）
//  - 「refs 合并」：工具 content 里是占位符，真值在 refs ⇒ `payload.refs` 必须合并，
//    且 `content` **不许**被替换成真值
//  - 「有界上下文」：每轮请求只有 system + 最近 3 轮 + 本轮 user；历史 tool 结果不进下一轮
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

/**
 * DB 相约定（照 session.test.ts）：mock `@/db/userDb`，**绝不 mock `plugin-sql`**；
 * 真库层用 `node:sqlite` 的 `DatabaseSync` 包成 Tauri `Database` 的形状。
 */
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return { ...actual, getUserDb: () => state.db as never };
});

// `runQuery` 是唯一碰 DB 的查询入口 ⇒ 在编排层把它换掉，让"工具真的跑了"与"工具坏了"
// 两种形态都可控，而不必搭一整套流水表。
const runQueryMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/ai/runQuery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/runQuery")>();
  return { ...actual, runQuery: runQueryMock };
});

import { initUserTables } from "@/db/userDb";
import type { ChatMessage, ChatOutcome, Transport } from "@/services/ai/transport";
import type { AppliedFilter } from "@/services/ai/resolve";
import type { AiQueryResult } from "@/services/ai/querySql";
import type { LedgerSnapshot } from "@/services/ai/prompt";
import type { LookupContext } from "@/services/ai/resolve";
// 只借类型（M4）：不会把 imageInput（它 import 两个 Tauri 插件）拉进这个测试的运行时
import type { ImageAttachment } from "@/services/ai/imageInput";
import {
  runAgent,
  CANCELED_TEXT,
  CLARIFY_FAILURE_TEXT,
  DB_FAILURE_TEXT,
  ROUND_LIMIT_TEXT,
  ROUND_LIMIT,
  MAX_TOOL_CORRECTIONS,
  type AgentDeps,
  type AgentSession,
  type AgentTurn,
} from "@/services/ai/agent";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const NOW = new Date("2026-03-01T10:00:00.000Z");
const LEDGER = "L1";

const SNAPSHOT: LedgerSnapshot = {
  kind: "personal",
  categories: [{ name: "买菜", type: "expense" }],
  accounts: [{ name: "招行", type: "银行卡" }],
  tags: ["生鲜"],
  members: [{ name: "我" }],
};

const LOOKUP: LookupContext = {
  categories: [{ id: "cat-1", name: "买菜", type: "expense" }],
  accounts: [{ id: "acc-1", name: "招行" }],
  tags: [{ id: "tag-1", name: "生鲜" }],
  members: [{ id: "u1", name: "我" }],
};

const APPLIED: AppliedFilter = {
  dateFrom: "2026-03-01",
  dateTo: "2026-03-31",
  type: null,
  categories: [{ id: "cat-1", name: "买菜" }],
  account: null,
  tags: [],
  members: [],
  merchant: null,
  amountMin: null,
  amountMax: null,
};

function queryResult(): AiQueryResult {
  const bucket = { total: 128.5, count: 3, avg: 42.83 };
  return {
    expense: bucket,
    income: null,
    transfer: null,
    net: null,
    matched: 4,
    groups: null,
    items: [
      {
        date: "2026-03-01",
        amount: 128.5,
        type: "expense",
        category: "买菜",
        fromAccount: "招行",
        toAccount: null,
        note: "盒马",
      },
    ],
    truncated: false,
  };
}

/** 让 `query_transactions` 成功：`runQuery` 回一份固定的结果 */
function queryOk(): void {
  runQueryMock.mockResolvedValue({ ok: true, result: queryResult(), applied: APPLIED });
}

/** 让 `runQuery` 抛（真库异常，不该冒到编排循环） */
function queryThrows(): void {
  runQueryMock.mockRejectedValue(new Error("database is locked"));
}

const CALL_QUERY = {
  id: "c1",
  name: "query_transactions",
  arguments: JSON.stringify({ aggregate: "sum" }),
};

/** 坏 JSON 的 arguments（§4.3 的第一条纠错路径：模型的格式错） */
const CALL_BAD_ARGS = { id: "c1", name: "query_transactions", arguments: "{不是 JSON" };
const CALL_UNKNOWN = { id: "c1", name: "no_such_tool", arguments: "{}" };
const CALL_DRAFT = {
  id: "c1",
  name: "create_transaction_draft",
  arguments: JSON.stringify({ type: "expense", amount: 128, category: "买菜", fromAccount: "招行" }),
};

type Reply = { text: string; toolCalls: typeof CALL_QUERY[]; finishReason?: string };

/** 假 transport：按脚本依次回，并把每次请求的 messages 记下来。 */
function scriptedTransport(...replies: Reply[]) {
  const calls: ChatMessage[][] = [];
  let i = 0;
  const chat = vi.fn(
    async (messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal): Promise<ChatOutcome> => {
      calls.push(messages.map((m) => ({ ...m })));
      const reply = replies[i++];
      if (reply === undefined) {
        throw new Error(`假 transport 只有 ${replies.length} 条脚本，却被调用了第 ${i} 次`);
      }
      return {
        ok: true,
        reply: { text: reply.text, toolCalls: reply.toolCalls, finishReason: reply.finishReason ?? "stop" },
      };
    },
  );
  return { transport: { chat } as Transport, chat, calls };
}

/** 永远要工具的 transport（用来测轮数上限），并记下被调了几次 */
function alwaysTools() {
  let n = 0;
  const chat = vi.fn(async (_m: ChatMessage[], _t: unknown[], _s: AbortSignal): Promise<ChatOutcome> => {
    n++;
    return {
      ok: true,
      reply: { text: "", toolCalls: [{ ...CALL_QUERY, id: `c${n}` }], finishReason: "tool_calls" },
    };
  });
  return { transport: { chat } as Transport, chat, calls: () => n };
}

function failTransport(outcome: ChatOutcome) {
  const chat = vi.fn(async (): Promise<ChatOutcome> => outcome);
  return { transport: { chat } as Transport, chat };
}

// ---------------------------------------------------------------------------
// fake session（单测默认不落库；需要断言写入顺序时注入它）
// ---------------------------------------------------------------------------

function fakeSession(opts: { recentTurns?: { role: "user" | "assistant"; content: string }[] } = {}) {
  const order: string[] = [];
  const appended: Record<string, unknown>[] = [];
  const titles: { convId: string; text: string }[] = [];
  const session = {
    ensureConversation: vi.fn(async (ledgerId: string) => {
      order.push("ensureConversation");
      return `conv-${ledgerId}`;
    }),
    recentTurns: vi.fn(async (_convId: string, _n?: number) => {
      order.push("recentTurns");
      return opts.recentTurns ?? [];
    }),
    appendMessage: vi.fn(async (row: Record<string, unknown>) => {
      order.push("appendMessage");
      appended.push(row);
      return true;
    }),
    setTitleIfEmpty: vi.fn(async (convId: string, text: string) => {
      order.push("setTitleIfEmpty");
      titles.push({ convId, text });
    }),
  };
  return { session, order, appended, titles };
}

async function run(
  deps: AgentDeps,
  over: { userText?: string; signal?: AbortSignal; image?: ImageAttachment } = {},
): Promise<AgentTurn> {
  return await runAgent({
    userText: over.userText ?? "这个月花了多少",
    // `image` 只在显式给的时候才传（M4 §4.2）：缺省时**连这个键都不出现**，
    // 老路径（M1–M3）的入参与行为逐字不变。
    ...(over.image === undefined ? {} : { image: over.image }),
    ledgerId: LEDGER,
    snapshot: SNAPSHOT,
    lookup: LOOKUP,
    deps,
    signal: over.signal ?? new AbortController().signal,
  });
}

function payloadOf(rows: Record<string, unknown>[], role: string) {
  return rows.filter((r) => r.role === role).map((r) => r.payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  queryOk();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ① 正常两轮
// ---------------------------------------------------------------------------

describe("正常两轮：tool_calls → 执行 → 最终文本（② §8.B 第一条）", () => {
  it("两轮收口：回答里的 {{q1.total}} 被回填成真值，chips 带上工具返回的 applied", async () => {
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "这个月买菜共花了 {{q1.total}} 元，{{q1.matched}} 笔。", toolCalls: [] },
    );

    const turn = await run({ transport });

    expect(turn.aborted).toBe(false);
    expect(turn.text).toBe("这个月买菜共花了 128.5 元，4 笔。");
    expect(turn.chips).toHaveLength(1);
    expect(turn.chips[0]).toEqual(APPLIED);
    expect(calls).toHaveLength(2);
    expect(turn.trace).toEqual([{ round: 1, name: "query_transactions", ok: true }]);
    // 数值引用：键是**扁平**的 q1.total（修正第 12 条），不是嵌套对象。
    // 值统一是 `String(value)`：`AiMessagePayload.refs` 就是 `Record<string,string>`
    // （session.test.ts 的既有 fixture 也这么写），`fillRefs` 再 String() 一次无害。
    expect(turn.refs["q1.total"]).toBe("128.5");
    expect(turn.refs["q1.matched"]).toBe("4");
  });

  it("回填只发生在最后一步：text 里**没有**残留的 {{…}}，也没有把 content 换掉", async () => {
    const draftTurn = await run(
      (() => {
        const t = scriptedTransport(
          { text: "", toolCalls: [CALL_DRAFT] },
          { text: "已生成草稿，请确认：{{q1.amount}} 元。", toolCalls: [] },
        );
        return { transport: t.transport };
      })(),
    );
    expect(draftTurn.text).toBe("已生成草稿，请确认：128 元。");
    expect(draftTurn.text).not.toContain("{{");
  });
});

// ---------------------------------------------------------------------------
// ② 纠错一次
// ---------------------------------------------------------------------------

describe("纠错额度恰好 1 次（失败回喂给模型一次，再失败就给人话）", () => {
  it("arguments 是坏 JSON ⇒ 错误回喂给模型一次，第二次改对 ⇒ 成功收口（§4.3 第一条纠错路径）", async () => {
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_BAD_ARGS] },
      { text: "", toolCalls: [CALL_QUERY] },
      // ⚠️ 编号是 q2 而不是 q1：`refIndex` **跨调用单调递增**（q1 已经被那次失败的工具占掉了）。
      // 这条 fixture 本身就是"编号不重置"的判据 —— 写成 q1 会在下面回填失败时原样漏出占位符。
      { text: "一共 {{q2.total}} 元。", toolCalls: [] },
    );

    const turn = await run({ transport });

    expect(turn.text).toBe("一共 128.5 元。");
    // 第二次请求里必须带着**回喂的错误**（工具结果进了 messages）
    const second = calls[1]!;
    const toolMsg = second.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("arguments 不是合法 JSON");
    expect(toolMsg!.tool_call_id).toBe("c1");
    // 而第二次请求里**没有**重复的 assistant 文本
    expect(calls[1]!.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(turn.trace.filter((t) => !t.ok)).toHaveLength(1);
  });

  it("工具名不存在（另一条纠错路径）同样只回喂一次", async () => {
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_UNKNOWN] },
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "一共 {{q2.total}} 元。", toolCalls: [] },
    );
    const turn = await run({ transport });
    expect(turn.text).toBe("一共 128.5 元。");
    expect(calls[1]!.find((m) => m.role === "tool")!.content).toContain("未知工具");
  });

  it("失败两次（额度用尽）⇒ 人话「我没理解这个请求，换个说法试试」，且**不再发第三次请求**", async () => {
    const { transport, chat } = scriptedTransport(
      { text: "", toolCalls: [CALL_UNKNOWN] },
      { text: "", toolCalls: [CALL_UNKNOWN] },
      { text: "不该被问到", toolCalls: [] },
    );

    const turn = await run({ transport });

    expect(turn.text).toBe(CLARIFY_FAILURE_TEXT);
    expect(chat).toHaveBeenCalledTimes(2); // 第 2 次是"纠错"，第 3 次不该发生
    expect(MAX_TOOL_CORRECTIONS).toBe(1);
  });

  it("工具执行抛异常（真库错）也走「一次纠正」，绝不冒到编排循环", async () => {
    queryThrows();
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "查不了，稍后再试。", toolCalls: [] },
    );

    const turn = await run({ transport });

    expect(turn.text).toBe("查不了，稍后再试。");
    expect(calls[1]!.find((m) => m.role === "tool")!.content).toContain("执行失败");
  });
});

// ---------------------------------------------------------------------------
// ③ not_found / 反问：不算错误，不重试
// ---------------------------------------------------------------------------

describe("名字解析失败是语义歧义、不是错误：模型反问时**不再发起工具调用**", () => {
  it("not_found ⇒ 工具把候选/事实回给模型 ⇒ 模型反问 ⇒ 循环收口且只调了一次工具", async () => {
    runQueryMock.mockResolvedValue({
      ok: false,
      failure: {
        kind: "unresolved",
        errors: [{ kind: "not_found", field: "categories", value: "老地方", candidates: [] }],
      },
    });
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "这个账本还没有分类，所以「老地方」不存在。", toolCalls: [] },
    );

    const turn = await run({ transport });

    expect(turn.text).toContain("还没有分类");
    expect(calls).toHaveLength(2);
    // 第二次请求里带的是**事实**（"这个账本还没有分类"），不是空候选列表
    expect(calls[1]!.find((m) => m.role === "tool")!.content).toContain("这个账本还没有分类");
    expect(turn.chips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ④ 轮数上限 6
// ---------------------------------------------------------------------------

describe("轮数上限（规格 §5.2 的 6 轮；用尽时给**得体的收尾**而不是错误气泡）", () => {
  it("轮数上限计的是**工具调用轮**：每一轮请求都拿到 tool_calls ⇒ 共 6 次请求后收口", async () => {
    const { transport, calls } = alwaysTools();

    const turn = await run({ transport });

    expect(ROUND_LIMIT).toBe(6);
    expect(turn.text).toBe(ROUND_LIMIT_TEXT);
    // ⚠️ 这条断言是"去掉轮数上限"变异的**快速杀手**：没有上限时 mock 会一直回工具调用，
    // 用例要挂到 vitest 超时（20s）才结束 —— 而 `calls()` 会先把次数顶上去。
    // 每轮 1 次请求（"第一次请求拿到 tool_calls"这条读法见 §5.2 的伪码：第 3 步在 while 外）。
    expect(calls()).toBe(ROUND_LIMIT);
    expect(turn.trace).toHaveLength(ROUND_LIMIT);
    expect(turn.trace[0]!.round).toBe(1);
    expect(turn.trace[ROUND_LIMIT - 1]!.round).toBe(ROUND_LIMIT);
    expect(turn.text).not.toContain("{{");
  });

  it("上限用尽时的文案是**建议**、不是错误（不含失败字样，也不走 §5.3 的错误矩阵）", async () => {
    const { transport } = alwaysTools();
    const turn = await run({ transport });
    expect(turn.text).toContain("筛选");
    expect(turn.text).not.toContain("失败");
    expect(turn.text).not.toContain("网络");
    expect(turn.text).toBe(ROUND_LIMIT_TEXT);
  });

  it("恰好 6 轮工具后模型给文本 ⇒ 正常收口（上限不是「提前掐断」）", async () => {
    const { transport, chat } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "前三轮够了：{{q3.total}} 元。", toolCalls: [] },
    );
    const turn = await run({ transport });
    expect(chat).toHaveBeenCalledTimes(4);
    expect(turn.text).toBe("前三轮够了：128.5 元。");
    expect(turn.trace).toHaveLength(3);
  });

  it("上限是**恰好** 6 轮：第 7 次请求一旦真发出，假 transport 立刻抛 ⇒ 毫秒级变红（不靠挂死）", async () => {
    // ⚠️ 上面 `alwaysTools()` 那条在"去掉轮数上限"变异下是**挂死**到 testTimeout(20s)，
    // 而挂死不是"红"（耗时法判据）。这条给**有界脚本**：第 ROUND_LIMIT+1 次调用会让假
    // transport 抛「脚本不够」⇒ 被 catch 吞成 DB_FAILURE_TEXT + 调用次数顶到 7 ⇒ 立刻红。
    const replies: Reply[] = Array.from({ length: ROUND_LIMIT }, (_unused, i) => ({
      text: "",
      toolCalls: [{ ...CALL_QUERY, id: `c${i + 1}` }],
    }));
    const { transport, chat } = scriptedTransport(...replies);

    const turn = await run({ transport });

    expect(chat).toHaveBeenCalledTimes(ROUND_LIMIT);
    expect(turn.text).toBe(ROUND_LIMIT_TEXT);
    expect(turn.aborted).toBe(false);
    expect(turn.trace).toHaveLength(ROUND_LIMIT);
  });

  it("用尽时的**收尾会落进消息流**，且落的是建议文案而不是错误文案（不是错误气泡）", async () => {
    // 上面几条都不注入 session ⇒ 只钉了返回值，没钉"这条收尾到底有没有给到用户"。
    // 变异：把 `agent.ts:472` 的落库文案换成 DB_FAILURE_TEXT ⇒ 本用例立刻红。
    const { session, appended } = fakeSession();
    const { transport } = alwaysTools();

    await run({ transport, session });

    const assistants = appended.filter((r) => r.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe(ROUND_LIMIT_TEXT);
    expect(assistants.some((r) => r.content === DB_FAILURE_TEXT)).toBe(false);
    expect(assistants.some((r) => r.content === CLARIFY_FAILURE_TEXT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 取消
// ---------------------------------------------------------------------------

describe("取消：不产生错误气泡、不写 assistant、循环立刻停（§5.2 / §5.3）", () => {
  it("一轮都没开始就 abort ⇒ 一个请求都不发、**连 user 消息都不落库**（§5.2「丢弃结果」）", async () => {
    const { session, appended } = fakeSession();
    const { transport, chat } = scriptedTransport({ text: "不该被问到", toolCalls: [] });
    const controller = new AbortController();
    controller.abort();

    const turn = await run({ transport, session }, { signal: controller.signal });

    expect(turn.aborted).toBe(true);
    expect(turn.text).toBe("");
    expect(turn.chips).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
    // 取消**不产生错误气泡**，也不留半条 user 消息：一次 appendMessage 都没有
    expect(appended).toEqual([]);
    expect(session.ensureConversation).not.toHaveBeenCalled();
  });

  it("在途取消（请求发出后再 abort，transport 回 cancelled）⇒ user 已落库、assistant 没有", async () => {
    const { session, appended } = fakeSession();
    const controller = new AbortController();
    // 在途取消：请求**已经发出**，用户在中途点了停 ⇒ transport 回 `cancelled`
    const chat = vi.fn(async (): Promise<ChatOutcome> => {
      controller.abort();
      return { ok: false, failure: { kind: "cancelled" } };
    });

    const turn = await run({ transport: { chat } as Transport, session }, { signal: controller.signal });

    expect(chat).toHaveBeenCalledTimes(1); // 与"一开始就 abort"那条形成对照
    expect(turn.aborted).toBe(true);
    expect(turn.text).toBe("");
    expect(appended.map((r) => r.role)).toEqual(["user"]);
    // 取消的那句话**不写**进消息流（§5.3 的错误矩阵里没有"取消"这一行）
    expect(CANCELED_TEXT.length).toBeGreaterThan(0); // 文案常量存在，但不该被渲染
    expect(appended.some((r) => r.content === CANCELED_TEXT)).toBe(false);
    expect(appended.some((r) => r.content === "这次提问已取消。")).toBe(false);
  });

  it("transport 回 `cancelled` 而 signal **没有** aborted ⇒ 同样不产生任何 assistant 消息（分类是唯一依据）", async () => {
    // ⚠️ 这条是"另一条防线圆回来"的杀手。上面两条都在 `chat` 里 `controller.abort()`，
    // 于是 `agent.ts:435` 的 `signal.aborted` 检查**先**返回 —— `agent.ts:439` 的
    // `isCanceled` 分支在测试里是死代码（实测：把 `isCanceled` 改成恒 false，43 条全绿）。
    // 这里**不动** signal，只让 transport 给出 `cancelled` 分类：唯一能挡住"渲染取消文案"
    // 的就只剩 `isCanceled`。变异：`agent.ts:145` 恒 false ⇒ 本用例红。
    const { session, appended } = fakeSession();
    const controller = new AbortController();
    const chat = vi.fn(
      async (): Promise<ChatOutcome> => ({ ok: false, failure: { kind: "cancelled" } }),
    );

    const turn = await run({ transport: { chat } as Transport, session }, { signal: controller.signal });

    // 前提断言（守卫）：signal 确实没被 abort —— 否则本用例又被 435 圆回来、判不出 isCanceled 死没死。
    expect(controller.signal.aborted).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(turn.aborted).toBe(true);
    expect(turn.text).toBe("");
    expect(appended.map((r) => r.role)).toEqual(["user"]);
    expect(appended.some((r) => r.content === CANCELED_TEXT)).toBe(false);
  });

  it("cancelled 与真实失败**不同形态**：同一 transport 换成 network ⇒ 立刻落一条错误气泡（对照）", async () => {
    // 与上一条的唯一差别是 failure.kind：证明上面那条不是"任何失败都不写库"。
    const { session, appended } = fakeSession();
    const chat = vi.fn(
      async (): Promise<ChatOutcome> => ({ ok: false, failure: { kind: "network" } }),
    );

    const turn = await run({ transport: { chat } as Transport, session });

    expect(turn.aborted).toBe(false);
    expect(turn.text).toBe("网络似乎不太顺，等会儿再试试。");
    expect(appended.filter((r) => r.role === "assistant")).toHaveLength(1);
  });

  it("transport 忽略 signal 仍回了成功响应 ⇒ 收尾时也要尊重 abort（不落库、不返回内容）", async () => {
    const { session, appended } = fakeSession();
    const controller = new AbortController();
    const chat = vi.fn(async (): Promise<ChatOutcome> => {
      controller.abort(); // 请求在途时用户取消，但实现方假装没看见
      return { ok: true, reply: { text: "迟到的回答", toolCalls: [], finishReason: "stop" } };
    });

    const turn = await run({ transport: { chat } as Transport, session }, { signal: controller.signal });

    expect(turn.aborted).toBe(true);
    expect(turn.text).toBe("");
    expect(payloadOf(appended, "assistant")).toEqual([]);
    expect(appended.some((r) => r.content === "迟到的回答")).toBe(false);
  });

  it("工具执行中途取消 ⇒ 也不再发下一轮请求", async () => {
    const { session } = fakeSession();
    const controller = new AbortController();
    let n = 0;
    const chat = vi.fn(async (): Promise<ChatOutcome> => {
      n++;
      if (n === 1) {
        return { ok: true, reply: { text: "", toolCalls: [CALL_QUERY], finishReason: "tool_calls" } };
      }
      return { ok: true, reply: { text: "不该到这", toolCalls: [], finishReason: "stop" } };
    });
    // 工具执行期间的取消：靠 runQuery 的调用把 controller 掐掉
    runQueryMock.mockImplementation(async () => {
      controller.abort();
      return { ok: true, result: queryResult(), applied: APPLIED };
    });

    const turn = await run({ transport: { chat } as Transport, session }, { signal: controller.signal });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(turn.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 错误即消息（永不抛）
// ---------------------------------------------------------------------------

describe("错误一律变成一条用户可见的 assistant 消息，用 transport 给的中文（§5.3）", () => {
  const CASES = [
    { kind: "network", text: "网络似乎不太顺，等会儿再试试。" },
    { kind: "timeout", text: "AI 分析超时了，请重试。" },
    { kind: "unauthorized", text: "登录状态已过期，请重新登录后再试。" },
    { kind: "disabled", text: "这个服务器还没启用 AI 功能。" },
    { kind: "too_large", text: "这次的对话内容太长了，清空会话记录后再试。" },
    { kind: "bad_request", text: "这条消息没能发出去，换个说法试试。" },
    { kind: "invalid_response", text: "AI 返回的内容看不懂，请重试。" },
    { kind: "rate_limited_minute", failure: { kind: "rate_limited", scope: "minute" }, text: "问得有点快，歇一分钟再试。" },
    { kind: "rate_limited_day", failure: { kind: "rate_limited", scope: "day" }, text: "今天的 AI 次数已经用完了，明天再来吧。" },
    { kind: "upstream", failure: { kind: "upstream", code: "ai_unreachable" }, text: "AI 服务暂时不可用，请稍后重试。" },
  ] as const;

  it.each(CASES.map((c) => [c.kind, c]))("%s ⇒ 落到消息流里的一条 assistant 消息", async (_kind, c) => {
    const failure = "failure" in c ? c.failure : { kind: c.kind };
    const { session, appended } = fakeSession();
    const { transport } = failTransport({ ok: false, failure } as ChatOutcome);

    const turn = await run({ transport, session });

    expect(turn.text).toBe(c.text);
    expect(turn.aborted).toBe(false);
    const assistants = appended.filter((r) => r.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe(c.text);
  });

  it("循环里的任何一步都不抛：transport 直接 throw 也变成一条通用失败消息", async () => {
    const { session, appended } = fakeSession();
    const chat = vi.fn(async (): Promise<ChatOutcome> => {
      throw new Error("谁把 fetch 弄成这样了");
    });

    const turn = await run({ transport: { chat } as Transport, session });

    expect(turn.text).toMatch(/AI|失败|稍后/);
    expect(appended.filter((r) => r.role === "assistant")).toHaveLength(1);
  });

  it("序言里的 `buildSystemPrompt` 抛（快照缺 categories）⇒ 也只是一条失败消息，绝不冒出去", async () => {
    // 杀手（Minor 第 1 处）：`:365` 的 docstring 写着"永不抛"，但 `try` 曾经从**循环**才开始
    // ⇒ 序言里的 `buildSystemPrompt`（`prompt.ts:68` 的 `s.categories.map`）在快照缺字段时
    // 直接 TypeError 冒到调用方，且当时**没有一条用例能红**（`:601` 只覆盖循环内的 transport throw）。
    // 修复前本用例实测：`TypeError: Cannot read properties of undefined (reading 'map')`。
    const broken = {
      kind: "personal",
      accounts: [{ name: "招行", type: "银行卡" }],
      tags: [],
      members: [{ name: "我" }],
    } as unknown as LedgerSnapshot;
    const { session, appended } = fakeSession();
    const { transport, chat } = scriptedTransport({ text: "不该被问到", toolCalls: [] });

    const turn = await runAgent({
      userText: "这个月花了多少",
      ledgerId: LEDGER,
      snapshot: broken,
      lookup: LOOKUP,
      deps: { transport, session, now: () => NOW },
      signal: new AbortController().signal,
    });

    // ① 不抛：变成一条用户可见的消息（§5.3 的通用失败文案）
    expect(turn.text).toBe(DB_FAILURE_TEXT);
    expect(turn.aborted).toBe(false);
    // ② system prompt 都组不出来 ⇒ 一个请求都不该发出去
    expect(chat).not.toHaveBeenCalled();
    // ③ "错误即消息"：这条失败同样要落进消息流，与 `!outcome.ok` 路径同一处理风格
    //    （user 消息在序言里已落库，assistant 那条由 catch 补上）
    const assistants = appended.filter((r) => r.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.content).toBe(DB_FAILURE_TEXT);
  });

  it("本地 DB 不可用（会话建不出来）⇒ 实话实说的失败消息，不假装查过", async () => {
    const session = {
      ensureConversation: vi.fn(async () => null),
      recentTurns: vi.fn(async () => []),
      appendMessage: vi.fn(async () => true),
      setTitleIfEmpty: vi.fn(async () => {}),
    };
    const { transport, chat } = scriptedTransport({ text: "不该被问到", toolCalls: [] });

    const turn = await run({ transport, session });

    expect(turn.text).toBe(DB_FAILURE_TEXT);
    expect(chat).not.toHaveBeenCalled();
  });

  it("user 消息写不进库 ⇒ 也不再发请求（回一条失败消息，而不是偷偷继续）", async () => {
    const session = {
      ensureConversation: vi.fn(async () => "conv-L1"),
      recentTurns: vi.fn(async () => []),
      appendMessage: vi.fn(async () => false),
      setTitleIfEmpty: vi.fn(async () => {}),
    };
    const { transport, chat } = scriptedTransport({ text: "不该被问到", toolCalls: [] });

    const turn = await run({ transport, session });

    expect(turn.text).toBe(DB_FAILURE_TEXT);
    expect(chat).not.toHaveBeenCalled();
  });

  it("`buildLookupContext` 抛（真库异常，Ruling 21）⇒ 变成失败消息，绝不冒出去", async () => {
    // 只有 DB 为 null 时它才返回空表；真查询异常会抛 ⇒ 编排层必须按 §5.3 收下
    state.db = {
      select: vi.fn(async () => {
        throw new Error("database disk image is malformed");
      }),
    };
    const { transport, chat } = scriptedTransport({ text: "不该被问到", toolCalls: [] });

    const turn = await runAgent({
      userText: "这个月花了多少",
      ledgerId: LEDGER,
      snapshot: SNAPSHOT,
      // 不注入 lookup ⇒ 走真实的 buildLookupContext
      deps: { transport, now: () => NOW },
      signal: new AbortController().signal,
    });

    expect(turn.text).toBe(DB_FAILURE_TEXT);
    expect(chat).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ⑦ 草稿工具零写入
// ---------------------------------------------------------------------------

describe("权限边界：草稿工具**零 DB 写入**（§8.B 的核心断言）", () => {
  it("create_transaction_draft 执行后 db.execute 调用次数为 0", async () => {
    const execute = vi.fn(async () => ({ rowsAffected: 1 }));
    state.db = { execute, select: vi.fn(async () => []) };

    const { transport } = scriptedTransport(
      { text: "", toolCalls: [CALL_DRAFT] },
      { text: "已生成草稿，请确认：{{q1.amount}} 元。", toolCalls: [] },
    );

    const turn = await run({ transport });

    expect(turn.drafts).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("agent 自己把草稿落库也是禁止的：`db.execute` 里不许出现写 ai_messages 的语句", async () => {
    // 上面那条用的是 null session ⇒ 完全不落库，**区分不了**"工具没写"与"agent 也没写"。
    // 这条给一个真会话，钉住写入只发生在 session 层。
    const execute = vi.fn(async () => ({ rowsAffected: 1 }));
    state.db = { execute, select: vi.fn(async () => []) };
    const { session } = fakeSession();

    const { transport } = scriptedTransport(
      { text: "", toolCalls: [CALL_DRAFT] },
      { text: "已生成草稿，请确认。", toolCalls: [] },
    );
    await run({ transport, session });

    const sqls = execute.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(sqls.filter((s) => s.includes("ai_messages"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑧ 有界上下文 + refs 合并 + payload 持久化
// ---------------------------------------------------------------------------

describe("上下文 = system + 最近 3 轮 + 本轮 user（§4.5；不带历史 tool 结果）", () => {
  it("recentTurns 以 n=3 调用，且请求里是 system + 3 轮 + 本轮 user", async () => {
    const { session } = fakeSession({
      recentTurns: [
        { role: "user", content: "上上轮" },
        { role: "assistant", content: "上上轮答" },
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "上一轮答" },
      ],
    });
    const { transport, calls } = scriptedTransport({ text: "好", toolCalls: [] });

    await run({ transport, session }, { userText: "这一轮" });

    expect(session.recentTurns).toHaveBeenCalledWith("conv-L1", 3);
    const roles = calls[0]!.map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user", "assistant", "user"]);
    expect(calls[0]![0]!.content).toContain("你是「一起数钱」"); // 真的带了 system prompt
    expect(calls[0]![5]!.content).toBe("这一轮");
  });

  it("历史里最后一条 user 与本轮重复 ⇒ 不再出现两次（否则「最近 3 轮」会退化成 2 轮）", async () => {
    const { session } = fakeSession({
      recentTurns: [
        { role: "user", content: "上一条" },
        { role: "assistant", content: "上一条答" },
        { role: "user", content: "这一轮" },
      ],
    });
    const { transport, calls } = scriptedTransport({ text: "好", toolCalls: [] });

    await run({ transport, session }, { userText: "这一轮" });

    expect(calls[0]!.filter((m) => m.role === "user" && m.content === "这一轮")).toHaveLength(1);
  });

  it("历史 tool 结果**不进**下一轮：第二次请求里没有任何 role:\"tool\" 以外的历史污染", async () => {
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "两轮都查了。", toolCalls: [] },
    );
    await run({ transport });

    // 第二轮请求必须带上第一轮的 tool 结果（模型要看得到结果才能继续）
    expect(calls[1]!.some((m) => m.role === "tool")).toBe(true);
    // 第三轮请求**不**重复带第一轮的 tool 结果：只保留本轮的
    const tools3 = calls[2]!.filter((m) => m.role === "tool");
    expect(tools3).toHaveLength(1);
    // 并且总长度有界：system + 至多 3 轮历史 + 本轮 user + 本轮 assistant + 本轮 tool
    expect(calls[2]!.length).toBeLessThanOrEqual(8);
  });
});

describe("refs 合并进 payload、content 保持占位符原文（§4.5 / §7.2）", () => {
  it("assistant 消息的 payload 里有合并后的 refs（键扁平、值是真值），content 里是占位符", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "共 {{q1.total}} 元，{{q1.matched}} 笔。", toolCalls: [] },
    );

    const turn = await run({ transport, session });

    const row = appended.find((r) => r.role === "assistant")!;
    // ⚠️ 存进 ai_messages.content 的必须是**带占位符的字符串**（渲染时才回填，§4.5）
    expect(row.content).toBe("共 {{q1.total}} 元，{{q1.matched}} 笔。");
    expect(row.content).not.toContain("128.5");
    const payload = row.payload as { refs: Record<string, string>; chips: unknown[]; trace: unknown[] };
    expect(payload.refs["q1.total"]).toBe("128.5");
    expect(payload.refs["q1.matched"]).toBe("4");
    expect(payload.chips).toHaveLength(1);
    // ⚠️ 而这个用例的判别力靠"两边对照"：turn.text 是回填后的（**不落库**），
    // row.content 是占位符原文（落库）。只钉一边的实现会在这里露馅。
    expect(turn.text).toBe("共 128.5 元，4 笔。");
    expect(payload.trace).toEqual([{ round: 1, name: "query_transactions", ok: true }]);
  });

  it("两轮工具调用的 refs 用 q1/q2 前缀合并（编号跨调用单调递增，不是每轮从 1 开始）", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "本月 {{q1.total}}，上月 {{q2.total}}。", toolCalls: [] },
    );

    await run({ transport, session });

    const payload = appended.find((r) => r.role === "assistant")!.payload as {
      refs: Record<string, string>;
    };
    // 两轮工具 = 两组 refs，且**两组都存在**（键按 q1/q2 前缀区分）。断言"两组都在"
    // 而不是"恰好这两个键"：一个查询真实产出的键由 tools.ts 决定（total/count/avg/…），
    // 这里要钉的是**合并**与**编号跨调用递增**，不是 tools 的键清单（那是 tools 的用例）。
    const keys = Object.keys(payload.refs);
    expect(keys).toContain("q1.total");
    expect(keys).toContain("q1.matched");
    expect(keys).toContain("q2.total");
    expect(keys).toContain("q2.matched");
    // 同一轮的两个查询不该互相覆盖（编号真的递增了，不是每轮从 q1 重来）
    expect(keys.filter((k) => k.startsWith("q1.")).length).toBeGreaterThan(0);
    expect(keys.filter((k) => k.startsWith("q2.")).length).toBe(keys.filter((k) => k.startsWith("q1.")).length);
  });

  it("草稿的 payload 带 drafts（含 draftId），chips 为空", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport(
      { text: "", toolCalls: [CALL_DRAFT] },
      { text: "已生成草稿，请确认：{{q1.amount}} 元。", toolCalls: [] },
    );

    const turn = await run({ transport, session });

    const payload = appended.find((r) => r.role === "assistant")!.payload as {
      drafts: { draftId: string }[];
    };
    expect(payload.drafts).toHaveLength(1);
    expect(typeof payload.drafts[0]!.draftId).toBe("string");
    expect(turn.drafts).toHaveLength(1);
    expect(turn.chips).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑨ 接线：ensureConversation → appendMessage、setTitleIfEmpty
// ---------------------------------------------------------------------------

describe("接线（修正第 10 条）：每一轮先 ensureConversation 再 appendMessage，每条 user 消息后 setTitleIfEmpty", () => {
  it("调用顺序是 ensureConversation → appendMessage(user) → setTitleIfEmpty，一轮一次", async () => {
    const { session, order, titles, appended } = fakeSession();
    const { transport } = scriptedTransport({ text: "好", toolCalls: [] });

    await run({ transport, session }, { userText: "这个月花了多少" });

    expect(order).toEqual([
      "ensureConversation",
      "recentTurns",
      "appendMessage", // user
      "setTitleIfEmpty",
      "appendMessage", // assistant
    ]);
    expect(titles).toEqual([{ convId: "conv-L1", text: "这个月花了多少" }]);
    expect(appended.map((r) => r.conversation_id)).toEqual(["conv-L1", "conv-L1"]);
  });

  it("首条消息设置标题并截断到 20 字；第二条**不覆盖**（标题逻辑在 session 里，这里钉调用）", async () => {
    const { session, titles } = fakeSession();
    // ⚠️ 两次 run 必须给**两条**脚本：只给一条时第二轮 `chat` 会抛「脚本不够」，
    // 被"错误即消息"吞成 DB_FAILURE_TEXT —— 用例仍绿，但第二轮其实什么都没答
    // （实测：把 catch 改成 rethrow 后本条因这个夹具瑕疵变红，属"因为错的理由红"）。
    const { transport } = scriptedTransport(
      { text: "好", toolCalls: [] },
      { text: "好", toolCalls: [] },
    );

    await run({ transport, session }, { userText: "第".repeat(30) });
    await run({ transport, session }, { userText: "第二条" });

    // 每次写 user 消息都调一次（**不是**只在"新建会话"分支调）：
    // setTitleIfEmpty 自己只认 title 是否为空，分不出"新会话"与"第二条消息"
    expect(titles).toHaveLength(2);
    expect(session.setTitleIfEmpty.mock.calls[0]).toEqual(["conv-L1", "第".repeat(30)]);
    expect(session.setTitleIfEmpty.mock.calls[1]).toEqual(["conv-L1", "第二条"]);
  });

  it("ensureConversation 抛异常（约束冲突等）⇒ 全是失败消息，绝不冒出去", async () => {
    const session = {
      ensureConversation: vi.fn(async () => {
        throw new Error("UNIQUE constraint failed: ai_conversations.ledger_id");
      }),
      recentTurns: vi.fn(async () => []),
      appendMessage: vi.fn(async () => true),
      setTitleIfEmpty: vi.fn(async () => {}),
    };
    const { transport, chat } = scriptedTransport({ text: "不该被问到", toolCalls: [] });

    const turn = await run({ transport, session });

    expect(turn.text).toBe(DB_FAILURE_TEXT);
    expect(chat).not.toHaveBeenCalled();
    // user 消息也不该落库（会话都没建出来）
    expect(session.appendMessage).not.toHaveBeenCalled();
  });

  it("recentTurns 抛异常 ⇒ 不致命：少一段上下文仍要回答（只是没有历史）", async () => {
    const session = {
      ensureConversation: vi.fn(async () => "conv-L1"),
      recentTurns: vi.fn(async () => {
        throw new Error("database is locked");
      }),
      appendMessage: vi.fn(async () => true),
      setTitleIfEmpty: vi.fn(async () => {}),
    };
    const { transport, calls } = scriptedTransport({ text: "照常回答", toolCalls: [] });

    const turn = await run({ transport, session });

    expect(turn.text).toBe("照常回答");
    // 请求里只有 system + 本轮 user（历史丢了，但对话没崩）
    expect(calls[0]!.map((m) => m.role)).toEqual(["system", "user"]);
    expect(session.appendMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ⑩ 真库：「清空会话后继续说话」必须落进**被复活**的会话
// ---------------------------------------------------------------------------

describe("真库：往软删会话里 appendMessage 是「写得进、读不出」⇒ 每轮先 ensure 才安全（修正第 10 条）", () => {
  function asTauriDb(sqlite: DatabaseSync) {
    return {
      // 形状照安装包产物：plugin-sql 的 `execute` 恒返回 `{ rowsAffected, lastInsertId }`
      // （`dist-js/index.js:88-98`，2.4.0），不是 `node:sqlite` 的 `{ changes }`（R86-2）。
      execute: async (sql: string, params: unknown[] = []): Promise<unknown> => {
        const r = sqlite.prepare(sql).run(...(params as never[]));
        return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
      },
      select: async <T,>(sql: string, params: unknown[] = []): Promise<T> =>
        sqlite.prepare(sql).all(...(params as never[])) as unknown as T,
    };
  }

  it("clearConversation 之后再 runAgent 一轮 ⇒ 消息落在被复活的会话里、loadMessages 读得到", async () => {
    const sqlite = new DatabaseSync(":memory:");
    await initUserTables(asTauriDb(sqlite) as never);
    state.db = asTauriDb(sqlite);

    const sessionModule = await import("@/services/ai/session");
    // 逐字段挑出接口要求的那四个函数：直接传模块命名空间会让 TS 的成员匹配（带
    // Symbol.toStringTag 等的命名空间不是普通对象）报 TS2322 —— 而这里同时保留了
    // "这四条签名必须真对得上 session.ts" 的结构化检查。
    const session: AgentSession = {
      ensureConversation: (ledgerId, now) => sessionModule.ensureConversation(ledgerId, now),
      recentTurns: (conversationId, n) => sessionModule.recentTurns(conversationId, n),
      appendMessage: (row) => sessionModule.appendMessage(row),
      setTitleIfEmpty: (convId, text) => sessionModule.setTitleIfEmpty(convId, text),
    };
    const { transport } = scriptedTransport(
      { text: "第一次回答", toolCalls: [] },
      { text: "第二次回答", toolCalls: [] },
    );

    // 第一轮
    await run({ transport, session });
    // 清空（硬删消息 + 软删会话）
    await sessionModule.clearConversation(LEDGER, NOW);
    const convId = (await sessionModule.ensureConversation(LEDGER, NOW))!;
    expect(await sessionModule.loadMessages(convId)).toEqual([]); // 真清空了

    // 第二轮：ensure 必须**复活**会话，否则新消息落进 is_deleted=1 的行、读不出来
    const turn = await run({ transport, session }, { userText: "又问一次" });

    expect(turn.text).toBe("第二次回答");
    const rows = await sessionModule.loadMessages(convId);
    expect(rows.map((r) => r.content)).toEqual(["又问一次", "第二次回答"]);
    expect(rows.every((r) => r.conversation_id === convId)).toBe(true);
    // 会话被复活 + 标题重新填上（clearConversation 把 title 置 NULL 了）
    const conv = sqlite
      .prepare("SELECT is_deleted, title FROM ai_conversations WHERE ledger_id = ?")
      .get(LEDGER) as { is_deleted: number; title: string };
    expect(conv.is_deleted).toBe(0);
    expect(conv.title).toBe("又问一次");
    sqlite.close();
  });

  it("软删会话**没有**被预先复活时：runAgent 自己必须先 ensure（否则消息落进 is_deleted=1 的行、读不出来）", async () => {
    // ⚠️ 上面那条**考不出**这件事：它为了拿 convId 调了一次 `ensureConversation`（`agent.test.ts`
    // 的那行），顺手把会话复活了 ⇒ 之后 runAgent 里的 ensure 是不是每轮都调，它分辨不了。
    // 实测：把会话 id 改成"模块级缓存、第二轮不再 ensure"（M4 变异），上面那条**仍然绿**。
    // 这条不预先复活：clearConversation 之后直接从 SQL 取 id，并先断言它确实是软删状态。
    const sqlite = new DatabaseSync(":memory:");
    await initUserTables(asTauriDb(sqlite) as never);
    state.db = asTauriDb(sqlite);

    const sessionModule = await import("@/services/ai/session");
    const session: AgentSession = {
      ensureConversation: (ledgerId, now) => sessionModule.ensureConversation(ledgerId, now),
      recentTurns: (conversationId, n) => sessionModule.recentTurns(conversationId, n),
      appendMessage: (row) => sessionModule.appendMessage(row),
      setTitleIfEmpty: (convId, text) => sessionModule.setTitleIfEmpty(convId, text),
    };
    const { transport } = scriptedTransport(
      { text: "第一次回答", toolCalls: [] },
      { text: "复活后的回答", toolCalls: [] },
    );

    await run({ transport, session });
    await sessionModule.clearConversation(LEDGER, NOW);

    const row = sqlite
      .prepare("SELECT id, is_deleted FROM ai_conversations WHERE ledger_id = ?")
      .get(LEDGER) as { id: string; is_deleted: number };
    // 前提断言（守卫）：此刻会话确实是**软删**的 —— 否则本用例又会像上面那条一样被自己圆回来
    expect(row.is_deleted).toBe(1);

    const turn = await run({ transport, session }, { userText: "软删之后又问" });

    expect(turn.text).toBe("复活后的回答");
    const after = sqlite
      .prepare("SELECT is_deleted FROM ai_conversations WHERE ledger_id = ?")
      .get(LEDGER) as { is_deleted: number };
    expect(after.is_deleted).toBe(0); // ensure 把它复活了
    const rows = await sessionModule.loadMessages(row.id);
    expect(rows.map((r) => r.content)).toEqual(["软删之后又问", "复活后的回答"]);
    sqlite.close();
  });
});

// ---------------------------------------------------------------------------
// ⑪ 绝不把 id 发给模型 / 不传 signal 给 refresh
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ⑫ M4 截图：本轮 content 的组装（§4.2）/ payload.image 落库（§4.1）/ 带图 400 的文案（§8）
// ---------------------------------------------------------------------------

describe("M4 带图那一轮：content 三态组装（§4.2）", () => {
  const IMG: ImageAttachment = {
    mime: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,QUJD",
    width: 1280,
    height: 960,
    bytes: 3,
  };
  /** 本轮那条 user 消息（历史上那几条也在数组里，所以按"最后一条 user"取） */
  const lastUser = (msgs: ChatMessage[]): ChatMessage | undefined =>
    [...msgs].reverse().find((m) => m.role === "user");

  it("无图 ⇒ content 仍是**字符串**（M1–M3 老路径零回归）", async () => {
    const { transport, calls } = scriptedTransport({ text: "好", toolCalls: [] });
    await run({ transport }, { userText: "上个月花了多少" });
    // 杀手：把 `userContent()` 改成"一律返回块数组" ⇒ 这条红（老路径的 content 类型变了）
    expect(lastUser(calls[0]!)!.content).toBe("上个月花了多少");
    expect(typeof lastUser(calls[0]!)!.content).toBe("string");
  });

  it("有图 + 无文字 ⇒ **只**一块 image_url（空 text 块在部分供应商上会被判非法）", async () => {
    const { transport, calls } = scriptedTransport({ text: "看不出金额", toolCalls: [] });
    await run({ transport }, { userText: "", image: IMG });
    // 杀手：删掉 `userContent` 里的 image_url 块（只发 text）⇒ 这条红
    expect(lastUser(calls[0]!)!.content).toEqual([
      { type: "image_url", image_url: { url: IMG.dataUrl } },
    ]);
    // 文字为空**不能**变成"不发这一轮"：这一轮必须真发出去（§4.2 允许只有图）
    expect(calls).toHaveLength(1);
  });

  it("有图 + 有文字 ⇒ 先 text 块再 image_url 块", async () => {
    const { transport, calls } = scriptedTransport({ text: "好", toolCalls: [] });
    await run({ transport }, { userText: "算餐饮", image: IMG });
    // 杀手：省掉 text 块（带图时只发 image_url）⇒ 这条红（用户那句指令丢了）
    expect(lastUser(calls[0]!)!.content).toEqual([
      { type: "text", text: "算餐饮" },
      { type: "image_url", image_url: { url: IMG.dataUrl } },
    ]);
  });

  it("图**只进当轮**：第二轮请求（工具往返）不会再多带一份图，历史里也没有图", async () => {
    const { session } = fakeSession({
      recentTurns: [
        { role: "user", content: "[用户发过一张截图] 算餐饮" }, // §4.3：历史里已经是占位文本
        { role: "assistant", content: "好" },
      ],
    });
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "记好了", toolCalls: [] },
    );
    await run({ transport, session }, { userText: "算餐饮", image: IMG });

    expect(calls).toHaveLength(2);
    // 本轮那块图在两轮请求里各出现一次（第二轮的 messages 是"历史 + 本轮 + 工具往返"重建的）
    for (const msgs of calls) {
      const withImage = msgs.filter(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image_url"),
      );
      expect(withImage).toHaveLength(1);
    }
    // 历史那一条**永远**是字符串（占位文本），不会把 dataUrl 再发一遍
    expect(JSON.stringify(calls[0]!.slice(0, 3))).not.toContain("base64");
  });
});

describe("M4 带图那一轮：图落 payload、content 仍是纯文本（§4.1）", () => {
  const IMG: ImageAttachment = {
    mime: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,QUJD",
    width: 1280,
    height: 960,
    bytes: 3,
  };

  it("带图 ⇒ user 行的 payload.image 整份落库，content 是纯文本（图不进 content）", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport({ text: "好", toolCalls: [] });
    await run({ transport, session }, { userText: "算餐饮", image: IMG });

    const row = appended.find((r) => r.role === "user")!;
    // 杀手：把 `prepareConversation` 的第四个参数去掉（不传 payload）⇒ 这条红
    expect(row.payload).toEqual({ image: IMG });
    // §4.1：content 仍是**纯文本**（用户那句文字），绝不是内容块数组
    expect(row.content).toBe("算餐饮");
    expect(typeof row.content).toBe("string");
  });

  it("无图 ⇒ user 行**连 payload 键都不出现**（老路径逐字不变）", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport({ text: "好", toolCalls: [] });
    await run({ transport, session }, { userText: "上个月花了多少" });

    const row = appended.find((r) => r.role === "user")!;
    // 杀手：把 payload 一律写成 `{ image: undefined }` ⇒ 这条红（会往库里塞一个坏 JSON 键）
    expect("payload" in row).toBe(false);
    expect(row.content).toBe("上个月花了多少");
  });
});

describe("M4 §8：上游 400 的文案（带图那一轮换成带前提的「可能不支持图片」）", () => {
  const IMG: ImageAttachment = {
    mime: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,QUJD",
    width: 1280,
    height: 960,
    bytes: 3,
  };

  it("带图 + 上游 400 ⇒ 这条没发出去：若带了截图，可能是当前模型不支持图片，试试先用文字描述。", async () => {
    const { transport } = failTransport({ ok: false, failure: { kind: "bad_request" } });
    const turn = await run({ transport }, { userText: "算餐饮", image: IMG });
    // 杀手：把 `IMAGE_UNSUPPORTED_TEXT` 换回 `describeFailure(...)` ⇒ 这条红
    expect(turn.text).toBe("这条没发出去：若带了截图，可能是当前模型不支持图片，试试先用文字描述。");
  });

  // 🔴 规格 §8 的措辞要求：`bad_request` **证明不了**原因是图（畸形 body / 非法参数同样落这个
  // kind）⇒ 猜测必须**显式标成猜测**，不能写成断言。若要它红：把文案改回旧的无前提写法
  // 「当前模型可能不支持图片，试试先用文字描述」。
  it("文案带前提：含「若带了截图」（不是在断言一件我们没验证过的事）", async () => {
    const { transport } = failTransport({ ok: false, failure: { kind: "bad_request" } });
    const turn = await run({ transport }, { userText: "算餐饮", image: IMG });
    expect(turn.text).toContain("若带了截图");
    expect(turn.text).toContain("试试先用文字描述"); // 可操作的下一步必须还在
  });

  it("**不带图**的 400 ⇒ 一个字都不变（仍是 M2 映射的原文案）", async () => {
    const { transport } = failTransport({ ok: false, failure: { kind: "bad_request" } });
    const plain = await run({ transport }, { userText: "上个月花了多少" });
    // 杀手：把判据写成"只判 failure.kind"（漏掉 `image !== undefined`）⇒ 这条红
    // （会把所有 400 的提示都换成"不支持图片"，与截图毫无关系的那一轮也开始胡说话）
    expect(plain.text).not.toBe("这条没发出去：若带了截图，可能是当前模型不支持图片，试试先用文字描述。");
    expect(plain.text).toBe("这条消息没能发出去，换个说法试试。");
  });

  it("带图但不是 400（例如超时）⇒ 仍走 M2 的原映射（这处改动只覆盖 bad_request）", async () => {
    const { transport } = failTransport({ ok: false, failure: { kind: "timeout" } });
    const turn = await run({ transport }, { userText: "算餐饮", image: IMG });
    expect(turn.text).toBe("AI 分析超时了，请重试。");
  });
});

describe("隐私与边界", () => {
  it("发出去的 messages 里不出现任何 id（工具已经剥过，agent 不再加回来）", async () => {
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "共 {{q1.total}} 元。", toolCalls: [] },
    );
    await run({ transport });

    const all = JSON.stringify(calls);
    for (const id of ["cat-1", "acc-1", "tag-1", "u1"]) {
      expect(all).not.toContain(id);
    }
    expect(all).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("工具结果消息里带 tool_call_id（M2 的扁平契约要求回应每个 call）", async () => {
    const { transport, calls } = scriptedTransport(
      { text: "", toolCalls: [CALL_QUERY] },
      { text: "好", toolCalls: [] },
    );
    await run({ transport });
    const tool = calls[1]!.find((m) => m.role === "tool")!;
    expect(tool.tool_call_id).toBe("c1");
    // assistant 那条要把**扁平**的 tool_calls 原样回传（不要 function 嵌套）
    const assistant = calls[1]!.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toEqual([{ id: "c1", name: "query_transactions", arguments: CALL_QUERY.arguments }]);
  });
});
