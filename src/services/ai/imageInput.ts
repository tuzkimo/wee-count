// 选图 + 读字节 + 本地压缩（规格 §3 步骤 1–2 / §6 / §8）。**插件的收口处**：全仓只有这个文件
// import `@tauri-apps/plugin-dialog` / `plugin-fs`，canvas 也只在这里出现。
//
// 为什么要有**注入缝**（`PickDeps`）：happy-dom 里三样东西一样都没有 ——
// `createImageBitmap` 是 `undefined`、`canvas.getContext("2d")` 返回 `null`、插件没有 IPC
// （本文件的环境探针实测）。若把转码写死在模块内部，测试只能整体 mock 掉 `pickImage`
// ⇒ 等于**没测**。所以三个 IO 全部从参数进来、默认用真实现（`realDeps`）：
// 测试既能注入假实现覆盖正常路径，也能**不注入**去证明生产默认路径真的接到了 canvas。
//
// ⚠️ **准入判据只有一条：字节头（魔数）**（裁决：扩展名**不设否决权**；errata E8c / E7d）：
//   选择器只按扩展名**过滤候选**（`PICK_EXTENSIONS`，纯粹是 UX），**不参与准入判断**。
//   理由：扩展名两头都不靠谱 —— 往上可被改名伪造（GIF 改名成 `.jpg`），往下会**误拒**
//   （Android 选择器可能返回一个没有扩展名的合法图片）。
//   所以：`readFile` 成功之后、**转码之前**调 `sniffImageMime(bytes)`，`null` 即拒绝；
//   送给转码器的 `sourceMime` 也用**嗅探结果**（比扩展名准）。
//   历史（两条已被删掉的判据，别再写回来）：
//     - `if (!isAcceptedMime("image/jpeg"))` —— 判的是**字面量**、恒假，一条假防线（E7d）；
//     - `if (mimeFromPath(selected) === null) return …` —— 让扩展名成了**第二道否决权**，
//       既与"字节定音"自相矛盾（E8c），又会误拒无扩展名的合法图片。
//
// ⚠️ 返回的 `mime` **固定 `"image/jpeg"`**：canvas 一律导出 JPEG（`toDataURL("image/jpeg", …)`），
// 把源类型传下去会让 `payload.image.mime` 与 `dataUrl` 的真实类型**不一致**（E8c）。
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  JPEG_QUALITY,
  type AcceptedMime,
  dataUrlByteLength,
  isWithinByteLimit,
  scaleToFit,
  sniffImageMime,
} from "./imageScale";

/** 落到 `payload.image` 的形状（规格 §4.1）。`bytes` 是**解码后字节数**，不是字符串长度。 */
export interface ImageAttachment {
  mime: AcceptedMime;
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * `null` = 用户取消（不是错误，页面什么都不做）；`{ok:false}` = 拒绝，附**规格 §8 的逐字文案**。
 * 本函数**不抛**：调用方（页面）只需展示 `message`。
 */
export type PickResult = { ok: true; image: ImageAttachment } | { ok: false; message: string } | null;

/**
 * 规格 §8 的用户可见文案。**逐字**照抄，且全文件只此一份（本仓 `toolNames.ts`
 * 记过"同一句话抄两份 ⇒ 两份手写真相迟早漂移"的血泪）。
 */
const MSG_UNSUPPORTED = "只支持 JPEG / PNG / WebP 图片";
const MSG_READ_FAILED = "读不到这张图片，请重试";
const MSG_DECODE_FAILED = "这张图片打不开";
const MSG_TOO_LARGE = "图片太大，换一张或先裁剪";

/** 选择器里列的扩展名（**只是 UX 过滤**：连它自己都不参与准入判断，见文件头） */
const PICK_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

/** 转码结果：压缩后的 data URL 与它的像素尺寸 */
interface JpegResult {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * 注入缝：三个 IO 全部可换。默认值见 `realDeps`（真插件 + 真 canvas）。
 * `toJpegDataUrl` 收 `sourceMime` 是为了让 `Blob` 的类型正确 —— 它由**字节头**决定。
 */
export interface PickDeps {
  open: typeof open;
  readFile: typeof readFile;
  toJpegDataUrl: (bytes: Uint8Array, sourceMime: AcceptedMime) => Promise<JpegResult>;
}

/**
 * 把原始字节按 `scaleToFit` 的结果画进 canvas，再导成 JPEG data URL。
 * ⚠️ 不给 `scaleToFit` 传第二个参数：`maxEdge` 一旦从调用点传进来，规格 §1 的 1280px 就
 * 绕过了 `imageScale.ts` 里那条被钉子钉住的常量。
 */
async function toJpegDataUrl(bytes: Uint8Array, sourceMime: AcceptedMime): Promise<JpegResult> {
  const blob = new Blob([bytes], { type: sourceMime });
  const bitmap = await createImageBitmap(blob);
  const target = scaleToFit({ width: bitmap.width, height: bitmap.height });
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no-2d-context");
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close?.();
  return { dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY), width: target.width, height: target.height };
}

/**
 * 生产默认依赖：真插件 + 真 canvas。
 * 测试的 B 组**故意不注入**这一份，用来证明默认路径确实走到了 canvas（换掉它那条必须红）。
 */
const realDeps: PickDeps = { open, readFile, toJpegDataUrl };

/**
 * 选一张图并压缩成 JPEG data URL（规格 §3 步骤 1–3）。
 *
 * 步骤与失败文案（§8）一一对应：取消 ⇒ `null`；魔数认不出 ⇒ 只支持…；读失败 ⇒ 读不到…
 * 解不开 / 编码结果为空 ⇒ 打不开；压缩后仍超 1 MiB ⇒ 图片太大…
 */
export async function pickImage(deps: PickDeps = realDeps): Promise<PickResult> {
  const selected = await deps.open({
    multiple: false,
    directory: false,
    filters: [{ name: "图片", extensions: PICK_EXTENSIONS }],
  });
  if (selected === null) return null;

  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(selected);
  } catch {
    return { ok: false, message: MSG_READ_FAILED };
  }

  // 定音：**魔数**在转码之前拦下伪装（GIF 改名成 .jpg、%PDF-、截断/空字节都走这里）
  const sniffed = sniffImageMime(bytes);
  if (sniffed === null) return { ok: false, message: MSG_UNSUPPORTED };

  let made: JpegResult;
  try {
    made = await deps.toJpegDataUrl(bytes, sniffed);
  } catch {
    return { ok: false, message: MSG_DECODE_FAILED };
  }

  const size = dataUrlByteLength(made.dataUrl);
  // 编码结果为空 = **根本没生成出图片** ⇒ 归"打不开"，**不能**归"图片太大"：
  // 后者会让用户去裁更小的图、然后继续失败（§8 的文案表一个字都不改，改的是落到哪条分支）
  if (size === 0) return { ok: false, message: MSG_DECODE_FAILED };
  if (!isWithinByteLimit(size)) return { ok: false, message: MSG_TOO_LARGE };

  return {
    ok: true,
    // mime 固定 image/jpeg：canvas 导出的就是 JPEG（E8c）
    image: { mime: "image/jpeg", dataUrl: made.dataUrl, width: made.width, height: made.height, bytes: size },
  };
}
