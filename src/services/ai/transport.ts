// `/api/v1/ai/chat` 与 `/api/v1/ai/status` 的**协议转换层**（规格 §5.1 / §6.1）。
//
// 本文件的全部职责：把 M2 归一化后的响应变成 M3 的类型，把失败变成**值**。
//
// 三条纪律（各有独立的测试与杀手）：
// 1. **永不抛**：网络错、超时、取消、任何非 200，都返回 `{ok:false, failure}`。编排循环
//    （任务 5）要靠这个值把失败渲染成消息流里的一条 assistant 消息，一个冒出来的异常
//    会变成未捕获的 promise rejection。
// 2. **判别顺序是"先 status、再看 body 里的 `ai_` 前缀"**（M2 契约第 2 条）：M2 的
//    401 / 400 / 413 响应体是 `text/plain` 直述消息、**不含错误码**（`SELF-HOSTING.md`
//    的"故障对照"注③）。只看 body 里有没有码，会把这三类全判成"未知失败"。
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
 * 一条对话消息。
 *
 * `tool_calls` 只在 assistant 消息上出现，形状与响应里收到的**逐字相同** —— 客户端把上一轮
 * 收到的那一份原样回传，服务端负责转成上游的嵌套形状（M2 契约第 1 条）。
 * 所以这里的类型只用 `ChatToolCall`，绝不会出现 `function: {...}`。
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
 * 九类失败（规格 §5.3 / §6.6 的客户端半边）。每一种都有独立测试。
 *
 * `rate_limited` 带 `scope`：**分钟级与日配额是两回事**（M2 契约第 4 条）—— 分钟级
 * 429 的文案是"稍后再试"，日配额 429 的文案是"今天用完了，明天再来"，混成一条会让用户
 * 在额度已经耗尽时一直重试。
 */
export type TransportFailure =
  | { kind: "network" }
  | { kind: "timeout" }
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
    case "ai_invalid_response":
      return { kind: "upstream", code };
    default:
      return null;
  }
}

/** 只在**带 `ai_` 前缀**时当真码查表；其余（含 undefined、直述消息）一律 null */
function failureFromCode(code: string | undefined): TransportFailure | null {
  if (code === undefined || !code.startsWith("ai_")) return null;
  return classifyCode(code);
}

/**
 * HTTP 状态 + `error` → 失败分类。**status 先、code 后**（本文件的第 2 条纪律）。
 *
 * `status === 0` 是 `apiFetch` 的"没走到 HTTP"（网络错 / 超时 / 被取消）哨兵
 * （`api.ts:111`），单独处理：那不是任何一个 HTTP 状态。
 */
function classifyHttp(status: number, code: string | undefined): TransportFailure {
  switch (status) {
    case 0:
      // `apiFetch` 的"没走到 HTTP"哨兵（网络错 / 被取消 / 超时）。**取消的细分在 chat()
      // 里用 signal 自己做**：到了这一层已经分不出"用户停"和"网络断"。
      return { kind: "network" };
    case 401:
      // 这一条就是"先看 status"的价值所在：M2 的 401 体是 text/plain 直述消息、
      // 没有码（`{"error":"invalid or expired token"}` 但 Content-Type 不是 JSON ⇒
      // apiFetch 的 `.json()` 拿到 `{}`）⇒ 靠 code 判会落到"未知失败"。
      return { kind: "unauthorized" };
    case 400:
      return { kind: "bad_request" };
    case 413:
      // M2 这一档的 error 是直述消息 "request body too large"（不是码）
      return { kind: "too_large" };
    case 429: {
      const byCode = failureFromCode(code);
      if (byCode !== null && byCode.kind === "rate_limited") return byCode;
      // 没有码（经代理改写 / 中间件版本不同）时按**分钟级**算：说"歇一分钟再试"比
      // 误判成"今天用完了"轻 —— 后者会让用户在额度尚在时放弃使用。
      return { kind: "rate_limited", scope: "minute" };
    }
    case 502: {
      // 502 的 code 有四种：ai_upstream_error / ai_upstream_auth / ai_unreachable /
      // ai_invalid_response —— 全都归 `upstream` 并**原样保留 code**（排障时这是唯一的线索）。
      const byCode = failureFromCode(code);
      return byCode !== null && byCode.kind === "upstream" ? byCode : { kind: "upstream", code: "" };
    }
    case 503:
      // 这个状态码今天只有 `ai_disabled` 一种来源；其他 503 走兜底（同一句话给用户）
      return failureFromCode(code) ?? { kind: "upstream", code: "" };
    case 504:
      return { kind: "timeout" };
    default:
      // 404（服务端版本旧、没有 /ai 路由）/ 500 / 502 以外的任何码：都归 unknown upstream，
      // 不新造分类 —— 上层只需要一句话。
      return { kind: "upstream", code: "" };
  }
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
      // 下会把"被取消"和"网络断"都归成 `status:0`（`api.ts:111` 的 catch 不看 abort 原因）
      // ⇒ 用户主动停会被报成"网络似乎不太顺"，反过来怪网络。
      if (signal.aborted) return { ok: false, failure: { kind: "timeout" } };

      let res: Awaited<ReturnType<typeof apiFetch>>;
      try {
        res = await apiFetch(CHAT_PATH, {
          method: "POST",
          body: JSON.stringify({ messages, tools }),
          signal,
        });
      } catch {
        // apiFetch 契约上不抛；万一将来它抛了（例如 getBaseUrl 未配置），也不能冒到编排循环
        return { ok: false, failure: { kind: signal.aborted ? "timeout" : "network" } };
      }

      // 在途被取消：同上，`status:0` 里分不出"用户停"和"网络断"，用 signal 自己判。
      // （放在 status 判定**之前**：否则 0 会被判成 network。）
      if (signal.aborted) return { ok: false, failure: { kind: "timeout" } };

      // 先看 status：失败分支里 code 只用来**细分**，分类永远由 status 决定。
      const code = typeof res.error === "string" ? res.error : undefined;
      if (!res.ok) {
        const failure = classifyHttp(res.status, code);
        logFailure("chat", failure, code);
        return { ok: false, failure };
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
 * 探一次 AI 能力。**不轮询**：`/ai/status` 与 `/ai/chat` 共用一个每分钟桶
 * （M2 契约第 4 条），轮询会平白吃掉用户的每分钟额度。调用点只有"启动 / 进入 AI 页"。
 *
 * **永不抛**，失败一律 `enabled: false` + `failure` —— 拿不到能力就等于没启用，
 * tab 不显示，这是安全的一侧。status 的 429 **不是"额度耗尽"**：日配额只约束
 * `/ai/chat`，所以这里不额外区分 scope，交给 `describeFailure`。
 */
export async function fetchAiStatus(): Promise<AiStatus> {
  let res: Awaited<ReturnType<typeof apiFetch>>;
  try {
    res = await apiFetch(STATUS_PATH);
  } catch {
    return { enabled: false, model: null, host: null, failure: { kind: "network" } };
  }

  if (!res.ok) {
    const code = typeof res.error === "string" ? res.error : undefined;
    const failure = classifyHttp(res.status, code);
    logFailure("status", failure, code);
    return { enabled: false, model: null, host: null, failure };
  }

  const status = readStatusData(res.data);
  // `enabled: true` 但形状不对 ⇒ 不是"没启用"而是"响应坏了"，两者都要 enabled:false，
  // 但排障时能分开：这条警告是唯一能区分它们的地方
  if (!isRecord(res.data)) logFailure("status", { kind: "invalid_response" });
  return status;
}
