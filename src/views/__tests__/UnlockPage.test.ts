import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

/**
 * vue-router 整个替换成替身：解锁页只用到 `useRoute().query` 与 `useRouter().replace`，
 * 拉真 router 反而要把整张路由表（连同守卫）拖进这个用例，测不出解锁页自己的行为。
 * query 用**可变对象**，才能在同一次运行里喂出不同的 redirect 值；
 * 用 `vi.hoisted` 是因为 `vi.mock` 工厂会在 import 之前被调用，普通 const 还处于 TDZ。
 */
const { replace, routeQuery, localLogin } = vi.hoisted(() => ({
  replace: vi.fn(),
  routeQuery: {} as Record<string, unknown>,
  localLogin: vi.fn(async () => true),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ localLogin }),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ query: routeQuery }),
  useRouter: () => ({ replace }),
}));

import UnlockPage from "@/views/UnlockPage.vue";
import { MAX_UNLOCK_ATTEMPTS, useLockStore } from "@/stores/lock";

const PIN = "194726";
const WRONG_PIN = "502814";
/** 重设锁时用的新口令：非全同、非连续，能过 store 的弱口令校验。 */
const NEW_PIN = "836251";

/**
 * 等这一轮输入结算。
 *
 * 校验走 bcrypt（动态 import + 跨宏任务轮次），单次 `flushPromises` 等不到结果，
 * 所以要等到出现明确落点：已跳转、已出提示、或数字键盘被清空。
 *
 * 注意「键盘空了」只在**确实存在数字键盘**时才算信号。图案路径（或账户密码表单）
 * 本来就没有点位指示，拿空集合当信号会立刻通过，bcrypt 结果就漏到下一条用例里，
 * 表现为随机的「上一条的 replace 出现在下一条」。
 */
async function settle(w: VueWrapper): Promise<void> {
  await vi.waitFor(
    () => {
      const redirected = replace.mock.calls.length > 0;
      const hasMessage = w.find('[data-test="unlock-message"]').exists();
      const padExists = w.find('[data-test="pin-key-1"]').exists();
      const padCleared = padExists && w.findAll('[data-test="pin-dot-filled"]').length === 0;
      if (!redirected && !hasMessage && !padCleared) throw new Error("这一轮输入尚未结算");
    },
    { timeout: 5000 },
  );
  await flushPromises();
}

/** 敲满 6 位（键盘自动提交）并等结算。 */
async function typePin(w: VueWrapper, pin: string): Promise<void> {
  for (const d of pin) {
    await w.find(`[data-test="pin-key-${d}"]`).trigger("click");
  }
  await settle(w);
}

/** happy-dom 不做布局，rect 恒为 0；按真实边长喂 rect，指针坐标才能 1:1 换算。 */
function stubRect(width: number): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: width, bottom: width,
    width, height: width, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** 在九宫格上划出给定点位序列。 */
async function dragPattern(w: VueWrapper, dots: number[]): Promise<void> {
  const svg = w.find('[data-test="pattern-lock"]');
  const size = Number(svg.attributes("width"));
  stubRect(size);
  const cell = size / 3;
  const at = (dot: number) => ({
    clientX: ((dot - 1) % 3 + 0.5) * cell,
    clientY: (Math.floor((dot - 1) / 3) + 0.5) * cell,
    pointerId: 1,
  });
  await svg.trigger("pointerdown", at(dots[0]));
  for (const dot of dots.slice(1)) await svg.trigger("pointermove", at(dot));
  await svg.trigger("pointerup", { pointerId: 1 });
  await flushPromises();
}

/** 连错到阈值，逼出账户密码表单。 */
async function exhaustAttempts(w: VueWrapper): Promise<void> {
  for (let i = 0; i < MAX_UNLOCK_ATTEMPTS; i++) await typePin(w, WRONG_PIN);
}

/** 填账户密码并提交（`localLogin` 是替身，微任务内即结算）。 */
async function submitAccount(w: VueWrapper, username: string, password: string): Promise<void> {
  await w.find('[data-test="unlock-account-username"]').setValue(username);
  await w.find('[data-test="unlock-account-password"]').setValue(password);
  await w.find('[data-test="unlock-account-form"]').trigger("submit");
  await flushPromises();
}

