// `/api/v1/ai/chat` 与 `/api/v1/ai/status` 的**协议转换层**（规格 §5.1 / §6.1）。
//
// 本文件的全部职责：把 M2 归一化后的响应变成 M3 的类型，把失败变成**值**。
//
// 三条纪律（各有独立的测试与杀手）：
// 1. **永不抛**：网络错、超时、取消、任何非 200，都返回 `{ok:false, failure}`。编排循环
//    （任务 5）要靠这个值把失败渲染成消息流里的一条 assistant 消息，一个冒出来的异常
//    会变成未捕获的 promise rejection。
// 2. **判别顺序是"先 status、再看 body 里的 `ai_` 前缀"**（M2 契约第 2 条）：M2 的
//    401 / 400 / 413 响应体里是**没有 `ai_` 前缀的直述消息**（`invalid or expired token` /
//    `invalid request body` / `request body too large`，见 `backend/internal/middleware/auth.go:33`
//    与 `handler/helpers.go:15-17`）。只看 body 里有没有码，会把这三类全判成"未知失败"。
//    ⚠️ 真判据是**前缀**，不是"body 不是 JSON"：401 走 `http.Error`，Content-Type 是
//    `text/plain` 但**内容是 JSON 文本** ⇒ `apiFetch` 的 `.json()` **能**解析出 `error`；
//    400/413 走 `writeError`，就是 `application/json`。
// 3. **`tool_calls` 是扁平形状 `{id, name, arguments}`**：客户端**两个方向**都只用这一种，
//    永远不写上游的嵌套 `{function:{name,arguments}}`（M2 契约第 1 条）。响应里出现嵌套
//    形状 = 服务端适配层坏了 ⇒ `invalid_response`，绝不"顺手兼容一下"：兼容等于让坏掉的
//    服务端继续工作，而我们会把 `undefined` 当工具名喂给 `executeTool`。
//
// ⚠️ 这里**没有**重写 401 的 refresh 单飞：那是 `apiFetch` 内建的（`api.ts:115-125`）。
// transport 重试一次 401 会与它叠加成"最多 4 次请求"，且破坏单飞的语义。
import { apiFetch } from "@/services/api";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/**
 * OpenAI 兼容的**内容块**（M4 截图那一轮用，§4.2）。只声明客户端会发出的两种：
 * `text`（用户那句话）与 `image_url`（截图的 dataUrl）。
 *
 * ⚠️ 这里只是**类型**：组块发生在 `agent.ts` 的编排层（`userContent`），transport
 * 一个字都不组装 —— 它只负责把 `messages` 序列化发出去（本文件顶部三条纪律不变）。
 *
 * 🔒 **这是线上契约的唯一一份定义**（请求体的 `content` 就长这样，后端当 JSON 哑管道透传）：
 * 谁都不许在别处再写一份等价联合类型（多一份＝多一个会跟上游悄悄漂移的地方）。
 * 别处需要它时一律 `import type { ContentBlock }`（type-only ⇒ 运行时不耦合）。
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * 一条对话消息。
 *
 * `tool_calls` 只在 assistant 消息上出现，形状与响应里收到的**逐字相同** —— 客户端把上一轮
 * 收到的那一份原样回传，服务端负责转成上游的嵌套形状（M2 契约第 1 条）。
 * 所以这里的类型只用 `ChatToolCall`，绝不会出现 `function: {...}`。
 *
 * `content` 是 `string | ContentBlock[]`（M4 起）：无图那一轮仍是**字符串**（M1–M3 逐字不变），
 * 带图那一轮是内容块数组（§4.2）。后端把它当 `json.RawMessage` 哑管道透传（M4 任务 1）。
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentBlock[];
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

/** 扁平的调用形状（M2 归一化后的形状，请求与响应两个方向都是它） */
export interface ChatToolCall {
  id: string;
  name: string;
  /** 上游给的 JSON 字符串（**不在这里 parse**：解析是 `tools.ts` 的 parseArgs 的职责） */
  arguments: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatReply {
  text: string;
  toolCalls: ChatToolCall[];
  usage?: ChatUsage;
  finishReason: string;
}

/**
 * 失败分类（规格 §5.3 / §6.6 的客户端半边）。每一种都有独立测试。
 *
 * `rate_limited` 带 `scope`：**分钟级与日配额是两回事**（M2 契约第 4 条）—— 分钟级
 * 429 的文案是"稍后再试"，日配额 429 的文案是"今天用完了，明天再来"，混成一条会让用户
 * 在额度已经耗尽时一直重试。
 *
 * `cancelled` 是**用户主动停**（"取消生成"，规格 §5.2），与 `timeout`（真实超时）必须是
 * 两类：以前两者**标签是反的** —— 真实超时被 `apiFetch` 压成 `status:0` 判成 `network`，
 * 而用户点取消被判成 `timeout` ⇒ 用户看到"分析超时了，请重试"（他没超时，是他自己停的）。
 * §5.3 里取消那一行是"丢弃结果"，所以任务 5 靠这一类比 `timeout` 决定**不渲染错误气泡**。
 */
export type TransportFailure =
  | { kind: "network" }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "unauthorized" }
  | { kind: "disabled" }
  | { kind: "rate_limited"; scope: "minute" | "day" }
  | { kind: "too_large" }
  | { kind: "bad_request" }
  | { kind: "upstream"; code: string }
  | { kind: "invalid_response" };

