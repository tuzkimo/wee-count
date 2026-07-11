# 团队账本体验优化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 15 项团队账本体验优化，覆盖会话持久化、新手引导、成员系统、权限筛选、交互细节。

**Architecture:** 五阶段渐进式改动。前端为主（Vue 3 + Pinia + SQLite），后端改动集中在 auth handler（email 字段移除，username 替代为唯一标识、profile 接口）和 sync 协议（member_aliases 扩展）。数据库将清空重测，直接删 email 列无兼容负担。

**Tech Stack:** Vue 3 + TypeScript + Pinia + SQLite (前端), Go + Chi + PostgreSQL (后端)

---

## Phase 1: 会话持久化 (#3 #7 #8)

### Task 1.1: 自动恢复会话 (#3)

**Files:**
- Modify: `src/stores/auth.ts:110-113` (`init` 方法)
- Modify: `src/stores/auth.ts:26-51` (`localLogin` 方法中存 userId)
- Modify: `src/stores/auth.ts:53-73` (`createLocalAccount` 方法中存 userId)
- Modify: `src/stores/auth.ts:76-97` (`bindOnline` 方法中存 userId)
- Modify: `src/router/index.ts:104-106` (路由守卫开头调用 `auth.init()`)

- [ ] **Step 1: `localLogin` 成功后写入 `localStorage`**

在 `src/stores/auth.ts` 的 `localLogin` 函数中，`currentLocalUser.value = user` 之后添加：

```typescript
// 第 37 行之后插入
localStorage.setItem("current_user_id", user.id);
```

- [ ] **Step 2: `createLocalAccount` 成功后写入 `localStorage`**

在 `createLocalAccount` 函数中，`mode.value = 'local'` 之后添加：

```typescript
// 第 72 行之后插入
localStorage.setItem("current_user_id", id);
```

- [ ] **Step 3: `bindOnline` 成功后写入 `localStorage`**

在 `bindOnline` 函数中，`mode.value = 'online'` 之后添加：

```typescript
// 第 97 行之后插入
localStorage.setItem("current_user_id", currentLocalUser.value!.id);
```

- [ ] **Step 4: 重写 `init` 方法实现自动恢复**

将 `src/stores/auth.ts` 的 `init` 方法从：

```typescript
async function init(): Promise<void> {
  // 启动时不做自动登录，交由路由守卫处理
  isInitialized.value = true;
}
```

改为：

```typescript
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
  const { openUserDb } = await import("@/db/userDb");
  await openUserDb(user.id);
  currentLocalUser.value = user;
  mode.value = 'local';

  // 如果绑定了服务端，尝试恢复在线会话
  if (user.server_user_id && user.api_url) {
    const { setBaseUrl, tryRestoreSession } = await import("@/services/api");
    setBaseUrl(user.api_url);
    const restored = await tryRestoreSession();
    if (restored) {
      onlineUser.value = restored;
      mode.value = 'online';
    }
  }

  isInitialized.value = true;
}
```

- [ ] **Step 5: 路由守卫在检查 auth 前调用 `auth.init()`**

修改 `src/router/index.ts` 的路由守卫，在 `if (users.length === 0)` 之后、`if (!auth.isAuthenticated)` 之前插入：

```typescript
// 第 117 行 const auth = useAuthStore() 之后插入
await auth.init();

// 如果 init 已自动恢复会话，直接放行
if (auth.isAuthenticated) {
  // 团队功能需要在线模式
  const onlineOnlyPages = ['/teams/create', '/teams/join']
  if (onlineOnlyPages.includes(to.path) && !auth.isOnline) {
    return { path: '/me', replace: true }
  }
  return true
}
```

注意：原来的 `if (!auth.isAuthenticated)` 分支和 `onlineOnlyPages` 检查逻辑需要合并到此处。

- [ ] **Step 6: 验证**

运行 `npm run dev`，确认：
1. 登录后关闭浏览器标签页 → 重新打开 → 直接进入首页（不经过登录页）
2. 在线模式用户重启后自动恢复在线会话

---

### Task 1.2: logout 不再清除 refresh_token (#8)

**Files:**
- Modify: `src/stores/auth.ts:100-107` (`logout` 方法)

- [ ] **Step 1: 修改 `logout` 方法**

将 `logout` 函数从：

```typescript
function logout(): void {
  closeUserDb();
  api.clearTokens();
  currentLocalUser.value = null;
  onlineUser.value = null;
  mode.value = 'none';
  lastSyncedAt.value = null;
}
```

改为：

```typescript
function logout(): void {
  closeUserDb();
  // 不再调用 api.clearTokens() — refresh_token 保留以便下次登录自动恢复在线会话
  currentLocalUser.value = null;
  onlineUser.value = null;
  mode.value = 'none';
  lastSyncedAt.value = null;
  localStorage.removeItem("current_user_id");
}
```

- [ ] **Step 2: 验证**

1. 在线模式登录 → 退出登录 → 重新登录 → 确认自动恢复在线状态，无需重新绑定
2. 确认 `localStorage` 中 `refresh_token` 未被删除

---

### Task 1.3: 退出在线同步入口 (#7)

**Files:**
- Modify: `src/stores/auth.ts` — 新增 `unbindOnline` action
- Modify: `src/views/MePage.vue` — 在线模式下显示「退出在线同步」按钮

- [ ] **Step 1: 在 auth store 新增 `unbindOnline` action**

在 `src/stores/auth.ts` 的 `logout` 函数之后添加：

```typescript
// 退出在线同步（保留本地账户，仅断开服务端绑定）
async function unbindOnline(): Promise<void> {
  if (!currentLocalUser.value) return;

  const { updateLocalUserBinding } = await import("@/db/meta");
  await updateLocalUserBinding(currentLocalUser.value.id, "", "");

  currentLocalUser.value = {
    ...currentLocalUser.value,
    api_url: null,
    server_user_id: null,
  };

  // 清除 token
  const { clearTokens } = await import("@/services/api");
  clearTokens();

  onlineUser.value = null;
  mode.value = 'local';
}
```

并在 return 对象中添加 `unbindOnline`：

```typescript
return {
  // ... existing
  unbindOnline,  // 新增
};
```

- [ ] **Step 2: MePage 显示「退出在线同步」按钮**

