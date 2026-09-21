// `imageInput` 的准入编排（规格 §3 步骤 1–3 / §8 文案 / §9 第 7、8 条）。
//
// ⚠️ 本文件有两组**用途不同**的用例，别把它们当成重复：
//   A 组：**注入**假转码器 ⇒ 覆盖编排（文案、定序、字段形状）。可控、可数。
//   B 组：**不注入**（`pickImage()` 无参）⇒ 证明**生产默认路径真的接到了 canvas**。
//         happy-dom 里 `createImageBitmap` 是 `undefined`、`canvas.getContext("2d")` 返回 `null`
//         （本任务开始前用环境探针实测过），所以 B 组要么落到"这张图片打不开"，
//         要么用 DOM 探针把 canvas 两个方法换掉、让**真实**转码链跑通。
//         ⇒ 若有人把 `realDeps.toJpegDataUrl` 换成假实现，B 组必红（A 组看不出来）。
//
// mock 只许 mock **第三方模块**（这也是 imageInput.ts 收口插件的原因）；
// 自己写的纯函数（imageScale）一律用真的 —— 把被测逻辑的同族模块 mock 掉等于同义反复。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { JPEG_QUALITY, MAX_BYTES, dataUrlByteLength } from "../imageScale";
import { type PickDeps, pickImage } from "../imageInput";

const MSG_UNSUPPORTED = "只支持 JPEG / PNG / WebP 图片";
const MSG_READ_FAILED = "读不到这张图片，请重试";
const MSG_DECODE_FAILED = "这张图片打不开";
const MSG_TOO_LARGE = "图片太大，换一张或先裁剪";

/** 用真 base64 编码器造出**解码后恰好 n 字节**的 data URL（用例里再自证一次长度）。 */
function dataUrlOfBytes(n: number): string {
  return `data:image/jpeg;base64,${Buffer.alloc(n, 0x41).toString("base64")}`;
}

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const GIF_BYTES = new TextEncoder().encode("GIF89a......");
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4");

interface JpegShot {
  dataUrl: string;
  width: number;
  height: number;
}

/** A 组的缝：转码器换成假实现，并把它的调用参数留下来（钉"定音"与"定序"）。 */
function injected(shot: JpegShot = { dataUrl: dataUrlOfBytes(3000), width: 1280, height: 960 }) {
  const toJpegDataUrl = vi.fn(async (_bytes: Uint8Array, _sourceMime: string): Promise<JpegShot> => shot);
  const deps: PickDeps = { open, readFile, toJpegDataUrl };
  return { deps, toJpegDataUrl };
}

describe("pickImage：读文件之前（只跟选择器打交道）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("用户取消选择 ⇒ 返回 null（不是错误，页面什么都不做）", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await expect(pickImage(injected().deps)).resolves.toBeNull();
  });

  it("选择器只要**一张**图（multiple / directory 都为 false，规格 §1「选 1 张」）", async () => {
    vi.mocked(open).mockResolvedValue(null);
    await pickImage(injected().deps);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ multiple: false, directory: false }));
  });

  // 🔴 裁决：扩展名**不设否决权**（选择器已按扩展名过滤候选，再否决只会误拒 ——
  // 比如 Android 选择器返回一个**没有扩展名**的合法图片）。准入判据只有字节头。
  // 若要它红，需要把 `sniffImageMime(bytes)` 重新套上扩展名白名单（= 把删掉的第二道否决权装回来）。
  it("扩展名不设否决权：`.pdf` 扩展名 + 合法 JPEG 字节 ⇒ **不拒**，照样进转码", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/a.pdf");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    const { deps, toJpegDataUrl } = injected();
    await expect(pickImage(deps)).resolves.toMatchObject({ ok: true });
    expect(toJpegDataUrl).toHaveBeenCalledTimes(1);
  });

  it("无扩展名的合法图片（Android 选择器可能这样返回）⇒ 不拒", async () => {
    vi.mocked(open).mockResolvedValue("content://media/external/images/1000042");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    const { deps, toJpegDataUrl } = injected();
    await expect(pickImage(deps)).resolves.toMatchObject({ ok: true });
    expect(toJpegDataUrl).toHaveBeenCalledTimes(1);
  });

  it("读文件失败（权限 / 损坏）⇒ 「读不到这张图片，请重试」", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/a.jpg");
    vi.mocked(readFile).mockRejectedValue(new Error("EACCES"));
    await expect(pickImage(injected().deps)).resolves.toEqual({ ok: false, message: MSG_READ_FAILED });
  });
});

