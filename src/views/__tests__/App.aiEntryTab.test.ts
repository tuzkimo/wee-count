// src/views/__tests__/App.aiEntryTab.test.ts
//
// T2（G1/C1）：AI tab 的显隐**只**由本地意愿层（`entryEnabled`）决定，与任何探测结果无关。
//
// 真 `App.vue` + 真 router + 真 `aiChat` store + 真 `api.ts`（本文件**从不** `setBaseUrl`
// ⇒ 自动探针一次都不发 ⇒ `status` 恒为 null、`host` 恒为 null，正是真机事故的形态）。
//
// 杀手（每条都能让对应用例红）：
//   - 把 `App.vue` 的判据换回 `ai.enabled`（能力层）⇒ 用例②③红（能力层不可用 ⇒ tab 没了）；
//   - 把判据改成恒显 ⇒ 用例①红（意愿关着也出现 tab）；
//   - 让 `entryEnabled` 参与「服务端明确没配就收回入口」（`&& !knownNotConfigured`）⇒ 用例③红。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";

const state = vi.hoisted(() => ({ status: null as unknown }));

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
import { useAiChatStore } from "@/stores/aiChat";

const blank = { template: "<div />" };

function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: blank },
      { path: "/reports", component: blank },
      { path: "/ai", component: AiChatPage },
      { path: "/accounts", component: blank },
      { path: "/me", component: blank },
    ],
  });
}

/**
 * 挂一次 App（本文件不配 base URL ⇒ 自动探针一次都不发）。
 *
 * pinia 显式建好、先 `setActivePinia` 再 mount 且**共用同一个实例**：能力层与意愿层都要在
 * 挂载**之前**就位，否则测试里拿到的是另一个 store 实例（`createPinia()` 每调一次就是一个新容器）。
 */
async function mountApp() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useAiChatStore();
  const router = makeRouter();
  await router.push("/");
  await router.isReady();
  return {
    store,
    mountNow: async (): Promise<ReturnType<typeof mount>> => {
      const wrapper = mount(App, { global: { plugins: [pinia, router] } });
      await flushPromises();
      return wrapper;
    },
  };
}

function tabLabels(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll("nav a").map((a) => a.text());
}

beforeEach(() => {
  vi.clearAllMocks();
  // 服务端**明确说配了** —— 能力层可用，唯一的变量只剩本地意愿
  state.status = { enabled: true, model: "m", host: "h" };
});

describe("AI tab 只由本地意愿层决定（G1/C1）", () => {
  it("① 意愿关着（默认）⇒ 一个 AI tab 都没有，哪怕服务端配了 AI、探测也说 enabled:true", async () => {
    const { store, mountNow } = await mountApp();
    // 先用真实路径探一次（用户显式触发，第 47 条允许），把能力层喂成"明确可用"
    await store.refreshStatus();
    expect(store.enabled).toBe(true);
    expect(store.entryEnabled).toBe(false);

    const wrapper = await mountNow();

    // 杀手：把 tab 判据改成恒显 ⇒ 这条红
    expect(tabLabels(wrapper)).toEqual(["首页", "报表", "账户", "我的"]);
    expect(wrapper.text()).not.toContain("AI");
  });

  it("② 意愿开启 + 真机形态（探测不可判定、host 仍为 null）⇒ tab **照样出现**", async () => {
    const { store, mountNow } = await mountApp();
    state.status = { enabled: true, model: null, host: null, failure: { kind: "network" } };
    await store.refreshStatus();
    expect(store.host).toBeNull();

    store.entryEnabled = true;
    const wrapper = await mountNow();

    // 杀手：判据换回能力层（`ai.enabled` / `ai.host !== null`）⇒ 这条红
    expect(tabLabels(wrapper)).toContain("AI");
  });

  it("③ 意愿开启 + 服务端**明确**没配 ⇒ 入口仍在（不许被服务端的答复收回）", async () => {
    const { store, mountNow } = await mountApp();
    state.status = { enabled: false, model: null, host: null };
    await store.refreshStatus();
    expect(store.configured).toBe(false);

    store.entryEnabled = true;
    const wrapper = await mountNow();

    // 杀手：判据写成 `entryEnabled && !knownNotConfigured` ⇒ 这条红 —— 用户刚开的入口自己消失，
    // 与"入口永远可达"（规则 2）冲突，是同一个死锁换了个位置
    expect(tabLabels(wrapper)).toContain("AI");
  });
});
