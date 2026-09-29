// src/__tests__/main.coldStart.e2e.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  BCRYPT_HASH,
  KEY,
  enterTauri,
  exitTauri,
  valid,
} from "@/services/__tests__/lockStorage.fixtures";

/**
 * 冷启动门禁的**端到端**测试：真实 router + 真实 lock store + 真实 `main.ts` 引导路径。
 *
 * 与 `main.bootstrap.test.ts` 的分工。那条测试把 `@/router` 整体换成「只有 install」
 * 的替身，只钉住调用的先后顺序；替身的 install 根本不会发起导航，所以它**从来没有
 * 真的跑过一次初始导航**。谁把顺序改错、而替身恰好不触发导航，那条测试照样绿。
 *
 * 这里不 mock router：`app.use(router)` 真的发起初始导航，真实守卫真的读 lock store。
 * 断言因此落在**可观测的结果**上：
 * 1. 首帧最终落在哪个路由（`window.location.pathname`，真 router 的真 history 写的）；
 * 2. 业务页组件（有真实数据的那几屏）**有没有被渲染过**——只断言「lock.lock() 被调用过」
 *    不算，那正是既有 mock 测试已经做到的事。
 *
 * 「已配置锁」是**真构造**的：用 `lockStorage.fixtures` 里的真 bcrypt 哈希落盘到真实
 * 的 lockStorage（非 Tauri 环境 = localStorage），`main.ts` 里的 `await lock.load()`
 * 会经真实 `readAppLock()`→`parseAppLock()` 把它读回来。没有伪造任何 getter。
 *
 * 文件里有两段，差别只在**「已配置锁」与「上一次会话怎么结束的」从哪来**：
 * - 冷启动基线（前两条用例）：不在 Tauri 内 ⇒ 锁配置走真实 lockStorage 的 localStorage 分支；
 * - 跨进程窗口的启动门禁（后六条用例）：`enterTauri()` + 假 `@tauri-apps/plugin-store`
 *   （锁配置从 settings.json 读出来）+ 假 `@tauri-apps/plugin-fs`（原生写的 `session.json`
 *   与前端写的 `authenticated` 标记）。这一段才看得见 `decideBootLock()` 的真实判定在接线层
 *   的结果 —— `main.bootstrap.test.ts` 把 `@/services/sessionLock` 整体换成替身，判定恒为
 *   替身给的布尔值，看不见「窗口内 / 超窗 / 本段没解锁过」这些分叉。
 */
const page = vi.hoisted(() => {
  /** 每个页面组件被渲染的累计次数：0 次 = 从未挂载。 */
  const renders: Record<string, number> = {};
  /** 渲染顺序，便于在失败信息里指出「首帧落到了哪一页」。 */
  const order: string[] = [];
  function make(name: string): { name: string; render: () => null } {
    return {
      name,
      render() {
        renders[name] = (renders[name] ?? 0) + 1;
        order.push(name);
        return null;
      },
    };
  }
  return { renders, order, make };
});

/**
 * 守卫里真实存在的异步工作。`getLocalUsers()` 在真机上要开 SQLite 库，
 * 这里用一段真实计时器延迟建模这段延迟——否则整条初始导航会缩成纯微任务，
 * 反而**掩盖**了「锁没就位就放行业务页」这个窗口（微任务里 Vue 来不及渲染出页面）。
 */
const dbLatencyMs = vi.hoisted(() => ({ value: 10 }));

vi.mock("@/views/UnlockPage.vue", () => ({ default: page.make("UnlockPage") }));
vi.mock("@/views/AccountList.vue", () => ({ default: page.make("AccountList") }));
vi.mock("@/views/TransactionList.vue", () => ({ default: page.make("TransactionList") }));
vi.mock("@/views/RecordPage.vue", () => ({ default: page.make("RecordPage") }));
vi.mock("@/views/ReportsPage.vue", () => ({ default: page.make("ReportsPage") }));
vi.mock("@/views/MePage.vue", () => ({ default: page.make("MePage") }));
vi.mock("@/views/WelcomePage.vue", () => ({ default: page.make("WelcomePage") }));
vi.mock("@/views/LoginPage.vue", () => ({ default: page.make("LoginPage") }));

