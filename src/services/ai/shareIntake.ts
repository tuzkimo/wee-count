// src/services/ai/shareIntake.ts
// 系统分享进来的截图：解析 payload → 读字节 → 走共用附件函数 → 写进 store → 进 AI 页 → 消费掉。
//
// 四条边界（都有能红的用例，见 __tests__/shareIntake.test.ts）：
//  1. **锁定时零 IO**：锁屏期间不读、不消费 —— pending 留在磁盘等解锁后再拉（设计 §5.4）。
//  2. **必须消费**：成功、失败、甚至形状不认，都要把 inbox 清掉；不清就会每次回前台弹一次文案。
//  3. **去重按 `pending.json` 原文**（模块内内存）：删除失败时不重试、不阻塞，但同一份原文
//     本进程内不再处理第二次。新分享一定覆盖 `pending.json`（文件名带 uuid）⇒ 原文必变。
//  4. **零插件依赖**：依赖全从参数进来（`shareIntake.ts` 里没有任何 `@tauri-apps/*`），
//     于是整套契约能在 happy-dom 里跑。
import {
  MSG_MULTIPLE_TAKEN,
  MSG_READ_FAILED,
  messageForShareCode,
  type ShareErrorCode,
} from "./attachText";
// 只借类型：`import type` 不会把 imageInput（它 import 两个 Tauri 插件）拉进运行期模块图
import type { ImageAttachment, PickResult } from "./imageInput";

/** `pending.json` 只认这个版本（设计 §4.2）：开发期 Vite 的新 JS 可能配到旧 APK 的 Kotlin */
const SHARE_PAYLOAD_VERSION = 1;

export type PendingPayload =
  | { v: 1; kind: "image"; file: string; count: number }
  | { v: 1; kind: "error"; code: ShareErrorCode };

export interface ShareIntakeDeps {
  isLocked: () => boolean;
  readPending: () => Promise<string | null>;
  readBytes: (file: string) => Promise<Uint8Array>;
  consume: (payload: PendingPayload | null) => Promise<void>;
  /**
   * 收窄掉 `null`：`PickResult` 里的 `null` 语义是"用户在选择器里点了取消"，而分享链**没有**这一步
   * （任务 1 的 `toAttachment` 本身就声明为永不返回 `null`，见 `imageInput.ts` 的说明）。
   * 按 `PickResult` 收会让 strict 下的每次字段访问多出一条给不存在状态编的 `null` 分支。
   */
  toAttachment: (bytes: Uint8Array) => Promise<Exclude<PickResult, null>>;
  setAttachedImage: (image: ImageAttachment) => void;
  setNotice: (text: string) => void;
  pushAi: () => void;
}

export type IntakeOutcome = "none" | "attached" | "failed" | "skipped";

/**
 * 已知的原生错误 code 集合。类型用 `Record<ShareErrorCode, true>`：**加第 4 个 code 时忘了改这里
 * 就是编译错（TS2741）**；数组则要靠 `as readonly string[]` 断言把类型系统挡在外面，等于把
 * "漏掉一个 code"留给运行期。
 *
 * ⚠️ 成员校验必须用 `Object.prototype.hasOwnProperty.call(...)`，**不能**用 `code in ERROR_CODES`：
 * `in` 会走**原型链**（`"constructor" in ERROR_CODES === true`），于是
 * `{"v":1,"kind":"error","code":"constructor"}` 会被当成合法 payload，`messageForShareCode`
 * 查表拿到 `Object` 构造函数 ⇒ `setNotice(函数)` ⇒ AI 页渲染出 `function Object() { [native code] }`。
 * 同理**不要用 `Object.hasOwn`**：`tsconfig.json` 的 `lib` 是 ES2020，没有它。
 */
const ERROR_CODES: Record<ShareErrorCode, true> = {
  no_stream: true,
  read_failed: true,
  source_too_large: true,
};

/**
 * 解析 `pending.json` 原文。`null` = 形状/版本不认（调用方按读失败处理**并消费掉**）。
 *
 * ⚠️ 只挑已知键：`mime` 之类的多余字段一律不进结果 —— 准入判据只有字节头（M4 的裁决），
 * 这里若把声明的类型带下去，就等于给"第二道否决权"留了复活的口子。
 */
export function parsePending(raw: string): PendingPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const rec = parsed as Record<string, unknown>;
  if (rec.v !== SHARE_PAYLOAD_VERSION) return null;

  if (rec.kind === "error") {
    const code = rec.code;
    // 只认**自有键**（原型链上的 `constructor` / `toString` 不是合法 code）
    if (typeof code === "string" && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) {
      return { v: 1, kind: "error", code: code as ShareErrorCode };
    }
    return null;
  }

  if (rec.kind === "image") {
    const file = rec.file;
    if (typeof file !== "string" || file === "") return null;
    const count = typeof rec.count === "number" && Number.isFinite(rec.count) ? rec.count : 1;
    return { v: 1, kind: "image", file, count };
  }

  return null;
}

