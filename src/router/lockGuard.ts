// src/router/lockGuard.ts
// 守卫决策做成纯函数，便于脱离 router 实例单测。

export interface LockGuardState {
  isLocked: boolean;
}

/**
 * 导航目标。
 *
 * `path` 与 `fullPath` 必须分开传，二者用途不同、不可互换：
 * - 窄名单按 `path` 匹配——`/unlock` 被拦后重定向出的 `fullPath` 是
 *   `/unlock?redirect=…`，若拿它去匹配窄名单就匹配不上，会被再拦一次，
 *   形成无限重定向；
 * - 回跳参数取 `fullPath`——只取 `path` 会丢掉深链的 query。
 */
export interface LockGuardTarget {
  path: string;
  fullPath: string;
}

export interface UnlockRedirect {
  path: string;
  query: { redirect: string };
  replace: true;
}

/**
 * 锁定态下唯一放行的页面。
 *
 * 这是**锁专用**的窄名单，与登录守卫的 `publicPages` 刻意分开。复用 `publicPages`
 * 会让锁定态直接放行两条真实数据出口：
 * - `/backup`：会话可经 `localStorage.current_user_id` 无口令恢复，随后全量导出账目；
 * - `/bind-sync`：页面输入框里填的地址会成为上报目标，本地全量账本被 POST 过去。
 *
 * 忘记 PIN 的出路是任务 10 的账户密码路径，不是这里的公共页面。
 * `/unlock` 必须在列，否则跳转到解锁页会被守卫再次拦截，形成无限重定向。
 */
export const LOCK_ALLOWED_PAGES = ["/unlock"] as const;

/**
 * 消毒解锁后的回跳目标，防开放重定向与死循环。
 *
 * 只接受站内绝对路径：原文以 `/` 开头（`\evil.com` 这类不算），且反斜杠规范化成 `/`
 * 之后仍**只有一个**前导 `/`，并且不是 `/unlock` 自身。
 * `/\evil.com` 会在规范化后变成 `//evil.com`（协议相对地址），这正是要拦的形态：
 * 它在部分解析器里会被当成外站，逐字检查又看不出来。
 * 先看原文、再看规范化结果，两步都过才算站内路径——这样既不会把「本来不是路径的值」
 * 改写成路径，也不会漏掉被反斜杠伪装的协议相对地址。
 */
export function sanitizeRedirect(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  if (!raw.startsWith("/")) return "/";
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("//")) return "/";
  if (
    normalized === "/unlock" ||
    normalized.startsWith("/unlock?") ||
    normalized.startsWith("/unlock/")
  ) {
    return "/";
  }
  return normalized;
}

/** 返回 `true` 表示放行，返回重定向对象表示拦到解锁页。 */
export function resolveLockRedirect(
  target: LockGuardTarget,
  state: LockGuardState,
  allowedPages: readonly string[],
): true | UnlockRedirect {
  if (allowedPages.includes(target.path)) return true;
  if (!state.isLocked) return true;
  return { path: "/unlock", query: { redirect: sanitizeRedirect(target.fullPath) }, replace: true };
}
