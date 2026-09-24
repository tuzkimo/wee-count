// src/views/__tests__/AiChatPage.test.ts
//
// AI 聊天页（计划任务 6 步骤 4 + 本片派单的接线要点）。
//
// 这一层**必须是端到端的**：`aiChat` store 是真的、`session.ts` 是真的、底下挂真
// `node:sqlite` + 真实 `initUserTables`（照 `aiChat.test.ts` 的约定：只 mock `@/db/userDb`
// 的入口，**绝不 mock `plugin-sql`**）。要钉的三件事都只有在真链路上才成立：
//  1. 页面**自己**拉账户/分类/标签三张名表 ⇒ 快照里才有名字（不然快照空、lookup 却有数据）；
//  2. 草稿按 `draftId` 加 `:key`，且确认时收起的是**这张卡自己的**草稿（不是"当前第一张"）；
//  3. 空账本首次发送后 `conversationId` 仍是 `null`（R4 懒建会话），消息**照样**渲染。
//
// 只换四个入口：`runAgent`（编排循环有自己的用例）、`fetchAiStatus`（能力探测有自己的用例）、
// `transactionStore`（草稿卡的记账动作有自己的用例）、`@/db/userDb` 的三个函数。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { createRouter, createMemoryHistory } from "vue-router";
import { DatabaseSync } from "node:sqlite";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => state.db as never,
    getCurrentUserId: () => "local-1",
    getTeamMembers: vi.fn(async () => [] as never),
  };
});

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return {
    ...actual,
    fetchAiStatus: vi.fn(async () => ({ enabled: true, model: "m", host: "h" })),
  };
});

/**
 * 草稿卡的记账动作：本文件只关心"页面在什么时候把草稿收起 / 换态"，不关心记账本身。
 * `add` 返回一个**真 UUID 形状**的 id（撤销要用它；短串会让"猜一个 id"的断言失去判别力）。
 */
const TX_ID = "7f3a1c2e-9b4d-4e6f-8a1b-2c3d4e5f6a7b";

const tx = vi.hoisted(() => ({
  add: vi.fn<(data: Record<string, unknown>) => Promise<string>>(),
  remove: vi.fn<(id: string) => Promise<void>>(),
}));

vi.mock("@/stores/transaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/transaction")>();
  return { ...actual, useTransactionStore: () => tx };
});

// M4 选图：只 mock **第三方插件**（自己写的 imageInput 一律走真的），与 ChatComposer.test.ts 同法
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { initUserTables } from "@/db/userDb";
import { appendMessage, ensureConversation } from "@/services/ai/session";
import { AGENT_FAILURE_TEXT, useAiChatStore } from "@/stores/aiChat";
import { runAgent, type AgentTurn } from "@/services/ai/agent";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useLedgerStore } from "@/stores/ledger";
import { useTagStore } from "@/stores/tag";
import { usePrefsStore } from "@/stores/prefs";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import DraftCard from "@/components/ai/DraftCard.vue";
import AiChatPage from "@/views/AiChatPage.vue";

const T0 = "2026-03-01T00:00:00.000Z";

// id 全是真 UUID 形态：快照"不许带 id"这类断言才不会恒真（Ruling 13）
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const CAT_ID = "11111111-1111-4111-8111-111111111111";
const ACC_ID = "22222222-2222-4222-8222-222222222222";
const TAG_ID = "33333333-3333-4333-8333-333333333333";

/** 两张**不同**草稿：夹具里没有"别的同类项"，"收错人"的变异就红不了（Ruling 42） */
const DRAFT_A = {
  draftId: "d-1",
  draft: {
    type: "expense",
    amount: 128,
    category: "买菜",
    fromAccount: "招行储蓄卡",
    toAccount: null,
    occurredAt: "2026-02-28T00:00",
    note: "盒马",
    tags: ["生鲜"],
  },
  resolved: { categoryId: CAT_ID, fromAccountId: ACC_ID, toAccountId: null, tagIds: [TAG_ID] },
};
const DRAFT_B = {
  draftId: "d-2",
  draft: {
    type: "expense",
    amount: 56,
    category: "打车",
    fromAccount: "招行储蓄卡",
    toAccount: null,
    occurredAt: "2026-02-27T00:00",
    note: null,
    tags: [],
  },
  resolved: { categoryId: CAT_ID, fromAccountId: ACC_ID, toAccountId: null, tagIds: [] },
};

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 让某条 SQL 卡住的闸门（用来观测 `loading` 态）：只拦会话行那条查询 */
let gate: Deferred<void> | null = null;
/** 让三个名表查询报错（真实可达的降级形态：表结构坏 / 查询失败） */
let failNames = false;

/**
 * `$1` 是 `@tauri-apps/plugin-sql` 的占位符，而 `node:sqlite` 的命名参数要按名字传
 * （位置传参会 `column index out of range`）⇒ 适配器里把 `$N` 逐个换成 `?` 并按序号重排参数。
 * 既有 store（`category.ts`/`tag.ts`）用的正是 `$1`，不翻译就跑不动真库。
 */
function toPositional(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  if (!/\$\d/.test(sql)) return { sql, params };
  const ordered: unknown[] = [];
  const translated = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    ordered.push(params[Number(n) - 1]);
    return "?";
  });
  return { sql: translated, params: ordered };
}

