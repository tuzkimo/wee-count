// `toAttachment` 是**分享链与选图链共用的那一段**（魔数定音 → 压缩 → 体积闸门）。
// 它单独有测试，是因为分享链从此只依赖这一个函数：这里的边界一旦松动，
// 两条链会**同时**松（这正是"共用一份实现"要付的代价，所以它必须被钉住）。
//
// 只 mock 第三方插件（imageInput.ts 的模块图里有它们），imageScale 这个自家纯函数用真的。
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import { MSG_DECODE_FAILED, MSG_TOO_LARGE, MSG_UNSUPPORTED } from "../attachText";
import { type EncodeDeps, toAttachment } from "../imageInput";
import { MAX_BYTES } from "../imageScale";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF_BYTES = new TextEncoder().encode("GIF89a......");

/** 用真 base64 编码器造出**解码后恰好 n 字节**的 data URL。 */
function dataUrlOfBytes(n: number): string {
  return `data:image/jpeg;base64,${Buffer.alloc(n, 0x41).toString("base64")}`;
}

function depsReturning(dataUrl: string): { deps: EncodeDeps; toJpegDataUrl: ReturnType<typeof vi.fn> } {
  const toJpegDataUrl = vi.fn(async () => ({ dataUrl, width: 1280, height: 960 }));
  return { deps: { toJpegDataUrl }, toJpegDataUrl };
}

describe("toAttachment：准入判据只有字节头", () => {
  it("合法 JPEG ⇒ 成功，且 mime **固定** image/jpeg（canvas 导出的就是 JPEG）", async () => {
    const { deps } = depsReturning(dataUrlOfBytes(3000));
    await expect(toAttachment(JPEG_BYTES, deps)).resolves.toEqual({
      ok: true,
      image: {
        mime: "image/jpeg",
        dataUrl: dataUrlOfBytes(3000),
        width: 1280,
        height: 960,
        bytes: 3000,
      },
    });
  });

  it("GIF 字节 ⇒ 只支持那条文案，且**根本没进转码器**（定序：先定音、后转码）", async () => {
    const { deps, toJpegDataUrl } = depsReturning(dataUrlOfBytes(3000));
    await expect(toAttachment(GIF_BYTES, deps)).resolves.toEqual({
      ok: false,
      message: MSG_UNSUPPORTED,
    });
    expect(toJpegDataUrl).not.toHaveBeenCalled();
  });

  it("转码器抛 ⇒ 这张图片打不开", async () => {
    const toJpegDataUrl = vi.fn(async () => {
      throw new Error("decode failed");
    });
    await expect(toAttachment(JPEG_BYTES, { toJpegDataUrl })).resolves.toEqual({
      ok: false,
      message: MSG_DECODE_FAILED,
    });
  });

  it("编码结果为空 ⇒ 这张图片打不开（不是「图片太大」）", async () => {
    const { deps } = depsReturning("data:image/jpeg;base64,");
    await expect(toAttachment(JPEG_BYTES, deps)).resolves.toEqual({
      ok: false,
      message: MSG_DECODE_FAILED,
    });
  });

  it("压缩后超上限 ⇒ 图片太大", async () => {
    const { deps } = depsReturning(dataUrlOfBytes(MAX_BYTES + 1));
    await expect(toAttachment(JPEG_BYTES, deps)).resolves.toEqual({
      ok: false,
      message: MSG_TOO_LARGE,
    });
  });

  it("恰好等于上限 ⇒ 允许（边界含等号）", async () => {
    const { deps } = depsReturning(dataUrlOfBytes(MAX_BYTES));
    await expect(toAttachment(JPEG_BYTES, deps)).resolves.toMatchObject({ ok: true });
  });
  // ⚠️ 若"恰好等于上限"这条红了：说明 `isWithinByteLimit` 是**开区间**（既有实现说了算），
  //    改测试用 `MAX_BYTES - 1`，**不要**去改 `imageScale.ts` 的边界语义。
});
