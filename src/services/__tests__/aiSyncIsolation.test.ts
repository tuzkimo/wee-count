import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 同步 / 备份隔离：AI 会话两张表**绝不能**进同步，也绝不能进备份。
 *
 * 四条断言全部是**行为级**的（不读源码文本）：要么调真实函数看它的返回值/发出的 SQL，
 * 要么调真实函数看它有没有发 AI 表的 SQL。每条都能回答"改哪一行会让它红"，见各自的注释。
 */
const getCurrentUserId = vi.fn(() => "u1");

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(),
  getCurrentUserId: () => getCurrentUserId(),
  getMemberAlias: vi.fn(),
  setMemberAlias: vi.fn(),
  getMemberAliases: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  hasBaseUrl: vi.fn(() => true),
}));

const useAuthStoreMock = vi.fn(() => ({
  isOnline: true,
  notifySyncComplete: vi.fn(),
  lastSyncFailed: false,
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => useAuthStoreMock(),
}));

import { emptyPayload, performSync, applyRemoteChanges, setLastSyncedAt, clearPendingSync } from "@/services/sync";
import type { SyncPayload } from "@/services/sync";
import { firstFullSync } from "@/services/migration";

/**
 * 同步契约的 6 张表 —— 在测试里**独立列一份**（golden），而不是从 `SyncPayload` 的类型反推：
 * 这份副本就是哨兵，往 `emptyPayload()` /  push 体里加表必须同时改这里，不能悄悄加。
 */
const SYNC_KEYS = ["ledgers", "accounts", "tags", "categories", "transactions", "member_aliases"];

beforeEach(() => {
  localStorage.clear();
  getCurrentUserId.mockReturnValue("u1");
  vi.clearAllMocks();
  useAuthStoreMock.mockReturnValue({ isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false });
});

// 失败路径会武装真实的退避 setTimeout，收尾必须清掉，否则定时器泄漏到别的用例
afterEach(() => {
  clearPendingSync();
});

describe("① 同步 payload 的键集被钉死", () => {
  it("emptyPayload() 恰为那 6 个键 —— 加任何一张新表都会红", () => {
    // 变异：`return { ...6 键, ai_conversations: [] }` → 7 个键，本条红
    expect(Object.keys(emptyPayload())).toEqual(SYNC_KEYS);
  });
});

/**
 * ② 备份白名单（§8.F 的备份半边）**不在这里重复抄 9 张表的 golden**：
 * 那条不变量由 `src/services/backup/__tests__/types.test.ts:61-67` 守卫（同一份 9 表清单，含顺序）。
 * 实测两处断言的变异 kill set 完全重合（往 `BACKUP_TABLES` 加 `"ai_messages"` 同时杀掉两边）
 * ⇒ 抄第二份只是维护陷阱：将来合法新增一张备份表要改两处，且没人知道该改哪处（Ruling 10）。
 */

describe("③ push 请求体不带 AI 表", () => {
  it("POST /sync 的 local_changes 键恰为那 6 个", async () => {
    const { apiFetch } = await import("@/services/api");
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select: vi.fn().mockResolvedValue([]), execute: vi.fn() } as never);
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, status: 200, data: { server_seq: 2, remote_changes: emptyPayload() },
    } as never);

    setLastSyncedAt("1"); // 有游标 ⇒ 走增量 push 分支（而不是 firstFullSync）
    await performSync();

    const opts = vi.mocked(apiFetch).mock.calls[0]![1] as { body: string };
    const body = JSON.parse(opts.body) as { local_changes: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["last_server_seq", "local_changes"]);
    // 变异：emptyPayload() 里加 ai_conversations → 请求体多一个键，本条红（服务端会拒或静默丢）
    expect(Object.keys(body.local_changes)).toEqual(SYNC_KEYS);
  });
});

describe("④ pull 不写 AI 表", () => {
  it("applyRemoteChanges 处理含 AI 键的 payload 时，一条 ai_ 的 SQL 都不发", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const select = vi.fn().mockResolvedValue([]);
    const db = { select, execute };

    // 6 键 payload，**每张表都放一行**：否则那些 for 循环整体空转，
    // "没有 ai_ 的 SQL" 就变成恒真断言（什么都不做当然不发 SQL）。
    const remote = {
      ledgers: [{ id: "l1", name: "x", type: "personal", owner_id: "u1", team_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      accounts: [{ id: "a1", ledger_id: "l1", owner_id: "u1", name: "现金", type: "cash", category: "asset", initial_balance: 0, credit_limit: null, repayment_day: null, color: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      tags: [{ id: "t1", ledger_id: "l1", name: "盒马", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      categories: [{ id: "c1", ledger_id: "l1", owner_id: "u1", name: "餐饮", type: "expense", icon: null, sort_order: 0, updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      transactions: [{ id: "tx1", ledger_id: "l1", user_id: "u1", amount: 10, type: "expense", from_account_id: null, to_account_id: null, category_id: null, note: null, occurred_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      member_aliases: [{ setter_user_id: "srv1", target_user_id: "u2", alias_name: "老婆", updated_at: "2026-01-01T00:00:00Z" }],
      // 哨兵：远端多塞了两把 AI 表（协议之外的键）。谁把这两张表接进 applyRemoteChanges，下面的断言立刻红。
      ai_conversations: [{ id: "c1", ledger_id: "l1", title: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: 0 }],
      ai_messages: [{ id: "m1", conversation_id: "c1", role: "user", content: "hi", payload: null, created_at: "2026-01-01T00:00:00Z" }],
    };

    await applyRemoteChanges(remote as unknown as SyncPayload, db as never, "u1", "srv1");

    const sqls = execute.mock.calls.map((c) => String(c[0]));
    // 先证明这一跑真的写了库：没有它，"没有 ai_ 的 SQL"在"整个函数早退"时也成立 —— 空转
    expect(sqls.some((s) => s.includes("INSERT INTO ledgers"))).toBe(true);
    expect(sqls.some((s) => s.includes("INSERT INTO transactions"))).toBe(true);
    expect(sqls.filter((s) => /ai_conversations|ai_messages/.test(s))).toEqual([]);
  });
});

describe("⑤ firstFullSync 不读 AI 表", () => {
  it("首次全量同步发出的 SELECT 里没有任何 ai_ 表", async () => {
    const select = vi.fn().mockResolvedValue([]);
    const execute = vi.fn().mockResolvedValue({});
    const db = { select, execute };
    const { apiFetch } = await import("@/services/api");
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, status: 200, data: { server_seq: 1, remote_changes: emptyPayload() },
    } as never);

    await firstFullSync("u1", db as never, "srv1");

    const sqls = select.mock.calls.map((c) => String(c[0]));
    // 变异：在 firstFullSync 里加 `await db.select('SELECT * FROM ai_conversations …')` → 下面的 filter 非空，本条红
    expect(sqls.length).toBeGreaterThanOrEqual(6); // ledgers/accounts/categories/tags/transactions/transaction_tags
    expect(sqls.filter((s) => /ai_/.test(s))).toEqual([]);
  });
});
