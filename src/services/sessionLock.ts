// src/services/sessionLock.ts
//
// 跨进程自动锁窗口：读原生写的会话记录，决定**本次启动要不要上锁**，并维护
// 「本段前台期已过门禁」标记。
//
// 两个文件都在 `cacheDir/wee-session/` 下（与 Kotlin 侧 `MainActivity` 的
// `SESSION_DIR` / 文件名逐字一致）：
//  - `session.json`：**原生写，前端只读**。`onStop` ⇒ `{"reason":"background"}`；
//    `onDestroy(isFinishing)` ⇒ `{"reason":"user_closed"}`。
//  - `authenticated`：**前端写，原生删**。语义是"当前这一段前台期已经过了门禁"：
//    用户解锁过，或启动判定本来就不需要锁。原生在 `onStop` / `onDestroy` 时删掉它，
//    于是它只代表当前这一段前台期，不会跨段生效。
//
// 为什么标记要落盘而不是放内存：页面重载（dev HMR、渲染进程崩溃）会把内存全丢，
// 而那时用户正用着 App —— 不落盘就会把正在用的人踢回解锁页。
//
// ⚠️ 本模块**永不抛错**：它决定的是"要不要把用户挡在门外"，任何读不出来的情况都必须在
// 调用方（`main.ts`）拿到一个值。方向一律从严（读不到 ⇒ 上锁），只有"窗口内 + 切后台"
// 才放行。
import { BaseDirectory, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { shouldLockOnBoot, type SessionEndRecord } from "@/utils/autoLock";

/** 与 `MainActivity.kt` 的 SESSION_DIR / SESSION_RECORD / SESSION_MARK 逐字一致 */
const SESSION_DIR = "wee-session";
const RECORD_NAME = "session.json";
const MARK_NAME = "authenticated";

/** 记录只认这个版本（与分享 payload 的 `v` 同款理由：新 JS 可能配到旧 APK 的原生） */
const SESSION_RECORD_VERSION = 1;

function sessionPath(name: string): string {
  return `${SESSION_DIR}/${name}`;
}

/**
 * 显式环境探测（与 `services/settingsFile.ts` 同款：不靠"调用抛错"反推是否在 Tauri 内）。
 *
 * 这两个文件是**原生 Android 侧**写/删的能力：桌面端（开发调试）与单测环境没有原生那一半，
 * 判定只能退化成"每次都要求解锁"，与改造前一致。这里显式短路是为了不让"环境本来就没有
 * 这个能力"刷出与"真配错了 ACL/scope"一模一样的日志 —— 后者必须留痕。
 */
function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * plugin-fs 对"文件不存在"的报错来自 Rust `io::Error` 的 Display（含 `"os error 2"`）。
 * 与 `useShareIntake` 的判断同款：误判成"不存在"时行为与从严一侧相同，代价可接受。
 */
function isNotFound(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /not found|no such file|os error 2/i.test(text);
}

/**
 * 解析 `session.json` 的原文。`null` = 形状/版本不认 —— 调用方**按"没有记录"处理**
 * （即从严上锁）。只挑自己认识的字段：将来多写的键不参与判定。
 */
export function parseSessionEnd(raw: unknown): SessionEndRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (rec.v !== SESSION_RECORD_VERSION) return null;
  if (typeof rec.at !== "number" || !Number.isFinite(rec.at)) return null;
  if (rec.reason !== "background" && rec.reason !== "user_closed") return null;
  // 缺字段/类型不对 ⇒ false（从严）：老版本原生写的记录没有这个字段，只按窗口放行是不安全的
  const authenticated = rec.authenticated === true;
  return { at: rec.at, reason: rec.reason, authenticated };
}

/** 读原生写的会话记录。**永不抛错**：读不到/认不出 ⇒ `null`。 */
export async function readSessionEnd(): Promise<SessionEndRecord | null> {
  if (!isTauriRuntime()) return null;
  let raw: string;
  try {
    raw = await readTextFile(sessionPath(RECORD_NAME), { baseDir: BaseDirectory.AppCache });
  } catch (e) {
    // "文件不存在"是正常路径（首启、刚更新完、缓存被系统清掉）：不打日志。
    // 其它错误（scope 配错、权限、磁盘）必须留痕 —— 它会让判定退化成"每次都要求解锁"。
    if (!isNotFound(e)) {
      console.warn("[sessionLock] 读取会话记录失败，本次按从严上锁处理", e);
    }
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const record = parseSessionEnd(parsed);
  if (record === null) {
    console.warn("[sessionLock] 会话记录形状不认，本次按从严上锁处理");
  }
  return record;
}

/**
 * 读"本段前台期已过门禁"标记的**时间戳**（毫秒）。读不到/内容认不出 ⇒ `null`。
 *
 * 返回时间戳而不是布尔值，是为了让调用方能判断"这个标记属于哪一段"：标记必须在
 * **上一次离场之后**写下才算数（见 `decideBootLock`）。只看存在性的话，一次写入/删除竞态
 * （`unlock()` 的异步写落在原生删标记之后）留下的残留标记会**永久**放行。
 *
 * 读取失败只 warn，不抛：这个标记只影响"要不要再判一次"，不该让启动失败。
 */
export async function readSessionMark(): Promise<number | null> {
  if (!isTauriRuntime()) return null;
  let raw: string;
  try {
    raw = await readTextFile(sessionPath(MARK_NAME), { baseDir: BaseDirectory.AppCache });
  } catch (e) {
    if (!isNotFound(e)) {
      console.warn("[sessionLock] 读取门禁标记失败，按未过门禁处理", e);
    }
    return null;
  }
  const at = Number(raw.trim());
  return Number.isFinite(at) && at > 0 ? at : null;
}

/**
 * 确保 `wee-session/` 目录存在。
 *
 * **必须显式建**：plugin-fs 的 `writeTextFile` 是 `OpenOptions { create }` 打开文件
 * （`resolve_file`），**不会**创建父目录；而 `fs:default` 里允许 `mkdir` 的 scope
 * （`scope-app-index`）只覆盖 `$APPCACHE` 本身、不含子目录 ⇒ capability 里为
 * `$APPCACHE/wee-session` 单开了一条 `fs:allow-mkdir`。
 *
 * `recursive: true` 对已存在的目录是**成功**（Rust `DirBuilder::recursive` → `create_dir_all`），
 * 所以这里可以无脑重复调用 —— 真机上这个目录通常已经由原生在 `onCreate` 建好了。
 */
async function ensureSessionDir(): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { baseDir: BaseDirectory.AppCache, recursive: true });
  } catch (e) {
    // 建不出来仍然继续往下写：目录可能本来就在（原生建的），写那一步会自己报错。
    console.warn("[sessionLock] 创建会话记录目录失败，继续尝试写入", e);
  }
}

