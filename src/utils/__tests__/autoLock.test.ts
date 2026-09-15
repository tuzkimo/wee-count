import { describe, it, expect } from "vitest";
import { computeElapsed, shouldLock, AUTO_LOCK_OPTIONS } from "@/utils/autoLock";

describe("computeElapsed", () => {
  it("正常前后台切换时两个时钟一致", () => {
    expect(computeElapsed(1_000, 5_000, 61_000, 65_000)).toBe(60_000);
  });

  it("设备休眠时单调钟少算，取 Date.now() 的结果（Android CLOCK_MONOTONIC 不计 suspend）", () => {
    // 墙钟走了 10 分钟，performance.now() 只走了 2 秒
    expect(computeElapsed(0, 0, 600_000, 2_000)).toBe(600_000);
  });

  it("用户把系统时间往回调时，取单调钟的结果", () => {
    // 墙钟倒退了 5 分钟，单调钟仍正确走了 30 秒
    expect(computeElapsed(600_000, 0, 0, 30_000)).toBe(30_000);
  });

  it("用户把系统时间往前调时得到超大值（fail-safe，直接锁）", () => {
    expect(computeElapsed(0, 0, 86_400_000, 1_000)).toBe(86_400_000);
  });
});

describe("shouldLock", () => {
  it("达到阈值即锁", () => {
    expect(shouldLock(60_000, 60)).toBe(true);
    expect(shouldLock(59_999, 60)).toBe(false);
  });

  it("autoLockSeconds 为 0 表示切走即锁", () => {
    expect(shouldLock(0, 0)).toBe(true);
    expect(shouldLock(1, 0)).toBe(true);
  });

  it("负数视为立即锁定（配置被篡改时不放行）", () => {
    expect(shouldLock(0, -1)).toBe(true);
  });
});

describe("AUTO_LOCK_OPTIONS", () => {
  it("只提供立即 / 1 分钟 / 5 分钟，不含「从不」（「不锁」由总开关承担）", () => {
    expect(AUTO_LOCK_OPTIONS.map((o) => o.seconds)).toEqual([0, 60, 300]);
  });
});
