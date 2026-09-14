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
    // lock() 静态 import prefs（两者无循环依赖），遮蔽同步生效，无需等微任务
    expect(prefs.amountsHidden).toBe(true);
  });

  it("lock() 在未配置锁时是空操作", () => {
    const lock = useLockStore();
    const prefs = usePrefsStore();
    prefs.showAmounts();
    expect(lock.isLockConfigured).toBe(false);

    lock.lock();

    // 不自设 isLocked，否则未配置锁的用户会被自己的「锁」挡在门外
    expect(lock.isLocked).toBe(false);
    // 空操作要空得干净：也不该顺带改动金额遮蔽
    expect(prefs.amountsHidden).toBe(false);
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

  it("updateSettings 改非口令设置并落盘，不影响口令", async () => {
    const lock = await configuredLock();
    await lock.updateSettings({ auto_lock_seconds: 300, screenshot_protection: false });
    expect(lock.autoLockSeconds).toBe(300);
    expect(lock.screenshotProtection).toBe(false);

    const fresh = useLockStore();
    await fresh.load();
    expect(fresh.autoLockSeconds).toBe(300);
    expect(fresh.screenshotProtection).toBe(false);
    // 改设置不换口令、不换锁型
    expect(fresh.lockType).toBe("pin");
    expect(await fresh.verifyPin("194726")).toBe(true);
  });

  it("updateSettings 未配置锁时是空操作，且忽略 biometric_enabled", async () => {
    const lock = useLockStore();
    await lock.updateSettings({ auto_lock_seconds: 300, screenshot_protection: false });
    // 未配置锁时既不落盘也不改内存态
    expect(localStorage.getItem("app_lock")).toBeNull();
    expect(lock.autoLockSeconds).toBe(60);

    await configuredLock();
    await lock.updateSettings({ biometric_enabled: true });
    // 生物识别本轮不做：patch 里的 biometric_enabled 必须被忽略，且不落盘
    expect(lock.biometricEnabled).toBe(false);
    const stored = JSON.parse(localStorage.getItem("app_lock") ?? "{}") as Record<string, unknown>;
    expect(stored.biometric_enabled).toBe(false);
  });

  it("clearLock 后重设锁回落默认设置，而非沿用上一会话的旧值", async () => {
    const lock = useLockStore();
    // 未配置态即默认值态：先记下出厂默认，作为回落目标
    const defaults = {
      type: lock.lockType,
      autoLockSeconds: lock.autoLockSeconds,
      screenshotProtection: lock.screenshotProtection,
    };
    expect(defaults).toEqual({ type: "pin", autoLockSeconds: 60, screenshotProtection: true });

    // 复现路径：在设置里关掉截屏防护、顺手拉长自动锁定时长，然后关闭应用锁
    await lock.setLock("pattern", [1, 2, 3, 5]);
    await lock.updateSettings({ auto_lock_seconds: 300, screenshot_protection: false });
    expect(lock.screenshotProtection).toBe(false);
    await lock.clearLock();

    expect(lock.autoLockSeconds).toBe(defaults.autoLockSeconds);
    expect(lock.screenshotProtection).toBe(defaults.screenshotProtection);
    expect(lock.lockType).toBe(defaults.type);

    // 再次开启：新锁必须带默认值，不能是上一会话的设置
    await lock.setLock("pin", "194726");
    const fresh = useLockStore();
    await fresh.load();
    expect(fresh.autoLockSeconds).toBe(60);
    expect(fresh.screenshotProtection).toBe(true);
    expect(fresh.lockType).toBe("pin");
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
