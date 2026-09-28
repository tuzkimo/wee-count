// src/components/imageZoom.ts
//
// 图片查看器的**手势算术**（纯函数，零 DOM、零 Vue）。
//
// 为什么单独一份：捏合倍率、双击切换、平移限位这三件事的**对不对**全在算术里，而它们在组件里
// 只能靠"造两次 pointer 事件 + 读回 transform"间接观察。抽出来之后边界可以逐条钉死
// （见 `__tests__/imageZoom.test.ts`），组件那层只负责"事件接到了这些函数上"。
//
// ⚠️ 限位用的是**框**而不是图片自己：`panLimit` 要同时表达两件事 —— 比框大时可以拖到看见边缘、
// 比框小时必须居中（否则"拖出边界"就是图片被拖到黑底上、或者干脆滑出屏幕）。

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 不小于原始尺寸（人类明确要求：不许把图缩得比原始还小） */
export const MIN_SCALE = 1;
/** 捏合上限。双击只到 2x（`DOUBLE_TAP_SCALE`），4x 留给捏合去找细节 */
export const MAX_SCALE = 4;
export const DOUBLE_TAP_SCALE = 2;

export function clampScale(scale: number, min: number = MIN_SCALE, max: number = MAX_SCALE): number {
  return Math.min(max, Math.max(min, scale));
}

/** 两指间距（`pointerDistance`）：捏合倍率的唯一输入 */
export function pointerDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 捏合过程中的倍率：**在起手倍率上乘距离比**，不是"从 1 重算"。
 *
 * `startDistance <= 0`（两指压在同一点，或事件没带坐标）时保持起手倍率：除零会得到
 * `Infinity`/`NaN`，而 `NaN` 一旦写进 `transform` 就是一个再也拉不回来的坏值。
 */
export function pinchScale(
  startScale: number,
  startDistance: number,
  currentDistance: number,
): number {
  if (startDistance <= 0) return clampScale(startScale);
  return clampScale(startScale * (currentDistance / startDistance));
}

/** 双击的落点：原始（含被夹到下限的）⇒ 2x；已经放大 ⇒ 回 1x */
export function doubleTapScale(current: number): number {
  return current > MIN_SCALE ? MIN_SCALE : DOUBLE_TAP_SCALE;
}

/**
 * 平移限位（每个轴各一个绝对值）：只有"放大后多出来的那部分"可以拖出来。
 *
 * - `base * scale <= frame`：该轴上图片仍完整落在框内 ⇒ 限位 0（保持居中）。
 * - 否则允许拖 `(缩放后尺寸 - 框) / 2`，正好能让一条边贴到框边、另一条边不露黑底。
 */
export function panLimit(scale: number, frame: Size, base: Size): Point {
  const axis = (scaled: number, inFrame: number): number => Math.max(0, (scaled - inFrame) / 2);
  return {
    x: axis(base.width * scale, frame.width),
    y: axis(base.height * scale, frame.height),
  };
}

/** 把偏移夹进限位：没超限的**原样返回**（限位不许变成吸附）+ 消掉 `-0`（`Math.max(-0, 负数)` 会得到它） */
function clampAxis(value: number, limit: number): number {
  const clamped = Math.min(limit, Math.max(-limit, value));
  return clamped === 0 ? 0 : clamped;
}

export function clampOffset(offset: Point, scale: number, frame: Size, base: Size): Point {
  const limit = panLimit(scale, frame, base);
  return {
    x: clampAxis(offset.x, limit.x),
    y: clampAxis(offset.y, limit.y),
  };
}