export type ChatOutcome = { ok: true; reply: ChatReply } | { ok: false; failure: TransportFailure };

export interface Transport {
  chat(messages: ChatMessage[], tools: unknown[], signal: AbortSignal): Promise<ChatOutcome>;
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  host: string | null;
  /** `/ai/status` 自己失败时的原因（网络 / 401 / 500…）。正常时不存在。 */
  failure?: TransportFailure;
}

// ---------------------------------------------------------------------------
// 失败 → 用户能看懂的中文
// ---------------------------------------------------------------------------

/** 失败 → 面向**普通用户**的一句中文（§5.3 的文案表；不含堆栈、不含后端原文、不含码） */
export function describeFailure(failure: TransportFailure): string {
  switch (failure.kind) {
    case "network":
      return "网络似乎不太顺，等会儿再试试。";
    case "timeout":
      return "AI 分析超时了，请重试。";
    case "cancelled":
      // §5.3 里"取消"不在错误矩阵上（§5.2：掐掉在途请求、**丢弃结果**）⇒ 任务 5 不该
      // 渲染这句话。这条只是为了 switch 穷尽 + 万一被渲染也给人话而不是 undefined。
      return "这次提问已取消。";
    case "unauthorized":
      return "登录状态已过期，请重新登录后再试。";
    case "disabled":
      return "这个服务器还没启用 AI 功能。";
    case "rate_limited":
      return failure.scope === "day"
        ? "今天的 AI 次数已经用完了，明天再来吧。"
        : "问得有点快，歇一分钟再试。";
    case "too_large":
      return "这次的对话内容太长了，清空会话记录后再试。";
    case "bad_request":
      return "这条消息没能发出去，换个说法试试。";
    case "upstream":
      return "AI 服务暂时不可用，请稍后重试。";
    case "invalid_response":
      return "AI 返回的内容看不懂，请重试。";
  }
}

// ---------------------------------------------------------------------------
// `error` 字段：只有带 `ai_` 前缀的才是错误码
// ---------------------------------------------------------------------------

/**
 * M2 的契约错误码 → 失败分类。
 *
 * `SELF-HOSTING.md` 的"故障对照"注把 `error` 分成三类：①契约码、②限流中间件码
 * （`ai_rate_limited` / `ai_quota_exceeded`，同样带前缀）、③**无前缀的直述消息**
 * （`request body too large` / `invalid request body` / 五条鉴权消息 / `unauthorized`）。
 * 第三类**不得当码查表**（查不到），判据就一条：**看有没有 `ai_` 前缀**。
 *
 * ⚠️ 这张表**不是分类的入口**（分类永远由 status 决定，见 `classifyHttp`）。它的唯一用处是
 * **行为不变量 + 排障线索**：钉住"这些码分别是什么意思"，并在 200 里混进码时把它当契约违反。
 *
 * 三个**幽灵码**（照 M2 源码核过，任务 4 修复轮）：
 * `ai_unauthorized` / `ai_bad_request` / `ai_body_too_large` 在 M2 **根本不存在** ——
 * `backend/internal/service/ai.go:23-31` 只定义了 7 个码（`ai_disabled` / `ai_unreachable` /
 * `ai_upstream_auth` / `ai_upstream_timeout` / `ai_upstream_error` / `ai_rate_limited` /
 * `ai_quota_exceeded`）；401/400/413 那三档的真实 `error` 是**无前缀的直述消息**。
 * 它们留在这里是**向前兼容**：万一适配层以后开始发，status 仍然说了算，不会被带偏。
 *
 * 注意 `ai_upstream_auth`（502，key 无效）**不在**九类里，它归 `upstream`
 * （code 原样保留供排障）；把没列进来的 `ai_` 码当作"未知失败"会让排障时丢掉唯一的线索。
 */
