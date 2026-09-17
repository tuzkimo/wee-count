// src/services/lockStorage.ts
import { deleteSetting, readSetting, writeSetting } from "@/services/settingsFile";

/**
 * 锁配置存独立文件，**不要**与 tokens.json 合并：
 * token 的生命周期（登录/登出/解绑）与锁配置无关，混在一起会互相牵连。
 *
 * 键名与文件位置由 `settingsFile` 统一管理（同一文件里还有独立的截屏防护设置）。
 */
const KEY = "app_lock";
const LOG = { tag: "lockStorage", label: "锁配置" } as const;

export type LockType = "pin" | "pattern";

/**
 * 应用锁配置。
 *
 * **不含截屏防护**：FLAG_SECURE 是窗口级开关，有没有应用锁都成立，它存在
 * `privacySettings` 的独立键里。历史上它曾是本结构的一个字段，代价是
 * 「没有应用锁」等于「这个设置既读不出也写不进」（本结构的 hash 是必填的），
 * 于是用户想关掉截屏防护就必须先建一把应用锁。别把它加回来。
 */
export interface AppLockConfig {
  type: LockType;
  hash: string;
  biometric_enabled: boolean;
  auto_lock_seconds: number;
}

/** 真实 bcrypt 哈希：$2a$/$2b$/$2y$ + 两位 cost + $ + 53 个 base64 字符（合计 60）。 */
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

/**
 * 校验并归一化配置。任何字段不合法一律返回 null——
 * 「配置读不出来」按「未配置锁」处理，绝不把用户锁在门外。
 * hash 必须是格式合法的 bcrypt 哈希：格式坏掉的哈希会让正确口令也永远验不过。
 *
 * 结构外的字段（含 1.1.x 遗留的 `screenshot_protection`）被**忽略**：
 * 这里只取自己认识的字段，不因为多了个字段就把用户判成「未配置锁」。
 */
export function parseAppLock(raw: unknown): AppLockConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.type !== "pin" && r.type !== "pattern") return null;
  if (typeof r.hash !== "string" || !BCRYPT_HASH_RE.test(r.hash)) return null;
  if (typeof r.biometric_enabled !== "boolean") return null;
  if (typeof r.auto_lock_seconds !== "number" || !Number.isFinite(r.auto_lock_seconds)) return null;

  return {
    type: r.type,
    hash: r.hash,
    biometric_enabled: r.biometric_enabled,
    auto_lock_seconds: r.auto_lock_seconds,
  };
}

/**
 * 读锁配置，**读路径永不抛错**（`readSetting` 的契约）：
 * 读不出来按「未配置锁」处理。
 *
 * 范围仅限**读**：写/清除是用户主动发起的动作，持久化失败必须 reject（见 writeAppLock）。
 */
export async function readAppLock(): Promise<AppLockConfig | null> {
  const read = await readSetting<AppLockConfig>(KEY, parseAppLock);
  if (read.kind === "found") return read.value;

  if (read.kind === "unavailable") {
    console.warn(
      read.stage === "load"
        ? "[lockStorage] settings.json 加载失败，本次按未配置锁处理"
        : "[lockStorage] 读取锁配置失败，本次按未配置锁处理",
      read.cause,
    );
  }
  return null;
}

/**
 * 写入锁配置。
 *
 * 与读路径不同，**持久化失败必须 reject**：这是用户主动发起的动作，
 * 静默返回等于对用户动作做假确认（UI 提示「已开启」而磁盘上什么都没有，
 * 下次启动锁直接消失）。调用方 await 到 rejection 就会自然跳过成功提示。
 */
export async function writeAppLock(config: AppLockConfig): Promise<void> {
  // 写入前先过一遍 parseAppLock：写入方是应用自己的代码，非法输入应当立刻炸在根因处。
  const parsed = parseAppLock(config);
  if (!parsed) {
    throw new Error("writeAppLock: 锁配置不合法，拒绝写入");
  }

  await writeSetting(KEY, parsed, { ...LOG, action: "写入" });
}

/** 清除锁配置。持久化失败同样必须 reject，理由见 writeAppLock。 */
export async function clearAppLock(): Promise<void> {
  await deleteSetting(KEY, { ...LOG, action: "清除" });
}
