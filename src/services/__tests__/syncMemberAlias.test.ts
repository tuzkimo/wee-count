import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(),
  getCurrentUserId: vi.fn(() => "local-user-1"),
  getMemberAliases: vi.fn(),
  getMemberAlias: vi.fn(),
  setMemberAlias: vi.fn(),
  openUserDb: vi.fn(),
  closeUserDb: vi.fn(),
}));
vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  hasBaseUrl: vi.fn(() => true),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(() => ({ currentLocalUser: { server_user_id: "server-me" } })),
}));

import { collectMemberAliasesForSync } from "@/services/sync";
import { getMemberAliases } from "@/db/userDb";

describe("collectMemberAliasesForSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stamps setter_user_id with server user id", async () => {
    (getMemberAliases as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { target_user_id: "u-other", alias_name: "阿明", updated_at: "2026-07-07T00:00:00Z" },
    ]);
    const out = await collectMemberAliasesForSync();
    expect(out).toHaveLength(1);
    expect(out[0].setter_user_id).toBe("server-me");
    expect(out[0].target_user_id).toBe("u-other");
    expect(out[0].alias_name).toBe("阿明");
  });
});
