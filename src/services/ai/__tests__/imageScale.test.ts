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
} from "../imageScale";

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
