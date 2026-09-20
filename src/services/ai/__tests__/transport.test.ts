// `/api/v1/ai/chat` 与 `/ai/status` 的协议转换测试。
//
// mock 约定照 `src/services/__tests__/apiTimeout.test.ts:30`：`vi.stubGlobal("fetch", …)`
// 喂脚本化响应，**不** mock `@/services/api` —— transport 契约的一半（401 不重试、
// 请求体形状、取消真的 abort 了在途请求）只有走真实 `apiFetch` 才验得出来。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTransport,
  fetchAiStatus,
  describeFailure,
  type ChatMessage,
  type ChatToolCall,
  type TransportFailure,
} from "@/services/ai/transport";
import { setBaseUrl, clearTokens } from "@/services/api";

const BASE = "http://example.test/api/v1";

const MSG: ChatMessage[] = [{ role: "user", content: "这个月花了多少" }];

function jsonRes(status: number, body: unknown, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

/**
 * **照 M2 真实形状**的失败响应（任务 4 修复轮实测，不照抄任何人的结论）：
 * - 401 走 `http.Error`（`backend/internal/middleware/auth.go:33`）⇒ `Content-Type: text/plain`，
 *   但**内容是 JSON 文本** `{"error":"invalid or expired token"}` —— 所以 `.json()` **能**解出 `error`
 * - 400 / 413 走 `writeError`（`backend/internal/handler/helpers.go:15-17`）⇒ `application/json`
 * 三档的共同点只有一个：`error` **不带 `ai_` 前缀**（那才是"先看 status"的真判据）。
 */
function m2ErrorRes(status: number, message: string): Response {
  const isJson = status === 400 || status === 413;
  const text = JSON.stringify({ error: message });
  return {
    ok: false,
    status,
    statusText: isJson ? "" : "Unauthorized",
    headers: new Headers({ "Content-Type": isJson ? "application/json" : "text/plain; charset=utf-8" }),
    text: async () => text,
    // happy-dom 的 Response 真有 arrayBuffer，但这里只需要 json/text 两条路径
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response;
}

/** 200 但响应体读不出来（`apiFetch` 的 `.catch(() => undefined)` 路径）⇒ 不是"空对象"而是 undefined */
function unreadableRes(status = 200): Response {
  return {
    ok: true,
    status,
    statusText: "",
    json: async () => {
      throw new Error("Unexpected end of JSON input");
    },
  } as unknown as Response;
}

/** `error` 在响应体里的形状（M2 契约：契约码与限流码都是 `{"error":"<code>"}`） */
const errRes = (status: number, code?: string): Response =>
  jsonRes(status, code === undefined ? {} : { error: code });

/**
 * M2 的 401/400/413：**`error` 是不带 `ai_` 前缀的直述消息**（照后端源码核过）。形状照
 * `m2ErrorRes`：401 是 `http.Error` 的 text/plain-JSON 文本，400/413 是 `application/json`。
 * `apiFetch` 三档都拿到 `error` = 后端原文 ⇒ 只看 body 有没有 `ai_` 前缀会把它们全判成
 * `upstream`（那正是"先看 status"的必要性所在）。
 */
type FetchMock = ReturnType<typeof vi.fn>;

/** 按顺序吐响应；队列空还被打 ⇒ 立刻红（否则测试会挂到超时，看不出原因） */
function useFetchQueue(...responses: Response[]): FetchMock {
  const queue = [...responses];
  const mock = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch 队列已空：实现多发了一次请求");
    return next;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  // api.ts 的 baseUrl / token 是模块级状态，逐例清干净，免得上一条用例的 token 触发 refresh
  window.localStorage.clear();
  setBaseUrl(BASE);
  clearTokens();
  // transport 会把失败原因写进 console（排障用）；测试里静音，需要断言 warn 的用例
  // 自己再 spyOn 一层（`mockRestore()` 会退回到这一层）
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("transport.chat 成功路径与扁平 tool_calls 契约", () => {
  it("200 + 扁平 tool_calls ⇒ ok:true，name/arguments 逐字保留", async () => {
    const mock = useFetchQueue(
      jsonRes(200, {
        text: "",
        tool_calls: [
          { id: "call_1", name: "query_transactions", arguments: '{"aggregate":"sum"}' },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        finish_reason: "tool_calls",
      }),
    );

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reply.toolCalls).toEqual<ChatToolCall[]>([
      { id: "call_1", name: "query_transactions", arguments: '{"aggregate":"sum"}' },
    ]);
    expect(out.reply.finishReason).toBe("tool_calls");
    expect(out.reply.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("200 + 只有 text ⇒ toolCalls 是空数组（不是 undefined）", async () => {
    useFetchQueue(jsonRes(200, { text: "本月一共 128 元", finish_reason: "stop" }));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reply.text).toBe("本月一共 128 元");
    expect(out.reply.toolCalls).toEqual([]);
    expect(out.reply.finishReason).toBe("stop");
  });

  it("请求体是 {messages, tools}，且上一轮的 tool_calls 原样回传（扁平、不是 function 嵌套）", async () => {
    const mock = useFetchQueue(jsonRes(200, { text: "好", finish_reason: "stop" }));
    const toolCall: ChatToolCall = { id: "call_1", name: "query_transactions", arguments: "{}" };
    const history: ChatMessage[] = [
      { role: "user", content: "这个月花了多少" },
      { role: "assistant", content: "", tool_calls: [toolCall] },
      { role: "tool", content: "{}", tool_call_id: "call_1" },
    ];

    await createTransport().chat(history, [{ type: "function" }], new AbortController().signal);

    const body = JSON.parse(String(mock.mock.calls[0]![1].body)) as {
      messages: ChatMessage[];
      tools: unknown[];
    };
    expect(Object.keys(body).sort()).toEqual(["messages", "tools"]);
    expect(body.tools).toEqual([{ type: "function" }]);
    // 回传的 assistant 消息必须**逐字**是扁平形状：多一个 `function` 键就是上游形状（M2 契约 1）
    expect(body.messages[1]!.tool_calls).toEqual([toolCall]);
    expect(Object.keys(body.messages[1]!.tool_calls![0]!)).toEqual(["id", "name", "arguments"]);
  });

  it("请求打到 /ai/chat（前缀不自己拼 /api/v1 —— baseUrl 已经带了）", async () => {
    const mock = useFetchQueue(jsonRes(200, { text: "", finish_reason: "stop" }));

    await createTransport().chat(MSG, [], new AbortController().signal);

    expect(mock.mock.calls[0]![0]).toBe(`${BASE}/ai/chat`);
    expect(mock.mock.calls[0]![1].method).toBe("POST");
  });
});

describe("客户端侧的契约哨兵：上游的嵌套形状必须被拒（③）", () => {
  it("200 但 tool_calls 是上游嵌套形状（含 function、顶层无 name）⇒ invalid_response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(
      jsonRes(200, {
        text: "",
        // 上游 OpenAI 形状：name/arguments 藏在 function 里
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "query_transactions", arguments: "{}" } },
        ],
        finish_reason: "tool_calls",
      }),
    );

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out).toEqual({ ok: false, failure: { kind: "invalid_response" } });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("`arguments` 是对象（不是字符串）也拒 —— 本地代码构造的 arguments 才是对象", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(
      jsonRes(200, {
        text: "",
        tool_calls: [{ id: "call_1", name: "query_transactions", arguments: { aggregate: "sum" } }],
      }),
    );

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure.kind).toBe("invalid_response");
    warn.mockRestore();
  });

  it("tool_calls 元素缺 id 也拒（半截形状 = 契约坏了）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(
      jsonRes(200, { text: "", tool_calls: [{ name: "query_transactions", arguments: "{}" }] }),
    );

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "invalid_response" });
    warn.mockRestore();
  });

  it("非对象响应体（数组 / 字符串）⇒ invalid_response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(jsonRes(200, "不是 JSON 对象"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "invalid_response" });
    warn.mockRestore();
  });

  it("200 但 json() 拿不到（空体）⇒ invalid_response（不是静默成功）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(unreadableRes());

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "invalid_response" });
    warn.mockRestore();
  });

  it("status 200 却带 `ai_` 错误码 ⇒ invalid_response（绝不静默成功成空气泡）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // text **非空**：证明判失败的原因不是"回复是空的"，而是"200 里出现了错误码"这个契约违反。
    useFetchQueue(errRes(200, "ai_disabled"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "invalid_response" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("反向：200 但 `error` 是**没有 `ai_` 前缀**的散字段 ⇒ 仍是正常回复", async () => {
    useFetchQueue(
      jsonRes(200, { text: "本月一共 128 元", finish_reason: "stop", error: "some proxy note" }),
    );

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reply.text).toBe("本月一共 128 元");
  });
});

