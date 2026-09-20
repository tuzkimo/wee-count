// src/views/__tests__/App.aiTab.test.ts
//
// AI tab 的显隐（计划任务 6 步骤 5 / 任务 7 的前置）：后端没启用 AI 时**整个 tab 不出现**。
//
// 只换 `aiChat` 这一个 store（App.vue 只用它的 `enabled` 与 `refreshStatus`）与两个
// 全局副作用入口（自动锁定、引导弹窗）；路由用**真** router，这样 tab 渲染出来的就是
// 真实的 `<a href>` 与文案顺序。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";

const mocks = vi.hoisted(() => ({
  enabled: false,
  refreshStatus: vi.fn(async () => undefined),
}));

vi.mock("@/stores/aiChat", () => ({
  useAiChatStore: () => ({
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

async function mountApp() {
  const router = makeRouter();
  await router.push("/");
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
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

describe("AI tab 门控", () => {
  it("enabled=false：不渲染 AI tab（四个既有 tab，文案与数量都不变）", async () => {
    const wrapper = await mountApp();

    expect(tabLabels(wrapper)).toEqual(["首页", "报表", "账户", "我的"]);
    expect(wrapper.findAll("nav a").length).toBe(4);
    expect(wrapper.text()).not.toContain("AI");
  });

  it("enabled=true：渲染 AI tab，且在「报表」与「账户」之间", async () => {
    mocks.enabled = true;
    const wrapper = await mountApp();

    expect(tabLabels(wrapper)).toEqual(["首页", "报表", "AI", "账户", "我的"]);
    // 位置是刻意的（计划步骤 5）：不是一个"随便插在末尾"的入口
    const hrefs = wrapper.findAll("nav a").map((a) => a.attributes("href"));
    expect(hrefs).toEqual(["/", "/reports", "/ai", "/accounts", "/me"]);
  });

  it("启动就探一次能力（tab 能否出现全靠它；不轮询）", async () => {
    await mountApp();

    expect(mocks.refreshStatus).toHaveBeenCalledTimes(1);
  });
});
