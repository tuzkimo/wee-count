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
  fetchWithTimeout: vi.fn(),
}));

// mock sync module — performSync 触发的真实同步不在 auth 测试范围内
vi.mock("@/services/sync", () => ({
  performSync: vi.fn().mockResolvedValue(true),
  enqueueSync: vi.fn(),
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

// mock ledger store — 改昵称后应调用 useLedgerStore().init() 刷新内存缓存
vi.mock("@/stores/ledger", () => ({ useLedgerStore: vi.fn(() => ({ init: vi.fn() })) }));

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

  it("localLogin fallback 不得用他人凭据开别人的库", async () => {
    // 回归：清空数据后在线登录 user1，登出，再用 user2（同密码）本地登录。
    // fallback 会拿 user2 凭据去服务端登录成功，但绝不能因此打开 user1 的库、
    // 或把 user2 的 username 写到 user1 的本地记录上。
    const { getLocalUserByUsername, getLocalUsers, updateLocalUsername } = await import("@/db/meta");
    const { openUserDb } = await import("@/db/userDb");
    const api = await import("@/services/api");
    (getLocalUserByUsername as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (getLocalUsers as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "local-user1", username: "user1", nickname: "user1", password_hash: "x",
        api_url: "http://srv", server_user_id: "server-user1", avatar_url: null,
        created_at: "", updated_at: "",
      },
    ]);
    // user2 凭据在服务端登录成功，但返回的是 user2 的服务端身份
    (api.login as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      user: { id: "server-user2", username: "user2", nickname: "user2", avatar_url: null, created_at: "", updated_at: "" },
      access_token: "a", refresh_token: "r", ledger_id: "L2",
    });

    const store = useAuthStore();
    const ok = await store.localLogin("user2", "same-password");

    expect(ok).toBe(false);
    expect(openUserDb).not.toHaveBeenCalled();
    expect(updateLocalUsername).not.toHaveBeenCalled();
    expect(api.clearTokens).toHaveBeenCalled();
  });

  it("init 对绑定在线同步的用户不阻塞：tryRestoreSession 挂起时仍立即以 local 就绪", async () => {
    // 回归：在线服务 TCP 可达但 HTTP 不响应时，旧实现 await tryRestoreSession 永久挂起，
    // 路由守卫不 resolve 导致白屏。改造后 init 本地部分立即完成，会话恢复后台进行。
    const { getLocalUser } = await import("@/db/meta");
    const api = await import("@/services/api");
    localStorage.setItem("current_user_id", "u1");
    (getLocalUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u1", username: "alice", nickname: "Alice", password_hash: "x",
      api_url: "http://srv", server_user_id: "s1", avatar_url: null,
      created_at: "", updated_at: "",
    });
    // 模拟服务挂起：tryRestoreSession 永不 resolve
    (api.tryRestoreSession as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(() => {})
    );

    const store = useAuthStore();
    await store.init(); // 必须立即 resolve，不被挂起的 restore 阻塞

    expect(store.isInitialized).toBe(true);
    expect(store.mode).toBe("local"); // 未切 online（会话尚未恢复）
    expect(api.tryRestoreSession).toHaveBeenCalled();
  });

  it("init 后台恢复在线会话成功 → 切 online", async () => {
    const { getLocalUser } = await import("@/db/meta");
    const api = await import("@/services/api");
    localStorage.setItem("current_user_id", "u2");
    (getLocalUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "u2", username: "bob", nickname: "Bob", password_hash: "x",
      api_url: "http://srv", server_user_id: "s2", avatar_url: null,
      created_at: "", updated_at: "",
    });
    (api.tryRestoreSession as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "s2", username: "bob", nickname: "Bob", avatar_url: null,
      created_at: "", updated_at: "",
    });

    const store = useAuthStore();
    await store.init();
    // restoreOnlineSession 是 fire-and-forget，flush 微任务等其完成
    await vi.waitFor(() => expect(store.mode).toBe("online"));
    expect(store.onlineUser).not.toBeNull();
    expect(store.onlineUser?.id).toBe("s2");
  });

  it("updateProfile 改昵称后刷新 ledger 内存缓存", async () => {
    const { useLedgerStore } = await import("@/stores/ledger");
    const initMock = vi.fn();
    (useLedgerStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ init: initMock });

    const { getUserDb } = await import("@/db/userDb");
    (getUserDb as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      execute: vi.fn(),
      select: vi.fn().mockResolvedValue([]),
    });

    const store = useAuthStore();
    store.currentLocalUser = {
      id: "u1", username: "alice", nickname: "Alice", password_hash: "x",
      api_url: null, server_user_id: null, avatar_url: null, created_at: "", updated_at: "",
    };
    store.mode = "local";
    await store.updateProfile({ nickname: "Alicia" });

    expect(initMock).toHaveBeenCalled();
  });

  it("isOnlineBound 区分纯本地与绑定在线（含降级）", () => {
    // 纯本地用户：从未绑定 → isOnlineBound=false
    const store = useAuthStore();
    store.currentLocalUser = {
      id: "u3", username: "carol", nickname: "Carol", password_hash: "x",
      api_url: null, server_user_id: null, avatar_url: null,
      created_at: "", updated_at: "",
    };
    store.mode = "local";
    expect(store.isOnlineBound).toBe(false);
    expect(store.isOnline).toBe(false);

    // 绑定在线但服务下线降级 → isOnlineBound=true、isOnline=false
    store.currentLocalUser = {
      ...store.currentLocalUser!,
      api_url: "http://srv",
      server_user_id: "s3",
    };
    expect(store.isOnlineBound).toBe(true);
    expect(store.isOnline).toBe(false);

    // 恢复在线 → 两者皆 true
    store.mode = "online";
    expect(store.isOnlineBound).toBe(true);
    expect(store.isOnline).toBe(true);
  });
});