function classifyCode(code: string): TransportFailure | null {
  switch (code) {
    case "ai_disabled":
      return { kind: "disabled" };
    case "ai_unauthorized":
      return { kind: "unauthorized" };
    case "ai_bad_request":
      return { kind: "bad_request" };
    case "ai_body_too_large":
      return { kind: "too_large" };
    case "ai_rate_limited":
      return { kind: "rate_limited", scope: "minute" };
    case "ai_quota_exceeded":
      return { kind: "rate_limited", scope: "day" };
    case "ai_upstream_timeout":
      return { kind: "timeout" };
    case "ai_upstream_error":
    case "ai_upstream_auth":
    case "ai_unreachable":
      return { kind: "upstream", code };
    default:
      // `ai_invalid_response` 从来不在这里出现：**M2 没有这个码**（上表三个幽灵码同源，
      // 它连 M2 的 7 个码都不在）。502 那三个真码上面已经全覆盖。
      return null;
  }
}

/** 只在**带 `ai_` 前缀**时当真码查表；其余（含 undefined、直述消息）一律 null */
function failureFromCode(code: string | undefined): TransportFailure | null {
  if (code === undefined || !code.startsWith("ai_")) return null;
  return classifyCode(code);
}

/**
 * 从**成功响应体**里取 `error` 字段（只可能是 `ai_` 码 ⇒ 契约违反）。
 *
 * ⚠️ 不能读 `res.error`：那是 `apiFetch` 在 `!res.ok` 时的**错误槽**，200 的 body 在
 * `res.data` 里（`api.ts:142-148`）—— 写成 `res.error` 就是恒 `undefined` 的死代码。
 */
function strayCodeInData(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const err = data.error;
  return typeof err === "string" && err.startsWith("ai_") ? err : undefined;
}

/**
 * HTTP 状态 + `error` → 失败分类。**status 先、code 后**（本文件的第 2 条纪律）。
 *
 * ⚠️ 这里**只**由 status 决定分类，`code` 只用于 429 的"分钟级 / 日配额"细分。以前 503
 * （`failureFromCode(code) ?? …`）会让 **code 决定** 分类 —— 503 + `ai_upstream_error`
 * 判成 `upstream`，正好违反这条纪律。现在六个状态码各自**硬绑**一个分类。
 *
 * `status === 0` **不在这里**：那是 `apiFetch` 的"没走到 HTTP"哨兵，一个数字抵三种原因
 * （网络错 / 15s 兜底超时 / 用户取消），靠 `error` 串才分得开（见 `classifyZero`）。
 *
 * **实测**（任务 4 修复轮，用 `m2ErrorRes` 喂真形状走真 `apiFetch`）：
 * ```
 * 400 → {"ok":false,"status":400,"error":"invalid request body"}
 * 401 → {"ok":false,"status":401,"error":"invalid or expired token"}   ← Content-Type 是 text/plain
 * 413 → {"ok":false,"status":413,"error":"request body too large"}
 * ```
 * 三档的 `error` 都是**后端原文**（**不是** `statusText`、**不是** `undefined`）：401 的
 * Content-Type 虽是 `text/plain`，**内容却是 JSON 文本** ⇒ `res.json()` 解析得出来。
 * 所以"只看 body 会判错"的真正原因是**没有 `ai_` 前缀**，不是"body 不是 JSON"（旧的
 * 注释把两者说反了 ✗）。
 */
