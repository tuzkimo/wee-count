import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    isAuthenticated: true,
    isOnline: true,
    isOnlineBound: true,
    isSyncing: false,
    lastSyncFailed: false,
    currentLocalUser: { nickname: "测试用户", avatar_url: null, api_url: "https://example.com/api/v1" },
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
 * 同步状态行是 `<button class="... bg-surface">`，而 button 上的 `display:flex`
 * 是**收缩到内容宽**的：少了 `w-full`，这块 bg-surface 只铺到文字末尾，右侧露出
 * 页面底色 —— 真机上一整行看着像被截断（与同页其余行按钮都显式带 w-full 的事实一致）。
 *
 * jsdom 没有布局引擎，量不出实际宽度，所以这里断言的是那条结构化前提：
 * 承载行背景的按钮自身必须声明占满整行。
 */
describe("MePage 同步状态行", () => {
  it("同步状态按钮声明 w-full，行背景才能铺满整行", () => {
    const w = mount(MePage);
    const syncRow = w.findAll("button").find((b) => b.text().includes("已同步"));
    expect(syncRow, "在线模式必须渲染同步状态按钮").toBeTruthy();
    expect(syncRow!.classes()).toContain("w-full");
    // 背景在按钮自己身上，行才不会有半截底色（前提变了这条测试就该跟着改）。
    expect(syncRow!.classes()).toContain("bg-surface");
  });
});
