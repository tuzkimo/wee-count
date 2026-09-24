// src/services/api.ts
import { computed, ref } from "vue";
import type { TeamMember } from "@/types";
import { readRefreshToken, writeRefreshToken, deleteRefreshToken } from "./tokenStorage";

let baseUrl: string | null = null

/**
 * `baseUrl` 的**响应式镜像**：它一变就通知订阅者。
 *
 * 为什么需要：`setBaseUrl()` 的三个调用点全在异步初始化之后（`stores/auth.ts:65/124/237`，
 * 另有 `BindSyncPage.vue:138/156`），而"地址就绪之后才允许探 AI 能力"（C6.1）这件事在
 * 组件里**没有任何可 watch 的对象** —— 模块级 `let` 变了不会触发任何重算，探测要么挂在
 * `onMounted`（早于就绪 ⇒ 真机上必然失败）要么靠轮询。这里只暴露一个布尔视图，
 * `baseUrl` 仍是唯一真相源，取值口径与 `hasBaseUrl()` 逐字相同（`!== null`）。
 */
const baseUrlSet = ref(false)

/** 只读视图：地址是否已配置。`App.vue` 用它当"就绪后探一次"的触发条件（C6）。 */
export const baseUrlReady = computed(() => baseUrlSet.value)

/**
 * 登录凭据（access / refresh token）是否**已经拿到**的响应式镜像。
 *
 * 为什么需要它（Bug 1 的真机事故）：打开 App 后 token 是**异步**恢复的，而"地址就绪"
 * （`setBaseUrl`，`stores/auth.ts:242`）发生在恢复**之前** —— `auth.restoreOnlineSession`
 * 是先 `setBaseUrl()`、**后**才 `tryRestoreSession()`（`:243`）。于是"地址一就绪就探 AI 能力"
 * 的自动探针会在**一个凭据都没有**的时候发出请求（`apiFetch` 只在有 accessToken 时才加
 * Authorization 头、且 refresh 分支要求 refreshToken 非空）⇒ 服务端如实回 401。
 *
 * 所以这个视图有两个用途，都只关于"我们现在到底知不知道自己的登录态"：
 *  1. 文案：没有凭据时的 401 **不是**"登录已过期"的证据（见 `services/ai/failureText.ts`）；
 *  2. 时机：凭据就绪那一刻允许**自动补探一次**（`stores/aiChat.ts` 的 `watch`），用户不必手点
 *     「重新检测」。
 *
 * 取值口径与两个 token 变量逐字一致（任一非 null ⇒ 就绪）：三处赋值点（`setTokens` /
 * `tryRestoreSession` / `clearTokens`）都在同一处翻这个开关，别只改一边。
 */
export const authTokenReady = computed(() => authTokenSet.value)

let accessToken: string | null = null
let refreshToken: string | null = null
/** `authTokenReady` 的真相源（见上）；与下面两个 token 变量同生同灭 */
let authTokenSet = ref(false)
// 当前会话归属的服务端用户 id：refresh_token 按它独立存取，避免同设备多账号串号。
let currentUserId: string | null = null

// refresh 单飞：并发 401 时共享同一个 refresh promise，避免各自触发 refresh 导致竞态。
let refreshInFlight: Promise<boolean> | null = null

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '') // 去掉末尾斜杠
  baseUrlSet.value = true
}

export function getBaseUrl(): string {
  if (!baseUrl) throw new Error('API base URL not configured')
  return baseUrl
}

export function hasBaseUrl(): boolean {
  return baseUrl !== null
}

