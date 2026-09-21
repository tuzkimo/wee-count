// 编排循环（规格 §5.2）：文字进 → 工具调 → 最终文本出。
//
// 本模块**没有自己发明失败话术**：所有面向用户的话都来自三条既有来源，避免第二份真相 ——
//   ① transport 的 `describeFailure`（§5.3 的错误矩阵文案表）
//   ② tools 的错误字符串（回喂给模型、让它改一次）
//   ③ 本文件四个常量（轮数用尽 / 纠错用尽 / 本地库不可用 / **带图那一轮的 400**）
//      —— 前三个**不是** §5.3 的错误矩阵，所以不放进 `describeFailure`（那里是"后端/网络"的
//      话术，混进去会让 UI 分不清该不该重试）；第四个是 §8 明写的一行文案，判据沿用 M2 的
//      `bad_request` 分类（**不新增错误码**），只在"这一轮带了图"时覆盖它。
//
// 四条硬约束（各有一条能红的用例，见 agent.test.ts）：
//   1. **轮数上限 6**（§5.2）：用尽时给"建议 + 手动筛选"，是**收尾**不是错误气泡。
//   2. **纠错恰好 1 次**：工具返回 `{ok:false}` ⇒ 把错误回喂给模型一次，再失败就给人话。
//   3. **取消不产生错误气泡**（§5.2 / §5.3）：靠 transport 那个 `cancelled` 分类，不靠
//      `signal.aborted` 猜（用户在途取消时 `apiFetch` 会把它压成 `status:0`，分不出来）。
//   4. **有界上下文**（§4.5）：每轮请求 = system + 最近 3 轮 user/assistant 文本 + 本轮 user
//      + 本轮的工具往返。**历史 tool 结果不进下一轮**（全量回放 tool 结果会让 token 膨胀，
//      而历史结论已经写在 assistant 文本里）。M4 起"本轮 user"可能是**内容块数组**（带图，
//      §4.2），但**历史里的图不重发**：`session.buildContext` 已把它换成占位文本（§4.3）。
//
// ⚠️ 两处"看着像多余、其实是边界"的地方：
//   - `snapshot` 与 `lookup` 都要：`buildSystemPrompt` 只要**名字+类型**（§7.1 刻意不给 id），
//     而工具解析需要 id ⇒ 两者形状不同，不能互相派生。
//   - `lookup` 可注入：不传时由本层调 `buildLookupContext`。它**只在 DB 为 null 时**回空表，
//     真库异常会**抛**（Ruling 21 刻意如此）⇒ 必须由这里按 §5.3 收下，别让它冒到 store。
//   - **成员表本层永远补不出来**：`snapshot.members` 只有名字（§7.1 不给 id），而
//     `buildLookupContext` 的第二个参数正是"名字 → 解析表 id"的映射 ⇒ 本层**没有**真 id 可传，
//     只能传空（见 `runAgent` 里那段注释）。真 id 由调用方经 `members` 注入（生产是 store，
//     它从本地 `team_members` / `member_aliases` 读），拿不到就由工具层**响亮失败**。
import {
  buildSystemPrompt,
  fillRefs,
  PROMPT_VERSION,
  type LedgerSnapshot,
} from "@/services/ai/prompt";
import {
  buildLookupContext,
  executeTool,
  type ToolContext,
  type ToolOutcome,
} from "@/services/ai/tools";
import { TOOLS } from "@/services/ai/tools";
import {
  describeFailure,
  type ChatMessage,
  type ChatToolCall,
  type ContentBlock,
  type Transport,
  type TransportFailure,
} from "@/services/ai/transport";
import {
  imagePlaceholderText,
  type AiMessagePayload,
} from "@/services/ai/session";
// ⚠️ **只借类型**：`import type` 不会把 imageInput 那份实现（它 import 两个 Tauri 插件）
// 拉进编排层的运行时 —— 本层要的只是"那张图的形状"（dataUrl / 尺寸 / 字节数）。
import type { ImageAttachment } from "@/services/ai/imageInput";
import type { LookupContext, LookupMember } from "@/services/ai/resolve";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 编排循环的轮数上限（§5.2）。正常路径 2 轮；再多说明模型在绕圈 */
export const ROUND_LIMIT = 6;

