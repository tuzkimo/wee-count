import { describe, it, expect } from "vitest";
import {
  LOCK_ALLOWED_PAGES,
  resolveLockRedirect,
  sanitizeRedirect,
  type LockGuardTarget,
} from "@/router/lockGuard";

/** 登录守卫的公共页面。锁定态**不**放行这些——见下面对应用例。 */
const PUBLIC_PAGES = ["/welcome", "/welcome/local", "/login", "/bind-sync", "/backup"];

function target(fullPath: string): LockGuardTarget {
  return { path: fullPath.split(/[?#]/, 1)[0], fullPath };
}

describe("sanitizeRedirect", () => {
  it("保留站内绝对路径（含 query）", () => {
    expect(sanitizeRedirect("/accounts")).toBe("/accounts");
    expect(sanitizeRedirect("/accounts/abc?x=1")).toBe("/accounts/abc?x=1");
  });

  it("拒绝非字符串、外站与协议相对地址", () => {
    expect(sanitizeRedirect(undefined)).toBe("/");
    expect(sanitizeRedirect(null)).toBe("/");
    expect(sanitizeRedirect(42)).toBe("/");
    expect(sanitizeRedirect("https://evil.example")).toBe("/");
    expect(sanitizeRedirect("//evil.example")).toBe("/");
    expect(sanitizeRedirect("accounts")).toBe("/");
  });

  it("规范化反斜杠，堵住 /\\evil.com 与 \\\\evil 这类写法", () => {
    // 下面每条同时给出源码写法与运行时字符串，避免读用例时数不清反斜杠：
    expect(sanitizeRedirect("/\\evil.com")).toBe("/"); // 运行时 /\evil.com
    expect(sanitizeRedirect("\\\\evil.com")).toBe("/"); // 运行时 \\evil.com
    expect(sanitizeRedirect("\\evil.com")).toBe("/"); // 运行时 \evil.com
    expect(sanitizeRedirect("\\/evil.com")).toBe("/"); // 运行时 \/evil.com
    // 规范化不得误伤正常路径
    expect(sanitizeRedirect("/accounts/abc?x=1")).toBe("/accounts/abc?x=1");
  });

  it("拒绝回跳 /unlock 自身，避免死循环", () => {
    expect(sanitizeRedirect("/unlock")).toBe("/");
    expect(sanitizeRedirect("/unlock?redirect=/accounts")).toBe("/");
  });
});

describe("resolveLockRedirect", () => {
  it("未锁定一律放行", () => {
    expect(resolveLockRedirect(target("/accounts"), { isLocked: false }, LOCK_ALLOWED_PAGES)).toBe(
      true,
    );
  });

  it("未锁定时公共页面照常放行", () => {
    for (const path of PUBLIC_PAGES) {
      expect(resolveLockRedirect(target(path), { isLocked: false }, LOCK_ALLOWED_PAGES)).toBe(true);
    }
  });

  it("锁定时重定向到 /unlock 并带上原目标", () => {
    expect(resolveLockRedirect(target("/accounts"), { isLocked: true }, LOCK_ALLOWED_PAGES)).toEqual(
      {
        path: "/unlock",
        query: { redirect: "/accounts" },
        replace: true,
      },
    );
  });

  it("锁定时公共页面同样被拦——它们不是锁的逃生口", () => {
    // 这条断言的方向是刻意反的：`/backup` 可无口令恢复会话后全量导出账目，
    // `/bind-sync` 会把本地全量账本 POST 到页面填的任意地址。
    // 若它们出现在 LOCK_ALLOWED_PAGES 里，本用例必须变红。
    for (const path of PUBLIC_PAGES) {
      expect(resolveLockRedirect(target(path), { isLocked: true }, LOCK_ALLOWED_PAGES)).toEqual({
        path: "/unlock",
        query: { redirect: path },
        replace: true,
      });
    }
  });

  it("锁定时 /unlock 放行，带 query 的 /unlock 也放行（否则无限重定向）", () => {
    expect(resolveLockRedirect(target("/unlock"), { isLocked: true }, LOCK_ALLOWED_PAGES)).toBe(
      true,
    );
    // 窄名单按 path 匹配：被拦后重定向出的目标 fullPath 是 /unlock?redirect=…，
    // 若拿 fullPath 去匹配窄名单就会匹配不上、被再拦一次。
    expect(
      resolveLockRedirect(target("/unlock?redirect=%2Fbackup"), { isLocked: true }, LOCK_ALLOWED_PAGES),
    ).toBe(true);
  });

  it("深链的 query 随回跳参数一起保留", () => {
    expect(resolveLockRedirect(target("/record/123?a=1"), { isLocked: true }, LOCK_ALLOWED_PAGES)).toEqual(
      {
        path: "/unlock",
        query: { redirect: "/record/123?a=1" },
        replace: true,
      },
    );
  });

  it("回跳参数经过消毒，恶意 fullPath 不会成为回跳目标", () => {
    expect(resolveLockRedirect(target("//evil.example"), { isLocked: true }, LOCK_ALLOWED_PAGES)).toEqual(
      {
        path: "/unlock",
        query: { redirect: "/" },
        replace: true,
      },
    );
  });

  it("解锁态下 /unlock 不放行：原地换到它带的回跳目标（真机：解锁后按返回又回到解锁页）", () => {
    // 杀手：把新加的 `if (state.isLocked) return true;` 去掉（恢复无条件放行）⇒ 本用例红。
    // 这条钉的是「解锁态下不存在解锁页」：残留条目（leave 的 replace 被补拉的 push 挤掉、
    // WebView 重载、手输 URL）一律不许渲染成页面。
    expect(
      resolveLockRedirect(target("/unlock?redirect=%2Faccounts"), { isLocked: false }, LOCK_ALLOWED_PAGES),
    ).toEqual({ path: "/accounts", replace: true });

    // 没有回跳参数 ⇒ 回首页，而不是停在解锁页
    expect(resolveLockRedirect(target("/unlock"), { isLocked: false }, LOCK_ALLOWED_PAGES)).toEqual({
      path: "/",
      replace: true,
    });

    // 深链的 query 不能丢
    expect(
      resolveLockRedirect(target("/unlock?redirect=%2Frecord%2F123%3Fa%3D1"), { isLocked: false }, LOCK_ALLOWED_PAGES),
    ).toEqual({ path: "/record/123?a=1", replace: true });

    // 回跳原文是**不可信输入**（用户可直接深链 /unlock?redirect=<任意值>）：
    // 消毒规则与守卫自己产出回跳值时同一套 —— 外站、协议相对、解锁页自身都兜成 /
    for (const raw of ["https://evil.example", "//evil.example", "/unlock?redirect=/accounts"]) {
      expect(
        resolveLockRedirect(
          target(`/unlock?redirect=${encodeURIComponent(raw)}`),
          { isLocked: false },
          LOCK_ALLOWED_PAGES,
        ),
      ).toEqual({ path: "/", replace: true });
    }

    // 必须 replace：push 的话返回键还是能回到解锁页（这正是真机上的表现）
    const stale = resolveLockRedirect(target("/unlock"), { isLocked: false }, LOCK_ALLOWED_PAGES);
    expect(stale).not.toBe(true);
    expect(stale === true ? null : stale.replace).toBe(true);
  });
});
