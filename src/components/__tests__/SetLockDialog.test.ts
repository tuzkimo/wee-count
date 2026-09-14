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

import SetLockDialog from "@/components/lock/SetLockDialog.vue";
import { useLockStore } from "@/stores/lock";

async function typePin(w: ReturnType<typeof mount>, pin: string) {
  for (const d of pin) {
    await w.find(`[data-test="pin-key-${d}"]`).trigger("click");
  }
  // 组件内部的校验 / 落盘是异步的（bcrypt 走动态 import，要跨宏任务轮次才结算），
  // 单次 flushPromises 等不到结果。这里等到这一轮输入有了明确落点：
  // 重新变空的键盘、一条提示，或一次 saved。
  await vi.waitFor(() => {
    const settled =
      w.emitted("saved") !== undefined ||
      w.find('[data-test="set-lock-message"]').exists() ||
      w.findAll('[data-test="pin-dot-filled"]').length === 0;
    if (!settled) throw new Error("这一轮输入尚未结算");
  });
  await flushPromises();
}

describe("SetLockDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  afterEach(() => {
    // 用例 (a) 把 localStorage 打没了、并监听了 console.warn，这里一律还原，
    // 不让全局状态泄漏到下一条用例。
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("open 为假时不渲染内容", () => {
    const w = mount(SetLockDialog, { props: { open: false } });
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
  });

  it("两遍输入一致时保存并发出 saved", async () => {
    const w = mount(SetLockDialog, { props: { open: true } });
    await typePin(w, "194726");
    await typePin(w, "194726");
    expect(w.emitted("saved")).toHaveLength(1);
    expect(useLockStore().isLockConfigured).toBe(true);
    expect(await useLockStore().verifyPin("194726")).toBe(true);
  });

  it("两遍不一致时给出提示且不保存", async () => {
    const w = mount(SetLockDialog, { props: { open: true } });
    await typePin(w, "194726");
    await typePin(w, "194727");
    expect(w.emitted("saved")).toBeUndefined();
    expect(w.text()).toContain("两次输入不一致");
    expect(useLockStore().isLockConfigured).toBe(false);
  });

  it("弱口令被拒绝并提示", async () => {
    const w = mount(SetLockDialog, { props: { open: true } });
    await typePin(w, "111111");
    await typePin(w, "111111");
    expect(w.emitted("saved")).toBeUndefined();
    expect(w.text()).toContain("全同或连续");
    expect(useLockStore().isLockConfigured).toBe(false);
  });

  it("mode=change 时先要求验证旧锁", async () => {
    await useLockStore().setLock("pin", "194726");

    const w = mount(SetLockDialog, { props: { open: true, mode: "change" } });
    expect(w.text()).toContain("当前应用锁");

    await typePin(w, "194726");
    expect(w.text()).toContain("设置新应用锁");
  });

  it("mode=change 时旧锁错误则停在验证阶段并提示", async () => {
    await useLockStore().setLock("pin", "194726");

    const w = mount(SetLockDialog, { props: { open: true, mode: "change" } });
    await typePin(w, "502814");
    expect(w.text()).toContain("验证当前应用锁");
    expect(w.text()).toContain("密码错误");
    expect(w.text()).not.toContain("设置新应用锁");

    // R35：verifyPin 与解锁页共用失败计数。连错到阈值后退化态下**正确口令也不放行**，
    // 此时界面必须换成「有出路」的诚实提示，而不是继续循环「密码错误」把用户困死。
    for (let i = 0; i < 4; i++) await typePin(w, "502814");
    expect(useLockStore().requireAccountPassword).toBe(true);
    expect(w.text()).toContain("尝试次数过多");
    expect(w.text()).not.toContain("密码错误");

    // 退化态下输入**正确**的旧口令同样被拒，提示必须如实说明原因与出路。
    await typePin(w, "194726");
    expect(w.text()).toContain("尝试次数过多");
    expect(w.text()).not.toContain("设置新应用锁");
  });

  it("落盘失败时不发 saved，且给出不含成功字样的失败提示", async () => {
    // R31 的持久化分支：writeAppLock 在「localStorage 不可用」时写不进去 → reject。
    // 这条 reject 带 cause，走的是 setLockErrorMessage 的**持久化**分支，
    // 与「弱口令」那条校验分支（无 cause，透出 store 原文案）不是同一条路径。
    vi.stubGlobal("localStorage", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const w = mount(SetLockDialog, { props: { open: true } });
    await typePin(w, "194726");
    await typePin(w, "194726");

    // 证据一：reject 来自 lockStorage 的写入分支，而不是 setLock 的校验分支
    // （校验分支在 writeAppLock 之前就抛了，不会有这条 warn）。
    expect(warn.mock.calls.flat().join(" ")).toContain("锁配置未写入");

    // 证据二：这条兜底文案只可能由 setLockErrorMessage 的持久化分支产出 ——
    // 校验分支会把 store 的原文案（如「全同或连续」）透出来，持久化分支才会换成这句。
    // 用**精确相等**钉住：既证明是这句兜底文案，也证明底层技术细节（writeAppLock: …）没被甩给用户。
    expect(w.emitted("saved")).toBeUndefined();
    expect(w.find('[data-test="set-lock-message"]').text()).toBe("设置失败，锁未保存，请重试");
    expect(w.text()).not.toContain("成功");
    expect(useLockStore().isLockConfigured).toBe(false);
    // 失败后回到第一遍，用户可以就地重试。
    expect(w.text()).toContain("设置应用锁");
  });

  it("打开时已处于降级态：打开即给出出路提示，不循环「密码错误」", async () => {
    // R35 的「打开即降级」路径：验证与解锁页共用 failedAttempts，
    // 先把计数打满，再以 open = true 挂载（不是先挂载再手动置真）。
    const lock = useLockStore();
    await lock.setLock("pin", "194726");
    for (let i = 0; i < 5; i++) {
      expect(await lock.verifyPin("502814")).toBe(false);
    }
    expect(lock.requireAccountPassword).toBe(true);

    const w = mount(SetLockDialog, { props: { open: true, mode: "change" } });
    // 打开即（watch immediate）就得是这句完整文案：说清真实原因 + 给出出路。
    expect(w.find('[data-test="set-lock-message"]').text())
      .toBe("尝试次数过多，请关闭对话框后在锁屏页改用账户密码，再重新设置应用锁");
    expect(w.text()).toContain("尝试次数过多");
    expect(w.text()).not.toContain("密码错误");
    expect(w.text()).not.toContain("设置新应用锁");

    // 降级态下输入**正确**的旧口令也不放行：提示必须仍是那条出路。
    await typePin(w, "194726");
    expect(w.find('[data-test="set-lock-message"]').text())
      .toBe("尝试次数过多，请关闭对话框后在锁屏页改用账户密码，再重新设置应用锁");
    expect(w.text()).not.toContain("密码错误");
    expect(w.text()).not.toContain("设置新应用锁");
  });

  it("落盘进行中禁用「取消」：点取消既不放行、也不关闭对话框", async () => {
    const w = mount(SetLockDialog, { props: { open: true } });
    // 第一遍正常结算，进入 confirm。
    await typePin(w, "194726");

    // 第二遍：点满 6 位后**不等**结算。此刻 setLock 正卡在 bcrypt 里，busy = true。
    for (const d of "194726") {
      await w.find(`[data-test="pin-key-${d}"]`).trigger("click");
    }
    const cancel = w.find('[data-test="set-lock-cancel"]');
    expect(cancel.attributes("disabled")).toBeDefined();

    await cancel.trigger("click");
    expect(w.emitted("close")).toBeUndefined();
    expect(w.emitted("saved")).toBeUndefined();

    // 写入已经开始、撤销不了：这次「取消」不该打断它，完成后仍要如实发出 saved。
    await vi.waitFor(() => expect(w.emitted("saved")).toHaveLength(1));

    // 结算后按钮恢复可用（disabled 不是恒真）。
    const after = w.find('[data-test="set-lock-cancel"]');
    expect(after.attributes("disabled")).toBeUndefined();
    // 正对照：busy 已落，同一个按钮、同一种点击方式**确实**能发出 close ——
    // 证明上面那条「不 emit close」不是「点击压根没生效」的恒真断言。
    await after.trigger("click");
    expect(w.emitted("close")).toHaveLength(1);
  });
});
