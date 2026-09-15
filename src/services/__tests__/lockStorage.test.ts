// src/services/__tests__/lockStorage.test.ts
//
// 本文件覆盖「不需要成功的 store」的两态：web（localStorage）与 error（Tauri 内 load 失败），
// 外加与运行环境无关的 parseAppLock 纯函数用例。
//
// 唯一会命中模块级 storePromise 缓存的「Tauri 内且 store 可用」套件被拆到
// lockStorage.tauriStore.test.ts：那里的 load() 成功会把 storePromise 永久缓存下来，
// 之后任何用例都不会再调用 load()，于是「依赖 load() 失败的 error 态用例」能不能过
// 就取决于 describe 的执行顺序（--sequence.shuffle 下必红）。
// Vitest 默认 isolate: true，按文件隔离模块注册表，拆开后任意顺序结果一致。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { loadMock } = vi.hoisted(() => ({
  loadMock: vi.fn(async (): Promise<unknown> => {
    throw new Error("load() 未在本用例中配置");
  }),
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
import { BCRYPT_HASH, KEY, valid, enterTauri, exitTauri } from "./lockStorage.fixtures";

let warnSpy: ReturnType<typeof vi.spyOn>;

interface FakeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

/**
 * 构造一个「某项操作会抛错」的最小 localStorage 替身，用来模拟
 * WebView 存储被禁用（SecurityError）或配额耗尽（QuotaExceededError）。
 * 用 vi.stubGlobal 整体替换而不是 spyOn：happy-dom 的 localStorage 是 Proxy，
 * spyOn 打上去的桩 restoreAllMocks 还原不掉，会污染同文件后续用例。
 */
function brokenStorage(
  throwOn: keyof FakeStorage,
  message: string,
  seed: Record<string, string> = {},
): FakeStorage {
  const data = new Map<string, string>(Object.entries(seed));
  const throwing = (): never => {
    throw new Error(message);
  };
  return {
    getItem: throwOn === "getItem" ? throwing : (key) => data.get(key) ?? null,
    setItem:
      throwOn === "setItem"
        ? throwing
        : (key, value) => {
            data.set(key, value);
          },
    removeItem:
      throwOn === "removeItem"
        ? throwing
        : (key) => {
            data.delete(key);
          },
    clear: () => data.clear(),
  };
}

describe("lockStorage（浏览器 / 非 Tauri 环境，用 localStorage）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
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

  it("localStorage.getItem 抛错（存储被禁用）时返回 null，读路径永不抛", async () => {
    vi.stubGlobal(
      "localStorage",
      brokenStorage("getItem", "SecurityError: 存储被禁用", { [KEY]: JSON.stringify(valid) }),
    );
    await expect(readAppLock()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("localStorage.setItem 抛错（配额耗尽）时 writeAppLock reject，不做假确认", async () => {
    vi.stubGlobal("localStorage", brokenStorage("setItem", "QuotaExceededError"));
    await expect(writeAppLock(valid)).rejects.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("localStorage.removeItem 抛错时 clearAppLock reject，不做假确认", async () => {
    const fake = brokenStorage("removeItem", "SecurityError: 存储被禁用", {
      [KEY]: JSON.stringify(valid),
    });
    vi.stubGlobal("localStorage", fake);
    await expect(clearAppLock()).rejects.toThrow();
    // 删除失败就不能假装已清除，原值必须还在。
    expect(fake.getItem(KEY)).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
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

// error 态不会缓存 storePromise（load() 失败后会置回 null），
// 所以这个套件放在本文件里不会污染其他套件，也不受其他套件影响。
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
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
    exitTauri();
  });

  it("readAppLock 返回 null、不抛错、也不读 localStorage", async () => {
    localStorage.setItem(KEY, JSON.stringify(valid));
    await expect(readAppLock()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("writeAppLock 不写任何地方（尤其是绝不回落到 localStorage），且必须 reject", async () => {
    const existing = JSON.stringify({ ...valid, auto_lock_seconds: 999 });
    localStorage.setItem(KEY, existing);
    await expect(writeAppLock(valid)).rejects.toThrow();
    // 确实走到了 Tauri 分支的 error 态，而不是被当成「非 Tauri 环境」走了 localStorage。
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(KEY)).toBe(existing);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("clearAppLock 不删任何地方（否则 settings.json 里的锁会自己回来），且必须 reject", async () => {
    localStorage.setItem(KEY, JSON.stringify(valid));
    await expect(clearAppLock()).rejects.toThrow();
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(KEY)).not.toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("error 态不被永久锁存：下次调用会重新 load()", async () => {
    await readAppLock();
    await readAppLock();
    expect(loadMock).toHaveBeenCalledTimes(2);
  });
});
