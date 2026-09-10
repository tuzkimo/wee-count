// src/services/backup/exporter.ts
import type Database from "@tauri-apps/plugin-sql";
import {
  BACKUP_FORMAT,
  BACKUP_TABLES,
  ENVELOPE_VERSION,
  PAYLOAD_SCHEMA_VERSION,
  type BackupAccount,
  type BackupEnvelope,
  type BackupPayload,
  type BackupRows,
} from "./types";
import { PBKDF2_ITERATIONS, encryptJson } from "./crypto";

/** 读取单表全行（含 is_deleted=1 软删行），时间戳保持 SQLite 原生格式原样搬运 */
export async function collectPayload(
  db: Database,
  account: BackupAccount
): Promise<BackupPayload> {
  const tables = {} as BackupRows;
  for (const table of BACKUP_TABLES) {
    tables[table] = await db.select<Record<string, unknown>[]>(`SELECT * FROM ${table}`);
  }
  return { schema_version: PAYLOAD_SCHEMA_VERSION, account, tables };
}

/** weecount-backup-YYYYMMDD-HHmmss.weecount */
export function buildBackupFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `weecount-backup-${ts}.weecount`;
}

/** payload → 加密 → envelope JSON 字符串 */
export async function buildEnvelopeJson(
  payload: BackupPayload,
  password: string,
  appVersion: string
): Promise<string> {
  const { salt, iv, data } = await encryptJson(payload, password);
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    version: ENVELOPE_VERSION,
    app_version: appVersion,
    exported_at: new Date().toISOString(),
    kdf: { algo: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt },
    cipher: "AES-256-GCM",
    iv,
    data,
  };
  return JSON.stringify(envelope);
}