/** 工具的纠错额度：**恰好一次**（§5.2「DSL 校验失败允许纠错 1 次」） */
export const MAX_TOOL_CORRECTIONS = 1;

/** 轮数用尽时的收尾（§5.3「达到轮数上限：给一条替代建议 + 提示可手动筛选」）——**不是**错误 */
export const ROUND_LIMIT_TEXT =
  "这个问题要查的步骤有点多，我先停在这里。可以试试把条件说得更具体一点（比如带上时间范围或分类），也可以直接在流水页用筛选看明细。";

/** 纠错额度用尽（§5.3「DSL 校验失败（纠错后仍失败）」） */
export const CLARIFY_FAILURE_TEXT = "我没理解这个请求，换个说法试试。";

/** 本地库不可用 / 本地查询异常（§5.3「工具执行异常（DB 错）：记 console，回一条通用失败消息」） */
export const DB_FAILURE_TEXT = "本地数据出了点问题，这次没能查。稍后再试试。";

/**
 * §8「上游 400（模型不支持视觉等）」的文案（M4）。
 *
 * **不是新错误码**：判据仍是 M2 既有的 `bad_request` 分类，只是"这一轮带了图"时把它换成
 * 一句用户能自救的话（"先用文字描述"）—— 供应商的视觉支持参差，400 是最常见的表现。
 * ⚠️ **不带图的 400 一个字都不变**（仍走 `describeFailure` 的原文案）：这处改动只覆盖
 * "带图那一轮"，别把 400 的通用提示悄悄换掉（`agent.test.ts` 有一条用例专钉这一点）。
 *
 * ⚠️ 措辞必须**带前提**（「若带了截图」）：`bad_request` 只说"这个请求没被接受"，
 * 它**证明不了**原因是图 —— 畸形 body、非法参数都会落到同一个 kind。旧写法
 * （"当前模型可能不支持图片，…"）把猜测说成了断言，是在告诉用户一件我们没验证的事。
 * 新写法保留可操作的下一步，同时把猜测**显式标成猜测**（规格 §8 与本常量逐字一致）。
 */
export const IMAGE_UNSUPPORTED_TEXT = "这条没发出去：若带了截图，可能是当前模型不支持图片，试试先用文字描述。";

/**
 * 取消时**不该**渲染的文案。
 *
 * §5.3 的错误矩阵里没有"取消"这一行：§5.2 说取消是"掐掉在途请求、丢弃结果" ⇒ 不产生任何
 * 消息。这个常量只用于让 `describeFailure` 的 switch 穷尽（以及万一被渲染也给人话），
 * **agent 不会把它写进消息流** —— 用例 `appended.some(r => r.content === CANCELED_TEXT)`
 * 钉着这一点。
 */
export const CANCELED_TEXT = "这次提问已取消。";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 落库会话的接口子集（`session.ts` 结构上满足它；单测注入假实现） */
export interface AgentSession {
  ensureConversation(ledgerId: string, now: Date): Promise<string | null>;
  recentTurns(
    conversationId: string,
    n?: number,
  ): Promise<{ role: "user" | "assistant"; content: string }[]>;
  appendMessage(
    row: {
      id: string;
      conversation_id: string;
      role: "user" | "assistant";
      content: string;
      created_at: string;
      payload?: AiMessagePayload;
    },
  ): Promise<boolean>;
  setTitleIfEmpty(convId: string, text: string): Promise<void>;
}

export interface AgentDeps {
  transport: Transport;
  /** 不传 = 不落库（单测默认）。生产由 store 传 `session.ts` 的那一组函数 */
  session?: AgentSession;
  now?: () => Date;
}

