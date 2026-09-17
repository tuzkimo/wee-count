import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * `main.ts` 的启动顺序测试。
 *
 * 首帧门禁（门禁早于 `app.use(router)`）与「绝不白屏」（门禁抛错也要 mount）
 * 都只在接线层成立，纯函数测试看不见。这里把 `main.ts` 真正执行一遍：
 * 外部依赖换成可观测的替身，用 `order` 记录调用顺序，
 * 用 App 替身是否被渲染来证明 `app.mount()` 真的执行了。
 */
const state = vi.hoisted(() => ({
  order: [] as string[],
  lockStoreThrows: false,
  loadRejects: false,
  privacyStoreThrows: false,
  privacyLoadRejects: false,
  privacyValue: true,
  screenshotFails: false,
  routerInstallThrows: false,
  /** `SCREENSHOT_PROTECTION_DEFAULT` 的替身取值。 */
  defaultScreenshot: true,
}));

vi.mock("@/App.vue", () => ({
  // 函数式组件：被渲染即说明 app.mount() 走到了渲染阶段。
  default: () => {
    state.order.push("render");
    return null;
  },
}));

vi.mock("@/router", () => ({
  default: {
    install: () => {
      state.order.push("router-install");
      if (state.routerInstallThrows) throw new Error("router install failed");
    },
  },
}));

vi.mock("@/services/screenshotProtection", () => ({
  applyScreenshotProtection: async (enabled: boolean) => {
    state.order.push(`screenshot:${enabled}`);
    if (state.screenshotFails) throw new Error("screenshot unavailable");
  },
}));

vi.mock("@/services/privacySettings", () => ({
  // 取值走 getter：用例可以把它改成一个与字面量 `true` 不同的值，用来证明 main.ts
  // 读的是这个共用常量，而不是自己抄的一份字面量。
  get SCREENSHOT_PROTECTION_DEFAULT() {
    return state.defaultScreenshot;
  },
}));

vi.mock("@/stores/lock", () => ({
  useLockStore: () => {
    state.order.push("useLockStore");
    if (state.lockStoreThrows) throw new Error("no active pinia");
    return {
      isLockConfigured: true,
      load: async () => {
        state.order.push("load");
        if (state.loadRejects) throw new Error("readAppLock failed");
      },
      lock: () => {
        state.order.push("lock");
      },
    };
  },
}));

vi.mock("@/stores/privacy", () => ({
  usePrivacyStore: () => {
    state.order.push("usePrivacyStore");
    if (state.privacyStoreThrows) throw new Error("no active pinia");
    return {
      get screenshotProtection() {
        return state.privacyValue;
      },
      load: async () => {
        state.order.push("privacy-load");
        if (state.privacyLoadRejects) throw new Error("readScreenshotProtection failed");
      },
    };
  },
}));

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.order.length = 0;
  state.lockStoreThrows = false;
  state.loadRejects = false;
  state.privacyStoreThrows = false;
  state.privacyLoadRejects = false;
  state.privacyValue = true;
  state.screenshotFails = false;
  state.routerInstallThrows = false;
  state.defaultScreenshot = true;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 重新执行一次 `main.ts`，等到 App 被渲染（= mount 已发生）为止。 */
async function startApp(): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  await import("@/main");
  await vi.waitFor(() => expect(state.order).toContain("render"));
}

describe("main.ts 启动顺序", () => {
  it("门禁先于 app.use(router)，mount 最后执行", async () => {
    await startApp();

    expect(state.order).toEqual([
      "useLockStore",
      "load",
      "lock", // 冷启动总是要求解锁
      "usePrivacyStore",
      "privacy-load", // 截屏防护的取值也要在 mount 之前读好
      "router-install", // 只有锁就位后 router 才会发起初始导航
      "screenshot:true",
      "render", // = app.mount()
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("load() 抛错也要 mount（Android 白屏防线）", async () => {
    state.loadRejects = true;

    await startApp();

    expect(state.order).toContain("router-install");
    expect(errorSpy).toHaveBeenCalledWith("启动门禁失败，降级为不锁启动", expect.any(Error));
  });

  it("useLockStore() 抛错也要 mount（R42：它必须在 try 之内）", async () => {
    state.lockStoreThrows = true;

    await startApp();

    expect(state.order).not.toContain("load");
    expect(state.order).toContain("router-install");
    // 「也要 mount」必须真的验到：只断言 router 装过是不够的（mount 才是白屏防线）。
    expect(state.order).toContain("render");
    expect(errorSpy).toHaveBeenCalledWith("启动门禁失败，降级为不锁启动", expect.any(Error));
  });

  it("R45：try 块里同步抛错也绝不跳过 mount", async () => {
    // 与上一条不同的路径：这次是 `useLockStore()` 在 try 的第一条语句上同步抛错，
    // 门禁整体降级，而 mount 仍必须发生。
    state.lockStoreThrows = true;

    await startApp();

    expect(state.order).toEqual([
      "useLockStore",
      "usePrivacyStore", // 门禁降级不影响隐私设置照常读取
      "privacy-load",
      "router-install",
      "screenshot:true",
      "render",
    ]);
  });

  it("R45：app.use(router) 同步抛错也要 mount（它就在两个 try 之间，原先无人保护）", async () => {
    state.routerInstallThrows = true;

    await startApp();

    // 顺序约束没被破坏：门禁先就位，router 才 install。
    expect(state.order).toEqual([
      "useLockStore",
      "load",
      "lock",
      "usePrivacyStore",
      "privacy-load",
      "router-install", // install 抛错，但它已经在顺序里了
      "screenshot:true",
      "render", // = app.mount()：router 装不上也照样挂载
    ]);
    expect(errorSpy).toHaveBeenCalledWith("路由注册失败，继续挂载", expect.any(Error));
  });

  it("隐私设置读到的值就是下发给系统层的值（不是只认默认值）", async () => {
    state.privacyValue = false;

    await startApp();

    expect(state.order).toContain("screenshot:false");
  });

  it("读隐私设置失败只降级截屏防护，不牵连应用锁，也不阻塞 mount", async () => {
    state.privacyLoadRejects = true;

    await startApp();

    // 门禁照常完成：两个 try 分开正是为了这个。
    expect(state.order).toEqual([
      "useLockStore",
      "load",
      "lock",
      "usePrivacyStore",
      "privacy-load",
      "router-install",
      "screenshot:true", // 读不到就按从严默认值下发
      "render",
    ]);
    expect(errorSpy).toHaveBeenCalledWith("读取隐私设置失败，按默认值处理", expect.any(Error));
  });

  it("截屏防护失败不阻塞 mount", async () => {
    state.screenshotFails = true;

    await startApp();

    expect(warnSpy).toHaveBeenCalledWith("应用截屏防护启用失败", expect.any(Error));
    expect(state.order).toContain("render");
  });

  it("读隐私设置失败时的截屏防护默认值来自 SCREENSHOT_PROTECTION_DEFAULT，不是另抄的字面量", async () => {
    // 把共用常量换成与字面量 `true` 不同的值：main.ts 若仍写死 `true`，这里必失败。
    state.defaultScreenshot = false;
    state.privacyStoreThrows = true;

    await startApp();

    expect(state.order).toContain("screenshot:false");
  });
});