在 `src/views/MePage.vue` 中，在「退出登录」按钮之前添加在线模式专属的「退出在线同步」按钮。在 `handleLogout` 函数之后添加：

```typescript
async function handleUnbindOnline(): Promise<void> {
  await auth.unbindOnline();
}
```

在 template 中，在 `<div class="mt-6 px-4">` 之前插入：

```html
<!-- 退出在线同步 (仅在线模式) -->
<div v-if="auth.isOnline" class="mt-6 px-4">
  <button
    class="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-3 text-text-secondary"
    @click="handleUnbindOnline"
  >
    <span>退出在线同步</span>
  </button>
</div>
```

- [ ] **Step 3: 验证**

1. 在线模式 → MePage 显示「退出在线同步」按钮
2. 点击后模式回退到 local，本地数据不受影响
3. 再次配置在线同步可正常绑定

- [ ] **Step 4: Commit Phase 1**

```bash
git add src/stores/auth.ts src/router/index.ts src/views/MePage.vue
git commit -m "feat: session persistence, logout-preserve-token, unbind-online"
```

---

## Phase 2: 新用户引导流程 (#1 #2 #6)

### Task 2.1: 后端 — 移除 email，username 替代 + profile 接口

**Files:**
- Modify: `backend/internal/model/user.go` — RegisterRequest / LoginRequest 新增 username 字段
- Modify: `backend/internal/service/auth.go` — Register 支持 username，Login 支持 username 登录
- Modify: `backend/internal/database/migrations/` — 新增 003 迁移添加 username 列
- Modify: `backend/internal/handler/auth.go` — 新增 Profile 路由

- [ ] **Step 1: 创建数据库迁移文件**

`backend/internal/database/migrations/003_email_to_username.up.sql`:

```sql
-- 直接删除 email 列，用 username 替代
ALTER TABLE users DROP COLUMN IF EXISTS email;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(255);
ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
```

`backend/internal/database/migrations/003_email_to_username.down.sql`:

```sql
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_username_unique;
ALTER TABLE users DROP COLUMN IF EXISTS username;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
```

- [ ] **Step 2: 更新 User 模型**

修改 `backend/internal/model/user.go`：

```go
type User struct {
	ID           string    `json:"id"`
	Username     string    `json:"username"`
	Nickname     string    `json:"nickname"`
	PasswordHash string    `json:"-"`
	AvatarURL    *string   `json:"avatar_url"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type RegisterRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Nickname string `json:"nickname,omitempty"`
}

type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type UpdateProfileRequest struct {
	Nickname  *string `json:"nickname,omitempty"`
	AvatarURL *string `json:"avatar_url,omitempty"`
}
```

- [ ] **Step 3: 更新 AuthService.Register**

修改 `backend/internal/service/auth.go` 的 `Register` 方法：

将 email 查重改为 username 查重：
```go
err := s.pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM users WHERE username = $1)", req.Username).Scan(&exists)
```

nickname 默认等于 username（如果没传）：
```go
nickname := req.Nickname
if nickname == "" {
    nickname = req.Username
}
```

INSERT 语句（无 email 列）：
```go
`INSERT INTO users (id, username, nickname, password_hash, created_at, updated_at)
 VALUES ($1, $2, $3, $4, $5, $6)`,
