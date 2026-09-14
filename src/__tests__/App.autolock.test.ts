import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
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

import App from "@/App.vue";

/**
 * App.vue 只用 `useRoute()` 与 `RouterView`，给一张最小路由表即可。
 * 四个底部 tab 的路径都要在表里：否则 `router-link` 会打出
 * `[Vue Router warn]: No match found`，而告警不是本项目的基线状态。
 */
function createTestRouter(): Router {
  const stub = { render: () => null };
  return createRouter({
    history: createMemoryHistory(),
    routes: ["/", "/reports", "/accounts", "/me"].map((path, i) => ({
      path,
      name: `test-${i}`,
      component: stub,
    })),
  });
}

describe("App.vue 自动锁定接线", () => {
  beforeEach(() => {
    autoLock.mockClear();
  });

  it("根组件挂载时启用 useAutoLock", async () => {
    const router = createTestRouter();
    await router.push("/");
    await router.isReady();

    mount(App, { global: { plugins: [router] } });

    expect(autoLock).toHaveBeenCalledTimes(1);
  });
});
