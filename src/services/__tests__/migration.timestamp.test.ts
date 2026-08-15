import { describe, it, expect, vi, beforeEach } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock("@/services/api", () => ({
  apiFetch: apiFetchMock,
  hasBaseUrl: vi.fn(() => true),
}));

const mockDb = { select: vi.fn(), execute: vi.fn() };
vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
  getCurrentUserId: vi.fn(() => "u1"),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(() => ({ notifySyncComplete: vi.fn() })),
}));

import { firstFullSync } from "@/services/migration";

describe("firstFullSync 时间戳归一化", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("将 datetime('now') 空格格式归一化为 ISO 后上传", async () => {
    mockDb.select.mockImplementation((sql: string) => {
      if (sql.includes("FROM ledgers")) {
        return Promise.resolve([{ id: "l1", name: "x", type: "personal", owner_id: "u1", team_id: null, created_at: "2026-07-10 02:31:59", updated_at: "2026-07-10 02:31:59", is_deleted: 0 }]);
      }
      // accounts/categories/tags/transactions/transaction_tags 一律返回空
      return Promise.resolve([]);
    });
    apiFetchMock.mockResolvedValue({ ok: true, status: 200, data: { server_seq: 2, remote_changes: { ledgers: [], accounts: [], tags: [], categories: [], transactions: [] } } });

    await firstFullSync();

    const body = JSON.parse(apiFetchMock.mock.calls[0][1].body);
    expect(body.local_changes.ledgers[0].updated_at).toBe("2026-07-10T02:31:59Z");
    expect(body.local_changes.ledgers[0].created_at).toBe("2026-07-10T02:31:59Z");
  });
});
