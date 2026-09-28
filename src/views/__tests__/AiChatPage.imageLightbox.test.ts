// AI 聊天页：**点图片 ⇒ 全屏预览** 的页面侧接线（两处入口：历史消息缩略图、待发附件）。
//
// 为什么单独一个文件、并且**替身掉 `aiChat` store**：既有 `AiChatPage.test.ts` 走的是
// "真 store + 真 session + 真 sqlite"的端到端链路，它钉的是快照/草稿归位那几件事；
// 这里要钉的只有"模板里那两处 @click 有没有接到查看器上、模糊跟着谁走、返回键关不关得掉"，
// 属于页面**接线**，用替身 store 喂一条带图的消息就够（与 `FilterPage.test.ts` 的替身惯例一致）。
// 既有文件一个字都不动。
//
// 断言读的是 DOM（查看器在不在、`<img>` 的 src、模糊 class、`history.state`），不是内部变量。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { usePrefsStore } from "@/stores/prefs";
import type { UiMessage } from "@/stores/aiChat";
import type { ImageAttachment } from "@/services/ai/imageInput";

const T0 = "2026-03-01T00:00:00.000Z";
const HISTORY_URL = "data:image/jpeg;base64,HISTORY";
const ATTACH_URL = "data:image/jpeg;base64,ATTACH";

/** 页面从 store 上取用的那一份（形状按模板/脚本里的实际用法给足，别的一律不实现） */
interface FakeAiChat {
  messages: UiMessage[];
  loading: boolean;
  sending: boolean;
  sendingEnabled: boolean;
  sendingHint: string;
  configured: boolean | null;
  host: string | null;
  privacyCardSeen: boolean;
  revealed: Set<string>;
  pendingDrafts: never[];
  confirmedDrafts: never[];
  rejectedDrafts: never[];
  attachedImage: ImageAttachment | null;
  load: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  send: (text: string) => void;
  cancel: () => void;
  clear: () => void;
  dismissPrivacyCard: () => Promise<void>;
  setAttachedImage: (image: ImageAttachment) => void;
  clearAttachedImage: () => void;
}

const holder = vi.hoisted(() => ({ store: null as unknown }));

vi.mock("@/stores/aiChat", async () => {
  const { reactive } = await import("vue");
  const store = reactive({
    messages: [] as UiMessage[],
    loading: false,
    sending: false,
    // §7.3 意愿层：不置位的话输入框与发送键都禁用（本文件不测门控，只让它可点）
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
    setAttachedImage: (image: ImageAttachment) => {
      store.attachedImage = image;
    },
    clearAttachedImage: () => {
      store.attachedImage = null;
    },
  });
  holder.store = store;
  return { useAiChatStore: () => store };
});

// 页面其余四个 store：本文件不关心账本/名表（`currentLedger` 缺席 ⇒ 页面跳过名表加载）
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

const aiStore = (): FakeAiChat => holder.store as FakeAiChat;

function attachment(dataUrl: string): ImageAttachment {
  return { mime: "image/jpeg", dataUrl, width: 1280, height: 960, bytes: 3 };
}

/** 一条带图的历史 user 消息（§4.1：图只进 payload，content 是纯文本） */
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
    global: {
      plugins: [createPinia()],
      // Teleport 内容在 happy-dom 下不在 wrapper 内，stub 成透传（同 FilterPage.test.ts:108）
      stubs: { Teleport: true, Transition: false },
    },
  });
  await flushPromises();
  return w as VueWrapper;
}

const LIGHTBOX = '[data-test="image-lightbox"]';
const LIGHTBOX_IMAGE = '[data-test="lightbox-image"]';
const THUMB = '[data-test="ai-message-thumb"]';
const ATTACH_THUMB = '[data-test="attachment-thumb"]';

beforeEach(() => {
  setActivePinia(createPinia());
  window.history.replaceState({ app: true }, "");
  const ai = aiStore();
  ai.messages = [];
  ai.revealed = new Set<string>();
  ai.attachedImage = null;
});

