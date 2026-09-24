// src/stores/__tests__/aiChat.probeAuth.test.ts
//
// Bug 1（真机）：冷启动进 AI 页 / 安全页，一直挂着
// 「检测失败：登录状态已过期，请重新登录后再试。」，**必须手点「重新检测」才消失**；
// 而登录态其实是好的 —— 不理它照样能正常发消息。
//
// 机制（四条用例把每一段分别钉住）：
//  1. 自动探针的触发条件是 `baseUrlReady`（`App.vue:62-69`）。而 `auth.restoreOnlineSession`
//     是**先** `api.setBaseUrl()`（`auth.ts:242`）、**后**才 `api.tryRestoreSession()`（`:243`）。
//     地址就绪那一刻 access / refresh token 都还是 null ⇒ 探测带着**空 Authorization** 发出去
//     （`api.ts:211` 只在有 accessToken 时才加头；`:223` 的 refresh 分支还要求 refreshToken 非空）
//     ⇒ 服务端如实回 401 ⇒ `classifyHttp(401)` = `unauthorized`（`transport.ts:252`）。
//  2. `refreshStatus` 把这次 401 记成**永久结论**（`aiChat.ts:1038` 的 `statusFailureKind`），
//     而唯一会改写它的地方就是下一次探测 ⇒ 那条话一直挂着。
//  3. 用户点「重新检测」时 token 早就恢复好了 ⇒ 这次探测正常 ⇒ "点一下就好"。
//  4. 发送路径从来不受影响：`apiFetch` 内建的 refresh 单飞（`api.ts:223-233`）会把 401 换成 200
//     ⇒ "挂着这句话也能正常发消息"。
//
// 与 `bf2ca9d`（T1–T4「探测等**地址**就绪后才发」）的关系：**同一条缺陷换了一个就绪维度**。
// 当时把触发点从 `onMounted` 挪到 `baseUrlReady` 是对的，但"登录态"这个更晚才就绪的前置条件
// 没人管 —— 而 401 在那一刻只说明"我们自己还没带上凭据"，不说明"登录过期了"。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, disposePinia, setActivePinia, type Pinia } from "pinia";

const state = vi.hoisted(() => ({ status: null as unknown }));
const chat = vi.hoisted(() => vi.fn(async () => ({ text: "答", refs: {} })));
const fetchAiStatus = vi.hoisted(() => vi.fn(async () => state.status as unknown));

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
vi.mock("@/services/ai/transport", async (importOriginal) => {
  // 部分 mock：`failureText.ts` 还要从这里取 `describeFailure`（文案的唯一来源）
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, createTransport: () => ({ chat }), fetchAiStatus };
});
const runAgent = vi.hoisted(() =>
  vi.fn(async () => ({ text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false })),
);
vi.mock("@/services/ai/agent", () => ({ runAgent }));

import { clearTokens, setBaseUrl, setTokens } from "@/services/api";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";

const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-03-01T00:00:00.000Z";

let pinia: Pinia | null = null;

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

/** 冷启动那一刻的探测结果：请求没带凭据 ⇒ 401 */
function unauthorized() {
  return { enabled: false, model: null, host: null, failure: { kind: "unauthorized" } };
}

/** 服务端正常表态（token 恢复之后的探测） */
function ok() {
  return { enabled: true, model: "deepseek-chat", host: "ai.example.com" };
}

beforeEach(() => {
  // 上一轮用例留下的 store 里也挂着 `authTokenReady` 的 watch —— 不 dispose 的话，
  // 本轮 `setTokens` 会把它们一起叫醒（多探几次，断言"恰好 2 次"就随用例顺序飘）
  if (pinia !== null) disposePinia(pinia);
  pinia = createPinia();
  setActivePinia(pinia);
  fetchAiStatus.mockClear();
  chat.mockClear();
  runAgent.mockClear();
  state.status = null;
  clearTokens();
  // 地址由 auth 的异步初始化写入（`auth.ts:242`）；本文件关心的是**地址之后的**那一段
  setBaseUrl("http://localhost:8080");
});

