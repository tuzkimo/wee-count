// src/stores/auth.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  getLocalUserByNickname,
  createLocalUser,
  updateLocalUserBinding,
  updateLocalUserProfile,
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
  const syncVersion = ref(0);

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
    await openUserDb(user.id, user.nickname);
    currentLocalUser.value = user;
    mode.value = 'local';
    localStorage.setItem("current_user_id", user.id);

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
    await openUserDb(id, nickname);
    currentLocalUser.value = {
      id,
      nickname,
      password_hash: hash,
      api_url: null,
      server_user_id: null,
      avatar_url: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    mode.value = 'local';
    localStorage.setItem("current_user_id", id);
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
    localStorage.setItem("current_user_id", currentLocalUser.value!.id);
  }

  // 登出
  function logout(): void {
    closeUserDb();
    // 不再调用 api.clearTokens() — refresh_token 保留以便下次登录自动恢复在线会话
    currentLocalUser.value = null;
    onlineUser.value = null;
    mode.value = 'none';
    lastSyncedAt.value = null;
    localStorage.removeItem("current_user_id");
  }

  // 退出在线同步（保留本地账户，仅断开服务端绑定）
  async function unbindOnline(): Promise<void> {
    if (!currentLocalUser.value) return;

    await updateLocalUserBinding(currentLocalUser.value.id, "", "");

    currentLocalUser.value = {
      ...currentLocalUser.value,
      api_url: null,
      server_user_id: null,
    };

    api.clearTokens();
    onlineUser.value = null;
    mode.value = 'local';
  }

  // 初始化
  async function init(): Promise<void> {
    if (isInitialized.value) return;

    const savedUserId = localStorage.getItem("current_user_id");
    if (!savedUserId) {
      isInitialized.value = true;
      return;
    }

    // 检查本地用户是否仍存在
    const { getLocalUser } = await import("@/db/meta");
    const user = await getLocalUser(savedUserId);
    if (!user) {
      localStorage.removeItem("current_user_id");
      isInitialized.value = true;
      return;
    }

    // 打开用户 db
    await openUserDb(user.id, user.nickname);
    currentLocalUser.value = user;
    mode.value = 'local';

    // 如果绑定了服务端，尝试恢复在线会话
    if (user.server_user_id && user.api_url) {
      api.setBaseUrl(user.api_url);
      const restored = await api.tryRestoreSession();
      if (restored) {
        onlineUser.value = restored;
        mode.value = 'online';
      }
    }

    isInitialized.value = true;
  }

  function notifySyncComplete(): void {
    syncVersion.value++;
  }

  async function updateProfile(data: { nickname?: string; avatar_url?: string | null }): Promise<void> {
    // 在线模式：先同步到服务端
    if (mode.value === 'online') {
      const { updateProfile: apiUpdateProfile } = await import("@/services/api");
      const updated = await apiUpdateProfile(data);
      onlineUser.value = updated;
    }
    // 更新本地记录（两种模式都要）
    if (currentLocalUser.value) {
      const newNickname = data.nickname ?? currentLocalUser.value.nickname
      const newAvatar = data.avatar_url !== undefined ? data.avatar_url : currentLocalUser.value.avatar_url
      await updateLocalUserProfile(currentLocalUser.value.id, newNickname, newAvatar)
      currentLocalUser.value = {
        ...currentLocalUser.value,
        nickname: newNickname,
        avatar_url: newAvatar,
      }
    }
  }

  return {
    currentLocalUser,
    onlineUser,
    mode,
    isInitialized,
    isSyncing,
    lastSyncedAt,
    syncVersion,
    isAuthenticated,
    isOnline,
    localLogin,
    createLocalAccount,
    bindOnline,
    logout,
    unbindOnline,
    notifySyncComplete,
    updateProfile,
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
