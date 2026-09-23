// src/views/__tests__/App.aiTab.test.ts
//
// AI tab 的显隐（G1/C1：**只**由本地意愿层 `entryEnabled` 决定）。
//
// 只换 `aiChat` 这一个 store（App.vue 只用它的 `entryEnabled` 与 `refreshStatus`）与两个
// 全局副作用入口（自动锁定、引导弹窗）；路由用**真** router，这样 tab 渲染出来的就是
// 真实的 `<a href>` 与文案顺序。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";

const mocks = vi.hoisted(() => ({
  /** 意愿层：AI 入口开没开（G1/C1 —— tab 显隐的**唯一**判据） */
  entryEnabled: false,
  enabled: false,
  refreshStatus: vi.fn(async () => undefined),
}));

vi.mock("@/stores/aiChat", () => ({
  useAiChatStore: () => ({
    get entryEnabled() {
      return mocks.entryEnabled;
    },
    get enabled() {
      return mocks.enabled;
    },
    refreshStatus: mocks.refreshStatus,
  }),
}));

vi.mock("@/composables/useAutoLock", () => ({ useAutoLock: () => undefined }));
vi.mock("@/components/lock/AppLockPrompt.vue", () => ({
  default: { name: "AppLockPrompt", template: "<div />" },
}));

import App from "@/App.vue";
import { setBaseUrl } from "@/services/api";

const blank = { template: "<div />" };

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: blank },
      { path: "/reports", component: blank },
      { path: "/ai", component: blank },
      { path: "/accounts", component: blank },
      { path: "/me", component: blank },
    ],
  });
}

/**
 * 挂上的 App 实例必须**逐条卸载**：`baseUrlReady` 是 `api.ts` 的模块级状态，上一条用例留下的
 * App 实例如果还活着，它那个 `watch` 会在本条用例 `setBaseUrl()` 时一起开火（数出来的次数
 * 与"探了几次"无关，只与"还挂着几个 App"有关）。
 */
const mounted: ReturnType<typeof mount>[] = [];

async function mountApp() {
  const router = makeRouter();
  await router.push("/");
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
  mounted.push(wrapper);
  await flushPromises();
  return wrapper;
}

/** tab 的文案（顺序即渲染顺序） */
function tabLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll("nav a").map((a) => a.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = false;
  setActivePinia(createPinia());
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
});

describe("AI tab 门控", () => {
  it("enabled=false：不渲染 AI tab（四个既有 tab，文案与数量都不变）", async () => {
    const wrapper = await mountApp();

    expect(tabLabels(wrapper)).toEqual(["首页", "报表", "账户", "我的"]);
    expect(wrapper.findAll("nav a").length).toBe(4);
    expect(wrapper.text()).not.toContain("AI");
  });

  it("意愿开启：渲染 AI tab，且在「报表」与「账户」之间", async () => {
    mocks.entryEnabled = true;
    const wrapper = await mountApp();

    expect(tabLabels(wrapper)).toEqual(["首页", "报表", "AI", "账户", "我的"]);
    // 位置是刻意的（计划步骤 5）：不是一个"随便插在末尾"的入口
    const hrefs = wrapper.findAll("nav a").map((a) => a.attributes("href"));
    expect(hrefs).toEqual(["/", "/reports", "/ai", "/accounts", "/me"]);
  });

  it("**地址就绪后**探一次能力（就绪前一次都不探、不轮询）", async () => {
    const wrapper = await mountApp();
    expect(wrapper.findAll("nav a").length).toBeGreaterThan(0);

    // 杀手：把探针挂回 `onMounted`（或让 `watch` 不判就绪）⇒ 这一条红
    expect(mocks.refreshStatus).not.toHaveBeenCalled();

    // 地址就绪（真实链路里由 auth 的异步初始化写入；`api.ts` 的模块级状态由模块隔离兜住）
    setBaseUrl("http://localhost:8080");
    await flushPromises();

    // 杀手：去掉"就绪后探一次"的 watch ⇒ 这里仍是 0 次 ⇒ 红
    expect(mocks.refreshStatus).toHaveBeenCalledTimes(1);
  });
});
