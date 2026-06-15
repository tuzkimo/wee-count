// src/services/api.ts
const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080/api/v1";

let accessToken: string | null = null;
let refreshToken: string | null = null;

export function setTokens(access: string, refresh: string): void {
  accessToken = access;
  refreshToken = refresh;
  localStorage.setItem("refresh_token", refresh);
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem("refresh_token");
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem("refresh_token");
}

async function refreshAccessToken(): Promise<boolean> {
  const stored = getStoredRefreshToken();
  if (!stored) return false;

  try {
    const res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: stored }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    accessToken = data.access_token;
    refreshToken = data.refresh_token;
    localStorage.setItem("refresh_token", data.refresh_token);
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  let res = await fetch(url, { ...options, headers });

  // 401 -> try refresh
  if (res.status === 401 && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      headers["Authorization"] = `Bearer ${accessToken}`;
      res = await fetch(url, { ...options, headers });
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, status: res.status, error: body.error || res.statusText };
  }

  const data = await res.json().catch(() => undefined);
  return { ok: true, status: res.status, data };
}

export function isLoggedIn(): boolean {
  return accessToken !== null || getStoredRefreshToken() !== null;
}
