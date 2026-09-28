// `AttachmentPreview` 的**预览入口**与金额模糊（`AttachmentPreview.test.ts` 钉的是缩略图 src /
// 隐私提示 / ✕，本文件只补"点缩略图能看大图"和"遮蔽时缩略图模糊"这两件新事）。
//
// 组件仍然无状态、零 IO：`preview` 只是一个事件，谁打开查看器由页面决定；
// 模糊与否由调用方按 `useAmountMask` 的语义算好传进来（附件没有 messageId ⇒ 不存在 `revealed`）。
import { mount } from "@vue/test-utils";
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

describe("AttachmentPreview：点缩略图 ⇒ 请求全屏预览", () => {
  // 杀手：把缩略图上的 `@click="emit('preview')"` 删掉 ⇒ 这条红（"点图片没反应"）
  it("点缩略图发出 preview 事件", async () => {
    const w = mount(AttachmentPreview, { props: { image } });

    await w.get('[data-test="attachment-thumb"]').trigger("click");

    expect(w.emitted("preview")).toHaveLength(1);
  });

  // 杀手：把 `:class="masked ? 'blur-lg' : ''"` 删掉（或恒 false）⇒ 前两条红；
  // 写成恒 true ⇒ 第三条红
  it("masked=true ⇒ 缩略图带模糊 class；不传/ false ⇒ 清晰", () => {
    expect(
      mount(AttachmentPreview, { props: { image, masked: true } })
        .get('[data-test="attachment-thumb"]')
        .classes(),
    ).toContain("blur-lg");

    expect(
      mount(AttachmentPreview, { props: { image, masked: false } })
        .get('[data-test="attachment-thumb"]')
        .classes(),
    ).not.toContain("blur-lg");

    expect(
      mount(AttachmentPreview, { props: { image } })
        .get('[data-test="attachment-thumb"]')
        .classes(),
    ).not.toContain("blur-lg");
  });
});