userID, req.Username, nickname, string(hash), now, now,
```

返回的 User 不再含 Email 字段。

- [ ] **Step 4: 更新 AuthService.Login**

修改 Login 方法，将 email 查询改为 username 查询，移除 email 字段：

```go
err := s.pool.QueryRow(ctx,
    `SELECT id, username, nickname, password_hash, avatar_url, created_at, updated_at
     FROM users WHERE username = $1`, req.Username,
).Scan(&user.ID, &user.Username, &user.Nickname, &user.PasswordHash, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
```

Refresh 和 GetMe 中的 user 查询同样去掉 email 字段。

- [ ] **Step 5: 更新错误变量名 + handler 验证逻辑**

`ErrEmailTaken` → `ErrUsernameTaken`，同时在 handler 中对应的 409 错误消息也改为 "username already registered"。Login 错误消息改为 "invalid username or password"。

修改 `backend/internal/handler/auth.go` 的 Register handler 验证逻辑：

```go
// 原来的 email 验证改为 username
if req.Username == "" || req.Password == "" {
    writeError(w, http.StatusBadRequest, "username and password are required")
    return
}
// nickname 不再强制必填，默认用 username
```

- [ ] **Step 6: 新增 PUT /auth/profile handler**

修改 `backend/internal/handler/auth.go`，新增 `UpdateProfile` 方法：

```go
func (h *AuthHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	userID := middleware.GetUserID(r.Context())
	var req model.UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	user, err := h.auth.UpdateProfile(r.Context(), userID, req)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, user)
}
```

并在 `main.go` 注册路由：
```go
r.Group(func(r chi.Router) {
    r.Use(middleware.AuthMiddleware(cfg.JWTSecret))
    r.Get("/me", authHandler.Me)
    r.Put("/auth/profile", authHandler.UpdateProfile)
    // ... 其他受保护路由
})
```

- [ ] **Step 7: AuthService 新增 UpdateProfile 方法**

在 `backend/internal/service/auth.go` 中：

```go
func (s *AuthService) UpdateProfile(ctx context.Context, userID string, req model.UpdateProfileRequest) (*model.User, error) {
	if req.Nickname != nil {
		_, err := s.pool.Exec(ctx, "UPDATE users SET nickname = $1, updated_at = $2 WHERE id = $3",
			*req.Nickname, time.Now().UTC(), userID)
		if err != nil {
			return nil, fmt.Errorf("update nickname: %w", err)
		}
	}
	if req.AvatarURL != nil {
		_, err := s.pool.Exec(ctx, "UPDATE users SET avatar_url = $1, updated_at = $2 WHERE id = $3",
			*req.AvatarURL, time.Now().UTC(), userID)
		if err != nil {
			return nil, fmt.Errorf("update avatar_url: %w", err)
		}
	}

	var user model.User
	err := s.pool.QueryRow(ctx,
		`SELECT id, username, nickname, avatar_url, created_at, updated_at FROM users WHERE id = $1`,
		userID,
	).Scan(&user.ID, &user.Username, &user.Nickname, &user.AvatarURL, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("query user: %w", err)
	}
	return &user, nil
}
```

- [ ] **Step 8: 更新 AuthResponse 返回 username**

确保 `AuthResponse.User` 包含 username 字段（已在 Step 2 的 User 结构体中添加）。

- [ ] **Step 9: Commit backend changes**

```bash
cd backend
git add .
git commit -m "feat: replace email with username, add profile update endpoint"
```

---

### Task 2.2: 前端 — API 层适配 username

**Files:**
- Modify: `src/services/api.ts` — login/register 函数签名
- Modify: `src/types/index.ts` — User 接口加 username

- [ ] **Step 1: 更新前端 User 类型**

修改 `src/types/index.ts` 的 `User` 接口（移除 email）：

```typescript
export interface User {
  id: string;
  username: string;
  nickname: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 2: 更新 api.login、api.register 和 api.ts 中的 User 接口**

修改 `src/services/api.ts`：

```typescript
// User 接口移除 email，新增 username
export interface User {
  id: string
  username: string
  nickname: string
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${getBaseUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  // ... 其余不变
}

export async function register(
  username: string,
  password: string,
  nickname?: string
): Promise<AuthResponse> {
  const res = await fetch(`${getBaseUrl()}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, nickname }),
  })
  // ... 其余不变
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/api.ts src/types/index.ts
git commit -m "feat: adapt frontend API to username-based auth"
```

---

### Task 2.3: WelcomePage 改为模式选择页 (#1)

**Files:**
- Modify: `src/views/WelcomePage.vue` — 完全重写
- Modify: `src/router/index.ts` — 添加 `/welcome/online` 路由，更新公开页面列表

- [ ] **Step 1: 重写 WelcomePage.vue**

用以下内容替换 `src/views/WelcomePage.vue`：

```vue
<!-- src/views/WelcomePage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">一起数钱</h1>
      <p class="text-gray-500 text-center mb-8">选择你的记账方式</p>

      <!-- 本地模式 -->
      <div class="mb-4 rounded-xl border border-gray-200 p-4">
        <h2 class="text-lg font-semibold mb-3">📱 本地模式</h2>
        <div class="space-y-3">
          <input
            v-model="nickname"
            type="text"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="你的昵称"
          />
          <input
            v-model="password"
            type="password"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="设置密码"
          />
          <p v-if="error" class="text-red-500 text-sm">{{ error }}</p>
          <button
            :disabled="!localValid || loading"
            class="w-full py-3 rounded-xl font-medium text-white bg-blue-500 disabled:opacity-50"
            @click="handleCreateLocal"
          >
            {{ loading ? '创建中...' : '开始使用' }}
          </button>
        </div>
      </div>

      <!-- 在线模式 -->
      <div class="rounded-xl border border-gray-200 p-4">
        <h2 class="text-lg font-semibold mb-3">🌐 在线模式</h2>
        <p class="text-sm text-gray-500 mb-3">同步数据到服务器，支持多设备和团队协作</p>
        <div class="space-y-3">
          <input
            v-model="apiUrl"
            type="text"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="服务器地址，如 https://api.example.com/api/v1"
          />
          <button
            :disabled="!onlineValid || loading"
            class="w-full py-3 rounded-xl font-medium text-white bg-green-500 disabled:opacity-50"
            @click="handleGoOnline"
          >
            配置在线同步
          </button>
        </div>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        已有本地账户？<router-link to="/login" class="text-blue-500">登录</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const nickname = ref('')
const password = ref('')
const apiUrl = ref('')
const loading = ref(false)
const error = ref('')

const localValid = computed(() => nickname.value.trim().length > 0 && password.value.length >= 4)
const onlineValid = computed(() => apiUrl.value.trim().length > 0)

async function handleCreateLocal(): Promise<void> {
  if (!localValid.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.createLocalAccount(nickname.value.trim(), password.value)
    router.replace('/')
  } catch {
    error.value = '创建失败，请重试'
  } finally {
    loading.value = false
  }
}

function handleGoOnline(): void {
  if (!onlineValid.value) return
  router.push({ path: '/bind-sync', query: { apiUrl: apiUrl.value.trim() } })
}
</script>
```

- [ ] **Step 2: 更新路由守卫**

在 `src/router/index.ts` 中，将公开页面列表更新为包含 `/welcome/online`：

```typescript
const publicPages = ['/welcome', '/login', '/bind-sync']
```

- [ ] **Step 3: 验证**

运行 `npm run dev`：
1. 打开 http://localhost:1420/welcome → 看到两个模式选择卡片
2. 选本地模式 → 填昵称+密码 → 进入首页
3. 选在线模式 → 填 API 地址 → 跳转到 BindSyncPage

- [ ] **Step 4: Commit**

```bash
git add src/views/WelcomePage.vue src/router/index.ts
git commit -m "feat: WelcomePage mode selection UI"
```

---

### Task 2.4: BindSyncPage 改为 Tab 切换 (#2)

**Files:**
- Modify: `src/views/BindSyncPage.vue` — 重构为 Tab 切换
- Modify: `src/services/migration.ts` — 适配新的调用方式

- [ ] **Step 1: 重写 BindSyncPage.vue**

用以下内容替换 `src/views/BindSyncPage.vue`：

```vue
<!-- src/views/BindSyncPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-2xl font-bold text-center mb-6">配置在线同步</h1>

      <!-- API 地址 -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-1">服务器地址</label>
        <input
          v-model="apiUrl"
          type="text"
          class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://api.example.com/api/v1"
        />
      </div>

      <!-- Tab 切换 -->
      <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
        <button
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="activeTab === 'login' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="activeTab = 'login'"
        >登录</button>
        <button
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="activeTab === 'register' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="activeTab = 'register'"
        >注册</button>
      </div>

      <p v-if="error" class="text-red-500 text-sm mb-3">{{ error }}</p>

      <!-- 登录表单 -->
      <div v-if="activeTab === 'login'" class="space-y-3">
        <input v-model="loginUsername" type="text" placeholder="用户名" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <input v-model="loginPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <button
          :disabled="loginLoading || !apiUrl || !loginUsername || !loginPassword"
          class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium disabled:opacity-50"
          @click="handleLogin"
        >
          {{ loginLoading ? '登录中...' : '登录并同步' }}
        </button>
      </div>

      <!-- 注册表单 -->
      <div v-if="activeTab === 'register'" class="space-y-3">
        <input v-model="regUsername" type="text" placeholder="用户名" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <input v-model="regPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <p class="text-xs text-gray-400">注册后昵称默认与用户名相同，可在设置中修改</p>
        <button
          :disabled="regLoading || !apiUrl || !regUsername || !regPassword"
          class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium disabled:opacity-50"
          @click="handleRegister"
        >
          {{ regLoading ? '注册中...' : '注册并同步' }}
        </button>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/" class="text-blue-500">暂不配置，继续使用本地模式</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/services/api'