describe("pickImage：字节头定音（魔数才是准入判据，errata E7d）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(open).mockResolvedValue("C:/tmp/fake.jpg");
  });

  // 🔴 本用例是 E7d 的落点：扩展名不再参与判断（连 `.jpg` 也不代表什么），只有字节头能定音。
  // 若要它红，需要让 `sniffImageMime(bytes)` 恒过（或让判据重新看扩展名）。
  it("改名伪装：GIF 字节 + .jpg 扩展名 ⇒ 拒绝（否则动图会被解出第一帧）", async () => {
    vi.mocked(readFile).mockResolvedValue(GIF_BYTES);
    const { deps, toJpegDataUrl } = injected();
    await expect(pickImage(deps)).resolves.toEqual({ ok: false, message: MSG_UNSUPPORTED });
    // 定序（E7d 第 3 条）：拒绝必须发生在**转码之前**
    expect(toJpegDataUrl).not.toHaveBeenCalled();
  });

  it("其它非静态位图形态（%PDF- / 截断的 JPEG / 空字节）⇒ 一律拒绝", async () => {
    const cases: Array<[string, Uint8Array]> = [
      ["%PDF-", PDF_BYTES],
      ["截断的 JPEG（只有 FF D8）", new Uint8Array([0xff, 0xd8])],
      ["空字节", new Uint8Array(0)],
    ];
    for (const [label, bytes] of cases) {
      vi.mocked(readFile).mockResolvedValue(bytes);
      await expect(pickImage(injected().deps), label).resolves.toEqual({ ok: false, message: MSG_UNSUPPORTED });
    }
  });

  // E8c：两条判据矛盾时**以字节头为准** —— 送给转码器的 sourceMime 必须是嗅探结果。
  // 若要它红，需要让 `toJpegDataUrl` 收到扩展名推出的 MIME。
  it("字节头优先于扩展名：.png 扩展名 + JPEG 字节 ⇒ 送给转码器的是 image/jpeg", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/mismatch.png");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    const { deps, toJpegDataUrl } = injected();
    await pickImage(deps);
    expect(toJpegDataUrl).toHaveBeenCalledTimes(1);
    expect(toJpegDataUrl.mock.calls[0]?.[1]).toBe("image/jpeg");
  });

  it("PNG 字节 + .png 扩展名 ⇒ 一致时不得误拒（PNG 是白名单里的静态位图）", async () => {
    vi.mocked(open).mockResolvedValue("C:/tmp/a.png");
    vi.mocked(readFile).mockResolvedValue(PNG_BYTES);
    const { deps, toJpegDataUrl } = injected();
    await expect(pickImage(deps)).resolves.toMatchObject({ ok: true });
    expect(toJpegDataUrl.mock.calls[0]?.[1]).toBe("image/png");
  });
});

