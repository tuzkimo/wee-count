// src/utils/pattern.ts
// 3×3 图案锁的纯逻辑。点位编号 1..9，行优先：
//   1 2 3
//   4 5 6
//   7 8 9

/** 合法图案的最少连线点数。 */
export const PATTERN_MIN_DOTS = 4;

/** 两个点位之间若隔着未访问的点，该点会被自动补入。键为 `起点-终点`。 */
const PASS_THROUGH: Readonly<Record<string, number>> = {
  "1-3": 2, "3-1": 2,
  "1-7": 4, "7-1": 4,
  "1-9": 5, "9-1": 5,
  "2-8": 5, "8-2": 5,
  "3-7": 5, "7-3": 5,
  "3-9": 6, "9-3": 6,
  "4-6": 5, "6-4": 5,
  "7-9": 8, "9-7": 8,
};

/** 点位中心坐标，size 为正方形画布边长。 */
export function dotCenter(dot: number, size: number): { x: number; y: number } {
  const cell = size / 3;
  const idx = dot - 1;
  return {
    x: (idx % 3 + 0.5) * cell,
    y: (Math.floor(idx / 3) + 0.5) * cell,
  };
}

/** 命中测试：返回半径内最近的点位编号，未命中返回 null。 */
export function hitTest(x: number, y: number, size: number, hitRadius: number): number | null {
  for (let dot = 1; dot <= 9; dot++) {
    const c = dotCenter(dot, size);
    if (Math.hypot(x - c.x, y - c.y) <= hitRadius) return dot;
  }
  return null;
}

/**
 * 追加一个点位，返回新序列（不修改入参）。
 * 已访问过的点直接忽略；跨过未访问中间点时先把中间点补入。
 */
export function appendDot(sequence: readonly number[], dot: number): number[] {
  if (sequence.includes(dot)) return [...sequence];
  const next = [...sequence];
  const last = next[next.length - 1];
  if (last !== undefined) {
    const middle = PASS_THROUGH[`${last}-${dot}`];
    if (middle !== undefined && !next.includes(middle)) next.push(middle);
  }
  next.push(dot);
  return next;
}

/** 合法图案：至少 PATTERN_MIN_DOTS 个点、均在 1..9、无重复。 */
export function isValidPattern(sequence: readonly number[]): boolean {
  if (sequence.length < PATTERN_MIN_DOTS) return false;
  const seen = new Set<number>();
  for (const dot of sequence) {
    if (!Number.isInteger(dot) || dot < 1 || dot > 9) return false;
    if (seen.has(dot)) return false;
    seen.add(dot);
  }
  return true;
}

/** 规范化编码，用作哈希输入。 */
export function encodePattern(sequence: readonly number[]): string {
  return sequence.join("-");
}
