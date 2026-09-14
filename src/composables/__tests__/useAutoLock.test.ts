// src/composables/__tests__/useAutoLock.test.ts
//
// useAutoLock 是在**活动组件实例**里注册/摘除监听的：裸调 `useAutoLock()` 时
// onMounted/onUnmounted 没有实例可绑定，一个监听都不会注册，后面所有断言都会
// 退化成恒真。所以这里一律用宿主组件 mount，卸载走 `wrapper.unmount()`。
//
// 断言一律打 `lock` action 的调用计数，而不是 `isLocked`：未配置锁时 `isLocked`
// 恒为 false，拿它当断言同样恒真。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { defineComponent } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { useAutoLock } from "@/composables/useAutoLock";
import { useLockStore } from "@/stores/lock";

/**
 * `@tauri-apps/api/window` 的替身。
 *
 * `listen` 的完成时机由用例控制（默认立即 resolve，需要竞态时换成受控 deferred），
 * 用来制造「组件在 await listen 期间卸载」这一竞态。`eventNames` 记录订阅到的事件名，
 * 顺便把「订阅的是哪个事件」钉死在字面量上。
 */
const tauriWindow = vi.hoisted(() => ({
  eventNames: [] as string[],
  listen: (_event: string, _handler: () => void): Promise<() => void> =>
    Promise.resolve(() => undefined),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    listen: (event: string, handler: () => void) => {
      tauriWindow.eventNames.push(event);
      return tauriWindow.listen(event, handler);
    },
  }),
}));

/** 宿主组件：只有它有活动实例，composable 的挂载/卸载钩子才会真的跑。 */
const Host = defineComponent({
  setup() {
    useAutoLock();
    return () => null;
  },
});

let pinia: Pinia;
let wallNow = 0;
let perfNow = 0;
let visible = true;

/**
 * 本用例挂载过的宿主。用例结束时统一卸载：否则监听会留在 document/window 上漏进
 * 下一个用例（虽然那些闭包指向的是已经作废的 pinia store，断言不会因此误判，
 * 但那是巧合，不该依赖）。
 */
const liveHosts = new Set<VueWrapper>();

function mountHost(): VueWrapper {
  const wrapper = mount(Host, { global: { plugins: [pinia] } });
  liveHosts.add(wrapper);
  return wrapper;
}

/** 卸载并销账（用例中途要卸载时用它，别直接调 wrapper.unmount()）。 */
function unmountHost(wrapper: VueWrapper): void {
  liveHosts.delete(wrapper);
  wrapper.unmount();
}

function setVisibility(value: boolean): void {
  visible = value;
}

/** 隐藏：改写 visibilityState 后派发 visibilitychange。 */
function hide(): void {
  setVisibility(false);
  document.dispatchEvent(new Event("visibilitychange"));
}

/** 恢复：同上，派发恢复态。 */
function show(): void {
  setVisibility(true);
  document.dispatchEvent(new Event("visibilitychange"));
}

/** 配置一把锁并返回 `lock` action 的 spy（vi.spyOn 默认透传原实现）。 */
function configuredLock(autoLockSeconds = 60): {
  store: ReturnType<typeof useLockStore>;
  lockSpy: ReturnType<typeof vi.spyOn>;
} {
  const store = useLockStore();
  store.isLockConfigured = true;
  store.autoLockSeconds = autoLockSeconds;
  return { store, lockSpy: vi.spyOn(store, "lock") };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  wallNow = 1_000_000;
  perfNow = 5_000;
  visible = true;
  tauriWindow.eventNames.length = 0;
  tauriWindow.listen = () => Promise.resolve(() => undefined);

  // 两个时钟各由独立变量驱动（happy-dom 的 window.performance 就是 Node 的
  // performance，一次 spy 即覆盖），否则「双时钟取 max」与「实参配对」无从判别。
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  vi.spyOn(performance, "now").mockImplementation(() => perfNow);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    visible ? "visible" : "hidden",
  );
});

afterEach(() => {
  for (const wrapper of liveHosts) wrapper.unmount();
  liveHosts.clear();
  vi.restoreAllMocks();
});

