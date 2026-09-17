// src/services/settingsFile.ts
import { load, type Store } from "@tauri-apps/plugin-store";

/**
 * settings.json 的通用读写层。
 *
 * 存在的理由只有一个：把「在不在 Tauri 内、store 能不能用」这个三态判定收敛到**一处**。
 * 锁配置与隐私设置落在同一个 settings.json 里，各抄一份判定的话两份策略早晚漂移
 * （一边在 error 态 fail-open、另一边静默回落到 localStorage），R74 那类事故就是这么来的。
 *
 * 本模块只管机制，不做裁决：**不决定「读不到时该用什么值」**（那是调用方的业务判断），
 * 也不替调用方吞错 —— 读失败如实返回 `unavailable`，写/删失败一律 reject + 记日志。
 */
const FILE = "settings.json";

/** 读结果。调用方必须把 `absent` 与 `invalid` 分开对待，两者的写回策略不同（见各字段说明）。 */
export type SettingRead<T> =
  | { kind: "found"; value: T }
  /** 键不存在（或为空）：可以安全地写入初值。 */
  | { kind: "absent" }
  /**
   * 键在、但取值不可解析：**不要**覆盖它（可能是别的版本写的更富结构），
   * 只在内存里回落默认值。把「读不懂」当「不存在」而去写初值，就是在覆盖别人的数据。
   */
  | { kind: "invalid" }
  /** 没能读到：`load` 是 settings.json 整个加载失败，`storage` 是按键读取/存取被拒。 */
  | { kind: "unavailable"; stage: "load" | "storage"; cause: unknown };

/** 写/删的日志与报错口径。`tag` 是模块名，`label` + `action` 组成用户与日志都能读懂的中文短语。 */
export interface SettingLogContext {
  tag: string;
  label: string;
  action: string;
}

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

// 显式环境探测：不靠 load() 抛错反推「是否在 Tauri 内」。
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 构造持久化失败的错误。target 是 ES2020，用不了 `new Error(msg, { cause })`，
 * 因此把根因挂在 `cause` 属性上，方便调用方与日志追溯。
 */
function persistError(message: string, cause: unknown): Error {
  return Object.assign(new Error(message), { cause });
}

// 只缓存成功结果。失败不锁存，下次调用会重新 load()，
// 避免暂时性故障变成永久降级（降级后配置只会写进 localStorage，与重启后的真相源漂移）。
// 顺带一个副作用是好的：同一轮启动里锁配置与隐私设置共用同一个 store 实例，只加载一次文件。
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

function parseStored<T>(text: string, parse: (raw: unknown) => T | null): SettingRead<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  const value = parse(raw);
  return value === null ? { kind: "invalid" } : { kind: "found", value };
}

/**
 * 读一个键，**永不抛错**：读不出来返回 `unavailable`，由调用方决定回落成什么。
 *
 * 启动路径上有 `await readXxx(); ...; app.mount("#app")`，这里 reject 会直接白屏，
 * 所以「读失败」必须是返回值而不是异常。
 */
export async function readSetting<T>(
  key: string,
  parse: (raw: unknown) => T | null,
): Promise<SettingRead<T>> {
  const resolved = await resolveStore();

  if (resolved.kind === "error") {
    return { kind: "unavailable", stage: "load", cause: resolved.cause };
  }

  if (resolved.kind === "web") {
    // WebView 存储被禁用/受限时 getItem 会抛 SecurityError；localStorage 本身也可能不存在。
    let text: string | null;
    try {
      text = typeof localStorage === "undefined" ? null : localStorage.getItem(key);
    } catch (cause) {
      return { kind: "unavailable", stage: "storage", cause };
    }
    if (!text) return { kind: "absent" };
    return parseStored(text, parse);
  }

  try {
    const raw = (await resolved.store.get(key)) ?? null;
    if (raw === null) return { kind: "absent" };
    const value = parse(raw);
    return value === null ? { kind: "invalid" } : { kind: "found", value };
  } catch (cause) {
    return { kind: "unavailable", stage: "storage", cause };
  }
}

/**
 * 写一个键。**持久化失败必须 reject**：调用方几乎都是用户主动发起的动作，
 * 静默返回等于对用户动作做假确认（界面提示「已保存」而磁盘上什么都没有，下次启动又变回去）。
 */
export async function writeSetting(
  key: string,
  value: unknown,
  log: SettingLogContext,
): Promise<void> {
  const resolved = await resolveStore();

  // error 态绝不回落到 localStorage：那会造成两份真相源漂移
  // （新设的锁下次启动消失、清掉的锁下次启动复活、配置永久迁到 WebView）。
  if (resolved.kind === "error") {
    console.warn(`[${log.tag}] settings.json 加载失败，${log.label}未${log.action}`, resolved.cause);
    throw persistError(
      `${log.tag}: settings.json 加载失败，${log.label}未${log.action}`,
      resolved.cause,
    );
  }

  if (resolved.kind === "web") {
    if (typeof localStorage === "undefined") {
      const cause = new Error("localStorage 不可用");
      console.warn(`[${log.tag}] localStorage 不可用，${log.label}未${log.action}`, cause);
      throw persistError(`${log.tag}: localStorage 不可用，${log.label}未${log.action}`, cause);
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (cause) {
      // 存储被禁用（SecurityError）或配额耗尽（QuotaExceededError）。
      console.warn(`[${log.tag}] ${log.label}${log.action} localStorage 失败`, cause);
      throw persistError(`${log.tag}: ${log.label}${log.action} localStorage 失败`, cause);
    }
    return;
  }

  try {
    await resolved.store.set(key, value);
    await resolved.store.save();
  } catch (cause) {
    console.warn(`[${log.tag}] ${log.label}${log.action} settings.json 失败`, cause);
    throw persistError(`${log.tag}: ${log.label}${log.action} settings.json 失败`, cause);
  }
}

/** 删除一个键。失败同样必须 reject，理由见 writeSetting。 */
export async function deleteSetting(key: string, log: SettingLogContext): Promise<void> {
  const resolved = await resolveStore();

  // 同理：error 态只删 localStorage 会让 settings.json 里的原值在下次启动复活。
  if (resolved.kind === "error") {
    console.warn(`[${log.tag}] settings.json 加载失败，${log.label}未${log.action}`, resolved.cause);
    throw persistError(
      `${log.tag}: settings.json 加载失败，${log.label}未${log.action}`,
      resolved.cause,
    );
  }

  if (resolved.kind === "web") {
    if (typeof localStorage === "undefined") {
      const cause = new Error("localStorage 不可用");
      console.warn(`[${log.tag}] localStorage 不可用，${log.label}未${log.action}`, cause);
      throw persistError(`${log.tag}: localStorage 不可用，${log.label}未${log.action}`, cause);
    }
    try {
      localStorage.removeItem(key);
    } catch (cause) {
      console.warn(`[${log.tag}] ${log.label}${log.action} localStorage 失败`, cause);
      throw persistError(`${log.tag}: ${log.label}${log.action} localStorage 失败`, cause);
    }
    return;
  }

  try {
    await resolved.store.delete(key);
    await resolved.store.save();
  } catch (cause) {
    console.warn(`[${log.tag}] ${log.label}${log.action} settings.json 失败`, cause);
    throw persistError(`${log.tag}: ${log.label}${log.action} settings.json 失败`, cause);
  }
}