function asTauriDb(sqlite: DatabaseSync) {
  const execute = vi.fn(
    async (sql: string, params: unknown[] = []): Promise<unknown> => {
      const q = toPositional(sql, params);
      // 形状照安装包产物：plugin-sql 的 `execute` 恒返回 `{ rowsAffected, lastInsertId }`
      // （`dist-js/index.js:88-98`，2.4.0），不是 `node:sqlite` 的 `{ changes, lastInsertRowid }`
      // —— 后者会让 store 按 `rowsAffected` 判成败时**永远读到 undefined**（R86-2）。
      const r = sqlite.prepare(q.sql).run(...(q.params as never[]));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
  );
  const select = vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown> => {
    if (failNames && /FROM (categories|accounts|tags)/.test(sql)) {
      throw new Error("no such table");
    }
    if (gate !== null && /FROM ai_conversations/.test(sql)) await gate.promise;
    const q = toPositional(sql, params);
    return sqlite.prepare(q.sql).all(...(q.params as never[]));
  });
  return { execute, select };
}

const opened: DatabaseSync[] = [];

async function useRealDb(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  await initUserTables(asTauriDb(sqlite) as never);
  state.db = asTauriDb(sqlite);
  opened.push(sqlite);
  return sqlite;
}

/** 一个个人账本 + 一张真实分类/账户/标签（快照里必须有它们） */
function seedLedger(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      "INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    )
    .run(LEDGER_ID, "家", "personal", "local-1", T0, T0);
}
function seedNames(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      `INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, color, created_at, updated_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(ACC_ID, LEDGER_ID, "local-1", "招行储蓄卡", "bank", "asset", 0, "#000", T0, T0);
  sqlite
    .prepare(
      `INSERT INTO categories (id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(CAT_ID, LEDGER_ID, "local-1", "买菜", "expense", null, 0, T0);
  sqlite
    .prepare("INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES (?, ?, ?, ?, 0)")
    .run(TAG_ID, LEDGER_ID, "生鲜", T0);
}

let pinia: Pinia;

async function mountPage(): Promise<VueWrapper> {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", component: { template: "<div />" } },
      { path: "/ai", component: { template: "<div />" } },
    ],
  });
  await router.push("/ai");
  await router.isReady();
  // §7.3 意愿层开关默认关闭 ⇒ 不置位的话输入框禁用、`send` 也不发。本文件钉的是页面接线
  // （名表加载 / 消息流 / 草稿归位 / 遮罩），门控本身在 `aiChat.privacy.test.ts` 里钉。
  useAiChatStore().sendingEnabled = true;
  const wrapper = mount(AiChatPage, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper as VueWrapper;
}

function bubbleTexts(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[data-test="message-bubble-text"]').map((el) => el.text());
}

/** 真实交互发送（走输入框 + 发送按钮，不直调 store） */
async function ask(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find('[data-test="composer-input"]').setValue(text);
  await wrapper.find('[data-test="composer-send"]').trigger("click");
  await flushPromises();
}

/**
 * 把 store 现在这批草稿**落进库**（`runAgent` 是 mock ⇒ 真 agent 里那一次 `persistAssistant`
 * 不会发生）。要钉"决定真的写进 payload"的用例必须先调它：库里没有那条消息行时
 * `updateDraftPayload` 必然 0 行，测出来的就不是页面的行为。
 */
async function persistDrafts(): Promise<void> {
  const store = useAiChatStore();
  const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
  for (const m of store.messages) {
    const drafts = m.payload?.drafts;
    if (m.role !== "assistant" || !Array.isArray(drafts) || drafts.length === 0) continue;
    await appendMessage({
      id: m.id,
      conversation_id: cid,
      role: "assistant",
      content: m.content,
      created_at: m.createdAt,
      payload: { chips: [], drafts, refs: {}, trace: [] },
    });
  }
  store.conversationId = cid;
  await flushPromises();
}

const runMock = () => vi.mocked(runAgent);

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  gate = null;
  failNames = false;
  tx.add.mockReset();
  tx.remove.mockReset();
  // 默认实现：`add` 给一个真 id（撤销要用它），`remove` 成功返回
  tx.add.mockResolvedValue(TX_ID);
  tx.remove.mockResolvedValue(undefined);
  pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
  gate = null;
});

// ---------------------------------------------------------------------------
// 名表加载（快照不许是空的）
// ---------------------------------------------------------------------------