// 真实 `@/db/meta` 会去开 sqlite:_meta.db（真机行为、单测环境无 Tauri IPC）。
// 只替掉取数，守卫的判定逻辑仍是真实的。
vi.mock("@/db/meta", () => ({
  getLocalUsers: async () => {
    await new Promise((resolve) => setTimeout(resolve, dbLatencyMs.value));
    return [
      {
        id: "u1",
        username: "alice",
        nickname: "Alice",
        // 与「已配置锁」用例共用同一份真 bcrypt 哈希，不另抄一份字面量。
        password_hash: BCRYPT_HASH,
        api_url: null,
        server_user_id: null,
        avatar_url: null,
        created_at: "2026-09-01T00:00:00Z",
        updated_at: "2026-09-01T00:00:00Z",
      },
    ];
  },
  getLocalUser: async () => null,
  getLocalUserByUsername: async () => null,
}));

// 单测环境没有 Tauri IPC，开用户库必然 reject；守卫的「自动恢复会话」分支在这里
// 是空操作，替掉它以免把一次 unhandled rejection 混进断言。
vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => null,
  getUserDb: () => null,
  openUserDb: async () => null,
  closeUserDb: () => {},
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ isAuthenticated: true, isOnline: false, init: async () => {} }),
}));

/**
 * `cacheDir/wee-session/` 的替身（`@tauri-apps/plugin-fs`）。
 *
 * 这一层**必须是假的**：两个文件真身在 Android 的 cacheDir 里，单测环境连 Tauri IPC 都没有，
 * 而不 mock 的话 `sessionLock.ts` 的环境探测会直接短路成「没有记录 ⇒ 恒上锁」，
 * 「窗口内的后台返回不锁」这条路径根本无法表达 —— 它恰恰是 Bug ① 的修复内容。
 *
 * 做成一个按路径存原文的**内存盘**（而不是把两个文件的返回值写死）：前端在放行时会
 * `writeTextFile` 记下 `authenticated` 标记，用例要能看见它真的落了盘。
 *
 * ⚠️ 「文件不存在」必须**抛错**，不能返回空内容：`sessionLock` 与 `useShareIntake` 都是靠
 * 捕获 `os error 2` 认出"这个文件不在"的。返回 `undefined` 会被当成"读到了空文件"，
 * 一路走到"形状不认"的处理分支（share intake 那条路会顺手把路由推去 /ai）。
 */
const fakeFs = vi.hoisted(() => {
  /** 路径 → 原文。用例预置原生写的 session.json，前端自己写 authenticated。 */
  const files = new Map<string, string>();
  /** 替身的真实行为。`vi.fn` 的初始实现与每个用例前的重装都用这一份，不抄第二遍。 */
  const behavior = {
    readTextFile: async (path: string): Promise<string> => {
      const content = files.get(path);
      // plugin-fs 对「文件不存在」抛出的**真实**形态（Rust `io::Error` 的 Display）
      if (content === undefined) throw new Error("No such file or directory (os error 2)");
      return content;
    },
    writeTextFile: async (path: string, content: string): Promise<void> => {
      files.set(path, content);
    },
    readFile: async (): Promise<Uint8Array> => new Uint8Array(),
    remove: async (path: string): Promise<void> => {
      files.delete(path);
    },
    mkdir: async (): Promise<void> => undefined,
  };
  return {
    files,
    behavior,
    readTextFile: vi.fn(behavior.readTextFile),
    writeTextFile: vi.fn(behavior.writeTextFile),
    readFile: vi.fn(behavior.readFile),
    remove: vi.fn(behavior.remove),
    mkdir: vi.fn(behavior.mkdir),
  };
});

vi.mock("@tauri-apps/plugin-fs", () => ({
  // AppCache 的真实值是 16（与 `sessionLock.test.ts` 同款理由：baseDir 写错时用例必须红）
  BaseDirectory: { AppCache: 16 },
  readTextFile: fakeFs.readTextFile,
  writeTextFile: fakeFs.writeTextFile,
  readFile: fakeFs.readFile,
  remove: fakeFs.remove,
  mkdir: fakeFs.mkdir,
}));

