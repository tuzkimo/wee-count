// src/stores/auth.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { apiFetch, setTokens, clearTokens, getStoredRefreshToken } from "@/services/api";
import type { User } from "@/types";

export const useAuthStore = defineStore("auth", () => {
  const user = ref<User | null>(null);
  const isInitialized = ref(false);
  const isSyncing = ref(false);
  const lastSyncedAt = ref<string | null>(null);

  const isAuthenticated = computed(() => user.value !== null);

  async function init(): Promise<void> {
    if (isInitialized.value) return;

    const storedRefresh = getStoredRefreshToken();
    if (storedRefresh) {
      const res = await apiFetch<{ user: User }>("/me");
      if (res.ok && res.data) {
        user.value = res.data.user;
      } else {
        clearTokens();
      }
    }

    isInitialized.value = true;
  }

  async function register(email: string, password: string, nickname: string): Promise<string | null> {
    const res = await apiFetch<{ user: User; access_token: string; refresh_token: string }>(
      "/auth/register",
      {
        method: "POST",
        body: JSON.stringify({ email, password, nickname }),
      }
    );

    if (!res.ok) {
      return res.error || "注册失败";
    }

    setTokens(res.data!.access_token, res.data!.refresh_token);
    user.value = res.data!.user;
    return null;
  }

  async function login(email: string, password: string): Promise<string | null> {
    const res = await apiFetch<{ user: User; access_token: string; refresh_token: string }>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }
    );

    if (!res.ok) {
      return res.error || "登录失败";
    }

    setTokens(res.data!.access_token, res.data!.refresh_token);
    user.value = res.data!.user;
    return null;
  }

  function logout(): void {
    clearTokens();
    user.value = null;
    lastSyncedAt.value = null;
  }

  return {
    user,
    isInitialized,
    isSyncing,
    lastSyncedAt,
    isAuthenticated,
    init,
    register,
    login,
    logout,
  };
});