import { migrateLocalDataToServer, firstFullSync } from '@/services/migration'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const activeTab = ref<'login' | 'register'>('login')
const apiUrl = ref((route.query.apiUrl as string) || '')
const error = ref('')
const loginLoading = ref(false)
const regLoading = ref(false)

const loginUsername = ref('')
const loginPassword = ref('')

const regUsername = ref('')
const regPassword = ref('')

async function doAfterBind(resp: api.AuthResponse): Promise<void> {
  await migrateLocalDataToServer(resp.ledger_id, resp.user.id)
  await auth.bindOnline(apiUrl.value, resp)
  router.replace('/')
  // 后台执行首次同步
  try { await firstFullSync() } catch (e) {
    console.warn("[BindSync] firstFullSync failed (non-fatal):", e)
  }
}

async function handleLogin(): Promise<void> {
  loginLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.login(loginUsername.value, loginPassword.value)
    await doAfterBind(resp)
  } catch (e: unknown) {
    error.value = (e as Error)?.message || '登录失败'
  } finally {
    loginLoading.value = false
  }
}

async function handleRegister(): Promise<void> {
  regLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.register(regUsername.value, regPassword.value)
    await doAfterBind(resp)
  } catch (e: unknown) {
    error.value = (e as Error)?.message || '注册失败'
  } finally {
    regLoading.value = false
  }
}
</script>
```

- [ ] **Step 2: 验证**

运行 `npm run dev`：
1. 从 WelcomePage 选在线模式 → 跳转 BindSyncPage，API 地址已预填
2. Tab 切换登录/注册正常
3. 登录/注册成功后跳转首页

- [ ] **Step 3: Commit**

```bash
git add src/views/BindSyncPage.vue
git commit -m "feat: BindSyncPage tab-based login/register UI"
```

---

### Task 2.5: RegisterPage 移除 (#6)

**Files:**
- Modify: `src/router/index.ts` — 移除 `/register` 路由
- Delete: `src/views/RegisterPage.vue` — 不再需要

- [ ] **Step 1: 移除 RegisterPage 路由**

在 `src/router/index.ts` 中删除以下路由定义：
```typescript
{
  path: "/register",
  name: "register",
  component: () => import("@/views/RegisterPage.vue"),
  meta: { hideTab: true },
},
```

- [ ] **Step 2: 删除 RegisterPage.vue**

```bash
rm src/views/RegisterPage.vue
```

- [ ] **Step 3: 检查并移除对 /register 的引用**

运行 `grep -r "register" src/ --include="*.vue" --include="*.ts" | grep -v "node_modules"` 确认无残留引用。

- [ ] **Step 4: Commit**

```bash
git add src/router/index.ts && git rm src/views/RegisterPage.vue
git commit -m "feat: remove standalone RegisterPage, merged into BindSyncPage"
```

---

## Phase 3: 团队体验优化 (#9 #11 #12)

### Task 3.1: 账本名称显示规则 (#9)

**Files:**
- Modify: `src/views/TransactionList.vue` — 账本切换器显示 `{团队名}的账本`

- [ ] **Step 1: 修改账本名称显示逻辑**

在 `src/views/TransactionList.vue` 的 template 中，将账本切换器的名称显示改为：

```html
<!-- 第 344 行，修改 ledgerStore.currentLedger?.name 的显示 -->
{{ ledgerStore.currentLedger?.type === 'team'
  ? (ledgerStore.currentLedger?.name || '团队') + '的账本'
  : (ledgerStore.currentLedger?.name || '我的账本') }}
```

账本切换器下拉列表中的名称（第 362 行附近）同样修改：

```html
<span class="truncate">
  {{ l.type === 'team' ? l.name + '的账本' : (l.name || '个人账本') }}
</span>
```

- [ ] **Step 2: 验证**

1. 个人账本显示原名或「个人账本」
2. 团队账本显示「{团队名}的账本」

- [ ] **Step 3: Commit**

```bash
git add src/views/TransactionList.vue
git commit -m "feat: display team ledger name as '{team}的账本'"
```

---

### Task 3.2: FilterPage 新增分类和成员筛选 (#11)

**Files:**
- Modify: `src/views/FilterPage.vue` — 新增分类多选和成员多选区域
- Modify: `src/stores/transaction.ts:143-188` — `fetchAll` 支持 categoryIds/memberIds 过滤
- Modify: `src/views/TransactionList.vue:144-166` — `buildFetchOpts` 解析新 query 参数

- [ ] **Step 1: FilterPage - 新增分类多选区域**

在 `src/views/FilterPage.vue` 的 script 中，新增：

```typescript
import { useCategoryStore } from "@/stores/category";
const categoryStore = useCategoryStore();

const selectedCategoryIds = ref<string[]>([]);

// onMounted 中恢复分类 query
if (route.query.categories) {
  selectedCategoryIds.value = (route.query.categories as string).split(",").filter(Boolean);
}

