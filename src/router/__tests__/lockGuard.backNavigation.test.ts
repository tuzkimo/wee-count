import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import router from "@/router";
import { useLockStore } from "@/stores/lock";

/**
 * 真机验收清单第 7 项：「锁屏状态下按 Android 返回键，不能退回被锁页面」。
 *
 * Android 返回键在 Tauri 的 WebView 里就是一次**浏览器历史后退**（`popstate`），
 * 而 vue-router 对 popstate 导航同样跑 `beforeEach`，所以这条性质在单测里可测。
 * 前提是**真的产生一次后退**：历史栈里得先有一条被锁页面、再有一条解锁页，
 * 然后让历史指针真的往回走——只断言「前进到被锁页面会被拦」不构成第 7 项的证据。
 *
 * 独立成文件（而不是并进 `lockGuard.wiring.test.ts`）的理由是这里需要一个**可控的历史栈**：
 * 那个文件共用同一个 router 单例，8 条用例的 push 会在同一个 happy-dom window 里逐条累积
 * 历史条目，后退会退到别的用例留下的页面上，结果随用例顺序漂移；而每个测试文件各自拥有
 * 一个干净的 window，本文件里的历史栈完全由这两条用例自己搭出来。
 *
 * router 的构造方式与替身约定沿用 `lockGuard.wiring.test.ts`：真实 router + 真实守卫 + 真实窄名单。
 * 被锁页面选 `/backup`、`/bind-sync`（而不是业务页）不是随手挑的：这两页正是
 * `LOCK_ALLOWED_PAGES` 这条窄名单要把它们挡在外面的对象，锁的整个设计动机都在这里。
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

// 懒加载页面组件在守卫**之前**就会被拉起来。只替身本用例会走到的两个被锁页面；
// `/unlock` 不替身，走的仍是路由表里真实注册的那条。
vi.mock("@/views/BackupPage.vue", () => stubView("BackupPageStub"));
vi.mock("@/views/BindSyncPage.vue", () => stubView("BindSyncPageStub"));

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

/** 数一次 `popstate`。返回值既摘掉监听、又给出计数。 */
function watchPopstate(): () => number {
  let count = 0;
  const onPopstate = (): void => {
    count += 1;
  };
  window.addEventListener("popstate", onPopstate);
  return () => {
    window.removeEventListener("popstate", onPopstate);
    return count;
  };
}

/**
 * 等这一次后退导航结算到明确落点。
 *
 * 锁定态下守卫会把任何被锁页面重定向成 `/unlock?redirect=<被拦下的 fullPath>`，
 * 所以「落在 `/unlock`、且回跳参数正好是刚才退向的那一页」这一个断言同时钉住两件事：
 * 守卫确实处理了这次后退、且最终路由是解锁页。
 */
async function waitForBounce(redirect: string): Promise<void> {
  await vi.waitFor(() => {
    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({ redirect });
  });
}

describe("应用锁：锁定态下的后退导航（第 7 项）", () => {
  it("历史里有被锁页面（/backup）时，按一次返回键最终仍停在 /unlock", async () => {
    // 解锁态先真实导航到 /backup：它必须**真的进历史栈**，否则后面无处可退，
    // 用例会退化成一次空转（下面的 popstate 计数就是为这一点准备的）。
    await router.push("/backup");
    expect(router.currentRoute.value.path).toBe("/backup");

    enterLockedState();
    await router.push("/unlock");
    // 落点确认：历史栈现在是 [/backup, /unlock]，指针在 /unlock 上、且还没带任何回跳参数。
    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({});

    const stopWatching = watchPopstate();
    router.back();
    await waitForBounce("/backup");
    const popstateCount = stopWatching();

    // 证据一：这真的是一次浏览器/历史后退，而不是「又 push 了一次被锁页面」。
    expect(popstateCount).toBe(1);
    // 证据二：断言落在**最终路由**上——后退的目标 /backup 被守卫弹回解锁页，
    // 回跳参数就是被拦下的那一页，说明守卫确实看见了这次后退。
    expect(router.currentRoute.value.path).toBe("/unlock");
    expect(router.currentRoute.value.query).toEqual({ redirect: "/backup" });
  });

  it("连按返回键逐层弹回，锁定后 router 从不落在被锁页面上", async () => {
    await router.push("/backup");
    await router.push("/bind-sync");
    enterLockedState();
    await router.push("/unlock");

    // 记录锁定之后 router 落过的每一个去处（含被守卫重定向后的落点）。
    const landedAfterLock: string[] = [];
    const stopRecording = router.afterEach((to) => {
      landedAfterLock.push(to.fullPath);
    });

    const stopWatching = watchPopstate();
    router.back();
    await waitForBounce("/bind-sync");
    router.back();
    await waitForBounce("/backup");
    const popstateCount = stopWatching();
    stopRecording();

    // 两次 popstate：历史指针真的往回走过了两层，不是一次都没动。
    expect(popstateCount).toBe(2);
    expect(router.currentRoute.value.path).toBe("/unlock");
    // 逐层弹回：先退到 /bind-sync、再退到 /backup，两次都被挡回解锁页。
    expect(landedAfterLock).toEqual([
      "/unlock?redirect=/bind-sync",
      "/unlock?redirect=/backup",
    ]);
    // 更强的不变式：锁定之后 router 落过的**每一个**去处都在解锁页上。
    expect(landedAfterLock.length).toBeGreaterThanOrEqual(2);
    for (const fullPath of landedAfterLock) {
      expect(fullPath.startsWith("/unlock")).toBe(true);
    }
  });
});
