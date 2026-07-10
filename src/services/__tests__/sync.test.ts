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

import { getLastSyncedAt, setLastSyncedAt, toIsoTimestamp } from "@/services/sync";

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
