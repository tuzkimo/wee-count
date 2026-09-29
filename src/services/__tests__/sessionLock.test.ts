// src/services/__tests__/sessionLock.test.ts
//
// 跨进程自动锁窗口的取值层：原生写「上一次会话怎么结束的」，前端读它决定**本次启动要不要上锁**。
//
// 这一层决定的是"要不要把用户挡在门外"，所以每一类异常都必须落在**从严**一侧：
// 读不到、认不出、时钟倒退、窗口不是数字、本段从没解锁过 ⇒ 要求解锁。用例逐条钉住这个方向。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** plugin-fs 在文件不存在时抛出的**真实**形态（Rust `io::Error` 的 Display）。 */
const NOT_FOUND = "No such file or directory (os error 2)";

const fs = vi.hoisted(() => ({
  // 字面量与下面 `NOT_FOUND` 同一份：`vi.hoisted` 的工厂跑在模块初始化之前，不能引用它。
  readTextFile: vi.fn(async (_path: string, _opts?: unknown): Promise<string> => {
    throw new Error("No such file or directory (os error 2)");
  }),
  writeTextFile: vi.fn(
    async (_path: string, _content: string, _opts?: unknown): Promise<void> => undefined,
  ),
  mkdir: vi.fn(async (_path: string, _opts?: unknown): Promise<void> => undefined),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  // AppCache 的真实值是 16（与 useShareIntake.test.ts 同款理由：baseDir 写错时用例必须红）
  BaseDirectory: { AppCache: 16 },
  readTextFile: fs.readTextFile,
  writeTextFile: fs.writeTextFile,
  mkdir: fs.mkdir,
}));

import {
  decideBootLock,
  markSessionAuthenticated,
  parseSessionEnd,
  readSessionEnd,
  readSessionMark,
} from "@/services/sessionLock";
// 环境探测是显式的（"__TAURI_INTERNALS__" in window）：这里注入标记来模拟"在 Tauri 内"，
// 与 lockStorage/privacySettings 的测试同一套路。
import { enterTauri, exitTauri } from "@/services/__tests__/lockStorage.fixtures";

/** 两个文件的路径与基目录：与原生 `MainActivity` 的 `SESSION_DIR` 逐字一致。 */
const RECORD_PATH = "wee-session/session.json";
const MARK_PATH = "wee-session/authenticated";
const APP_CACHE = { baseDir: 16 };

/** 固定"现在"，让窗口判定与用例无关（不依赖真实时间流逝）。 */
const NOW = 1_700_000_000_000;

/**
 * 会话记录原文。`authenticated` 默认给 true（"本段过过门禁"）—— **这是放行的必要条件之一**，
 * 单独用例会把它设成 false 来钉住"停在解锁页也能靠窗口进来"那条漏洞。
 */
function backgroundRaw(at: number, authenticated = true): string {
  return JSON.stringify({ v: 1, at, reason: "background", taskId: 7, authenticated });
}
function userClosedRaw(at: number): string {
  return JSON.stringify({ v: 1, at, reason: "user_closed", taskId: 7, authenticated: false });
}

/** 让 `readTextFile` 按路径分别作答（记录与标记是两个文件）。 */
function stubFiles(files: { record?: string; mark?: string }): void {
  fs.readTextFile.mockImplementation(async (path: string) => {
    if (path === RECORD_PATH && files.record !== undefined) return files.record;
    if (path === MARK_PATH && files.mark !== undefined) return files.mark;
    throw new Error(NOT_FOUND);
  });
}

beforeEach(() => {
  enterTauri();
  fs.readTextFile.mockReset();
  fs.readTextFile.mockImplementation(async () => {
    throw new Error(NOT_FOUND);
  });
  fs.writeTextFile.mockReset();
  fs.writeTextFile.mockResolvedValue(undefined);
  fs.mkdir.mockReset();
  fs.mkdir.mockResolvedValue(undefined);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  exitTauri();
});