/**
 * `settings.json` 的替身（`@tauri-apps/plugin-store` 的 `load`）。
 *
 * 为什么不直接 mock `@/services/lockStorage` 的读函数：`enterTauri()` 之后 `settingsFile`
 * 会走 plugin-store 那条分支，"锁配置到底读没读出来"本身就是启动门禁的一环（读不出来 ⇒
 * `isLockConfigured` 为假 ⇒ `decideBootLock` 根本不会被调用，用例会以一种与判定无关的方式
 * 变红）。这里只换掉 IPC 那一层，`readAppLock()` → `parseAppLock()` → `lock.load()` 全是真身。
 */
const fakeStore = vi.hoisted(() => {
  /** settings.json 的键 → 值。用例预置锁配置，读路径的形状与真机一致。 */
  const values = new Map<string, unknown>();
  const store = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    save: async () => undefined,
  };
  return { values, store, load: vi.fn(async (_path: string, _options?: unknown) => store) };
});

vi.mock("@tauri-apps/plugin-store", () => ({ load: fakeStore.load }));

/**
 * 重装假插件的方法。
 *
 * **每个用例前都要重装**：`afterEach` 的 `vi.restoreAllMocks()` 会把 `vi.fn()` 的实现清回
 * 初始值，而没有实现的替身返回 `undefined` —— 那比抛错危险得多（见 `fakeFs` 的说明）。
 * 初始实现也一并给上，是为了让"忘了重装"这件事不改变行为。
 */
function armFakeEnv(): void {
  fakeFs.readTextFile.mockImplementation(fakeFs.behavior.readTextFile);
  fakeFs.writeTextFile.mockImplementation(fakeFs.behavior.writeTextFile);
  fakeFs.readFile.mockImplementation(fakeFs.behavior.readFile);
  fakeFs.remove.mockImplementation(fakeFs.behavior.remove);
  fakeFs.mkdir.mockImplementation(fakeFs.behavior.mkdir);
  fakeStore.load.mockResolvedValue(fakeStore.store);
}

/** 业务页：冷启动首帧绝不允许渲染的页面（就是有真实数据的那几屏）。 */
const BUSINESS_PAGES = ["AccountList", "TransactionList", "RecordPage", "ReportsPage", "MePage"];

/** 判定「业务页是否被渲染过」。分开写是为了让失败信息直接说出是哪一页。 */
function expectNoBusinessPageRendered(): void {
  const rendered = BUSINESS_PAGES.filter((name) => (page.renders[name] ?? 0) > 0);
  expect(
    rendered,
    `首帧渲染了业务页 ${rendered.join(", ")}（渲染顺序：${page.order.join(" → ") || "空"}）`,
  ).toEqual([]);
}

beforeEach(() => {
  localStorage.clear();
  // 假盘与假 settings.json 也每例清空：两段用例（Tauri / 非 Tauri）共用同一份替身，
  // 谁先跑都不能看见别人留下的文件与配置。
  fakeFs.files.clear();
  fakeStore.values.clear();
  armFakeEnv();
  // 直接以业务页 `/accounts` 作为入口：守卫一旦没拦，它就落在真实数据页上。
  window.history.replaceState({}, "", "/accounts");
  for (const name of Object.keys(page.renders)) delete page.renders[name];
  page.order.length = 0;
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  // 环境标记按用例回收：哪一条用例先跑都不能影响另一段（Tauri 段 / 非 Tauri 段）。
  exitTauri();
  vi.restoreAllMocks();
});

/** 跑一次真实引导：`main.ts` 的 bootstrap 是模块级副作用，重置模块后动态 import 即执行。 */
async function coldStart(): Promise<void> {
  vi.resetModules();
  await import("@/main");
  // 等「首帧渲染出一页」为止。轮询而不是定时等待：初始导航本身是异步的（守卫里有真实
  // 异步工作），固定睡眠既可能不够（假红），也可能掩盖「渲染了又立刻被替换」的窗口。
  // 这里**不**等某个特定页面 —— 等到哪一页是断言的事，等到不存在的页面只会让失败信息
  // 变成一句没有信息量的超时。
  await vi.waitFor(() => expect(page.order.length).toBeGreaterThan(0), { timeout: 2000 });
}

