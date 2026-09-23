// src/views/__tests__/App.aiProbeTiming.test.ts
//
// T1（C6.1/C6.2）：探测**不得早于 base URL 就绪**，且一个就绪窗口内**只探一次**。
//
// 与 `App.aiProbe.test.ts` 的分工：那份钉"自动探针只有一处"（数到 2 就红，真 `hasBaseUrl()`
// 永不为真、因此探测次数恒为 0）；这一份钉"什么时候才允许探"——真 `App.vue` + 真 router +
// 真 `aiChat` store + **真 `api.ts` 的模块级 baseUrl**，只换网络入口 `fetchAiStatus`。
//
// 杀手：
//   - 把探针挂回 `onMounted` ⇒ 用例①红（就绪前 `fetchAiStatus` 被调）；
//   - 去掉 `baseUrlReady` 这个触发条件（或改成"挂载就跑一次"）⇒ 用例①红；
//   - 在页面里加回 `void ai.refreshStatus()` ⇒ 用例②红（数到 2）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";

const state = vi.hoisted(() => ({ status: { enabled: true, model: "m", host: "h" } as unknown }));

// 真库不参与（照 `App.aiProbe.test.ts`：页面在"没有库"的形态下照样走完 onMounted）
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
import { setBaseUrl } from "@/services/api";
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

describe("探测时机（C6：地址就绪后才探，且只探一次）", () => {
  it("base URL 未就绪 ⇒ 一个请求都不发；就绪之后恰好 1 次", async () => {
    // 本文件从不预先 `setBaseUrl` ⇒ 真 `hasBaseUrl()` 为 false（模块级状态由模块隔离兜住）
    await mountAppAt("/");
    await flushPromises();

    // 杀手：探针挂回 `onMounted`（或 `watch` 不判就绪）⇒ 这里已经是 1 次 ⇒ 红
    expect(fetchMock()).not.toHaveBeenCalled();

    // 地址就绪（真实链路里由 `auth.ts` 的异步初始化写入；这里直接写同一个入口）
    setBaseUrl("http://localhost:8080");
    await flushPromises();

    // 杀手：去掉"就绪后探一次"的 `watch` ⇒ 这里仍是 0 次 ⇒ 红
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("就绪后进 AI 页 ⇒ 探测次数**仍然是 1**（页面不许再探）", async () => {
    setBaseUrl("http://localhost:8080");
    const { wrapper, router } = await mountAppAt("/");
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    await router.push("/ai");
    await flushPromises();

    // 杀手：页面里加回 `void ai.refreshStatus()` ⇒ 2（第 47 条）
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    // 页面真的挂上了（不是"路由没匹配上"那种假绿）
    expect(wrapper.find('[data-test="ai-scroller"]').exists()).toBe(true);
  });
});
