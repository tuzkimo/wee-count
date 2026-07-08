import { describe, it, expect } from "vitest";
import { computeCrop } from "@/utils/crop";

describe("computeCrop", () => {
  const V = 200;

  it("正方形图 userScale=1 居中：采样整张图", () => {
    // 400×400 图，baseScale=0.5，居中 x=y=0
    const out = computeCrop({ imgW: 400, imgH: 400, viewport: V, userScale: 1, x: 0, y: 0 });
    expect(out.sx).toBe(0);
    expect(out.sy).toBe(0);
    expect(out.sSize).toBe(400);
  });

  it("宽图居中：取中部正方形", () => {
    // 800×200，baseScale=1，居中 x=-300, y=0
    const out = computeCrop({ imgW: 800, imgH: 200, viewport: V, userScale: 1, x: -300, y: 0 });
    expect(out.sx).toBe(300);
    expect(out.sy).toBe(0);
    expect(out.sSize).toBe(200);
  });

  it("高图居中：取中部正方形", () => {
    // 200×800，baseScale=1，居中 x=0, y=-300
    const out = computeCrop({ imgW: 200, imgH: 800, viewport: V, userScale: 1, x: 0, y: -300 });
    expect(out.sx).toBe(0);
    expect(out.sy).toBe(300);
    expect(out.sSize).toBe(200);
  });

  it("userScale=2 放大：采样更小的中心区域", () => {
    // 400×400，baseScale=0.5，total=1，居中 x=-100, y=-100
    const out = computeCrop({ imgW: 400, imgH: 400, viewport: V, userScale: 2, x: -100, y: -100 });
    expect(out.sx).toBe(100);
    expect(out.sy).toBe(100);
    expect(out.sSize).toBe(200);
  });

  it("偏移视窗左上角：sx/sy 反映图片右下区域", () => {
    // 800×200，baseScale=1，x=-600（视窗显示图片最右 200px），y=0
    const out = computeCrop({ imgW: 800, imgH: 200, viewport: V, userScale: 1, x: -600, y: 0 });
    expect(out.sx).toBe(600);
    expect(out.sy).toBe(0);
    expect(out.sSize).toBe(200);
  });
});