function toggleCategory(catId: string) {
  const idx = selectedCategoryIds.value.indexOf(catId);
  if (idx >= 0) {
    selectedCategoryIds.value.splice(idx, 1);
  } else {
    selectedCategoryIds.value.push(catId);
  }
}
```

在 onMounted 中加载分类：
```typescript
await Promise.all([
  accountStore.fetchAll(ledgerId),
  tagStore.fetchAll(ledgerId),
  categoryStore.fetchAll(ledgerId), // 新增
]);
```

在 `apply()` 函数中添加：
```typescript
if (selectedCategoryIds.value.length > 0) query.categories = selectedCategoryIds.value.join(",");
```

在 `reset()` 函数中添加：
```typescript
selectedCategoryIds.value = [];
```

- [ ] **Step 2: FilterPage - 分类多选 UI**

在 template 中标签区域之后插入：

```html
<!-- 分类（多选） -->
<div class="mb-4">
  <label class="mb-1 block text-xs text-text-secondary">📂 分类</label>
  <div class="flex flex-wrap gap-2">
    <button
      v-for="cat in categoryStore.categories"
      :key="cat.id"
      class="rounded-full px-3 py-1.5 text-xs transition-colors"
      :class="selectedCategoryIds.includes(cat.id)
        ? 'bg-primary text-white'
        : 'bg-gray-100 text-text-secondary'"
      @click="toggleCategory(cat.id)"
    >
      <span>{{ cat.icon }}</span>
      {{ cat.name }}
    </button>
    <p v-if="categoryStore.categories.length === 0" class="text-xs text-text-secondary">暂无分类</p>
  </div>
</div>
```

- [ ] **Step 3: TransactionList - buildFetchOpts 解析 categories/members query**

在 `src/views/TransactionList.vue` 的 `buildFetchOpts` 函数中添加：

```typescript
const qCategories = route.query.categories as string | undefined;
const qMembers = route.query.members as string | undefined;

return {
  // ... existing
  categoryIds: qCategories ? qCategories.split(",").filter(Boolean) : undefined,
  memberIds: qMembers ? qMembers.split(",").filter(Boolean) : undefined,
};
```

- [ ] **Step 4: transaction store - fetchAll 支持 categoryIds/memberIds 过滤**

在 `src/stores/transaction.ts` 的 `fetchAll` 方法 opts 类型中添加：

```typescript
opts?: {
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  tagIds?: string[];
  categoryIds?: string[];  // 新增
  memberIds?: string[];    // 新增
}
```

在 tag 过滤逻辑之后添加 category 过滤：
```typescript
if (opts?.categoryIds && opts.categoryIds.length > 0) {
  const placeholders = opts.categoryIds.map(() => "?").join(",");
  sql += ` AND t.category_id IN (${placeholders})`;
  params.push(...opts.categoryIds);
}
```

在 category 过滤之后添加 member 过滤：
```typescript
if (opts?.memberIds && opts.memberIds.length > 0) {
  const placeholders = opts.memberIds.map(() => "?").join(",");
  sql += ` AND t.user_id IN (${placeholders})`;
  params.push(...opts.memberIds);
}
```

- [ ] **Step 5: 成员筛选仅在团队账本时显示 (后续 Task 4.x 完善数据源)**

FilterPage 的成员筛选 UI 先预留位置，等 Phase 4 成员系统完成后再接入真实数据。当前通过 `route.query.members` 透传即可。

- [ ] **Step 6: 更新 filterSummary 显示分类和成员筛选状态**

在 `src/views/TransactionList.vue` 的 `filterSummary` computed 中添加：

```typescript
// 分类筛选摘要
if (q.categories) {
  const catIds = (q.categories as string).split(",").filter(Boolean);
  // ponytail: 简单显示数量
  parts.push(`📂 ${catIds.length}个分类`);
} else {
  parts.push("📂 全部分类");
}

// 成员筛选摘要
if (q.members) {
  const memIds = (q.members as string).split(",").filter(Boolean);
  parts.push(`👥 ${memIds.length}个成员`);
}
```

- [ ] **Step 7: Commit**

```bash
git add src/views/FilterPage.vue src/views/TransactionList.vue src/stores/transaction.ts
git commit -m "feat: add category and member filter support"
```

---

### Task 3.3: 权限控制 — 流水/账户/分类编辑限制 (#12)

**Files:**
- Modify: `src/views/RecordPage.vue` — 编辑模式下检查 owner_id，非自己的流水隐藏删除按钮、置灰保存
- Modify: `src/views/AccountEdit.vue` — 检查 owner_id
- Modify: `src/components/CategorySheet.vue` — 检查 category 归属（通过 owner_id 或 user_id）

- [ ] **Step 1: RecordPage 权限检查**

在 `src/views/RecordPage.vue` 的编辑模式下（`isEdit` 为 true），从 transaction 数据中获取 `user_id`，与当前用户 ID 比较。

在 script 中新增：

```typescript
import { getCurrentUserId } from "@/db/userDb";

const isOwner = computed(() => {
  if (!isEdit.value || !editId.value) return true;
  const tx = transactionStore.transactions.find((t) => t.id === editId.value);
  if (!tx) return true;
  const currentUserId = auth.currentLocalUser?.server_user_id || getCurrentUserId();
  return tx.user_id === currentUserId;
});
```

在 template 中：
- 删除按钮：`v-if="isEdit && isOwner"`（第 305-312 行）
- 如果非 owner，删除按钮替换为置灰状态提示

```html
<template v-if="isEdit" #action>
  <button
    v-if="isOwner"
    class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
    @click="deleteDialogVisible = true"
  >
    <Trash2 :size="18" class="text-expense" />
  </button>
  <span v-else class="text-xs text-text-secondary">他人记录</span>
</template>
```

保存按钮（`CalculatorKeypad` 的 done/save-next）也需要在非 owner 时禁用。在 `doSave` 开头添加：

```typescript
if (!isOwner.value) return false;
```

- [ ] **Step 2: AccountEdit 权限检查**

在 `src/views/AccountEdit.vue` 中新增：

```typescript
import { getCurrentUserId } from "@/db/userDb";
import { useAuthStore } from "@/stores/auth";
const auth = useAuthStore();

const isOwner = computed(() => {
  if (!account.value) return true;
  const currentUserId = auth.currentLocalUser?.server_user_id || getCurrentUserId();
  return account.value.owner_id === currentUserId;
});
```

删除按钮条件改为：`v-if="isOwner"`
保存按钮条件改为：`:disabled="!name.trim() || saving || !isOwner"`
非 owner 时显示「他人账户」提示。

- [ ] **Step 3: CategorySheet 权限检查**

在 `src/components/CategorySheet.vue` 中，编辑和删除按钮需要检查权限。由于 Category 没有 owner_id 字段，个人账本中所有分类可编辑。团队账本的权限检查需要 ledger 的 owner_id。

简化方案：团队账本中，非 ledger owner 隐藏分类编辑/删除按钮。需要从 ledgerStore 获取 currentLedger 并比较 owner_id。

```typescript
import { useAuthStore } from "@/stores/auth";
const auth = useAuthStore();
const ledgerStore = useLedgerStore();

