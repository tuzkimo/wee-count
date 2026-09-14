import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 环境探测是显式的（"__TAURI_INTERNALS__" in window），因此测试通过注入/移除该标记
// 来切换「是否在 Tauri 内」，并用假 store 替换 plugin-store，不依赖 Tauri 运行时。
const { loadMock, fakeStore } = vi.hoisted(() => ({
  loadMock: vi.fn(async (): Promise<unknown> => {
    throw new Error("load() 未在本用例中配置");
  }),
  fakeStore: {
    get: vi.fn(async (_key: string): Promise<unknown> => null),
    set: vi.fn(async (_key: string, _value: unknown): Promise<void> => undefined),
    save: vi.fn(async (): Promise<void> => undefined),
    delete: vi.fn(async (_key: string): Promise<void> => undefined),
  },
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: loadMock,
}));

import {
  clearAppLock,
  parseAppLock,
  readAppLock,
  writeAppLock,
  type AppLockConfig,
} from "@/services/lockStorage";

// 真实的 60 字符 bcrypt 哈希：$2b$ + cost 两位 + $ + 53 个 base64 字符。
const BCRYPT_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

const valid: AppLockConfig = {
  type: "pin",
  hash: BCRYPT_HASH,
  biometric_enabled: false,
  auto_lock_seconds: 60,
  screenshot_protection: true,
};

const KEY = "app_lock";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function enterTauri(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

function exitTauri(): void {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

describe("lockStorage（浏览器 / 非 Tauri 环境，用 localStorage）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    exitTauri();
  });

  it("未写入时返回 null", async () => {
    expect(await readAppLock()).toBeNull();
  });

  it("写入后可读回，且字段一致", async () => {
    await writeAppLock(valid);
    expect(await readAppLock()).toEqual(valid);
  });

  it("clearAppLock 之后返回 null", async () => {
    await writeAppLock(valid);
    await clearAppLock();
    expect(await readAppLock()).toBeNull();
  });

  it("数据损坏时返回 null（不抛错，视为未配置锁）", async () => {
    localStorage.setItem(KEY, "{ not json");
    expect(await readAppLock()).toBeNull();
  });

  it("parseAppLock 拒绝结构不合法的配置", () => {
    expect(parseAppLock(null)).toBeNull();
    expect(parseAppLock({})).toBeNull();
    expect(parseAppLock({ ...valid, type: "gesture" })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "" })).toBeNull();
    expect(parseAppLock({ ...valid, auto_lock_seconds: "60" })).toBeNull();
    expect(parseAppLock({ ...valid, screenshot_protection: 1 })).toBeNull();
  });

  it("parseAppLock 接受 pattern 类型", () => {
    expect(parseAppLock({ ...valid, type: "pattern" })?.type).toBe("pattern");
  });

  it("parseAppLock 接受合法的 bcrypt 哈希（60 字符）", () => {
    expect(BCRYPT_HASH).toHaveLength(60);
    expect(parseAppLock(valid)).toEqual(valid);
    expect(parseAppLock({ ...valid, type: "pattern" })?.hash).toBe(BCRYPT_HASH);
  });

  it("parseAppLock 拒绝格式非法的 bcrypt 哈希（避免正确口令也永远验不过）", () => {
    // 简报里的旧夹具：只有 29 字符，bcryptjs 对长度 ≠ 60 的哈希只会返回 false 而不抛错。
    expect(parseAppLock({ ...valid, hash: "$2b$10$abcdefghijklmnopqrstuv" })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "$2b$10$" + "a".repeat(52) })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "$2b$10$" + "a".repeat(54) })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "$1a$10$" + "a".repeat(53) })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "$2b$1$" + "a".repeat(53) })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "$2b$10$" + "a".repeat(52) + "!" })).toBeNull();
    expect(parseAppLock({ ...valid, hash: "not-a-hash" })).toBeNull();
  });

  it("writeAppLock 收到非法 config 时抛错，且不落盘", async () => {
    await expect(writeAppLock({ ...valid, hash: "short" })).rejects.toThrow();
    await expect(writeAppLock({ ...valid, auto_lock_seconds: Number.NaN })).rejects.toThrow();
    await expect(
      writeAppLock({ ...valid, type: "gesture" as AppLockConfig["type"] }),
    ).rejects.toThrow();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("lockStorage（在 Tauri 内但 settings.json 加载失败 → error 态）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    enterTauri();
    loadMock.mockImplementation(async () => {
      throw new Error("settings.json 损坏");
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
    exitTauri();
  });

  it("readAppLock 返回 null、不抛错、也不读 localStorage", async () => {
    localStorage.setItem(KEY, JSON.stringify(valid));
    await expect(readAppLock()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("writeAppLock 不写任何地方（尤其是绝不回落到 localStorage）", async () => {
    await expect(writeAppLock(valid)).resolves.toBeUndefined();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(await readAppLock()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("clearAppLock 不删任何地方（否则 settings.json 里的锁会自己回来）", async () => {
    localStorage.setItem(KEY, JSON.stringify(valid));
    await expect(clearAppLock()).resolves.toBeUndefined();
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("error 态不被永久锁存：下次调用会重新 load()", async () => {
    await readAppLock();
    await readAppLock();
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});

describe("lockStorage（在 Tauri 内且 store 可用）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    enterTauri();
    loadMock.mockImplementation(async () => fakeStore);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    exitTauri();
  });

  it("读写走 store，不碰 localStorage", async () => {
    fakeStore.get.mockResolvedValueOnce(valid);
    await expect(readAppLock()).resolves.toEqual(valid);

    await writeAppLock(valid);
    expect(fakeStore.set).toHaveBeenCalledWith(KEY, valid);
    expect(fakeStore.save).toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();

    await clearAppLock();
    expect(fakeStore.delete).toHaveBeenCalledWith(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("store.get 抛错时 readAppLock 不 reject（返回 null）", async () => {
    fakeStore.get.mockRejectedValueOnce(new Error("读取失败"));
    await expect(readAppLock()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store.set 抛错时 writeAppLock 不 reject", async () => {
    fakeStore.set.mockRejectedValueOnce(new Error("写入失败"));
    await expect(writeAppLock(valid)).resolves.toBeUndefined();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store 里数据损坏时 readAppLock 返回 null", async () => {
    fakeStore.get.mockResolvedValueOnce({ type: "pin", hash: "broken" });
    await expect(readAppLock()).resolves.toBeNull();
  });
});
