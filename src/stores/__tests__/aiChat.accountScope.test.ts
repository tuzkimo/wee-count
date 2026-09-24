// 团队账本里 AI 记账的**账户作用域**（实机缺陷：账本里两个人各有一个「现金」，AI 收到的是
// 无法区分的账户清单，用户说"用我的"也没用）。
//
// 本文件钉 store 这一侧的两件事（工具/SQL 那一侧在 `services/ai/__tests__/accountScope.test.ts`）：
//   1. 提示词快照（§7.1）里的账户只含**当前用户自己的** —— 这是"AI 收到的账户清单"的正文；
//   2. `runAgent` 拿到 `currentUserId` —— 没有它，解析表那侧的 owner 过滤无从下手
//      （`buildLookupContext` 是服务层，不依赖 Vue、拿不到当前用户）。
//
// 口径照 `useTransactionForm:46-54` / `DraftCard.vue:178-184`：**只在团队账本里**按 owner_id 过滤，
// 当前用户身份取 `auth.currentLocalUser?.server_user_id || getCurrentUserId() || ""`。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const state = vi.hoisted(() => ({ teamMembers: [] as unknown[] }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return {
    ...actual,
    getUserDb: () => null,
    getCurrentUserId: () => "local-1",
    getTeamMembers: vi.fn(async () => state.teamMembers as never),
  };
});

// 只换 runAgent：要验的是"store 传了什么"，不是 agent 的行为
vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, type AgentTurn } from "@/services/ai/agent";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import type { Account, Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const ACC_MINE = "22222222-2222-4222-8222-222222222222";
const ACC_OTHER = "66666666-6666-4666-8666-666666666666";

function acct(over: Partial<Account> = {}): Account {
  return {
    id: ACC_MINE, ledger_id: LEDGER_ID, owner_id: "local-1", name: "现金", type: "cash",
    initial_balance: 0, color: "#000", created_at: T0, updated_at: T0, is_deleted: false, ...over,
  };
}

function setLedger(id: string, over: Partial<Ledger> = {}): void {
  const ledgerStore = useLedgerStore();
  ledgerStore.ledgers = [
    {
      id, name: "家", type: "personal", team_id: null, owner_id: "local-1",
      created_at: T0, updated_at: T0, is_deleted: false, ...over,
    },
  ];
  ledgerStore.currentLedgerId = id;
}

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
}

/** 建 store 并打开 §7.3 的意愿层门控（默认关闭 ⇒ 不打开的话 `send` 一个请求都不发） */
function openGate(): ReturnType<typeof useAiChatStore> {
  const store = useAiChatStore();
  store.sendingEnabled = true;
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.teamMembers = [];
  setActivePinia(createPinia());
  vi.mocked(runAgent).mockResolvedValue(turn({ text: "答" }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("团队账本：AI 的账户清单只含当前用户自己的账户", () => {
  it("快照 accounts 只有我的「现金」（别人那份同名账户不进提示词）", async () => {
    setLedger(LEDGER_ID, { type: "team", team_id: "T1" });
    const store = openGate();
    useAccountStore().accounts = [
      acct({ id: ACC_MINE, owner_id: "local-1", name: "现金" }),
      acct({ id: ACC_OTHER, owner_id: "u-ming", name: "现金" }),
    ];

    await store.send("记一笔 12 块的菜，用我的现金");

    // 改哪一行能让它红：`stores/aiChat.ts` 的 `buildSnapshot` 里那条 owner 过滤
    // （去掉它 ⇒ 这里变成两份「现金」，模型又拿到无法区分的清单）。
    const args = vi.mocked(runAgent).mock.calls[0]![0];
    expect(args.snapshot.accounts).toEqual([{ name: "现金", type: "现金" }]);
    // 同一条规则的**另一半**：解析表那侧的过滤要靠这个 id（服务层拿不到当前用户身份）
    expect(args.currentUserId).toBe("local-1");
  });

  it("guard：个人账本不过滤（账户全是我自己的，照 useTransactionForm 的口径）", async () => {
    setLedger(LEDGER_ID); // personal
    const store = openGate();
    useAccountStore().accounts = [
      acct({ id: ACC_MINE, owner_id: "local-1", name: "现金" }),
      acct({ id: ACC_OTHER, owner_id: "u-ming", name: "小金库" }),
    ];

    await store.send("记一笔 12 块的菜");

    const args = vi.mocked(runAgent).mock.calls[0]![0];
    expect(args.snapshot.accounts.map((a) => a.name)).toEqual(["现金", "小金库"]);
  });
});