describe("冷启动探测的 401（Bug 1）：客户端还没带上凭据时不许说「登录状态已过期」", () => {
  it("① 无凭据的 401 ⇒ 不记成失败结论，文案说「登录状态还没就绪」", async () => {
    state.status = unauthorized();
    const store = useAiChatStore();
    store.sendingEnabled = true;

    await store.refreshStatus();

    // 杀手：去掉"客户端当时没有凭据"这条分支 ⇒ `statusFailureKind` 变成 `unauthorized`、文案变成
    // 「检测失败：登录状态已过期，请重新登录后再试。」（= 真机那句谎话）⇒ 下面四条红
    expect(store.statusFailureKind).toBeNull();
    expect(store.sendingHint).toContain("登录状态还没就绪");
    expect(store.sendingHint).not.toContain("登录状态已过期");
    expect(store.sendingHint).not.toContain("检测失败");
    // 安全页那一行同样中招（`describeHostState`），它也不许说成"检测失败"
    expect(store.hostStateText).not.toContain("检测失败");
    expect(store.hostStateText).toContain("登录状态还没就绪");
  });

  it("② 凭据就绪后**自动**重探一次 ⇒ 那句话自己消失（不用手点「重新检测」）", async () => {
    state.status = unauthorized();
    const store = useAiChatStore();
    store.sendingEnabled = true;
    await store.refreshStatus();
    expect(fetchAiStatus).toHaveBeenCalledTimes(1);

    // 真实链路：`tryRestoreSession` 成功（auth.ts:243 → api.ts:328-331）
    state.status = ok();
    setTokens("u-1", "access-1", "refresh-1");

    // 杀手：去掉 `watch(authTokenReady)` ⇒ 仍然是 1 次、`host` 仍是 null、
    // 提示条一直挂着「登录状态还没就绪」⇒ 这条红
    await vi.waitFor(() => expect(fetchAiStatus).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.host).toBe("ai.example.com"));
    expect(store.sendingHint).not.toContain("登录状态还没就绪");
  });

  it("③ 真有凭据却仍被 401 ⇒ 照旧如实说「登录状态已过期」（不许把合法结论一起删掉）", async () => {
    setTokens("u-1", "access-1", "refresh-1");
    const store = useAiChatStore();
    store.sendingEnabled = true;
    state.status = unauthorized();

    await store.refreshStatus();

    // 杀手：把判据写成"401 一律不记"（不看当时有没有凭据）⇒ 这条红
    expect(store.statusFailureKind).toBe("unauthorized");
    expect(store.sendingHint).toContain("登录状态已过期");
  });

  it("④ 发送成功后不再留着过期的「检测失败」结论（成功发送本身就是链路可用的证据）", async () => {
    setLedger(LEDGER_ID);
    // 凭据在 store 创建**之前**就绪（本次探测确实带着身份发出去）⇒ 这一轮的 network 失败是
    // 服务端/链路给的真结论，文案如实说「检测失败」（对比用例①：没凭据时同一个 401 什么都不记）
    setTokens("u-1", "access-1", "refresh-1");
    state.status = { enabled: false, model: null, host: null, failure: { kind: "network" } };
    const store = useAiChatStore();
    store.sendingEnabled = true;
    await store.refreshStatus();
    expect(store.sendingHint).toContain("检测失败");

    await store.send("这个月花了多少");

    // 杀手：去掉 `appendTurn` 顶部那次清理 ⇒ 这条红（用户看得见的那句话与事实相反）
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(store.statusFailureKind).toBeNull();
    expect(store.sendingHint).not.toContain("检测失败");
  });

  it("⑤ 无凭据 + **网络**失败 ⇒ 照旧如实说「检测失败」：豁免只给 401，别把网络故障说成「去登录」", async () => {
    // 边界（实测踩过）：把"没凭据"当成比 `failureKind` 更优先的分界，会顺手把网络 / 超时 /
    // 429 / 形状坏全都改口成「登录状态还没就绪」—— 那是**另一句**谎话（用户的网断了，
    // 我们却让他去重新登录）。豁免必须只挂在 `unauthorized` 上。
    state.status = { enabled: false, model: null, host: null, failure: { kind: "network" } };
    const store = useAiChatStore();
    store.sendingEnabled = true;

    await store.refreshStatus();

    // 杀手：把 `describeOffHint` / `describeHostState` 里的"没凭据"分支挪到 `failureKind` 之前 ⇒ 红
    expect(store.statusFailureKind).toBe("network");
    expect(store.sendingHint).toContain("检测失败");
    expect(store.sendingHint).not.toContain("登录状态还没就绪");
    expect(store.hostStateText).toContain("检测失败");
  });
});