function classifyHttp(status: number, code: string | undefined): TransportFailure {
  switch (status) {
    case 401:
      // 这一条就是"先看 status"的价值所在：M2 的 401 体是 `http.Error` 写的 text/plain
      // JSON 文本，内容 `{"error":"invalid or expired token"}` —— **没有 `ai_` 前缀**
      // （`backend/internal/middleware/auth.go:33`）⇒ 靠 code 判会落到"未知失败"。
      // （这段直述消息不会出现在给用户的文案里，`describeFailure` 只回一句人话 ✓）
      return { kind: "unauthorized" };
    case 400:
      // M2 这里是 `writeError` → application/json，内容是 `invalid request body`（不是码）
      return { kind: "bad_request" };
    case 413:
      // 同上，`request body too large`（不是码）
      return { kind: "too_large" };
    case 429: {
      // 唯一允许 code 参与细分的分支：分类仍是 `rate_limited`（status 定的），
      // code 只决定"分钟级"还是"日配额"。
      const byCode = failureFromCode(code);
      if (byCode !== null && byCode.kind === "rate_limited") return byCode;
      // 没有码（经代理改写 / 中间件版本不同）时按**分钟级**算：说"歇一分钟再试"比
      // 误判成"今天用完了"轻 —— 后者会让用户在额度尚在时放弃使用。
      return { kind: "rate_limited", scope: "minute" };
    }
    case 502:
      // M2 的 502 只有**三个**码（`handler/ai.go:86-87` 与 `:97-98` 的 default）：
      // ai_upstream_auth / ai_upstream_error / ai_unreachable（**不是四个** ——
      // `ai_invalid_response` 在 M2 不存在）。三个都归 `upstream`，code **原样保留**
      // 供排障；这里**不看** code 是什么，只透传 —— 所以 502 + `ai_disabled` 也是
      // `{kind:"upstream", code:"ai_disabled"}`，码不丢（以前那个 `kind === "upstream"`
      // 守卫会把码吞成 `""` ✗，与"原样保留 code"的注释正好相反）。
      return { kind: "upstream", code: code ?? "" };
    case 503:
      // 这个状态码今天只有 `ai_disabled` 一种来源（`handler/ai.go:84-85`）。body 里
      // 混进别的码也**不改分类** —— 同一句话给用户（上游坏了不等于 AI 没启用）。
      return { kind: "disabled" };
    case 504:
      return { kind: "timeout" };
    default:
      // 404（服务端版本旧、没有 /ai 路由）/ 500 / 其他任何码：都归 unknown upstream，
      // 不新造分类，也**不**把 code 带出来（未知状态下的码没有可解释性）。
      return { kind: "upstream", code: "" };
  }
}

/**
 * `apiFetch` 的 `status:0` 哨兵 → 失败分类。一个数字抵三种原因，靠 `apiFetch` 带上来的
 * `error`（`api.ts` 的 `networkErrorReason`）分：
 * - `"timeout"`：`fetchWithTimeout` 的 15s 兜底掐的（没人主动取消）⇒ `timeout` ✓
 * - `"aborted"`：外部 signal 取消 ⇒ `cancelled` ✓
 * - `"network error"`：fetch 自己抛的（断网 / DNS / TLS / 代理）⇒ `network` ✓
 *
 * ⚠️ 用户主动取消**正常到不了**这里：`chat()` 在 status 判定之前就用 `signal.aborted`
 * 拦掉了。
 * ⚠️⚠️ 而 `"aborted"` 这个**值本身实际也几乎产不出来**（step 0 处置死代码时实测；计划第 30
 * 条的更正只说了"别用 `signal.aborted` 猜"，没说这一层）：用户在途取消时 `onAbort` 让
 * `controller.abort()`，fetch **同步**拒绝，catch 跑起来时 `timeoutFired` 还是 false
 * ⇒ `api.ts` 不打标签 ⇒ 值是 `"network error"`。唯一能让（兜底开火 ∧ 外部已 abort）同时成立
 * 的窗口是**兜底开火之后、catch 跑起来之前**用户又取消（竞态，且良性：用户确实掐了请求）；但
 * `api.ts` 读的是**发起请求之前**取的 `external.aborted` 快照，迟到的取消事件改不了它
 * ⇒ 连这个窗口也合不上。
 *
 * 这条分支与 `api.ts` 的那个 `"aborted"` 标签**成对保留**（铁律：要么一起删、要么一起留，
 * 别一处删一处留）：留着是**兜底 + 契约**（万一有人删掉 `chat()` 的取消前置判别、或把外部
 * 取消改成走兜底超时，分类必须仍是 `cancelled`，不能滑成"网络似乎不太顺"）。另一半的理由
 * 写在 `api.ts` 文件头。
 *
 * ⚠️ `status:0` 的 `code` 可能是 `undefined`（`apiFetch` 两个 catch 都带 error 串，
 * 但别处调用可能不认这三档）⇒ 一律当网络层失败。
 */
