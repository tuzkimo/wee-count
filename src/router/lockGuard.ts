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
 * 解锁态下把**残留的** `/unlock` 导航原地换走（回它自己带的回跳目标）。
 *
 * 只有 `path` 与 `replace: true`：没有回跳目标时由 `sanitizeRedirect` 兜成 `/`；
 * `replace` 不可改成 `push` —— 否则那条解锁页条目还留在历史栈里，按返回键又回到它。
 */
export interface StaleUnlockRedirect {
  path: string;
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
 * 但它**只在锁定态**放行 —— 解锁态下它是残留条目，见 `resolveLockRedirect`。
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

/**
 * 从 `/unlock?redirect=…` 里取回跳原文（解码由 `URLSearchParams` 负责）。
 * 取不到 / 格式不合法一律交给 `sanitizeRedirect` 兜成 `/` —— 这里是**不可信输入**
 * （用户可以直接深链 `/unlock?redirect=<任意值>`），所以不在这里做任何判断。
 */
function redirectOf(fullPath: string): unknown {
  const queryAt = fullPath.indexOf("?");
  if (queryAt === -1) return undefined;
  return new URLSearchParams(fullPath.slice(queryAt + 1)).get("redirect");
}

/** 返回 `true` 表示放行，返回重定向对象表示拦到解锁页。 */
export function resolveLockRedirect(
  target: LockGuardTarget,
  state: LockGuardState,
  allowedPages: readonly string[],
): true | UnlockRedirect | StaleUnlockRedirect {
  if (allowedPages.includes(target.path)) {
    if (state.isLocked) return true;
    // 解锁态下 `/unlock` **不放行**：它是残留条目，而不是一个该看的页面。
    //
    // 真机上它是这么来的：`UnlockPage.leave()` 先 `unlock()`（同步翻转 isLocked ⇒ 唤醒
    // 收件箱补拉的 watch），再 fire-and-forget 地 `replace(回跳目标)`；补拉紧接着
    // `push("/ai")`，而 vue-router 里后发起的导航会**取消**前一个 ⇒ 那条 replace 没落地，
    // `/unlock` 留在历史栈里。锁明明已经开了，用户按一次返回却又回到解锁页。
    //
    // 与其只堵住那一处竞态（谁先落地取决于 SQLite IPC 与解码耗时的赛跑，堵不干净），
    // 不如在这里收口："解锁态下不存在解锁页"。深链、WebView 重载、手输 URL 留下的残条
    // 也一并兜住。必须 `replace`：`push` 的话返回键还是能回到它。
    return { path: sanitizeRedirect(redirectOf(target.fullPath)), replace: true };
  }
  if (!state.isLocked) return true;
  return { path: "/unlock", query: { redirect: sanitizeRedirect(target.fullPath) }, replace: true };
}