/** 本进程内"处理过"的那份原文（设计 §5.3 第 6 条）。只在内存：重启后会再处理一次。 */
let consumedRaw: string | null = null;
/** 单飞：多个拉取点撞在一起时只跑一条（boot / visible / resumed / 解锁后）。 */
let inFlight: Promise<IntakeOutcome> | null = null;

/**
 * 拉取一次。**只兜 IO 依赖与路由**：`readPending` / `readBytes` / `consume` 的异常在这里被转成
 * 了返回值或 `console.warn`，`pushAi` 被 `pushAiQuietly` 的 try 包住；但 `toAttachment` /
 * `setAttachedImage` / `setNotice` 抛错仍会让本函数 **reject**（store 写入方按约定不抛）。
 * ⇒ 调用方在事件回调里仍需自己兜边界（见 `useShareIntake` 的 `pull()`）。
 */
export async function intakeShare(deps: ShareIntakeDeps): Promise<IntakeOutcome> {
  if (inFlight !== null) return inFlight;
  inFlight = runIntake(deps).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runIntake(deps: ShareIntakeDeps): Promise<IntakeOutcome> {
  if (deps.isLocked()) return "skipped";

  let raw: string | null;
  try {
    raw = await deps.readPending();
  } catch (e) {
    // 读不到不等于"没有分享"：不消费、不弹文案，留给下一次拉取重试
    console.warn("[ai/share] 读 pending.json 失败：", e);
    return "none";
  }
  if (raw === null || raw === consumedRaw) return "none";

  // 从这一行起，这份原文就"记账"了：无论成功、失败还是删除失败，同一份原文不再处理第二次
  consumedRaw = raw;

  const payload = parsePending(raw);
  if (payload === null) {
    console.warn("[ai/share] pending.json 形状不认，按读失败处理并消费");
    await noticeAndConsume(deps, null, MSG_READ_FAILED);
    return "failed";
  }

  if (payload.kind === "error") {
    await noticeAndConsume(deps, payload, messageForShareCode(payload.code));
    return "failed";
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.readBytes(payload.file);
  } catch (e) {
    console.warn("[ai/share] 读图片字节失败：", e);
    await noticeAndConsume(deps, payload, MSG_READ_FAILED);
    return "failed";
  }

  const made = await deps.toAttachment(bytes);
  if (!made.ok) {
    await noticeAndConsume(deps, payload, made.message);
    return "failed";
  }

  deps.setAttachedImage(made.image);
  // 成功路径**一律写**：多图给"只取第一张"，单图给空串（= 清掉上一次的多图/失败提示）。
  // 只写"多图"那一支的话，上一次的「已用第一张」会跨过一次干净的单图分享继续挂在输入框上方。
  deps.setNotice(payload.count > 1 ? MSG_MULTIPLE_TAKEN : "");
  await consume(deps, payload);
  pushAiQuietly(deps);
  return "attached";
}

/**
 * 失败路径的唯一出口：出文案 + 消费 + 进 AI 页。
 *
 * ⚠️ 漏掉消费 = 每次回前台重复弹一次；漏掉 `pushAi` = **用户站在原页面什么都看不到**
 * （他的意图就是"送到 AI 聊天窗"，失败的那句话必须让他看见）。`pushAi` 内部会判"已在 /ai
 * 就不推"，所以成功/失败两条路都调它不会堆历史栈。
 */
async function noticeAndConsume(
  deps: ShareIntakeDeps,
  payload: PendingPayload | null,
  message: string,
): Promise<void> {
  deps.setNotice(message);
  await consume(deps, payload);
  pushAiQuietly(deps);
}

/** 进 AI 页：路由失败不回滚附件（设计 §9 第 11 条）—— 图已经在 store 里，用户进 AI 页照样看得到 */
function pushAiQuietly(deps: ShareIntakeDeps): void {
  try {
    deps.pushAi();
  } catch (e) {
    console.warn("[ai/share] 进 AI 页失败：", e);
  }
}

async function consume(deps: ShareIntakeDeps, payload: PendingPayload | null): Promise<void> {
  try {
    await deps.consume(payload);
  } catch (e) {
    // 删除失败不重试、不阻塞：原文已在 `consumedRaw` 里，本进程内不会再处理它
    console.warn("[ai/share] 消费 inbox 失败：", e);
  }
}
