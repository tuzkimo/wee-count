import { describe, it, expect } from "vitest";
import { resolveLockRedirect, sanitizeRedirect } from "@/router/lockGuard";

const PUBLIC = ["/welcome", "/welcome/local", "/login", "/bind-sync", "/backup", "/unlock"];

describe("sanitizeRedirect", () => {
  it("保留站内绝对路径", () => {
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

  it("拒绝回跳 /unlock 自身，避免死循环", () => {
    expect(sanitizeRedirect("/unlock")).toBe("/");
    expect(sanitizeRedirect("/unlock?redirect=/accounts")).toBe("/");
  });
});

describe("resolveLockRedirect", () => {
  it("未锁定一律放行", () => {
    expect(resolveLockRedirect("/accounts", { isLocked: false }, PUBLIC)).toBe(true);
  });

  it("锁定时重定向到 /unlock 并带上原目标", () => {
    expect(resolveLockRedirect("/accounts", { isLocked: true }, PUBLIC)).toEqual({
      path: "/unlock",
      query: { redirect: "/accounts" },
      replace: true,
    });
  });

  it("公开路由在锁定时也放行", () => {
    for (const path of PUBLIC) {
      expect(resolveLockRedirect(path, { isLocked: true }, PUBLIC)).toBe(true);
    }
  });
});
