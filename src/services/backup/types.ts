// src/services/backup/types.ts

/** 备份文件信封格式标识 */
export const BACKUP_FORMAT = "weecount-backup";
/** 信封结构版本（加密方式与外壳字段） */
export const ENVELOPE_VERSION = 1;
/** 备份内数据结构版本（表结构随 app 迁移演进） */
export const PAYLOAD_SCHEMA_VERSION = 1;

/** 备份覆盖的 9 张表，顺序即恢复时的写入顺序（被引用表在前，满足外键依赖） */
export const BACKUP_TABLES = [
  "ledgers", "accounts", "categories", "tags", "transactions",
  "transaction_tags", "team_members", "member_aliases", "app_kv",
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];

export type BackupRows = { [K in BackupTable]: Record<string, unknown>[] };

export interface BackupAccount {
  /** 数据行内出现的账户 id：纯本地=本地行 id；在线=server_user_id（绑定迁移后数据行内已是该值） */
  id: string;
  username: string | null;
  nickname: string;
  avatar_url: string | null;
  /** bcrypt 哈希，随备份带走：恢复出的账户用原账户密码登录 */
  password_hash: string;
}

export interface BackupPayload {
  schema_version: number;
  account: BackupAccount;
  tables: BackupRows;
}

export interface BackupEnvelope {
  format: string;
  version: number;
  app_version: string;
  exported_at: string;
  kdf: { algo: string; iterations: number; salt: string };
  cipher: string;
  iv: string;
  data: string;
}

export type BackupErrorCode = "invalid" | "version" | "decrypt" | "schema" | "restore";

export class BackupError extends Error {
  constructor(
    public code: BackupErrorCode,
    message: string
  ) {
    super(message);
    this.name = "BackupError";
  }
}

function isEnvelope(o: unknown): o is BackupEnvelope {
  if (typeof o !== "object" || o === null) return false;
  const e = o as Record<string, unknown>;
  const kdf = e.kdf as Record<string, unknown> | undefined;
  return (
    e.format === BACKUP_FORMAT &&
    typeof e.version === "number" &&
    typeof e.app_version === "string" &&
    typeof e.exported_at === "string" &&
    typeof kdf?.algo === "string" &&
    typeof kdf.iterations === "number" &&
    typeof kdf.salt === "string" &&
    typeof e.cipher === "string" &&
    typeof e.iv === "string" &&
    typeof e.data === "string"
  );
}

/** 解析并校验 envelope 外壳（不解密）。version 高于当前 → 'version'，结构损坏 → 'invalid' */
export function parseEnvelope(raw: string): BackupEnvelope {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new BackupError("invalid", "不是有效的备份文件");
  }
  if (!isEnvelope(obj)) throw new BackupError("invalid", "不是有效的备份文件");
  if (obj.version > ENVELOPE_VERSION)
    throw new BackupError("version", "备份文件版本较新，请先升级 app");
  if (obj.version !== ENVELOPE_VERSION)
    throw new BackupError("invalid", "不是有效的备份文件");
  return obj;
}