describe("首屏：页面的名表加载责任", () => {
  it("自己 fetchAll 账户/分类/标签，且 send 的快照里带着它们的名字", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    seedNames(sqlite);
    await mountPage();

    // 三个既有 store 的内存被页面填上了（快照读的就是这三份内存）
    expect(useAccountStore().accounts.map((a) => a.name)).toEqual(["招行储蓄卡"]);
    expect(useCategoryStore().categories.map((c) => c.name)).toEqual(["买菜"]);
    expect(useTagStore().tags.map((t) => t.name)).toEqual(["生鲜"]);

    runMock().mockResolvedValue(turn({ text: "这个月花了 128 元" }));
    await useAiChatStore().send("这个月花了多少");

    const args = runMock().mock.calls[0]![0];
    expect(args.ledgerId).toBe(LEDGER_ID);
    // 杀手：删掉页面里那三行 fetchAll ⇒ 下面这三个数组全变空（而 tools 的 lookup 走 DB 仍有数据）
    expect(args.snapshot).toEqual({
      kind: "personal",
      categories: [{ name: "买菜", type: "expense" }],
      accounts: [{ name: "招行储蓄卡", type: "银行卡" }],
      tags: ["生鲜"],
      members: [{ name: "我" }],
    });
  });

  it("名表读失败也不让整页打不开：后面的 load 照跑，快照退回空表", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    seedNames(sqlite);
    const convId = await ensureConversation(LEDGER_ID, new Date(T0));
    await appendMessage({
      id: "m1",
      conversation_id: convId!,
      role: "user",
      content: "旧问题",
      created_at: T0,
    });
    // 三个名表查询报错（冷启动建表失败 / schema 坏）——`fetchAll` 会抛
    failNames = true;
    // 同上：账本已就位 ⇒ 读历史只走页面自己那条 `load()`
    await useLedgerStore().init();
    const wrapper = await mountPage();

    // 杀手：catch 不吞（rethrow / 删掉 try）⇒ onMounted 的 await 链断在 fetchAll，
    // 下面的 `ai.load()` 永远不跑 ⇒ 这条断言红
    expect(bubbleTexts(wrapper)).toEqual(["旧问题"]);
    expect(wrapper.find('[data-test="composer-input"]').exists()).toBe(true);

    runMock().mockResolvedValue(turn({ text: "答" }));
    await ask(wrapper, "问一句");

    expect(bubbleTexts(wrapper)).toEqual(["旧问题", "问一句", "答"]);
    // 如实记录降级后果：这一轮快照是空的（模型会说"账本里还没有分类"）
    expect(runMock().mock.calls[0]![0].snapshot.categories).toEqual([]);
    failNames = false;
  });
});

// ---------------------------------------------------------------------------
// 消息流
// ---------------------------------------------------------------------------

