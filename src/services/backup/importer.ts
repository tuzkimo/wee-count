// src/services/backup/importer.ts
import { remove } from "@tauri-apps/plugin-fs";
import { appConfigDir, join } from "@tauri-apps/api/path";
import { openRestoreUserDb } from "@/db/userDb";
import { createLocalUser, updateLocalUserProfile, getLocalUserByUsername, getMetaDb } from "@/db/meta";
import { decryptJson } from "./crypto";
import {
  BACKUP_TABLES,
  PAYLOAD_SCHEMA_VERSION,
  parseEnvelope,
  BackupError,
  type BackupPayload,
  type BackupTable,
} from "./types";

/** 引用账户 id 的列（改写目标）；不在表内的值一律原样保留 */
const TABLE_USER_ID_COLS: Partial<Record<BackupTable, string>> = {
  ledgers: "owner_id",
  accounts: "owner_id",
  categories: "owner_id",
  transactions: "user_id",
  team_members: "user_id",
  member_aliases: "target_user_id",
};

/** 单行 id 改写：仅当目标列等于备份账户原 id 时替换为新 id */
export function rewriteRow(
  table: BackupTable,
  row: Record<string, unknown>,
  oldId: string,
  newId: string
): Record<string, unknown> {
  const col = TABLE_USER_ID_COLS[table];
  if (!col || row[col] !== oldId) return row;
  return { ...row, [col]: newId };
}

/** 用户名冲突处理：追加递增数字（tuzki → tuzki2），直到不冲突 */
export async function resolveUsername(
  base: string,
  exists: (username: string) => Promise<boolean>
): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await exists(candidate)) {
    candidate = `${base}${n}`;
    n++;
  }
  return candidate;
}

function isPayload(o: unknown): o is BackupPayload {
  if (typeof o !== "object" || o === null) return false;
  const p = o as Partial<BackupPayload>;
  const tables = p.tables as Record<string, unknown> | undefined;
  return (
    typeof p.schema_version === "number" &&
    !!p.account &&
    typeof p.account.id === "string" &&
    typeof p.account.nickname === "string" &&
    typeof p.account.password_hash === "string" &&
    !!tables &&
    BACKUP_TABLES.every((t) => Array.isArray(tables[t]))
  );
}

/** 读文件内容 → 校验 envelope → 解密 → 校验 payload 结构 */
export async function readBackup(
  raw: string,
  password: string
): Promise<{ payload: BackupPayload; exportedAt: string }> {
  const envelope = parseEnvelope(raw);
  const payload = await decryptJson<unknown>({ salt: envelope.kdf.salt, iv: envelope.iv, data: envelope.data }, password);
  if (!isPayload(payload))
    throw new BackupError("schema", "备份内容结构异常，无法导入");
  if (payload.schema_version > PAYLOAD_SCHEMA_VERSION)
    throw new BackupError("schema", "备份来自更新版本，请先升级 app");
  if (payload.schema_version !== PAYLOAD_SCHEMA_VERSION)
    throw new BackupError("schema", "备份内容结构异常，无法导入");
  return { payload, exportedAt: envelope.exported_at };
}

function buildInsert(table: string, row: Record<string, unknown>): { sql: string; params: unknown[] } {
  // 列名来自解密后的 payload（不可信输入），必须引号包裹并转义内部双引号
  const cols = Object.keys(row);
  const quoted = cols.map((c) => `"${c.replace(/"/g, '""')}"`);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  return {
    sql: `INSERT INTO ${table} (${quoted.join(", ")}) VALUES (${placeholders})`,
    params: cols.map((c) => row[c]),
  };
}

/** 恢复失败清理：关连接 + 删除半成品库文件（主文件与 WAL 旁挂文件） */
async function cleanupRestoreFiles(userId: string, db: { close(): Promise<unknown> }): Promise<void> {
  try {
    await db.close();
  } catch {
    /* 连接可能已损坏，忽略 */
  }
  const dir = await appConfigDir();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await remove(await join(dir, `${userId}.db${suffix}`));
    } catch {
      /* 文件可能不存在 */
    }
  }
}

function toRestoreError(err: unknown): BackupError {
  const detail = err instanceof Error ? err.message : String(err);
  return new BackupError("restore", `恢复失败：${detail}`);
}

/**
 * 恢复编排：新库（独立连接）单事务写入 9 表 → meta 库插入 local_users 行。
 * 业务表按 BACKUP_TABLES 顺序写入（被引用表在前）；失败时回滚/清理，不留半成品。
 */
export async function restoreBackup(payload: BackupPayload, newUserId: string): Promise<void> {
  const db = await openRestoreUserDb(newUserId);

  try {
    await db.execute("BEGIN");
    for (const table of BACKUP_TABLES) {
      for (const raw of payload.tables[table]) {
        const row = rewriteRow(table, raw, payload.account.id, newUserId);
        const { sql, params } = buildInsert(table, row);
        await db.execute(sql, params);
      }
    }
    await db.execute("COMMIT");
  } catch (err) {
    try {
      await db.execute("ROLLBACK");
    } catch {
      /* 连接可能已损坏，忽略 */
    }
    await cleanupRestoreFiles(newUserId, db);
    throw toRestoreError(err);
  }

  try {
    // username 为空的历史备份回填 nickname（与 meta.ts 的回填规则一致）
    const baseUsername = payload.account.username ?? payload.account.nickname;
    const username = await resolveUsername(
      baseUsername,
      async (u) => (await getLocalUserByUsername(u)) !== null
    );

    await createLocalUser(newUserId, username, payload.account.nickname, payload.account.password_hash);
    if (payload.account.avatar_url) {
      await updateLocalUserProfile(newUserId, payload.account.nickname, payload.account.avatar_url);
    }
  } catch (err) {
    try {
      const meta = await getMetaDb();
      await meta.execute("DELETE FROM local_users WHERE id = $1", [newUserId]);
    } catch {
      /* 尽力清理 */
    }
    await cleanupRestoreFiles(newUserId, db);
    throw toRestoreError(err);
  }
}
