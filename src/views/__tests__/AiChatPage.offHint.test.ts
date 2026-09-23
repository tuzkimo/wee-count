// src/views/__tests__/AiChatPage.offHint.test.ts
//
// T3（G3/C3/C5）：AI 页那两条提示条必须**说真话**。
//
// 真机事故：`enabled:true + host:null`（地址/登录态未就绪，请求根本没发出去）被渲染成
// 「服务端未配置 AI：这台设备暂时用不了助手。」—— 用户被引向完全错误的方向。
//
// `AiChatPage.test.ts` 一行**都不改**（它只钉 host 已知那一版，`:747`）；本文件是新增契约
// （C5.1–C5.4）的落点。
//
// 杀手：
//   - 把 `ai-sending-off-hint` 的文本改回旧三元（`host === null ⇒ 服务端未配置 AI…`）⇒ 用例①红；
//   - 判据改回 `!ai.sendingEnabled && ai.enabled` ⇒ 用例①红（未探测时能力层是 false）；
//   - 去掉 `v-else-if` 两条提示条 ⇒ 用例②③红；
//   - 点 `ai-recheck` 不调 `refreshStatus` ⇒ 用例②的后半红。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
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

const fetchAiStatus = vi.hoisted(() => vi.fn(async () => state.status));
vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, fetchAiStatus };
});

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

// M4 选图只 mock 第三方插件（本文件不点选图，但组件模块图里有它们）
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import AiChatPage from "@/views/AiChatPage.vue";
import { setBaseUrl } from "@/services/api";
import { useAiChatStore } from "@/stores/aiChat";

let pinia: Pinia;

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/ai", component: { template: "<div />" } },
    ],
  });
  await router.push("/ai");
  await router.isReady();
  const wrapper = mount(AiChatPage, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper as VueWrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.status = null;
  pinia = createPinia();
  setActivePinia(pinia);
});

describe("AI 页提示条（C3/C5）", () => {
  it("① 意愿关着 + 未探测 ⇒ 提示条说「去哪打开」，**不许**诬赖服务端没配（C5.1/C3.4）", async () => {
    useAiChatStore().sendingEnabled = false;
    const w = await mountPage();

    const hint = w.get('[data-test="ai-sending-off-hint"]');
    // 杀手：改回旧三元 ⇒ 这一条红（真机那句谎话）
    expect(hint.text()).toContain("我的 → 隐私");
    expect(hint.text()).not.toContain("服务端未配置 AI");
  });

  it("② 意愿开着 + 真机形态（host:null + 探测失败）⇒ 「暂时连不上」那条 + 重新检测；重试成功后收敛为真话（C5.3）", async () => {
    // 地址就绪（真实链路里由 auth 初始化写入）：这轮探测**能发出去**、只是没结论
    setBaseUrl("http://localhost:8080");
    state.status = { enabled: true, model: null, host: null, failure: { kind: "network" } };
    useAiChatStore().sendingEnabled = true;
    await useAiChatStore().refreshStatus();
    const w = await mountPage();

    // 杀手：去掉 C5.3 那条 `v-else-if` ⇒ 这两条红
    const unknown = w.get('[data-test="ai-sending-unknown"]');
    expect(unknown.text()).toContain("检测失败");
    expect(unknown.text()).not.toContain("服务端未配置 AI");
    expect(w.find('[data-test="ai-sending-off-hint"]').exists()).toBe(false);

    // 用户显式重试：这一轮探测成功 ⇒ 提示条消失（文案跟着真相走）
    state.status = { enabled: true, model: "m", host: "h" };
    await w.get('[data-test="ai-sending-unknown"] [data-test="ai-recheck"]').trigger("click");
    await flushPromises();

    // 杀手：点重试不调 `refreshStatus` ⇒ 这一条红
    expect(fetchAiStatus).toHaveBeenCalledTimes(2);
    expect(w.find('[data-test="ai-sending-unknown"]').exists()).toBe(false);
  });

  it("③ 意愿开着 + 服务端**明确**没配 ⇒ 说「未配置」（C5.4，唯一允许这句话的情形）", async () => {
    state.status = { enabled: false, model: null, host: null };
    useAiChatStore().sendingEnabled = true;
    await useAiChatStore().refreshStatus();
    const w = await mountPage();

    // 杀手：配置层没进 store / 模板不判 `configured === false` ⇒ 这条红
    expect(w.get('[data-test="ai-not-configured"]').text()).toContain("未配置");
  });

  it("④ 意愿开着 + host 可知 ⇒ 三条提示条**都不出现**（C5.2）", async () => {
    state.status = { enabled: true, model: "m", host: "h" };
    useAiChatStore().sendingEnabled = true;
    await useAiChatStore().refreshStatus();
    const w = await mountPage();

    expect(w.find('[data-test="ai-sending-off-hint"]').exists()).toBe(false);
    expect(w.find('[data-test="ai-sending-unknown"]').exists()).toBe(false);
    expect(w.find('[data-test="ai-not-configured"]').exists()).toBe(false);
  });
});
