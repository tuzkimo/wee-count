import { describe, it, expect } from "vitest";
import {
  computeElapsed,
  shouldLock,
  shouldLockOnBoot,
  AUTO_LOCK_OPTIONS,
  type SessionEndRecord,
} from "@/utils/autoLock";

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

/**
 * 冷启动（进程被杀/Activity 重建/WebView 重载）时的门禁判定。
 *
 * 背景：`main.ts` 曾经**无条件**上锁，于是"切走 20 秒回来"只要撞上一次重启就要解锁，
 * 与设置里那个窗口完全无关（真机上每次分享都要求解锁的根因）。
 * 这里的判据把窗口延伸到跨进程：只有"用户自己关的"才无条件上锁。
 */
describe("shouldLockOnBoot", () => {
  const NOW = 1_700_000_000_000;
  /** 默认 authenticated=true ≡ "离开那一刻本段前台期已经过门禁"（解锁过，或启动判定本就不需要锁） */
  const background = (at: number, authenticated = true): SessionEndRecord => ({
    at,
    reason: "background",
    authenticated,
  });

  it("上一段以「切到后台」结束且在窗口内 ⇒ 不上锁（进程被杀/页面重载都不该要求解锁）", () => {
    expect(shouldLockOnBoot(background(NOW - 20_000), NOW, 60)).toBe(false);
  });

  it("窗口边界与 shouldLock 同一套语义：正好到点即锁", () => {
    expect(shouldLockOnBoot(background(NOW - 59_999), NOW, 60)).toBe(false);
    expect(shouldLockOnBoot(background(NOW - 60_000), NOW, 60)).toBe(true);
  });

  it("超出窗口 ⇒ 上锁", () => {
    expect(shouldLockOnBoot(background(NOW - 90_000), NOW, 60)).toBe(true);
  });

  it("「立即」设置（0 秒）⇒ 任何冷启动都上锁", () => {
    expect(shouldLockOnBoot(background(NOW), NOW, 0)).toBe(true);
  });

  it("本段从没解锁过（authenticated=false）⇒ 即使窗口内也上锁", () => {
    // 否则"停在解锁页 → 切后台 → 进程被杀 → 一分钟内点回来"就是一条免口令通道：
    // 从未解锁却因为窗口内被放行，而 router 的守卫只看 isLocked ⇒ 直接渲染真实账目页。
    expect(shouldLockOnBoot(background(NOW - 5_000, false), NOW, 60)).toBe(true);
    expect(shouldLockOnBoot(background(NOW, false), NOW, 300)).toBe(true);
  });

  it("窗口不是有限数（配置被写坏成 undefined/NaN/Infinity）⇒ 从严上锁", () => {
    // NaN 会让 `elapsed >= NaN` 恒为 false（= 永不锁），方向正好反了
    expect(shouldLockOnBoot(background(NOW - 999_999), NOW, Number.NaN)).toBe(true);
    expect(shouldLockOnBoot(background(NOW - 999_999), NOW, Number.POSITIVE_INFINITY)).toBe(true);
  });

  it("用户自己关的（划掉后台/强关）⇒ 无论多近都上锁", () => {
    expect(shouldLockOnBoot({ at: NOW - 1_000, reason: "user_closed", authenticated: false }, NOW, 300)).toBe(true);
    expect(shouldLockOnBoot({ at: NOW, reason: "user_closed", authenticated: true }, NOW, 300)).toBe(true);
  });

  it("没有记录（首次启动 / 缓存被系统清掉）⇒ 从严上锁", () => {
    expect(shouldLockOnBoot(null, NOW, 300)).toBe(true);
  });

  it("记录时间在将来（系统时间被往回调）⇒ 从严上锁", () => {
    expect(shouldLockOnBoot(background(NOW + 5_000), NOW, 300)).toBe(true);
  });

  it("记录时间非法（NaN）⇒ 从严上锁", () => {
    expect(shouldLockOnBoot(background(Number.NaN), NOW, 300)).toBe(true);
  });
});
