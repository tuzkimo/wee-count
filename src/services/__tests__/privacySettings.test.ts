// src/services/__tests__/privacySettings.test.ts
//
// 截屏防护的持久化：独立键为唯一真相源 + 从 1.1.x 的 app_lock 里一次性迁移。
// 环境探测是显式的（"__TAURI_INTERNALS__" in window），与 lockStorage 测试同一套路。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

import {
  SCREENSHOT_PROTECTION_DEFAULT,
  readScreenshotProtection,
  writeScreenshotProtection,
} from "@/services/privacySettings";

const KEY = "screenshot_protection";
const LEGACY_KEY = "app_lock";

/** 一份 1.1.x 的锁配置：截屏防护当时是它的一个字段。 */
function legacyConfig(screenshotProtection: boolean): string {
  return JSON.stringify({
    type: "pin",
    hash: "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy",
    biometric_enabled: false,
    auto_lock_seconds: 60,
    screenshot_protection: screenshotProtection,
  });
}

let warnSpy: ReturnType<typeof vi.spyOn>;

describe("privacySettings（浏览器 / 非 Tauri 环境，用 localStorage）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("什么都没存过时是默认值（从严开启）", async () => {
    expect(SCREENSHOT_PROTECTION_DEFAULT).toBe(true);
    await expect(readScreenshotProtection()).resolves.toBe(true);
  });

  it("独立键的取值就是真相，读写一致", async () => {
    await writeScreenshotProtection(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);
    await expect(readScreenshotProtection()).resolves.toBe(false);
  });

  it("迁移：独立键缺失时采纳 app_lock 里的旧值，并写回独立键", async () => {
    localStorage.setItem(LEGACY_KEY, legacyConfig(false));

    await expect(readScreenshotProtection()).resolves.toBe(false);

    // 写回这一步不能省：否则用户下次关掉应用锁会删掉 app_lock，
    // 「他特意关掉的截屏防护」就会自己打开。
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);
  });

  it("迁移只在独立键缺失时发生：两边冲突时以独立键为准", async () => {
    localStorage.setItem(LEGACY_KEY, legacyConfig(true));
    localStorage.setItem(KEY, JSON.stringify(false));

    await expect(readScreenshotProtection()).resolves.toBe(false);
    // 没有把 legacy 的值反写回来。
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);
  });

  it("独立键在但读不懂时回落默认值，且**不覆盖**它（可能是别的版本写的）", async () => {
    localStorage.setItem(KEY, JSON.stringify("false"));

    await expect(readScreenshotProtection()).resolves.toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe("false");
  });

  it("app_lock 损坏时不采纳任何旧值，回落默认值", async () => {
    localStorage.setItem(LEGACY_KEY, "{ not json");
    await expect(readScreenshotProtection()).resolves.toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("写失败必须 reject（用户主动动作不许假确认）", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });

    await expect(writeScreenshotProtection(false)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("迁移写回失败不影响本次返回值：仍按旧值生效，下次启动再试", async () => {
    localStorage.setItem(LEGACY_KEY, legacyConfig(false));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === LEGACY_KEY ? legacyConfig(false) : null),
      setItem: () => {
        throw new Error("SecurityError: 存储被禁用");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });

    await expect(readScreenshotProtection()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("读路径永不抛错：getItem 抛 SecurityError 时回落默认值", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: 存储被禁用");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });

    await expect(readScreenshotProtection()).resolves.toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});
