import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Transaction } from "@/types";

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

const useAuthStoreMock = vi.fn(() => ({
  isOnline: false,
  notifySyncComplete: () => {},
  lastSyncFailed: false,
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => useAuthStoreMock(),
}));

import {
  enqueueSync,
  performSync,
  applyRemoteChanges,
  clearPendingSync,
  setLastSyncedAt,
  getLastSyncedAt,
} from "@/services/sync";

const emptyRemote = {
  ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [],
};

function lastApiFetchBody(apiFetch: unknown): { local_changes: { transactions: { id: string }[] } } {
  const calls = (apiFetch as ReturnType<typeof vi.fn>).mock.calls;
  const lastCall = calls[calls.length - 1];
  return JSON.parse(lastCall[1].body as string);
}

describe("performSync 网络异常不丢变更", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
    useAuthStoreMock.mockReturnValue({ isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false });
  });

  it("apiFetch reject 时回队变更、标记失败且游标不推进", async () => {
    vi.useFakeTimers();
    const authState = { isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false };
    useAuthStoreMock.mockReturnValue(authState);
    setLastSyncedAt("T1");

    const { apiFetch } = await import("@/services/api");
    enqueueSync({ transactions: [{ id: "t1", updated_at: "2026-07-11T00:00:00Z" } as never] });

    // 网络异常：apiFetch 直接 throw（而非返回 {ok:false}）
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error("network down"));

    const result = await performSync();

    expect(result).toBe(false);
    expect(authState.lastSyncFailed).toBe(true); // 不再误报「已同步」
    expect(getLastSyncedAt()).toBe("T1"); // 游标未推进

    // 变更已回队：再次 performSync（apiFetch 成功）应携带 t1
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, status: 200, data: { server_time: "T2", remote_changes: emptyRemote },
    } as never);
    await performSync();

    const body = lastApiFetchBody(apiFetch);
    expect(body.local_changes.transactions.map((t) => t.id)).toContain("t1");

    vi.useRealTimers();
  });
});

describe("clearPendingSync", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
    useAuthStoreMock.mockReturnValue({ isOnline: true, notifySyncComplete: vi.fn(), lastSyncFailed: false });
  });

  it("清空待推送队列后 performSync 不再发送变更", async () => {
    vi.useFakeTimers();
    setLastSyncedAt("T1");

    const { apiFetch } = await import("@/services/api");
    enqueueSync({ transactions: [{ id: "t1", updated_at: "2026-07-11T00:00:00Z" } as never] });

    clearPendingSync();

    vi.mocked(apiFetch).mockResolvedValue({
      ok: true, status: 200, data: { server_time: "T2", remote_changes: emptyRemote },
    } as never);
    await performSync();

    const body = lastApiFetchBody(apiFetch);
    expect(body.local_changes.transactions).toHaveLength(0); // 队列已被清空

    vi.useRealTimers();
  });
});

describe("applyRemoteChanges 标签 LWW", () => {
  beforeEach(() => {
    localStorage.clear();
    getCurrentUserId.mockReturnValue("u1");
    vi.clearAllMocks();
  });

  const txBase: Transaction = {
    id: "tx1", ledger_id: "L1", user_id: "u1", amount: 10, type: "expense",
    from_account_id: null, to_account_id: null, category_id: null, note: null,
    occurred_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", is_deleted: false,
  };

  it("远端流水更旧时不清空本地标签", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    // 本地 updated_at 更新（T2）
    const select = vi.fn().mockResolvedValue([{ updated_at: "2026-07-12T00:00:00Z" }]);
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    await applyRemoteChanges({
      ...emptyRemote,
      transactions: [{ ...txBase, updated_at: "2026-07-11T00:00:00Z", tag_ids: ["old-tag"] }],
    });

    // 远端更旧：不应重建标签（不清空本地较新的标签改动）
    const deleteTagCalls = execute.mock.calls.filter((c) => String(c[0]).includes("DELETE FROM transaction_tags"));
    expect(deleteTagCalls).toHaveLength(0);
  });

  it("远端更新且无标签时应清空本地标签", async () => {
    const execute = vi.fn().mockResolvedValue({ rowsAffected: 1 });
    const select = vi.fn().mockResolvedValue([{ updated_at: "2026-07-10T00:00:00Z" }]); // 本地更旧
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValue({ select, execute } as never);

    await applyRemoteChanges({
      ...emptyRemote,
      transactions: [{ ...txBase, updated_at: "2026-07-11T00:00:00Z" }], // 无 tag_ids → 后端 omitempty 空数组
    });

    // 远端标签缺失应视作空，清空本地关联
    const deleteTagCalls = execute.mock.calls.filter((c) => String(c[0]).includes("DELETE FROM transaction_tags"));
    expect(deleteTagCalls).toHaveLength(1);
  });
});
