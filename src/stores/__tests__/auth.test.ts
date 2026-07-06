// src/stores/__tests__/auth.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "../auth";

// mock api module
vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  setBaseUrl: vi.fn(),
  getBaseUrl: vi.fn(() => "http://localhost:8080/api/v1"),
  getStoredRefreshToken: vi.fn(() => null),
  isLoggedIn: vi.fn(() => false),
  login: vi.fn(),
  register: vi.fn(),
  tryRestoreSession: vi.fn(),
}));

// mock meta db module
vi.mock("@/db/meta", () => ({
  getMetaDb: vi.fn(),
  getLocalUsers: vi.fn(() => []),
  getLocalUser: vi.fn(),
  getLocalUserByUsername: vi.fn(() => null),
  createLocalUser: vi.fn(),
  updateLocalUserBinding: vi.fn(),
  updateLocalUserProfile: vi.fn(),
  updateLocalUsername: vi.fn(),
  closeMetaDb: vi.fn(),
}));

// mock userDb module
vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => null),
  getCurrentUserId: vi.fn(() => null),
  openUserDb: vi.fn(),
  closeUserDb: vi.fn(),
}));

describe("useAuthStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("初始状态为未登录", () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.currentLocalUser).toBeNull();
    expect(store.mode).toBe("none");
  });

  it("初始状态 isInitialized 为 false", () => {
    const store = useAuthStore();
    expect(store.isInitialized).toBe(false);
  });

  it("localLogin 按不可变 username 查询本地用户，而非可变 nickname", async () => {
    // 回归：在线模式改昵称后 local_users.nickname 漂移，登录若按 nickname 查会查不到。
    const { getLocalUserByUsername } = await import("@/db/meta");
    (getLocalUserByUsername as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const store = useAuthStore();
    const ok = await store.localLogin("alice", "pw");
    expect(ok).toBe(false);
    expect(getLocalUserByUsername).toHaveBeenCalledWith("alice");
  });
});
