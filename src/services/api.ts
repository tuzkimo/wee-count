// src/services/api.ts
import type { TeamMember } from "@/types";

let baseUrl: string | null = null

let accessToken: string | null = null
let refreshToken: string | null = null

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/$/, '') // 去掉末尾斜杠
}

export function getBaseUrl(): string {
  if (!baseUrl) throw new Error('API base URL not configured')
  return baseUrl
}

export function hasBaseUrl(): boolean {
  return baseUrl !== null
}

export function setTokens(access: string, refresh: string): void {
  accessToken = access
  refreshToken = refresh
  localStorage.setItem("refresh_token", refresh)
}

export function clearTokens(): void {
  accessToken = null
  refreshToken = null
  localStorage.removeItem("refresh_token")
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem("refresh_token")
}

async function refreshAccessToken(): Promise<boolean> {
  const stored = getStoredRefreshToken()
  if (!stored || !baseUrl) return false

  try {
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: stored }),
    })
    if (!res.ok) return false
    const data = await res.json()
    accessToken = data.access_token
    refreshToken = data.refresh_token
    localStorage.setItem("refresh_token", data.refresh_token)
    return true
  } catch {
    return false
  }
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

  let res = await fetch(url, { ...options, headers })

  // 401 -> try refresh
  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken()
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`
      res = await fetch(url, { ...options, headers })
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
  return accessToken !== null || getStoredRefreshToken() !== null
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
  const res = await fetch(`${getBaseUrl()}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || '登录失败')
  }
  const data: AuthResponse = await res.json()
  setTokens(data.access_token, data.refresh_token)
  return data
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
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || '注册失败')
  }
  const data: AuthResponse = await res.json()
  setTokens(data.access_token, data.refresh_token)
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

export async function tryRestoreSession(): Promise<User | null> {
  const stored = getStoredRefreshToken()
  if (!stored || !baseUrl) return null

  try {
    const res = await fetch(`${baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: stored }),
    })
    if (!res.ok) return null
    const data = await res.json()
    accessToken = data.access_token
    refreshToken = data.refresh_token
    localStorage.setItem('refresh_token', data.refresh_token)
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