describe("AI 聊天页：点历史消息缩略图 ⇒ 全屏预览", () => {
  // 杀手：把模板里缩略图那行的 `@click="openMessageImage(m.id)"` 删掉 ⇒ 第一条红
  //（这正是本片派单要修的"点图片没反应"）
  it("点缩略图 ⇒ 查看器打开，src 就是那条消息的图；点 ✕ ⇒ 关掉", async () => {
    const w = await mountPage();
    aiStore().messages = [imageMessage("m1", HISTORY_URL)];
    await flushPromises();

    expect(w.find(LIGHTBOX).exists()).toBe(false);

    await w.get(THUMB).trigger("click");

    expect(w.get(LIGHTBOX_IMAGE).attributes("src")).toBe(HISTORY_URL);

    await w.get('[data-test="lightbox-close"]').trigger("click");

    expect(w.find(LIGHTBOX).exists()).toBe(false);
  });

  // 杀手：把缩略图上 `:class="isMasked(m.id) ? 'blur-lg' : ''"` 删掉 ⇒ 第一条红；
  // 把查看器的 `:masked="viewerMasked"` 写死 false ⇒ 第二条红；
  // 把 `viewerMasked` 写成只看 `amountsHidden`（不看 revealed）⇒ 最后一条红
  it("金额遮蔽开着 ⇒ 缩略图与全屏都模糊；这条被眼睛揭示（revealed）后两边都清晰", async () => {
    const w = await mountPage();
    aiStore().messages = [imageMessage("m1", HISTORY_URL)];
    await flushPromises();

    // 历史消息 + 全局遮蔽开着 ⇒ 两条路都遮
    expect(usePrefsStore().amountsHidden).toBe(true);
    expect(w.get(THUMB).classes()).toContain("blur-lg");

    await w.get(THUMB).trigger("click");
    expect(w.get(LIGHTBOX_IMAGE).classes()).toContain("blur-lg");

    // §7.4 乙方案：`revealed` 是这条消息被"本轮问出来"的标记 ⇒ 揭示后清晰（不新增任何交互）
    aiStore().revealed.add("m1");
    await flushPromises();
    expect(w.get(LIGHTBOX_IMAGE).classes()).not.toContain("blur-lg");

    await w.get('[data-test="lightbox-close"]').trigger("click");
    expect(w.get(THUMB).classes()).not.toContain("blur-lg");
  });

  // 杀手：把 `isMasked` 改成恒 true（或把 `amountsHidden` 忽略掉）⇒ 这条红
  it("用户自己关掉遮蔽（眼睛控的是全局 amountsHidden）⇒ 缩略图与全屏都清晰", async () => {
    const w = await mountPage();
    // ⚠️ 必须在 mount 之后改：`mountPage` 自己 new 一个 pinia，先改会改到上一个实例上
    usePrefsStore().amountsHidden = false;
    aiStore().messages = [imageMessage("m1", HISTORY_URL)];
    await flushPromises();

    expect(w.get(THUMB).classes()).not.toContain("blur-lg");

    await w.get(THUMB).trigger("click");
    expect(w.get(LIGHTBOX_IMAGE).classes()).not.toContain("blur-lg");
  });
});

describe("AI 聊天页：点待发附件缩略图 ⇒ 全屏预览", () => {
  // 杀手：删掉 AttachmentPreview 缩略图的 `@click="emit('preview')"`、或 ChatComposer 的
  // `@preview="emit('preview')"` 转发、或页面上的 `@preview="openAttachmentImage"` ⇒ 第一条红
  it("点附件缩略图 ⇒ 查看器打开的是那张待发图；遮蔽开着时附件缩略图也模糊", async () => {
    const w = await mountPage();
    aiStore().attachedImage = attachment(ATTACH_URL);
    await flushPromises();

    expect(w.get(ATTACH_THUMB).classes()).toContain("blur-lg");

    await w.get(ATTACH_THUMB).trigger("click");

    expect(w.get(LIGHTBOX_IMAGE).attributes("src")).toBe(ATTACH_URL);
    expect(w.get(LIGHTBOX_IMAGE).classes()).toContain("blur-lg");
  });
});

describe("AI 聊天页：返回键关闭查看器", () => {
  // 杀手：把 ImageLightbox 里 `pushState` + `popstate` 那段删掉 ⇒ 第二条红（返回键关不掉）
  it("Android 返回键（popstate）⇒ 查看器关掉，哨兵条目被收回", async () => {
    const w = await mountPage();
    aiStore().messages = [imageMessage("m1", HISTORY_URL)];
    await flushPromises();

    await w.get(THUMB).trigger("click");
    expect(window.history.state).toEqual({ app: true, weeCountImageLightbox: true });

    window.history.back();

    await vi.waitFor(() => expect(w.find(LIGHTBOX).exists()).toBe(false));
    expect(window.history.state).toEqual({ app: true });
  });
});
