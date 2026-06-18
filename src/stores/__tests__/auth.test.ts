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
  getLocalUserByNickname: vi.fn(() => null),
  createLocalUser: vi.fn(),
  updateLocalUserBinding: vi.fn(),
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
});