describe("九类失败逐条可测（⑥⑦⑧ 与它们的细分）", () => {
  it.each([
    ["ai_disabled(503)", errRes(503, "ai_disabled"), { kind: "disabled" }],
    ["ai_unauthorized(401)", errRes(401, "ai_unauthorized"), { kind: "unauthorized" }],
    ["ai_bad_request(400)", errRes(400, "ai_bad_request"), { kind: "bad_request" }],
    ["ai_body_too_large(413)", errRes(413, "ai_body_too_large"), { kind: "too_large" }],
    ["ai_upstream_error(502)", errRes(502, "ai_upstream_error"), { kind: "upstream", code: "ai_upstream_error" }],
    ["ai_upstream_timeout(504)", errRes(504, "ai_upstream_timeout"), { kind: "timeout" }],
    ["ai_rate_limited(429)", errRes(429, "ai_rate_limited"), { kind: "rate_limited", scope: "minute" }],
    ["ai_quota_exceeded(429)", errRes(429, "ai_quota_exceeded"), { kind: "rate_limited", scope: "day" }],
    // ⚠️ `ai_invalid_response` 在 **M2 根本不存在**（`service/ai.go:23-31` 只有 7 个码）
    // ⇒ 这一行是**死码向前兼容**：万一适配层以后开始发，502 仍归 `upstream` 且码照带。
    ["ai_invalid_response(502)", errRes(502, "ai_invalid_response"), { kind: "upstream", code: "ai_invalid_response" }],
  ])("%s ⇒ 对应的 failure", async (_label, res, expected) => {
    useFetchQueue(res);

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual<TransportFailure>(expected as TransportFailure);
  });

  it("status:0（fetch 直接抛）⇒ network，且只有一次请求", async () => {
    const mock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", mock);

    // ⚠️ signal **没有**被 abort ⇒ 这是真的网络层失败，不是超时、也不是取消。
    // 「真实超时」那条对照在本节的末尾（同一个 status:0，靠 signal 分开）。
    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "network" });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("调用方的 signal 已 abort ⇒ 一个请求都不发（取消不该走网络）", async () => {
    const mock = useFetchQueue(jsonRes(200, { text: "不该到这里", finish_reason: "stop" }));
    const controller = new AbortController();
    controller.abort();

    const out = await createTransport().chat(MSG, [], controller.signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    // 取消归**独立**的一类（不是 timeout ✗）：`apiFetch` 把取消与网络错都压成 status:0，
    // 所以这条判别必须靠 transport 手里的 signal 自己。
    expect(out.failure).toEqual({ kind: "cancelled" });
    expect(mock).not.toHaveBeenCalled();
  });

  it("在途请求被 abort ⇒ signal 真的传到了 fetch（apiFetch 支持外部 signal 的证据）", async () => {
    const realFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const s = init?.signal;
          if (!s) return;
          if (s.aborted) reject(new Error("aborted"));
          else s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    );
    vi.stubGlobal("fetch", realFetch);
    const controller = new AbortController();

    const pending = createTransport().chat(MSG, [], controller.signal);
    // 断言"fetch 已经被调"而不是"promise 会 resolve"：mock 的 abort 处理是本用例自己写的，
    // 真正要证明的是 apiFetch **没有丢掉**我们的 signal
    await vi.waitFor(() => expect(realFetch).toHaveBeenCalledTimes(1));
    const passed = realFetch.mock.calls[0]![1]!.signal as AbortSignal;
    expect(passed.aborted).toBe(false);

    controller.abort();
    // 同步断言放在 abort() 后面（同 apiTimeout.test.ts 的注释）：实现里外部 signal 是
    // **同步转发**给超时 controller 的，而"只 await 结果"的写法在"signal 被覆盖"的变异下
    // 会因为 fetch 永不 settle 而**既不红也不结束**（vitest 按超时收尾，报 ✓）。
    expect(passed.aborted).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, failure: { kind: "cancelled" } });
  });

  it("**真实超时**（电话打到半死服务端，没人 abort）⇒ timeout，而不是 network、也不是 cancelled", async () => {
    // 这是 F2 的杀手：真实超时与用户取消以前**标签是反的**（超时报 network、取消报 timeout）。
    // 走的是真 `apiFetch`：`fetchWithTimeout` 的 15s 兜底 abort 内部 controller ⇒ fetch 以
    // AbortError 拒 ⇒ `apiFetch` 压成 `{status:0, error:"timeout"}` ⇒ transport 归 `timeout`。
    vi.useFakeTimers();
    try {
      const rawFetch = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            // 真 fetch 被 abort 时抛的是 name === "AbortError" 的 DOMException（mock 必须照抄，
            // 否则 `api.ts` 分不出"超时"和"网络断"）
            const abort = (): void => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            };
            const s = init?.signal as AbortSignal | undefined;
            if (!s) return; // 无 signal 则真挂起
            if (s.aborted) abort();
            else s.addEventListener("abort", abort, { once: true });
          }),
      );
      vi.stubGlobal("fetch", rawFetch);

      const pending = createTransport().chat(MSG, [], new AbortController().signal);
      // 先证明请求真的发出去了（否则"超时"是因为别的路径，用例变空转）
      await Promise.resolve();
      expect(rawFetch).toHaveBeenCalledTimes(1);

      // 推进**恰好** `api.ts` 自己的 15000ms 兜底（不是 vitest 的 20s 测试上限）
      await vi.advanceTimersByTimeAsync(15000);

      await expect(pending).resolves.toEqual({ ok: false, failure: { kind: "timeout" } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("判别顺序：status 优先，body 里的码只用来细分（⑧ 的 M2 text/plain 陷阱）", () => {
  it("401 + 后端直述消息（无 `ai_` 前缀）⇒ unauthorized（靠 status，不靠码）", async () => {
    useFetchQueue(m2ErrorRes(401, "invalid or expired token"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "unauthorized" });
    // 先把**真实形状**钉住（F3：实测 `apiFetch` 对 401 返回 `error` = 后端原文），
    // 否则本用例退化成"码也在、status 也在"的空转：
    // 401 的 Content-Type 是 text/plain，但**内容是 JSON 文本** ⇒ `.json()` 解得出 `error`
    await expect(m2ErrorRes(401, "invalid or expired token").json()).resolves.toEqual({
      error: "invalid or expired token",
    });
    // 这条消息**不带** `ai_` 前缀 —— 那才是"只看 body 会判错"的真正原因（不是"body 不是 JSON"）
    expect(describeFailure(out.failure)).not.toContain("invalid or expired token");
  });

  it("401 的直述消息**不进**面向用户的文案（describeFailure 只给人话）", async () => {
    useFetchQueue(m2ErrorRes(401, "invalid or expired token"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(describeFailure(out.failure)).toBe("登录状态已过期，请重新登录后再试。");
  });

  it("413 + 后端直述消息「request body too large」⇒ too_large（直述消息不是码）", async () => {
    useFetchQueue(m2ErrorRes(413, "request body too large"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "too_large" });
    expect(describeFailure(out.failure)).toBe("这次的对话内容太长了，清空会话记录后再试。");
  });

  it("400 + 后端直述消息「invalid request body」⇒ bad_request", async () => {
    useFetchQueue(m2ErrorRes(400, "invalid request body"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "bad_request" });
    expect(describeFailure(out.failure)).toBe("这条消息没能发出去，换个说法试试。");
  });

  it("401 且 body 里是别的码 ⇒ 仍看 status（unauthorized，不是被码带走）", async () => {
    useFetchQueue(errRes(401, "ai_rate_limited"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "unauthorized" });
  });

  it("400 且 body 里是 ai_disabled ⇒ bad_request（status 是 400 就是 bad_request）", async () => {
    useFetchQueue(errRes(400, "ai_disabled"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "bad_request" });
  });

  it("429 没有码 ⇒ 按分钟级算（不误判成日配额耗尽）", async () => {
    useFetchQueue(errRes(429));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "rate_limited", scope: "minute" });
  });

  it("502 没有码 ⇒ upstream（code 空串），有码则原样保留供排障", async () => {
    useFetchQueue(errRes(502));
    const a = await createTransport().chat(MSG, [], new AbortController().signal);
    expect(a.ok).toBe(false);
    if (a.ok) return;
    expect(a.failure).toEqual({ kind: "upstream", code: "" });

    useFetchQueue(errRes(502, "ai_unreachable"));
    const b = await createTransport().chat(MSG, [], new AbortController().signal);
    expect(b.ok).toBe(false);
    if (b.ok) return;
    expect(b.failure).toEqual({ kind: "upstream", code: "ai_unreachable" });
  });

  it("502 + ai_upstream_auth（不在九类里）⇒ upstream 且保留码", async () => {
    useFetchQueue(errRes(502, "ai_upstream_auth"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "upstream", code: "ai_upstream_auth" });
  });

  it("未预期的 500 ⇒ upstream（一句话兜底，不新造分类、不抛）", async () => {
    useFetchQueue(errRes(500));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "upstream", code: "" });
  });

  it("404（服务端版本旧、没有 /ai 路由）⇒ upstream，不崩", async () => {
    useFetchQueue(errRes(404));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "upstream", code: "" });
  });

  it("503 却带 ai_upstream_error ⇒ 仍是 disabled（分类由 status 决定，code 带不偏它）", async () => {
    // F4 的杀手：以前这里走 `failureFromCode(code) ?? …` ⇒ 分类**被 code 决定**（判成 upstream ✗），
    // 违反本文件第 2 条纪律。
    useFetchQueue(errRes(503, "ai_upstream_error"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "disabled" });
  });

  it("502 却带 ai_disabled ⇒ 仍是 upstream 且**原码照带**（不丢码）", async () => {
    // F5 的杀手：以前这里要求 `byCode.kind === "upstream"` 才返回它，否则 `code:""` ⇒ 码被丢掉 ✗
    // （与"原样保留 code 供排障"的注释相反）。
    useFetchQueue(errRes(502, "ai_disabled"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "upstream", code: "ai_disabled" });
  });

  it("401 却带 ai_disabled ⇒ 仍是 unauthorized（不是 disabled）", async () => {
    useFetchQueue(errRes(401, "ai_disabled"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "unauthorized" });
  });

  it("413 却带 ai_disabled ⇒ 仍是 too_large", async () => {
    useFetchQueue(errRes(413, "ai_disabled"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "too_large" });
  });

  it("504 却带 ai_disabled ⇒ 仍是 timeout", async () => {
    useFetchQueue(errRes(504, "ai_disabled"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "timeout" });
  });

  it("500 却带 ai_upstream_error ⇒ 仍是兜底 upstream 且 code 为空（未知状态不细分）", async () => {
    useFetchQueue(errRes(500, "ai_upstream_error"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "upstream", code: "" });
  });
});

