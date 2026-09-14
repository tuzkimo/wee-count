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
    // 每条用例都从「系统层调用成功」起步：个别用例会临时把它改成 reject，
    // 而页面在 onMounted 里也会重放一次（R68），不复位就会泄漏到下一条用例。
    vi.mocked(applyScreenshotProtection).mockReset();
    vi.mocked(applyScreenshotProtection).mockImplementation(async () => undefined);
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

    // 页面挂载时已按当时的真实值重放过一次（R68）。这里只关心**这次失败的写入**
    // 有没有下发系统层调用，所以从这一刻起重新计数。
    vi.mocked(applyScreenshotProtection).mockClear();

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

  // ---- 收尾修复轮：R66 / R67 / R68 ----

  it("R66：打开设置对话框后点取消，总开关回到「未开启」的真实态", async () => {
    const w = mount(SecurityPage);
    await flushPromises();

    await w.find('[data-test="lock-enabled"]').setValue(true);
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);
    // 前提（正是缺陷的成因）：浏览器已把 DOM 原生翻到勾选态，而 store 仍未被配置。
    // 此时 `:checked` 的 prop 值没有变化，Vue 不会回写 DOM。
    expect((w.find('[data-test="lock-enabled"]').element as HTMLInputElement).checked).toBe(true);
    expect(useLockStore().isLockConfigured).toBe(false);

    await w.find('[data-test="set-lock-cancel"]').trigger("click");
    await flushPromises();
    await w.vm.$nextTick();

    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
    const el = w.find('[data-test="lock-enabled"]').element as HTMLInputElement;
    // DOM 真实态，以及它与 store 的一致性 —— R66 的全部要求。
    expect(el.checked).toBe(false);
    expect(el.checked).toBe(useLockStore().isLockConfigured);
    // 不靠一条红色提示去「解释」这个不一致：状态本身就该是对的。
    expect(w.find('[data-test="security-error"]').exists()).toBe(false);
  });

  it("R66：setLock 落盘失败后再点取消，开关同样回到未开启", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = mount(SecurityPage);
    await flushPromises();

    await w.find('[data-test="lock-enabled"]').setValue(true);

    // 落盘必失败（与 R34 同一条路径）：localStorage 不可用 → writeAppLock reject。
    vi.stubGlobal("localStorage", undefined);
    for (const d of PIN) await w.find(`[data-test="pin-key-${d}"]`).trigger("click");
    for (const d of PIN) await w.find(`[data-test="pin-key-${d}"]`).trigger("click");
    // 落盘要过真实 bcrypt（跨多轮宏任务），等到那条失败提示出现，才确认这次
    // 走到的是「设置失败后再取消」，而不是被别的路径挡住。
    await vi.waitFor(() => {
      expect(w.find('[data-test="set-lock-message"]').text()).toContain("设置失败");
    });

    expect(useLockStore().isLockConfigured).toBe(false);
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);

    await w.find('[data-test="set-lock-cancel"]').trigger("click");
    await flushPromises();
    await w.vm.$nextTick();

    const el = w.find('[data-test="lock-enabled"]').element as HTMLInputElement;
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
    expect(el.checked).toBe(false);
    expect(el.checked).toBe(useLockStore().isLockConfigured);
    warn.mockRestore();
  });

  it("R67：未配置锁时不渲染「禁止截屏」开关（点了也不会有任何效果）", async () => {
    const w = mount(SecurityPage);
    await flushPromises();

    // 未配置锁时 `updateSettings` 是空操作（有意行为）：渲染一个可点却写不进去的
    // 开关，等于让页面撒谎，还会真的把系统级防护关掉。
    expect(w.find('[data-test="screenshot-protection"]').exists()).toBe(false);
    expect(w.text()).not.toContain("禁止截屏");

    // 正对照：配置锁之后同一个开关确实出现，证明上面不是选择器写错的恒真断言。
    await useLockStore().setLock("pin", PIN);
    await w.vm.$nextTick();
    expect(w.find('[data-test="screenshot-protection"]').exists()).toBe(true);
  });

  it("R68：关锁后把复位后的截屏防护值重放到系统层", async () => {
    const lock = useLockStore();
    await lock.setLock("pin", PIN);
    // 用户此前把截屏防护关掉了：持久化 false，系统层也已经关掉。
    await lock.updateSettings({ screenshot_protection: false });
    expect(lock.screenshotProtection).toBe(false);

    const w = mount(SecurityPage);
    await flushPromises();
    // 开页面时先按当前值重放一次（与 main.ts 启动时同一个动作，幂等）。
    expect(applyScreenshotProtection).toHaveBeenLastCalledWith(false);

    await w.find('[data-test="lock-enabled"]').setValue(false);
    await flushPromises();

    // clearLock 把 store 复位成默认 true；系统层必须跟着变成 true，
    // 否则本次会话里「配置说开启、系统其实关着」，要等下次冷启动才被纠正。
    expect(lock.isLockConfigured).toBe(false);
    expect(lock.screenshotProtection).toBe(true);
    expect(applyScreenshotProtection).toHaveBeenLastCalledWith(true);
  });

  it("R68：关锁后重放失败时如实提示，且不说「关闭失败」", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    vi.mocked(applyScreenshotProtection).mockRejectedValue(new Error("FLAG_SECURE 设置失败"));

    await w.find('[data-test="lock-enabled"]').setValue(false);
    await flushPromises();

    // 锁确实关掉了：不能谎报「关闭失败」。
    expect(useLockStore().isLockConfigured).toBe(false);
    const err = w.find('[data-test="security-error"]');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain("截屏防护未能同步");
    expect(err.text()).not.toContain("关闭失败");
  });

  it("R68：开页面时重放失败只留日志，不弹提示也不阻断渲染", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(applyScreenshotProtection).mockRejectedValue(new Error("not in tauri"));
    await useLockStore().setLock("pin", PIN);

    const w = mount(SecurityPage);
    await flushPromises();

    expect(w.find('[data-test="screenshot-protection"]').exists()).toBe(true);
    expect(w.find('[data-test="security-error"]').exists()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("R69：系统层切换失败时页面提示可达（那条分支不再是死代码）", async () => {
    await useLockStore().setLock("pin", PIN);
    const w = mount(SecurityPage);
    await flushPromises();

    // 落盘成功、系统层失败：配置已经是 false，但系统调用 reject。
    // R69 之前服务层把失败吞掉，这条 catch 永远走不到。
    vi.mocked(applyScreenshotProtection).mockImplementation(async (enabled: boolean) => {
      if (!enabled) throw new Error("设置 FLAG_SECURE 失败");
    });

    await w.find('[data-test="screenshot-protection"]').setValue(false);
    await flushPromises();

    // 配置如实落盘（不谎称失败），但系统层没跟上必须说出来。
    expect(useLockStore().screenshotProtection).toBe(false);
    expect((w.find('[data-test="screenshot-protection"]').element as HTMLInputElement).checked)
      .toBe(false);
    expect(w.find('[data-test="security-error"]').text()).toContain("截屏防护设置失败，请重试");
  });
});
