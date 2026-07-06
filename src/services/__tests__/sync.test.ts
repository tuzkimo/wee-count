import { describe, it, expect, vi, beforeEach } from "vitest";

const getCurrentUserId = vi.fn<(typeof import("@/db/userDb"))["getCurrentUserId"]>(() => null);

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(),
  getCurrentUserId: () => getCurrentUserId(),
}));

vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  hasBaseUrl: vi.fn(() => true),
}));

import { getLastSyncedAt, setLastSyncedAt } from "@/services/sync";

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
