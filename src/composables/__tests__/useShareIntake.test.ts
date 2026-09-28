// useShareIntake 的接线契约（规格 §5.4）：
//  - 五个拉取点里，**启动**、**回前台**、**`tauri://resumed`**、**扑空后的补拉**都在这里被钉住
//    （解锁补拉由 store 状态驱动，同样在本文件）；
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

/** plugin-fs 在文件不存在时抛出的**真实**形态（Rust `io::Error` 的 Display）。 */
const NOT_FOUND = "No such file or directory (os error 2)";

const fs = vi.hoisted(() => ({
  // ⚠️ 必须用 plugin-fs **真实抛出的措辞**：`readPending` 据此区分"文件不存在"（⇒ null，不打日志）
  //    与"真错误"（⇒ 抛出去 + warn + 不消费）。用 `new Error("ENOENT")` 这类假措辞会被判成真错误，
  //    于是每条用例都多一条 warn，且与真机行为不符。
  //（这里的字面量与下面 `NOT_FOUND` 同一份：`vi.hoisted` 的工厂跑在模块初始化之前，不能引用它。）
  readTextFile: vi.fn(async (_path: string, _opts?: unknown): Promise<string> => {
    throw new Error("No such file or directory (os error 2)");
  }),
  readFile: vi.fn(async (_path: string, _opts?: unknown): Promise<Uint8Array> => new Uint8Array([1])),
  remove: vi.fn(async (_path: string, _opts?: unknown): Promise<void> => undefined),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  // AppCache 的真实值是 **16**（`@tauri-apps/api/path` 的 `BaseDirectory` 枚举；12 是 `Temp`）。
  // 随手写 12 的话，"baseDir 传错/漏传"这一整类 bug 在用例里是全绿的。
  BaseDirectory: { AppCache: 16 },
  readTextFile: fs.readTextFile,
  readFile: fs.readFile,
  remove: fs.remove,
}));
// 组件模块图里有它（`imageInput.ts` 顶部 import 了 `plugin-dialog`，而本用例要跑真 canvas 链）
// 本文件不点选图，所以只需要一个不会在导入期出事的替身。
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const tauriWindow = vi.hoisted(() => ({
  eventNames: [] as string[],
  /** 真实保存 handler：只断言事件名的话，把回调换成空函数仍然全绿（第 4 个拉取点就没人钉了） */
  handlers: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: (event: string, handler: () => void) => {
      tauriWindow.eventNames.push(event);
      tauriWindow.handlers.push(handler);
      return Promise.resolve(() => undefined);
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
function hostWith(options: { retryDelayMs?: number } = {}) {
  return defineComponent({
    setup() {
      useShareIntake(options);
      return () => null;
    },
  });
}

/**
 * 默认宿主把补拉推到 60 秒后 —— 远大于任何用例的时长，于是 ①–⑥、⑪ 的"拉了几次"
 * 断言与生产行为无关地保持确定；补拉本身由 ⑦/⑨/⑩ 用小的 `retryDelayMs` 专门验证。
 * （卸载时定时器会被清掉，不留悬挂。）
 */
const Host = hostWith({ retryDelayMs: 60_000 });

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
    throw new Error(NOT_FOUND);
  });
  fs.readFile.mockReset();
  fs.readFile.mockResolvedValue(JPEG_BYTES);
  fs.remove.mockReset();
  fs.remove.mockResolvedValue(undefined);
  tauriWindow.eventNames.length = 0;
  tauriWindow.handlers.length = 0;
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
  it("① 没有待消费的分享 ⇒ 什么都不做、没有附件，**且一条日志都不打**", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountHost();
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
    expect(fs.readFile).not.toHaveBeenCalled();
    expect(useAiChatStore().attachedImage).toBeNull();
    // 用的就是 AppCache 这个基目录：不是 cwd、也不是绝对路径
    expect(fs.readTextFile).toHaveBeenCalledWith("share-inbox/pending.json", { baseDir: 16 });
    // "文件不存在"是绝大多数启动的正常路径，**不该**有日志。反方向（真错误 ⇒ 有 warn）由 ⑪ 钉住；
    // 这一条则保证 `isNotFound` 的正则若与真机 plugin-fs 的措辞不符时会红。
    expect(warn).not.toHaveBeenCalled();
  });

  it("② 有分享 ⇒ 附件进 store、inbox 被清掉（路径 + baseDir）、跳到 AI 页", async () => {
    const raw = imageRaw();
    fs.readTextFile.mockResolvedValue(raw);
    await mountHost();

    const ai = useAiChatStore();
    expect(ai.attachedImage).toMatchObject({ mime: "image/jpeg", width: 1280, height: 960, bytes: 3000 });
    expect(ai.imageNotice).toBe("");
    const file = (JSON.parse(raw) as { file: string }).file;
    // 读字节用的是 payload 里的文件名，且同样落在 AppCache 下
    expect(fs.readFile).toHaveBeenCalledWith(`share-inbox/${file}`, { baseDir: 16 });
    // 图 + pending.json 两份都要删，且**都必须带 AppCache**：漏掉 baseDir 时这一整套仍然全绿，
    // 而真机上的后果是 inbox 永不清空、每次回前台重弹一次文案
    expect(fs.remove).toHaveBeenCalledTimes(2);
    expect(fs.remove).toHaveBeenCalledWith(`share-inbox/${file}`, { baseDir: 16 });
    expect(fs.remove).toHaveBeenCalledWith("share-inbox/pending.json", { baseDir: 16 });
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

  it("⑥ 订阅的是 tauri://resumed，且那个回调**真的会拉**（第 4 个拉取点）", async () => {
    await mountHost();
    expect(tauriWindow.eventNames).toEqual(["tauri://resumed"]);
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);

    // 只断言事件名的话，把回调换成 `() => {}` 仍然全绿 —— 所以这里真的触发一次
    expect(tauriWindow.handlers).toHaveLength(1);
    tauriWindow.handlers[0]();
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(2);
  });

  it("⑦ 挂载后还补一次延迟重拉（后台拷贝可能晚于首次拉取落盘）", async () => {
    // 100ms 的注入延迟：远大于"挂载 + 一次 flushPromises"的耗时（实测 1–17ms），
    // 于是"补拉还在延迟窗口里"这件事可断言。用 0ms 会与本用例自己的等待撞在同一个
    // 定时器桶里：机器一忙，补拉可能在挂载阶段就已经跑掉，`1 次` 那条断言就假红。
    await mountHost(hostWith({ retryDelayMs: 100 }));
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
    const wrapper = await mountHost(hostWith({ retryDelayMs: 100 }));
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await flushPromises();
    // 定时器没清 ⇒ 卸载后还会拉一次（对着已经不存在的组件写 store）
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
  });

  it("⑨ 热启动补拉：回前台那次扑空后仍会再补一次（挂载时的定时器早已不在）", async () => {
    // 热启动的真实序列：`App.vue` **不会**重新挂载 ⇒ 挂载时排的那个定时器早就用掉了，
    // 只剩 visibilitychange / tauri://resumed 两次拉取。这两次都扑空时若不再补，
    // 用户看到的就是"分享了一把，什么都没发生"。
    // 100ms 的注入延迟（同 ⑦）：远大于一次 flushPromises（实测 1–17ms），"补拉还没到点"才可断言。
    await mountHost(hostWith({ retryDelayMs: 100 }));
    expect(fs.readTextFile).toHaveBeenCalledTimes(1); // 挂载那次（扑空）

    // 挂载排的那次补拉到点并用掉 ⇒ 此刻**没有**待命定时器（否则下面那次会被"已有定时器"挡掉）
    await vi.waitFor(() => expect(fs.readTextFile).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await flushPromises();

    // 回前台拉一次、又扑空 ⇒ 必须**再排一次**补拉
    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(3);

    // 那次补拉真的会跑（去掉"扑空补拉"⇒ 停在这条上 ⇒ 红）
    await vi.waitFor(() => expect(fs.readTextFile).toHaveBeenCalledTimes(4), { timeout: 2000 });
  });

  it("⑩ 回前台排的那次补拉再扑空 ⇒ 不再链下一次（只补一次，不是轮询）", async () => {
    await mountHost(hostWith({ retryDelayMs: 100 }));
    // 先把挂载排的那次用掉，让"事件拉取"能自己排一个
    await vi.waitFor(() => expect(fs.readTextFile).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await flushPromises();

    document.dispatchEvent(new Event("visibilitychange"));
    await flushPromises();
    // 3 = 回前台那次拉取，4 = 它排出来的补拉
    await vi.waitFor(() => expect(fs.readTextFile).toHaveBeenCalledTimes(4), { timeout: 2000 });

    // 补拉是"定时器触发"（不可再排）⇒ 再等三个延迟周期也涨不到 5
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(4);
  });

  it("⑪ 读 pending.json 抛真错误（不是「不存在」）⇒ 仍按 none 处理、有 warn、不消费、不弹文案", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // capability / scope 配错在真机上就长这样：**不是** "os error 2"
    fs.readTextFile.mockRejectedValue(new Error("forbidden path: not allowed by scope"));

    await mountHost();
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
    // "读不到" ≠ "这次没有分享"：一份都不许消费（否则图还躺在 inbox 里却已经记账了）
    expect(fs.remove).not.toHaveBeenCalled();
    expect(useAiChatStore().attachedImage).toBeNull();
    expect(useAiChatStore().imageNotice).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("⑫ 卸载之后才 resolve 的在途拉取不会再武装补拉（卸载后不读文件、不写 store）", async () => {
    // 挂载时那一次拉取**悬在半空**：读 pending.json 的 promise 由用例自己控
    let rejectPending: (e: unknown) => void = () => undefined;
    fs.readTextFile.mockImplementation(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectPending = reject;
        }),
    );

    const wrapper = await mountHost(hostWith({ retryDelayMs: 100 }));
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);

    // 先卸载（onUnmounted 只清"已武装"的定时器 —— 此刻还没有）
    wrapper.unmount();
    // 在途那次拉取随后才 resolve 成 "none"（= 文件不存在）
    rejectPending(new Error(NOT_FOUND));
    await flushPromises();

    // 少了 `stopped` 守卫时，这里会武装一个 100ms 的补拉 ⇒ 下面两次断言都会红
    await new Promise((resolve) => setTimeout(resolve, 200));
    await flushPromises();
    expect(fs.readTextFile).toHaveBeenCalledTimes(1);
    expect(useAiChatStore().attachedImage).toBeNull();
  });
});
