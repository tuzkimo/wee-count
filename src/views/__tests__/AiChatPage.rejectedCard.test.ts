// src/views/__tests__/AiChatPage.rejectedCard.test.ts
//
// 撤回后的**静态卡必须留在消息流里**（规格 §4.4.4 / §4.5:271，2026-09-24 人工批准）：
//
// 推翻的旧行为是「已拒绝的草稿不渲染、卡从列表里消失」（`AiChatPage.vue:52,175` 的原文）。
// 新行为：`rejected` 照样渲染成一张静态「已撤回」卡（摘要完整、零按钮），决定照旧落库，
// **重进页面仍是已撤回静态卡 —— 绝不允许复活成待确认**（C-P1 的复活路径：复活后再点一次确认
// 就是第二笔真账）。
//
// 判据落在**页面**（`draftsFor()` 收哪几份草稿）：卡自己的形态由 `DraftCard.readonlySummary.test.ts`
// 钉。夹具走真 `node:sqlite` + 真 session（决定要真写进 payload），只 mock `runAgent`（这一轮
// 的产物）与记账入口。
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
  return { ...actual, fetchAiStatus: vi.fn(async () => ({ enabled: true, model: "m", host: "h" })) };
});

const tx = vi.hoisted(() => ({
  add: vi.fn(async () => "7f3a1c2e-9b4d-4e6f-8a1b-2c3d4e5f6a7b"),
  remove: vi.fn(async () => {}),
}));
vi.mock("@/stores/transaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/stores/transaction")>();
  return { ...actual, useTransactionStore: () => tx };
});

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));

import { initUserTables } from "@/db/userDb";
import { appendMessage, ensureConversation } from "@/services/ai/session";
import { useAiChatStore } from "@/stores/aiChat";
import { runAgent, type AgentTurn } from "@/services/ai/agent";
import AiChatPage from "@/views/AiChatPage.vue";

const T0 = "2026-03-01T00:00:00.000Z";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const CAT_ID = "11111111-1111-4111-8111-111111111111";
const ACC_ID = "22222222-2222-4222-8222-222222222222";

/** 带 tags / 备注 / 账户的一条草稿（静态卡"摘要不缩水"要拿它比） */
const DRAFT = {
  draftId: "d-1",
  draft: {
    type: "expense",
    amount: 128.5,
    category: "买菜",
    fromAccount: "招行",
    toAccount: null,
    occurredAt: "2026-02-28T00:00",
    note: "盒马",
    tags: ["生鲜"],
  },
  resolved: { categoryId: CAT_ID, fromAccountId: ACC_ID, toAccountId: null, tagIds: [] },
};

/** 改口之后那一轮的新草稿（§4.4.6：它一出现，上面那张**待确认**的就被作废、不再渲染） */
const DRAFT_B = {
  draftId: "d-2",
  draft: { ...DRAFT.draft, note: "改口后的新草稿", fromAccount: "现金" },
  resolved: { ...DRAFT.resolved },
};

const runMock = () => vi.mocked(runAgent);

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "已生成草稿，请确认", chips: [], drafts: [DRAFT], refs: {}, trace: [], aborted: false, ...over };
}

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
  return {
    execute: vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown> => {
      const q = toPositional(sql, params);
      const r = sqlite.prepare(q.sql).run(...(q.params as never[]));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    }),
    select: vi.fn(async (sql: string, params: unknown[] = []): Promise<unknown> => {
      const q = toPositional(sql, params);
      return sqlite.prepare(q.sql).all(...(q.params as never[]));
    }),
  };
}

const opened: DatabaseSync[] = [];

async function useRealDb(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  await initUserTables(asTauriDb(sqlite) as never);
  state.db = asTauriDb(sqlite);
  opened.push(sqlite);
  return sqlite;
}

