import { describe, it, expect } from "vitest";
import {
  PATTERN_MIN_DOTS,
  appendDot,
  dotCenter,
  encodePattern,
  hitTest,
  isValidPattern,
} from "@/utils/pattern";

describe("pattern", () => {
  it("最少连线点数为 4", () => {
    expect(PATTERN_MIN_DOTS).toBe(4);
  });

  it("appendDot 依次追加未访问的点", () => {
    expect(appendDot([], 1)).toEqual([1]);
    expect(appendDot([1], 5)).toEqual([1, 5]);
  });

  it("appendDot 忽略重复点", () => {
    expect(appendDot([1, 2], 2)).toEqual([1, 2]);
    expect(appendDot([1, 2, 3, 5], 2)).toEqual([1, 2, 3, 5]);
  });

  it("appendDot 自动补入被跨过的中间点", () => {
    expect(appendDot([1], 3)).toEqual([1, 2, 3]);
    expect(appendDot([1], 9)).toEqual([1, 5, 9]);
    expect(appendDot([2], 8)).toEqual([2, 5, 8]);
    expect(appendDot([4], 6)).toEqual([4, 5, 6]);
    expect(appendDot([7], 3)).toEqual([7, 5, 3]);
  });

  it("中间点已被访问过时不再补入", () => {
    expect(appendDot([1, 2], 3)).toEqual([1, 2, 3]);
    expect(appendDot([4, 5], 6)).toEqual([4, 5, 6]);
  });

  it("无中间点的连线直接追加", () => {
    expect(appendDot([1], 6)).toEqual([1, 6]);
    expect(appendDot([5], 9)).toEqual([5, 9]);
  });

  it("isValidPattern 要求至少 4 点且点位合法无重复", () => {
    expect(isValidPattern([1, 2, 3])).toBe(false);
    expect(isValidPattern([1, 2, 3, 4])).toBe(true);
    expect(isValidPattern([1, 2, 3, 5, 7])).toBe(true);
    expect(isValidPattern([1, 2, 3, 2])).toBe(false);
    expect(isValidPattern([1, 2, 3, 10])).toBe(false);
    expect(isValidPattern([0, 2, 3, 4])).toBe(false);
  });

  it("encodePattern 产出稳定的规范化编码", () => {
    expect(encodePattern([1, 2, 3, 5, 7])).toBe("1-2-3-5-7");
    expect(encodePattern([9])).toBe("9");
  });

  it("dotCenter 按 3×3 行优先排布", () => {
    expect(dotCenter(1, 300)).toEqual({ x: 50, y: 50 });
    expect(dotCenter(5, 300)).toEqual({ x: 150, y: 150 });
    expect(dotCenter(9, 300)).toEqual({ x: 250, y: 250 });
  });

  it("hitTest 命中半径内返回点位编号，否则返回 null", () => {
    expect(hitTest(50, 50, 300, 30)).toBe(1);
    expect(hitTest(250, 250, 300, 30)).toBe(9);
    expect(hitTest(150, 10, 300, 30)).toBeNull();
  });
});
