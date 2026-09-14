// src/router/__tests__/securityRoute.wiring.test.ts
//
// 任务 11 的接线回归：/security 必须真的注册进真实路由表，「我的」页必须真的
// 能跳过去，且入口必须排在「备份与恢复」**上方**。
// 只测 SecurityPage 组件本身的话，路由漏注册 / 入口按钮没接 @click 这类断链
// 在组件测试里照绿不误。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import type { RouteRecordNormalized } from "vue-router";

const { pushMock, authState, ledgerState, localUser } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  authState: {} as Record<string, unknown>,
  ledgerState: {} as Record<string, unknown>,
  localUser: { id: "u1", username: "alice", nickname: "alice", password_hash: "x" },
}));

// 只替换 useRouter：路由实例（createRouter / 真实的守卫）必须是 vue-router 的**原件**，
// 否则本用例测的就不是真实接线了。
vi.mock("vue-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("vue-router")>();
  return { ...actual, useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }) };
});

// 路由表里的页面组件是懒加载的，vue-router 在跑守卫之前就会把它们拉起来。
// 换成最小替身，本用例只关心「注册、懒加载、入口跳转」这三件事。
const { stubView } = vi.hoisted(() => ({
  stubView: (name: string) => ({ default: { name, render: () => null } }),
}));
// SecurityPage 只在路由表的懒加载里用到，换成替身避免把整页依赖拖进来。
vi.mock("@/views/SecurityPage.vue", () => stubView("SecurityPageStub"));
vi.mock("@/views/BackupPage.vue", () => stubView("BackupPageStub"));
vi.mock("@/views/UnlockPage.vue", () => stubView("UnlockPageStub"));

// 「我的」页依赖两个 store + 真实守卫要查本地用户 / 恢复会话。
// 这里都换成替身：本用例不测登录流程，只测安全入口这一条链。
vi.mock("@/stores/auth", () => ({ useAuthStore: () => reactive(authState) }));
vi.mock("@/stores/ledger", () => ({ useLedgerStore: () => reactive(ledgerState) }));
vi.mock("@/services/sync", () => ({
  performSync: vi.fn(async () => true),
  getLastSyncedTime: () => null,
}));
vi.mock("@/db/meta", () => ({
  getLocalUsers: vi.fn(async () => [localUser]),
  getLocalUser: vi.fn(async () => localUser),
}));
vi.mock("@/db/userDb", () => ({
  openUserDb: vi.fn(async () => undefined),
  closeUserDb: vi.fn(async () => undefined),
  getUserDb: vi.fn(() => null),
}));

import router from "@/router";
import MePage from "@/views/MePage.vue";
import SecurityPageStub from "@/views/SecurityPage.vue";

function firstMatch(loc: { matched: RouteRecordNormalized[] }): RouteRecordNormalized {
  const record = loc.matched[0];
  if (!record) throw new Error("没有匹配到任何路由记录：路由未注册");
  return record;
}

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  pushMock.mockClear();
  // 已登录态：「我的」页才会渲染出真实的入口列表。
  Object.assign(authState, {
    isAuthenticated: true,
    currentLocalUser: { nickname: "alice", avatar_url: "" },
    isOnline: false,
    isOnlineBound: false,
    lastSyncFailed: false,
    isSyncing: false,
    init: vi.fn(async () => undefined),
    logout: vi.fn(),
    unbindOnline: vi.fn(async () => undefined),
  });
  Object.assign(ledgerState, {
    ledgers: [],
    currentLedger: null,
    init: vi.fn(async () => undefined),
  });
});

describe("「我的」页的安全入口", () => {
  it("入口显示在「备份与恢复」上方", async () => {
    const w = mount(MePage);
    await flushPromises();

    const entry = w.find('[data-test="me-security-entry"]');
    expect(entry.exists()).toBe(true);
    expect(entry.text()).toContain("安全");

    // 位置断言：安全条目必须出现在「备份与恢复」之前。
    const text = w.text();
    expect(text.indexOf("安全")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("安全")).toBeLessThan(text.indexOf("备份与恢复"));
  });

  it("点击入口跳转 /security", async () => {
    const w = mount(MePage);
    await flushPromises();

    await w.find('[data-test="me-security-entry"]').trigger("click");

    expect(pushMock).toHaveBeenCalledWith("/security");
  });
});

describe("/security 路由注册", () => {
  it("解析到真实的 SecurityPage，且懒加载、隐藏底部标签栏", async () => {
    const resolved = router.resolve("/security");

    expect(resolved.matched).toHaveLength(1);
    expect(resolved.name).toBe("security");
    // 懒加载：解析出来是函数（loader），不是已经内联进首包的组件对象。
    expect(typeof resolved.matched[0].components?.default).toBe("function");
    expect(resolved.meta.hideTab).toBe(true);

    // 导航后命中 `/security` 加载出来的组件（本用例里是替身模块的 default）：
    // 既证明这条路由真的能导航（不是 `No match found`），也证明它指向的就是
    // SecurityPage.vue 这个模块，而不是别的页面。
    await router.push("/security");
    expect(router.currentRoute.value.path).toBe("/security");
    expect(firstMatch(router.currentRoute.value).components?.default).toBe(SecurityPageStub);
  });
});
