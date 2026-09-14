import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

/**
 * 自动锁定的**接线**测试：判定逻辑本身在 `useAutoLock` 的测试里，这里只证明
 * 根组件确实挂上了它。漏挂是静默失效——切后台再回来永远不会锁，没有任何报错。
 * 把 composable 换成替身，用「是否被调用」当证据。
 */
const autoLock = vi.fn();

vi.mock("@/composables/useAutoLock", () => ({
  useAutoLock: () => autoLock(),
}));

/**
 * `sanitizeRedirect` 的观察点：原地代理真实现，只多记一次调用。
 *
 * 真实 `route.fullPath` 一律是站内路径、消毒前后完全相同，所以「结果正确」证明不了
 * 消毒**被调用**（把 `sanitizeRedirect(...)` 换成裸值同样全绿）。这里既断言它被调用
 * 且收到的是 fullPath，又断言返回值仍是真实现消毒后的结果，两头都钉住。
 */
const sanitizeSpy = vi.hoisted(() => vi.fn());

vi.mock("@/router/lockGuard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/router/lockGuard")>();
  return {
    ...actual,
    sanitizeRedirect: (raw: unknown) => {
      sanitizeSpy(raw);
      return actual.sanitizeRedirect(raw);
    },
  };
});

import App from "@/App.vue";
import { useLockStore } from "@/stores/lock";

/**
 * App.vue 用 `useRoute()`、`RouterView` 与 `router-link`。四个底部 tab 的路径都要在
 * 表里：否则 `router-link` 会打出 `[Vue Router warn]: No match found`，而告警不是
 * 本项目的基线状态。`/unlock` 是 R70 的落点，`/record/:id` 用来喂深链 query。
 */
function createTestRouter(): Router {
  const stub = { render: () => null };
  const paths = ["/", "/reports", "/accounts", "/me", "/record/:id", "/unlock"];
  return createRouter({
    history: createMemoryHistory(),
    routes: paths.map((path, i) => ({ path, name: `test-${i}`, component: stub })),
  });
}

/**
 * 挂载根组件并返回这一轮的路由器 / 锁 store。
 *
 * 必须先 `setActivePinia` 再把**同一个** pinia 装到 app 上：App.vue 里
 * `useLockStore()` 取的是注入的实例，用例里取的必须是同一个，否则改的不是同一份 state。
 */
async function mountApp(initialPath: string) {
  const router = createTestRouter();
  await router.push(initialPath);
  await router.isReady();

  const pinia = createPinia();
  setActivePinia(pinia);
  const lock = useLockStore();

  const wrapper = mount(App, { global: { plugins: [router, pinia] } });
  return { router, lock, wrapper };
}

describe("App.vue 自动锁定接线", () => {
  beforeEach(() => {
    sanitizeSpy.mockClear();
    autoLock.mockClear();
  });

  it("根组件挂载时启用 useAutoLock", async () => {
    await mountApp("/");

    expect(autoLock).toHaveBeenCalledTimes(1);
  });

  // ---- R70：锁定态必须立刻把界面切到解锁页 ----

  it("R70：isLocked 变真立刻导航到 /unlock，redirect 为当前页面且过 sanitizeRedirect", async () => {
    const { router, lock } = await mountApp("/accounts");
    const replaceSpy = vi.spyOn(router, "replace");

    lock.isLocked = true;
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe("/unlock");
    });
    await flushPromises();

    // 证据一：确实发生了一次到 /unlock 的导航，且 redirect 是用户原来看的页面。
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(router.currentRoute.value.query).toEqual({ redirect: "/accounts" });
    // 证据二：回跳值走的是 lockGuard 那一套消毒，而不是裸拼字符串。
    expect(sanitizeSpy).toHaveBeenCalledWith("/accounts");
  });

  it("R70：redirect 取 fullPath 而非 path，深链的 query 不丢", async () => {
    const { router, lock } = await mountApp("/record/123?a=1");

    lock.isLocked = true;
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe("/unlock");
    });

    expect(router.currentRoute.value.query).toEqual({ redirect: "/record/123?a=1" });
  });

  it("R70：已经在 /unlock 上不再重复跳（不把 redirect 覆盖成 /）", async () => {
    const { router, lock } = await mountApp("/unlock?redirect=%2Faccounts");
    const replaceSpy = vi.spyOn(router, "replace");

    lock.isLocked = true;
    await flushPromises();

    expect(replaceSpy).not.toHaveBeenCalled();
    // 原始去处原样留着 —— 重入一次就会变成 `/`（sanitizeRedirect 拦掉 /unlock 自身）。
    expect(router.currentRoute.value.query).toEqual({ redirect: "/accounts" });
  });

  it("R70：解锁（isLocked 变回 false）不产生任何导航", async () => {
    const { router, lock } = await mountApp("/accounts");

    lock.isLocked = true;
    await vi.waitFor(() => {
      expect(router.currentRoute.value.path).toBe("/unlock");
    });

    const replaceSpy = vi.spyOn(router, "replace");
    lock.isLocked = false;
    await flushPromises();

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe("/unlock");
  });
});