describe("消息流", () => {
  it("首屏读既有会话（load）：占位符按 refs 回填后上屏（历史消息按 §7.4 遮罩）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const convId = await ensureConversation(LEDGER_ID, new Date(T0));
    await appendMessage({
      id: "m1",
      conversation_id: convId!,
      role: "user",
      content: "这个月花了多少",
      created_at: T0,
    });
    await appendMessage({
      id: "m2",
      conversation_id: convId!,
      role: "assistant",
      content: "这个月花了 {{q1.total}} 元",
      created_at: T0,
      payload: { refs: { "q1.total": "128" } },
    });

    // 真实形态：进 AI 页时账本**已经**是当前账本（前面已经过流水页）⇒ store 里
    // `watch(currentLedgerId)` 不会触发，读历史只能靠**页面自己**调 `load()`。
    await useLedgerStore().init();

    const wrapper = await mountPage();

    // 杀手：删掉 onMounted 里的 `await ai.load()` ⇒ 这里只剩空态
    // §7.4 乙方案：`load()` 读回来的是**历史消息**（不在 `revealed` 里）⇒ 跟随遮罩。
    // ⚠️ 本条**原先**期望 `这个月花了 128 元` —— 那是规格前的行为，按 Ruling 49
    //    先改断言（它编码的正是 §7.4 要消灭的那件事），再改实现。
    expect(bubbleTexts(wrapper)).toEqual(["这个月花了多少", `这个月花了 ${AMOUNT_PLACEHOLDER} 元`]);
    // 反向断言（遮罩测试的通病是"只断言了占位符在"）：这条消息里唯一的真值是 128，它一个字符都不许上屏
    expect(wrapper.findAll('[data-test="message-bubble-text"]')[1]!.text()).not.toContain("128");
  });

  it("发送后追加两条（user + assistant）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "这个月花了 128 元" }));
    const wrapper = await mountPage();

    await ask(wrapper, "这个月花了多少");

    expect(bubbleTexts(wrapper)).toEqual(["这个月花了多少", "这个月花了 128 元"]);
    expect(wrapper.findAll('[data-test="ai-message"]').length).toBe(2);
  });

  it("本轮问出来的回答显示**真值**（§7.4 的另一半：遮罩不能把刚问的数字也遮掉）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    // 真实 agent 的形态：`content` 里是占位符，真值在 refs 里
    runMock().mockResolvedValue(
      turn({ text: "这个月花了 {{q1.total}} 元", refs: { "q1.total": "128" } }),
    );
    const wrapper = await mountPage();

    await ask(wrapper, "这个月花了多少");

    // 杀手：页面把 `isMasked()` 写成"只按全局 amountsHidden 判"（不看 revealed）⇒ 这条红
    //      （历史那条仍绿），也就是"问一句也看不到数字"——§7.4 明说不接受
    expect(bubbleTexts(wrapper)).toEqual(["这个月花了多少", "这个月花了 128 元"]);
  });

  it("失败是消息流里的一条 assistant 消息，不是对话框（§5.3）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockRejectedValue(new Error("agent 契约被改坏了"));
    const wrapper = await mountPage();

    await ask(wrapper, "问一句");

    expect(bubbleTexts(wrapper)).toEqual(["问一句", AGENT_FAILURE_TEXT]);
    expect(wrapper.findComponent(ConfirmDialog).exists()).toBe(false);
  });

  it("空账本首次发送后 conversationId 仍是 null（R4 懒建会话），消息照样渲染", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "答" }));
    const wrapper = await mountPage();

    await ask(wrapper, "第一句");

    const store = useAiChatStore();
    // 建会话推迟到 agent 的 ensureConversation（runAgent 在这是 mock ⇒ 库里仍然没有会话行）
    expect(store.conversationId).toBeNull();
    // 杀手：把消息列表写成 `v-if="store.conversationId"` ⇒ 第一轮问答整段消失
    expect(bubbleTexts(wrapper)).toEqual(["第一句", "答"]);
  });

  it("加载态：会话行还在读的时候显示 loading，读完换成消息", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const convId = await ensureConversation(LEDGER_ID, new Date(T0));
    await appendMessage({
      id: "m1",
      conversation_id: convId!,
      role: "user",
      content: "旧问题",
      created_at: T0,
    });

    gate = deferred<void>();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/ai", component: { template: "<div />" } }],
    });
    await router.push("/ai");
    await router.isReady();
    const wrapper = mount(AiChatPage, { global: { plugins: [pinia, router] } }) as VueWrapper;
    await flushPromises();

    expect(wrapper.find('[data-test="ai-loading"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="ai-empty"]').exists()).toBe(false);

    gate.resolve();
    gate = null;
    await flushPromises();

    expect(wrapper.find('[data-test="ai-loading"]').exists()).toBe(false);
    expect(bubbleTexts(wrapper)).toEqual(["旧问题"]);
  });

  it("清空按钮真的清会话（413 的文案就是让用户来点它）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "答" }));
    const wrapper = await mountPage();
    await ask(wrapper, "第一句");

    await wrapper.find('[data-test="ai-clear"]').trigger("click");
    await flushPromises();

    const store = useAiChatStore();
    expect(store.messages).toEqual([]);
    expect(store.pendingDrafts).toEqual([]);
    expect(wrapper.find('[data-test="ai-empty"]').exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 草稿卡：归位、:key、收起时机
// ---------------------------------------------------------------------------

describe("草稿卡接线", () => {
  it("草稿渲染在产生它的那条 assistant 消息下面，且 :key 是 draftId", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "给你一张草稿", drafts: [DRAFT_A] }));
    const wrapper = await mountPage();

    await ask(wrapper, "记一笔");

    const messages = wrapper.findAll('[data-test="ai-message"]');
    expect(messages.length).toBe(2);
    expect(messages[0]!.find('[data-test="draft-card"]').exists()).toBe(false);
    expect(messages[1]!.find('[data-test="draft-card"]').exists()).toBe(true);
    // `:key` 必须**就是** draftId（跨草稿的身份钉）。
    // ⚠️ 别把它记成"防同实例换草稿的唯一防线"：页面上真正**先出手**的是 `load()` 期间
    // `loading` 的 `v-if/v-else` 把整段列表卸载重建（下面那条用例钉着它），
    // 而"同实例换内容"由卡内自清兜住（`DraftCard.vue:78-84`，6b 的用例钉着）。
    const cards = wrapper.findAllComponents(DraftCard);
    expect(cards.length).toBe(1);
    expect(cards[0]!.vm.$.vnode.key).toBe("d-1");
  });

  it("load 期间整段列表被卸载重建（`loading` 互斥 = 防「同实例换草稿」的那道行为防线）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    // 库里有**两张**草稿卡：一张在会话里，一张在下面 load 后再出现（槽位不同）
    const convId = await ensureConversation(LEDGER_ID, new Date(T0));
    await appendMessage({
      id: "m-1",
      conversation_id: convId!,
      role: "assistant",
      content: "这张草稿先落库",
      created_at: T0,
      payload: { drafts: [DRAFT_A] },
    });

    const wrapper = await mountPage();
    expect(wrapper.findAll('[data-test="draft-card"]').length).toBe(1);

    // 再读一次会话（真实触发点：进页面 / 换账本 / 清空后的 load）
    gate = deferred<void>();
    void useAiChatStore().load();
    await flushPromises();

    // 杀手：把 `<template v-else>` 改成 `<template>`（loading 时也渲染列表）⇒ 下面两条自己红：
    // 整个列表连同草稿卡实例被卸载重建 ⇒ 旧的卡**不可能**把新草稿接管过去
    expect(wrapper.find('[data-test="ai-loading"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-test="ai-message"]').length).toBe(0);
    expect(wrapper.findAll('[data-test="draft-card"]').length).toBe(0);

    gate.resolve();
    gate = null;
    await flushPromises();

    expect(wrapper.findAll('[data-test="draft-card"]').length).toBe(1);
  });

  it("确认的是第二张 ⇒ 第二张进「已记账 + 撤销」且卡留着，第一张仍待确认", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock()
      .mockResolvedValueOnce(turn({ text: "A", drafts: [DRAFT_A] }))
      .mockResolvedValueOnce(turn({ text: "B", drafts: [DRAFT_B] }));
    const wrapper = await mountPage();
    await ask(wrapper, "一");
    await ask(wrapper, "二");

    const store = useAiChatStore();
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1", "d-2"]);
    await persistDrafts();

    const pending = deferred<string>();
    tx.add.mockReturnValue(pending.promise);
    const cards = wrapper.findAll('[data-test="draft-card"]');
    expect(cards.length).toBe(2);
    await cards[1]!.find('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 点到的是第二张（金额 56），不是第一张
    expect(tx.add.mock.calls[0]![0].amount).toBe(56);

    pending.resolve(TX_ID);
    await flushPromises();

    // ⚠️ 这条断言**原先**写的是"`pendingDrafts` 剩 ["d-1"]、卡片消失"—— 那是把 C-P2 的缺陷
    //    （`@confirm` 接 `onDraftDismissed`：确认的同一次 flush 里卡片被卸载，§4.4:164 的
    //    「已记账 ✓ + 撤销」永远画不出来）冻成了契约（"把现状当规格"那一族）。
    //    规格要的是：确认后卡片**留在原地**变成「已记账 ✓ + 撤销」。
    // 杀手：收错人（按 `pendingDrafts[0]` / "列表最后一张" 收起）；或 `@confirm` 仍接旧处理 ⇒ 下面红
    const after = wrapper.findAll('[data-test="draft-card"]');
    expect(after.length).toBe(2);
    expect(after[1]!.attributes("data-draft-state")).toBe("saved");
    expect(after[1]!.get('[data-test="draft-saved-text"]').text()).toContain("已记账");
    // 撤销认的是**它自己**那笔（`add` 的返回值），不是第一张的、也不是"最后一笔"
    expect(after[1]!.find('[data-test="draft-undo"]').exists()).toBe(true);
    expect(after[0]!.attributes("data-draft-state")).toBe("pending");
    expect(after[0]!.find('[data-test="draft-confirm"]').exists()).toBe(true);
  });

  it("页面上真的接了 `@undo`：除卡片自己删那笔，**页面**还要把决定写回待确认（C-P2 的原状是没接）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "给你一张草稿", drafts: [DRAFT_A] }));
    const wrapper = await mountPage();
    await ask(wrapper, "记一笔");
    await persistDrafts();

    // 走真实交互进"已记账"：确认 ⇒ 卡片留在原地带撤销（上面那条钉了视图）
    await wrapper.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-test="draft-card"]').attributes("data-draft-state")).toBe("saved");
    // 前提：这次确认**真的**到了 store（不然下面"写回待确认"的断言就恒真了）
    expect(useAiChatStore().confirmedDrafts.map((d) => d.draftId)).toEqual(["d-1"]);

    await wrapper.get('[data-test="draft-undo"]').trigger("click");
    await flushPromises();

    // ① 卡片自己的那一半：真调 `remove(add 返回的 id)`。
    //    ⚠️ 这一条**只能**证明卡片这一层（`DraftCard.onUndo` 里就调 `remove`）—— 实测：把页面的
    //    `@undo` 整个删掉，这一条**照样绿**（`remove` 在修复前就不是死代码，复审的这一句是错的）。
    expect(tx.remove).toHaveBeenCalledWith(TX_ID);

    // ② 页面那一半（这条才是 `@undo` 监听唯一的杀手）：`@undo` ⇒ `ai.undoDraft` 把决定写回
    //    `pending`。没有监听的话 store 永远停在"已确认" ⇒ 下面红（重进页面还会说"已记账"）。
    expect(useAiChatStore().confirmedDrafts).toEqual([]);
    expect(useAiChatStore().pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);

    // ③ 撤销的决定**也持久**：重进页面（`load()`）不许复活成"已记账"
    await useAiChatStore().load();
    await flushPromises();
    expect(useAiChatStore().confirmedDrafts).toEqual([]);
    expect(useAiChatStore().pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    expect(wrapper.get('[data-test="draft-card"]').attributes("data-draft-state")).toBe("pending");
  });

  it("决定落库失败不许静默（M-5）：卡回退成待确认 + 把那笔撤回 + 让人看见", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "给你一张草稿", drafts: [DRAFT_A] }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const wrapper = await mountPage();
    await ask(wrapper, "记一笔");
    // ⚠️ 不调 persistDrafts：库里没有那条 assistant 行 ⇒ 决定 UPDATE 必然 0 行
    // （真链路里 = 落库那一刻失败）

    await wrapper.get('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();
    await flushPromises();

    // 卡片本地**进过**「已记账」（`tx.add` 成功了）—— 决定没落库就必须回退，不许停在假成功
    // 杀手：页面把 `confirmDraft` 的返回值丢掉（`void ai.confirmDraft(...)`）⇒ 状态是 saved、这条红
    expect(wrapper.get('[data-test="draft-card"]').attributes("data-draft-state")).toBe("pending");
    // 而且要让用户看见（静默 = 用户以为记上了）
    expect(wrapper.get('[data-test="draft-error"]').text()).toContain("决定没存下");
    // 账上那笔也必须撤回：留下"账上有一笔、库里没有决定"的形态 ⇒ 重进页面草稿复活、再确认 = 第二笔
    expect(tx.remove).toHaveBeenCalledWith(TX_ID);
    expect(useAiChatStore().confirmedDrafts).toEqual([]);
    expect(useAiChatStore().pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
    // 回退必须是**可重试**的：卡在"记账中"就永远点不动了
    expect(wrapper.get('[data-test="draft-confirm"]').attributes("disabled")).toBeUndefined();
    warn.mockRestore();
  });

  it("拒绝：立刻收起，不记账", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "给你一张草稿", drafts: [DRAFT_A] }));
    const wrapper = await mountPage();
    await ask(wrapper, "记一笔");
    await persistDrafts();

    await wrapper.find('[data-test="draft-reject"]').trigger("click");
    await flushPromises();

    expect(tx.add).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="draft-card"]').exists()).toBe(false);
    // 拒绝是一条**决定**（不是"把草稿删掉"）：它必须离开待确认列表（重进页面才不会复活）
    expect(useAiChatStore().pendingDrafts).toEqual([]);
    expect(useAiChatStore().rejectedDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
  });
});

