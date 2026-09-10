// src/stores/__tests__/auth.switchUser.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import type { LocalUser } from "@/db/meta";

const mockUserDb = { select: vi.fn(), execute: vi.fn() };
vi.mock("@/db/userDb", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  openUserDb: vi.fn(async () => mockUserDb),
  getUserDb: vi.fn(() => mockUserDb),
  closeUserDb: vi.fn(),
}));
vi.mock("@/db/meta", () => ({
  getLocalUserByUsername: vi.fn(),
  getLocalUsers: vi.fn(async () => []),
  getLocalUser: vi.fn(),
  createLocalUser: vi.fn(),
  updateLocalUserBinding: vi.fn(),
  updateLocalUserProfile: vi.fn(),
  updateLocalUsername: vi.fn(),
}));
vi.mock("@/services/sync", () => ({
  performSync: vi.fn(),
  clearPendingSync: vi.fn(),
  resetSyncTimers: vi.fn(),
}));
vi.mock("@/services/api", () => ({
  setBaseUrl: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  tryRestoreSession: vi.fn(),
  login: vi.fn(),
}));

import { useAuthStore } from "@/stores/auth";

const userA: LocalUser = {
  id: "user-a", username: "a", nickname: "A", password_hash: "h",
  api_url: null, server_user_id: null, avatar_url: null,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
};
const userB: LocalUser = { ...userA, id: "user-b", username: "b", nickname: "B" };

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  localStorage.clear();
});

describe("switchToLocalUser", () => {
  it("未登录时直接切换到目标账户", async () => {
    const auth = useAuthStore();
    await auth.switchToLocalUser(userB);

    expect(auth.mode).toBe("local");
    expect(auth.currentLocalUser?.id).toBe("user-b");
    expect(localStorage.getItem("current_user_id")).toBe("user-b");
  });

  it("已登录时先登出旧会话再切换", async () => {
    const auth = useAuthStore();
    auth.currentLocalUser = userA;
    auth.mode = "local";

    await auth.switchToLocalUser(userB);

    expect(auth.mode).toBe("local");
    expect(auth.currentLocalUser?.id).toBe("user-b");
    expect(localStorage.getItem("current_user_id")).toBe("user-b");
  });
});
