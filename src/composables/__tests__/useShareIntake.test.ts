// useShareIntake 的接线契约（规格 §5.4）：
//  - 四个拉取点里，**启动**与**回前台**在这里被钉住（解锁补拉由 store 状态驱动，同样在本文件）；
//  - 锁定时**连 pending.json 都不读**；
//  - 成功路径走的是**真的** canvas 链（探针把 createImageBitmap 与 canvas 两个方法换掉），
//    所以"分享进来的图确实变成了附件"这件事不是靠 mock 自己的函数自证的。
//
// 只 mock 第三方模块与「本仓的 IO/网络边界」（与本仓 aiChat.* 用例同款），不 mock 自家纯函数。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

const fs = vi.hoisted(() => ({
  readTextFile: vi.fn(async (_path: string, _opts?: unknown): Promise<string> => {
    throw new Error("ENOENT");
  }),
  readFile: vi.fn(async (_path: string, _opts?: unknown): Promise<Uint8Array> => new Uint8Array([1])),
  remove: vi.fn(async (_path: string, _opts?: unknown): Promise<void> => undefined),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppCache: 12 },
  readTextFile: fs.readTextFile,
  readFile: fs.readFile,
  remove: fs.remove,
}));
// 组件模块图里有它（`imageInput.ts` 顶部 import 了 `plugin-dialog`，而本用例要跑真 canvas 链）
// 本文件不点选图，所以只需要一个不会在导入期出事的替身。
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const tauriWindow = vi.hoisted(() => ({
  eventNames: [] as string[],
  listen: (_event: string, _handler: () => void): Promise<() => void> => Promise.resolve(() => undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: (event: string, handler: () => void) => {
      tauriWindow.eventNames.push(event);
      return tauriWindow.listen(event, handler);
    },
  }),
}));

vi.mock("@/db/userDb", () => ({
  getUserDb: () => null,
  getCurrentUserId: () => "local-1",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async () => null,
}));
vi.mock("@/services/settingsFile", () => ({
  readSetting: vi.fn(async () => ({ kind: "absent" })),
  writeSetting: vi.fn(async () => undefined),
}));
vi.mock("@/services/ai/transport", () => ({
  createTransport: () => ({ chat: vi.fn() }),
  fetchAiStatus: vi.fn(async () => ({ enabled: false, model: null, host: null, failure: { kind: "network" } })),
}));
vi.mock("@/services/ai/agent", () => ({ runAgent: vi.fn() }));

import { useShareIntake } from "@/composables/useShareIntake";
import { useAiChatStore } from "@/stores/aiChat";
import { useLockStore } from "@/stores/lock";
// 文案的**唯一真相**在 attachText（字面量在那边被 `attachText.test.ts` 逐字钉住）：
// 这里 import 常量，不复制字符串 —— 否则第七份"文案副本"就会在测试里长出来。
import { MSG_MULTIPLE_TAKEN } from "@/services/ai/attachText";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** 宿主组件：composable 的 onMounted/onUnmounted 需要一个活动实例才会真的跑。 */
function hostWith(options: { bootRetryMs?: number } = {}) {
  return defineComponent({
    setup() {
      useShareIntake(options);
      return () => null;
    },
  });
}

/**
 * 默认宿主把延迟重拉推到 60 秒后 —— 远大于任何用例的时长，于是 ①–⑥ 的"拉了几次"
 * 断言与生产行为无关地保持确定；重拉本身由 ⑦ 用 `bootRetryMs: 0` 专门验证。
 * （卸载时定时器会被清掉，不留悬挂。）
 */
const Host = hostWith({ bootRetryMs: 60_000 });

let pinia: Pinia;
let router: Router;
const liveHosts = new Set<VueWrapper>();

function setVisibility(value: "visible" | "hidden"): void {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
}

async function mountHost(host = Host): Promise<VueWrapper> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/ai", component: { template: "<div />" } },
    ],
  });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(host, { global: { plugins: [pinia, router] } });
  liveHosts.add(wrapper);
  await flushPromises();
  return wrapper as VueWrapper;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  fs.readTextFile.mockReset();
  fs.readTextFile.mockImplementation(async () => {
    throw new Error("ENOENT");
  });
  fs.readFile.mockReset();
  fs.readFile.mockResolvedValue(JPEG_BYTES);
  fs.remove.mockReset();
  fs.remove.mockResolvedValue(undefined);
  tauriWindow.eventNames.length = 0;
  setVisibility("visible");

  // 真 canvas 链的探针：happy-dom 里 createImageBitmap 是 undefined、getContext 返回 null。
  // 源图 4000×3000 ⇒ `scaleToFit` 的长边 1280 ⇒ 1280×960（下面断言的就是这一对）。
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
    `data:image/jpeg;base64,${Buffer.alloc(3000, 0x41).toString("base64")}`,
  );
});

