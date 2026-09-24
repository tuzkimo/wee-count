// src/stores/__tests__/aiChat.probeAuthOrder.test.ts
//
// Bug 1 的**确证**（不是复述代码）：用**真的** `api.ts` + **真的** `transport.ts`，只把
// `fetch` 换成替身，把冷启动那一刻的时序原样跑一遍 —— 证明"那次 401 是探测跑在令牌就绪之前"。
//
// 与 `aiChat.probeAuth.test.ts` 的分工：那边是**单元**证据（`fetchAiStatus` 被替身控制，
// 直接喂 401）；这里不替身任何传输层，让 `App.vue` 那一次自动探测真的发出去，因此能回答
// "到底带没带 Authorization" —— 也就是"401 从哪来"这个问题的唯一硬证据。
//
// 时序（逐字对应真机代码）：
//   `stores/auth.ts:242`  `api.setBaseUrl(url)`      ← 同步，`baseUrlReady` 立刻变 true
//   `App.vue:62-69`       watch(baseUrlReady) 的立即回调 ⇒ `ai.refreshStatus()` 发 /ai/status
//   `stores/auth.ts:243`  `await api.tryRestoreSession(...)` ← 异步，**之后**才有 token
//
// 断言三件事：
//   ① 第一次探测的请求**没有** Authorization 头（401 的来源，实锤）；
//   ② 凭据恢复完成后**自动**补探一次，这次带着 `Bearer`，拿到 200；
//   ③ 全程没有任何一刻渲染出「登录状态已过期」/「检测失败」——包括恢复完成前的中间态。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/services/settingsFile", () => ({
  readSetting: vi.fn(async () => ({ kind: "absent" })),
  writeSetting: vi.fn(async () => {}),
}));
vi.mock("@/db/userDb", () => ({
  getUserDb: () => null,
  getCurrentUserId: () => "local-1",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async () => null,
}));
// ⚠️ 刻意**不** mock `@/services/ai/transport`（也不 mock `@/services/api`）：本文件的全部
// 价值就在于跑真实传输层。"401 从哪来"只有真发一次请求才能回答。
vi.mock("@/services/ai/agent", () => ({
  runAgent: vi.fn(async () => ({ text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false })),
}));

import { clearTokens, setBaseUrl, tryRestoreSession, authTokenReady } from "@/services/api";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";

const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-03-01T00:00:00.000Z";

let pinia: Pinia | null = null;
let realFetch: typeof globalThis.fetch | null = null;

/** 替身 Response：`apiFetch` 只用到 `.ok` / `.status` / `.json()` */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function setLedger(id: string): void {
  const ledgerStore = useLedgerStore();
  ledgerStore.ledgers = [
    {
      id,
      name: "家",
      type: "personal",
      team_id: null,
      owner_id: "local-1",
      created_at: T0,
      updated_at: T0,
      is_deleted: false,
    },
  ];
  ledgerStore.currentLedgerId = id;
}

beforeEach(() => {
  if (pinia !== null) disposePinia(pinia);
  pinia = createPinia();
  setActivePinia(pinia);
  clearTokens();
  localStorage.clear();
  realFetch = globalThis.fetch;
});

