import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * `main.ts` 的启动顺序测试。
 *
 * 首帧门禁（门禁早于 `app.use(router)`）与「绝不白屏」（门禁抛错也要 mount）
 * 都只在接线层成立，纯函数测试看不见。这里把 `main.ts` 真正执行一遍：
 * 四个外部依赖换成可观测的替身，用 `order` 记录调用顺序，
 * 用 App 替身是否被渲染来证明 `app.mount()` 真的执行了。
 */
const state = vi.hoisted(() => ({
  order: [] as string[],
  lockStoreThrows: false,
  loadRejects: false,
  screenshotFails: false,
  routerInstallThrows: false,
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

vi.mock("@/stores/lock", () => ({
  useLockStore: () => {
    state.order.push("useLockStore");
    if (state.lockStoreThrows) throw new Error("no active pinia");
    return {
      isLockConfigured: true,
      screenshotProtection: true,
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

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  state.order.length = 0;
  state.lockStoreThrows = false;
  state.loadRejects = false;
  state.screenshotFails = false;
  state.routerInstallThrows = false;
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

    expect(state.order).toEqual(["useLockStore", "router-install", "screenshot:true", "render"]);
  });

  it("R45：app.use(router) 同步抛错也要 mount（它就在两个 try 之间，原先无人保护）", async () => {
    state.routerInstallThrows = true;

    await startApp();

    // 顺序约束没被破坏：门禁先就位，router 才 install。
    expect(state.order).toEqual([
      "useLockStore",
      "load",
      "lock",
      "router-install", // install 抛错，但它已经在顺序里了
      "screenshot:true",
      "render", // = app.mount()：router 装不上也照样挂载
    ]);
    expect(errorSpy).toHaveBeenCalledWith("路由注册失败，继续挂载", expect.any(Error));
  });

  it("截屏防护失败不阻塞 mount", async () => {
    state.screenshotFails = true;

    await startApp();

    expect(warnSpy).toHaveBeenCalledWith("应用截屏防护启用失败", expect.any(Error));
    expect(state.order).toContain("render");
  });
});