export interface AgentTurn {
  /** 已回填真值的回答文本（**不落库**：落库的是占位符原文） */
  text: string;
  chips: unknown[];
  drafts: unknown[];
  /** 扁平键（`"q1.total"`）→ 真值（修正第 12 条） */
  refs: Record<string, string>;
  trace: { round: number; name: string; ok: boolean; note?: string }[];
  aborted: boolean;
}

export interface RunAgentArgs {
  userText: string;
  /**
   * 这一轮带的截图（M4 §4.2）。三件事都由它决定：
   *  1. 发给模型的**当前轮** content 从字符串变成内容块数组（`userContent`）；
   *  2. 落库那条 user 消息的 `payload.image`（§4.1 —— content 仍是纯文本 `userText`）；
   *  3. 上游 400 的文案（§8：带图那一轮的 400 多半是"模型不支持视觉"）。
   * ⚠️ **历史里的图不重发**（§4.2）：它只影响"本轮"与"本次落库"，`history` 里的图
   * 早在 `session.buildContext` 就被替换成占位文本了。
   */
  image?: ImageAttachment;
  ledgerId: string;
  snapshot: LedgerSnapshot;
  /**
   * 整张查找表都注入时用这个：本层**不碰 DB**（单测与将来的调用方都能完全接管）。
   * 不传时由本层调 `buildLookupContext`（它的真库异常按 §5.3 收下）。
   */
  lookup?: LookupContext;
  /**
   * 成员表（**真 id 只能来自本地库**）。只在 `lookup` 不传时用于组装默认查找表。
   *
   * 不传 = 本层没有成员身份信息（`buildLookupContext` 的成员表为空）⇒ 依赖成员的查询
   * 会在工具层**响亮失败**，绝不伪造 id 去查（伪造的表现是"小明这个月花了 0 元"这种静默错答案）。
   */
  members?: LookupMember[];
  deps: AgentDeps;
  signal: AbortSignal;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 回给模型的工具结果文本上限：模型只需要"错在哪"，不需要整份 JSON 塞满上下文 */
const MAX_TOOL_NOTE_CHARS = 2000;

/**
 * `RunAgentArgs.members`（`{id, name}`）→ `buildLookupContext` 的入参形状（`{userId, name}`）。
 *
 * ⚠️ 这两者**必须逐字段显式转**：直接传 `{id, name}` 进去，`m.userId` 会是 `undefined`，
 * 于是解析表里躺着一个 `id: undefined` 的成员 —— 名字能解析、SQL 却拿它去比 `user_id`
 * （真库里就是 NULL 比较）⇒ 又是一次"静默 0 行"。类型门会先报 TS2345，这行转换是它的落地。
 */
function memberRows(members: LookupMember[]): { userId: string; name: string }[] {
  return members.map((m) => ({ userId: m.id, name: m.name }));
}

function truncateForModel(text: string): string {
  return text.length > MAX_TOOL_NOTE_CHARS ? `${text.slice(0, MAX_TOOL_NOTE_CHARS)}…（已截断）` : text;
}

function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i === -1 ? text : text.slice(0, i);
}

/** 判定"这次失败是用户取消"。靠 transport 给的分类，不靠 `signal.aborted` 猜 */
function isCanceled(outcome: { ok: false; failure: TransportFailure }): boolean {
  return outcome.failure.kind === "cancelled";
}

/**
 * 当前轮 user 消息的 content（§4.2 的三态，**唯一的组装点**）。
 *
 *  - **无图 ⇒ 字符串**（M1–M3 老路径逐字不变 ⇒ 老路径零回归）
 *  - **有图无文字 ⇒ 只一块 `image_url`**（空 `text` 块在部分供应商上会被判非法）
 *  - **有图有文字 ⇒ `[{type:"text"},{type:"image_url"}]`**（text 在前：顺序即语义）
 *
 * ⚠️ 判据是 `image === undefined`，不是 `text === ""`：用户"只发一张图、一个字不写"是
 * §4.2 明确支持的形态（那条 content 是空串，但**必须**发出去）。
 */
function userContent(text: string, image: ImageAttachment | undefined): string | ContentBlock[] {
  if (image === undefined) return text;
  const block: ContentBlock = { type: "image_url", image_url: { url: image.dataUrl } };
  return text === "" ? [block] : [{ type: "text", text }, block];
}

