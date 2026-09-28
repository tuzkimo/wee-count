// `imageZoom`（图片查看器的手势算术，**纯函数**）单测。
//
// 为什么单独一个模块：双指 pinch / 拖动限位 / 双击切换这三件事的**算术**决定了对不对，
// 而它们在组件里只能靠"造两次 pointer 事件 + 读回 transform"间接观察。
// 抽出来之后，边界（不拖出边界、不小于原始、放大上限）可以逐条钉死，
// 组件那层只测"事件有没有接到这些函数上"。
import { describe, it, expect } from "vitest";
import {
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  MIN_SCALE,
  clampOffset,
  clampScale,
  doubleTapScale,
  panLimit,
  pinchScale,
  pointerDistance,
} from "../imageZoom";

describe("clampScale：缩放倍率的绝对范围", () => {
  it("小于 1 一律夹到 1（图片不许被缩到比原始更小）", () => {
    expect(clampScale(0.4)).toBe(MIN_SCALE);
    expect(clampScale(-3)).toBe(MIN_SCALE);
  });

  it("大于上限一律夹到上限", () => {
    expect(clampScale(99)).toBe(MAX_SCALE);
  });

  it("范围内的倍率原样保留", () => {
    expect(clampScale(2.5)).toBeCloseTo(2.5);
  });
});

describe("pinchScale：双指捏合的倍率换算", () => {
  it("两指距离翻倍 ⇒ 倍率翻倍", () => {
    expect(pinchScale(1, 100, 200)).toBeCloseTo(2);
  });

  it("两指距离不变 ⇒ 倍率不变（起手时不会跳一下）", () => {
    expect(pinchScale(1.5, 100, 100)).toBeCloseTo(1.5);
  });

  it("从已放大的状态继续捏合，是在**当前倍率**上乘，不是从 1 重算", () => {
    expect(pinchScale(2, 100, 150)).toBeCloseTo(3);
  });

  it("捏过头 ⇒ 夹在 1x / 4x 之内", () => {
    expect(pinchScale(1, 100, 10)).toBe(MIN_SCALE);
    expect(pinchScale(1, 100, 1000)).toBe(MAX_SCALE);
  });

  it("起始距离为 0（两指压在同一个点）⇒ 不退化成 Infinity/NaN", () => {
    const s = pinchScale(1.5, 0, 120);
    expect(Number.isFinite(s)).toBe(true);
    expect(s).toBeCloseTo(1.5);
  });
});

describe("doubleTapScale：双击在 1x / 2x 之间切换", () => {
  it("原始大小（或更小）⇒ 放到 2x", () => {
    expect(doubleTapScale(1)).toBe(DOUBLE_TAP_SCALE);
    expect(doubleTapScale(0.5)).toBe(DOUBLE_TAP_SCALE);
  });

  it("已经放大（含捏合到 3x）⇒ 回到 1x", () => {
    expect(doubleTapScale(2)).toBe(MIN_SCALE);
    expect(doubleTapScale(3)).toBe(MIN_SCALE);
  });
});

describe("pointerDistance：两指间距（3-4-5）", () => {
  it("按勾股算", () => {
    expect(pointerDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBeCloseTo(5);
  });
});

describe("panLimit / clampOffset：平移限位", () => {
  const frame = { width: 400, height: 800 };
  // 屏幕里的一张正方形图：上下能填满、左右留白
  const base = { width: 400, height: 400 };

  it("1x 时一个像素都不许拖（图片本来就完整可见）", () => {
    expect(panLimit(1, frame, base)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: 120, y: -80 }, 1, frame, base)).toEqual({ x: 0, y: 0 });
  });

  it("2x 时：宽 800 可左右各拖 (800-400)/2=200；高 800 与框等高 ⇒ 上下仍不许拖", () => {
    expect(panLimit(2, frame, base)).toEqual({ x: 200, y: 0 });
  });

  it("拖过头 ⇒ 夹在限位上（不拖出边界）", () => {
    expect(clampOffset({ x: 1000, y: 1000 }, 2, frame, base)).toEqual({ x: 200, y: 0 });
    expect(clampOffset({ x: -1000, y: -1000 }, 2, frame, base)).toEqual({ x: -200, y: 0 });
  });

  it("没拖过头 ⇒ 原样返回（限位不能变成吸附）", () => {
    expect(clampOffset({ x: 37, y: 0 }, 2, frame, base)).toEqual({ x: 37, y: 0 });
  });

  it("图片本来就比框大（base 大于 frame）⇒ 1x 也允许拖出被裁掉的部分", () => {
    expect(panLimit(1, { width: 400, height: 400 }, { width: 800, height: 600 })).toEqual({
      x: 200,
      y: 100,
    });
  });
});
