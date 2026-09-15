import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { RouteRecordNormalized } from "vue-router";
import router from "@/router";
import UnlockPage from "@/views/UnlockPage.vue";
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

// `/unlock` 与解锁页组件由任务 10 注册进真实路由表（`src/router/index.ts`）。
// 这里曾补过一条最小替身路由，但替身会**遮蔽**真实路由：即便 `index.ts` 漏注册
// `/unlock`（`[Vue Router warn]: No match found` + 空白视图），用替身的用例照样全绿。
// 现在直接用真实路由，R60 才有真正的回归防线。

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

/** 取唯一一条匹配记录。匹配不到（= `No match found`）就直接失败，说明路由缺失。 */
function firstMatch(loc: { matched: RouteRecordNormalized[] }): RouteRecordNormalized {
  const record = loc.matched[0];
  if (!record) throw new Error("没有匹配到任何路由记录：路由未注册");
  return record;
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

  it("锁定态：/unlock 命中真实注册的路由（真实解锁页 + 懒加载 + 隐藏底部标签栏）", async () => {
    enterLockedState();
    await router.push("/unlock");

    const current = router.currentRoute.value;
    expect(current.matched).toHaveLength(1);
    // 解析出的就是解锁页本身，不是替身：路由指错组件这类回归同样要拦住。
    expect(firstMatch(current).components?.default).toBe(UnlockPage);
    // 解锁页上不能出现「可点、但点了必然被守卫弹回」的底部 tab。
    expect(current.meta.hideTab).toBe(true);

    // 懒加载：导航会把 loader 的解析结果写回记录，所以要在一个**没加载过**的
    // 新模块注册表里看原始形态——是函数才说明解锁页没有进首包。
    vi.resetModules();
    const { default: freshRouter } = await import("@/router");
    expect(typeof firstMatch(freshRouter.resolve("/unlock")).components?.default).toBe("function");
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