/**
 * 每轮请求的 messages（§4.5 的有界上下文）。
 *
 * `history` 只含**落库的 user/assistant 文本**（`recentTurns` 已经只取这两类），
 * `roundMessages` 只含**本轮**的 assistant(tool_calls) + tool 结果。
 * ⇒ 历史 tool 结果永远不会出现在下一轮的请求里。
 *
 * `userContent` 是本轮那条 user 消息的 content：**字符串或内容块数组**（§4.2 三态，
 * 由 `userContent()` 组装）。历史那几条**永远是字符串** —— 带图的历史已经被替换成
 * 占位文本（§4.3），图不重发。
 */
function buildMessages(
  system: string,
  history: { role: "user" | "assistant"; content: string }[],
  userContent: string | ContentBlock[],
  roundMessages: ChatMessage[],
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  for (const turn of history) messages.push({ role: turn.role, content: turn.content });
  messages.push({ role: "user", content: userContent });
  for (const m of roundMessages) messages.push(m);
  return messages;
}

/**
 * 本轮那条 user 消息在**历史里**会呈现成的文本 —— `withoutTrailingDuplicate` 的比较对象。
 *
 *  - 无图轮 ⇒ 原文（`recentTurns` 原样返回，M1–M3 逐字不变）
 *  - 带图轮 ⇒ `imagePlaceholderText(userText)`：`recentTurns` 出来的历史已经过 §4.3 的
 *    占位替换，库里那行在原位长成这样
 *
 * ⚠️ 比较对象**必须**是"历史里那个样子"，不能是 `userText` 原文：带图轮拿原文比
 * `last.content === userText` **永远为假** ⇒ 去重静默失效（连点两次发送会把同一轮发两遍，
 * 而"最近 3 轮"实际只剩 2 轮 —— 不报错、不抛，只是上下文悄悄变样）。
 * 无图轮两者相等，所以老路径行为逐字不变。
 */
function contextText(userText: string, image: ImageAttachment | undefined): string {
  return image === undefined ? userText : imagePlaceholderText(userText);
}

/**
 * `recentTurns` 是**在本轮 user 落库之前**读的，所以正常不会含本轮。
 * 但"用户连点两次发送"或 store 先落库的形态下它可能已含 ⇒ 去掉尾部重复的本轮消息，
 * 否则本轮会问两遍、且"最近 3 轮"实际只剩 2 轮。
 *
 * ⚠️ 与它比较的**只能是文本**（`contextText` 算出来的那份），**绝不能**是本轮那份 content
 * （带图时是块数组）：库里那行 user 消息的 `content` 就是纯文本（§4.1），拿块数组去比 `===`
 * **永远为假** ⇒ 去重会**静默失效**。带图轮还要再往前一步：它的历史已被 §4.3 替换成
 * 占位文本 ⇒ 拿 `userText` 原文比同样永远为假（同一个坑的第二种走法）。
 */
function withoutTrailingDuplicate(
  turns: { role: "user" | "assistant"; content: string }[],
  contextText: string,
): { role: "user" | "assistant"; content: string }[] {
  const last = turns[turns.length - 1];
  if (last !== undefined && last.role === "user" && last.content === contextText) {
    return turns.slice(0, -1);
  }
  return turns;
}

// ---------------------------------------------------------------------------
// 一回合之内：工具执行
// ---------------------------------------------------------------------------

interface RoundReport {
  roundMessages: ChatMessage[];
  chips: unknown[];
  drafts: unknown[];
  refs: Record<string, string>;
  failed: { name: string; error: string } | null;
  traceEntries: { round: number; name: string; ok: boolean; note?: string }[];
}

