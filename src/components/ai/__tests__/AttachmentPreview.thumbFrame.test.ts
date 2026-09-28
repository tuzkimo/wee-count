// `AttachmentPreview` 缩略图的**浅色描边/底**（实机反馈的后半条：列表里的小图模糊后也糊成一片）。
//
// 为什么单独一个文件：`AttachmentPreview.test.ts`（src/隐私提示/✕）与 `AttachmentPreview.preview.test.ts`
// （点开预览/模糊 class）都是既有的，**一个字不动**；这里只补"缩略图有一圈看得见的边界"。
//
// ⚠️ 与全屏查看器同一条约束：`blur-lg` 是 `filter: blur()`，画在同一个元素上的描边会被一起糊掉，
// 而且模糊会**向外溢**（与周围背景糊成一片）。所以描边必须落在一层**不被模糊**的包裹元素上，
// 并靠 `overflow-hidden` 把溢出的模糊夹在框里。
import { mount, type VueWrapper } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AttachmentPreview from "../AttachmentPreview.vue";
import type { ImageAttachment } from "@/services/ai/imageInput";

const image: ImageAttachment = {
  mime: "image/jpeg",
  dataUrl: "data:image/jpeg;base64,AAAA",
  width: 10,
  height: 10,
  bytes: 3,
};

const THUMB = '[data-test="attachment-thumb"]';
const FRAME = '[data-test="attachment-thumb-frame"]';

function frameOf(w: VueWrapper): ReturnType<VueWrapper["get"]> {
  return w.get(FRAME);
}

describe("AttachmentPreview：缩略图的描边/底", () => {
  // 杀手：把包裹 `<img>` 那层（`data-test="attachment-thumb-frame"` 上的 `ring-1`）删掉 ⇒ 第一条红；
  // 把模糊改到包裹层上（`<img>` 上不再有 `blur-lg`）⇒ 第二条红（既有 `AttachmentPreview.preview.test.ts` 也会红）
  it("被遮 ⇒ 缩略图有一圈描边，且描边落在**不被模糊**的包裹层上（模糊不外溢）", () => {
    const w = mount(AttachmentPreview, { props: { image, masked: true } });

    const frame = frameOf(w);
    expect(frame.classes()).toContain("ring-1");
    // 模糊外溢会把小图和背景糊在一起 ⇒ 包裹层必须把溢出的模糊夹住
    expect(frame.classes()).toContain("overflow-hidden");
    // 描边层是 `<img>` 的父层：filter 只作用在 `<img>` 上，描边因此保持清晰
    expect(w.get(THUMB).element.parentElement).toBe(frame.element);
    expect(w.get(THUMB).classes()).toContain("blur-lg");
  });

  // 杀手：把 `:class="masked ? ... : ''"` 那套搬到描边层上（清晰时描边消失）⇒ 第一条红
  it("清晰时描边照样在（小图与浅色背景之间也要有边界）", () => {
    const w = mount(AttachmentPreview, { props: { image, masked: false } });

    expect(frameOf(w).classes()).toContain("ring-1");
    expect(w.get(THUMB).classes()).not.toContain("blur-lg");
  });
});