describe("UnlockPage", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    replace.mockClear();
    localLogin.mockClear();
    localLogin.mockImplementation(async () => true);
    routeQuery.redirect = "/accounts";
    await useLockStore().setLock("pin", PIN);
    useLockStore().lock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("渲染数字键盘", () => {
    const w = mount(UnlockPage);
    expect(w.find('[data-test="pin-key-1"]').exists()).toBe(true);
    expect(w.find('[data-test="pattern-lock"]').exists()).toBe(false);
  });

  it("正确 PIN 解锁并回跳 redirect", async () => {
    const w = mount(UnlockPage);
    await typePin(w, PIN);
    // 端到端：验证本身不放行（R72），真正解锁的是 `leave()` 里那句 `lock.unlock()`。
    // 断言的是最终状态而不是 `verifyPin` 的返回值 —— 漏掉那一步用户就解不开锁。
    expect(useLockStore().isLocked).toBe(false);
    expect(replace).toHaveBeenCalledWith("/accounts");
  });

  it("错误 PIN 提示且保持锁定", async () => {
    const w = mount(UnlockPage);
    await typePin(w, WRONG_PIN);
    expect(useLockStore().isLocked).toBe(true);
    expect(w.text()).toContain("密码错误");
    expect(replace).not.toHaveBeenCalled();
  });

  it("连错 5 次后切到账户密码表单", async () => {
    const w = mount(UnlockPage);
    await exhaustAttempts(w);
    expect(w.find('[data-test="unlock-account-form"]').exists()).toBe(true);
    expect(w.text()).toContain("错误次数过多");
    expect(useLockStore().requireAccountPassword).toBe(true);
  });

  it("lockType 为 pattern 时渲染九宫格而不是数字键盘", async () => {
    // `setLock` 只改配置，不动 `isLocked`：这一轮仍是锁定态。
    await useLockStore().setLock("pattern", [1, 2, 3, 4]);

    const w = mount(UnlockPage);
    expect(w.find('[data-test="pattern-lock"]').exists()).toBe(true);
    expect(w.find('[data-test="pin-key-1"]').exists()).toBe(false);
  });

  it("正确图案解锁并回跳 redirect", async () => {
    await useLockStore().setLock("pattern", [1, 2, 3, 4]);

    const w = mount(UnlockPage);
    await dragPattern(w, [1, 2, 3, 4]);
    await settle(w);

    // 图案这条链同样端到端：验证不放行（R72），`leave()` 的 `unlock()` 才放行。
    expect(useLockStore().isLocked).toBe(false);
    expect(replace).toHaveBeenCalledWith("/accounts");
  });

  it("图案点数不足（invalid）不计入失败次数（R56）", async () => {
    await useLockStore().setLock("pattern", [1, 2, 3, 4]);

    const w = mount(UnlockPage);
    // 一次未完成的输入（系统打断 / 手掌误触都会走到这里），不是一次失败的验证。
    await dragPattern(w, [1, 2, 3]);

    expect(useLockStore().failedAttempts).toBe(0);
    expect(useLockStore().requireAccountPassword).toBe(false);
    expect(useLockStore().isLocked).toBe(true);
    expect(w.text()).toContain("至少需要连接 4 个点");
    expect(w.text()).not.toContain("密码错误");
    expect(replace).not.toHaveBeenCalled();
  });

  it("图案错误（合法但不对）才计入失败次数", async () => {
    await useLockStore().setLock("pattern", [1, 2, 3, 4]);

    const w = mount(UnlockPage);
    await dragPattern(w, [1, 2, 3, 6]);
    await settle(w);

    expect(useLockStore().failedAttempts).toBe(1);
    expect(useLockStore().isLocked).toBe(true);
    expect(w.text()).toContain("密码错误");
    expect(replace).not.toHaveBeenCalled();
  });

  it("账户密码验证成功后仍在锁内，重设新锁之后才放行（R33）", async () => {
    const w = mount(UnlockPage);
    await exhaustAttempts(w);

    await submitAccount(w, "alice", "secret");

    // 身份已证明，但没有任何放行：仍在锁内、没跳转，只是就地要求重设新锁。
    expect(useLockStore().isLocked).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);

    // 重设：两遍一致的新 PIN。
    await typePin(w, NEW_PIN);
    await typePin(w, NEW_PIN);

    expect(await useLockStore().verifyPin(NEW_PIN)).toBe(true);
    expect(useLockStore().isLocked).toBe(false);
    expect(replace).toHaveBeenCalledWith("/accounts");
  });

  it("重设锁时点取消会关掉对话框，且仍然锁着（R18）", async () => {
    const w = mount(UnlockPage);
    await exhaustAttempts(w);
    await submitAccount(w, "alice", "secret");
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);

    await w.find('[data-test="set-lock-cancel"]').trigger("click");

    // 「取消」必须真的关掉对话框：原计划只接了 @saved，点取消毫无反应。
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
    expect(useLockStore().isLocked).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    // 取消后仍是一个可用的解锁页（账户密码验过会清零错误计数，于是回到 PIN 路径），
    // 既没卡在对话框上，也没留下空白视图。
    expect(useLockStore().requireAccountPassword).toBe(false);
    expect(w.find('[data-test="pin-key-1"]').exists()).toBe(true);
  });

  it("非降级态也能走「忘记密码？」进账户密码（忘了 PIN 的人唯一的出路）", async () => {
    const w = mount(UnlockPage);
    expect(w.find('[data-test="unlock-account-form"]').exists()).toBe(false);

    await w.find('[data-test="unlock-forgot"]').trigger("click");

    const form = w.find('[data-test="unlock-account-form"]');
    expect(form.exists()).toBe(true);
    // 非降级态不该谎称「错误次数过多」：这里本来就是用户主动点进来的。
    expect(form.text()).not.toContain("错误次数过多");

    await submitAccount(w, "alice", "secret");
    expect(useLockStore().isLocked).toBe(true);
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);
  });

  it("账户密码错误时提示且不放行", async () => {
    localLogin.mockImplementation(async () => false);

    const w = mount(UnlockPage);
    await exhaustAttempts(w);
    await submitAccount(w, "alice", "wrong");

    expect(w.text()).toContain("用户名或密码错误");
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(false);
    expect(useLockStore().isLocked).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirect 是协议相对地址（//evil.example）时消毒后回落首页（R46）", async () => {
    // 守卫只消毒它自己产出的回跳值；深链进来的原始值必须由解锁页自己再过一遍。
    routeQuery.redirect = "//evil.example";

    const w = mount(UnlockPage);
    await typePin(w, PIN);

    expect(useLockStore().isLocked).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("redirect 缺失时回落首页（R46）", async () => {
    delete routeQuery.redirect;

    const w = mount(UnlockPage);
    await typePin(w, PIN);

    expect(useLockStore().isLocked).toBe(false);
    expect(replace).toHaveBeenCalledWith("/");
  });

  // ---- 收尾修复轮：R64（「忘记密码？」不是单向门）----

  it("R64：从「忘记密码？」进入账户密码表单后能返回键盘", async () => {
    const w = mount(UnlockPage);
    await w.find('[data-test="unlock-forgot"]').trigger("click");
    expect(w.find('[data-test="unlock-account-form"]').exists()).toBe(true);
    expect(w.find('[data-test="pin-key-1"]').exists()).toBe(false);

    await w.find('[data-test="unlock-back"]').trigger("click");

    // 回到键盘：表单收起、「忘记密码？」重新可用、返回入口自己消失。
    expect(w.find('[data-test="unlock-account-form"]').exists()).toBe(false);
    expect(w.find('[data-test="pin-key-1"]').exists()).toBe(true);
    expect(w.find('[data-test="unlock-forgot"]').exists()).toBe(true);
    expect(w.find('[data-test="unlock-back"]').exists()).toBe(false);
    // 没有因为「退回去」而放行。
    expect(useLockStore().isLocked).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it("R64：返回键盘时清掉表单留下的失败提示", async () => {
    localLogin.mockImplementation(async () => false);

    const w = mount(UnlockPage);
    await w.find('[data-test="unlock-forgot"]').trigger("click");
    await submitAccount(w, "alice", "wrong");
    expect(w.find('[data-test="unlock-message"]').text()).toContain("用户名或密码错误");

    await w.find('[data-test="unlock-back"]').trigger("click");

    // 退回键盘时不该还挂着账户密码的错误提示（会让人以为是 PIN 输错了）。
    expect(w.find('[data-test="unlock-message"]').exists()).toBe(false);
    expect(w.find('[data-test="pin-key-1"]').exists()).toBe(true);
  });

  it("R64：降级态不提供返回入口（那时 PIN/图案一律不放行，退回去是死路）", async () => {
    const w = mount(UnlockPage);
    await exhaustAttempts(w);

    expect(w.find('[data-test="unlock-account-form"]').exists()).toBe(true);
    expect(w.find('[data-test="unlock-back"]').exists()).toBe(false);
  });

  it("R64：放行时账户密码表单被一并收起（leave 里复位）", async () => {
    const w = mount(UnlockPage);
    await w.find('[data-test="unlock-forgot"]').trigger("click");
    await submitAccount(w, "alice", "secret");
    expect(w.find('[data-test="set-lock-dialog"]').exists()).toBe(true);

    // 账户密码验过 → 就地重设新锁 → @saved 才放行。
    await typePin(w, NEW_PIN);
    await typePin(w, NEW_PIN);

    expect(replace).toHaveBeenCalledWith("/accounts");
    // 放行之际表单状态也要复位：残留的 showAccountForm 会让解锁页多留一帧表单。
    expect(w.find('[data-test="unlock-account-form"]').exists()).toBe(false);
    expect(w.find('[data-test="unlock-back"]').exists()).toBe(false);
  });
});
