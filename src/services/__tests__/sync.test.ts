import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getCurrentUserId = vi.fn<(typeof import("@/db/userDb"))["getCurrentUserId"]>(() => null);

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

// performSyncIfOnline 动态 import auth store 读 isOnline
interface AuthStoreLike {
  isOnline: boolean;
  notifySyncComplete: () => void;
  lastSyncFailed: boolean;
}
const useAuthStoreMock = vi.fn<() => AuthStoreLike>(() => ({
  isOnline: false,
  notifySyncComplete: () => {},
  lastSyncFailed: false,
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => useAuthStoreMock(),
}));

import { enqueueSync, clearPendingSync, getLastSyncedAt, setLastSyncedAt, toIsoTimestamp, compareTimestamp, mergeChanges } from "@/services/sync";
import type { SyncPayload } from "@/services/sync";

describe("sync cursor is per-user", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReset();
  });

  it("separate local users keep independent last_synced_at cursors", () => {
    // user1 syncs, cursor advances to T1
    getCurrentUserId.mockReturnValue("user-1");
    setLastSyncedAt("1");

    // switch to user2 — must NOT inherit user1's cursor
    getCurrentUserId.mockReturnValue("user-2");
    expect(getLastSyncedAt()).toBeNull();
    setLastSyncedAt("2");

    // switch back to user1 — cursor must still be T1, not advanced by user2
    getCurrentUserId.mockReturnValue("user-1");
    expect(getLastSyncedAt()).toBe("1");

    // user2's cursor stays T2
    getCurrentUserId.mockReturnValue("user-2");
    expect(getLastSyncedAt()).toBe("2");
  });
});

describe("toIsoTimestamp", () => {
  it("normalizes SQLite datetime('now') format to RFC3339", () => {
    // datetime('now') 产出 "YYYY-MM-DD HH:MM:SS"（UTC），Go time.Time 无法解析
    expect(toIsoTimestamp("2026-07-10 02:31:59")).toBe("2026-07-10T02:31:59Z");
  });

  it("preserves fractional seconds from datetime('now','subsec')", () => {
    expect(toIsoTimestamp("2026-07-10 02:31:59.123")).toBe("2026-07-10T02:31:59.123Z");
  });

  it("leaves already-ISO timestamps untouched", () => {
    const iso = "2026-07-10T02:31:59.123Z";
    expect(toIsoTimestamp(iso)).toBe(iso);
  });
});

describe("compareTimestamp", () => {
  it("空格格式与 ISO 格式按真实时间比较，而非字典序", () => {
    // " " (0x20) < "T" (0x54)：字典序会把空格格式误判为「更旧」
    const space = "2026-07-10 02:31:59";      // 等价 ISO 2026-07-10T02:31:59Z
    const iso = "2026-07-10T02:30:00Z";
    expect(compareTimestamp(space, iso)).toBeGreaterThan(0);
  });
  it("相等时间返回 0", () => {
    expect(compareTimestamp("2026-07-10T02:31:59Z", "2026-07-10 02:31:59")).toBe(0);
  });
});

describe("mergeChanges LWW", () => {
  it("空格格式与 ISO 格式按真实时间比较，保留较新者", () => {
    const target: SyncPayload = {
      ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
    };
    // 先入队较旧者（ISO），再入队较新者（空格格式，等价 ISO 2026-07-10T02:31:59Z）
    mergeChanges(target, {
      transactions: [{ id: "t1", updated_at: "2026-07-10T02:30:00Z" } as never],
    });
    mergeChanges(target, {
      transactions: [{ id: "t1", updated_at: "2026-07-10 02:31:59" } as never],
    });

    expect(target.transactions[0].updated_at).toBe("2026-07-10 02:31:59");
  });
});

