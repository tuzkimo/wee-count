// AI 聊天页**历史消息缩略图**的浅色描边/底（实机反馈：模糊后列表里的小图也糊成一片）。
//
// 为什么另起一个文件：`AiChatPage.imageLightbox.test.ts` 钉的是"点图 ⇒ 查看器"的接线，
// `AiChatPage.test.ts` 走真 store/真 sqlite 的端到端链路 —— 两个都**一个字不动**。
// 这里只补"缩略图自己有一圈看得见的边界"，所以照样用替身 store（同 `FilterPage.test.ts` 的惯例）。
//
// ⚠️ 描边不能画在 `<img>` 上：`blur-lg` 的 `filter: blur()` 会把同元素的边框一起糊掉，
// 还会向外溢到背景上。描边因此落在 `<img>` 的父层，并用 `overflow-hidden` 夹住外溢的模糊。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import type { UiMessage } from "@/stores/aiChat";
import type { ImageAttachment } from "@/services/ai/imageInput";

const T0 = "2026-03-01T00:00:00.000Z";
const HISTORY_URL = "data:image/jpeg;base64,HISTORY";

/** 与 `AiChatPage.imageLightbox.test.ts` 同一套替身（页面取用的那几项给足，其余不实现） */
const holder = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("@/stores/aiChat", async () => {
  const { reactive } = await import("vue");
  const store = reactive({
    messages: [] as UiMessage[],
    loading: false,
    sending: false,
    sendingEnabled: true,
    sendingHint: "",
    configured: true,
    host: "h",
    privacyCardSeen: true,
    revealed: new Set<string>(),
    pendingDrafts: [],
    confirmedDrafts: [],
    rejectedDrafts: [],
    attachedImage: null as ImageAttachment | null,
    load: async () => {},
    refreshStatus: async () => {},
    send: () => {},
    cancel: () => {},
    clear: () => {},
    dismissPrivacyCard: async () => {},
    setAttachedImage: () => {},
    clearAttachedImage: () => {},
  });
  holder.store = store;
  return { useAiChatStore: () => store };
});

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ init: async () => {}, currentLedger: null }),
}));
vi.mock("@/stores/account", () => ({ useAccountStore: () => ({ fetchAll: async () => {} }) }));
vi.mock("@/stores/category", () => ({ useCategoryStore: () => ({ fetchAll: async () => {} }) }));
vi.mock("@/stores/tag", () => ({ useTagStore: () => ({ fetchAll: async () => {} }) }));
vi.mock("@/stores/transaction", () => ({
  useTransactionStore: () => ({ add: async () => "", remove: async () => {} }),
}));

import AiChatPage from "@/views/AiChatPage.vue";

const THUMB = '[data-test="ai-message-thumb"]';
const FRAME = '[data-test="ai-message-thumb-frame"]';

function attachment(dataUrl: string): ImageAttachment {
  return { mime: "image/jpeg", dataUrl, width: 1280, height: 960, bytes: 3 };
}

function imageMessage(id: string, dataUrl: string): UiMessage {
  return {
    id,
    role: "user",
    content: "",
    payload: { image: attachment(dataUrl) },
    createdAt: T0,
  };
}

async function mountPage(): Promise<VueWrapper> {
  const w = mount(AiChatPage, {
    global: { plugins: [createPinia()], stubs: { Teleport: true, Transition: false } },
  });
  await flushPromises();
  return w as VueWrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.history.replaceState({ app: true }, "");
  const store = holder.store as { messages: UiMessage[]; revealed: Set<string> };
  store.messages = [];
  store.revealed = new Set<string>();
});

describe("AI 聊天页：历史缩略图的描边/底", () => {
  // 杀手：把模板里缩略图外面那层（`data-test="ai-message-thumb-frame"` 上的 `ring-1`）删掉 ⇒ 第一条红；
  // 把 `blur-lg` 挪到包裹层上（`<img>` 上不再有模糊）⇒ 既有 `AiChatPage.imageLightbox.test.ts` 也会红
  it("被遮 ⇒ 缩略图有一圈描边，且描边落在**不被模糊**的包裹层上（模糊不外溢）", async () => {
    const w = await mountPage();
    (holder.store as { messages: UiMessage[] }).messages = [imageMessage("m1", HISTORY_URL)];
    await flushPromises();

    const frame = w.get(FRAME);
    expect(frame.classes()).toContain("ring-1");
    // 外溢的模糊正是"小图与背景糊成一片"的来源 ⇒ 包裹层必须夹住它
    expect(frame.classes()).toContain("overflow-hidden");
    expect(w.get(THUMB).element.parentElement).toBe(frame.element);
    expect(w.get(THUMB).classes()).toContain("blur-lg");
  });
});
