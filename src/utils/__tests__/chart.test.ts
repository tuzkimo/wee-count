import { describe, it, expect } from "vitest";
import {
  computeLinePoints, niceTicks, donutAngles, arcPath, nearestIndex,
} from "@/utils/chart";

describe("computeLinePoints", () => {
  it("maps values to pixel coords with pad, baseline 0", () => {
    const pts = computeLinePoints([0, 50, 100], 200, 100, 10);
    expect(pts[0]).toEqual({ x: 10, y: 90 });
    // 修正：0→90 与 100→10 是线性（drop 80），故 50→50（简报原值 45 不可能）
    expect(pts[1].y).toBe(50);
    expect(pts[2]).toEqual({ x: 190, y: 10 });
  });
  it("avoids divide-by-zero when all values are 0", () => {
    const pts = computeLinePoints([0, 0], 200, 100, 10);
    expect(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
  it("centers a single point", () => {
    const pts = computeLinePoints([42], 200, 100, 10);
    expect(pts[0].x).toBe(100);
  });
  it("respects an explicit max", () => {
    const pts = computeLinePoints([5], 200, 100, 10, 100);
    expect(pts[0].y).toBeGreaterThan(pts[0].y - 100); // 5/100 → 靠近底边
    expect(pts[0].y).toBe(90 - 80 * 0.05); // 90 - (100-2*10)*0.05
  });
});

describe("niceTicks", () => {
  it("produces ascending ticks including 0", () => {
    const t = niceTicks(83, 4);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(83);
    expect(t.every((v, i) => i === 0 || v > t[i - 1])).toBe(true);
  });
});

describe("donutAngles", () => {
  it("allocates radians proportional to values from -PI/2", () => {
    const a = donutAngles([100, 100]);
    expect(a[0].start).toBeCloseTo(-Math.PI / 2);
    expect(a[1].end - a[0].start).toBeCloseTo(Math.PI * 2);
    expect(a[1].start).toBeCloseTo(a[0].end);
  });
  it("splits evenly when all values are 0", () => {
    const a = donutAngles([0, 0]);
    expect(a[1].end - a[0].start).toBeCloseTo(Math.PI * 2);
  });
});

describe("arcPath", () => {
  it("produces an M...A...Z path for a full circle", () => {
    const d = arcPath(50, 50, 40, 20, 0, Math.PI * 2);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("A 40 40");
    expect(d).toContain("A 20 20");
  });
});

describe("nearestIndex", () => {
  it("finds nearest index", () => {
    expect(nearestIndex(15, [0, 10, 20])).toBe(1);
    expect(nearestIndex(5, [0, 10, 20])).toBe(0);
  });
});
