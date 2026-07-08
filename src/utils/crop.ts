export interface CropInput {
  imgW: number; // 图片 natural width
  imgH: number; // 图片 natural height
  viewport: number; // 视窗边长 V
  userScale: number; // 用户缩放因子 [1,3]
  x: number; // 图片左上角在视窗坐标系中的位置
  y: number;
}

export interface CropOutput {
  sx: number; // 源采样起点 x
  sy: number; // 源采样起点 y
  sSize: number; // 源采样边长
}

/**
 * 由视窗几何反推源图采样参数。
 * total = baseScale * userScale；baseScale = max(V/imgW, V/imgH) 保证 cover。
 * 视窗点 (0,0) 对应图片显示点 (-x,-y)，对应源点 (-x/total, -y/total)。
 * 视窗边长 V 在源空间即 V/total。
 */
export function computeCrop(input: CropInput): CropOutput {
  const baseScale = Math.max(input.viewport / input.imgW, input.viewport / input.imgH);
  const total = baseScale * input.userScale;
  return {
    // -0 归一化为 +0：Object.is(-0,0) 为 false，否则 toBe(0) 失败
    sx: (-input.x / total) + 0,
    sy: (-input.y / total) + 0,
    sSize: input.viewport / total,
  };
}
