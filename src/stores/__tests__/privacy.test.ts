// src/stores/__tests__/privacy.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

import { usePrivacyStore } from "@/stores/privacy";

const KEY = "screenshot_protection";

describe("privacy store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("初始即默认值（从严开启），与落盘上的真相无关", () => {
    expect(usePrivacyStore().screenshotProtection).toBe(true);
  });

  it("setScreenshotProtection 落盘后才是新值，且 load 读得回来", async () => {
    const privacy = usePrivacyStore();
    await privacy.setScreenshotProtection(false);
    expect(privacy.screenshotProtection).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(false);

    const fresh = usePrivacyStore();
    await fresh.load();
    expect(fresh.screenshotProtection).toBe(false);
  });

  it("落盘失败时 reject 且内存值不变（不做乐观更新）", async () => {
    const privacy = usePrivacyStore();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(privacy.setScreenshotProtection(false)).rejects.toThrow();
    expect(privacy.screenshotProtection).toBe(true);
    warn.mockRestore();
  });

  it("load() 不抛：读不到时回落默认值", async () => {
    const privacy = usePrivacyStore();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: 存储被禁用");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(privacy.load()).resolves.toBeUndefined();
    expect(privacy.screenshotProtection).toBe(true);
    warn.mockRestore();
  });
});
