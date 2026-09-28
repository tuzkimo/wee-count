// 分享提示行的渲染契约：空串不渲染、非空逐字渲染（文案本身由 attachText 的用例钉）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter } from "vue-router";

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

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import AiChatPage from "@/views/AiChatPage.vue";
import { useAiChatStore } from "@/stores/aiChat";
// 逐字断言用的是**唯一真相**里的常量：字面量已在 `attachText.test.ts` 被钉住，
// 这里再抄一遍就等于在测试里养出第七份文案副本。
import { MSG_MULTIPLE_TAKEN } from "@/services/ai/attachText";

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

describe("AI 页分享提示行", () => {
  it("① 没有提示 ⇒ 不渲染（空串不是一句话）", async () => {
    const w = await mountPage();
    expect(w.find('[data-test="ai-share-notice"]').exists()).toBe(false);
  });

  it("② 有提示 ⇒ 逐字渲染", async () => {
    useAiChatStore().setImageNotice(MSG_MULTIPLE_TAKEN);
    const w = await mountPage();
    expect(w.get('[data-test="ai-share-notice"]').text()).toBe(MSG_MULTIPLE_TAKEN);
  });
});
