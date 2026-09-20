// src/services/__tests__/apiTimeout.test.ts
// 回归：在线同步服务 TCP 可达但 HTTP 不响应时，原生 fetch 永久 pending，
// 曾把路由守卫的 await 链挂死导致白屏。fetchWithTimeout 必须能打破这种挂起。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 模拟「TCP 可达但 HTTP 不返回」的服务端：fetch 返回永不主动 resolve 的 promise，
// 仅在 AbortSignal 触发时 reject（与真实 fetch 的 abort 行为一致）。
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (!signal) return; // 无 signal 则真挂起
      if (signal.aborted) reject(new Error("aborted"));
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })
  );
}

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("超时 abort 永久 pending 的 fetch", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { fetchWithTimeout } = await import("@/services/api");
    const p = fetchWithTimeout("http://x/api", {}, 100);
    // 先挂 rejection handler，避免 abort 触发的 reject 在断言前变成 unhandled
    const rejection = p.then(() => null, (e: unknown) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("aborted");
    expect(signal.aborted).toBe(true);
  });

  it("fetch 在超时前返回则不 abort", async () => {
    const resp = { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    vi.stubGlobal("fetch", vi.fn(async () => resp));

    const { fetchWithTimeout } = await import("@/services/api");
    const r = await fetchWithTimeout("http://x/api", {}, 5000);
    expect(r).toBe(resp);
  });

  it("tryRestoreSession 在 fetch 挂起时超时返回 null（不抛错）", async () => {
    vi.stubGlobal("fetch", hangingFetch());

    const api = await import("@/services/api");
    api.setBaseUrl("http://x");
    api.setTokens("u1", "access", "refresh"); // 写入 localStorage 的 refresh_token

    const p = api.tryRestoreSession("u1");
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeNull();
  });
});

describe("fetchWithTimeout 的外部 signal（AI 取消生成靠它）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("外部 signal abort ⇒ 在途 fetch 真的被掐，且用的是超时 controller 那条路径", async () => {
    // 旧实现是 `{ ...init, signal: controller.signal }` ⇒ **外部 signal 被覆盖**、取消静默失效
    // （请求照发、结果照回）。这条用例把这个形态钉住：只断言"传进去的 signal 最后 aborted"
    // 的实现会绿，断言"fetch 的 reject 真发生"才咬得住。
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const api = await import("@/services/api");
    api.setBaseUrl("http://x");

    const controller = new AbortController();
    const before = api.fetchWithTimeout("http://x/api", { signal: controller.signal }, 15000);
    const rejection = before.then(() => "resolved", (e: unknown) => e);

    const passed = fetchMock.mock.calls[0]![1].signal as AbortSignal;
    expect(passed.aborted).toBe(false);

    controller.abort();

    // ⚠️ 断言必须**同步**跟在 abort() 后面：转发是同步的（listener 里直接 abort controller）。
    // 只写 `await expect(before).rejects.toThrow()` 的版本**杀不掉"覆盖 signal"的变异** ——
    // 那时 fetch 永不 settle，测试会一直挂着，最后 vitest 按"测试超时"收尾而**不是失败**
    // （实测：变异下这条用例 15008ms 后仍报 ✓）。所以判别力来自这一条同步断言。
    expect(passed.aborted).toBe(true);

    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("aborted");
  });

  it("已经 abort 过的 signal ⇒ fetch 收到的是**已 abort** 的 signal，请求当场结束", async () => {
    vi.useFakeTimers();
    try {
      // 旧实现只靠 `addEventListener`：signal 已经 abort 过就**不会再派发事件** ⇒ 这个
      // controller 永远不会 abort ⇒ 请求照发、一直挂着，靠 api.ts 自己的 15s 兜底收尾。
      // 判别力**必须**是 abort() 之后那条**同步**断言：只写 `await expect(...).rejects`
      // 的版本在"删掉 already-aborted 分支"的变异下**整份 49 条全绿**（实测该用例
      // 15004ms，那 15s 就是兜底超时，不是 vitest 的 20s 上限）。
      const fetchMock = hangingFetch();
      vi.stubGlobal("fetch", fetchMock);
      const api = await import("@/services/api");
      api.setBaseUrl("http://x");

      const controller = new AbortController();
      controller.abort();

      const p = api.fetchWithTimeout("http://x/api", { signal: controller.signal }, 15000);
      const rejection = p.then(() => "resolved", (e: unknown) => e);

      // 同步：分支存在与否的唯一判据
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]![1].signal as AbortSignal).aborted).toBe(true);

      const err = await rejection;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("apiFetch 网络异常", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("网络异常返回 {ok:false,status:0,error:'network error'} 而非 throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));

    const api = await import("@/services/api");
    api.setBaseUrl("http://example.com");
    api.clearTokens();

    const res = await api.apiFetch("/x");

    expect(res).toEqual({ ok: false, status: 0, error: "network error" });
  });
});