// ---------------------------------------------------------------------------
// §7.3 / §7.4 的**页面接线**（判定只有一处 `isMasked()`，但要逐个出口确认它真的传下去了）
// ---------------------------------------------------------------------------

describe("隐私：说明卡、意愿层门控、三个金额出口", () => {
  it("历史消息的**三个出口**同时遮：正文、芯片的金额条件、草稿卡的金额", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const convId = await ensureConversation(LEDGER_ID, new Date(T0));
    await appendMessage({
      id: "m-hist",
      conversation_id: convId!,
      role: "assistant",
      content: "上月买菜花了 {{q1.total}} 元",
      created_at: T0,
      payload: {
        refs: { "q1.total": "128" },
        drafts: [DRAFT_A],
        chips: [
          {
            dateFrom: null,
            dateTo: null,
            type: "expense",
            categories: [],
            account: null,
            tags: [],
            members: [],
            merchant: null,
            amountMin: 500,
            amountMax: null,
          },
        ],
      },
    });
    await useLedgerStore().init();
    const wrapper = await mountPage();

    // 出口 1：正文
    expect(bubbleTexts(wrapper)[0]).toBe(`上月买菜花了 ${AMOUNT_PLACEHOLDER} 元`);
    // 出口 2：芯片的金额条件（杀手：模板上漏传 `:masked` ⇒ 这条红）。
    // 标签里的"支出"照旧 ⇒ 遮的是金额、不是整条条件。
    expect(wrapper.get('[data-test="filter-chip"]').text()).toBe(`支出 · ≥${AMOUNT_PLACEHOLDER}`);
    // 出口 3：草稿卡的金额（同一个杀手）
    const cardText = wrapper.get('[data-test="draft-card"]').text();
    expect(cardText).toContain(AMOUNT_PLACEHOLDER);
    // 反向：三个出口里都不许出现真值（128 是正文的真值、500 是芯片的真值、128 也是卡的真值）
    const all = wrapper.text();
    expect(all).not.toContain("128");
    expect(all).not.toContain("500");
  });

  it("意愿层关着 ⇒ 输入框与发送键都禁用 + 页面说明为什么（§7.3）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const wrapper = await mountPage(); // mountPage 会先打开门控（本文件其余用例要能发问）
    const store = useAiChatStore();
    await store.refreshStatus(); // 有 host ⇒ 文案是"去隐私设置打开"那一版
    store.sendingEnabled = false;
    await flushPromises();

    // 杀手：`ChatComposer` 不接 `enabled`（只传 sending）⇒ 前两条红
    expect(wrapper.get('[data-test="composer-input"]').element).toHaveProperty("disabled", true);
    expect(wrapper.get('[data-test="composer-send"]').element).toHaveProperty("disabled", true);
    expect(wrapper.get('[data-test="ai-sending-off-hint"]').text()).toContain("我的 → 隐私");

    store.sendingEnabled = true;
    await flushPromises();
    expect(wrapper.get('[data-test="composer-input"]').element).toHaveProperty("disabled", false);
  });

  it("拿不到 host ⇒ 说明卡不出现（M2→M3 硬约束在页面这一层也成立）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const wrapper = await mountPage();
    const store = useAiChatStore();
    // 页面**不会**自己探能力（第 47 条）⇒ 没探过时 host 是 null
    expect(store.host).toBeNull();
    // 杀手：把 `:host="ai.host"` 换成写死的字符串 ⇒ 这条红（会给一个不知道发给谁的同意书）
    expect(wrapper.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
  });

  it("host 可知且未看过 ⇒ 卡片渲染；点「知道了」⇒ store 记住（下次不再弹）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const wrapper = await mountPage();
    const store = useAiChatStore();
    await store.refreshStatus();
    await flushPromises();

    expect(wrapper.get('[data-test="ai-privacy-host"]').text()).toBe("h");
    await wrapper.get('[data-test="ai-privacy-card-dismiss"]').trigger("click");
    await flushPromises();

    // 杀手：`onPrivacyDismiss` 里不调 `dismissPrivacyCard` ⇒ 这两条红
    expect(store.privacyCardSeen).toBe(true);
    expect(wrapper.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
  });

  it("本轮问出来的草稿卡显示**真金额**（`:masked` 真的传到了卡上，不是靠全局默认）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "给你一张草稿", drafts: [DRAFT_A] }));
    const wrapper = await mountPage();

    await ask(wrapper, "记一笔");

    // ⚠️ 这条断言是**唯一**能钉住"页面把 `:masked` 传给 DraftCard"的地方：
    // 历史那条（上面"三个出口"）在漏传时**照绿** —— 因为全局默认就是"遮"，
    // 卡片自己回落到 `amountsHidden` 也能得出同样的结果（变异实测 m7-12 是 MISS）。
    // 反过来这里要的是"不遮"：全局默认遮着，只有真的传了 `masked=false` 才可能显示 128。
    const cardText = wrapper.get('[data-test="draft-card"]').text();
    expect(cardText).toContain("128");
    expect(cardText).not.toContain(AMOUNT_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// M4 附件：页面接线（E12.1）—— 选图/撤掉都经 store，切页（重挂载）不丢
// ---------------------------------------------------------------------------

describe("M4 附件接线：附件归 store ⇒ 切页不丢（E12.1）", () => {
  const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

  /** 用真 base64 编码器造出**解码后恰好 n 字节**的 data URL */
  function dataUrlOfBytes(n: number): string {
    return `data:image/jpeg;base64,${Buffer.alloc(n, 0x41).toString("base64")}`;
  }

  /** 让**真实**转码链在 happy-dom 里跑通（同 ChatComposer.test.ts 的 DOM 探针） */
  function stubRealCanvas(url: string): void {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4000, height: 3000, close: vi.fn() })),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(url);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 点页面上的选图按钮（走真实 imageInput + 被 mock 的两个插件） */
  async function pick(wrapper: VueWrapper, url: string): Promise<void> {
    vi.mocked(open).mockResolvedValue("C:/tmp/real.jpg");
    vi.mocked(readFile).mockResolvedValue(JPEG_BYTES);
    stubRealCanvas(url);
    await wrapper.get('[data-test="composer-pick-image"]').trigger("click");
    await flushPromises();
  }

  it("选完图 ⇒ 图进 store 且预览出现；**卸载再挂载** ⇒ 预览仍在（切页不丢附件）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const url = dataUrlOfBytes(3000);
    const wrapper = await mountPage();

    await pick(wrapper, url);

    // 杀手：删掉页面上的 `@attach="ai.setAttachedImage"` ⇒ 这三条红（图根本进不了 store）
    expect(useAiChatStore().attachedImage?.dataUrl).toBe(url);
    expect(wrapper.get('[data-test="attachment-thumb"]').attributes("src")).toBe(url);

    // 切页 = 组件被**卸载**；回来 = 重新挂载（同一个 Pinia 实例 ⇒ store 还活着）
    wrapper.unmount();
    const again = await mountPage();

    // ⚠️ 这条是 E12.1 的落点：附件若活在组件/页面局部状态里，重挂载后就什么都不剩。
    //    它和上面那条**共用同一个杀手**（附件没进 store 时两条一起红）—— 它多守的是
    //    "有没有人把附件的作用域缩到一次挂载之内"（例如卸载时顺手清掉）。
    expect(again.find('[data-test="attachment-preview"]').exists()).toBe(true);
    expect(again.get('[data-test="attachment-thumb"]').attributes("src")).toBe(url);
  });

  it("点 ✕ 撤掉 ⇒ 预览消失，且**重挂载后不会复活**（撤掉也是 store 的动作）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const url = dataUrlOfBytes(3000);
    const wrapper = await mountPage();
    await pick(wrapper, url);
    expect(wrapper.find('[data-test="attachment-preview"]').exists()).toBe(true);

    await wrapper.get('[data-test="attachment-remove"]').trigger("click");
    await flushPromises();
    // 杀手：删掉页面上的 `@remove-attachment="ai.clearAttachedImage()"` ⇒ store 里那张图还在
    // ⇒ 这一条（重挂载后复活）与上面的"消失"一起红
    expect(useAiChatStore().attachedImage).toBeNull();
    expect(wrapper.find('[data-test="attachment-preview"]').exists()).toBe(false);

    wrapper.unmount();
    const again = await mountPage();
    expect(again.find('[data-test="attachment-preview"]').exists()).toBe(false);
  });

  it("历史里带图的那条 user 消息仍显示缩略图（§4.3 只换**发给模型**的上下文）", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const url = dataUrlOfBytes(3000);
    const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
    await appendMessage({
      id: "u-img",
      conversation_id: cid,
      role: "user",
      content: "",
      payload: {
        image: { mime: "image/jpeg", dataUrl: url, width: 1280, height: 960, bytes: 3000 },
      },
      created_at: T0,
    });

    const wrapper = await mountPage();

    // 杀手：把页面里那个 `<img data-test="ai-message-thumb">` 删掉 ⇒ 这条红
    // （§4.3 的替换只作用于上下文；页面这侧必须还能看见当初发的是哪张图）
    expect(wrapper.get('[data-test="ai-message-thumb"]').attributes("src")).toBe(url);
  });
});