describe("冷启动端到端（真实 router + 真实 lock store）", () => {
  it("已配置锁：初始导航落到 /unlock，业务页从未渲染（R41）", async () => {
    localStorage.setItem(KEY, JSON.stringify(valid));

    await coldStart();

    // 承重断言：业务页一次都没被渲染。
    expectNoBusinessPageRendered();
    // 首帧渲染的就是解锁页。
    expect(page.renders.UnlockPage ?? 0).toBeGreaterThan(0);
    // 首帧的落点：真 router 的真 history 写在 URL 上。
    expect(window.location.pathname).toBe("/unlock");
  });

  it("未配置锁：不强制解锁，照常落到业务页（门禁不能把没设锁的用户关在门外）", async () => {
    // 反向对照：证明上一条的 `/unlock` 来自「已配置锁」，而不是路由表本身的行为。
    await coldStart();

    expect(page.renders.AccountList ?? 0).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/accounts");
  });
});

/**
 * 跨进程自动锁窗口在**接线层**的效果：真 `main.ts` + 真 `decideBootLock()` + 真 router。
 *
 * 挡的是哪一类事故：`decideBootLock()` 的判据本身有取值层用例（`sessionLock.test.ts`），
 * 但「它的返回值有没有真的决定首帧落点」只有端到端看得见。历史上真机 Bug ① 就是
 * `main.ts` 无条件 `lock.lock()`：切走 20 秒回来（进程被杀 / Activity 重建 / WebView 重载）
 * 照样要求解锁。这里每条用例都能说清"哪一行接线被改坏时它会红"。
 */
