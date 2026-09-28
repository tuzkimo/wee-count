// 附件文案的**逐字**哨兵：这六句话是用户在失败路径上唯一看得见的东西，
// 搬运（从 imageInput.ts 搬来这里）与后续改动都不许悄悄改口径。
import { describe, expect, it } from "vitest";
import {
  MSG_DECODE_FAILED,
  MSG_MULTIPLE_TAKEN,
  MSG_NO_STREAM,
  MSG_READ_FAILED,
  MSG_TOO_LARGE,
  MSG_UNSUPPORTED,
  messageForShareCode,
} from "../attachText";

describe("attachText：M4 §8 的四条文案（搬运后逐字未变）", () => {
  it("逐字照抄", () => {
    expect(MSG_UNSUPPORTED).toBe("只支持 JPEG / PNG / WebP 图片");
    expect(MSG_READ_FAILED).toBe("读不到这张图片，请重试");
    expect(MSG_DECODE_FAILED).toBe("这张图片打不开");
    expect(MSG_TOO_LARGE).toBe("图片太大，换一张或先裁剪");
  });
});

describe("attachText：分享链新增的两条与 code 映射", () => {
  it("新增文案逐字", () => {
    expect(MSG_NO_STREAM).toBe("这条分享里没有图片");
    expect(MSG_MULTIPLE_TAKEN).toBe("一次只能记一张，已用第一张");
  });

  it("三个原生 code 各自映射到一条已存在的文案（原生侧不写中文）", () => {
    expect(messageForShareCode("no_stream")).toBe(MSG_NO_STREAM);
    expect(messageForShareCode("read_failed")).toBe(MSG_READ_FAILED);
    expect(messageForShareCode("source_too_large")).toBe(MSG_TOO_LARGE);
  });
});
