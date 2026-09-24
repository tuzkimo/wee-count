// src/services/ai/__tests__/agent.noDraftNotice.test.ts
//
// G3「文案说真话」的补丁（真机缺陷：**上一轮失败后，下一个草稿不弹卡片**）。
//
// 卡片只认 `turn.drafts`（`AiChatPage.vue:57-69`），而「已生成草稿，请确认」是**话术** ——
// prompt 与草稿工具的返回正文都明确教模型这么写（`tools.ts` 的 DRAFT_TOOL 结果）。于是一轮里
// 草稿工具**报错**、本轮没有任何草稿时，模型照样回「已生成草稿，请确认」：用户看到"说有草稿"、
// 等不到卡片，只能再催一句（下一轮模型重试、这次调通 ⇒ 卡片才出现）。
//
// 判据是**结构**（工具 trace 里 `DRAFT_TOOL` 且 `ok:false` + 本轮草稿数 0），不是去匹配模型那句
// 话：文本匹配既漏报（换个说法就不认）又会误伤。判定落在编排层（文案与判据都在这里），
// store 只负责把 `turn.noDraftNotice` 渲染成**另起**的一条消息。
//
// 本文件**不 mock 任何东西**：真编排 + 真工具（`lookup` 直接注入，用不到 DB），
// 只把 transport 换成按脚本回的假实现 —— 要钉的正是"模型的话术 vs 工具的真相"这对关系。
import { describe, it, expect, vi } from "vitest";
import type { ChatMessage, ChatOutcome, Transport } from "@/services/ai/transport";
import type { LedgerSnapshot } from "@/services/ai/prompt";
import type { LookupContext } from "@/services/ai/resolve";
import {
  CLARIFY_FAILURE_TEXT,
  NO_DRAFT_NOTICE_TEXT,
  draftToolFailed,
  runAgent,
} from "@/services/ai/agent";
import { DRAFT_TOOL } from "@/services/ai/toolNames";

const LEDGER = "L1";

const SNAPSHOT: LedgerSnapshot = {
  kind: "personal",
  categories: [{ name: "买菜", type: "expense" }],
  accounts: [{ name: "招行", type: "银行卡" }],
  tags: [],
  members: [{ name: "我" }],
};
const LOOKUP: LookupContext = {
  categories: [{ id: "cat-1", name: "买菜", type: "expense" }],
  accounts: [{ id: "acc-1", name: "招行" }],
  tags: [],
  members: [],
};

type Call = { id: string; name: string; arguments: string };
type Reply = { text: string; toolCalls: Call[] };

/** 草稿工具**成功**（账户名对得上 `LOOKUP`） */
const CALL_DRAFT_OK: Call = {
  id: "c1",
  name: DRAFT_TOOL,
  arguments: JSON.stringify({ type: "expense", amount: 128, category: "买菜", fromAccount: "招行" }),
};
/** 草稿工具**失败**：账户名在账本里找不到（`resolveDraftNames` 回 ok:false、回喂给模型一次） */
const CALL_DRAFT_BAD: Call = { ...CALL_DRAFT_OK, arguments: JSON.stringify({ ...JSON.parse(CALL_DRAFT_OK.arguments), fromAccount: "并不存在的账户" }) };

/** 模型在工具报错后照样说的那句（prompt 教的话术） */
const CLAIM: Reply = { text: "已生成草稿，请确认", toolCalls: [] };

function scriptedTransport(...replies: Reply[]) {
  let i = 0;
  const chat = vi.fn(
    async (_messages: ChatMessage[], _tools: unknown[], _signal: AbortSignal): Promise<ChatOutcome> => {
      const reply = replies[i++];
      if (reply === undefined) throw new Error(`假 transport 只有 ${replies.length} 条脚本，却被调了第 ${i} 次`);
      return { ok: true, reply: { text: reply.text, toolCalls: reply.toolCalls, finishReason: "stop" } };
    },
  );
  return { transport: { chat } as Transport, chat };
}

async function run(...replies: Reply[]) {
  const { transport } = scriptedTransport(...replies);
  return await runAgent({
    userText: "记一笔 128 的菜",
    ledgerId: LEDGER,
    snapshot: SNAPSHOT,
    lookup: LOOKUP,
    deps: { transport },
    signal: new AbortController().signal,
  });
}

/** 一个"只调工具、不说话"的模型回复（脚本里的每一轮都是一条 `Reply`） */
const toolCall = (call: Call): Reply => ({ text: "", toolCalls: [call] });

/**
 * 假会话（单测默认不落库；要断言"提示也写进会话"时必须注入它）。
 * 形状照 `agent.test.ts:182-206`：只实现 `runAgent` 真正用到的那四个方法。
 */
function fakeSession() {
  const appended: Record<string, unknown>[] = [];
  const session = {
    ensureConversation: vi.fn(async (ledgerId: string) => `conv-${ledgerId}`),
    recentTurns: vi.fn(async (_convId: string, _n?: number) => []),
    appendMessage: vi.fn(async (row: Record<string, unknown>) => {
      appended.push(row);
      return true;
    }),
    setTitleIfEmpty: vi.fn(async (_convId: string, _text: string) => undefined),
  };
  return { session, appended };
}

