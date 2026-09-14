// src/services/lockStorage.ts
import { load, type Store } from "@tauri-apps/plugin-store";

/**
 * 锁配置存独立文件，**不要**与 tokens.json 合并：
 * token 的生命周期（登录/登出/解绑）与锁配置无关，混在一起会互相牵连。
 */
const FILE = "settings.json";
const KEY = "app_lock";

export type LockType = "pin" | "pattern";

export interface AppLockConfig {
  type: LockType;
  hash: string;
  biometric_enabled: boolean;
  auto_lock_seconds: number;
  screenshot_protection: boolean;
}

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

/**
 * 校验并归一化配置。任何字段不合法一律返回 null——
 * 「配置读不出来」按「未配置锁」处理，绝不把用户锁在门外。
 */
export function parseAppLock(raw: unknown): AppLockConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.type !== "pin" && r.type !== "pattern") return null;
  if (typeof r.hash !== "string" || r.hash.length === 0) return null;
  if (typeof r.biometric_enabled !== "boolean") return null;
  if (typeof r.auto_lock_seconds !== "number" || !Number.isFinite(r.auto_lock_seconds)) return null;
  if (typeof r.screenshot_protection !== "boolean") return null;

  return {
    type: r.type,
    hash: r.hash,
    biometric_enabled: r.biometric_enabled,
    auto_lock_seconds: r.auto_lock_seconds,
    screenshot_protection: r.screenshot_protection,
  };
}

export async function readAppLock(): Promise<AppLockConfig | null> {
  const store = await getStore();
  let raw: unknown;
  if (store) {
    raw = (await store.get(KEY)) ?? null;
  } else {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
  }
  return parseAppLock(raw);
}

export async function writeAppLock(config: AppLockConfig): Promise<void> {
  const store = await getStore();
  if (store) {
    await store.set(KEY, config);
    await store.save();
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(config));
}

export async function clearAppLock(): Promise<void> {
  const store = await getStore();
  if (store) {
    await store.delete(KEY);
    await store.save();
    return;
  }
  localStorage.removeItem(KEY);
}
