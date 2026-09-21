// src/services/ai/session.ts
// AI 会话两张表的读写（规格 §4.5）。两张表**不参与同步、不进备份**，
// 只在本机 userDb 里存会话历史。
//
// 三条硬约束（都会踩）：
//  1. `getUserDb()` 可能返回 null —— 它只在冷启动/登录（`openUserDb`）与恢复备份
//     （`openRestoreUserDb`）里被初始化（Ruling 13）。本模块每个函数都必须就地降级。
//  2. `ai_conversations.ledger_id` 是 UNIQUE ⇒ 会话必须与当前账本绑定，切账本即切会话；
//     并发下第二条 INSERT 会撞 UNIQUE（Ruling 14），`db.execute` 的异常绝不能冒到编排循环。
//  3. `content` 存占位符原文（`{{q1.total}}`），真值在 `payload.refs` 里，渲染时才回填（§4.5）。
//  4. `is_deleted` 只长在会话行上（消息表没有该列）：读路径按**所属会话**的 `is_deleted = 0` 过滤；
//     `clearConversation` 硬删消息行 + 软删会话行；`ensureConversation` 复活软删行而不是插第二行（Ruling 7）。
import { getUserDb } from "@/db/userDb";
import type { ImageAttachment } from "@/services/ai/imageInput";

const WARN = "[ai/session]";

export interface AiConversationRow {
  id: string
  ledger_id: string
  title: string | null
  created_at: string
  updated_at: string
  is_deleted: number
}

export interface AiMessageRow {
  id: string
  conversation_id: string
  role: "user" | "assistant"
  content: string
  payload: string | null
  created_at: string
}

/** `ai_messages.payload` 的 JSON 形状。`revealed` 不落库（§7.4 乙方案，内存 Set）。 */
export interface AiMessagePayload {
  chips?: unknown[]
  drafts?: unknown[]
  refs?: Record<string, string>
  trace?: unknown[]
  /**
   * 这条 user 消息带的**截图**（M4 §4.1）。只进 payload、**绝不进 `content`**（content 是纯文本）。
   *
   * 它有两个消费者，都在本文件/编排层，且都**只读**：
   *  1. 页面渲染（历史里那条消息仍要显示缩略图 —— §4.3 明写替换"不影响页面渲染"）；
   *  2. `buildContext` 判"这条历史消息要不要换成占位文本"（§4.3）。
   * ⇒ 发给模型的上下文里**永远没有** dataUrl，只有占位文本（省 token + 缩小隐私面）。
   */
  image?: ImageAttachment
  /**
   * 产生这条 assistant 消息时用的提示词版本（`prompt.PROMPT_VERSION`，§7.1:449 的"随消息落库"）。
   *
   * 可缺省是为了**老消息**：库里已经存在的 payload 里没有这个键 ⇒ 读回来是 `undefined`，渲染与
   * 草稿解析都不看它，不崩、也不丢东西（没有"补写老消息"这种迁移 —— 那要动 schema/数据）。
   * ⚠️ 别和 prompt **文本**里的 `prompt_version=`（`prompt.ts:73`）混为一谈：那行是发给模型的文本，
   * 这里是**落库的元数据**；两者同源（同一个常量）但用途不同，谁都不能替代谁。
   */
  promptVersion?: number
}

/** 发给模型的上下文里的一条消息：**只有文本**，不带历史 tool 结果（§4.5） */
export interface AiTurn {
  role: "user" | "assistant"
  content: string
}

/** `ai_conversations` 的读路径过滤条件：消息表自己没有 `is_deleted` ⇒ 只能由所属会话行决定（Ruling 7）。 */
const CONV_NOT_DELETED = `EXISTS (SELECT 1 FROM ai_conversations c
         WHERE c.id = ai_messages.conversation_id AND c.is_deleted = 0)`;

type UserDb = NonNullable<ReturnType<typeof getUserDb>>;

/** 软删的会话行要**原地复活**：`ledger_id` UNIQUE 决定了不能插第二行（Ruling 7）。 */
async function reviveIfDeleted(
  db: UserDb,
  row: { id: string; is_deleted: number | null },
  now: Date
): Promise<string> {
  if (row.is_deleted) {
    await db.execute(
      "UPDATE ai_conversations SET is_deleted = 0, updated_at = ? WHERE id = ?",
      [now.toISOString(), row.id]
    );
  }
  return row.id;
}