describe("enqueueSync 降级模式", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
    useAuthStoreMock.mockReturnValue({
      isOnline: false,
      notifySyncComplete: vi.fn(),
      lastSyncFailed: false,
    });
  });

  it("isOnline=false 时入队但不触发 performSync（避免降级期 401 风暴）", async () => {
    // 回归：绑定在线但会话未恢复时，旧实现每条本地写都 3s 后打一次 /sync，
    // 全部 401→refresh 失败→重新入队。改造后非 online 不推，变更留待恢复后统一推。
    vi.useFakeTimers();
    const { apiFetch } = await import("@/services/api");

    enqueueSync({
      transactions: [{ id: "t1", updated_at: "2026-07-11T00:00:00Z" } as never],
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(apiFetch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("isOnline=true 时正常触发 performSync", async () => {
    useAuthStoreMock.mockReturnValue({
      isOnline: true,
      notifySyncComplete: vi.fn(),
      lastSyncFailed: false,
    });
    vi.useFakeTimers();
    // 设游标让 performSync 走 /sync 分支而非 firstFullSync
    setLastSyncedAt("1");
    const { apiFetch } = await import("@/services/api");
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, data: { server_seq: 2, remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] } },
    });

    enqueueSync({
      transactions: [{ id: "t2", updated_at: "2026-07-11T00:00:00Z" } as never],
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(apiFetch).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("performSync 健壮性", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
  });

  // 失败路径会 scheduleRetry() 武装真实 setTimeout（本 describe 不用 fake timers），
  // 必须在收尾清理，否则活着的定时器会在后续用例/收尾时触发，甚至级联出新的 scheduleRetry。
  afterEach(() => {
    clearPendingSync();
  });

  it("applyRemoteChanges 抛异常时游标不推进且 lastSyncFailed 置位", async () => {
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);

    setLastSyncedAt("1");
    const { apiFetch } = await import("@/services/api");
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        server_seq: 2,
        remote_changes: {
          ledgers: [{ id: "l1", name: "x", type: "team", owner_id: null, team_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
          accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
        },
      },
    } as never);

    // 让 applyRemoteChanges 内部的 db.select reject，模拟外键违反抛异常
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({
      select: vi.fn().mockRejectedValue(new Error("FOREIGN KEY constraint failed")),
      execute: vi.fn(),
    } as never);

    const { performSync } = await import("@/services/sync");
    await performSync();

    expect(authState.lastSyncFailed).toBe(true);
    expect(getLastSyncedAt()).toBe("1"); // 游标未推进
  });
});

describe("performSync 失败自动重试", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
    clearPendingSync(); // 重置模块级 retryAttempt 与泄漏的 syncTimer，避免上一用例影响退避时长
  });

  it("网络异常失败后，退避后重新触发 performSync", async () => {
    vi.useFakeTimers();
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);
    setLastSyncedAt("1");
    const { apiFetch } = await import("@/services/api");
    // 第一次失败，第二次成功
    (apiFetch as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { server_seq: 2, remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] } } });

    const { performSync } = await import("@/services/sync");
    await performSync(); // 失败
    expect(authState.lastSyncFailed).toBe(true);

    await vi.advanceTimersByTimeAsync(5000); // 触发第一次退避重试
    expect(apiFetch).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("applyRemoteChanges 幂等", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
  });

  it("补拉与增量返回同一父行（updated_at 相等）时跳过 UPDATE", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    const select = vi.fn().mockResolvedValue([{ updated_at: "2026-01-01T00:00:00Z" }]);
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    const { applyRemoteChanges } = await import("@/services/sync");
    await applyRemoteChanges({
      ledgers: [{ id: "l1", name: "x", type: "team", owner_id: "u1", team_id: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_deleted: false }],
      accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
    });

    // select 返回 updated_at 相等的本地记录 → 不应执行任何 UPDATE / INSERT
    const writeCalls = execute.mock.calls.filter((c) => {
      const sql = c[0] as string;
      return sql.startsWith("UPDATE") || sql.startsWith("INSERT");
    });
    expect(writeCalls).toHaveLength(0);
  });

  it("同名标签应改指关联并删除本地旧标签，避免 UNIQUE 冲突", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    const select = vi.fn()
      .mockResolvedValueOnce([])                    // tags 按 id 查：不存在
      .mockResolvedValueOnce([{ id: "local-dup" }]); // 同名标签命中
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    const { applyRemoteChanges } = await import("@/services/sync");
    await applyRemoteChanges({
      ledgers: [], accounts: [],
      tags: [{ id: "remote-tag", ledger_id: "L1", name: "餐饮", updated_at: "2026-07-11T00:00:00Z", is_deleted: false }],
      categories: [], transactions: [], member_aliases: [],
    });

    // 断言：改指 transaction_tags.tag_id、DELETE 旧 tag、INSERT 新 tag
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE transaction_tags SET tag_id"),
      expect.anything()
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM tags"),
      expect.anything()
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tags"),
      expect.anything()
    );
  });

  it("软删同名标签也应命中去重，避免 UNIQUE(ledger_id,name) 冲突导致同步卡死", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    const select = vi.fn()
      .mockResolvedValueOnce([])                    // tags 按 id 查：不存在
      .mockResolvedValueOnce([{ id: "soft-deleted" }]); // 同名标签命中（软删行也占用唯一键）
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    const { applyRemoteChanges } = await import("@/services/sync");
    await applyRemoteChanges({
      ledgers: [], accounts: [],
      tags: [{ id: "remote-tag", ledger_id: "L1", name: "餐饮", updated_at: "2026-07-11T00:00:00Z", is_deleted: false }],
      categories: [], transactions: [], member_aliases: [],
    });

    // 去重查询不再过滤 is_deleted，软删行也能命中
    const dupSelect = select.mock.calls.find((c) => String(c[0]).includes("FROM tags WHERE ledger_id"));
    expect(dupSelect).toBeTruthy();
    expect(String(dupSelect![0])).not.toContain("is_deleted");

    // 命中后改指 + 删除软删行 + 插入新标签
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM tags"),
      expect.anything()
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tags"),
      expect.anything()
    );
  });

  it("远端交易合并时保留 note 字段", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1, lastInsertId: 1 });
    const select = vi.fn().mockResolvedValue([]); // 本地不存在 → INSERT
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    const { applyRemoteChanges } = await import("@/services/sync");
    await applyRemoteChanges({
      ledgers: [], accounts: [], tags: [], categories: [],
      transactions: [{
        id: "t1", ledger_id: "L1", user_id: "u1", amount: 10, type: "expense",
        from_account_id: null, to_account_id: null, category_id: null,
        note: "午餐", occurred_at: "2026-07-11T00:00:00Z", created_at: "2026-07-11T00:00:00Z",
        updated_at: "2026-07-11T00:00:00Z", is_deleted: false,
      }],
      member_aliases: [],
    });

    const insertCall = execute.mock.calls.find((c) => String(c[0]).startsWith("INSERT INTO transactions"));
    expect(insertCall).toBeTruthy();
    expect(String(insertCall![0])).toContain("note");
  });
});

