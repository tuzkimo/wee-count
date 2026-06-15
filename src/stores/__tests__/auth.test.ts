// src/stores/__tests__/auth.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useAuthStore } from "../auth";

// mock api module
vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  setTokens: vi.fn(),
  clearTokens: vi.fn(),
  getStoredRefreshToken: vi.fn(() => null),
  isLoggedIn: vi.fn(() => false),
}));

describe("useAuthStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("初始状态为未登录", () => {
    const store = useAuthStore();
    expect(store.isAuthenticated).toBe(false);
    expect(store.user).toBeNull();
  });

  it("初始状态 isInitialized 为 false", () => {
    const store = useAuthStore();
    expect(store.isInitialized).toBe(false);
  });
});