function classifyZero(code: string | undefined): TransportFailure {
  if (code === "timeout") return { kind: "timeout" };
  if (code === "aborted") return { kind: "cancelled" };
  return { kind: "network" };
}

// ---------------------------------------------------------------------------
// 响应体校验（客户端侧的契约哨兵）
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验并归一化一次成功的 `/ai/chat` 响应。**任何形状不合的地方都返回 null**（⇒ invalid_response）。
 *
 * 判别式是**形状**，不是 `as`：
 * - 上游的嵌套形状 `{id, type, function:{name, arguments}}` 没有 `name` 字符串 ⇒ 被拒
 * - `arguments` 由**本地代码构造**、上游是字符串 ⇒ 非字符串一律被拒
 * - `tool_calls` 是数组但元素不是对象 ⇒ 被拒
 *
 * `{...tc}` 展开会把嵌套的 `function` 键一起带出去 —— 那是上游的形状，客户端永远不写。
 * 所以这里**逐字段取值**（与 `tools.ts` 的 `toPromptItem` 同一条纪律）。
 */
function readReply(data: unknown): ChatReply | null {
  if (!isRecord(data)) return null;

  const rawText = data.text;
  if (rawText !== undefined && typeof rawText !== "string") return null;
  const text = typeof rawText === "string" ? rawText : "";

  const rawCalls = data.tool_calls;
  if (rawCalls !== undefined && !Array.isArray(rawCalls)) return null;
  const toolCalls: ChatToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      if (!isRecord(raw)) return null;
      const { id, name, arguments: args } = raw;
      if (typeof id !== "string" || id === "") return null;
      if (typeof name !== "string" || name === "") return null;
      // ⚠️ 上游的嵌套形状在这里被拒：它的 `arguments` 在 `function` 里，顶层没有 `name`
      if (typeof args !== "string") return null;
      toolCalls.push({ id, name, arguments: args });
    }
  }

  const rawFinish = data.finish_reason;
  if (rawFinish !== undefined && typeof rawFinish !== "string") return null;

  const reply: ChatReply = {
    text,
    toolCalls,
    finishReason: typeof rawFinish === "string" ? rawFinish : "",
  };

  const usage = readUsage(data.usage);
  if (usage !== null) reply.usage = usage;
  return reply;
}

/** usage 三个字段都是数字才算；**形状错就整个丢掉**（用量只用于观测，不该让一次成功的回答失败） */
function readUsage(raw: unknown): ChatUsage | undefined {
  if (!isRecord(raw)) return undefined;
  const p = raw.prompt_tokens;
  const c = raw.completion_tokens;
  const t = raw.total_tokens;
  if (typeof p !== "number" || typeof c !== "number" || typeof t !== "number") return undefined;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: t };
}

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

const CHAT_PATH = "/ai/chat";
const STATUS_PATH = "/ai/status";

/**
 * 把失败的原因写进 console（**不是**给用户看的文案）。后端原文只留在这里：
 * §5.3 要求 UI 上是人话，排障要靠控制台。
 */
function logFailure(where: string, failure: TransportFailure, error?: string): void {
  if (failure.kind === "invalid_response") {
    console.warn(`[ai] ${where} 响应形状不符合契约（tool_calls 必须是扁平 {id,name,arguments}）`);
    return;
  }
  if (error !== undefined && error !== "") console.warn(`[ai] ${where} 失败：${failure.kind}（${error}）`);
}

