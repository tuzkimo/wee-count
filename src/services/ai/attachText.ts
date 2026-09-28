// src/services/ai/attachText.ts
// 附件链路的**用户可见文案唯一真相**（M4 §8 四条 + 分享入口 §8 两条）。
//
// 为什么独立成模块（而不是从 `imageInput.ts` 导出）：`imageInput.ts:25-26` 顶部 import 了
// `@tauri-apps/plugin-dialog` 与 `plugin-fs`。分享链只需要**一句话**，不该为它把
// `plugin-dialog` 拉进自己的模块图。
//
// ⚠️ 原生侧**不写中文**：Kotlin 只出 `pending.json` 里的 `code`，映射在这张表里做。

/** 字节头认不出（含 GIF、HEIC、改名伪装、非图片）—— M4 §8 */
export const MSG_UNSUPPORTED = "只支持 JPEG / PNG / WebP 图片";
/** 读文件失败（权限 / 损坏）—— M4 §8 */
export const MSG_READ_FAILED = "读不到这张图片，请重试";
/** 解码或尺寸读取失败，以及"编码结果为空或非法"—— M4 §8 */
export const MSG_DECODE_FAILED = "这张图片打不开";
/** 压缩后仍超 1 MiB —— M4 §8 */
export const MSG_TOO_LARGE = "图片太大，换一张或先裁剪";
/** 分享的 intent 里没有 `EXTRA_STREAM` —— 本设计 §8 */
export const MSG_NO_STREAM = "这条分享里没有图片";
/** 分享带了多张图，只取了第一张 —— 本设计 §8 */
export const MSG_MULTIPLE_TAKEN = "一次只能记一张，已用第一张";

/** 原生侧能报的三个错误 code（本设计 §4.2） */
export type ShareErrorCode = "no_stream" | "read_failed" | "source_too_large";

/** `code → 文案`。**唯一的**原生错误 → 中文的落点。 */
export function messageForShareCode(code: ShareErrorCode): string {
  switch (code) {
    case "no_stream":
      return MSG_NO_STREAM;
    case "read_failed":
      return MSG_READ_FAILED;
    case "source_too_large":
      return MSG_TOO_LARGE;
  }
}
