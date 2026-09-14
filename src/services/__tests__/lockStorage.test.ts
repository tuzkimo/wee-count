import { describe, it, expect, vi, beforeEach } from "vitest";

// 非 Tauri 环境下 load() 抛错 → lockStorage 回落 localStorage。
// 这里显式模拟该回落分支，测试不依赖 Tauri 运行时。
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

import {
  clearAppLock,
  parseAppLock,
  readAppLock,
  writeAppLock,
  type AppLockConfig,
} from "@/services/lockStorage";

const valid: AppLockConfig = {
  type: "pin",
  hash: "$2b$10$abcdefghijklmnopqrstuv",
  biometric_enabled: false,
  auto_lock_seconds: 60,
  screenshot_protection: true,
};

describe("lockStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("未写入时返回 null", async () => {
    expect(await readAppLock()).toBeNull();
  });

  it("写入后可读回，且字段一致", async () => {
    await writeAppLock(valid);
    expect(await readAppLock()).toEqual(valid);
  });

  it("clearAppLock 之后返回 null", async () => {
    await writeAppLock(valid);
    await clearAppLock();
    expect(await readAppLock()).toBeNull();
  });

  it("数据损坏时返回 null（不抛错，视为未配置锁）", async () => {
    localStorage.setItem("app_lock", "{ not json");
    expect(await readAppLock()).toBeNull();
  });

  it("parseAppLock 拒绝结构不合法的配置", () => {
    expect(parseAppLock(null)).toBeNull();
    expect(parseAppLock({})).toBeNull();
    expect(parseAppLock({ ...valid, type: "gesture" })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "" })).toBeNull();
    expect(parseAppLock({ ...valid, auto_lock_seconds: "60" })).toBeNull();
    expect(parseAppLock({ ...valid, screenshot_protection: 1 })).toBeNull();
  });

  it("parseAppLock 接受 pattern 类型", () => {
    expect(parseAppLock({ ...valid, type: "pattern" })?.type).toBe("pattern");
  });
});
