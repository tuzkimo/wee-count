// src/services/backup/__tests__/exporter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildBackupFileName, collectPayload, buildEnvelopeJson } from "../exporter";
import { parseEnvelope } from "../types";
import { decryptJson } from "../crypto";
import type { BackupAccount } from "../types";
import { stubWebCrypto } from "./webcrypto";

const account: BackupAccount = {
  id: "user-1",
  username: "tuzki",
  nickname: "Tuzki",
  avatar_url: "data:image/png;base64,xxx",
  password_hash: "$2a$10$hash",
};

/** 按 SQL 里的表名路由到各自的假行 */
function fakeDb(rowsByTable: Record<string, Record<string, unknown>[]>) {
  return {
    select: vi.fn(async (sql: string) => {
      const table = sql.replace("SELECT * FROM ", "").trim();
      return rowsByTable[table] ?? [];
    }),
  };
}

beforeEach(() => stubWebCrypto());
afterEach(() => vi.unstubAllGlobals());

describe("buildBackupFileName", () => {
  it("格式为 weecount-backup-YYYYMMDD-HHmmss.weecount", () => {
    const name = buildBackupFileName(new Date(2026, 8, 10, 7, 5, 3));
    expect(name).toBe("weecount-backup-20260910-070503.weecount");
  });
});

describe("collectPayload", () => {
  it("读取全部 9 张表并带上账户信息", async () => {
    const db = fakeDb({
      ledgers: [{ id: "l1", name: "Tuzki的账本", type: "personal", owner_id: "user-1", team_id: null, created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00", is_deleted: 0 }],
      transactions: [{ id: "t1", ledger_id: "l1", user_id: "user-1", amount: 10, type: "expense", from_account_id: null, to_account_id: null, category_id: null, note: null, occurred_at: "2026-01-02 08:00:00", created_at: "2026-01-02 08:00:00", updated_at: "2026-01-02 08:00:00", is_deleted: 1 }],
    });
    const payload = await collectPayload(db as never, account);

    expect(db.select).toHaveBeenCalledTimes(9);
    expect(payload.schema_version).toBe(1);
    expect(payload.account).toEqual(account);
    expect(payload.tables.ledgers).toHaveLength(1);
    expect(payload.tables.transactions[0].is_deleted).toBe(1); // 软删行保留
    expect(payload.tables.app_kv).toEqual([]); // 无行的表为空数组
  });
});

describe("buildEnvelopeJson", () => {
  it("产出的 JSON 可经 parseEnvelope + decryptJson 还原 payload", async () => {
    const payload = await collectPayload(fakeDb({}) as never, account);
    const json = await buildEnvelopeJson(payload, "password123", "0.11.0");

    const envelope = parseEnvelope(json);
    expect(envelope.app_version).toBe("0.11.0");
    expect(envelope.kdf.iterations).toBe(600_000);
    expect(envelope.cipher).toBe("AES-256-GCM");
    // decryptJson 需要 { salt, iv, data }；envelope 顶层无 salt，salt 在 kdf.salt
    await expect(
      decryptJson(
        { salt: envelope.kdf.salt, iv: envelope.iv, data: envelope.data },
        "password123"
      )
    ).resolves.toEqual(payload);
  });
});