describe("pickImage：压缩后的体积闸门与返回形状（规格 §4.1 / §8）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
  });

  it("通过时字段照 §4.1：mime 固定 image/jpeg、bytes 是**解码后**字节数", async () => {
    const url = dataUrlOfBytes(3000);
    expect(dataUrlByteLength(url)).toBe(3000); // fixture 先自证长度
    await expect(pickImage(injected({ dataUrl: url, width: 1280, height: 960 }).deps)).resolves.toEqual({
      ok: true,
      image: { mime: "image/jpeg", dataUrl: url, width: 1280, height: 960, bytes: 3000 },
    });
  });

  it("压缩后**恰好** 1 MiB ⇒ 通过（规格 §1 是「超 1MiB 才拒」，边界不许误伤）", async () => {
    const url = dataUrlOfBytes(MAX_BYTES);
    expect(dataUrlByteLength(url)).toBe(MAX_BYTES); // 边界 fixture 自证
    await expect(pickImage(injected({ dataUrl: url, width: 1280, height: 960 }).deps)).resolves.toMatchObject({
      ok: true,
      image: { bytes: MAX_BYTES },
    });
  });

  // 若要它红，需要让 `!isWithinByteLimit(size)` 那条分支不返回 §8 的这句文案。
  it("压缩后超 1 MiB ⇒ 「图片太大，换一张或先裁剪」", async () => {
    const url = dataUrlOfBytes(MAX_BYTES + 1);
    expect(dataUrlByteLength(url)).toBe(MAX_BYTES + 1); // 边界 fixture 自证
    await expect(pickImage(injected({ dataUrl: url, width: 1280, height: 960 }).deps)).resolves.toEqual({
      ok: false,
      message: MSG_TOO_LARGE,
    });
  });

  // 🔴 裁决 B：编码结果为空 ⇒ **「这张图片打不开」**，不许报成「图片太大」
  // （后者会让用户去裁更小的图、然后继续失败 —— 文案诚实性）。
  // 若要它红，需要删掉 `if (size === 0)` 这条守卫：空结果会掉进"图片太大"分支。
  it("编码结果为空（空串 / 只有前缀）⇒ 「这张图片打不开」", async () => {
    for (const dataUrl of ["", "data:image/jpeg;base64,"]) {
      await expect(pickImage(injected({ dataUrl, width: 1280, height: 960 }).deps), JSON.stringify(dataUrl)).resolves.toEqual({
        ok: false,
        message: MSG_DECODE_FAILED,
      });
    }
  });

  it("转码失败（解不开 / 没有 2d 上下文）⇒ 「这张图片打不开」", async () => {
    const toJpegDataUrl = vi.fn(async () => {
      throw new Error("no-2d-context");
    });
    await expect(pickImage({ open, readFile, toJpegDataUrl })).resolves.toEqual({
      ok: false,
      message: MSG_DECODE_FAILED,
    });
  });
});

describe("pickImage：**生产默认路径**真的接到了 canvas（B 组，不注入 deps）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // 环境事实（本任务开始前探针实测）：happy-dom 里 `canvas.getContext("2d")` 返回 null
  // ⇒ 真实转码链走到 canvas 就抛 ⇒ §8 的"解码失败"文案。
  // 若要它红，需要让 `realDeps.toJpegDataUrl` 变成任何能返回成功结果的假实现。
  it("无参 pickImage() 走到**真实** canvas：没有 2d 上下文 ⇒ 「这张图片打不开」", async () => {
    const createImageBitmapMock = vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() }));
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);

    await expect(pickImage()).resolves.toEqual({ ok: false, message: MSG_DECODE_FAILED });
    // 走到位图这一步本身就是证据：默认实现不是某个"直接返回"的假壳
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
  });

  it("把 canvas 两个 DOM 方法换成探针 ⇒ **真实**转码链跑通（缩到 1280×960、JPEG 质量取常量）", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
    );
    const drawImage = vi.fn();
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const url = dataUrlOfBytes(3000);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(url);

    await expect(pickImage()).resolves.toEqual({
      ok: true,
      image: { mime: "image/jpeg", dataUrl: url, width: 1280, height: 960, bytes: 3000 },
    });

    // 目标尺寸来自 `scaleToFit`（4000×3000 ⇒ 长边 1280）⇒ 没有从调用点传第二个 maxEdge
    const canvas = getContext.mock.contexts[0] as HTMLCanvasElement;
    expect([canvas.width, canvas.height]).toEqual([1280, 960]);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 960);
    // 质量来自 JPEG_QUALITY 常量（写符号，不写 0.72：那是真机可调的旋钮）
    expect(toDataURL).toHaveBeenCalledWith("image/jpeg", JPEG_QUALITY);
  });
});
