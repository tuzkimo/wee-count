// src/services/ai/failureText.ts
//
// T3（G3「文案说真话」）：`host === null` **至少有三类来源**，不得一律说成
// 「服务端未配置 AI」——
//
//   ① 地址 / 登录态未就绪（`hasBaseUrl()` 为假）：请求**根本没发出去**，与服务端无关；
//   ② 网络不可达 / 超时 / 429 / 形状坏 / 401：地址有、但这轮探测给不出结论；
//   ③ 服务端**明确**回复没配（200 + `enabled:false`，或 503 `ai_disabled`）。
//
// 真机事故里这三类全被渲染成第三类的那句话（"这台设备暂时用不了助手"），把用户引向
// 完全错误的方向。这里的唯一职责就是**分流**：纯函数、不碰 store、不碰网络，四条分支
// 的文案互不相同（唯一含「未配置」的是第三类）。
//
// ⚠️ 发送**失败**的文案不在这里：那是 `transport.ts` 的 `describeFailure`（§5.3 的文案表），
// 本文件只出**入口 / 门控**这一层的说明（C3/C5）。C3.5 复用 `describeFailure` 的原文，
// 不另抄一份 —— 两处各写各的必然漂移。
import { describeFailure, type AiStatus, type TransportFailure } from "@/services/ai/transport";

/** 最近一次**不可判定**的探测失败类型（形状坏 / 网络 / 超时 / 429 / 401 / 5xx） */
export type FailureKind = NonNullable<AiStatus["failure"]>["kind"];

export interface OffHintParams {
  /** 意愿层：用户是否允许发送。`false` 时优先说"去哪打开"（C5.1） */
  sendingEnabled: boolean;
  /** 服务端地址是否已知；`null` = 还没探到（C3：这一类来源最多） */
  host: string | null;
  /** 最近一次不可判定探测的失败类型；`null` = 没有（要么没探过、要么就绪前没发请求） */
  failureKind: FailureKind | null;
  /** 服务端是否**明确**表态配了 AI；`null` = 没表态（C3.1 只在 `false` 时生效） */
  configured: boolean | null;
  /** 地址是否已配置（`hasBaseUrl()`）。这一条是 ①② 的分界线 */
  hasBaseUrl: boolean;
  /**
   * 客户端是否**已经拿到登录凭据**（`api.authTokenReady`）。这一条是 ① 内部的第二条分界线：
   * 地址有了、但 token 还没恢复时，请求是以**匿名**身份发出去的，401 只说明"我们自己还没登录"。
   *
   * ⚠️ 可选（不传 = 已就绪）**只**为让 `bf2ca9d` 之前那批表驱动用例逐字不变；`aiChat` store
   * 必须传真实值，否则真机那句谎话会回来。
   */
  authTokenReady?: boolean;
}

/** 服务端明确没配时**唯一**允许出现「未配置」字样的文案 */
const NOT_CONFIGURED = "服务端未配置 AI 功能。";

/**
 * 客户端还没拿到登录凭据时**唯一**允许说的话。
 *
 * 它与「检测失败：…」的区别就是 Bug 1 的要点：那次 401 发生在**请求没带任何凭据**的时候，
 * 说的是"这次请求没有以某个身份发出去"，**不是**"服务端判定你的登录过期了"。也不许诺
 * "稍后会自动重试" —— 会话恢复失败（服务下线 / 已解绑）时并没有谁会去重试。
 */
const AUTH_NOT_READY = "登录状态还没就绪，登录成功后再试。";

/**
 * `host === null` 的三类来源 → 三句**不同**的话；意愿层关着 → 另起一句。
 *
 * 分支顺序是刻意的（先"已知没配"，再"意愿层"，再"地址未就绪"，最后"探测失败"）：
 * `configured === false` 是**已知**，优先级高于一切猜测；而"意愿层关着"这条要说的是
 * "去哪打开"，与 host 是哪一类来源无关。
 */
export function describeOffHint(params: OffHintParams): string {
  if (params.configured === false) return NOT_CONFIGURED;

  if (!params.sendingEnabled) {
    // 有 host 时可以说得更具体（数据会发到哪）；没探到时不许编一个域名出来
    return params.host === null
      ? "AI 助手已关闭，去「我的 → 隐私」打开后才能发送。"
      : `AI 助手已关闭，去「我的 → 隐私」打开后才能发送（数据将发送到 ${params.host}）。`;
  }

  // 走到这里 = 用户已开启发送（C5：host 未知也能开），但服务端地址还不可知
  if (!params.hasBaseUrl) {
    return "还没有连接到服务器，登录或配置服务器地址后再试。";
  }
  // 401 **只在"我们确实带着身份发出去"时**才算"登录已过期"的证据（Bug 1）：没有凭据时那次
  // 401 什么都不说明 ⇒ 不许说成「检测失败」。
  // ⚠️ 这条豁免**只给 `unauthorized`**：网络 / 超时 / 429 / 形状坏与登录态无关，没凭据也照样
  // 如实说「检测失败」—— 把它们也改成"登录状态还没就绪"是把网络故障说成了"你去登录一下"
  // （`AiChatPage.offHint.test.ts:97` 钉着这条，那是对的）。
  const unauthorizedWithoutCredentials =
    params.failureKind === "unauthorized" && params.authTokenReady === false;
  if (params.failureKind !== null && !unauthorizedWithoutCredentials) {
    return `检测失败：${describeFailure({ kind: params.failureKind } as TransportFailure)}`;
  }
  // 没有失败结论、凭据又还没恢复：这时唯一能确定的事实就是"我们还没登录"
  if (params.authTokenReady === false) {
    return AUTH_NOT_READY;
  }
  return "尚未检测到可用的 AI 服务，点「重新检测」再试。";
}

/**
 * 隐私区那一行状态说明（C3.1–C3.5）。
 *
 * 与 `describeOffHint` 分开：那一句回答"为什么发不出去"，这一行回答"现在到底连到哪儿了"。
 * `host === null` 时**禁止**插值出 `null` 字样（C3 的禁止值）。
 */
export function describeHostState(params: Omit<OffHintParams, "sendingEnabled">): string {
  if (params.configured === false) return NOT_CONFIGURED;
  if (params.host !== null) return `数据将发送到 ${params.host}。`;
  if (!params.hasBaseUrl) return "还没有连接到服务器，登录或配置服务器地址后再试。";
  // 与 `describeOffHint` 逐条同序（两处必须一起改，否则同一状态在两条提示条上说两种话）
  const unauthorizedWithoutCredentials =
    params.failureKind === "unauthorized" && params.authTokenReady === false;
  if (params.failureKind !== null && !unauthorizedWithoutCredentials) {
    return `检测失败：${describeFailure({ kind: params.failureKind } as TransportFailure)}`;
  }
  // 没凭据 ⇒ 不是"检测失败"，是"还没登录"
  if (params.authTokenReady === false) return AUTH_NOT_READY;
  return "尚未检测 AI 服务，可点「重新检测」。";
}

/** 服务端明确没配时给用户的一句话（C4.3 的防呆提示 + C5.4 的提示条共用一份） */
export const AI_NOT_CONFIGURED_TEXT = NOT_CONFIGURED;