// ---------------------------------------------------------------------------
// Bug 1：发送期间必须看得见「正在思考」（实机：发问后页面毫无反馈，过一会结果一次性弹出）
//
// 三条**独立的**结束路径都要把提示收掉：成功、失败、取消。只钉成功那条 = 漏掉另外两条
// （失败会被 `fail()` 兜成一条消息、取消走 `cancelInFlight()`，两者都不经过"回答到达"那一步）。
// ---------------------------------------------------------------------------

describe("Bug 1：发送中的可见反馈", () => {
  it("等回答时显示「正在思考…」，回答到达后消失", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const pending = deferred<AgentTurn>();
    runMock().mockReturnValue(pending.promise);
    const wrapper = await mountPage();

    await ask(wrapper, "问一句");

    // 前提：这一轮确实在途中（composer 已经切成取消按钮 ⇒ 页面知道自己在等）
    expect(useAiChatStore().sending).toBe(true);
    expect(wrapper.find('[data-test="composer-cancel"]').exists()).toBe(true);
    // 杀手：删掉模板里那条 `v-if="ai.sending"` 的进行中提示 ⇒ 下面两条红。
    // ⚠️ 注意它**不是** `ai.loading`（那只服务首次读历史，`load()` 之外恒为 false）。
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="ai-thinking"]').text()).toContain("正在思考");

    pending.resolve(turn({ text: "答" }));
    await flushPromises();

    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(false);
    expect(bubbleTexts(wrapper)).toEqual(["问一句", "答"]);
  });

  it("失败（agent 抛）之后提示也消失：不许因为没走到成功路径就永远挂着", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    let reject!: (e: Error) => void;
    const pending = new Promise<AgentTurn>((_resolve, rej) => {
      reject = rej;
    });
    runMock().mockReturnValue(pending);
    const wrapper = await mountPage();

    await ask(wrapper, "问一句");
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(true);

    reject(new Error("agent 契约被改坏了"));
    await flushPromises();

    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(false);
    expect(useAiChatStore().sending).toBe(false);
    expect(bubbleTexts(wrapper)).toEqual(["问一句", AGENT_FAILURE_TEXT]);
  });

  it("取消之后提示立刻消失（不等那一轮 settle），迟到的那轮也不许把它带回来", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const pending = deferred<AgentTurn>();
    runMock().mockReturnValue(pending.promise);
    const wrapper = await mountPage();

    await ask(wrapper, "问一句");
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(true);

    await wrapper.get('[data-test="composer-cancel"]').trigger("click");
    await flushPromises();

    // 杀手：提示只跟 `sending` 走（`cancelInFlight()` 立刻置 false）⇒ 这两条红
    expect(useAiChatStore().sending).toBe(false);
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(false);

    // 被 abort 的那一轮仍可能回来（`runSeq` 已作废它）：不许把提示带回来、也不许追加回答
    pending.resolve(turn({ text: "迟到的回答" }));
    await flushPromises();
    expect(wrapper.find('[data-test="ai-thinking"]').exists()).toBe(false);
    expect(bubbleTexts(wrapper)).toEqual(["问一句"]);
  });
});

