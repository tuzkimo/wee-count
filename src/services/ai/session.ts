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

/**
 * 最近 n 轮的 user/assistant 文本（不带 tool 结果），供 prompt 使用。
 * 「一轮」= user 一条 + assistant 一条，所以取最近 `n * 2` 条再翻成正序。
 * DB 未就绪或查询失败时返回 []（不抛）；软删会话同样读不到（见 `loadMessages`）。
 */
export async function recentTurns(conversationId: string, n = 3): Promise<AiTurn[]> {
  const db = getUserDb();
  if (!db) return [];

  try {
    const rows = await db.select<AiTurn[]>(
      `SELECT role, content FROM ai_messages
       WHERE conversation_id = ? AND ${CONV_NOT_DELETED}
       ORDER BY rowid DESC LIMIT ?`,
      [conversationId, n * 2]
    );
    // 显式只映射 role/content：把整行透传会把 payload（含 refs 真值）带进上下文
    return rows.map((r) => ({ role: r.role, content: r.content })).reverse();
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
