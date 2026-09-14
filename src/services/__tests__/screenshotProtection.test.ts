import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `vi.mock` 的工厂会被提升到文件顶部，所以替身必须用 `vi.hoisted` 一起提升，
// 否则工厂执行时 `invoke` 还在 TDZ 里（vitest 会直接报 Cannot access before initialization）。
const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_cmd?: string, _args?: unknown): Promise<undefined> => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { applyScreenshotProtection } from "@/services/screenshotProtection";

/**
 * 截屏防护的接线测试。
 *
 * 这一层只有两个契约：把布尔值原样送到 Rust command；任何失败都不许外泄成 rejection。
 * 后者是硬要求——`main.ts` 在 `app.mount()` 之前调用它，抛出去就是白屏。
 */
describe("applyScreenshotProtection", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("调用 Rust command 并传 enabled", async () => {
    await applyScreenshotProtection(true);
    expect(invoke).toHaveBeenCalledWith("set_screenshot_protection", { enabled: true });
  });

  it("关闭时传 false", async () => {
    await applyScreenshotProtection(false);
    expect(invoke).toHaveBeenCalledWith("set_screenshot_protection", { enabled: false });
  });

  it("非 Tauri 环境（invoke 抛错）时静默忽略，不阻断启动", async () => {
    invoke.mockRejectedValueOnce(new Error("not in tauri"));
    await expect(applyScreenshotProtection(true)).resolves.toBeUndefined();
  });

  it("invoke 失败时留一条告警日志，便于排障", async () => {
    invoke.mockRejectedValueOnce(new Error("not in tauri"));
    await applyScreenshotProtection(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("每个开关各调用一次，不重复下发", async () => {
    await applyScreenshotProtection(true);
    await applyScreenshotProtection(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("Rust command 返回 Err 时同样不外泄", async () => {
    invoke.mockRejectedValueOnce("FLAG_SECURE 设置失败");
    await expect(applyScreenshotProtection(false)).resolves.toBeUndefined();
  });
});