const canManage = computed(() => {
  const ledger = ledgerStore.currentLedger;
  if (!ledger || ledger.type !== 'team') return true;
  const currentUserId = auth.currentLocalUser?.server_user_id || getCurrentUserId();
  return ledger.owner_id === currentUserId;
});
```

Template 中编辑/删除按钮加 `v-if="canManage"`。

- [ ] **Step 4: Commit**

```bash
git add src/views/RecordPage.vue src/views/AccountEdit.vue src/components/CategorySheet.vue
git commit -m "feat: permission control for team ledger — hide edit/delete for non-owner"
```

---

## Phase 4: 用户资料 & 成员系统 (#10 #14 #15)

### Task 4.1: SettingsPage 实现头像/昵称编辑 (#14)

**Files:**
- Modify: `src/views/SettingsPage.vue` — 实现完整编辑 UI
- Modify: `src/services/api.ts` — 新增 `updateProfile` API 函数
- Modify: `src/stores/auth.ts` — 新增 `updateProfile` action

- [ ] **Step 1: 新增 api.updateProfile**

在 `src/services/api.ts` 末尾添加：

```typescript
export interface UpdateProfileRequest {
  nickname?: string;
  avatar_url?: string | null;
}

export async function updateProfile(data: UpdateProfileRequest): Promise<User> {
  const res = await apiFetch<User>("/auth/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  });
  if (!res.ok || !res.data) {
    throw new Error(res.error || "更新失败");
  }
  return res.data;
}
```

- [ ] **Step 2: auth store 新增 updateProfile action**

在 `src/stores/auth.ts` 中，`return` 之前添加：

```typescript
async function updateProfile(data: { nickname?: string; avatar_url?: string | null }): Promise<void> {
  if (mode.value === 'online') {
    const { updateProfile: apiUpdateProfile } = await import("@/services/api");
    const updated = await apiUpdateProfile(data);
    onlineUser.value = updated;
  }
  // 本地模式下仅更新 currentLocalUser
  if (data.nickname && currentLocalUser.value) {
    currentLocalUser.value = { ...currentLocalUser.value, nickname: data.nickname };
  }
}
```

并在 return 对象中添加 `updateProfile`。

- [ ] **Step 3: 实现 SettingsPage**

用以下内容替换 `src/views/SettingsPage.vue`：

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import AppHeader from "@/components/AppHeader.vue";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();

const nickname = ref(auth.currentLocalUser?.nickname || "");
const selectedEmoji = ref(auth.onlineUser?.avatar_url || "");

// emoji 头像选项
const avatarOptions = ["😀", "🐱", "🐶", "🦊", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄", "🐌", "🐛", "🦋"];

const saving = ref(false);
const saved = ref(false);

async function handleSave(): Promise<void> {
  saving.value = true;
  saved.value = false;
  try {
    await auth.updateProfile({
      nickname: nickname.value.trim() || undefined,
      avatar_url: selectedEmoji.value || null,
    });
    saved.value = true;
    setTimeout(() => { saved.value = false; }, 2000);
  } catch (e) {
    console.error("Save profile failed:", e);
  } finally {
    saving.value = false;
  }
}

const hasChanges = computed(() =>
  nickname.value.trim() !== (auth.currentLocalUser?.nickname || "") ||
  selectedEmoji.value !== (auth.onlineUser?.avatar_url || "")
);
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="设置" :show-back="true" />

    <div class="flex-1 overflow-auto px-4 py-4">
      <!-- 头像 -->
      <label class="mb-2 block text-sm font-medium text-text">头像</label>
      <div class="mb-6 flex flex-wrap gap-2">
        <button
          v-for="emoji in avatarOptions"
          :key="emoji"
          class="flex h-12 w-12 items-center justify-center rounded-xl text-2xl transition-colors"
          :class="selectedEmoji === emoji
            ? 'bg-primary/10 ring-2 ring-primary ring-offset-1'
            : 'bg-gray-100 hover:bg-gray-200'"
          @click="selectedEmoji = selectedEmoji === emoji ? '' : emoji"
        >
          {{ emoji }}
        </button>
      </div>

      <!-- 昵称 -->
      <label class="mb-1 block text-sm font-medium text-text">昵称</label>
      <input
        v-model="nickname"
        type="text"
        maxlength="20"
        class="mb-6 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        placeholder="你的昵称"
      />

      <!-- 在线模式额外信息 -->
      <div v-if="auth.isOnline" class="mb-6 rounded-lg bg-gray-50 p-3">
        <p class="text-xs text-text-secondary">
          用户名：{{ auth.onlineUser?.username || '-' }}
        </p>
      </div>

      <!-- 保存按钮 -->
      <button
        class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors disabled:opacity-50"
        :disabled="!hasChanges || saving"
        @click="handleSave"
      >
        {{ saving ? '保存中...' : saved ? '已保存 ✓' : '保存' }}
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 验证**

运行 `npm run dev`：
1. 进入设置页 → 选择 emoji 头像 + 修改昵称 → 保存
2. 在线模式下确认 API 调用成功
3. 本地模式下确认昵称更新到 currentLocalUser

- [ ] **Step 5: Commit**

```bash
git add src/views/SettingsPage.vue src/services/api.ts src/stores/auth.ts
git commit -m "feat: SettingsPage with emoji avatar and nickname editing"
```

---

### Task 4.2: 成员别名表 + 同步协议扩展 (#10 #15 前半)

**Files:**
- Modify: `src/db/meta.ts` — 新增 `member_aliases` 表 CRUD
- Modify: `src/services/sync.ts` — `SyncPayload` 加 `member_aliases`，`applyRemoteChanges` 处理别名
- Create: `backend/internal/database/migrations/004_member_aliases.up.sql`
- Modify: `backend/internal/model/sync.go` — `SyncPayload` 加 `MemberAliases`
- Modify: `backend/internal/service/sync.go` — 处理 member_aliases 同步

- [ ] **Step 1: 前端 member_aliases 表**

在 `src/db/meta.ts` 的 `initMetaTables` 函数中添加建表语句：

```typescript
await db.execute(`
  CREATE TABLE IF NOT EXISTS member_aliases (
    setter_user_id TEXT NOT NULL,
    target_user_id TEXT NOT NULL,
    alias_name TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (setter_user_id, target_user_id)
  )
`);
```

新增 CRUD 函数：

```typescript
export interface MemberAlias {
  setter_user_id: string;
  target_user_id: string;
  alias_name: string;
  updated_at: string;
}

export async function getMemberAliases(): Promise<MemberAlias[]> {
  const db = await getMetaDb();
  return db.select<MemberAlias[]>(
    'SELECT setter_user_id, target_user_id, alias_name, updated_at FROM member_aliases'
  );
}

export async function setMemberAlias(
  setterUserId: string,
  targetUserId: string,
  aliasName: string
): Promise<void> {
  const db = await getMetaDb();
  await db.execute(
    `INSERT OR REPLACE INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at)
     VALUES ($1, $2, $3, datetime('now'))`,
    [setterUserId, targetUserId, aliasName]
  );
}
```

- [ ] **Step 2: 扩展 SyncPayload**

修改 `src/services/sync.ts`：

```typescript
// 类型定义新增
export interface MemberAliasPayload {
  setter_user_id: string;
  target_user_id: string;
  alias_name: string;
  updated_at: string;
}

export interface SyncPayload {
  ledgers: Ledger[];
  accounts: Account[];
  tags: Tag[];
  categories: Category[];
  transactions: Transaction[];
  member_aliases: MemberAliasPayload[];  // 新增
}
```

在 `enqueueSync` 和 `mergeChanges` 中加上 `member_aliases`，在 `applyRemoteChanges` 中处理：

```typescript
for (const alias of (remote.member_aliases || [])) {
  const local = await db.select<{ updated_at: string }[]>(
    "SELECT updated_at FROM member_aliases WHERE setter_user_id = ? AND target_user_id = ?",
    [alias.setter_user_id, alias.target_user_id]
  );
  if (local.length === 0) {
    await db.execute(
      "INSERT INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at) VALUES (?, ?, ?, ?)",
      [alias.setter_user_id, alias.target_user_id, alias.alias_name, alias.updated_at]
    );
  } else if (alias.updated_at > local[0].updated_at) {
    await db.execute(
      "UPDATE member_aliases SET alias_name = ?, updated_at = ? WHERE setter_user_id = ? AND target_user_id = ?",
      [alias.alias_name, alias.updated_at, alias.setter_user_id, alias.target_user_id]
    );
  }
}
```

- [ ] **Step 3: 后端 member_aliases 表**

创建 `backend/internal/database/migrations/004_member_aliases.up.sql`：

```sql
CREATE TABLE IF NOT EXISTS member_aliases (
  setter_user_id UUID NOT NULL REFERENCES users(id),
  target_user_id UUID NOT NULL REFERENCES users(id),
  alias_name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (setter_user_id, target_user_id)
);
```

- [ ] **Step 4: 后端 SyncPayload 扩展 + sync 逻辑**

在 `backend/internal/model/sync.go` 的 `SyncPayload` 中添加：
```go
MemberAliases []MemberAlias `json:"member_aliases"`
```

新增 `MemberAlias` 结构体：
```go
type MemberAlias struct {
    SetterUserID string    `json:"setter_user_id"`
    TargetUserID string    `json:"target_user_id"`
    AliasName    string    `json:"alias_name"`
    UpdatedAt    time.Time `json:"updated_at"`
}
```

在 `backend/internal/service/sync.go` 中添加 `lwwMergeMemberAlias` 方法并按 LWW 模式处理 member_aliases 的插入/更新/查询。

- [ ] **Step 5: Commit**

```bash
git add src/db/meta.ts src/services/sync.ts backend/
git commit -m "feat: add member_aliases table and sync protocol extension"
```

---

### Task 4.3: 成员别名显示逻辑 (#10 #15 后半)

**Files:**
- Modify: `src/views/TransactionList.vue` — 流水记录显示成员别名
- Modify: `src/components/AccountPickerSheet.vue` — 账户归属显示别名
- Modify: `src/stores/transaction.ts` — 查询时 JOIN user 信息（nickname/avatar_url/username）

- [ ] **Step 1: transaction store 查询添加 user 信息 JOIN**

在 `src/stores/transaction.ts` 的 QUERY 中添加 LEFT JOIN users（本地 users 表）：

实际上本地 SQLite 没有独立的 users 表用于团队成员。成员信息通过同步获取。简化方案：在 transaction 的 assemble 阶段，通过 member_aliases 表和本地用户表来解析显示名。

更简单的做法：在 `TransactionList.vue` 中新增一个辅助函数，根据 `user_id` 查找显示名：

```typescript
import { getMemberAliases } from "@/db/meta";

// 获取用户显示名（别名 > 昵称 > 用户名）
function getUserDisplayName(userId: string): string {
  // 如果是自己
  if (userId === (auth.currentLocalUser?.server_user_id || getCurrentUserId())) {
    return "我";
  }
  // 查别名
  const alias = memberAliases.value.find(
    (a) => a.setter_user_id === currentUserId && a.target_user_id === userId
  );
  if (alias) return alias.alias_name;
  // fallback: 显示 user_id 前 8 位
  return userId.slice(0, 8);
}
```

- [ ] **Step 2: TransactionList 中显示成员归属**

在流水列表的每个 item 中添加成员归属显示。在 `getTxDescription` 或单独的位置添加 `👤 {displayName}`。

具体位置：在 template 中 `getTxDescription(tx)` 之后添加一行：

```html
<p v-if="isTeamLedger && tx.user_id" class="text-[10px] text-text-secondary">
  👤 {{ getUserDisplayName(tx.user_id) }}
</p>
```

其中 `isTeamLedger` 为：
```typescript
const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === 'team');
```

- [ ] **Step 3: AccountPickerSheet 账户归属显示**

在 `src/components/AccountPickerSheet.vue` 中，每行账户名称后显示归属：

```html
<span class="text-text">{{ acc.name }}</span>
<span v-if="isTeamLedger && acc.owner_id" class="text-[10px] text-text-secondary">
  ({{ getUserDisplayName(acc.owner_id) }})
