// src/views/__tests__/LoginPage.onboarding.test.ts
//
// 接线测试：本地登录成功后**必须先问一次要不要开应用锁，再跳首页**。
// 这条顺序只在页面这一层成立（store 自己不知道谁调它、什么时候调），所以它得在这里钉住。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

const replace = vi.fn(async () => undefined);
vi.mock("vue-router", () => ({ useRouter: () => ({ replace }) }));

const localLogin = vi.fn(async () => true);
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ localLogin }),
}));

// 只替掉「读标记」这一步：其余仍走真实的 onboarding store，
// 于是下面那条「引导出意外也不影响登录」验的是真实链路，而不是另一个替身。
const readAsked = vi.fn(async (): Promise<"yes" | "no" | "unknown"> => "no");
vi.mock("@/services/onboarding", () => ({
  readAppLockAsked: () => readAsked(),
  markAppLockAsked: vi.fn(async () => undefined),
}));

import LoginPage from "@/views/LoginPage.vue";
import { useOnboardingStore } from "@/stores/onboarding";

async function submitLogin(): Promise<ReturnType<typeof mount>> {
  const w = mount(LoginPage, { global: { stubs: { RouterLink: true } } });
  await w.find('input[type="text"]').setValue("tuzki");
  await w.find('input[type="password"]').setValue("account-pw");
  await w.find("button").trigger("click");
  await flushPromises();
  return w;
}

describe("LoginPage 的新用户引导接线", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    replace.mockClear();
    localLogin.mockClear();
    localLogin.mockResolvedValue(true);
    readAsked.mockClear();
    readAsked.mockResolvedValue("no");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("登录成功：先弹询问，用户选完才跳首页", async () => {
    const w = await submitLogin();
    const onboarding = useOnboardingStore();

    expect(localLogin).toHaveBeenCalledWith("tuzki", "account-pw");
    expect(onboarding.promptVisible).toBe(true);
    // 关键：询问还挂着的时候不能已经跳走，否则用户看不到它。
    expect(replace).not.toHaveBeenCalled();

    await onboarding.finishAppLockPrompt();
    await flushPromises();

    expect(replace).toHaveBeenCalledWith("/");
    w.unmount();
  });

  it("登录失败：不弹询问、不跳转", async () => {
    localLogin.mockResolvedValueOnce(false);
    const w = await submitLogin();

    expect(useOnboardingStore().promptVisible).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(w.text()).toContain("用户名或密码错误");
  });

  it("本设备已经问过：直接跳首页，不多问一次", async () => {
    readAsked.mockResolvedValueOnce("yes");
    const w = await submitLogin();

    expect(useOnboardingStore().promptVisible).toBe(false);
    expect(replace).toHaveBeenCalledWith("/");
    w.unmount();
  });

  it("引导本身出意外：不 reject、不遮罩，登录该成功还是成功", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    readAsked.mockRejectedValueOnce(new Error("boom"));

    const w = await submitLogin();

    // 账户已经登录成功了，这里绝不能显示「登录失败，请重试」。
    expect(w.text()).not.toContain("登录失败");
    expect(useOnboardingStore().promptVisible).toBe(false);
    expect(replace).toHaveBeenCalledWith("/");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    w.unmount();
  });
});