/**
 * 一次工具调用（= 一次对话轮）的传输。**永不抛**。
 *
 * `signal` 透传给 `apiFetch`（`api.ts` 已支持：`init.signal` 会在 `fetchWithTimeout` 里
 * 与超时 controller 串联）。取消时在途请求真的被 abort，不是"假装取消"。
 *
 * 请求体形状照 §6.1：`{messages, tools}`；`tools` 由调用方传 `TOOLS` 进来，本层**不 import
 * `tools.ts`** —— 那样会把 `@/db/userDb` 拖进 transport 的模块图，而 transport 只需要
 * "一个 JSON 可序列化的数组"。
 */
export function createTransport(): Transport {
  return {
    async chat(messages, tools, signal): Promise<ChatOutcome> {
      // 已经取消的调用**一个请求都不发**。不是为了省流量，而是因为 `apiFetch` 在这一形态
      // 下会把"被取消"和"网络断"都归成 `status:0`（`api.ts:126` 的 catch 不看 abort 原因）
      // ⇒ 用户主动停会被报成"网络似乎不太顺"，反过来怪网络。
      if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };

      let res: Awaited<ReturnType<typeof apiFetch>>;
      try {
        res = await apiFetch(CHAT_PATH, {
          method: "POST",
          body: JSON.stringify({ messages, tools }),
          signal,
        });
      } catch (err) {
        // apiFetch 契约上不抛；万一将来它抛了（例如 getBaseUrl 未配置），也不能冒到编排循环。
        // **必须打日志**：这是唯一能看到抛出原因的地方（仓内惯例是 console.warn）。
        const failure: TransportFailure = signal.aborted ? { kind: "cancelled" } : { kind: "network" };
        logFailure("chat", failure, err instanceof Error ? err.message : String(err));
        return { ok: false, failure };
      }

      // 在途取消：同上，`status:0` 里分不出"用户停"和"网络断"，用 signal 自己判。
      // （放在 status 判定**之前**：否则 0 会被判成 network，503 会被判成 disabled。）
      if (signal.aborted) return { ok: false, failure: { kind: "cancelled" } };

      // 先看 status：失败分支里 code 只用来**细分**，分类永远由 status 决定。
      const code = typeof res.error === "string" ? res.error : undefined;
      if (!res.ok) {
        // `status:0` 单独一档：它一个数字抵三种原因（网络错 / 15s 兜底超时 / 取消）。
        // 不分开的话真实超时会被报成"网络似乎不太顺"（规格 §5.3 要的是"分析超时"）。
        const failure = res.status === 0 ? classifyZero(code) : classifyHttp(res.status, code);
        logFailure("chat", failure, code);
        return { ok: false, failure };
      }

      // 200 里混进 `ai_` 错误码 = 服务端把失败包成了成功（契约违反）⇒ `invalid_response`。
      // 不判的话用户会看到一个**空气泡**且没有任何错误提示（静默成功），比报错更糟。
      // 判据用 `ai_` 前缀（与判别顺序那条纪律同一个判据）：没有前缀的散字段不是 M2 的错误码。
      const stray = strayCodeInData(res.data);
      if (stray !== undefined) {
        logFailure("chat", { kind: "invalid_response" }, stray);
        return { ok: false, failure: { kind: "invalid_response" } };
      }

      const reply = readReply(res.data);
      if (reply === null) {
        logFailure("chat", { kind: "invalid_response" });
        return { ok: false, failure: { kind: "invalid_response" } };
      }
      return { ok: true, reply };
    },
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function readStatusData(data: unknown): Pick<AiStatus, "enabled" | "model" | "host"> {
  if (!isRecord(data)) return { enabled: false, model: null, host: null };
  return {
    enabled: data.enabled === true,
    model: typeof data.model === "string" && data.model !== "" ? data.model : null,
    // `host` 缺失/为空 ⇒ null。上层据此**不显示隐私卡、也不允许开启开关**（§7.3 的硬门槛）
    host: typeof data.host === "string" && data.host !== "" ? data.host : null,
  };
}

/**
 * `catch` 里的原因 → 一行日志文本。
 *
 * `String(err)` 对 `Error("")` 会拿到 `"Error"`、对 `null` 会拿到 `"null"` —— 都还有信息；
 * 但对"有 message 的 Error"要拿到的是**原因本身**，不能是 `"Error: xxx"` 这种把原因埋掉的形态。
 * 单独一个函数是为了让每个吞异常的分支**都必须显式调它**（G5：吞异常必留痕）。
 */
function throwReason(err: unknown): string {
  return err instanceof Error && err.message !== "" ? err.message : String(err);
}

/**
 * 探一次 AI 能力。**不轮询**：`/ai/status` 与 `/ai/chat` 共用一个每分钟桶
 * （M2 契约第 4 条），轮询会平白吃掉用户的每分钟额度。
 *
 * 自动调用点只有一处：`App.vue` 那个"地址就绪后探一次"的钩子（C6：**地址没配就不发请求**）；
 * 用户点「重新检测」是显式路径，不受那条守卫限制。页面 `onMounted` **不许**再探
 * （`App.aiProbe.test.ts` 钉着"自动探针只有一处"）。
 *
 * **永不抛**，失败一律 `enabled: false` + `failure` —— 拿不到能力就等于没启用，
 * tab 不显示，这是安全的一侧。status 的 429 **不是"额度耗尽"**：日配额只约束
 * `/ai/chat`，所以这里不额外区分 scope，交给 `describeFailure`。
 */
export async function fetchAiStatus(): Promise<AiStatus> {
  let res: Awaited<ReturnType<typeof apiFetch>>;
  try {
    res = await apiFetch(STATUS_PATH);
  } catch (err) {
    // G5（吞异常必留痕）：`apiFetch` 契约上不抛，但 base URL 未配置时 `getBaseUrl()` 会抛，
    // 而这个 catch 过去**一个字都不打** ⇒ 真机上 Network 无请求（异常在 fetch 之前）、
    // Console 空、后端无日志 —— 三种观测手段同时隐身（本轮事故的最贵教训）。
    // 日志里必须同时有**这条路**（STATUS_PATH）与**抛出原因**：排障时要能一眼分清
    // "地址/登录态未就绪"与"网络层真的抛了"。降级形状不变（上面的契约）。
    console.warn(`[ai] status ${STATUS_PATH} 未发出（吞掉异常并降级）：${throwReason(err)}`);
    return { enabled: false, model: null, host: null, failure: { kind: "network" } };
  }

  if (!res.ok) {
    const code = typeof res.error === "string" ? res.error : undefined;
    // `status:0` 与 chat 同法分开（这条没有外部 signal ⇒ 只可能 network / 兜底超时）。
    // 不分的话以前会掉进 `classifyHttp` 的 default（`upstream`）—— 报"AI 服务暂时不可用"
    // 而不是"网络不太好"，是错的文案，只是被用例的期望值一起写错了。
    const failure = res.status === 0 ? classifyZero(code) : classifyHttp(res.status, code);
    logFailure("status", failure, code);
    return { enabled: false, model: null, host: null, failure };
  }

  const status = readStatusData(res.data);
  // 形状不对 ⇒ 不是"没启用"而是"响应坏了"：两者都要 `enabled:false`（安全的一侧 —— 绝不把
  // 坏响应当成"已启用"），但**必须**把 `failure` 带出去：上层（`aiChat.refreshStatus`）只有
  // 看得见它，才能把"服务端明确说没配"（200 + `enabled:false`）与"这次探测不可判定"分开，
  // 后者要**保留上一次已知状态**（第 47 条：拿不到结论不能把已确认可用的 tab 关掉）。
  // `enabled` 不是布尔值同属"形状坏"：缺字段时 `readStatusData` 会默默给 false，
  // 那会被上层读成"服务端明确说没配" —— 一个旧版服务端的空 body 就能关掉用户的 tab。
  if (!isRecord(res.data) || typeof res.data.enabled !== "boolean") {
    logFailure("status", { kind: "invalid_response" });
    return { ...status, failure: { kind: "invalid_response" } };
  }
  return status;
}
