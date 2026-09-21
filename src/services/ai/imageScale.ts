// 图片准入与缩放规则（M4 规格 §1）。**全部是纯函数**：不碰 DOM、不碰 Tauri 插件。
//
// 为什么单独一个文件：canvas 与 Tauri 插件在 happy-dom 里都用不了（没有真 canvas、没有 IPC），
// 所以一切**可判定的规则**必须留在这里才测得了 —— canvas（任务 3 的 `imageInput.ts`）只是执行者。
//
// ⚠️ 边界语义（三处都靠 `<=`，写成 `<` 只在边界上表现，正是最容易漏的错）：
//   - `scaleToFit`：长边**恰好等于**上限 ⇒ 不缩放（否则白白重编码一次、掉一次画质）
//   - `isWithinByteLimit`：**恰好等于** 1 MiB ⇒ 通过（规格 §1 是"超 1MiB 则拒绝"）
//   - `dataUrlByteLength`：base64 的 padding 不计入真实字节数（否则 §4.1 的 bytes 与闸门一起偏大）

/** 图片最长边上限（像素）。规格 §1：本地压缩到 1280px 以内 */
export const MAX_EDGE = 1280;

/** 重编码 JPEG 的质量（规格 §1）。0.72 是起点值，真机实测小字认不出时可只调这个常量 */
export const JPEG_QUALITY = 0.72;

/** 单图压缩后的字节上限（规格 §1：超 1 MiB 则拒绝）。是**解码后的字节数**，不是 data URL 字符数 */
export const MAX_BYTES = 1024 * 1024;

/** 只接受静态位图（规格 §1：不做 GIF/HEIC/视频/PDF） */
export const ACCEPTED_MIME = ["image/jpeg", "image/png", "image/webp"] as const;

/** 白名单里的 MIME。`isAcceptedMime` 用它做收窄，调用方拿到的是这个类型而不是裸 `string` */
export type AcceptedMime = (typeof ACCEPTED_MIME)[number];

export interface ImageSize {
  width: number;
  height: number;
}

export interface ScaledSize extends ImageSize {
  /** true 表示发生了重编码缩放（false 时返回的就是原尺寸） */
  scaled: boolean;
}

/**
 * 按长边等比缩到 `maxEdge` 以内；**永不返回 0 边**。
 *
 * 极端长宽比（如 20000×3）下较短边的 `Math.round` 会得到 0，而 0 边画进 canvas 会直接抛
 * `IndexSizeError` ⇒ 用 `Math.max(1, …)` 兜底；1px 的短边在视觉上等价于"一条线"，
 * 比"整张图打不开"好。
 */
export function scaleToFit(size: ImageSize, maxEdge: number = MAX_EDGE): ScaledSize {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge) return { width: size.width, height: size.height, scaled: false };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(size.width * ratio)),
    height: Math.max(1, Math.round(size.height * ratio)),
    scaled: true,
  };
}

/** MIME 白名单判定（大小写敏感的精确匹配：`image/jpg` 这类野写法不算通过） */
export function isAcceptedMime(mime: string): mime is AcceptedMime {
  return (ACCEPTED_MIME as readonly string[]).includes(mime);
}

/** bytes 是**解码后的字节数**，不是 data URL 字符串长度。0 字节不是合法图片 */
export function isWithinByteLimit(bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_BYTES;
}

/**
 * data URL 的 base64 段 → 解码字节数（供 `imageInput` 算 §4.1 的 `bytes`，也在这里测）。
 *
 * base64 每 4 字符编码 3 字节，末尾 `==`/`=` 是补齐（不携带数据）⇒ 必须扣除，
 * 否则算出来的字节数偏大，1 MiB 闸门会跟着偏松。
 */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const b64 = dataUrl.slice(comma + 1);
  if (b64.length === 0) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}
