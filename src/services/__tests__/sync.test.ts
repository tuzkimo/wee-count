import { describe, it, expect, vi, beforeEach } from "vitest";

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

import { enqueueSync, clearPendingSync, getLastSyncedAt, setLastSyncedAt, toIsoTimestamp, compareTimestamp } from "@/services/sync";

describe("sync cursor is per-user", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReset();
  });

  it("separate local users keep independent last_synced_at cursors", () => {
    // user1 syncs, cursor advances to T1
    getCurrentUserId.mockReturnValue("user-1");
    setLastSyncedAt("T1");

    // switch to user2 — must NOT inherit user1's cursor
    getCurrentUserId.mockReturnValue("user-2");
    expect(getLastSyncedAt()).toBeNull();
    setLastSyncedAt("T2");

    // switch back to user1 — cursor must still be T1, not advanced by user2
    getCurrentUserId.mockReturnValue("user-1");
    expect(getLastSyncedAt()).toBe("T1");

    // user2's cursor stays T2
    getCurrentUserId.mockReturnValue("user-2");
    expect(getLastSyncedAt()).toBe("T2");
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
    setLastSyncedAt("T1");
    const { apiFetch } = await import("@/services/api");
    (apiFetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, status: 200, data: { server_time: "T2", remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] } },
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

  it("applyRemoteChanges 抛异常时游标不推进且 lastSyncFailed 置位", async () => {
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);

    setLastSyncedAt("T1");
    const { apiFetch } = await import("@/services/api");
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        server_time: "T2",
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
    expect(getLastSyncedAt()).toBe("T1"); // 游标未推进
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
    setLastSyncedAt("T1");
    const { apiFetch } = await import("@/services/api");
    // 第一次失败，第二次成功
    (apiFetch as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { server_time: "T2", remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] } } });

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
});
