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
 * 这一层只有两个契约：把布尔值原样送到 Rust command；**失败必须 reject**。
 * 后者是 R69 的裁决：Rust 侧已把系统层失败沿 `Err` 冒泡，这里若再吞一次，
 * `SecurityPage.vue` 那条「截屏防护设置失败，请重试」就永远是死代码 ——
 * 用户在界面上关掉防护、系统层其实还开着，且零反馈。
 * rejection 不会白屏：两个调用方（`main.ts` / `SecurityPage.vue`）都自有 try/catch。
 */
describe("applyScreenshotProtection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockImplementation(async () => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("调用 Rust command 并传 enabled", async () => {
    await applyScreenshotProtection(true);
    expect(invoke).toHaveBeenCalledWith("set_screenshot_protection", { enabled: true });
  });

  it("关闭时传 false", async () => {
    await applyScreenshotProtection(false);
    expect(invoke).toHaveBeenCalledWith("set_screenshot_protection", { enabled: false });
  });

  it("非 Tauri 环境（invoke 抛错）时把失败外泄给调用方，由调用方决定怎么呈现", async () => {
    invoke.mockRejectedValueOnce(new Error("not in tauri"));
    await expect(applyScreenshotProtection(true)).rejects.toThrow("not in tauri");
  });

  it("Rust command 返回 Err（字符串）时同样 reject，且原样带出原因", async () => {
    invoke.mockRejectedValueOnce("设置 FLAG_SECURE 失败: jni: null pointer");
    await expect(applyScreenshotProtection(false)).rejects.toBe(
      "设置 FLAG_SECURE 失败: jni: null pointer",
    );
  });

  it("失败不被吞掉：调用方 await 之后不会继续往下走", async () => {
    invoke.mockRejectedValueOnce(new Error("FLAG_SECURE 设置失败"));
    let reached = false;
    try {
      await applyScreenshotProtection(false);
      reached = true;
    } catch {
      // 预期路径
    }
    expect(reached).toBe(false);
  });

  it("每个开关各调用一次，不重复下发", async () => {
    await applyScreenshotProtection(true);
    await applyScreenshotProtection(false);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
