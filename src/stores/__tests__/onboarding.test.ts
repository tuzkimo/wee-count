// src/stores/__tests__/onboarding.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

import { useOnboardingStore } from "@/stores/onboarding";
import { useLockStore } from "@/stores/lock";

const KEY = "app_lock_asked";
/** 非全同、非连续，能过 store 的弱口令校验。 */
const PIN = "194726";

/** 让一个 promise 有机会跑到它下一个 await 之后。 */
async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("onboarding store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("未配锁、也没问过 → 弹窗，并一直挂到用户作出选择", async () => {
    const onboarding = useOnboardingStore();
    const pending = onboarding.promptAppLockIfNeeded();
    await tick();

    expect(onboarding.promptVisible).toBe(true);

    // 挂起：await 还没轮到，调用方（登录页）不会先跳走。
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);

    await onboarding.finishAppLockPrompt();
    await pending;
    expect(onboarding.promptVisible).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(true);
  });

  it("已配置应用锁 → 不弹（设备上已经有锁了）", async () => {
    await useLockStore().setLock("pin", PIN);
    const onboarding = useOnboardingStore();

    await onboarding.promptAppLockIfNeeded();

    expect(onboarding.promptVisible).toBe(false);
    // 不弹就不该写标记：用户这次没被问过，不该被算作「问过了」。
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("问过（含拒绝）→ 不再问", async () => {
    localStorage.setItem(KEY, "true");
    const onboarding = useOnboardingStore();

    await onboarding.promptAppLockIfNeeded();

    expect(onboarding.promptVisible).toBe(false);
  });

  it("标记读不出来时**不**弹：引导不是关键路径，宁可少打扰一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError: 存储被禁用");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
      clear: () => undefined,
    });
    const onboarding = useOnboardingStore();

    await onboarding.promptAppLockIfNeeded();

    expect(onboarding.promptVisible).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("标记无法解析（不是布尔）时也按「不弹」处理", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    localStorage.setItem(KEY, JSON.stringify("true"));
    const onboarding = useOnboardingStore();

    await onboarding.promptAppLockIfNeeded();

    expect(onboarding.promptVisible).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("写标记失败只留日志，不阻断调用方（最坏是下次再问一次）", async () => {
    const onboarding = useOnboardingStore();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const pending = onboarding.promptAppLockIfNeeded();
    await tick();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
      clear: () => undefined,
    });

    // 不 reject：调用方 await 的是「用户选完了」，不是「标记写成功了」。
    await expect(onboarding.finishAppLockPrompt()).resolves.toBeUndefined();
    await pending;
    expect(onboarding.promptVisible).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("并发/重复调用只开一次询问：一次选择把两边一起放行", async () => {
    const onboarding = useOnboardingStore();

    const first = onboarding.promptAppLockIfNeeded();
    await tick();
    const second = onboarding.promptAppLockIfNeeded();
    await tick();

    expect(onboarding.promptVisible).toBe(true);

    let firstDone = false;
    let secondDone = false;
    void first.then(() => {
      firstDone = true;
    });
    void second.then(() => {
      secondDone = true;
    });
    await tick();
    // 还没作出选择，两边都不许先走。
    expect(firstDone).toBe(false);
    expect(secondDone).toBe(false);

    await onboarding.finishAppLockPrompt();
    await Promise.all([first, second]);

    expect(firstDone).toBe(true);
    expect(secondDone).toBe(true);
    expect(onboarding.promptVisible).toBe(false);
  });
});
