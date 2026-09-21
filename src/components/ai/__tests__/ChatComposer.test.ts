import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import ChatComposer from "@/components/ai/ChatComposer.vue";

// M4 的选图入口用**真的** `imageInput`（walk 到真 canvas）：只 mock **第三方模块**（插件），
// 自己写的模块一律不 mock。happy-dom 里 canvas 不可用，所以成功路径靠 DOM 探针换掉
// `createImageBitmap` / `getContext` / `toDataURL` —— 换的是**环境**，不是我们的实现。
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

/** 用真 base64 编码器造出**解码后恰好 n 字节**的 data URL */
function dataUrlOfBytes(n: number): string {
  return `data:image/jpeg;base64,${Buffer.alloc(n, 0x41).toString("base64")}`;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

/** 让**真实**转码链在 happy-dom 里能跑通：位图 4000×3000 ⇒ 目标 1280×960 */
function stubRealCanvas(url: string): void {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(url);
}

function mountComposer(sending = false) {
  return mount(ChatComposer, { props: { sending } });
}

describe("ChatComposer", () => {
  it("点发送发出 trim 后的文本并清空输入框", async () => {
    const w = mountComposer();
    const input = w.get('[data-test="composer-input"]');
    await input.setValue("  上月买菜花了多少  ");
    await w.get('[data-test="composer-send"]').trigger("click");

    expect(w.emitted("send")).toEqual([["上月买菜花了多少"]]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("回车发送", async () => {
    const w = mountComposer();
    await w.get('[data-test="composer-input"]').setValue("本月支出");
    await w.get('[data-test="composer-input"]').trigger("keydown.enter");
    expect(w.emitted("send")).toEqual([["本月支出"]]);
  });

  it("空串与纯空白都**不发**（白发一次就是白烧一次配额）", async () => {
    const w = mountComposer();
    await w.get('[data-test="composer-send"]').trigger("click");
    expect(w.emitted("send")).toBeUndefined();

    await w.get('[data-test="composer-input"]').setValue("   \n  ");
    await w.get('[data-test="composer-send"]').trigger("click");
    await w.get('[data-test="composer-input"]').trigger("keydown.enter");
    expect(w.emitted("send")).toBeUndefined();
  });

  it("sending 时输入框禁用、发送按钮换成取消按钮", () => {
    const w = mountComposer(true);
    expect(w.get('[data-test="composer-input"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="composer-send"]').exists()).toBe(false);
    expect(w.find('[data-test="composer-cancel"]').exists()).toBe(true);
  });

  it("sending 时两个入口都真的发不出去（事件层，不只看禁用属性）", async () => {
    // ⚠️ 这条用例守的是**回车入口的唯一防线**：`<input>` 的 `:disabled="sending"`。
    // 判别力全靠下一行**必须走 `setValue`** —— 它会真派发 `input` 事件把 `text` 写成非空。
    // 曾经这里写的是 `(input.element).value = "..."`（只改 DOM、绕过 v-model）：`text` 仍是 `""`，
    // `onSend` 被**更早的** `if (value === "") return` 挡住 ⇒ 删掉 `:disabled` 这条用例照绿 = 零判别力
    // （复审 m15 定位到具体一行；改回 `setValue` 后 m15b 实测 2 红）。
    const w = mountComposer(true);
    const input = w.get('[data-test="composer-input"]');
    await input.setValue("还要再问一句");
    await input.trigger("keydown.enter");
    // 发送按钮在 sending 时**不渲染**（v-if），所以这里没有第二颗可点的按钮
    await w.get('[data-test="composer-cancel"]').trigger("click");

    expect(w.emitted("send")).toBeUndefined();
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("取消**不清空**已输入的文字（用户可能只是想停下来改一改）", async () => {
    const w = mountComposer(true);
    await w.get('[data-test="composer-input"]').setValue("上个月");
    await w.get('[data-test="composer-cancel"]').trigger("click");
    expect((w.get('[data-test="composer-input"]').element as HTMLInputElement).value).toBe("上个月");
  });
});

describe("ChatComposer：M4 选图入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 🔴 规格 §7：关闭时选图按钮与发送按钮**一并**不可用 ⇒ 必须是**同一道闸**（`:disabled="!enabled"`）。
  // 若要它红，需要把选图按钮的禁用条件改成常量（`false` ⇒ 前两条红；`true` ⇒ 后两条红）。
  it("意愿层关着 ⇒ 选图按钮与发送按钮同时不可用；开着 ⇒ 两颗都能点", () => {
    const off = mount(ChatComposer, { props: { sending: false, enabled: false } });
    expect(off.get('[data-test="composer-pick-image"]').attributes("disabled")).toBeDefined();
    expect(off.get('[data-test="composer-send"]').attributes("disabled")).toBeDefined();

    const on = mount(ChatComposer, { props: { sending: false, enabled: true } });
    expect(on.get('[data-test="composer-pick-image"]').attributes("disabled")).toBeUndefined();
    expect(on.get('[data-test="composer-send"]').attributes("disabled")).toBeUndefined();
  });

  it("取消选择 ⇒ 不报错、不出预览、不发 attach（§8「取消沿用 M3」）", async () => {
    vi.mocked(open).mockResolvedValue(null);
    const w = mountComposer();
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="composer-image-error"]').exists()).toBe(false);
    expect(w.find('[data-test="attachment-preview"]').exists()).toBe(false);
    expect(w.emitted("attach")).toBeUndefined();
  });

  it("选图失败 ⇒ 把 §8 文案显示在输入区上方（真实 imageInput：happy-dom 里没有 2d 上下文）", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
    );

    const w = mountComposer();
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="composer-image-error"]').text()).toBe("这张图片打不开");
    expect(w.find('[data-test="attachment-preview"]').exists()).toBe(false);
    expect(w.emitted("attach")).toBeUndefined();
  });

  it("选图成功 ⇒ 预览（缩略图 + 隐私提示）出现，并 emit attach 整份 image（§4.1）", async () => {
    const url = dataUrlOfBytes(3000);
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    stubRealCanvas(url);

    const w = mountComposer();
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="attachment-thumb"]').attributes("src")).toBe(url);
    expect(w.get('[data-test="attachment-notice"]').text()).toBe("截图会整张发给模型，可能含余额等其他信息");
    expect(w.emitted("attach")).toEqual([
      [{ mime: "image/jpeg", dataUrl: url, width: 1280, height: 960, bytes: 3000 }],
    ]);
  });

  it("点 ✕ ⇒ 预览消失（撤掉的只是**待发**附件）", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    stubRealCanvas(dataUrlOfBytes(3000));

    const w = mountComposer();
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="attachment-preview"]').exists()).toBe(true);

    await w.get('[data-test="attachment-remove"]').trigger("click");
    expect(w.find('[data-test="attachment-preview"]').exists()).toBe(false);
  });

  // 🔴 规格 §7：关掉的闸门是"发送权"，**不是**"已附的图" —— 关开关时预览必须还在（不能被顺手清空）。
  // 若要它红，需要让预览依赖 `enabled`（例如 `<AttachmentPreview v-if="attached && enabled">`，
  // 或在关闭时 `watch` 清空 `attached`）。
  it("意愿层**关掉**时，已附的图保留可见（只是不能再发）", async () => {
    const url = dataUrlOfBytes(3000);
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    stubRealCanvas(url);

    const w = mount(ChatComposer, { props: { sending: false, enabled: true } });
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="attachment-preview"]').exists()).toBe(true);

    await w.setProps({ enabled: false });

    // 预览与缩略图**原样还在**（含隐私提示 —— 用户此刻仍需看到"这张图会整张发出去"）
    expect(w.find('[data-test="attachment-preview"]').exists()).toBe(true);
    expect(w.get('[data-test="attachment-thumb"]').attributes("src")).toBe(url);
    expect(w.get('[data-test="attachment-notice"]').text()).toBe("截图会整张发给模型，可能含余额等其他信息");
    // 而发送权没了：两颗按钮都禁用
    expect(w.get('[data-test="composer-send"]').attributes("disabled")).toBeDefined();
    expect(w.get('[data-test="composer-pick-image"]').attributes("disabled")).toBeDefined();
  });

  // 🔴 取消 = 放弃这次挑选 ⇒ 上一轮的失败文案要被清掉（否则它会一直挂在输入区上方误导人）。
  // 若要它红，需要让取消分支直接 `return`（不清 `imageError`）。
  it("失败后再取消 ⇒ 上一轮的失败文案被清掉", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
    );

    const w = mountComposer();
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();
    expect(w.get('[data-test="composer-image-error"]').text()).toBe("这张图片打不开");

    // 第二次点击：用户取消了选择
    vi.mocked(open).mockResolvedValue(null);
    await w.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="composer-image-error"]').exists()).toBe(false);
  });
});