/** 取当前账本的会话 id；没有就建一条。DB 未就绪时返回 null（调用方降级，不抛）。 */
export async function ensureConversation(ledgerId: string, now: Date): Promise<string | null> {
  const db = getUserDb();
  if (!db) return null;

  try {
    const existing = await db.select<{ id: string; is_deleted: number | null }[]>(
      "SELECT id, is_deleted FROM ai_conversations WHERE ledger_id = ? LIMIT 1",
      [ledgerId]
    );
    // 软删过的会话（用户清空过）在这里复活，绝不能再 INSERT 一条（`ledger_id` UNIQUE 会当场抛）
    if (existing.length > 0) return await reviveIfDeleted(db, existing[0]!, now);

    const id = crypto.randomUUID();
    const ts = now.toISOString(); // UTC ISO，与 transactions 同口径（不要用 datetime('now')）
    try {
      await db.execute(
        `INSERT INTO ai_conversations (id, ledger_id, title, created_at, updated_at, is_deleted)
         VALUES (?, ?, NULL, ?, ?, 0)`,
        [id, ledgerId, ts, ts]
      );
      return id;
    } catch (e) {
      // 并发下 ledger_id UNIQUE 冲突（Ruling 14）：别人刚建好了 → 回查复用，绝不抛。
      // 走到这里的赢家那条一定是**刚插进去的新行**（is_deleted = 0 由上面的 INSERT 写死），不需要复活。
      const again = await db.select<{ id: string }[]>(
        "SELECT id FROM ai_conversations WHERE ledger_id = ? LIMIT 1",
        [ledgerId]
      );
      if (again.length > 0) return again[0]!.id;
      console.warn(`${WARN} ensureConversation insert failed:`, e);
      return null;
    }
  } catch (e) {
    console.warn(`${WARN} ensureConversation failed:`, e);
    return null;
  }
}