/**
 * 执行本轮的全部工具调用。
 *
 * - `refIndex` 是**跨调用单调递增**的序号（`ToolContext.refIndex`）：`q1`/`q2`… 的编号
 *   必须与模型在 prompt 里学到的规则一致 —— 每轮从 1 重新开始会让 `{{q1.total}}` 指向
 *   两个不同的数字。
 * - `failed` 只保留**第一个**失败：纠错额度用尽时给用户的那句话不因有几个工具而变。
 * - 成功的 outcome 其 `refs`/`payload` 立刻并进本轮账（`payload.refs` 是渲染回填的唯一真源）。
 */
async function runToolRound(
  toolCalls: ChatToolCall[],
  ctxBase: { ledgerId: string; lookup: LookupContext; now: Date },
  round: number,
  refIndexStart: number,
  state: { chips: unknown[]; drafts: unknown[]; refs: Record<string, string> },
): Promise<RoundReport> {
  const report: RoundReport = {
    roundMessages: [],
    chips: [],
    drafts: [],
    refs: {},
    failed: null,
    traceEntries: [],
  };
  const results: ChatMessage[] = [];
  let refIndex = refIndexStart;

  for (const call of toolCalls) {
    const ctx: ToolContext = { ...ctxBase, refIndex };
    refIndex++;
    const outcome = await executeTool(call.name, call.arguments, ctx);
    if (outcome.ok) {
      collectOutcome(outcome, state, report);
      report.traceEntries.push({ round, name: call.name, ok: true });
      results.push({ role: "tool", tool_call_id: call.id, content: truncateForModel(outcome.content) });
      continue;
    }
    report.traceEntries.push({ round, name: call.name, ok: false, note: firstLine(outcome.error) });
    if (report.failed === null) report.failed = { name: call.name, error: outcome.error };
    // 错误也要回给模型：这正是"一次纠错"的输入（§4.3 的两条纠错路径都靠它）
    results.push({ role: "tool", tool_call_id: call.id, content: outcome.error });
  }

  // assistant 那条要把**扁平**的 tool_calls 原样回传（M2 契约第 1 条：客户端两个方向
  // 都只用扁平形状）。逐字段取值而不是 `{...call}`：将来 `ChatToolCall` 上多一个字段时，
  // 展开会把它顺手发给服务端，而契约只有这三个键。
  report.roundMessages.push({
    role: "assistant",
    content: "",
    tool_calls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
  });
  for (const r of results) report.roundMessages.push(r);
  return report;
}

function collectOutcome(
  outcome: Extract<ToolOutcome, { ok: true }>,
  state: { chips: unknown[]; drafts: unknown[]; refs: Record<string, string> },
  report: RoundReport,
): void {
  for (const [key, value] of Object.entries(outcome.refs)) {
    // 扁平键（`"q1.total"`）。`payload.refs` 的类型是 `Record<string, string>`，
    // 而 `fillRefs` 收 `string | number` ⇒ 这里统一成 String（回填时还会 String() 一次）。
    state.refs[key] = String(value);
    report.refs[key] = String(value);
  }
  if (typeof outcome.payload !== "object" || outcome.payload === null) return;
  const payload = outcome.payload as { chips?: unknown[]; drafts?: unknown[] };
  if (Array.isArray(payload.chips)) {
    state.chips.push(...payload.chips);
    report.chips.push(...payload.chips);
  }
  if (Array.isArray(payload.drafts)) {
    state.drafts.push(...payload.drafts);
    report.drafts.push(...payload.drafts);
  }
}

// ---------------------------------------------------------------------------
// 结果构造
// ---------------------------------------------------------------------------

function emptyTurn(): AgentTurn {
  return { text: "", chips: [], drafts: [], refs: {}, trace: [], aborted: false };
}

// ---------------------------------------------------------------------------
// 落库
// ---------------------------------------------------------------------------

interface Persist {
  conversationId: string | null;
  now: Date;
  session: AgentSession | undefined;
}

