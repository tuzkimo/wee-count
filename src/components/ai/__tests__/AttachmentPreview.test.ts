// `AttachmentPreview`（规格 §3 步骤 3 / §7 / §9 第 12 条的同族）：
// 缩略图 + **隐私提示**（提示必须与缩略图同屏，用户点发送前一定读到）+ 撤掉。
import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AttachmentPreview from "../AttachmentPreview.vue";
import type { ImageAttachment } from "@/services/ai/imageInput";

// 显式标注类型：`mime` 是 `AcceptedMime` 联合，靠推断会退化成 `string`（vue-tsc 会红）
const image: ImageAttachment = {
  mime: "image/jpeg",
  dataUrl: "data:image/jpeg;base64,AAAA",
  width: 10,
  height: 10,
  bytes: 3,
};

describe("AttachmentPreview", () => {
  it("缩略图就是传进来的 dataUrl（不加工、不缩略到别处）", () => {
    const w = mount(AttachmentPreview, { props: { image } });
    expect(w.get('[data-test="attachment-thumb"]').attributes("src")).toBe(image.dataUrl);
  });

  // 若要它红，需要删掉 `data-test="attachment-notice"` 那段提示（或改掉它的文案）。
  it("显示规格 §3 的隐私提示（逐字）", () => {
    const w = mount(AttachmentPreview, { props: { image } });
    expect(w.get('[data-test="attachment-notice"]').text()).toBe("截图会整张发给模型，可能含余额等其他信息");
  });

  it("点 ✕ 发出 remove 事件（页面据此把附件从输入区拿掉）", async () => {
    const w = mount(AttachmentPreview, { props: { image } });
    await w.get('[data-test="attachment-remove"]').trigger("click");
    expect(w.emitted("remove")).toHaveLength(1);
  });
});