// ---------------------------------------------------------------------------
// Bug 2：AI 页就地切换金额遮蔽（实机：金额被遮成星号，本页却没有眼睛图标，只能去别的页面开完再切回来）
//
// ⚠️ 眼睛控的是**全局** `amountsHidden`（其他页面同一个组件、同一条语义），
// 而 §7.4 乙方案的 `revealed`（本轮问出来的显示真值）**一点都不能动** —— 两者是两件事：
// 前者是"用户现在想不想看"，后者是"这条消息是不是我刚问出来的"。所以下面第二条点击
// 专门钉"全局关回去之后，本轮那条仍显示真值、历史那条重新遮上"。
// ---------------------------------------------------------------------------

describe("Bug 2：AI 页就地切换金额遮蔽", () => {
  it("页头有眼睛开关；点它 ⇒ 历史消息由遮变真，再点回去 ⇒ 历史重新遮上、本轮的仍显示真值", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    // 历史消息（`load()` 读回来的，不在 `revealed` 里）⇒ 跟随全局遮罩
    const convId = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
    await appendMessage({
      id: "m-hist",
      conversation_id: convId,
      role: "assistant",
      content: "上月买菜花了 {{q1.total}} 元",
      created_at: T0,
      payload: { refs: { "q1.total": "128" } },
    });
    await useLedgerStore().init();
    runMock().mockResolvedValue(
      turn({ text: "这个月花了 {{q2.total}} 元", refs: { "q2.total": "256" } }),
    );
    const wrapper = await mountPage();
    await ask(wrapper, "这个月花了多少");

    const HID = `上月买菜花了 ${AMOUNT_PLACEHOLDER} 元`;
    const SHOWN = "上月买菜花了 128 元";
    // 前提：一条历史（遮）+ 一轮刚问出来的（真值）—— 两种形态同时在屏上
    expect(bubbleTexts(wrapper)).toEqual([HID, "这个月花了多少", "这个月花了 256 元"]);
    expect(usePrefsStore().amountsHidden).toBe(true);

    // 杀手：删掉页头那个 `<AmountMaskToggle />` ⇒ 这一行直接抛（找不到元素）
    const eye = wrapper.get('[data-test="amount-mask-toggle"]');

    await eye.trigger("click");
    await flushPromises();

    // 眼睛控的是**全局** `amountsHidden` ⇒ 历史那条跟着显示真值
    expect(usePrefsStore().amountsHidden).toBe(false);
    expect(bubbleTexts(wrapper)).toEqual([SHOWN, "这个月花了多少", "这个月花了 256 元"]);

    await eye.trigger("click");
    await flushPromises();

    // 关回去：历史重新遮上（全局语义），而**本轮问出来的**仍显示真值（`revealed` 没被这次改动碰到）。
    // 杀手：把"就地切换"实现成往 `revealed` 里塞消息 id / 清空 `revealed` ⇒ 这两条其中之一红。
    expect(usePrefsStore().amountsHidden).toBe(true);
    expect(bubbleTexts(wrapper)).toEqual([HID, "这个月花了多少", "这个月花了 256 元"]);
  });

  it("空会话也有眼睛开关：它是全局开关，不该等第一条消息才出现", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    const wrapper = await mountPage();

    expect(bubbleTexts(wrapper)).toEqual([]);
    // 杀手：把 `<AmountMaskToggle />` 挪进 `v-for` 的消息块 / `messages.length > 0` 的分支 ⇒ 这条红
    expect(wrapper.find('[data-test="amount-mask-toggle"]').exists()).toBe(true);
  });
});