/** 写一条消息；`session` 缺省（单测默认）时是 no-op。绝不抛。 */
async function persistMessage(
  p: Persist,
  role: "user" | "assistant",
  content: string,
  payload?: AiMessagePayload,
): Promise<boolean> {
  if (p.session === undefined || p.conversationId === null) return true;
  try {
    return await p.session.appendMessage({
      id: crypto.randomUUID(),
      conversation_id: p.conversationId,
      role,
      content,
      created_at: p.now.toISOString(),
      ...(payload === undefined ? {} : { payload }),
    });
  } catch (e) {
    // session 层自己已经 try/catch（它保证不抛），这里是"契约被改坏"的兜底：
    // 一条消息写不进去不该让整轮对话消失。
    console.warn("[ai/agent] appendMessage 抛出（session 层契约是永不抛）：", e);
    return false;
  }
}

/**
 * 准备会话：往**当前会话**写本轮 user 消息 + 补标题。
 *
 * ⚠️ 本函数**不自己 `ensureConversation`**：会话 id 由 `runAgent` 在读历史之前就保证了
 * （那里每轮先 ensure —— 它会**复活**软删会话行；清空会话后继续说话，消息否则会落进
 * `is_deleted=1` 的行里，写得进、读不出）。这里再 ensure 一次的话，`ledgerId`/`now` 与
 * 同一 tick 内的库状态都与第一次完全相同 ⇒ **结果必然与第一次相同**（实测：删掉它聚焦测试全绿，
 * 整块换成一行 null 判断也全绿）⇒ 是冗余，不是防线。
 *
 * 因此走到这里 `conversationId` 仍是 null，只可能是一次 ensure 就失败（抛 / 回 null）：
 * 翻译成"本地库不可用"。
 */
