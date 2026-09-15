// src/__tests__/main.coldStart.e2e.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { BCRYPT_HASH, KEY, valid } from "@/services/__tests__/lockStorage.fixtures";

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
  // 直接以业务页 `/accounts` 作为入口：守卫一旦没拦，它就落在真实数据页上。
  window.history.replaceState({}, "", "/accounts");
  for (const name of Object.keys(page.renders)) delete page.renders[name];
  page.order.length = 0;
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
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