function seedLedger(sqlite: DatabaseSync): void {
  sqlite
    .prepare(
      "INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, 0)",
    )
    .run(LEDGER_ID, "家", "personal", "local-1", T0, T0);
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
  useAiChatStore().sendingEnabled = true;
  const wrapper = mount(AiChatPage, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper as VueWrapper;
}

/**
 * 把 mock 出来的那一轮草稿**落进库**（真 agent 里这一步是 `persistAssistant`）。
 * 不落库的话 `rejectDraft` 的 `updateDraftPayload` 打到 0 行 ⇒ 页面走的是"决定没存下"那条路，
 * 测出来的就不是"撤回"的行为。
 */
async function persistDrafts(): Promise<void> {
  const store = useAiChatStore();
  const cid = (await ensureConversation(LEDGER_ID, new Date(T0)))!;
  for (const m of store.messages) {
    const drafts = m.payload?.drafts;
    if (m.role !== "assistant" || !Array.isArray(drafts) || drafts.length === 0) continue;
    // ⚠️ `payload` 传**对象**（session 自己 stringify）：再 `JSON.stringify` 一次会变成双重编码，
    // `json_extract(payload, '$.drafts')` 什么都取不到 ⇒ 决定写库必然 0 行。
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

async function ask(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.find('[data-test="composer-input"]').setValue(text);
  await wrapper.find('[data-test="composer-send"]').trigger("click");
  await flushPromises();
}

const cards = (w: VueWrapper) => w.findAll('[data-test="draft-card"]');

beforeEach(async () => {
  vi.clearAllMocks();
  runMock().mockReset();
  tx.add.mockClear();
  tx.remove.mockClear();
  state.db = null;
  pinia = createPinia();
  setActivePinia(pinia);
  const sqlite = await useRealDb();
  seedLedger(sqlite);
});

afterEach(() => {
  for (const sqlite of opened.splice(0)) sqlite.close();
  state.db = null;
});

describe("撤回后的静态卡（§4.4.4）", () => {
  it("① 撤回 ⇒ 卡**留在消息流里**变成静态「已撤回」，摘要完整、零按钮", async () => {
    runMock().mockResolvedValue(turn());
    const wrapper = await mountPage();

    await ask(wrapper, "记一笔 128.5 的菜");
    expect(cards(wrapper).length).toBe(1);
    await persistDrafts();

    // 撤回按钮的文案是「撤回」（标识符仍是 draft-reject，§4.4.1）
    const reject = wrapper.get('[data-test="draft-reject"]');
    expect(reject.text()).toContain("撤回");
    await reject.trigger("click");
    await flushPromises();

    // 改哪一行能让它红：`AiChatPage.vue` 的 `draftsByMessage` 只收 pending + confirmed 两份
    // （改动前的原文）⇒ 撤回后 `cards(wrapper).length` 变 0，这一条与下一条同时红。
    const after = cards(wrapper);
    expect(after.length).toBe(1);
    expect(after[0]!.attributes("data-draft-state")).toBe("rejected");
    // 摘要不缩水（静态卡与待确认卡同一份摘要）
    expect(after[0]!.find('[data-test="draft-category"]').text()).toBe("买菜");
    expect(after[0]!.find('[data-test="draft-note"]').text()).toBe("盒马");
    expect(after[0]!.get('[data-test="draft-tag"]').text()).toBe("生鲜");
    // 零按钮：撤回的那笔**从未入账**，静态卡不调 transactionStore 的任何方法
    for (const name of ["draft-confirm", "draft-reject", "draft-undo"]) {
      expect(wrapper.find(`[data-test="${name}"]`).exists()).toBe(false);
    }
    expect(tx.add).not.toHaveBeenCalled();
    expect(tx.remove).not.toHaveBeenCalled();
  });

  it("② 决定真的落进 payload：重进页面（`load()`）仍是已撤回静态卡，不复活成待确认", async () => {
    runMock().mockResolvedValue(turn());
    const wrapper = await mountPage();
    await ask(wrapper, "记一笔 128.5 的菜");
    await persistDrafts();
    await wrapper.get('[data-test="draft-reject"]').trigger("click");
    await flushPromises();

    // 重进页面：拿库里的 payload 重新播种
    await useAiChatStore().load();
    await flushPromises();

    const after = cards(wrapper);
    expect(after.length).toBe(1);
    expect(after[0]!.attributes("data-draft-state")).toBe("rejected");
    // 复活成待确认就会重新出现确认按钮 ⇒ 用户再点一次 = 第二笔真账
    expect(wrapper.find('[data-test="draft-confirm"]').exists()).toBe(false);
  });

  it("③ 新草稿顶掉旧的待确认卡：消息流里只剩一张，且旧卡**不是**「已撤回」", async () => {
    runMock().mockResolvedValue(turn());
    const wrapper = await mountPage();
    await ask(wrapper, "记一笔 128.5 的菜");
    await persistDrafts();
    expect(cards(wrapper).length).toBe(1);

    // 用户在对话里改口 ⇒ 工具再调一次、又出一张卡（§4.4.3 的正当路径 (a)）
    runMock().mockResolvedValue(turn({ drafts: [DRAFT_B] }));
    await ask(wrapper, "不是招行，是现金");
    await persistDrafts();
    await flushPromises();

    // 改哪一行能让它红：去掉 `runTurn` 里那次 `supersedePendingDrafts()` ⇒ 两张待确认卡同屏
    // （旧那张还挂着"确认记账"，用户点错就是一笔他没要的账），这条与下一条同时红。
    expect(cards(wrapper).length).toBe(1);
    expect(wrapper.get('[data-test="draft-note"]').text()).toBe("改口后的新草稿");
    // 作废不是撤回：屏幕上不该出现「已撤回」（那是"用户主动否决"的语义）
    expect(wrapper.text()).not.toContain("已撤回");

    // 重进页面：作废的卡仍不渲染（判定落了库）
    await useAiChatStore().load();
    await flushPromises();
    expect(cards(wrapper).length).toBe(1);
    expect(wrapper.get('[data-test="draft-note"]').text()).toBe("改口后的新草稿");
  });
});