describe("parseSessionEnd：形状与版本", () => {
  it("认原生 `writeSessionEnd` 拼出来的**逐字**原文（跨语言契约）", () => {
    // 这两条是从 Kotlin 的字符串模板逐字抄下来的：
    //   """{"v":1,"at":$at,"reason":"$reason","taskId":${currentTaskId()},"authenticated":$authenticated}"""
    // （`currentTaskId()` 取不到时写 -1。）不写成 JSON.stringify(对象) 是有意的：
    // 那样两边字段名一起写错也照样绿。
    expect(
      parseSessionEnd(
        JSON.parse('{"v":1,"at":1759123456789,"reason":"background","taskId":2840,"authenticated":true}'),
      ),
    ).toEqual({ at: 1759123456789, reason: "background", authenticated: true });
    expect(
      parseSessionEnd(
        JSON.parse('{"v":1,"at":1759123456789,"reason":"user_closed","taskId":-1,"authenticated":false}'),
      ),
    ).toEqual({ at: 1759123456789, reason: "user_closed", authenticated: false });
  });

  it("两种 reason 都认，并带上 authenticated", () => {
    expect(parseSessionEnd(JSON.parse(backgroundRaw(NOW)))).toEqual({
      at: NOW,
      reason: "background",
      authenticated: true,
    });
    expect(parseSessionEnd(JSON.parse(backgroundRaw(NOW, false)))).toEqual({
      at: NOW,
      reason: "background",
      authenticated: false,
    });
    expect(parseSessionEnd(JSON.parse(userClosedRaw(NOW)))).toEqual({
      at: NOW,
      reason: "user_closed",
      authenticated: false,
    });
  });

  it("authenticated 缺字段/类型不对 ⇒ false（老版本原生写的记录不能只按窗口放行）", () => {
    const base = { v: 1, at: NOW, reason: "background" };
    expect(parseSessionEnd(base)).toEqual({ at: NOW, reason: "background", authenticated: false });
    expect(parseSessionEnd({ ...base, authenticated: "true" })).toEqual({
      at: NOW,
      reason: "background",
      authenticated: false,
    });
  });

  it("版本不认 / reason 不认识 / at 非有限数 / 不是对象 ⇒ null（调用方按从严处理）", () => {
    expect(parseSessionEnd({ v: 2, at: NOW, reason: "background" })).toBeNull();
    expect(parseSessionEnd({ v: 1, at: NOW, reason: "closed" })).toBeNull();
    expect(parseSessionEnd({ v: 1, at: Number.NaN, reason: "background" })).toBeNull();
    expect(parseSessionEnd({ v: 1, at: "1700000000000", reason: "background" })).toBeNull();
    expect(parseSessionEnd(null)).toBeNull();
    expect(parseSessionEnd([{ v: 1, at: NOW, reason: "background" }])).toBeNull();
  });
});