</span>
```

需要传入 `isTeamLedger` prop 和 `getUserDisplayName` 函数。

- [ ] **Step 4: Commit**

```bash
git add src/views/TransactionList.vue src/components/AccountPickerSheet.vue src/stores/transaction.ts
git commit -m "feat: display member alias in transaction list and account picker"
```

---

## Phase 5: 交互细节 (#4 #5 #13)

### Task 5.1: AccountPickerSheet 添加新建账户入口 (#4)

**Files:**
- Modify: `src/components/AccountPickerSheet.vue` — 底部加「+ 新建账户」按钮，emit `create` 事件
- Modify: `src/views/RecordPage.vue` — 处理 create 事件

- [ ] **Step 1: AccountPickerSheet 添加新建按钮**

在 `src/components/AccountPickerSheet.vue` 的 emit 定义中添加：

```typescript
const emit = defineEmits<{
  close: [];
  select: [account: Account];
  selectAll: [];
  create: [];  // 新增
}>();
```

在列表底部、close 按钮之前添加：

```html
<button
  class="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 py-3 text-sm text-text-secondary transition-colors hover:border-primary hover:text-primary"
  @click="$emit('create')"
>
  <Plus :size="16" />
  <span>新建账户</span>
</button>
```

并 import `Plus` from `lucide-vue-next`。

- [ ] **Step 2: RecordPage 处理 create 事件**

在 `src/views/RecordPage.vue` 的 `AccountPickerSheet` 使用处添加：

```html
<AccountPickerSheet
  :visible="accountPickerVisible"
  @close="accountPickerVisible = false"
  @select="onAccountSelect"
  @create="handleCreateAccount"
