// src/views/__tests__/App.aiProbe.test.ts
//
// 第 47 条（本轮 Critical）：**自动探针只有一处** —— `App.vue` 的启动钩子。
//
// 这条用**生产路径**实测"探测次数 = 1"：真 `App.vue` + 真 router（`/ai` 挂真页面）+ 真
// `aiChat` store，只换网络入口 `fetchAiStatus` 与三个副作用入口。
// 杀手：页面里加回 `void ai.refreshStatus()` ⇒ 这里数到 2 ⇒ 本用例自己红。
//
// 为什么值得一条独立文件：`App.aiTab.test.ts` 把整个 store mock 掉了（它验的是 tab 渲染），
// 而"探测次数"这件事**只有让真 store + 真页面一起跑**才数得出来（上一轮就是两处各探一次）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";

const state = vi.hoisted(() => ({ status: { enabled: true, model: "m", host: "h" } as unknown }));

// 真库不参与（页面在"没有库"的形态下照样走完 onMounted：名表失败被吞、读会话降级成空态，
// Ruling 13）。这里要数的只有探测次数。
vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => null,
    getCurrentUserId: () => "local-1",
    getTeamMembers: vi.fn(async () => []),
  };
});

vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, fetchAiStatus: vi.fn(async () => state.status) };
});

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("@/composables/useAutoLock", () => ({ useAutoLock: () => undefined }));
vi.mock("@/components/lock/AppLockPrompt.vue", () => ({
  default: { name: "AppLockPrompt", template: "<div />" },
}));

import App from "@/App.vue";
import AiChatPage from "@/views/AiChatPage.vue";
import { fetchAiStatus } from "@/services/ai/transport";

const fetchMock = () => vi.mocked(fetchAiStatus);
const blank = { template: "<div />" };

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: blank },
      { path: "/reports", component: blank },
      // 真页面：只有真的挂上它，"页面又偷偷探一次"才会被数进来
      { path: "/ai", component: AiChatPage },
      { path: "/accounts", component: blank },
      { path: "/me", component: blank },
    ],
  });
}

async function mountAppAt(path: string) {
  const router = makeRouter();
  await router.push(path);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [createPinia(), router] } });
  await flushPromises();
  return { wrapper, router };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.status = { enabled: true, model: "m", host: "h" };
  setActivePinia(createPinia());
});

describe("/ai/status 的自动探测次数（第 47 条）", () => {
  it("进 AI 页（真页面挂载）⇒ 全程只探一次（App 启动那次），tab 也真的出现了", async () => {
    const { wrapper } = await mountAppAt("/ai");

    // 杀手：页面加回自动探 ⇒ 2
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    // 顺带钉住整条链：这次探测的 enabled:true 真的把 AI tab 渲染出来了
    expect(wrapper.findAll("nav a").map((a) => a.text())).toEqual([
      "首页",
      "报表",
      "AI",
      "账户",
      "我的",
    ]);
  });

  it("启动后从首页点进 AI 页 ⇒ 探测次数**仍然是 1**（不是「进页面再探一次」）", async () => {
    const { wrapper, router } = await mountAppAt("/");
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    await router.push("/ai");
    await flushPromises();

    // 杀手：页面里加回 `void ai.refreshStatus()` ⇒ 2（这就是上一轮实测的"启动后=1，进页面后=2"）
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    // 页面真的挂上了（不是"路由没匹配上"那种假绿）
    expect(wrapper.find('[data-test="ai-scroller"]').exists()).toBe(true);
  });
});
