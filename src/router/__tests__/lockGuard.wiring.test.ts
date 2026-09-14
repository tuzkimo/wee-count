import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import router from "@/router";
import { useLockStore } from "@/stores/lock";

/**
 * 路由接线测试：用**真实的 router 实例**（真实的守卫 + 真实的窄名单）跑导航。
 *
 * 两个关键缺陷都落在接线层而不是纯函数里：锁判定与 `publicPages` 早返回的先后顺序、
 * 实际传进去的白名单是哪一个。纯函数测试对这两点无感，所以必须跑真导航。
 */

const { getLocalUsers, stubView } = vi.hoisted(() => ({
  getLocalUsers: vi.fn(async () => []),
  // 必须是对象形态的组件：函数会被 vue-router 当成异步 loader 去 await。
  stubView: (name: string) => ({ default: { name, render: () => null } }),
}));

vi.mock("@/db/meta", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/meta")>();
  return { ...actual, getLocalUsers };
});

// 路由表里的页面组件是懒加载的，vue-router 在跑守卫**之前**就会调用它们
// （extractComponentsGuards 里 `rawComponent()` 是立即调用的）。
// 换成最小替身，本用例才只关心守卫本身。
vi.mock("@/views/BackupPage.vue", () => stubView("BackupPageStub"));
vi.mock("@/views/BindSyncPage.vue", () => stubView("BindSyncPageStub"));
vi.mock("@/views/WelcomePage.vue", () => stubView("WelcomePageStub"));
vi.mock("@/views/LoginPage.vue", () => stubView("LoginPageStub"));
vi.mock("@/views/AccountList.vue", () => stubView("AccountListStub"));
vi.mock("@/views/RecordPage.vue", () => stubView("RecordPageStub"));

// `/unlock` 路由与解锁页组件属于任务 10 的范围，本分支上尚不存在。
// 这里补一条最小路由，让「重定向目标可达、且不会被再次拦截」可测。
router.addRoute({
  path: "/unlock",
  name: "unlock-test-stub",
  component: { name: "UnlockStub", render: () => null },
});

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  getLocalUsers.mockClear();
});

/** 进入锁定态：`isLockConfigured` 是 setup store 暴露的可写 ref，用它喂出「已配置锁」。 */
function enterLockedState(): void {
  const lock = useLockStore();
  lock.isLockConfigured = true;
  lock.lock();
}

describe("锁守卫接线（真实 router）", () => {
  it("锁定态：/backup 被拦到 /unlock（不再放行）", async () => {
    enterLockedState();
    await router.push("/backup");

    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({ redirect: "/backup" });
  });

  it("锁定态：/bind-sync 被拦到 /unlock（本地全量账本不可被上传到任意地址）", async () => {
    enterLockedState();
    await router.push("/bind-sync");

    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({ redirect: "/bind-sync" });
  });

  it("锁定态：其它公开页面（/welcome、/login）同样被拦", async () => {
    enterLockedState();
    for (const path of ["/welcome", "/login"]) {
      await router.push(path);
      expect(router.currentRoute.value.path).toBe("/unlock");
      expect(router.currentRoute.value.query).toEqual({ redirect: path });
    }
  });

  it("锁定态：业务页被拦，且不去查库", async () => {
    enterLockedState();
    await router.push("/accounts");

    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({ redirect: "/accounts" });
    expect(getLocalUsers).not.toHaveBeenCalled();
  });

  it("锁定态：/unlock 不被拦截（否则无限重定向）", async () => {
    enterLockedState();
    await router.push("/unlock");

    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({});
  });

  it("锁定态：深链的 query 随回跳参数保留", async () => {
    enterLockedState();
    await router.push("/record/123?a=1");

    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({ redirect: "/record/123?a=1" });
  });

  it("未锁定态：公开页面正常放行", async () => {
    await router.push("/backup");
    expect(router.currentRoute.value.path).toBe("/backup");

    await router.push("/bind-sync");
    expect(router.currentRoute.value.path).toBe("/bind-sync");
  });
});