/>
```

新增处理函数：

```typescript
function handleCreateAccount(): void {
  accountPickerVisible.value = false;
  router.push('/accounts/new');
}
```

注意：需要确认 `/accounts/new` 路由是否存在，如不存在需要添加 AccountEdit 的新建路由。

- [ ] **Step 3: 新建完成后自动选中**

在 AccountEdit 保存成功后，通过路由 query 参数回传新账户 ID，RecordPage 在 onMounted 时读取并选中。

简化方案：AccountEdit 新建成功后 `router.replace('/record?account=' + newAccountId)`。

- [ ] **Step 4: Commit**

```bash
git add src/components/AccountPickerSheet.vue src/views/RecordPage.vue
git commit -m "feat: add 'new account' button in AccountPickerSheet"
```

---

### Task 5.2: CreateTeamPage 复制反馈 (#5)

**Files:**
- Modify: `src/views/CreateTeamPage.vue` — 复制按钮动画反馈

- [ ] **Step 1: 添加复制反馈状态和逻辑**

在 `src/views/CreateTeamPage.vue` 的 script 中：

```typescript
const copied = ref(false);

async function handleCopy(): Promise<void> {
  await navigator.clipboard.writeText(createdCode.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
```

- [ ] **Step 2: 修改复制按钮样式**

将复制按钮的 template 改为：

```html
<button
  class="w-full rounded-lg py-3 text-white font-medium transition-colors"
  :class="copied ? 'bg-green-500' : 'bg-primary'"
  @click="handleCopy"
>
  {{ copied ? '已复制 ✓' : '复制邀请码' }}
</button>
```

- [ ] **Step 3: Commit**

```bash
git add src/views/CreateTeamPage.vue
git commit -m "feat: copy feedback animation on CreateTeamPage"
```

---

### Task 5.3: 在线模式首页空白修复 (#13)

**Files:**
- Modify: `src/stores/auth.ts` — 新增 `syncVersion` 计数器
- Modify: `src/services/sync.ts` — `performSync` 和 `firstFullSync` 成功后递增 `syncVersion`
- Modify: `src/views/TransactionList.vue` — watch `syncVersion` 重新 fetch

- [ ] **Step 1: auth store 新增 syncVersion**

在 `src/stores/auth.ts` 中添加：

```typescript
const syncVersion = ref(0);

function notifySyncComplete(): void {
  syncVersion.value++;
}
```

在 return 中导出 `syncVersion` 和 `notifySyncComplete`。

- [ ] **Step 2: sync 服务完成后触发通知**

修改 `src/services/sync.ts`，在 `performSync` 成功返回后：

```typescript
if (!res.ok || !res.data) {
  // ... error handling
  return;
}

await applyRemoteChanges(res.data.remote_changes);
setLastSyncedAt(res.data.server_time);

// 通知 auth store 同步完成
const { useAuthStore } = await import("@/stores/auth");
useAuthStore().notifySyncComplete();
```

在 `src/services/migration.ts` 的 `firstFullSync` 成功后也添加同样通知。

- [ ] **Step 3: TransactionList watch syncVersion**

在 `src/views/TransactionList.vue` 的 script 中添加：

```typescript
import { useAuthStore } from "@/stores/auth";
const authStore = useAuthStore();

watch(
  () => authStore.syncVersion,
  async () => {
    const ledgerId = ledgerStore.currentLedger?.id;
    if (!ledgerId) return;
    await accountStore.fetchAll(ledgerId);
    await tagStore.fetchAll(ledgerId);
    await transactionStore.fetchAll(ledgerId, buildFetchOpts());
  }
);
```

- [ ] **Step 4: 验证**

1. 在线模式首次登录 → 首页在 sync 完成后应该显示数据
2. 手动点击同步 → 首页数据自动刷新

- [ ] **Step 5: Commit**

```bash
git add src/stores/auth.ts src/services/sync.ts src/services/migration.ts src/views/TransactionList.vue
git commit -m "fix: TransactionList reloads after sync completes"
```

---

## 最终验证

全部 Phase 完成后运行：

```bash
npm run dev        # 前端验证
npm run test       # 前端单元测试
cd backend && go test ./...   # 后端测试
```

确认：
1. 新用户从 WelcomePage 选本地/在线模式均可正常进入
2. 在线模式重启 App 可自动恢复会话
3. 退出登录不清除 refresh_token，再次登录自动恢复在线
4. 退出在线同步回退到本地模式
5. 团队账本权限控制生效（非 owner 不可编辑/删除）
6. 分类和成员筛选功能正常
7. 成员别名显示正确
8. 复制邀请码有绿色反馈
9. 在线模式首页不再空白
