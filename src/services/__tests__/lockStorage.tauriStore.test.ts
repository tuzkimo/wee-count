// src/services/__tests__/lockStorage.tauriStore.test.ts
//
// 本文件只覆盖「在 Tauri 内且 store 可用」这一种环境态。
//
// 为什么单独一个文件：load() 成功后会被缓存成模块级单例 storePromise，且**只缓存成功结果**。
// 一旦这个套件在本文件内先跑，之后所有用例的 resolveStore() 都会直接拿到缓存、
// 再也不调用 load()，于是「依赖 load() 失败的 error 态用例」会按错误的理由变红
// （--sequence.shuffle --sequence.seed=3 下可复现 4 条失败）。
// Vitest 默认 isolate: true，按文件隔离模块注册表，拆开后任意顺序结果一致。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
  readAppLock,
  writeAppLock,
} from "@/services/lockStorage";
import { KEY, valid, enterTauri, exitTauri } from "./lockStorage.fixtures";

let warnSpy: ReturnType<typeof vi.spyOn>;

describe("lockStorage（在 Tauri 内且 store 可用）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    enterTauri();
    loadMock.mockImplementation(async () => fakeStore);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    warnSpy.mockRestore();
    exitTauri();
  });

  it("读写走 store，不碰 localStorage", async () => {
    fakeStore.get.mockResolvedValueOnce(valid);
    await expect(readAppLock()).resolves.toEqual(valid);
    expect(fakeStore.get).toHaveBeenCalledWith(KEY);

    await writeAppLock(valid);
    expect(fakeStore.set).toHaveBeenCalledWith(KEY, valid);
    expect(fakeStore.save).toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();

    await clearAppLock();
    expect(fakeStore.delete).toHaveBeenCalledWith(KEY);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("store.get 抛错时 readAppLock 返回 null（不 reject），且确实走到了 store", async () => {
    fakeStore.get.mockRejectedValueOnce(new Error("读取失败"));
    await expect(readAppLock()).resolves.toBeNull();
    // 路径断言：必须真的调用过 store.get。没有这一行，「压根没走 store 就返回 null」也能通过。
    expect(fakeStore.get).toHaveBeenCalledWith(KEY);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store.set 抛错时 writeAppLock reject，且确实走到了 store", async () => {
    fakeStore.set.mockRejectedValueOnce(new Error("写入失败"));
    await expect(writeAppLock(valid)).rejects.toThrow();
    expect(fakeStore.set).toHaveBeenCalledWith(KEY, valid);
    expect(fakeStore.save).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store.save 抛错时 writeAppLock reject（set 成功不等于已落盘）", async () => {
    fakeStore.save.mockRejectedValueOnce(new Error("落盘失败"));
    await expect(writeAppLock(valid)).rejects.toThrow();
    expect(fakeStore.set).toHaveBeenCalledWith(KEY, valid);
    expect(fakeStore.save).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store.delete 抛错时 clearAppLock reject，且确实走到了 store", async () => {
    fakeStore.delete.mockRejectedValueOnce(new Error("删除失败"));
    await expect(clearAppLock()).rejects.toThrow();
    expect(fakeStore.delete).toHaveBeenCalledWith(KEY);
    expect(fakeStore.save).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store.save 抛错时 clearAppLock reject（delete 成功不等于已落盘）", async () => {
    fakeStore.save.mockRejectedValueOnce(new Error("落盘失败"));
    await expect(clearAppLock()).rejects.toThrow();
    expect(fakeStore.delete).toHaveBeenCalledWith(KEY);
    expect(fakeStore.save).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("store 里数据损坏时 readAppLock 返回 null，且确实走到了 store", async () => {
    fakeStore.get.mockResolvedValueOnce({ type: "pin", hash: "broken" });
    await expect(readAppLock()).resolves.toBeNull();
    expect(fakeStore.get).toHaveBeenCalledWith(KEY);
  });
});