describe("readSessionEnd", () => {
  it("读到合法记录 ⇒ 返回它（路径 + AppCache 基目录）", async () => {
    stubFiles({ record: userClosedRaw(NOW - 5_000) });

    await expect(readSessionEnd()).resolves.toEqual({
      at: NOW - 5_000,
      reason: "user_closed",
      authenticated: false,
    });
    expect(fs.readTextFile).toHaveBeenCalledWith(RECORD_PATH, APP_CACHE);
  });

  it("文件不存在 ⇒ null，且**不打日志**（首启/从未写过是正常路径）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(readSessionEnd()).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("内容坏 / 形状不认 ⇒ null + warn（异常，但方向仍然从严）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.readTextFile.mockResolvedValue("not json");

    await expect(readSessionEnd()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    fs.readTextFile.mockResolvedValue(JSON.stringify({ v: 1, at: NOW, reason: "whatever" }));
    await expect(readSessionEnd()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("真错误（scope 配错等，不是「不存在」）⇒ null + warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.readTextFile.mockRejectedValue(new Error("forbidden path: not allowed by scope"));

    await expect(readSessionEnd()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("readSessionMark / markSessionAuthenticated", () => {
  it("标记里是时间戳 ⇒ 返回它；不在 ⇒ null 且无日志", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    stubFiles({ mark: String(NOW - 1_000) });
    await expect(readSessionMark()).resolves.toBe(NOW - 1_000);
    expect(fs.readTextFile).toHaveBeenCalledWith(MARK_PATH, APP_CACHE);

    stubFiles({});
    await expect(readSessionMark()).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("标记内容认不出（空/非数字/非正数）⇒ null（宁可当作没有标记）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (const raw of ["", "abc", "0", "-5", "NaN"]) {
      stubFiles({ mark: raw });
      await expect(readSessionMark()).resolves.toBeNull();
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it("读标记出真错误 ⇒ null + warn（从严：宁可要求解锁）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.readTextFile.mockRejectedValue(new Error("forbidden path: not allowed by scope"));

    await expect(readSessionMark()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("记标记：先确保目录存在、再写对路径与基目录；写失败不抛（只 warn）", async () => {
    await expect(markSessionAuthenticated()).resolves.toBeUndefined();
    // 目录必须显式建：plugin-fs 的 writeTextFile 不会创建父目录，而 mkdir 的默认 scope 不含子目录
    expect(fs.mkdir).toHaveBeenCalledWith("wee-session", { baseDir: 16, recursive: true });
    expect(fs.writeTextFile).toHaveBeenCalledWith(MARK_PATH, String(NOW), APP_CACHE);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.writeTextFile.mockRejectedValue(new Error("disk full"));
    await expect(markSessionAuthenticated()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("建目录失败仍继续写：目录可能已经存在（原生建的），只有 mkdir 那一条 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.mkdir.mockRejectedValue(new Error("forbidden path: not allowed by scope"));

    await expect(markSessionAuthenticated()).resolves.toBeUndefined();

    // 建不出来不改"继续尝试写"这个决定
    expect(fs.writeTextFile).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("时间戳取「解锁那一刻」，不是写盘那一刻（mkdir 往返期间切后台不会留下更新的残留标记）", async () => {
    // 现实时序：unlock() → 本函数；`ensureSessionDir()` 是一次 IPC 往返，用户可能就在这个窗口里
    // 按 Home ⇒ 原生 onStop 先写下 background(at = 更早)，此时若等 mkdir 返回再取 Date.now()，
    // 落盘的标记就比记录更晚 ⇒ 下次启动"标记比记录新 ⇒ 不锁"会绕过 autoLock 窗口。
    const now = vi.spyOn(Date, "now").mockReturnValue(NOW); // 调用那一刻
    fs.mkdir.mockImplementation(async () => {
      // 注意用 mockReturnValue 换掉**默认值**而不是 mockReturnValueOnce 排一次：
      // 排一次的话，"把取时间戳挪到 await 之后"也照样能拿到 NOW，用例就变成假绿
      // （这条用例存在的全部意义就是钉住"取在 await 之前"）。
      now.mockReturnValue(NOW + 5_000); // mkdir 往返期间时间前进
    });

    await markSessionAuthenticated();

    expect(fs.writeTextFile).toHaveBeenCalledWith(MARK_PATH, String(NOW), APP_CACHE);
  });
});

describe("decideBootLock：本次启动要不要上锁", () => {
  it("上一段切到后台、本段过过门禁、窗口内、没有残留标记 ⇒ 不上锁，并把本段记成已过门禁", async () => {
    stubFiles({ record: backgroundRaw(NOW - 20_000) });

    await expect(decideBootLock(60)).resolves.toBe(false);
    // 「本段已过门禁」必须落盘：否则紧接着的页面重载（dev HMR / 渲染进程崩溃）会再判一次，
    // 而那时记录已经超出窗口 ⇒ 用户正用着 App 却被要求解锁。
    expect(fs.writeTextFile).toHaveBeenCalledWith(MARK_PATH, String(NOW), APP_CACHE);
  });

  it("本段标记晚于上一次离场 ⇒ 不上锁（前台期内的重载不该再判一次窗口）", async () => {
    // 记录是很久以前那一次离场（早已超窗），标记来自本段解锁 ⇒ 认标记
    stubFiles({ record: backgroundRaw(NOW - 600_000), mark: String(NOW - 1_000) });

    await expect(decideBootLock(60)).resolves.toBe(false);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("标记早于上一次离场 ⇒ 那是上一段残留的标记，不作数（按窗口判）", async () => {
    // unlock() 的异步写可能落在原生删标记之后 ⇒ 残留标记会永久放行，所以必须比时间戳
    stubFiles({ record: backgroundRaw(NOW - 600_000), mark: String(NOW - 700_000) });

    await expect(decideBootLock(60)).resolves.toBe(true);
  });

  it("标记的时间戳落在未来（系统时间被往回调过）⇒ 不采信它，照旧按窗口从严", async () => {
    // 记录落在"未来"时 shouldLockOnBoot 已经从严（elapsed < 0）；标记通道不能反而比它松：
    // 时间戳跑到未来只可能是时钟被回拨，那时"标记比记录新"就不再是"本段已过门禁"的证据。
    stubFiles({ record: backgroundRaw(NOW - 90_000), mark: String(NOW + 60_000) });

    await expect(decideBootLock(60)).resolves.toBe(true);
  });

  it("记录不存在时不采信任何标记（无从判断新旧）⇒ 上锁", async () => {
    stubFiles({ mark: String(NOW) });

    await expect(decideBootLock(60)).resolves.toBe(true);
  });

  it("本段从没解锁过（authenticated=false）⇒ 即使窗口内也上锁（不许靠「停在解锁页」免口令进来）", async () => {
    stubFiles({ record: backgroundRaw(NOW - 5_000, false) });

    await expect(decideBootLock(60)).resolves.toBe(true);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("用户自己关的（user_closed）、本段没有更新的标记 ⇒ 上锁（「划掉后台必须解锁」的硬要求）", async () => {
    stubFiles({ record: userClosedRaw(NOW - 1_000) });

    await expect(decideBootLock(300)).resolves.toBe(true);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("用户自己关的、但**这之后用户真的解锁过**（标记比记录新）⇒ 不上锁", async () => {
    // 组合的现实来源：划掉 → 重开（解锁页）→ 解锁 → 页面重载（dev HMR / 渲染进程崩溃）。
    // 标记是"解锁过"的直接证据，且它比那次关闭新；此时再踢回解锁页就是 Bug ① 的形态回来了。
    // 那次"重开必锁"由 onStop/onDestroy 删掉标记来保证（删除权在原生手里），不靠 reason 压过标记。
    stubFiles({ record: userClosedRaw(NOW - 1_000), mark: String(NOW) });

    await expect(decideBootLock(300)).resolves.toBe(false);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("窗口外的后台返回 ⇒ 上锁", async () => {
    stubFiles({ record: backgroundRaw(NOW - 90_000) });

    await expect(decideBootLock(60)).resolves.toBe(true);
  });

  it("记标记失败不影响本次判定（fire-and-forget：判定不等它，也不因它改判）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    stubFiles({ record: backgroundRaw(NOW - 5_000) });
    fs.writeTextFile.mockRejectedValue(new Error("disk full"));

    await expect(decideBootLock(60)).resolves.toBe(false);
    // 失败只留一条日志（异步落盘，所以等它出现）
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });

  it("没有记录（首启 / 缓存被清）⇒ 上锁", async () => {
    await expect(decideBootLock(300)).resolves.toBe(true);
    expect(fs.writeTextFile).not.toHaveBeenCalled();
  });

  it("读记录出真错误 ⇒ 上锁 + warn（绝不因为读不到就放行）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fs.readTextFile.mockImplementation(async (path: string) => {
      // 记录读不到（scope 配错），标记本来就不在 ⇒ 只有记录那一条该 warn
      if (path === RECORD_PATH) throw new Error("forbidden path: not allowed by scope");
      throw new Error(NOT_FOUND);
    });

    await expect(decideBootLock(300)).resolves.toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("没有 Tauri 运行时（桌面浏览器 / 单测）", () => {
  it("一次也不碰 fs、按从严上锁、且不打日志（与环境配错区分开）", async () => {
    exitTauri();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(decideBootLock(300)).resolves.toBe(true);
    await expect(readSessionEnd()).resolves.toBeNull();
    await expect(readSessionMark()).resolves.toBeNull();
    await expect(markSessionAuthenticated()).resolves.toBeUndefined();

    expect(fs.readTextFile).not.toHaveBeenCalled();
    expect(fs.writeTextFile).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