describe("草稿工具报错、本轮没有草稿 ⇒ 客户端要另起一句确定性提示", () => {
  it("① 模型说「已生成草稿，请确认」但本轮 drafts 为空（trace 里工具 ok:false）⇒ 出提示", async () => {
    const turn = await run(toolCall(CALL_DRAFT_BAD), CLAIM);

    // 改哪一行能让它红：删掉 `buildTurn` 里那个 `...(!aborted && state.drafts.length === 0 &&
    // draftToolFailed(trace) …)` ⇒ `noDraftNotice` 变 undefined，下面第一条断言红。
    expect(turn.noDraftNotice).toBe(NO_DRAFT_NOTICE_TEXT);
    // 前提不能省：这一轮**确实**没有草稿、工具确实报过错（否则上面那条是空转通过）
    expect(turn.drafts.length).toBe(0);
    expect(draftToolFailed(turn.trace)).toBe(true);
    // 模型那句话**原样留着**：提示是另起的一条，不改历史（改了就等于篡改模型输出）
    expect(turn.text).toBe("已生成草稿，请确认");
  });

  it("② 同一轮后来真生成了草稿（先失败后成功）⇒ 不补提示，卡片照常出现", async () => {
    const turn = await run(toolCall(CALL_DRAFT_BAD), toolCall(CALL_DRAFT_OK), CLAIM);

    expect(turn.drafts.length).toBe(1);
    // trace 里那条 ok:false **还在**（它是历史）—— 判据不是"trace 干净"，而是"这一轮有草稿"
    expect(draftToolFailed(turn.trace)).toBe(true);
    expect(turn.noDraftNotice).toBeUndefined();
  });

  it("③ 没有草稿工具失败（纯回答那一轮）⇒ 不补提示", async () => {
    const turn = await run({ text: "这个月一共花了 128 元。", toolCalls: [] });

    expect(turn.noDraftNotice).toBeUndefined();
    expect(turn.text).toBe("这个月一共花了 128 元。");
  });

  it("④ 纠错额度用尽时的收尾文案自己就是实话（CLARIFY_FAILURE_TEXT）⇒ 不叠第二句", async () => {
    const turn = await run(toolCall(CALL_DRAFT_BAD), toolCall(CALL_DRAFT_BAD));

    expect(turn.text).toBe(CLARIFY_FAILURE_TEXT);
    expect(turn.noDraftNotice).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 真机补丁（2026-09-24 实机证据）：模型**压根没调**草稿工具，却照着 prompt 的话术回
  // 「已生成草稿，请确认：支出 20 元…」。
  //
  // 库里那一轮的 payload 逐字是：`{"chips":[],"drafts":[],"refs":{},"trace":[],"promptVersion":1}`
  // （真机会话 `3f0adab6-…db`，2026-09-24T05:43:41.907Z = 13:43:41 +0800）—— **零工具调用**，
  // 正文里的"20 元"还是字面量（有 ref 的成功轮写的是 `{{q1.amount}}`）。
  //
  // `draftToolFailed(trace)` 要求 trace 里**存在**草稿工具且 `ok:false` ⇒ 空 trace 时恒 false，
  // 9f251ff 的判据**覆盖不到这一形态**（用户看着"说有草稿"、消息流里却没有卡）。
  // -------------------------------------------------------------------------

  it("⑤ 模型没调工具却宣称「已生成草稿」⇒ 照样补提示（判据是结构事实，不是工具失败）", async () => {
    const turn = await run(CLAIM);

    // 前提：这一轮**零**工具调用（正是真机那一轮的形态）
    expect(turn.trace).toEqual([]);
    expect(turn.drafts).toEqual([]);
    expect(draftToolFailed(turn.trace)).toBe(false);
    // 改哪一行能让它红：把 `buildTurn` 的判据退回 `draftToolFailed(trace)` ⇒ 这条 undefined
    expect(turn.noDraftNotice).toBe(NO_DRAFT_NOTICE_TEXT);
    // 模型那句话仍然原样留着（提示是另起的一条）
    expect(turn.text).toBe("已生成草稿，请确认");
  });

  it("⑥ 同一轮真有草稿时，同样的话术**不**触发提示（防误伤）", async () => {
    const turn = await run(toolCall(CALL_DRAFT_OK), CLAIM);

    expect(turn.drafts.length).toBe(1);
    expect(turn.noDraftNotice).toBeUndefined();
  });

  it("⑦ 提示要**落进会话**（另起一条 assistant 消息）——下一轮模型才知道「这一轮没有草稿」", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport(CLAIM);
    await runAgent({
      userText: "记一笔 20 的粉",
      ledgerId: LEDGER,
      snapshot: SNAPSHOT,
      lookup: LOOKUP,
      deps: { transport, session },
      signal: new AbortController().signal,
    });

    // 一条 user + 一条 assistant（模型那句）+ 一条 assistant（客户端的事实提示）
    const roles = appended.map((row) => row.role);
    expect(roles).toEqual(["user", "assistant", "assistant"]);
    expect(appended[1]!.content).toBe("已生成草稿，请确认");
    // 改哪一行能让它红：删掉 `persistAssistant` 里那次 `persistMessage(p, "assistant", NO_DRAFT_NOTICE_TEXT)`
    expect(appended[2]!.content).toBe(NO_DRAFT_NOTICE_TEXT);
    // 提示那条**不带 payload**（没有 chips/drafts/trace 可带，也不该被草稿决定的 UPDATE 命中）
    expect(appended[2]!.payload).toBeUndefined();
  });

  it("⑧ 纯查询轮（没有草稿、也没宣称草稿）⇒ 不写提示那条消息", async () => {
    const { session, appended } = fakeSession();
    const { transport } = scriptedTransport({ text: "这个月一共花了 128 元。", toolCalls: [] });
    await runAgent({
      userText: "这个月花了多少",
      ledgerId: LEDGER,
      snapshot: SNAPSHOT,
      lookup: LOOKUP,
      deps: { transport, session },
      signal: new AbortController().signal,
    });

    expect(appended.map((row) => row.role)).toEqual(["user", "assistant"]);
  });
});