describe("useAutoLock", () => {
  it("隐藏 → 两钟同步前进 61s → 恢复：上锁", async () => {
    const { lockSpy } = configuredLock();
    mountHost();
    await flushPromises();

    hide();
    expect(lockSpy).not.toHaveBeenCalled();

    wallNow += 61_000;
    perfNow += 61_000;
    show();

    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it("同步前进 59s（两钟一致）：不误锁", async () => {
    const { store, lockSpy } = configuredLock();
    mountHost();
    await flushPromises();

    hide();
    wallNow += 59_000;
    perfNow += 59_000;
    show();

    expect(lockSpy).not.toHaveBeenCalled();
    expect(store.isLocked).toBe(false);
  });

  it("卸载后再派发 visibilitychange：没有任何效果（卸载前同一序列会上锁，作对照）", async () => {
    const { store, lockSpy } = configuredLock();

    // 对照组：同一宿主、同一序列，卸载前确实会上锁。
    // 没有这一段，「靠 `if (!hidden)` 早退」也能让下面的 0 次通过。
    const first = mountHost();
    await flushPromises();
    hide();
    wallNow += 61_000;
    perfNow += 61_000;
    show();
    expect(lockSpy).toHaveBeenCalledTimes(1);

    unmountHost(first);
    lockSpy.mockClear();
    // 复位锁定态：否则只靠 `isLocked` 守卫就能让下面保持 0 次，断言又变成恒真。
    store.isLocked = false;

    hide();
    wallNow += 61_000;
    perfNow += 61_000;
    show();

    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("未配置锁（isLockConfigured=false、autoLockSeconds=0）：lock 不被调用", async () => {
    const store = useLockStore();
    store.isLockConfigured = false;
    store.autoLockSeconds = 0;
    const lockSpy = vi.spyOn(store, "lock");

    mountHost();
    await flushPromises();

    hide();
    wallNow += 61_000;
    perfNow += 61_000;
    show();

    expect(lockSpy).not.toHaveBeenCalled();
  });

  it("已锁定：不重复上锁，且 failedAttempts 不被复位", async () => {
    const { store, lockSpy } = configuredLock();
    store.isLocked = true;
    store.failedAttempts = 3;

    mountHost();
    await flushPromises();

    hide();
    wallNow += 61_000;
    perfNow += 61_000;
    show();

    expect(lockSpy).not.toHaveBeenCalled();
    // 守卫若被删，真实的 lock() 会把错误计数清零——这是守卫本应拦下的真实副作用。
    expect(store.failedAttempts).toBe(3);
  });

  it("双时钟取 max + 实参配对：墙钟回拨不锁、墙钟前跳锁", async () => {
    const { store, lockSpy } = configuredLock();

    // A：墙钟回拨 5 分钟、单调钟正常走 30 秒 → 取 30s，未达 60s 阈值，不锁。
    const a = mountHost();
    await flushPromises();
    hide();
    wallNow -= 300_000;
    perfNow += 30_000;
    show();
    expect(lockSpy).not.toHaveBeenCalled();
    unmountHost(a);

    // 复位时钟与锁定态，让 B 只受自己的序列影响。
    lockSpy.mockClear();
    wallNow = 1_000_000;
    perfNow = 5_000;
    store.isLocked = false;

    // B：墙钟前跳 10 分钟、单调钟只走 1 秒 → 取 600s，达阈值，锁。
    const b = mountHost();
    await flushPromises();
    hide();
    wallNow += 600_000;
    perfNow += 1_000;
    show();
    expect(lockSpy).toHaveBeenCalledTimes(1);
    unmountHost(b);
  });

  it("pagehide + pageshow 配对：不派发 visibilitychange 也会在恢复时判定", async () => {
    const { lockSpy } = configuredLock();
    mountHost();
    await flushPromises();

    window.dispatchEvent(new Event("pagehide"));
    wallNow += 61_000;
    perfNow += 61_000;
    expect(lockSpy).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pageshow"));
    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it("挂载时文档已隐藏：播种 hidden，恢复时仍能判定", async () => {
    const { lockSpy } = configuredLock();
    // 挂载前就处于隐藏态，且不派发任何隐藏事件。
    setVisibility(false);

    mountHost();
    await flushPromises();
    expect(lockSpy).not.toHaveBeenCalled();

    wallNow += 61_000;
    perfNow += 61_000;
    show();

    expect(lockSpy).toHaveBeenCalledTimes(1);
  });

  it("listen 在卸载之后才 resolve：就地退订，不把监听留在窗口上", async () => {
    let resolveListen: ((stop: () => void) => void) | undefined;
    const stop = vi.fn();
    tauriWindow.listen = () =>
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      });

    const wrapper = mountHost();
    await flushPromises();
    expect(tauriWindow.eventNames).toEqual(["tauri://resumed"]);
    expect(resolveListen).toBeDefined();

    unmountHost(wrapper);
    expect(stop).not.toHaveBeenCalled();

    resolveListen?.(stop);
    await flushPromises();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("listen 在挂载期间完成：退订由 onUnmounted 执行", async () => {
    const stop = vi.fn();
    tauriWindow.listen = () => Promise.resolve(stop);

    const wrapper = mountHost();
    await flushPromises();
    expect(stop).not.toHaveBeenCalled();

    unmountHost(wrapper);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