// 给裸 fetch 加超时兜底：服务端 TCP 可达但 HTTP 不响应（半死 / 代理丢包）时，
// 原生 fetch 会永久 pending，把整条 await 链挂死（曾导致在线服务下线时客户端白屏）。
// 超时后 abort，fetch 走 catch，由调用方的 try/catch 吞成失败返回。
//
// `init.signal`（外部取消，AI 会话的"取消生成"用它）：**本函数过去会把它覆盖掉** ✗ ——
// 上面那个 `{ ...init, signal: controller.signal }` 让外部 signal 静默失效（请求照发、
// 结果照回），而调用方以为已经取消了。现在把两者**串起来**：外部一 abort 就转发给
// 超时 controller（不直接 reject，保持"只有 controller 能结束这个请求"这一条不变，
// 返回/抛出的形状与超时路径完全一致）。所有既有调用方都不传 signal ⇒ 行为不变
// （`apiTimeout.test.ts` 的三条回归钉着这一点）。
//
// `timeoutFired` / `reason`：把**抛出原因**标在 error 上（`"timeout"` / `"aborted"`），让
// `apiFetch` 的 catch 分得开"15s 兜底超时"和"网络层错误"。上游 AI 的 15s 超时必须报
// 「分析超时」而不是「网络似乎不太顺」（规格 §5.3），而 catch 里拿到的只有一个不透明的
// reject 值。判据是**我们自己的兜底有没有开火**（`timeoutFired`）—— 裸 fetch 自己抛的错
// （断网 / DNS）时它仍是 false ⇒ 不打标签 ⇒ 老的值。实测：不这么分，既有的
// `apiFetch 网络异常`、`status:0 ⇒ network`、`apiFetch reject` 三条会全红（它们用的是
// "裸 fetch 抛 Error"的 mock，那种情况既不是超时也不是取消）。
//
// ⚠️ **`"aborted"` 这一档实际几乎产不出来**（step 0 处置死代码时的实测结论）：用户在途取消
// 走 `onAbort` ⇒ `controller.abort()` ⇒ fetch **同步**拒 ⇒ catch 运行时 `timeoutFired` 还是
// false ⇒ 无标签 ⇒ 值是 `"network error"`，而不是 `"aborted"`。
// 唯一能让"兜底开火 ∧ 外部已 abort"同时成立的窗口是**兜底开火之后、catch 跑起来之前**用户又
// 取消（竞态，且良性 —— 用户确实掐了请求）；但 `externalWasAborted` 是**发起请求之前**取的
// 快照，那种迟到的取消事件改不了它 ⇒ 连这个窗口也合不上，标签仍然产不出来。
// 消费者一侧因此也拿不到它（见 `transport.ts` 的 `classifyZero`），用户看到"已取消"靠的是
// transport 自己 `signal.aborted` 的前置判别 —— 那一层是**正常触发**的，不是这里。
//
// 保留这个标签而**不删**（与 `classifyZero` 的分支成对保留，铁律：要么一起删、要么一起留）：
// ① `timeoutFired && externalWasAborted` 这个谓词本身表达"这次结束是被用户掐的"，
//    一旦将来把外部取消改成"也走兜底超时"的形态就会真的命中；
// ② 万一有人删掉 transport 的取消前置判别，`status:0` 会被判成 `network`（"网络似乎不太
//    顺"）而不是"已取消" —— 留着它至少让那条错误分类在有人改回来时立刻正确。
// ⛔ **别只删一半**：删掉这里而留着 `classifyZero` 的 `"aborted"` 分支，就变成"分支永远
//    不可达且上游也不再产生"的纯误导（反向同理）。
//
// ⚠️ 也**不能**改用 `signal.aborted` 在别处猜：实测（假 timer 推进 15s、mock 在 abort
// 事件里同步 reject）走到分类时那个 controller 的 `aborted` 还是 `false` ⇒ 真实超时会被
// 判成 network。原因在产生它的那一层标出来才是最可靠的。
/** `fetchWithTimeout` 抛出的错误上挂的**原因标签**（见该函数的 catch） */
interface ReasonedError extends Error {
  reason?: string
}

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController()
  let timeoutFired = false
  const timer = setTimeout(() => {
    timeoutFired = true
    controller.abort()
  }, timeoutMs)
  const external = init.signal ?? null
  const externalWasAborted = external !== null && external.aborted
  const onAbort = (): void => controller.abort()
  if (external !== null) {
    // 已经 abort 过的不再派发事件 ⇒ 必须显式接一次，否则请求照样发出去
    if (external.aborted) controller.abort()
    else external.addEventListener("abort", onAbort)
  }
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (err) {
    // 只标 `Error`（原生 fetch 抛的两种都是 Error 的子类）；别的值原样抛，不改成 Error。
    // ⚠️ 这里实际只会打 `"timeout"`：`externalWasAborted` 是上面那个**发起请求之前**取的快照，
    //    它一旦为 true，外部 abort 就已经先把 controller 掐了 ⇒ fetch 立刻拒 ⇒ 兜底 timer 随即
    //    被 finally 清掉 ⇒ `timeoutFired` 必为 false。唯一可能同真的窗口是"兜底开火之后、catch
    //    跑起来之前"用户又取消（竞态，良性），而那种迟到的取消事件改不了这个快照。保留整个
    //    谓词的理由与"别只删一半"的警告写在文件头那段注释里。
    if (timeoutFired && err instanceof Error) {
      const reason = externalWasAborted ? "aborted" : "timeout"
      ;(err as ReasonedError).reason = reason
    }
    throw err
  } finally {
    clearTimeout(timer)
    external?.removeEventListener("abort", onAbort)
  }
}

export function setTokens(userId: string, access: string, refresh: string): void {
  currentUserId = userId
  accessToken = access
  refreshToken = refresh
  authTokenSet.value = true
  void writeRefreshToken(userId, refresh)
}

export function clearTokens(): void {
  if (currentUserId) void deleteRefreshToken(currentUserId)
  currentUserId = null
  accessToken = null
  refreshToken = null
  authTokenSet.value = false
}

