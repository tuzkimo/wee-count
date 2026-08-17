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
