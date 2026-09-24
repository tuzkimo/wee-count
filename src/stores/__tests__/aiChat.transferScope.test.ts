// 提示词快照里的账户**分组**（人类确认：转出只能本人账户、转入可以用所有人的账户）。
//
// 转入放开之后，池子里同时有"我的现金"和小明的现金 —— 如果快照还只印一列名字，
// 模型又会拿到无法区分的清单（同名缺陷在转入这条路上复发）。所以快照分两组：
//   `accounts`      = 我自己的账户，名字**不带**归属（转出/筛选只用这一组）
//   `otherAccounts` = 其他成员的账户，名字带归属（`小明的现金`），**只**可作转账的转入方
// 两组名字与解析表里那些名字**逐字相同**（`otherAccountLabel`）—— 模型照着快照写，解析表才有唯一匹配。
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

vi.mock("@/services/ai/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/agent")>();
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent, type AgentTurn } from "@/services/ai/agent";
import { buildSystemPrompt } from "@/services/ai/prompt";
import { useAiChatStore } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import type { Account, Ledger } from "@/types";

const T0 = "2026-03-01T00:00:00.000Z";
const LEDGER_ID = "55555555-5555-4555-8555-555555555555";
const ACC_MINE = "22222222-2222-4222-8222-222222222222";
const ACC_MING = "66666666-6666-4666-8666-666666666666";

function acct(over: Partial<Account> = {}): Account {
  return {
    id: ACC_MINE, ledger_id: LEDGER_ID, owner_id: "local-1", name: "现金", type: "cash",
    initial_balance: 0, color: "#000", created_at: T0, updated_at: T0, is_deleted: false, ...over,
  };
}

function setTeamLedger(): void {
  const ledgerStore = useLedgerStore();
  const ledger: Ledger = {
    id: LEDGER_ID, name: "家", type: "team", team_id: "T1", owner_id: "local-1",
    created_at: T0, updated_at: T0, is_deleted: false,
  };
  ledgerStore.ledgers = [ledger];
  ledgerStore.currentLedgerId = LEDGER_ID;
}

function turn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { text: "答", chips: [], drafts: [], refs: {}, trace: [], aborted: false, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  state.teamMembers = [
    { team_id: "T1", user_id: "local-1", username: "me", nickname: "我", avatar_url: null, role: "owner", updated_at: T0 },
    { team_id: "T1", user_id: "u-ming", username: "ming", nickname: "小明", avatar_url: null, role: "member", updated_at: T0 },
  ];
  vi.mocked(runAgent).mockResolvedValue(turn({ text: "答" }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function snapshotOfTeamLedger() {
  setTeamLedger();
  const store = useAiChatStore();
  store.sendingEnabled = true;
  useAccountStore().accounts = [
    acct({ id: ACC_MINE, owner_id: "local-1", name: "现金" }),
    acct({ id: ACC_MING, owner_id: "u-ming", name: "现金" }),
  ];
  await store.send("转 100 到小明的现金");
  return vi.mocked(runAgent).mock.calls[0]![0].snapshot;
}

describe("团队账本：快照把「我的账户」与「其他成员的账户」分两组", () => {
  it("本人账户不加归属，别人的账户带归属（且只出现在第二组）", async () => {
    const snapshot = await snapshotOfTeamLedger();

    // 改哪一行能让它红：`buildSnapshot` 里那句"其他成员账户"的组装
    // （去掉它 ⇒ 转入这条路又变成"模型只看得到我的账户"，上一轮的同名歧义换一副面孔复发）。
    expect(snapshot.accounts).toEqual([{ name: "现金", type: "现金" }]);
    expect(snapshot.otherAccounts).toEqual([{ name: "小明的现金", type: "现金" }]);
  });

  it("渲染进 prompt 的两组名字与解析表逐字相同（模型抄得快照里的名字）", async () => {
    const snapshot = await snapshotOfTeamLedger();
    const prompt = buildSystemPrompt(snapshot, new Date(2026, 2, 15));

    expect(prompt).toContain("现金(现金)");
    expect(prompt).toContain("小明的现金(现金)");
    // 本人的账户**不加**归属：写成「我的现金」的话，模型会照抄一个解析表里不存在的名字
    // （那条路只能靠包含匹配兜住），而且"我的账户"这一组就失去了"这是你的"的含义。
    expect(prompt).not.toContain("我的现金");
  });
});