/**
 * 记下"本段前台期已过门禁"。**永不抛错**：写不进去只是下一次重载会重判一次，
 * 不该让解锁动作或启动流程因此失败。
 *
 * 时间戳取**解锁那一刻**（在 `ensureSessionDir()` 之前取），不是写盘那一刻：
 * `mkdir` 是一次 IPC 往返，用户完全可能在这个窗口里按 Home —— 原生 `onStop` 会先写下
 * `background(at = t_s)`，若等 mkdir 返回再取 `Date.now()`，落盘的就是 `t_m > t_s`，
 * 于是"标记比记录新 ⇒ 本段已过门禁"下次启动会**绕过 autoLock 窗口**（用户确实解锁过，
 * 但窗口被判无效）。提前取之后，"标记不会晚于同段结束时的记录"对 `onStop`/`onDestroy`
 * 也结构性成立，不只是一个通常成立的巧合。
 */
export async function markSessionAuthenticated(): Promise<void> {
  if (!isTauriRuntime()) return;
  const markedAt = Date.now();
  await ensureSessionDir();
  try {
    await writeTextFile(sessionPath(MARK_NAME), String(markedAt), {
      baseDir: BaseDirectory.AppCache,
    });
  } catch (e) {
    console.warn("[sessionLock] 记录门禁标记失败", e);
  }
}

/**
 * 本次启动要不要上锁（`main.ts` 的唯一入口）。
 *
 * 判定顺序：
 *  1. 本段前台期已经过门禁（标记的时间戳**晚于**上一次离场、且不晚于现在）⇒ 不上锁。
 *     这条覆盖的是"同一次前台期内的重启"：dev HMR、WebView 渲染进程崩溃、未被 manifest
 *     接管的配置变更。两个条件都不能省：晚于离场 —— `unlock()` 是异步写盘，可能落在原生
 *     删标记之后，只看存在性就会把一次残留标记当成永久通行证；不晚于现在 —— 标记跑到未来
 *     只可能是系统时间被往回调，那时它对"本段已过门禁"没有证明力（记录落在未来时
 *     `shouldLockOnBoot` 已经从严，这条通道不该比它松）。记录不存在时也不采信标记
 *     （无从判断新旧）。
 *     ⚠️ 记录是 `user_closed` 时也认这条：那份记录**之后**用户真的解锁过，标记就是证据；
 *     而"划掉后重开必锁"由原生在离开时删掉标记（`onStop`/`onDestroy`）来保证，
 *     不靠 `reason` 压过标记 —— 否则"划掉 → 重开 → 解锁 → 前台重载"会再踢回解锁页。
 *  2. 其余交给 `shouldLockOnBoot`：窗口内的后台返回放行，`user_closed`／本段没解锁过／
 *     窗口或时钟异常一律从严。
 *
 * 放行时顺手把本段记成"已过门禁"：否则紧接着的一次重载会重判一次，而那时记录早已
 * 超出窗口 ⇒ 正在用 App 的人被要求解锁。
 */
export async function decideBootLock(autoLockSeconds: number): Promise<boolean> {
  const record = await readSessionEnd();
  const markAt = await readSessionMark();
  const now = Date.now();
  // `markAt <= now` 这一半堵时钟回拨：记录落在"未来"时 `shouldLockOnBoot` 已经从严
  // （`elapsed < 0` ⇒ 上锁），标记通道不能反而比它松。时间戳跑到未来只可能是系统时间被
  // 往回调过，那时"标记比记录新"就不再是"本段已过门禁"的证据。
  if (record !== null && markAt !== null && markAt > record.at && markAt <= now) {
    return false;
  }
  const verdict = shouldLockOnBoot(record, now, autoLockSeconds);
  if (!verdict) void markSessionAuthenticated();
  return verdict;
}
