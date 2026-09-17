// src/components/lock/__tests__/AppLockPrompt.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

import AppLockPrompt from "@/components/lock/AppLockPrompt.vue";
import { useLockStore } from "@/stores/lock";
import { useOnboardingStore } from "@/stores/onboarding";

const KEY = "app_lock_asked";
const PIN = "194726";

/**
 * 触发一次询问并返回那次 await 的 promise。
 *
 * **刻意不是 async**：async 函数返回 promise 会被展平，`await openPrompt()` 就会
 * 一直等到用户作出选择为止 —— 测试还没开始断言就卡死了。
 */
function startPrompt(): Promise<void> {
  return useOnboardingStore().promptAppLockIfNeeded();
}

/** 让 store 里的 `readAppLockAsked()` 跑完，使 promptVisible 变真。 */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function typePin(w: ReturnType<typeof mount>, pin: string): Promise<void> {
  for (const d of pin) await w.find(`[data-test="pin-key-${d}"]`).trigger("click");
}

describe("AppLockPrompt", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("点「暂不开启」：标记为已问过，询问消失，调用方得以继续", async () => {
    const pending = startPrompt();
    await tick();
    const w = mount(AppLockPrompt);
    expect(w.find('[data-test="app-lock-prompt"]').exists()).toBe(true);

    await w.find('[data-test="app-lock-prompt-decline"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="app-lock-prompt"]').exists()).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(true);
    expect(useLockStore().isLockConfigured).toBe(false);
    // 调用方（登录页）的 await 必须被放行，否则用户会卡在这一层。
    await expect(pending).resolves.toBeUndefined();
  });

  it("点「设置应用锁」：进入设置对话框，设好后标记已问过并收起", async () => {
    const pending = startPrompt();
    await tick();
    const w = mount(AppLockPrompt);

    await w.find('[data-test="app-lock-prompt-accept"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);

    await typePin(w, PIN);
    await typePin(w, PIN);
    await vi.waitFor(() => {
      expect(useLockStore().isLockConfigured).toBe(true);
    });
    await flushPromises();

    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
    expect(w.find('[data-test="app-lock-prompt"]').exists()).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it("进入设置后点取消：同样算「问过了」，不再回头问第二遍", async () => {
    const pending = startPrompt();
    await tick();
    const w = mount(AppLockPrompt);

    await w.find('[data-test="app-lock-prompt-accept"]').trigger("click");
    await flushPromises();
    await w.find('[data-test="set-lock-cancel"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
    expect(w.find('[data-test="app-lock-prompt"]').exists()).toBe(false);
    expect(useLockStore().isLockConfigured).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toBe(true);
    await expect(pending).resolves.toBeUndefined();
  });

  it("未挂起时不渲染任何东西（不该在首页凭空出现）", () => {
    const w = mount(AppLockPrompt);
    expect(w.find('[data-test="app-lock-prompt"]').exists()).toBe(false);
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
  });
});