describe("跨进程自动锁窗口的启动门禁（Tauri 内：settings.json + 原生写的会话记录）", () => {
  /** 与 `sessionLock.ts` / `MainActivity.kt` 逐字一致的两个路径。 */
  const RECORD_PATH = "wee-session/session.json";
  const MARK_PATH = "wee-session/authenticated";

  /**
   * 原生 `writeSessionEnd` 拼出来的原文。字段形状取自 `sessionLock.test.ts` 的取值层用例
   * （那里有从 Kotlin 字符串模板逐字抄下来的跨语言契约）。
   */
  function sessionRecord(
    at: number,
    reason: "background" | "user_closed",
    authenticated: boolean,
  ): string {
    return JSON.stringify({ v: 1, at, reason, taskId: 7, authenticated });
  }

  beforeEach(() => {
    // 只负责切到 Tauri 内并预置「已配置锁」：假盘的清空与重装在文件级 beforeEach 里
    // （两段用例共用同一份替身，那一处才是唯一的入口）。
    enterTauri();

    // 真键名、真形状、真 `auto_lock_seconds`（`valid` 里是 60 秒，
    // 下面几条用例的 20 秒 / 90 秒就是相对这个窗口的）。
    fakeStore.values.set(KEY, valid);
  });

  it("① 窗口内的后台返回 ⇒ 不锁：首帧不落 /unlock、解锁页 0 次、业务页照常渲染（真机 Bug ① 的修复）", async () => {
    // 上一段是「切到后台」，离开那一刻本段已过门禁，离现在只有 20 秒 < 60 秒
    fakeFs.files.set(RECORD_PATH, sessionRecord(Date.now() - 20_000, "background", true));

    await coldStart();

    // 承重断言：没被踢回解锁页。把 `main.ts` 改回无条件 `lock.lock()` ⇒ 这里红。
    expect(window.location.pathname).toBe("/accounts");
    expect(page.renders.UnlockPage ?? 0).toBe(0);
    // 且真的进了业务页 —— 否则「锁没生效」与「哪一页都没渲染」会混成同一个绿。
    expect(page.renders.AccountList ?? 0).toBeGreaterThan(0);
    // 放行时顺手把本段记成「已过门禁」：少这一笔，紧接着的一次页面重载会再判一次窗口，
    // 而那时这份记录早已超窗 ⇒ 正在用 App 的人被要求解锁。
    await vi.waitFor(() => expect(fakeFs.files.has(MARK_PATH)).toBe(true));
  });

  it("② 本段从没解锁过 ⇒ 锁：即使窗口内也必须落 /unlock（不许靠「停在解锁页」免口令进来）", async () => {
    // 「停在解锁页没输口令 → 切后台 → 进程被杀 → 一分钟内回来」：时间窗口内，但本段没解锁过
    fakeFs.files.set(RECORD_PATH, sessionRecord(Date.now() - 20_000, "background", false));

    await coldStart();

    expect(window.location.pathname).toBe("/unlock");
    expect(page.renders.UnlockPage ?? 0).toBeGreaterThan(0);
    // 删掉 `shouldLockOnBoot` 里 `if (!record.authenticated) return true` 那一行 ⇒ 这条红
    expectNoBusinessPageRendered();
  });

  it("③ 用户自己关的 ⇒ 锁：哪怕刚关掉 1 秒（「划掉后台必须解锁」是硬要求）", async () => {
    fakeFs.files.set(RECORD_PATH, sessionRecord(Date.now() - 1_000, "user_closed", false));

    await coldStart();

    // 把 `shouldLockOnBoot` 里 `reason === "user_closed"` 那条判据删掉（只留时间窗口）⇒ 这条红
    expect(window.location.pathname).toBe("/unlock");
    expect(page.renders.UnlockPage ?? 0).toBeGreaterThan(0);
    expectNoBusinessPageRendered();
  });

  it("④ 超窗的后台返回 ⇒ 锁：离开 90 秒 > 配置的 60 秒窗口", async () => {
    fakeFs.files.set(RECORD_PATH, sessionRecord(Date.now() - 90_000, "background", true));

    await coldStart();

    // 把窗口判据换成「只要 reason 是 background 就放行」⇒ 这条红
    expect(window.location.pathname).toBe("/unlock");
    expect(page.renders.UnlockPage ?? 0).toBeGreaterThan(0);
    expectNoBusinessPageRendered();
  });

  it("⑤ 标记晚于记录 ⇒ 不锁：同一次前台期内的页面重载不再判一次窗口", async () => {
    // 记录是超窗的后台离场，本段也没解锁过，但盘上有一个**比它新**的标记 ——
    // 那是本段解锁过（或启动判定本就不需要锁）的直接证据：dev HMR / 渲染进程崩溃后的重载
    // 不该把正在用 App 的人再踢回解锁页。
    fakeFs.files.set(RECORD_PATH, sessionRecord(Date.now() - 90_000, "background", false));
    fakeFs.files.set(MARK_PATH, String(Date.now()));

    await coldStart();

    // 删掉 `decideBootLock` 里 `markAt > record.at` 这一整条 ⇒ 这条红
    expect(window.location.pathname).toBe("/accounts");
    expect(page.renders.UnlockPage ?? 0).toBe(0);
    expect(page.renders.AccountList ?? 0).toBeGreaterThan(0);
  });

  it("⑥ 标记早于记录 ⇒ 锁：那是上一段残留的标记，不能当永久通行证", async () => {
    // 「只看标记存不存在」就会放行 —— 而 `unlock()` 是异步写盘，完全可能落在原生删标记之后
    // 留下一个残留标记。判据必须是**时间戳比记录新**。
    fakeFs.files.set(RECORD_PATH, sessionRecord(Date.now() - 90_000, "background", true));
    fakeFs.files.set(MARK_PATH, String(Date.now() - 120_000));

    await coldStart();

    // 把 `markAt > record.at` 改成「标记存在即放行」（`markAt !== null`）⇒ 这条红
    expect(window.location.pathname).toBe("/unlock");
    expect(page.renders.UnlockPage ?? 0).toBeGreaterThan(0);
    expectNoBusinessPageRendered();
  });
});