async function prepareConversation(
  p: Persist,
  userText: string,
  image?: ImageAttachment,
): Promise<"ok" | "db_error"> {
  if (p.session === undefined) return "ok";
  // 会话 id 由 runAgent 每轮先 ensure 保证 ⇒ 这里仍为 null 就是本地库不可用
  if (p.conversationId === null) return "db_error";

  // 首条 user 消息写完**立刻**补标题：`setTitleIfEmpty` 自己只认 title 是否为空，
  // 分不出"新会话"与"第二条消息" ⇒ 必须每条 user 消息后都调一次（修正第 10 条），
  // 否则 `title` 是死列（规格 §4.5 要求取首条用户消息前 20 字）。
  //
  // §4.1：截图**只进 payload**，`content` 仍是纯文本 `userText`（没写字就是空串）——
  // 图绝不进 content（content 是"面向模型/给用户看"的那一份，payload 才是本地结构化数据）。
  const written = await persistMessage(p, "user", userText, image === undefined ? undefined : { image });
  if (!written) return "db_error";
  try {
    await p.session.setTitleIfEmpty(p.conversationId, userText);
  } catch (e) {
    // 标题只是列表里的显示名，写失败不该毁掉这次提问
    console.warn("[ai/agent] setTitleIfEmpty 抛出：", e);
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * 跑一轮完整对话。**永不抛**：`try` 从**序言**第一行就开始覆盖（lookup / 建会话 / 读历史 /
 * `buildSystemPrompt` / 编排循环全在里面）⇒ 任何失败都变成一条等价的返回值（`text` 是给用户的
 * 话）并落进消息流，而不是冒到调用方。try 之外只剩对入参的两次纯取值（`deps.now()` 与
 * `signal.aborted`）。
 */
export async function runAgent(args: RunAgentArgs): Promise<AgentTurn> {
  const nowFn = args.deps.now ?? ((): Date => new Date());
  const now = nowFn();
  const persist: Persist = { conversationId: null, now, session: args.deps.session };

  // 取消前置检查放在**最前面**：取消意味着"丢弃结果"，连 user 消息都不该落库（§5.2）
  if (args.signal.aborted) {
    return { ...emptyTurn(), aborted: true };
  }

  // 账（chips/drafts/refs/trace）在 try **之前**声明：catch 也要能把"到目前为止"的账交回去
  const state = { chips: [] as unknown[], drafts: [] as unknown[], refs: {} as Record<string, string> };
  const trace: AgentTurn["trace"] = [];

  // ⚠️ try 必须从**序言**就覆盖：`buildSystemPrompt` 在快照缺字段时会直接抛 TypeError
  //    （`prompt.ts:68` 的 `s.categories.map`）。修复前 try 从循环才开始 ⇒ 那个 TypeError
  //    原样冒到调用方，而 docstring 却写着"永不抛"，且没有一条用例能红。
  try {
    // 名字查找表：不注入就走真实的 buildLookupContext（它的抛 ⇒ §5.3 的通用失败消息）。
    //
    // ⚠️ 成员表**只传 `args.members`，绝不凭空造 id**：这里的 `userId` 会被
    //    `buildLookupContext` 原样当成解析表的 `id`（`tools.ts` 的 `members:` 那一行），再经 `resolveFilter`
    //    进 SQL 的 `t.user_id IN (...)`（`querySql.ts:119-121`）。曾经这里传的是
    //    `member-${i}`（用**序号**冒充 id）⇒ 成员筛选恒 0 行、成员分组全叫「未知成员」，
    //    而且是**静默**答错（用户问"小明这个月花了多少"得到"0 元"）。
    //    `snapshot` 刻意只有名字（§7.1），真 id 只能来自本地库（`team_members` /
    //    `member_aliases`，且显示名要走 `useMemberInfo` —— 那是 Vue 侧的唯一实现，
    //    本层不依赖 Vue，也不许猜）⇒ 拿不到就交空表，让依赖成员的查询在工具层响亮失败。
    let lookup: LookupContext;
    try {
      lookup =
        args.lookup ??
        (await buildLookupContext(args.ledgerId, memberRows(args.members ?? [])));
    } catch (e) {
      console.warn("[ai/agent] buildLookupContext 失败：", e);
      return { ...emptyTurn(), text: DB_FAILURE_TEXT };
    }

    // 会话 + 历史必须在**落库 user 消息之前**读：否则本轮消息会把最老的一轮挤出"最近 3 轮"。
    // ⚠️ 顺序：先 ensureConversation（它会复活软删会话，下面写消息就落在活着的行里），
    //    再读历史，最后才写 user 消息 + 补标题（修正第 10 条）。
    //    ⚠️ 这次 ensure 是**唯一**一次：会话 id 由这里每轮保证，`prepareConversation` 不再自己 ensure。
    let history: { role: "user" | "assistant"; content: string }[] = [];
    if (persist.session !== undefined) {
      try {
        persist.conversationId = await persist.session.ensureConversation(args.ledgerId, now);
      } catch (e) {
        console.warn("[ai/agent] ensureConversation 抛出（session 层契约是永不抛）：", e);
      }
      if (persist.conversationId !== null) {
        try {
          history = await persist.session.recentTurns(persist.conversationId, 3);
        } catch (e) {
          // 读历史失败不是致命的（prompt 少一段上下文仍然能回答）
          console.warn("[ai/agent] recentTurns 失败：", e);
        }
      }
    }

    if ((await prepareConversation(persist, args.userText, args.image)) === "db_error") {
      return { ...emptyTurn(), text: DB_FAILURE_TEXT };
    }

    const system = buildSystemPrompt(args.snapshot, now);
    let roundMessagesForModel: ChatMessage[] = [];
    let refIndex = 1;
    let corrections = 0;

    for (let round = 1; round <= ROUND_LIMIT; round++) {
      if (args.signal.aborted) return { ...buildTurn(state, trace), aborted: true };

      const messages = buildMessages(
        system,
        // 去重拿**历史里那个样子**比（见 `withoutTrailingDuplicate` / `contextText` 的 ⚠️：
        // 块数组比会静默失效；带图轮拿 userText 原文比同样会）
        withoutTrailingDuplicate(history, contextText(args.userText, args.image)),
        userContent(args.userText, args.image),
        roundMessagesForModel,
      );
      const outcome = await args.deps.transport.chat(messages, TOOLS, args.signal);
      if (args.signal.aborted) return { ...buildTurn(state, trace), aborted: true };

      if (!outcome.ok) {
        // 用户的取消**不是**错误 ⇒ 不渲染任何消息（§5.2 的"丢弃结果"），返回 aborted
        if (isCanceled(outcome)) return { ...buildTurn(state, trace), aborted: true };
        // §8：带图那一轮的 400 多半是"模型不支持视觉" ⇒ 换成一句能自救的话；
        // 不带图的 400 **一个字都不变**（沿用 M2 既有映射，不新增错误码）。
        const text =
          args.image !== undefined && outcome.failure.kind === "bad_request"
            ? IMAGE_UNSUPPORTED_TEXT
            : describeFailure(outcome.failure);
        await persistMessage(persist, "assistant", text);
        return { ...buildTurn(state, trace), text };
      }

      const reply = outcome.reply;
      if (reply.toolCalls.length === 0) {
        // 收口：占位符在**最后一步**回填（§5.2 第 5 步）。落库的永远是原文。
        const text = fillRefs(reply.text, state.refs);
        await persistAssistant(persist, reply.text, state, trace);
        return { ...buildTurn(state, trace), text };
      }

      const roundReport = await runToolRound(reply.toolCalls, { ledgerId: args.ledgerId, lookup, now }, round, refIndex, state);
      refIndex += reply.toolCalls.length;
      trace.push(...roundReport.traceEntries);

      // 历史 tool 结果**不进**下一轮：`roundMessagesForModel` 每轮被整份替换
      roundMessagesForModel = roundReport.roundMessages;

      if (roundReport.failed !== null) {
        if (corrections >= MAX_TOOL_CORRECTIONS) {
          // 额度用尽：给用户一句人话（§5.3「DSL 校验失败（纠错后仍失败）」）
          await persistMessage(persist, "assistant", CLARIFY_FAILURE_TEXT);
          return { ...buildTurn(state, trace), text: CLARIFY_FAILURE_TEXT };
        }
        // 把错误**回喂给模型一次**：这一轮照常发出去，`roundMessagesForModel` 里已经带上 tool 结果
        corrections++;
      }
    }

    // 轮数用尽：这是**收尾**不是错误 ⇒ 给建议 + 提示可手动筛选（§5.3）
    await persistMessage(persist, "assistant", ROUND_LIMIT_TEXT);
    return { ...buildTurn(state, trace), text: ROUND_LIMIT_TEXT };
  } catch (e) {
    // 契约是"永不抛"：任何意外（含序言里的）都变成一条消息，而不是未捕获的 rejection
    console.warn("[ai/agent] 编排（含序言）意外抛出：", e);
    await persistMessage(persist, "assistant", DB_FAILURE_TEXT);
    return { ...buildTurn(state, trace), text: DB_FAILURE_TEXT };
  }
}

/**
 * 落 assistant 消息：`content` 是**占位符原文**，`payload` 带 chips/drafts/refs/trace（§4.5）+
 * `promptVersion`（§7.1:449：回答是哪版提示词问出来的，事后可查）。
 *
 * 写入点选在这里的唯一理由：**落库**的 payload 只在这一处产生（`appendTurn` 里那份是内存投影，
 * 两边都从 `PROMPT_VERSION` 同一个常量取，不会漂移）。
 */
async function persistAssistant(
  p: Persist,
  content: string,
  state: { chips: unknown[]; drafts: unknown[]; refs: Record<string, string> },
  trace: AgentTurn["trace"],
): Promise<void> {
  const payload: AiMessagePayload = {
    chips: state.chips,
    drafts: state.drafts,
    refs: state.refs,
    trace,
    promptVersion: PROMPT_VERSION,
  };
  await persistMessage(p, "assistant", content, payload);
}

/** 返回值里的 text 由调用方补（这里是"到目前为止"的账：chips/drafts/refs/trace） */
function buildTurn(
  state: { chips: unknown[]; drafts: unknown[]; refs: Record<string, string> },
  trace: AgentTurn["trace"],
): AgentTurn {
  return {
    text: "",
    chips: state.chips,
    drafts: state.drafts,
    refs: state.refs,
    trace,
    aborted: false,
  };
}
