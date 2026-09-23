// src/services/ai/__tests__/transport.statusCatchTrace.test.ts
//
// T1 / ledger Ruling 1 的**最贵教训**：任何"吞异常并降级"的分支都必须留痕。
//
// 真机事故的完整链路（`fetchAiStatus` 的 catch）：
//   `App.vue` 启动就探 ⇒ `setBaseUrl()` 还没被 auth 的异步恢复调到 ⇒ `apiFetch` 里
//   `getBaseUrl()`（`api.ts:19-22`）**直接抛** ⇒ 这个 catch 把它变成
//   `{failure:{kind:"network"}}` **且一个字都不打** ⇒ Network 无请求（异常在 fetch 之前）、
//   Console 空、后端无日志 ⇒ 整条失败对三种观测手段**同时隐身**。
//
// 为什么单开一个文件：`transport.test.ts` 的 `beforeEach` 会 `setBaseUrl(BASE)`，
// 而"base URL 未配置"这一档**必须**在一个从未配置过 base URL 的模块里测（`api.ts` 的
// `baseUrl` 是模块级状态，没有 setter 能把它置回 null）。在那个文件里加用例只能靠
// 顺序依赖，脆且不可读；这里整文件不配置 base URL，条件由模块隔离本身保证。
import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * 只把 `apiFetch` 包一层（默认走**真实现**），其余保持原样。
 *
 * 为什么走真实现：本文件要测的第一档恰恰是"真 `apiFetch` 在 base URL 未配置时抛"，
 * 用替身抛异常只能测到"我假设它会抛"。用例 2 再用 `mockRejectedValueOnce` 换别的抛出
 * 原因（证明日志内容跟着原因走，而不是一句写死的文案）。
 */
vi.mock("@/services/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/api")>();
  return { ...actual, apiFetch: vi.fn(actual.apiFetch) };
});

import { fetchAiStatus } from "@/services/ai/transport";
import { apiFetch } from "@/services/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchAiStatus 的 catch 必须留痕（Ruling 1）", () => {
  it("base URL 未配置（getBaseUrl 抛）⇒ 仍是 network 失败，但 console.warn 必须写出抛出原因", async () => {
    // 本文件从不 `setBaseUrl` ⇒ 真 `apiFetch` 走 `getBaseUrl()` 的 throw 分支
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const s = await fetchAiStatus();

    // 降级行为本身不变（契约：永不抛，安全的一侧）
    expect(s).toEqual({
      enabled: false,
      model: null,
      host: null,
      failure: { kind: "network" },
    });
    // 杀手：把 catch 里的 console.warn 删掉（或退回"裸 catch {}"）⇒ 这条变 0 次调用 ⇒ 红。
    // 正则同时钉住两件事：是 **status** 这条路（不是 chat），且原因**逐字**在日志里
    // —— 排障时"base URL 未配置"与"网络层抛"必须分得开。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/\/ai\/status[\s\S]*API base URL not configured/),
    );
  });

  it("别的抛出原因 ⇒ 日志内容是那个原因（不是一句写死的文案）", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("boom-sentinel"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const s = await fetchAiStatus();

    expect(s.failure).toEqual({ kind: "network" });
    // 杀手：把 catch 的日志改成不含原因的固定文案 ⇒ 这条红（它与上一条断言的是
    // 两个不同原因必须产出两条不同日志）。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom-sentinel"));
  });

  it("抛出值没有说明（空 message）也必须留痕 —— 这条分支的价值就是 console 里看得见", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error(""));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetchAiStatus();

    // 杀手：日志写成 `if (reason) console.warn(...)` ⇒ 空 message 时静默 ⇒ 这条红。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("status"));
  });

  it("抛出的根本不是 `Error`（字符串）也必须留痕，且日志里能看出是 `/ai/status` 这条路", async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce("plain-string-failure");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await fetchAiStatus();

    // 杀手：删掉 catch 里的 `console.warn`（退回裸 `catch {}`）⇒ 两条都变 0 次 ⇒ 红。
    // 正则钉住 STATUS_PATH：排障时必须一眼看出"这次是能力探测没发出去"，而不是聊天的失败。
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/ai/status"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plain-string-failure"));
  });
});
