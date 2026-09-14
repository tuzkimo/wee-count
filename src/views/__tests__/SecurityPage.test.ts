import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ localLogin: vi.fn(async () => true) }),
}));
vi.mock("@/services/screenshotProtection", () => ({
  applyScreenshotProtection: vi.fn(async () => undefined),
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));

import SecurityPage from "@/views/SecurityPage.vue";
import { useLockStore } from "@/stores/lock";
import { applyScreenshotProtection } from "@/services/screenshotProtection";

/** 非全同、非连续，能过 store 的弱口令校验。 */
const PIN = "194726";

describe("SecurityPage", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 失败路径用例把 localStorage 整体换掉 / 监听了 console.warn，这里一律还原，
    // 不让全局状态泄漏到下一条用例。
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("未设锁时总开关为关，且不显示改锁入口", () => {
    const w = mount(SecurityPage);
    expect(w.find('[data-test="lock-enabled"]').element).toHaveProperty("checked", false);
    expect(w.find('[data-test="change-lock"]').exists()).toBe(false);
  });

  it("已设锁时显示锁形态与改锁入口", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();
    expect(w.text()).toContain("数字密码");
    expect(w.find('[data-test="change-lock"]').exists()).toBe(true);
  });

  it("打开总开关弹出设置锁对话框", async () => {
    const w = mount(SecurityPage);
    await w.find('[data-test="lock-enabled"]').setValue(true);
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);
  });

  it("关闭总开关清除锁配置", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();
    await w.find('[data-test="lock-enabled"]').setValue(false);
    await flushPromises();
    expect(useLockStore().isLockConfigured).toBe(false);
  });

  it("自动锁定时间只提供立即 / 1 分钟 / 5 分钟", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();
    // 取每个选项按钮里的**标签 span**（第一个子元素）：按钮内还有独立的选中标记，
    // 直接取按钮 text() 会把「✓」混进选项文案里。
    const options = w
      .findAll('[data-test^="auto-lock-"] > span:first-child')
      .map((o) => o.text());
    expect(options).toEqual(["立即", "1 分钟", "5 分钟"]);
  });

  it("切换自动锁定时间写入配置", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();
    await w.find('[data-test="auto-lock-300"]').trigger("click");
    await flushPromises();
    expect(useLockStore().autoLockSeconds).toBe(300);
  });

  it("截图防护开关默认开且可关闭并写回配置", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();
    const toggle = w.find('[data-test="screenshot-protection"]');
    expect((toggle.element as HTMLInputElement).checked).toBe(true);
    await toggle.setValue(false);
    await flushPromises();
    expect(useLockStore().screenshotProtection).toBe(false);
  });

  it("不出现「加密」措辞（数据文件是明文，避免安全错觉）", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();
    expect(w.text()).not.toContain("加密");
  });

  // ---- 以下为简报 8 条之外补的用例（R34 / R57 / R62 / R51 路径）----

  it("R62：未设锁时没有任何 change 模式入口（change 会因 hash 为空无限报「密码错误」）", async () => {
    const w = mount(SecurityPage);
    expect(w.find('[data-test="change-lock"]').exists()).toBe(false);

    // 正对照：已设锁时同一个入口确实出现 —— 证明上面那条不是「选择器压根写错」的恒真断言。
    await useLockStore().setLock("pin", PIN);
    await w.vm.$nextTick();
    expect(w.find('[data-test="change-lock"]').exists()).toBe(true);
  });

  it("R62：改锁入口打开的是 change 模式对话框（先验旧锁）", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    await w.find('[data-test="change-lock"]').trigger("click");

    const dialog = w.find('[data-test="set-lock-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain("验证当前应用锁");
  });

  it("R62：总开关打开的是 set 模式对话框（不走 change 的验旧锁）", async () => {
    const w = mount(SecurityPage);
    await w.find('[data-test="lock-enabled"]').setValue(true);

    const dialog = w.find('[data-test="set-lock-dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).not.toContain("验证当前应用锁");
    expect(dialog.text()).toContain("设置应用锁");
  });

  it("R34：关锁落盘失败时如实报错，且绝不让界面看起来像已关闭", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    // 模拟 WebView 存储被禁用：clearLock → clearAppLock → localStorage.removeItem 抛错 → reject。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", undefined);

    await w.find('[data-test="lock-enabled"]').setValue(false);
    await flushPromises();

    // 真实状态：仍然是「已配置、仍生效」。
    expect(useLockStore().isLockConfigured).toBe(true);
    // 复选框必须回到勾选态：受控 input 的 DOM 状态由 store 驱动。
    expect((w.find('[data-test="lock-enabled"]').element as HTMLInputElement).checked).toBe(true);
    // 出路提示：明确说明关锁失败、锁仍开着。
    expect(w.find('[data-test="security-error"]').text()).toContain("关闭失败，应用锁仍开启");
    // 不得出现任何「已关闭」的成功措辞。
    expect(w.text()).not.toContain("已关闭");
    // 证据：reject 来自 clearAppLock 的持久化分支，而不是别的路径。
    expect(warn.mock.calls.flat().join(" ")).toContain("锁配置未清除");
    warn.mockRestore();
  });

  it("R57：自动锁定时间落盘失败时提示且不改变显示值", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    // 默认 60 秒，点「5 分钟」时写入失败。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", undefined);

    await w.find('[data-test="auto-lock-300"]').trigger("click");
    await flushPromises();

    expect(w.find('[data-test="security-error"]').text()).toContain("设置保存失败");
    expect(useLockStore().autoLockSeconds).toBe(60);
    // 选中标记仍在 1 分钟上（不是假确认到 5 分钟）。
    expect(w.find('[data-test="auto-lock-check-60"]').exists()).toBe(true);
    expect(w.find('[data-test="auto-lock-check-300"]').exists()).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("锁配置未写入");
    warn.mockRestore();
  });

  it("R57：截图防护开关落盘失败时提示，且界面回到真实状态（仍是开）", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", undefined);

    await w.find('[data-test="screenshot-protection"]').setValue(false);
    await flushPromises();

    expect(w.find('[data-test="security-error"]').text()).toContain("设置保存失败");
    expect(useLockStore().screenshotProtection).toBe(true);
    expect((w.find('[data-test="screenshot-protection"]').element as HTMLInputElement).checked)
      .toBe(true);
    // 落盘都没成功，绝不能真的去关系统层面的截屏防护。
    expect(applyScreenshotProtection).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("截图防护开关在 await 落盘之后才调用 applyScreenshotProtection", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    const calls: string[] = [];
    vi.mocked(applyScreenshotProtection).mockImplementation(async () => {
      // 调用它时，配置必须已经真的落盘（而不是「先关防护、后写失败」）。
      calls.push(String(useLockStore().screenshotProtection));
    });

    await w.find('[data-test="screenshot-protection"]').setValue(false);
    await flushPromises();

    expect(applyScreenshotProtection).toHaveBeenCalledWith(false);
    expect(calls).toEqual(["false"]);
  });

  it("成功路径不留下失败提示（证明失败提示不是恒真渲染）", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    await w.find('[data-test="auto-lock-300"]').trigger("click");
    await flushPromises();

    expect(useLockStore().autoLockSeconds).toBe(300);
    expect(w.find('[data-test="security-error"]').exists()).toBe(false);
  });

  it("生物识别不提供任何开关 UI（本轮恒为 false，不给开了也没用的按钮）", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    expect(w.find('[data-test="biometric"]').exists()).toBe(false);
    expect(w.text()).not.toContain("指纹");
    expect(w.text()).not.toContain("面容");
    expect(w.text()).not.toContain("生物识别");
  });
});
