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

/** 真实 bcrypt 哈希：$2a$/$2b$/$2y$ + 两位 cost + $ + 53 个 base64 字符（合计 60）。 */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * 当前运行环境的三态判定：
 * - tauri：在 Tauri 内且 settings.json 加载成功
 * - web  ：不在 Tauri 内（浏览器 dev / 单元测试）→ 用 localStorage
 * - error：在 Tauri 内但加载失败
 */
type StoreResolution =
  | { kind: "tauri"; store: Store }
  | { kind: "web" }
  | { kind: "error"; cause: unknown };

// 显式环境探测：不再靠 load() 抛错反推「是否在 Tauri 内」。
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// 只缓存成功结果。失败不锁存，下次调用会重新 load()，
// 避免暂时性故障变成永久降级（降级后配置只会写进 localStorage，与重启后的真相源漂移）。
let storePromise: Promise<Store> | null = null;

async function resolveStore(): Promise<StoreResolution> {
  if (!isTauriRuntime()) return { kind: "web" };

  if (!storePromise) {
    storePromise = load(FILE, { autoSave: true });
  }
  try {
    return { kind: "tauri", store: await storePromise };
  } catch (cause) {
    storePromise = null;
    return { kind: "error", cause };
  }
}

/**
 * 校验并归一化配置。任何字段不合法一律返回 null——
 * 「配置读不出来」按「未配置锁」处理，绝不把用户锁在门外。
 * hash 必须是格式合法的 bcrypt 哈希：格式坏掉的哈希会让正确口令也永远验不过。
 */
export function parseAppLock(raw: unknown): AppLockConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.type !== "pin" && r.type !== "pattern") return null;
  if (typeof r.hash !== "string" || !BCRYPT_HASH_RE.test(r.hash)) return null;
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

/**
 * 读锁配置，**永不抛错**（Tauri 分支的 store 操作同样被兜住）：
 * 启动路径是 `await readAppLock(); ...; app.mount("#app")`，这里 reject 会直接白屏。
 * 读不出来按「未配置锁」处理。
 */
export async function readAppLock(): Promise<AppLockConfig | null> {
  const resolved = await resolveStore();

  if (resolved.kind === "error") {
    console.warn("[lockStorage] settings.json 加载失败，本次按未配置锁处理", resolved.cause);
    return null;
  }

  if (resolved.kind === "web") {
    const text = localStorage.getItem(KEY);
    if (!text) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    return parseAppLock(raw);
  }

  try {
    const raw = (await resolved.store.get(KEY)) ?? null;
    return parseAppLock(raw);
  } catch (cause) {
    console.warn("[lockStorage] 读取锁配置失败，本次按未配置锁处理", cause);
    return null;
  }
}

/** 写入前先过一遍 parseAppLock：写入方是应用自己的代码，非法输入应当立刻炸在根因处。 */
export async function writeAppLock(config: AppLockConfig): Promise<void> {
  const parsed = parseAppLock(config);
  if (!parsed) {
    throw new Error("writeAppLock: 锁配置不合法，拒绝写入");
  }

  const resolved = await resolveStore();

  // error 态绝不回落到 localStorage：那会造成两份真相源漂移
  // （新设的锁下次启动消失、清掉的锁下次启动复活、锁配置永久迁到 WebView）。
  if (resolved.kind === "error") {
    console.warn("[lockStorage] settings.json 加载失败，锁配置未写入", resolved.cause);
    return;
  }

  if (resolved.kind === "web") {
    localStorage.setItem(KEY, JSON.stringify(parsed));
    return;
  }

  try {
    await resolved.store.set(KEY, parsed);
    await resolved.store.save();
  } catch (cause) {
    console.warn("[lockStorage] 写入锁配置失败", cause);
  }
}

export async function clearAppLock(): Promise<void> {
  const resolved = await resolveStore();

  // 同理：error 态只删 localStorage 会让 settings.json 里的合法锁在下次启动复活。
  if (resolved.kind === "error") {
    console.warn("[lockStorage] settings.json 加载失败，锁配置未清除", resolved.cause);
    return;
  }

  if (resolved.kind === "web") {
    localStorage.removeItem(KEY);
    return;
  }

  try {
    await resolved.store.delete(KEY);
    await resolved.store.save();
  } catch (cause) {
    console.warn("[lockStorage] 清除锁配置失败", cause);
  }
}
