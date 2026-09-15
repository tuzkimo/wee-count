// src/utils/autoLock.ts
// 自动锁定时长判定。刻意不依赖后台定时器——定时器在后台会被系统挂起，
// 策略是「在恢复时判定」，只依赖恢复事件 + 上次活跃时间戳。

export interface AutoLockOption {
  seconds: number;
  label: string;
}

/** 不提供「从不」：不锁的语义由 SecurityPage 的总开关承担，两处并存必然语义打架。 */
export const AUTO_LOCK_OPTIONS: readonly AutoLockOption[] = [
  { seconds: 0, label: "立即" },
  { seconds: 60, label: "1 分钟" },
  { seconds: 300, label: "5 分钟" },
];

/**
 * 取两个时钟结果的较大值。
 *
 * 单用 performance.now() 会漏算设备休眠：Android 上其底层 CLOCK_MONOTONIC
 * 不计入 suspend 时间，手机关屏一小时再打开会被少算成几分钟。
 * 单用 Date.now() 则会被改系统时间缩短。
 *
 * 取 max 后三种情形同时成立：
 * - 设备休眠 → Date.now() 兜住
 * - 系统时间往回调 → performance.now() 兜住
 * - 系统时间往前调 → 得到超大值，直接锁（fail-safe）
 */
export function computeElapsed(
  t0: number,
  p0: number,
  now: number,
  perfNow: number,
): number {
  return Math.max(now - t0, perfNow - p0);
}

/**
 * 判定切走时长是否已达到自动锁定阈值。
 *
 * `autoLockSeconds <= 0`（含 0 与负数）一律视为「切走即锁」：0 是「立即」选项，
 * 负数只可能来自被篡改的配置，两种情况下都不放行。
 */
export function shouldLock(elapsedMs: number, autoLockSeconds: number): boolean {
  if (autoLockSeconds <= 0) return true;
  return elapsedMs >= autoLockSeconds * 1000;
}