afterEach(() => {
  for (const wrapper of liveHosts) wrapper.unmount();
  liveHosts.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 每次给**唯一**原文：shareIntake 的去重按原文比（见它的用例文件头）。 */
let seq = 0;
function imageRaw(count = 1): string {
  seq += 1;
  return JSON.stringify({ v: 1, kind: "image", file: `f-${seq}.bin`, count });
}

describe("useShareIntake", () => {
  it("① 没有待消费的分享 ⇒ 什么都不做，也没有附件", async () => {
    await mountHost();
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(useAiChatStore().attachedImage).toBeNull();
    // 用的就是 AppCache 这个基目录：不是 cwd、也不是绝对路径
    expect(fs.readTextFile).toHaveBeenCalledWith("share-inbox/pending.json", { baseDir: 12 });
  });

  it("② 有分享 ⇒ 附件进 store、inbox 被清掉、跳到 AI 页", async () => {
    fs.readTextFile.mockResolvedValue(imageRaw());
    await mountHost();

    const ai = useAiChatStore();
    expect(ai.attachedImage).toMatchObject({ mime: "image/jpeg", width: 1280, height: 960, bytes: 3000 });
    expect(ai.imageNotice).toBe("");
    // 图 + pending.json 两份都要删
    expect(fs.remove).toHaveBeenCalledTimes(2);
    expect(router.currentRoute.value.path).toBe("/ai");
  });

  it("③ 多图分享 ⇒ 附件照附上，另加一行提示（文案逐字）", async () => {
    fs.readTextFile.mockResolvedValue(imageRaw(3));
    await mountHost();
    expect(useAiChatStore().attachedImage).not.toBeNull();
    expect(useAiChatStore().imageNotice).toBe(MSG_MULTIPLE_TAKEN);
  });

  it("④ 锁定时连 pending.json 都不读；解锁后补拉一次", async () => {
    const lock = useLockStore();
    lock.isLockConfigured = true;
    lock.lock();
    fs.readTextFile.mockResolvedValue(imageRaw());

    await mountHost();
    expect(fs.readTextFile).not.toHaveBeenCalled();
    expect(useAiChatStore().attachedImage).toBeNull();

    lock.unlock();
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
    expect(useAiChatStore().attachedImage).not.toBeNull();
  });

  it("⑤ 回到前台（visibilitychange → visible）再拉一次", async () => {
    await mountHost();
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(2);
  });

  it("⑥ 订阅的是 tauri://resumed（非 Tauri 环境静默跳过）", async () => {
    await mountHost();
    expect(tauriWindow.eventNames).toEqual(["tauri://resumed"]);
  });

  it("⑦ 挂载后还补一次延迟重拉（后台拷贝可能晚于首次拉取落盘）", async () => {
    // 100ms 的注入延迟：远大于"挂载 + 一次 flushPromises"的耗时（实测 1–17ms），
    // 于是"重拉还在延迟窗口里"这件事可断言。用 0ms 会与本用例自己的等待撞在同一个
    // 定时器桶里：机器一忙，重拉可能在挂载阶段就已经跑掉，`1 次` 那条断言就假红。
    await mountHost(hostWith({ bootRetryMs: 100 }));
    // ① 挂载只拉了一次：同步再拉一次的实现会让这里变成 2 ⇒ 红
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);

    // ② 延迟到点后**补拉一次**
    await vi.waitFor(() => expect(fs.readTextFile).toHaveBeenCalledTimes(2), { timeout: 2000 });

    // ③ 再等一段：**只补一次**，不是轮询（改成 setInterval 这里会数到 3+）
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(2);
  });

  it("⑧ 卸载后那次延迟重拉被清掉（不留悬挂定时器）", async () => {
    const wrapper = await mountHost(hostWith({ bootRetryMs: 100 }));
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushPromises();
    // 定时器没清 ⇒ 卸载后还会拉一次（对着已经不存在的组件写 store）
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
  });
});
