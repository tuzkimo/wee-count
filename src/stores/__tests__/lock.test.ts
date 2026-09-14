// src/stores/__tests__/lock.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

// 账户密码降级路径需要真实的 auth store；这里只验证它被调用且结果被采信。
const localLoginMock = vi.fn(async () => true);
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ localLogin: localLoginMock }),
}));

import { MAX_UNLOCK_ATTEMPTS, useLockStore } from "@/stores/lock";
import { usePrefsStore } from "@/stores/prefs";
import { hashPassword } from "@/utils/passwordHash";

async function configuredLock(type: "pin" | "pattern" = "pin") {
  const lock = useLockStore();
  await lock.setLock(type, type === "pin" ? "194726" : [1, 2, 3, 5]);
  return lock;
}

describe("lock store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    localLoginMock.mockClear();
  });

  it("初始为未配置、未锁定", () => {
    const lock = useLockStore();
    expect(lock.isLockConfigured).toBe(false);
    expect(lock.isLocked).toBe(false);
  });

  it("setLock 后进入已配置态并落盘", async () => {
    const lock = await configuredLock();
    expect(lock.isLockConfigured).toBe(true);
    expect(lock.lockType).toBe("pin");

    const fresh = useLockStore();
    await fresh.load();
    expect(fresh.isLockConfigured).toBe(true);
    expect(await fresh.verifyPin("194726")).toBe(true);
  });

  it("setLock 拒绝弱口令", async () => {
    const lock = useLockStore();
    await expect(lock.setLock("pin", "111111")).rejects.toThrow();
    await expect(lock.setLock("pin", "123456")).rejects.toThrow();
    await expect(lock.setLock("pin", "12345")).rejects.toThrow();
    expect(lock.isLockConfigured).toBe(false);
  });

  it("setLock 拒绝点数不足的图案", async () => {
    const lock = useLockStore();
    await expect(lock.setLock("pattern", [1, 2, 3])).rejects.toThrow();
    expect(lock.isLockConfigured).toBe(false);
  });

  it("lock 与 unlock 切换锁定状态", async () => {
    const lock = await configuredLock();
    lock.lock();
    expect(lock.isLocked).toBe(true);
    lock.unlock();
    expect(lock.isLocked).toBe(false);
  });

  it("lock() 同时把金额遮蔽重置为隐藏", async () => {
    const lock = await configuredLock();
    const prefs = usePrefsStore();
    prefs.showAmounts();
    expect(prefs.amountsHidden).toBe(false);
    lock.lock();
    // lock() 内部对 prefs 用的是动态 import（避免 lock ↔ prefs 循环依赖），故需等待微任务
    await vi.waitFor(() => expect(prefs.amountsHidden).toBe(true));
  });

  it("图案锁按规范化编码校验", async () => {
    const lock = await configuredLock("pattern");
    expect(await lock.verifyPattern([1, 2, 3, 5])).toBe(true);
    expect(await lock.verifyPattern([1, 2, 3, 4])).toBe(false);
  });

  it("连错达到阈值后要求账户密码", async () => {
    const lock = await configuredLock();
    for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i++) {
      expect(await lock.verifyPin("000001")).toBe(false);
    }
    expect(lock.requireAccountPassword).toBe(true);
  });

  it("降级后即使用正确 PIN 也不再放行", async () => {
    const lock = await configuredLock();
    for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i++) await lock.verifyPin("000001");
    expect(await lock.verifyPin("194726")).toBe(false);
  });

  it("账户密码成功后可重设锁并清零计数", async () => {
    const lock = await configuredLock();
    for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i++) await lock.verifyPin("000001");

    const ok = await lock.unlockWithAccountPassword("tuzki", "account-pw");
    expect(ok).toBe(true);
    expect(localLoginMock).toHaveBeenCalledWith("tuzki", "account-pw");
    expect(lock.requireAccountPassword).toBe(false);
    expect(lock.failedAttempts).toBe(0);

    await lock.setLock("pin", "502814");
    expect(await lock.verifyPin("502814")).toBe(true);
  });

  it("账户密码失败保持降级态并累加计数", async () => {
    localLoginMock.mockResolvedValueOnce(false);
    const lock = await configuredLock();
    for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i++) await lock.verifyPin("000001");
    expect(await lock.unlockWithAccountPassword("tuzki", "wrong")).toBe(false);
    expect(lock.requireAccountPassword).toBe(true);
  });

  it("clearLock 恢复未配置态并解除锁定", async () => {
    const lock = await configuredLock();
    lock.lock();
    await lock.clearLock();
    expect(lock.isLockConfigured).toBe(false);
    expect(lock.isLocked).toBe(false);
  });

  it("load 读取持久化配置与默认值", async () => {
    const lock = useLockStore();
    const hash = await hashPassword("194726");
    localStorage.setItem(
      "app_lock",
      JSON.stringify({
        type: "pin",
        hash,
        biometric_enabled: false,
        auto_lock_seconds: 300,
        screenshot_protection: false,
      }),
    );
    await lock.load();
    expect(lock.isLockConfigured).toBe(true);
    expect(lock.autoLockSeconds).toBe(300);
    expect(lock.screenshotProtection).toBe(false);
  });

  it("load 遇到损坏配置时视为未配置锁", async () => {
    localStorage.setItem("app_lock", "garbage");
    const lock = useLockStore();
    await lock.load();
    expect(lock.isLockConfigured).toBe(false);
  });
});
