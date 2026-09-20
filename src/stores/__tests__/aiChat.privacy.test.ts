// src/stores/__tests__/aiChat.privacy.test.ts
//
// §7.3 意愿层开关 + §7.4 乙方案的 `revealed`。
//
// 这一层**不 mock `@/services/aiPrivacySettings`**（那些用例钉的是"写没写对键/写失败会不会假确认"），
// 只 mock 底层 `settingsFile`（照 `stores/__tests__/privacy.test.ts` 的做法）：
// 这样"默认关闭"这条断言读的是**真实**的 `AI_SENDING_ENABLED_DEFAULT`，不是一份测试替身的默认值。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const readSetting = vi.hoisted(() => vi.fn());
const writeSetting = vi.hoisted(() => vi.fn(async (_key: string, _value: unknown, _log?: unknown) => {}));

vi.mock("@/services/settingsFile", () => ({ readSetting, writeSetting }));
vi.mock("@/db/userDb", () => ({
  getUserDb: () => null,
  getCurrentUserId: () => "local-1",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async () => null,
}));

// transport：`send` 一旦真的发请求就会调它 ⇒ "关闭时零调用"这条断言必须有它才能钉
const chat = vi.hoisted(() => vi.fn(async () => ({ text: "答", refs: {} })));
vi.mock("@/services/ai/transport", () => ({
  createTransport: () => ({ chat }),
  fetchAiStatus: vi.fn(async () => ({ enabled: true, model: "m", host: "ai.example.com" })),
}));

const runAgent = vi.hoisted(() => vi.fn(async () => ({ text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false })));
vi.mock("@/services/ai/agent", () => ({ runAgent }));

import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";

const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const T0 = "2026-03-01T00:00:00.000Z";

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
  vi.clearAllMocks();
  readSetting.mockResolvedValue({ kind: "absent" });
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("意愿层开关（§7.3）", () => {
  it("① 默认**关闭**：读到 absent 时 store 里是 false", async () => {
    const store = useAiChatStore();
    expect(store.sendingEnabled).toBe(false); // 建 store 那一刻的初值
    await store.loadPrivacySettings();
    // 杀手：把 `AI_SENDING_ENABLED_DEFAULT` 改成 true ⇒ 上面那句变成 true
    expect(store.sendingEnabled).toBe(false);
    expect(readSetting).toHaveBeenCalledWith("ai_sending_enabled", expect.any(Function));
  });

  it("② 打开后**落盘**：写到 `ai_sending_enabled`，且写失败时状态不变（不许假确认）", async () => {
    await useAiChatStore().refreshStatus(); // 拿到 host（开启的硬门槛）
    const store = useAiChatStore();

    await store.setSendingEnabled(true);
    expect(writeSetting).toHaveBeenCalledWith("ai_sending_enabled", true, expect.anything());
    expect(store.sendingEnabled).toBe(true);

    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    // 杀手：`setSendingEnabled` 先改内存再写盘（或吞掉写失败）⇒ 这条红（内存会变成 false）
    await expect(store.setSendingEnabled(false)).rejects.toThrow("disk full");
    expect(store.sendingEnabled).toBe(true);
  });

  it("③ 关闭时 `send` **一个请求都不发**（agent 都不该被调）", async () => {
    setLedger(LEDGER_ID);
    const store = useAiChatStore();
    await store.loadPrivacySettings();
    expect(store.sendingEnabled).toBe(false);

    await store.send("这个月花了多少");

    // 杀手：删掉 `send` 里 `if (!sendingEnabled.value) return;` ⇒ 下面四条全红
    expect(runAgent).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    expect(store.messages).toEqual([]);
    expect(store.sending).toBe(false);
  });

  it("④ 拿不到 `host` 时**不允许开启**（store 层第二道守卫，开关本身由 UI 不渲染）", async () => {
    // 没有 refreshStatus ⇒ status 仍是 null ⇒ host 为 null
    const store = useAiChatStore();
    expect(store.host).toBeNull();

    await store.setSendingEnabled(true);

    // 杀手：去掉 `if (enabled && host.value === null)` 那道守卫 ⇒ `writeSetting` 被调 + 状态变 true
    expect(writeSetting).not.toHaveBeenCalled();
    expect(store.sendingEnabled).toBe(false);
  });

  it("拿不到 host 时**关闭**仍然允许（关永远是安全的一侧）", async () => {
    const store = useAiChatStore();
    await store.setSendingEnabled(false);
    expect(writeSetting).toHaveBeenCalledWith("ai_sending_enabled", false, expect.anything());
  });

  it("说明卡：状态可读、`dismissPrivacyCard` 先落盘再改内存", async () => {
    readSetting.mockImplementation(async (key: string) =>
      key === "ai_privacy_card_seen" ? { kind: "found", value: false } : { kind: "absent" },
    );
    const store = useAiChatStore();
    await store.loadPrivacySettings();
    expect(store.privacyCardSeen).toBe(false);

    await store.dismissPrivacyCard();
    expect(writeSetting).toHaveBeenCalledWith("ai_privacy_card_seen", true, expect.anything());
    expect(store.privacyCardSeen).toBe(true);

    // 写失败 ⇒ 状态**不许**变成"已看过"（否则用户以为记住了，下次又弹）
    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    store.privacyCardSeen = false;
    await expect(store.dismissPrivacyCard()).rejects.toThrow("disk full");
    expect(store.privacyCardSeen).toBe(false);
  });
});

describe("§7.4 乙方案：revealed（本轮主动问出来的）", () => {
  it("本轮 send 出来的两条消息都在 revealed 里；重建 store 后回到遮蔽态", async () => {
    setLedger(LEDGER_ID);
    const store = useAiChatStore();
    await store.loadPrivacySettings();
    await store.refreshStatus();
    await store.setSendingEnabled(true);

    await store.send("这个月花了多少");
    const ids = store.messages.map((m) => m.id);
    expect(ids).toHaveLength(2);
    // 杀手：`runTurn`/`appendAssistant` 里不 `revealed.add(...)` ⇒ 这条红（本轮的消息会被当成历史遮掉）
    for (const id of ids) expect(store.revealed.has(id)).toBe(true);

    // 重建 store（= 重开 App）⇒ 空集合 ⇒ 全部回到遮蔽态（§7.4 的"重开 App 后清空"）
    setActivePinia(createPinia());
    const fresh = useAiChatStore();
    expect(fresh.revealed.size).toBe(0);
    for (const id of ids) expect(fresh.revealed.has(id)).toBe(false);
  });

  it("`revealed` 只活在内存里：任何一次落盘都**不含**消息 id（④）", async () => {
    setLedger(LEDGER_ID);
    const store = useAiChatStore();
    await store.loadPrivacySettings();
    await store.refreshStatus();
    await store.setSendingEnabled(true);
    await store.send("这个月花了多少");
    const ids = store.messages.map((m) => m.id);
    expect(ids).toHaveLength(2);

    // 活的对照：这一路**确实**有落盘发生（否则"没写消息 id"是空转断言）——
    // 上面那次 `setSendingEnabled(true)` 必然调用过 writeSetting
    expect(writeSetting).toHaveBeenCalled();

    const written = JSON.stringify(writeSetting.mock.calls);
    for (const id of ids) {
      // 杀手：把 `revealed` 一起持久化（例如 writeSetting("revealed", [...revealed])) ⇒ 这条红
      expect(written).not.toContain(id);
    }
    // 键名也钉一下：只允许这两个隐私键
    const keys = writeSetting.mock.calls.map((c) => String(c[0]));
    expect(new Set(keys)).toEqual(new Set(["ai_sending_enabled"]));
  });
});
