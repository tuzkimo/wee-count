// src/stores/auth.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  getLocalUserByNickname,
  createLocalUser,
  updateLocalUserBinding,
  type LocalUser,
} from "@/db/meta";
import { openUserDb, closeUserDb } from "@/db/userDb";
import * as api from "@/services/api";

export type AuthMode = 'none' | 'local' | 'online'

export const useAuthStore = defineStore("auth", () => {
  const currentLocalUser = ref<LocalUser | null>(null);
  const onlineUser = ref<api.User | null>(null);
  const mode = ref<AuthMode>('none');
  const isInitialized = ref(false);
  const isSyncing = ref(false);
  const lastSyncedAt = ref<string | null>(null);

  const isAuthenticated = computed(() => mode.value !== 'none');
  const isOnline = computed(() => mode.value === 'online');

  // 本地登录
  async function localLogin(nickname: string, password: string): Promise<boolean> {
    const user = await getLocalUserByNickname(nickname);
    if (!user) return false;

    // 验证密码 (bcrypt compare)
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) return false;

    // 打开用户 db
    await openUserDb(user.id);
    currentLocalUser.value = user;
    mode.value = user.server_user_id ? 'online' : 'local';

    // 如果绑定了服务端，尝试恢复在线会话
    if (user.server_user_id && user.api_url) {
      api.setBaseUrl(user.api_url);
      const restored = await api.tryRestoreSession();
      if (restored) {
        onlineUser.value = restored;
        mode.value = 'online';
      }
    }

    return true;
  }

  // 创建本地账户
  async function createLocalAccount(
    nickname: string,
    password: string
  ): Promise<string> {
    const id = crypto.randomUUID();
    const hash = await hashPassword(password);
    await createLocalUser(id, nickname, hash);
    await openUserDb(id);
    currentLocalUser.value = {
      id,
      nickname,
      password_hash: hash,
      api_url: null,
      server_user_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mode.value = 'local';
    return id;
  }

  // 绑定服务端 (纯本地 → 在线)
  async function bindOnline(
    apiUrl: string,
    serverUser: api.AuthResponse
  ): Promise<void> {
    api.setBaseUrl(apiUrl);
    api.setTokens(serverUser.access_token, serverUser.refresh_token);

    await updateLocalUserBinding(
      currentLocalUser.value!.id,
      apiUrl,
      serverUser.user.id
    );

    currentLocalUser.value = {
      ...currentLocalUser.value!,
      api_url: apiUrl,
      server_user_id: serverUser.user.id,
    };

    onlineUser.value = serverUser.user;
    mode.value = 'online';
  }

  // 登出
  function logout(): void {
    closeUserDb();
    api.clearTokens();
    currentLocalUser.value = null;
    onlineUser.value = null;
    mode.value = 'none';
    lastSyncedAt.value = null;
  }

  // 初始化
  async function init(): Promise<void> {
    // 启动时不做自动登录，交由路由守卫处理
    isInitialized.value = true;
  }

  return {
    currentLocalUser,
    onlineUser,
    mode,
    isInitialized,
    isSyncing,
    lastSyncedAt,
    isAuthenticated,
    isOnline,
    localLogin,
    createLocalAccount,
    bindOnline,
    logout,
    init,
  };
});

// 密码工具函数 (使用 bcryptjs)
async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(password, 10);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(password, hash);
}