export async function getStoredRefreshToken(): Promise<string | null> {
  if (!currentUserId) return null
  return readRefreshToken(currentUserId)
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    const stored = await getStoredRefreshToken()
    if (!stored || !baseUrl) return false

    try {
      const res = await fetchWithTimeout(`${baseUrl}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: stored }),
      }, 5000)
      if (!res.ok) return false
      const data = await res.json()
      accessToken = data.access_token
      refreshToken = data.refresh_token
      if (currentUserId) void writeRefreshToken(currentUserId, data.refresh_token)
      return true
    } catch {
      return false
    }
  })()
  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

/**
 * `fetchWithTimeout` 抛出来的原因 → `apiFetch` 的 `status:0` 错误串。
 *
 * 三个原因必须分开（AI 那条路要用，见 `transport.ts` 的 `classifyZero`）：
 * - `"timeout"`：本层的 15s 兜底把请求掐了 ⇒ 用户该看到「分析超时」
 * - `"aborted"`：外部 signal 主动取消（AI 的"取消生成"）⇒ 用户自己停的。
 *   ⚠️ **实际几乎产不出来**（见 `fetchWithTimeout` 的 catch 与文件头那段）：实测在途取消得到
 *   的是 `"network error"` —— 唯一窗口是"兜底开火之后、catch 跑起来之前"用户又取消（竞态，
 *   且良性），而 `externalWasAborted` 取的是发起请求之前的快照 ⇒ 连这个窗口也合不上，所以
 *   `transport.ts` 的 `classifyZero` 那个 `"aborted"` 分支同样不可达 —— 用户看到"已取消"靠的
 *   是 transport 自己的 `signal.aborted` 前置判别。两者**成对保留**。
 * - `"network error"`：其余（断网 / DNS / TLS / 代理）⇒ 老的值，**不许变**（既有调用方依赖）
 *
 * ⚠️ 判据只有 `fetchWithTimeout` 挂的那个 `reason` 标签，**不看 `err.name`**：
 * `AbortError` 这个名字也可能来自"裸 fetch 自己抛的 AbortError"（无 signal），那种情况
 * 既不是我们的兜底超时、也不是外部取消 ⇒ 老的值。实测：按 `name` 判会让既有的
 * `apiFetch 网络异常`、`status:0 ⇒ network`、`apiFetch reject` 三条全红。
 */
export function networkErrorReason(err: unknown): string {
  if (err instanceof Error) {
    const reason = (err as ReasonedError).reason
    if (typeof reason === "string") return reason
  }
  return "network error"
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const url = `${getBaseUrl()}${path}`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  }

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`
  }

  let res: Response
  try {
    res = await fetchWithTimeout(url, { ...options, headers })
  } catch (err) {
    return { ok: false, status: 0, error: networkErrorReason(err) }
  }

  // 401 -> try refresh
  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`
      try {
        res = await fetchWithTimeout(url, { ...options, headers })
      } catch (err) {
        return { ok: false, status: 0, error: networkErrorReason(err) }
      }
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: body.error || res.statusText }
  }

  const data = await res.json().catch(() => undefined)
  return { ok: true, status: res.status, data }
}

export function isLoggedIn(): boolean {
  return accessToken !== null || refreshToken !== null
}

// --- Auth helpers ---

export interface User {
  id: string
  username: string
  nickname: string
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface AuthResponse {
  user: User
  access_token: string
  refresh_token: string
  ledger_id: string
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${getBaseUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }, 10000)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || '登录失败')
  }
  const data: AuthResponse = await res.json()
  setTokens(data.user.id, data.access_token, data.refresh_token)
  return data
}

export async function register(
  username: string,
  password: string,
  nickname?: string
): Promise<AuthResponse> {
  const res = await fetchWithTimeout(`${getBaseUrl()}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, nickname }),
  }, 10000)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || '注册失败')
  }
  const data: AuthResponse = await res.json()
  setTokens(data.user.id, data.access_token, data.refresh_token)
  return data
}

export interface UpdateProfileRequest {
  nickname?: string
  avatar_url?: string | null
}

export async function updateProfile(data: UpdateProfileRequest): Promise<User> {
  const res = await apiFetch<User>("/auth/profile", {
    method: "PUT",
    body: JSON.stringify(data),
  })
  if (!res.ok || !res.data) {
    throw new Error(res.error || "更新失败")
  }
  return res.data
}

export async function tryRestoreSession(userId: string): Promise<User | null> {
  const stored = await readRefreshToken(userId)
  if (!stored || !baseUrl) return null

  try {
    const res = await fetchWithTimeout(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: stored }),
    }, 5000)
    if (!res.ok) return null
    const data = await res.json()
    currentUserId = userId
    accessToken = data.access_token
    refreshToken = data.refresh_token
    authTokenSet.value = true
    void writeRefreshToken(userId, data.refresh_token)
    return data.user
  } catch {
    return null
  }
}

export async function fetchTeamMembers(teamId: string): Promise<TeamMember[]> {
  const res = await apiFetch<TeamMember[]>(`/teams/${teamId}/members`)
  if (!res.ok || !res.data) {
    throw new Error(res.error || "获取成员失败")
  }
  return res.data
}

