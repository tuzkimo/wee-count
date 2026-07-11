// src/stores/auth.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  getLocalUserByUsername,
  getLocalUsers,
  createLocalUser,
  updateLocalUserBinding,
  updateLocalUserProfile,
  updateLocalUsername,
  type LocalUser,
} from "@/db/meta";
import { openUserDb, closeUserDb, getUserDb } from "@/db/userDb";
import * as api from "@/services/api";
import { performSync } from "@/services/sync";
import type { Ledger } from "@/types";

export type AuthMode = 'none' | 'local' | 'online'

export const useAuthStore = defineStore("auth", () => {
  const currentLocalUser = ref<LocalUser | null>(null);
  const onlineUser = ref<api.User | null>(null);
  const mode = ref<AuthMode>('none');
  const isInitialized = ref(false);
  const isSyncing = ref(false);
  const lastSyncedAt = ref<string | null>(null);
  const lastSyncFailed = ref(false);
  const syncVersion = ref(0);

  const isAuthenticated = computed(() => mode.value !== 'none');
  const isOnline = computed(() => mode.value === 'online');
  // 是否绑定过在线同步（与当前是否连上解耦）：绑定了但服务下线退到 local 时为 true。
  // 用于 UI 区分「纯本地用户」与「在线用户降级」，避免降级时误显示「配置在线同步」。
  const isOnlineBound = computed(
    () => !!currentLocalUser.value?.server_user_id && !!currentLocalUser.value?.api_url
  );

  // 本地登录（按不可变 username 查，与可变 nickname 解耦）
  async function localLogin(username: string, password: string): Promise<boolean> {
    const user = await getLocalUserByUsername(username);
    if (user) {
      // 验证密码 (bcrypt compare)
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) return false;

      // 打开用户 db
      await openUserDb(user.id, user.nickname);
      currentLocalUser.value = user;
      mode.value = 'local';
      localStorage.setItem("current_user_id", user.id);

      // 绑定了服务端则后台恢复在线会话（不阻塞登录返回）
      if (user.server_user_id && user.api_url) {
        void restoreOnlineSession();
      }
      triggerOnlineSync();
      return true;
    }

    // fallback：历史在线账户改过昵称致本地 username 列漂移，按服务端 username/password
    // 验证，命中即修复本地 username 列（一次性，下次直接命中本地查询）
    const onlineCandidates = (await getLocalUsers()).filter(u => u.server_user_id && u.api_url);
    for (const c of onlineCandidates) {
      api.setBaseUrl(c.api_url!);
      let resp: api.AuthResponse;
      try {
        resp = await api.login(username, password);
      } catch {
        continue;
      }
      // 必须是同一服务端账号（本地 username 漂移）才可复用此候选人的库；
      // 否则输入的是别人的凭据，开错库会看到他人数据，且会把别人 username 写到该库上。
      if (resp.user.id !== c.server_user_id) {
        api.clearTokens();
        continue;
      }
      await updateLocalUsername(c.id, username);
      await openUserDb(c.id, c.nickname);
      currentLocalUser.value = { ...c, username };
      onlineUser.value = resp.user;
      mode.value = 'online';
      localStorage.setItem("current_user_id", c.id);
      triggerOnlineSync();
      return true;
    }

    return false;
  }

  // 创建本地账户
  // username：不可变登录键（在线账户=服务端 username，纯本地账户=初始 nickname）
  // nickname：可变显示名
  async function createLocalAccount(
    username: string,
    nickname: string,
    password: string
  ): Promise<string> {
    const id = crypto.randomUUID();
    const hash = await hashPassword(password);
    await createLocalUser(id, username, nickname, hash);
    await openUserDb(id, nickname);
    currentLocalUser.value = {
      id,
      username,
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
    stopOnlineRecovery();
    closeUserDb();
    // 不再调用 api.clearTokens() — refresh_token 保留以便下次登录自动恢复在线会话
    currentLocalUser.value = null;
    onlineUser.value = null;
    mode.value = 'none';
    lastSyncedAt.value = null;
    lastSyncFailed.value = false;
    localStorage.removeItem("current_user_id");
  }

  // 退出在线同步（保留本地账户，仅断开服务端绑定）
  async function unbindOnline(): Promise<void> {
    if (!currentLocalUser.value) return;

    stopOnlineRecovery();
    await updateLocalUserBinding(currentLocalUser.value.id, "", "");

    currentLocalUser.value = {
      ...currentLocalUser.value,
      api_url: null,
      server_user_id: null,
    };

    api.clearTokens();
    onlineUser.value = null;
    mode.value = 'local';
    lastSyncFailed.value = false;
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

    // 打开用户 db，立即以本地模式就绪——不阻塞路由守卫渲染。
    // 在线服务即便下线，用户也能先用本地数据。
    await openUserDb(user.id, user.nickname);
    currentLocalUser.value = user;
    mode.value = 'local';
    isInitialized.value = true;

    // 绑定了在线同步则后台恢复会话（不阻塞）：
    // 成功 → 切 online + 拉取远程；失败/服务下线 → 保持本地可用 + 退避重连直到恢复。
    if (user.server_user_id && user.api_url) {
      void restoreOnlineSession();
    }
  }

  function notifySyncComplete(): void {
    syncVersion.value++;
  }

  // 在线会话恢复/登录后，后台拉取一次远程变更（团队账本里别人加的数据靠这进来）。
  // fire-and-forget：不阻塞登录返回；同步完成会 notifySyncComplete() 触发列表刷新。
  // 必须在 mode='online' 后调用——performSync 依赖 baseUrl 与已恢复的 token。
  function triggerOnlineSync(): void {
    if (mode.value !== 'online') return;
    void performSync().catch(() => { /* performSync 内部已 console.warn，吞掉即可 */ });
  }

  // 后台在线会话恢复：幂等，可在 local 模式下反复调用。
  // 成功 → 切 online + 拉取远程 + 推送降级期间积压的本地变更；
  // 失败/超时 → 启动指数退避重连，直到在线服务重新上线自动恢复。
  // 关键：不阻塞 init/localLogin，路由渲染与会话恢复解耦。
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let recoveryAttempt = 0;

  async function restoreOnlineSession(): Promise<void> {
    if (mode.value === 'online') return;
    const user = currentLocalUser.value;
    if (!user || !user.server_user_id || !user.api_url) return;

    api.setBaseUrl(user.api_url);
    const restored = await api.tryRestoreSession();
    if (restored) {
      onlineUser.value = restored;
      mode.value = 'online';
      stopOnlineRecovery();
      triggerOnlineSync();
      return;
    }
    startOnlineRecovery();
  }

  // 指数退避：10s → 20s → 40s → 60s（上限），长期保持每分钟探测一次。
  function startOnlineRecovery(): void {
    if (recoveryTimer) return;
    if (mode.value === 'online') return;
    const user = currentLocalUser.value;
    if (!user || !user.server_user_id || !user.api_url) return;

    recoveryAttempt++;
    const delay = Math.min(10000 * Math.pow(2, recoveryAttempt - 1), 60000);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      void restoreOnlineSession();
    }, delay);
  }

  function stopOnlineRecovery(): void {
    recoveryAttempt = 0;
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
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
      const oldNickname = currentLocalUser.value.nickname
      const newNickname = data.nickname ?? oldNickname
      const newAvatar = data.avatar_url !== undefined ? data.avatar_url : currentLocalUser.value.avatar_url
      await updateLocalUserProfile(currentLocalUser.value.id, newNickname, newAvatar)
      currentLocalUser.value = {
        ...currentLocalUser.value,
        nickname: newNickname,
        avatar_url: newAvatar,
      }
      // 昵称变更时同步更新个人账本名称
      if (data.nickname && data.nickname !== oldNickname) {
        const db = getUserDb()
        if (db) {
          const oldName = `${oldNickname}的账本`
          const newName = `${data.nickname}的账本`
          const now = new Date().toISOString()
          await db.execute(
            "UPDATE ledgers SET name = $1, updated_at = $2 WHERE name = $3 AND type = 'personal'",
            [newName, now, oldName]
          )
          // 在线模式：把改名的个人账本入队同步，让服务端 ledgers.name 跟随昵称更新，
          // 否则其他设备只能看到旧昵称的账本名
          if (mode.value === 'online') {
            const { enqueueSync } = await import("@/services/sync")
            const rows = await db.select<(Omit<Ledger, "is_deleted"> & { is_deleted: number })[]>(
              "SELECT id, name, type, owner_id, team_id, created_at, updated_at, is_deleted FROM ledgers WHERE name = $1 AND type = 'personal'",
              [newName]
            )
            if (rows.length > 0) {
              enqueueSync({ ledgers: rows.map((r) => ({ ...r, is_deleted: !!r.is_deleted })) })
            }
          }
        }
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
    lastSyncFailed,
    syncVersion,
    isAuthenticated,
    isOnline,
    isOnlineBound,
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
