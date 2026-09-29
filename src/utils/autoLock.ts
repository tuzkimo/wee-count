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

/**
 * 「上一次会话是怎么结束的」——由原生写盘（`cacheDir/wee-session/session.json`），
 * 前端在**每次启动**时读它，决定本次启动要不要上锁。
 *
 * 为什么必须有 `reason`：`main.ts` 原本无条件上锁，于是"切走 20 秒回来"只要碰上进程被杀 /
 * Activity 重建 / WebView 重载就要解锁一次（真机上的表现就是"每次分享都要解锁"）。
 * 而单纯按时间窗口放行又会放过"用户自己划掉后台"——那是一种明确的"我关掉了"意图，
 * 这两种情形在 JS 侧完全不可区分（都只是页面停止运行），只能由原生判定：它在离开时写这条
 * 记录，并在下次启动时比对任务号（`MainActivity.reconcileTask`，划掉后台会换一个新任务）。
 */
export interface SessionEndRecord {
  /** 会话结束时刻（墙钟毫秒，与 `Date.now()` 同源） */
  at: number;
  /** background = 只是切到后台；user_closed = 用户自己关的（划掉后台 / 从最近任务里清除） */
  reason: "background" | "user_closed";
  /**
   * 离开那一刻，**本段前台期是否已经过了门禁**（用户解锁过，或启动判定本来就不需要锁）。
   *
   * 由原生在 `onStop` 里读前端的 `authenticated` 标记得到。没有这个字段就只剩时间窗口，
   * 于是"停在解锁页没输口令 → 切后台 → 进程被杀 → 一分钟内回来"会直接进业务页
   * （从未解锁却因为窗口内而被放行）。缺字段一律当 `false`（从严）。
   */
  authenticated: boolean;
}

/**
 * 启动门禁判定：**本次启动要不要把用户挡在门外**。
 *
 * 只有"上一段是切到后台、本段曾过门禁、且没超过 `autoLockSeconds`"才放行 —— 与同一会话内
 * `shouldLock` 的窗口是同一个语义，只是把它延伸到了跨进程。其余全部从严（返回 true）：
 * 没有记录（首启 / 缓存被系统清掉）、用户自己关的、**本段从没解锁过**、窗口或时钟异常。
 */
export function shouldLockOnBoot(
  record: SessionEndRecord | null,
  now: number,
  autoLockSeconds: number,
): boolean {
  if (record === null) return true;
  // 窗口本身不可信（undefined/NaN）⇒ 从严。放开这一步等于把判据交给一个非数字。
  if (!Number.isFinite(autoLockSeconds)) return true;
  if (record.reason === "user_closed") return true;
  // 本段前台期从没解锁过 ⇒ 无论多近都必须解锁（否则"停在解锁页"就是一条免口令通道）
  if (!record.authenticated) return true;
  const elapsed = now - record.at;
  // NaN（记录被篡改）或记录在未来（系统时间被往回调）⇒ 无从判断经过多久，从严上锁
  if (!Number.isFinite(elapsed) || elapsed < 0) return true;
  return shouldLock(elapsed, autoLockSeconds);
}