describe("失败一律是值，不是异常（⑨ 不 throw 的契约）", () => {
  it("每一种失败都返回 ok:false（没有任何一种会抛）", async () => {
    const cases: [string, Response][] = [
      ["503 ai_disabled", errRes(503, "ai_disabled")],
      ["401", errRes(401)],
      ["400", errRes(400)],
      ["413", errRes(413)],
      ["502 ai_upstream_error", errRes(502, "ai_upstream_error")],
      ["504", errRes(504)],
      ["429 ai_rate_limited", errRes(429, "ai_rate_limited")],
      ["429 ai_quota_exceeded", errRes(429, "ai_quota_exceeded")],
      ["200 但响应体读不出来", unreadableRes()],
    ];
    for (const [label, res] of cases) {
      useFetchQueue(res);
      const out = await createTransport().chat(MSG, [], new AbortController().signal);
      expect(out.ok, `${label} 应当判失败：${JSON.stringify(out)}`).toBe(false);
    }

    // 同一条路径喂一份合法响应 ⇒ ok:true（防空转：上面的循环不是因为链路上恒失败才全 false）
    useFetchQueue(jsonRes(200, { text: "好", finish_reason: "stop" }));
    const ok = await createTransport().chat(MSG, [], new AbortController().signal);
    expect(ok.ok).toBe(true);
  });

  it("apiFetch reject（将来它变卦抛异常）也不会冒到编排循环", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("boom");
      }),
    );
    await expect(
      createTransport().chat(MSG, [], new AbortController().signal),
    ).resolves.toEqual({ ok: false, failure: { kind: "network" } });
  });

  it("三条失败路径都写 console（F8：catch 也要打，否则抛出的原因在 console 里看不到）", async () => {
    // ① `apiFetch` 的 await 真的抛出来：用**循环引用**的请求体让 `JSON.stringify` 在
    //    try 内抛（`getBaseUrl()` 抛的那条够不到 —— 它就是 catch 的来源，没有 setter 能置空）。
    const circular: { role: "user"; content: string; self?: unknown } = {
      role: "user",
      content: "x",
    };
    circular.self = circular;
    const warnThrow = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      createTransport().chat([circular], [], new AbortController().signal),
    ).resolves.toEqual({ ok: false, failure: { kind: "network" } });
    expect(warnThrow).toHaveBeenCalledWith(expect.stringContaining("chat"));
    warnThrow.mockRestore();

    // ② 非 200
    const warnHttp = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(errRes(401, "ai_upstream_error"));
    await createTransport().chat(MSG, [], new AbortController().signal);
    expect(warnHttp).toHaveBeenCalledWith(expect.stringContaining("unauthorized"));
    warnHttp.mockRestore();

    // ③ 形状坏
    const warnShape = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(jsonRes(200, [1, 2, 3]));
    await createTransport().chat(MSG, [], new AbortController().signal);
    expect(warnShape).toHaveBeenCalledWith(expect.stringContaining("形状"));
    warnShape.mockRestore();
  });
});

