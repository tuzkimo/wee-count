import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

const replace = vi.fn();
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn(), replace }) }));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    isAuthenticated: true,
    isOnline: true,
    isOnlineBound: true,
    isSyncing: false,
    lastSyncFailed: false,
    currentLocalUser: { nickname: "测试用户", avatar_url: null, api_url: "http://localhost:8080" },
    init: vi.fn(async () => undefined),
    logout: vi.fn(),
    unbindOnline: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    ledgers: [{ id: 1, name: "个人账本", type: "personal" }],
    currentLedger: { id: 1, name: "个人账本", type: "personal" },
    init: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/services/sync", () => ({
  performSync: vi.fn(async () => undefined),
  getLastSyncedTime: vi.fn(() => null),
}));

import MePage from "@/views/MePage.vue";

/**
 * 页面根节点的高度由 App.vue 的 `flex-1 min-h-0` 决定，等于「视口 - 状态栏 - tab 栏」。
 * 内容超出这个高度时，只有**内部存在可滚动容器**才能滚到底；否则溢出部分会被
 * DOM 顺序在后的 tab 栏盖住，「退出登录」就此点不到（真机 R 级 UI 缺陷）。
 *
 * jsdom 没有布局引擎，算不出真实滚动高度，所以这里断言的是那条结构化前提：
 * 正文被包在一个 overflow-auto 容器里，且它不是页面根节点本身。
 */
function scrollableAncestorOf(el: Element): Element | undefined {
  let cur: Element | null = el.parentElement;
  while (cur) {
    if (/overflow(-y)?-auto/.test(cur.className)) return cur;
    cur = cur.parentElement;
  }
  return undefined;
}

describe("MePage 可滚动性", () => {
  it("已登录时正文位于可滚动容器内，退出登录按钮可达", () => {
    const w = mount(MePage);
    const logout = w.findAll("button").find((b) => b.text().includes("退出登录"));
    expect(logout, "已登录态必须渲染退出登录按钮").toBeTruthy();

    const scroller = scrollableAncestorOf(logout!.element);
    expect(scroller, "退出登录按钮必须落在 overflow-auto 容器内，否则会被底部 tab 栏遮蔽").toBeTruthy();
    expect(scroller!.className, "可滚动容器不能是页面根节点").not.toContain("h-full");
    // 容器本身要撑满剩余高度，否则内容会直接溢出到 tab 栏之下而不是产生滚动。
    expect(scroller!.className).toContain("flex-1");
  });

  it("底部按钮与滚动区下沿留有间距", () => {
    const w = mount(MePage);
    const logout = w.findAll("button").find((b) => b.text().includes("退出登录"));
    const scroller = scrollableAncestorOf(logout!.element)!;
    expect(scroller.className, "滚到底时退出登录按钮不应贴着 tab 栏").toMatch(/pb-\d/);
  });
});