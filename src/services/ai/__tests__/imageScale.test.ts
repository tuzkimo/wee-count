// 图片尺寸与准入门槛（M4 规格 §1「本地压缩：最大边 1280px、JPEG 质量 0.72、压缩后超 1MiB 则拒绝」
// ＋ §9 测试清单第 6–8 条）。
//
// 为什么这些规则必须住在**无 DOM 的纯函数**里：canvas 与 Tauri 插件在 happy-dom 里都不可用
// （没有真 canvas、没有 IPC），任何"可判定的规则"只要留在有 DOM 的壳里就**测不了**。所以
// 尺寸换算、体积闸门、类型白名单全在 `imageScale.ts` 里判定，canvas 只是执行者
// （任务 3 的 `imageInput.ts`），本文件直测那些判定。
//
// ⚠️ 边界值（"恰好等于上限"）是这一族规则里唯一真正会出错的地方：`<=` 写成 `<` 在正常
// 尺寸下毫无症状，只在边界那一像素/那一字节上表现 ⇒ 每个边界各有一条用例钉住。
import { describe, expect, it } from "vitest";
import {
  MAX_BYTES,
  MAX_EDGE,
  dataUrlByteLength,
  isAcceptedMime,
  isWithinByteLimit,
  scaleToFit,
  sniffImageMime,
} from "../imageScale";

describe("规格 §1 的常量值（MAX_EDGE / MAX_BYTES 是规格值，不是旋钮）", () => {
  // 这两条钉的是**值本身**：其余用例全走导出符号，把 1280 改成 2560 它们**全都不会红**
  // （符号跟着一起变），而那已经违反规格 §1 了。
  it("MAX_EDGE 是规格 §1 的 1280px（不是可随手调的旋钮）", () => {
    expect(MAX_EDGE).toBe(1280);
  });

  it("MAX_BYTES 是规格 §1 的 1 MiB（不是可随手调的旋钮）", () => {
    expect(MAX_BYTES).toBe(1024 * 1024);
  });

  // ⚠️ **刻意不钉 `JPEG_QUALITY`**：规格 §10.5 把"质量 0.72 / 最大边 1280px"留作真机实测后的
  // 调参旋钮。钉死它会把一次**有意调参**变成红测试，也会让"对照变异"失去落点。
});

describe("scaleToFit", () => {
  it("长边不超过上限时不缩放，且原样返回尺寸", () => {
    expect(scaleToFit({ width: 800, height: 600 })).toEqual({ width: 800, height: 600, scaled: false });
  });

  it("长边恰好等于上限时不缩放（边界不允许被误判）", () => {
    expect(scaleToFit({ width: MAX_EDGE, height: 10 }).scaled).toBe(false);
  });

  it("长边超上限时按长边等比缩到上限", () => {
    expect(scaleToFit({ width: 2560, height: 1280 })).toEqual({ width: MAX_EDGE, height: 640, scaled: true });
  });

  it("极端长宽比不产生 0 边（Math.round 会把它压成 0）", () => {
    const out = scaleToFit({ width: 20000, height: 3 });
    expect(out.width).toBe(MAX_EDGE);
    expect(out.height).toBeGreaterThanOrEqual(1);
  });

  it("竖图（高 > 宽）同样按长边缩", () => {
    expect(scaleToFit({ width: 600, height: 2400 })).toEqual({ width: 320, height: MAX_EDGE, scaled: true });
  });
});

describe("isAcceptedMime", () => {
  it("接受 JPEG / PNG / WebP", () => {
    expect(isAcceptedMime("image/jpeg")).toBe(true);
    expect(isAcceptedMime("image/png")).toBe(true);
    expect(isAcceptedMime("image/webp")).toBe(true);
  });

  it("拒绝 GIF / HEIC / 非图片（规格 §1：只接受静态位图）", () => {
    expect(isAcceptedMime("image/gif")).toBe(false);
    expect(isAcceptedMime("image/heic")).toBe(false);
    expect(isAcceptedMime("application/pdf")).toBe(false);
  });
});

