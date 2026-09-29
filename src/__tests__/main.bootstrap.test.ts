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
  /** AI 意愿层开关的启动读取：次数、是否发生在 mount 之后、是否抛错 */
  aiPrivacyLoads: 0,
  aiPrivacyAfterRender: false,
  aiPrivacyThrows: false,
  /** 跨进程窗口判定的替身取值：true = 本次启动要求解锁 */
  bootLock: true,
  decideThrows: false,
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
      autoLockSeconds: 60,
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

/**
 * 跨进程窗口判定的替身。
 *
 * 为什么必须 mock：真身要读原生写的会话记录，**没有 Tauri 运行时它恒返回 true**
 * （从严兜底）—— 也就是说不 mock 的话"判定说不用锁"这条路径根本无法表达，
 * 而它恰恰是 Bug ① 的修复内容。`main.coldStart.e2e.test.ts` 走的是真身 + 无运行时那条路。
 */
vi.mock("@/services/sessionLock", () => ({
  decideBootLock: async () => {
    state.order.push("decideBootLock");
    if (state.decideThrows) throw new Error("session record unreadable");
    return state.bootLock;
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

/**
 * AI 意愿层开关（§7.3）在冷启动读一次。
 *
 * ⚠️ 这个替身**不往 `state.order` 里推东西**：上面那些 `toEqual` 顺序断言钉的是
 * "门禁 → router → mount"这条主干，AI 这一块是**并列**的第三段（§7.3 与截屏防护同族）。
 * 硬把它插进顺序里会让几条既有断言全部重写，而它们要保护的东西并没有变 ——
 * 这里改用"调用次数 + 调用时是否已经 render"两个哨兵，判别力一样、改动面小得多。
 */
vi.mock("@/stores/aiChat", () => ({
  useAiChatStore: () => ({
    loadPrivacySettings: async () => {
      state.aiPrivacyLoads += 1;
      if (state.order.includes("render")) state.aiPrivacyAfterRender = true;
      if (state.aiPrivacyThrows) throw new Error("read ai privacy failed");
    },
  }),
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
  state.aiPrivacyLoads = 0;
  state.aiPrivacyAfterRender = false;
  state.aiPrivacyThrows = false;
  state.bootLock = true;
  state.decideThrows = false;
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
      "decideBootLock", // 配置了锁就必须先问一次"这一段算不算过过门禁"
      "lock", // 本次启动判定为需要解锁
      "usePrivacyStore",
      "privacy-load", // 截屏防护的取值也要在 mount 之前读好
      "router-install", // 只有锁就位后 router 才会发起初始导航
      "screenshot:true",
      "render", // = app.mount()
    ]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  /**
   * Bug ① 的接线回归保护：改回改造前的 `if (lock.isLockConfigured) lock.lock()` 这条会红。
   *
   * 光有 `shouldLockOnBoot` / `decideBootLock` 的纯函数用例挡不住接线写错：真身在没有 Tauri
   * 运行时恒返回 true，所以"判定为不需要锁"这条路径只有在接线层 mock 掉才验得到。
   */
  it("判定为「本段已经过门禁」⇒ 不调 lock()，但判定仍要发生在 router 之前", async () => {
    state.bootLock = false;

    await startApp();

    expect(state.order).toEqual([
      "useLockStore",
      "load",
      "decideBootLock",
      "usePrivacyStore",
      "privacy-load",
      "router-install",
      "screenshot:true",
      "render",
    ]);
    expect(state.order).not.toContain("lock");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("判定抛错 ⇒ 按从严处理：仍然调 lock()（方向不能跟着外层的兜底反过来）", async () => {
    state.decideThrows = true;

    await startApp();

    expect(state.order).toContain("lock");
    expect(errorSpy).toHaveBeenCalledWith("启动门禁判定失败，按从严处理（要求解锁）", expect.any(Error));
    // 只降级"这次判定"，不能降级整条门禁路径：router 该装还是要装
    expect(state.order).toContain("router-install");
    expect(state.order).toContain("render");
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
      "decideBootLock",
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
      "decideBootLock",
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

  it("AI 意愿层开关在冷启动读**一次**，且在 mount 之前（§7.3 / R71：页面不许再读）", async () => {
    await startApp();

    // 杀手：删掉 `main.ts` 里那段 `await useAiChatStore().loadPrivacySettings()` ⇒ 这条红
    expect(state.aiPrivacyLoads).toBe(1);
    expect(state.aiPrivacyAfterRender).toBe(false);
  });

  it("读 AI 隐私开关失败只降级这一块，不牵连应用锁/截屏防护，也不阻塞 mount", async () => {
    state.aiPrivacyThrows = true;

    await startApp();

    expect(state.order).toContain("render");
    expect(state.order).toContain("screenshot:true");
    expect(errorSpy).toHaveBeenCalledWith("读取 AI 隐私开关失败，按默认值处理", expect.any(Error));
  });
});
