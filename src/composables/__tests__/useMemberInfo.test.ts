import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const mockGetMemberAlias = vi.fn();
const mockGetTeamMembers = vi.fn();

vi.mock("@/db/userDb", () => ({
  getMemberAlias: (...a: unknown[]) => mockGetMemberAlias(...a),
  getTeamMembers: (...a: unknown[]) => mockGetTeamMembers(...a),
  getCurrentUserId: vi.fn(() => "local-me"),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    currentLocalUser: {
      server_user_id: "server-me",
      avatar_url: "🐱",
      nickname: "我本人",
    },
  }),
}));

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ currentLedger: { team_id: "t1" } }),
}));

import { useMemberInfo } from "@/composables/useMemberInfo";

describe("useMemberInfo.getMember", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockGetMemberAlias.mockReset();
    mockGetTeamMembers.mockReset();
  });

  it("returns '我' for self", async () => {
    const { getMember } = useMemberInfo();
    const r = await getMember("server-me");
    expect(r.displayName).toBe("我");
    expect(r.avatarUrl).toBe("🐱");
  });

  it("prefers alias over nickname/username", async () => {
    mockGetMemberAlias.mockResolvedValueOnce({ target_user_id: "u2", alias_name: "阿明", updated_at: "" });
    mockGetTeamMembers.mockResolvedValueOnce([
      { team_id: "t1", user_id: "u2", username: "alice", nickname: "Alice", avatar_url: null, role: "member", updated_at: "" },
    ]);
    const { getMember } = useMemberInfo();
    const r = await getMember("u2");
    expect(r.displayName).toBe("阿明");
  });

  it("falls back to nickname then username (not id prefix)", async () => {
    mockGetMemberAlias.mockResolvedValueOnce(null);
    mockGetTeamMembers.mockResolvedValueOnce([
      { team_id: "t1", user_id: "u3", username: "bob", nickname: "Bob", avatar_url: "🐶", role: "member", updated_at: "" },
    ]);
    const { getMember } = useMemberInfo();
    const r = await getMember("u3");
    expect(r.displayName).toBe("Bob");
    expect(r.avatarUrl).toBe("🐶");
  });

  it("uses username when nickname missing", async () => {
    mockGetMemberAlias.mockResolvedValueOnce(null);
    mockGetTeamMembers.mockResolvedValueOnce([
      { team_id: "t1", user_id: "u4", username: "carol", nickname: null, avatar_url: null, role: "member", updated_at: "" },
    ]);
    const { getMember } = useMemberInfo();
    const r = await getMember("u4");
    expect(r.displayName).toBe("carol");
  });
});