describe("isWithinByteLimit", () => {
  it("恰好等于上限通过", () => {
    expect(isWithinByteLimit(MAX_BYTES)).toBe(true);
  });

  it("超上限 1 字节即拒绝", () => {
    expect(isWithinByteLimit(MAX_BYTES + 1)).toBe(false);
  });

  it("0 字节视为无效（空文件不是合法图片）", () => {
    expect(isWithinByteLimit(0)).toBe(false);
  });
});

describe("dataUrlByteLength", () => {
  it("无 padding 时按 base64 长度换算成解码字节数", () => {
    // "AAAA" 4 个字符 ⇒ 3 字节
    expect(dataUrlByteLength("data:image/jpeg;base64,AAAA")).toBe(3);
  });

  it("带 padding 时扣除补齐字节（`==` 扣 2、`=` 扣 1）", () => {
    // "AA==" 4 个字符里 3 字节的位置只有 1 字节是真数据；"AAA=" 是 2 字节。
    // 少扣这两字节会让 §4.1 的 `payload.image.bytes` 与 1MiB 闸门一起偏大。
    expect(dataUrlByteLength("data:image/jpeg;base64,AA==")).toBe(1);
    expect(dataUrlByteLength("data:image/jpeg;base64,AAA=")).toBe(2);
  });

  it("缺逗号或空 base64 ⇒ 0（不成负数、不成 NaN）", () => {
    expect(dataUrlByteLength("data:image/jpeg;base64")).toBe(0);
    expect(dataUrlByteLength("data:image/jpeg;base64,")).toBe(0);
  });
});

describe("sniffImageMime", () => {
  // 字节头才是准入判据：扩展名可以被改名伪造，而 `createImageBitmap` 解得出 GIF 的第一帧
  // ⇒ 只看扩展名等于给规格 §1 的"只接受静态位图"开后门。
  const bytes = (...vals: number[]): Uint8Array => new Uint8Array(vals);

  it("JPEG：FF D8 FF 开头 ⇒ image/jpeg", () => {
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43))).toBe("image/jpeg");
  });

  it("PNG：8 字节签名 ⇒ image/png", () => {
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });

  it("WebP：RIFF 容器头 + WEBP 四字符编码 ⇒ image/webp", () => {
    // 4..7 字节是分块长度（这里是 0x1a），任意值都必须照判
    expect(sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50))).toBe(
      "image/webp",
    );
    expect(sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0xff, 0x57, 0x45, 0x42, 0x50, 0x56))).toBe(
      "image/webp",
    );
  });

  it("GIF（GIF87a / GIF89a）⇒ null —— 本函数存在的理由：改名成 .jpg 的动图必须被拒", () => {
    expect(sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBeNull();
    expect(sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61))).toBeNull();
  });

  it("PDF / HEIC 等非静态位图容器 ⇒ null", () => {
    expect(sniffImageMime(bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34))).toBeNull(); // "%PDF-1.4"
    expect(
      sniffImageMime(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63)),
    ).toBeNull(); // ftyp heic
  });

  it("空数组与长度不足 ⇒ null，且不抛异常", () => {
    expect(sniffImageMime(new Uint8Array(0))).toBeNull();
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e))).toBeNull(); // PNG 签名只有 3 字节（需要 8）
    expect(sniffImageMime(bytes(0x52, 0x49, 0x46))).toBeNull(); // "RIF" 只有 3 字节（需要 12）
  });

  it("前缀正确但被截断 ⇒ null", () => {
    expect(sniffImageMime(bytes(0xff, 0xd8))).toBeNull(); // JPEG 只有 SOI，没有第三个字节
    expect(sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull(); // PNG 前 7 字节
    expect(sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42))).toBeNull(); // 少最后一位 P
  });

  it("JPEG 分支的第三个字节：FF D8 之后不是 FF ⇒ null（不是合法 JPEG 头）", () => {
    // 这条是 `bytes[2] === 0xff` 子句的唯一杀手：上面七条对那个子句全都视而不见
    // （真 JPEG 的第三字节本来就是 FF，截断用例又过不了 `length >= 3`）。
    expect(sniffImageMime(bytes(0xff, 0xd8, 0x00))).toBeNull();
    expect(sniffImageMime(bytes(0xff, 0xd8, 0x4a, 0x00))).toBeNull();
  });
});
