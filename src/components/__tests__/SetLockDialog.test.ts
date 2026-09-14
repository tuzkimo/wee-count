import { describe, it, expect, vi, beforeEach } from "vitest";
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
});
