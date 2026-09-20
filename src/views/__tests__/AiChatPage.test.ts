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

/** 草稿卡的记账动作：本文件只关心"页面在什么时候把草稿收起"，不关心记账本身 */
const tx = vi.hoisted(() => ({ add: vi.fn(), remove: vi.fn() }));

vi.mock("@/stores/transaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/transaction")>();
  return { ...actual, useTransactionStore: () => tx };
});

import { initUserTables } from "@/db/userDb";
import { appendMessage, ensureConversation } from "@/services/ai/session";
import { AGENT_FAILURE_TEXT, useAiChatStore } from "@/stores/aiChat";
import { runAgent, type AgentTurn } from "@/services/ai/agent";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useLedgerStore } from "@/stores/ledger";
import { useTagStore } from "@/stores/tag";
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
      return sqlite.prepare(q.sql).run(...(q.params as never[]));
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

const runMock = () => vi.mocked(runAgent);

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
  gate = null;
  failNames = false;
  tx.add.mockReset();
  tx.remove.mockReset();
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
  it("首屏读既有会话（load）：占位符按 refs 回填后上屏", async () => {
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
    expect(bubbleTexts(wrapper)).toEqual(["这个月花了多少", "这个月花了 128 元"]);
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
    // `:key` 必须**就是** draftId：同实例换草稿是"防删旧账"那条保证的第一道防线
    const cards = wrapper.findAllComponents(DraftCard);
    expect(cards.length).toBe(1);
    expect(cards[0]!.vm.$.vnode.key).toBe("d-1");
  });

  it("确认的是第二张 ⇒ 收起的也必须是第二张（不能收'当前第一张'）", async () => {
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

    const pending = deferred<string>();
    tx.add.mockReturnValue(pending.promise);
    const cards = wrapper.findAll('[data-test="draft-card"]');
    expect(cards.length).toBe(2);
    await cards[1]!.find('[data-test="draft-confirm"]').trigger("click");
    await flushPromises();

    // 点到的是第二张（金额 56），不是第一张
    expect(tx.add.mock.calls[0]![0].amount).toBe(56);

    pending.resolve("tx-1");
    await flushPromises();

    // 杀手：页面按 `pendingDrafts[0]` / "列表最后一张" 收起 ⇒ 这里红（收错了人）
    expect(store.pendingDrafts.map((d) => d.draftId)).toEqual(["d-1"]);
  });

  it("拒绝：立刻收起，不记账", async () => {
    const sqlite = await useRealDb();
    seedLedger(sqlite);
    runMock().mockResolvedValue(turn({ text: "给你一张草稿", drafts: [DRAFT_A] }));
    const wrapper = await mountPage();
    await ask(wrapper, "记一笔");

    await wrapper.find('[data-test="draft-reject"]').trigger("click");
    await flushPromises();

    expect(useAiChatStore().pendingDrafts).toEqual([]);
    expect(tx.add).not.toHaveBeenCalled();
    expect(wrapper.find('[data-test="draft-card"]').exists()).toBe(false);
  });
});
