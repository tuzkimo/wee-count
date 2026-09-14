// src/router/lockGuard.ts
// 守卫决策做成纯函数，便于脱离 router 实例单测。

export interface LockGuardState {
  isLocked: boolean;
}

export interface UnlockRedirect {
  path: string;
  query: { redirect: string };
  replace: true;
}

/**
 * 消毒解锁后的回跳目标，防开放重定向与死循环。
 * 只接受站内绝对路径：以单个 `/` 开头，且不是 `/unlock` 自身。
 */
export function sanitizeRedirect(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  if (raw === "/unlock" || raw.startsWith("/unlock?") || raw.startsWith("/unlock/")) return "/";
  return raw;
}

/** 返回 `true` 表示放行，返回重定向对象表示拦到解锁页。 */
export function resolveLockRedirect(
  path: string,
  state: LockGuardState,
  publicPages: readonly string[],
): true | UnlockRedirect {
  if (publicPages.includes(path)) return true;
  if (!state.isLocked) return true;
  return { path: "/unlock", query: { redirect: sanitizeRedirect(path) }, replace: true };
}
