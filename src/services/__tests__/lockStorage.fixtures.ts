// src/services/__tests__/lockStorage.fixtures.ts
// lockStorage 测试的共享纯夹具（非测试文件，不会被 vitest 收集）。
// 环境探测是显式的（"__TAURI_INTERNALS__" in window），因此测试通过注入/移除该标记
// 来切换「是否在 Tauri 内」，并用假 store 替换 plugin-store，不依赖 Tauri 运行时。
import type { AppLockConfig } from "@/services/lockStorage";

export const KEY = "app_lock";

/** 真实的 60 字符 bcrypt 哈希：$2b$ + cost 两位 + $ + 53 个 base64 字符。 */
export const BCRYPT_HASH = "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export const valid: AppLockConfig = {
  type: "pin",
  hash: BCRYPT_HASH,
  biometric_enabled: false,
  auto_lock_seconds: 60,
  screenshot_protection: true,
};

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

export function enterTauri(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
}

export function exitTauri(): void {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}