describe("performSync 互斥（重入保护）", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
    clearPendingSync();
  });

  afterEach(() => {
    clearPendingSync();
  });

  it("在途同步期间再次调用返回 false，且完成后补跑积压的同步", async () => {
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);
    setLastSyncedAt("1");

    const { apiFetch } = await import("@/services/api");
    const okResp = (server_seq: number) => ({
      ok: true,
      status: 200,
      data: { server_seq, remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] } },
    });
    let resolveFirst!: (v: unknown) => void;
    const gate = new Promise((res) => { resolveFirst = res; });
    vi.mocked(apiFetch)
      .mockReturnValueOnce(gate as never)          // 第一次（在途，挂起）
      .mockResolvedValue(okResp(3) as never);   // 补跑（第二次）

    const { performSync } = await import("@/services/sync");
    const first = performSync();
    const second = performSync();

    // 第二次在途调用被跳过
    expect(await second).toBe(false);

    // 第一次在途 sync 最终只打一次 apiFetch（此时仍在途）
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    // 第一次完成 → finally 里 syncQueued 触发补跑
    resolveFirst(okResp(2));
    await first;

    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
  });
});

describe("同步队列按 uid 隔离", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    clearPendingSync();
  });

  afterEach(() => {
    clearPendingSync();
  });

  const okResp = {
    ok: true,
    status: 200,
    data: {
      server_seq: 2,
      remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] },
    },
  };

  function captureApiBody(apiFetchMock: ReturnType<typeof vi.fn>): { local_changes: { transactions: { id: string }[] } } {
    const opts = apiFetchMock.mock.calls[0][1] as { body: string };
    return JSON.parse(opts.body) as { local_changes: { transactions: { id: string }[] } };
  }

  it("resetSyncTimers 保留队列，登出后同 uid 重新登录仍恢复推送", async () => {
    getCurrentUserId.mockReturnValue("u1");
    useAuthStoreMock.mockReturnValue({ isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false });
    setLastSyncedAt("1");

    const { apiFetch } = await import("@/services/api");
    const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
    apiFetchMock.mockResolvedValue(okResp);

    enqueueSync({ transactions: [{ id: "t1", updated_at: "2026-07-11T00:00:00Z" } as never] });

    const { resetSyncTimers, performSync } = await import("@/services/sync");
    resetSyncTimers(); // 登出：只停定时器，保留队列
    await performSync(); // 重新登录为 u1 并同步

    expect(apiFetchMock).toHaveBeenCalled();
    expect(captureApiBody(apiFetchMock).local_changes.transactions.map((t) => t.id)).toEqual(["t1"]);
  });

  it("A 积压的变更不会串到 B 账号", async () => {
    useAuthStoreMock.mockReturnValue({ isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false });
    const { apiFetch } = await import("@/services/api");
    const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
    apiFetchMock.mockResolvedValue(okResp);

    getCurrentUserId.mockReturnValue("u1");
    setLastSyncedAt("1");
    enqueueSync({ transactions: [{ id: "t1", updated_at: "2026-07-11T00:00:00Z" } as never] });

    getCurrentUserId.mockReturnValue("u2");
    setLastSyncedAt("1");
    enqueueSync({ transactions: [{ id: "t2", updated_at: "2026-07-11T00:00:00Z" } as never] });

    const { performSync } = await import("@/services/sync");
    await performSync(); // 当前 uid = u2

    expect(captureApiBody(apiFetchMock).local_changes.transactions.map((t) => t.id)).toEqual(["t2"]);
  });

  it("队列持久化到 localStorage，clearPendingSync 清空", () => {
    getCurrentUserId.mockReturnValue("u1");
    enqueueSync({ transactions: [{ id: "t1", updated_at: "2026-07-11T00:00:00Z" } as never] });
    expect(localStorage.getItem("pending_sync:u1")).toBeTruthy();

    clearPendingSync();
    expect(localStorage.getItem("pending_sync:u1")).toBeNull();
  });
});