/** 追加一条消息；DB 未就绪或约束冲突时返回 false 并 console.warn（绝不抛给编排循环）。 */
export async function appendMessage(
  row: Omit<AiMessageRow, "payload"> & { payload?: AiMessagePayload }
): Promise<boolean> {
  const db = getUserDb();
  if (!db) return false;

  try {
    await db.execute(
      `INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.conversation_id, row.role, row.content,
        // `JSON.stringify(undefined)` 返回 undefined（不是字符串），真库会拒绝绑定 → 必须显式写 null
        row.payload ? JSON.stringify(row.payload) : null,
        row.created_at,
      ]
    );
    return true;
  } catch (e) {
    console.warn(`${WARN} appendMessage failed:`, e);
    return false;
  }
}

/**
 * 全量消息（时间正序）。DB 未就绪或查询失败时返回 []（不抛）。
 * 会话被软删（`clearConversation` 过的）时读不到任何消息 —— `ai_messages` 自己没有 `is_deleted`，
 * 只能由所属会话行决定（Ruling 7）。
 */
export async function loadMessages(conversationId: string): Promise<AiMessageRow[]> {
  const db = getUserDb();
  if (!db) return [];

  try {
    return await db.select<AiMessageRow[]>(
      `SELECT id, conversation_id, role, content, payload, created_at
       FROM ai_messages
       WHERE conversation_id = ? AND ${CONV_NOT_DELETED}
       ORDER BY rowid ASC`,
      [conversationId]
    );
  } catch (e) {
    console.warn(`${WARN} loadMessages failed:`, e);
    return [];
  }
}

/** `buildContext` 的入参：一行历史消息（`payload` 是**库里那份 JSON 文本**，可能为 null）。 */
export interface ContextRow {
  role: "user" | "assistant"
  content: string
  payload: string | null
}

/**
 * 带图历史消息在上下文里的占位文本（§4.3 逐字）。
 * ⚠️ 与 §8 的失败文案无关：这是**发给模型**的，用户永远看不到（页面仍显示缩略图）。
 */
export const IMAGE_PLACEHOLDER = "[用户发过一张截图]"

/**
 * 一条带图 user 消息在**上下文里**会呈现成的文本（§4.3 的替换规则，**唯一定义**）。
 *
 *  - 有文字 ⇒ `[用户发过一张截图] <原文字>`（原文字保留：模型要靠它理解"帮我记餐饮"）
 *  - 没文字 ⇒ `[用户发过一张截图]`（**不带尾随空格** —— 尾随空格会让 prompt 里出现不可见差异）
 *
 * 🔒 为什么要单独导出：`agent.ts` 的**去重**（`withoutTrailingDuplicate`）必须拿"历史里那个
 * 样子"当比较对象，而不是本轮 `userText` 原文 —— 带图轮的历史已经被本函数替换过，拿原文比
 * 永远为假 ⇒ 去重静默失效（连点两次发送会把同一轮发两遍）。两处若各写一份，就是下一个漂移点。
 */
export function imagePlaceholderText(content: string): string {
  return content === "" ? IMAGE_PLACEHOLDER : `${IMAGE_PLACEHOLDER} ${content}`
}

/** 这一行的 payload 里有没有落图的 `image`（§4.1）。坏 payload / `image: null` ⇒ 当作没有（不抛）。 */
function hasImage(payloadJson: string | null): boolean {
  if (payloadJson === null) return false
  try {
    const parsed: unknown = JSON.parse(payloadJson)
    if (typeof parsed !== "object" || parsed === null) return false
    const image = (parsed as { image?: unknown }).image
    // 只认"真有一份图"：`image: null` / 缺键都不算（老消息与坏写入都走这一条）
    return typeof image === "object" && image !== null
  } catch {
    // 坏 JSON 不能连累整段历史：当作"没有图"（与 store 的 `parsePayload` 同一条纪律：坏行不致命）
    return false
  }
}

/**
 * 历史行 → **发给模型**的上下文（§4.3 的替换在这里，也是它唯一的落点）。
 *
 * 带 `image` 的历史 **user** 消息替换成占位文本：
 *  - 有文字 ⇒ `[用户发过一张截图] <原文字>`（原文字保留：模型要靠它理解"帮我记餐饮"）
 *  - 没文字 ⇒ `[用户发过一张截图]`（**不带尾随空格** —— 尾随空格会让 prompt 里出现不可见差异）
 *
 * ⚠️ 三条边界，缺一条就有真实代价：
 *  1. **只影响发出去这一份**：入参对象一个字段都不改（`map` 出新对象）—— §4.3 明写替换
 *     "不影响本地存储与页面渲染"（页面仍要显示缩略图，历史条目的真值仍在 payload 里）。
 *  2. **assistant 消息永不替换**：占位文本说的是"用户发过"，挂在回答上就是撒谎。
 *  3. 判据是 payload 里的 `image` 对象，**不是** content 里有没有字 —— 无文字的那条
 *     content 是空串，靠 content 判会漏掉它（那条恰恰最需要占位，否则模型看到一条空气泡）。
 */
export function buildContext(rows: ContextRow[]): AiTurn[] {
  return rows.map((r) => {
    if (r.role !== "user" || !hasImage(r.payload)) return { role: r.role, content: r.content }
    return {
      role: r.role,
      content: imagePlaceholderText(r.content),
    }
  })
}

/**
 * 最近 n 轮的 user/assistant 文本（不带 tool 结果），供 prompt 使用。
 * 「一轮」= user 一条 + assistant 一条，所以取最近 `n * 2` 条再翻成正序。
 * DB 未就绪或查询失败时返回 []（不抛）；软删会话同样读不到（见 `loadMessages`）。
 *
 * ⚠️ M4 起 SQL **必须**把 `payload` 一起选出来：判"这条 user 消息带没带图"（§4.3）只能看它。
 * 但 payload 只被 `buildContext` 用来判一个布尔 —— 返回的每个 turn 仍然只有 `role`/`content`
 * 两个键，refs 的真值 / drafts / trace **一律不进上下文**（§4.5 的有界上下文）。
 */
export async function recentTurns(conversationId: string, n = 3): Promise<AiTurn[]> {
  const db = getUserDb();
  if (!db) return [];

  try {
    const rows = await db.select<ContextRow[]>(
      `SELECT role, content, payload FROM ai_messages
       WHERE conversation_id = ? AND ${CONV_NOT_DELETED}
       ORDER BY rowid DESC LIMIT ?`,
      [conversationId, n * 2]
    );
    return buildContext(rows).reverse();
  } catch (e) {
    console.warn(`${WARN} recentTurns failed:`, e);
    return [];
  }
}

/**
 * 清空当前账本的会话：**硬删消息行 + 软删会话行**（Ruling 7）。
 * 消息行必须真删 —— 会话行会被 `ensureConversation` 复活（`is_deleted = 0`），
 * 只标记会话的话旧消息会跟着一起复活。会话行保留 id，保证 `ledger_id` UNIQUE 下不插第二行。
 */
export async function clearConversation(ledgerId: string, now: Date): Promise<void> {
  const db = getUserDb();
  if (!db) return;

  try {
    const rows = await db.select<{ id: string }[]>(
      "SELECT id FROM ai_conversations WHERE ledger_id = ? LIMIT 1",
      [ledgerId]
    );
    if (rows.length === 0) return;
    await db.execute("DELETE FROM ai_messages WHERE conversation_id = ?", [rows[0]!.id]);
    await db.execute(
      "UPDATE ai_conversations SET title = NULL, is_deleted = 1, updated_at = ? WHERE id = ?",
      [now.toISOString(), rows[0]!.id]
    );
  } catch (e) {
    console.warn(`${WARN} clearConversation failed:`, e);
  }
}

/**
 * 把 `title` 填成 `text` 的前 20 字（规格 §4.5），**不覆盖已有标题**。
 * 只在会话新建后写入第一条 user 消息时调用 —— 接进编排循环是任务 5 的事。
 */
export async function setTitleIfEmpty(convId: string, text: string): Promise<void> {
  const db = getUserDb();
  if (!db) return;

  try {
    // 判空写在 SQL 里（而不是先 SELECT 再判断）：一条 UPDATE 完成"判空 + 写"，没有读改写竞态。
    // `title = ''` 也要算空：空串是"没标题"的另一种落库形态。
    await db.execute(
      "UPDATE ai_conversations SET title = ? WHERE id = ? AND (title IS NULL OR title = '')",
      [text.slice(0, 20), convId]
    );
  } catch (e) {
    console.warn(`${WARN} setTitleIfEmpty failed:`, e);
  }
}