afterEach(() => {
  if (realFetch !== null) globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("确证：冷启动那次 401 = 探测跑在令牌就绪之前", () => {
  it("地址就绪时发出的探测**不带** Authorization；凭据一到就自动补探、并收敛成已知状态", async () => {
    setLedger(LEDGER_ID);
    // 冷启动：磁盘里有 refresh_token（上次登录留下的），但**内存里还没有任何凭据**
    localStorage.setItem("refresh_token:u-1", "refresh-0");
    expect(authTokenReady.value).toBe(false);

    const statusCalls: { auth: string | null }[] = [];
    // `/auth/refresh` 卡在闸门上：让"探测先回来"这件事**确定**发生，而不是靠调度巧合
    let openRefresh: () => void = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      openRefresh = resolve;
    });

    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (url.includes("/auth/refresh")) {
          await refreshGate;
          return jsonResponse(200, {
            user: {
              id: "u-1",
              username: "me",
              nickname: "我",
              avatar_url: null,
              created_at: T0,
              updated_at: T0,
            },
            access_token: "access-1",
            refresh_token: "refresh-1",
            ledger_id: LEDGER_ID,
          });
        }
        const auth = headers["Authorization"] ?? null;
        statusCalls.push({ auth });
        // 服务端的行为：没有身份 ⇒ 401（**这正是真机上那个 401**）
        return auth === null
          ? jsonResponse(401, { error: "invalid or expired token" })
          : jsonResponse(200, { enabled: true, model: "deepseek-chat", host: "ai.example.com" });
      },
    );

    const store = useAiChatStore();
    store.sendingEnabled = true;

    // —— 真机那一刻 ——
    setBaseUrl("http://localhost:8080"); // auth.ts:242（同步）
    const probe = store.refreshStatus(); // App.vue 的 watch(baseUrlReady) 回调
    const restore = tryRestoreSession("u-1"); // auth.ts:243（异步，之后才有 token）

    await probe;
    // ① 实锤：这次探测请求里**根本没有** Authorization 头
    expect(statusCalls).toHaveLength(1);
    expect(statusCalls[0].auth).toBeNull();
    // ③ 中间态：不能把"我还没带上凭据"说成"检测失败：登录状态已过期"
    expect(store.sendingHint).not.toContain("检测失败");
    expect(store.sendingHint).not.toContain("登录状态已过期");
    expect(store.hostStateText).not.toContain("检测失败");
    expect(store.hostStateText).not.toContain("登录状态已过期");
    // 而且这条 401 **不许**留下失败结论（否则就是真机上那句一直挂着的话）
    expect(store.statusFailureKind).toBeNull();

    // —— 令牌恢复完成 ——
    openRefresh();
    await restore;
    expect(authTokenReady.value).toBe(true);

    // ② 自动补探：不用用户点「重新检测」
    await vi.waitFor(() => expect(statusCalls).toHaveLength(2));
    expect(statusCalls[1].auth).toBe("Bearer access-1");

    // 收敛成已知状态，且全程没出现过那句假话。
    // ⚠️ 补探是 `void refreshStatus()`（fire-and-forget）：请求进 stub 后还要几个微任务才写回
    // store ⇒ 这里必须等**状态**，不能只等"请求发出去了"（`statusCalls` 会先到）。
    await vi.waitFor(() => expect(store.host).toBe("ai.example.com"));
    expect(store.statusFailureKind).toBeNull();
    // 隐私区那一行（C3）此时说的是真域名 —— 它就是安全页「允许发送给 AI 助手」那行的状态说明
    expect(store.hostStateText).toContain("ai.example.com");
    // AI 页提示条（C5）不再挂着失败结论（它的职责是"为什么发不出去"，本来就不含域名）
    expect(store.sendingHint).not.toContain("检测失败");
    expect(store.sendingHint).not.toContain("登录状态已过期");
  });

  it("反证：凭据**已经**就绪时的一次 401 仍然如实说「登录状态已过期」（别把合法结论一起删掉）", async () => {
    setLedger(LEDGER_ID);
    globalThis.fetch = vi.fn(
      async (): Promise<Response> => jsonResponse(401, { error: "invalid or expired token" }),
    );

    setBaseUrl("http://localhost:8080");
    // 先造出"已就绪"的凭据（走真实 setTokens，不加 mock）
    localStorage.setItem("refresh_token:u-1", "refresh-0");
    const restore = await tryRestoreSession("u-1").catch(() => null);
    expect(restore).toBeNull(); // refresh 也被 401 挡了 ⇒ 本次没能就绪
    const { setTokens: realSetTokens } = await import("@/services/api");
    realSetTokens("u-1", "access-x", "refresh-x");
    expect(authTokenReady.value).toBe(true);

    const store = useAiChatStore();
    store.sendingEnabled = true;
    await store.refreshStatus();

    expect(store.statusFailureKind).toBe("unauthorized");
    expect(store.sendingHint).toContain("登录状态已过期");
  });
});