describe("401 不重试：refresh 单飞是 api.ts 的职责（⑤）", () => {
  it("401 ⇒ 只发一次请求（transport 不叠加自己的重试）", async () => {
    const mock = useFetchQueue(errRes(401, "ai_unauthorized"));

    const out = await createTransport().chat(MSG, [], new AbortController().signal);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.failure).toEqual({ kind: "unauthorized" });
    // 无 token 时 apiFetch 不会走 refresh 分支；这条钉的是"transport 自己别重试"
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("describeFailure：给人看的中文，不泄漏后端原文/码/堆栈", () => {
  const ALL: TransportFailure[] = [
    { kind: "network" },
    { kind: "timeout" },
    { kind: "cancelled" },
    { kind: "unauthorized" },
    { kind: "disabled" },
    { kind: "rate_limited", scope: "minute" },
    { kind: "rate_limited", scope: "day" },
    { kind: "too_large" },
    { kind: "bad_request" },
    { kind: "upstream", code: "ai_upstream_auth" },
    { kind: "invalid_response" },
  ];

  it("每一类都有非空中文，且互不相同（分钟级与日配额必须是两句）", () => {
    const texts = ALL.map(describeFailure);
    for (const t of texts) {
      expect(t.length).toBeGreaterThan(0);
      expect(t).toMatch(/[\u4e00-\u9fa5]/); // 至少含中文
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("文案里不出现 `ai_` 码、不出现 kind 名（面向普通用户）", () => {
    for (const f of ALL) {
      const t = describeFailure(f);
      expect(t).not.toContain("ai_");
      expect(t).not.toContain(f.kind);
      expect(t).not.toContain("Error");
      expect(t).not.toContain("undefined");
    }
  });
});

describe("fetchAiStatus（⑨）", () => {
  it("enabled:false ⇒ {enabled:false, model:null, host:null}", async () => {
    const mock = useFetchQueue(jsonRes(200, { enabled: false, model: null, host: null }));

    const s = await fetchAiStatus();

    expect(s).toEqual({ enabled: false, model: null, host: null });
    expect(mock.mock.calls[0]![0]).toBe(`${BASE}/ai/status`);
    expect(mock.mock.calls[0]![1].method).toBeUndefined(); // GET（默认）
  });

  it("enabled:true 且给全 ⇒ 三个字段都带出来", async () => {
    useFetchQueue(
      jsonRes(200, { enabled: true, model: "deepseek-chat", host: "api.deepseek.com" }),
    );

    await expect(fetchAiStatus()).resolves.toEqual({
      enabled: true,
      model: "deepseek-chat",
      host: "api.deepseek.com",
    });
  });

  it("host 缺失 / 空串 ⇒ host:null（上层据此不显示隐私卡、也不允许开启）", async () => {
    useFetchQueue(jsonRes(200, { enabled: true, model: "deepseek-chat" }));
    await expect(fetchAiStatus()).resolves.toEqual({
      enabled: true,
      model: "deepseek-chat",
      host: null,
    });

    useFetchQueue(jsonRes(200, { enabled: true, model: "deepseek-chat", host: "" }));
    const s = await fetchAiStatus();
    expect(s.host).toBeNull();
    expect(s.enabled).toBe(true);
  });

  it("/ai/status 的 429 不算额度耗尽：enabled:false + rate_limited/minute，不抛", async () => {
    useFetchQueue(errRes(429, "ai_rate_limited"));

    const s = await fetchAiStatus();

    expect(s.enabled).toBe(false);
    expect(s.failure).toEqual({ kind: "rate_limited", scope: "minute" });
  });

  it("网络失败 / 401 / 500 ⇒ enabled:false + failure，而不是抛", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await expect(fetchAiStatus()).resolves.toEqual({
      enabled: false,
      model: null,
      host: null,
      failure: { kind: "network" },
    });

    useFetchQueue(errRes(401));
    const a = await fetchAiStatus();
    expect(a.enabled).toBe(false);
    expect(a.failure).toEqual({ kind: "unauthorized" });

    useFetchQueue(errRes(500));
    const b = await fetchAiStatus();
    expect(b.enabled).toBe(false);
    expect(b.failure).toEqual({ kind: "upstream", code: "" });
  });

  it("响应体不是对象 ⇒ enabled:false（不把坏响应当成启用）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useFetchQueue(jsonRes(200, "ok"));

    const s = await fetchAiStatus();

    expect(s.enabled).toBe(false);
    expect(s.host).toBeNull();
    warn.mockRestore();
  });

  it("形状坏（不是对象 / `enabled` 不是布尔）⇒ 带 failure:invalid_response", async () => {
    // 上层（`aiChat.refreshStatus`）靠这个 `failure` 把「这次探测不可判定」与
    // 「服务端明确说没配」分开：前者要**保留上一次已知状态**（第 47 条，否则 429 会把
    // 已确认可用的 tab 关掉），后者才关 tab。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    useFetchQueue(jsonRes(200, "ok"));
    await expect(fetchAiStatus()).resolves.toEqual({
      enabled: false,
      model: null,
      host: null,
      failure: { kind: "invalid_response" },
    });

    // 旧版服务端回了空 body：`enabled` 缺字段时 `readStatusData` 会默默给 false，
    // 那会被上层读成「明确说没配」⇒ 一个空 body 就能关掉用户的 tab ✗
    useFetchQueue(jsonRes(200, {}));
    await expect(fetchAiStatus()).resolves.toEqual({
      enabled: false,
      model: null,
      host: null,
      failure: { kind: "invalid_response" },
    });
    warn.mockRestore();
  });

  it("只发一次请求：不轮询（status 与 chat 共用一个每分钟桶）", async () => {
    const mock = useFetchQueue(jsonRes(200, { enabled: true, model: "m", host: "h" }));

    await fetchAiStatus();

    expect(mock).toHaveBeenCalledTimes(1);
  });
});
