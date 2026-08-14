// src/services/tokenStorage.ts
import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "tokens.json";
const KEY = "refresh_token";

let storePromise: Promise<Store | null> | null = null;

// 惰性加载；非 Tauri 环境（浏览器 dev / 单元测试）load 会失败，回落 null → localStorage。
async function getStore(): Promise<Store | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        return await load(FILE, { autoSave: true });
      } catch {
        return null;
      }
    })();
  }
  return storePromise;
}

export async function readRefreshToken(): Promise<string | null> {
  const store = await getStore();
  if (store) return (await store.get<string>(KEY)) ?? null;
  return localStorage.getItem(KEY);
}

export async function writeRefreshToken(token: string): Promise<void> {
  const store = await getStore();
  if (store) await store.set(KEY, token);
  else localStorage.setItem(KEY, token);
}

export async function deleteRefreshToken(): Promise<void> {
  const store = await getStore();
  if (store) await store.delete(KEY);
  else localStorage.removeItem(KEY);
}
