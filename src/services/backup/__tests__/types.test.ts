// src/services/backup/__tests__/types.test.ts
import { describe, it, expect } from "vitest";
import { parseEnvelope, BACKUP_FORMAT, BACKUP_TABLES, BackupError } from "../types";

const validEnvelope = {
  format: BACKUP_FORMAT,
  version: 1,
  app_version: "0.11.0",
  exported_at: "2026-09-10T12:00:00.000Z",
  kdf: { algo: "PBKDF2-SHA256", iterations: 600000, salt: "c2FsdA==" },
  cipher: "AES-256-GCM",
  iv: "aXZpdml2",
  data: "ZGF0YQ==",
};

describe("parseEnvelope", () => {
  it("合法 envelope 原样返回", () => {
    expect(parseEnvelope(JSON.stringify(validEnvelope))).toEqual(validEnvelope);
  });

  it("JSON 损坏 → invalid", () => {
    expect(() => parseEnvelope("not json")).toThrowError(BackupError);
    try {
      parseEnvelope("not json");
    } catch (e) {
      expect((e as BackupError).code).toBe("invalid");
    }
  });

  it("format 不符 → invalid", () => {
    const bad = { ...validEnvelope, format: "other" };
    expect(() => parseEnvelope(JSON.stringify(bad))).toThrowError(BackupError);
  });

  it("缺少字段 → invalid", () => {
    const { data, ...noData } = validEnvelope;
    expect(() => parseEnvelope(JSON.stringify(noData))).toThrowError(BackupError);
  });

  it("version 更高 → version 错误", () => {
    const bad = { ...validEnvelope, version: 2 };
    try {
      parseEnvelope(JSON.stringify(bad));
      expect.unreachable();
    } catch (e) {
      expect((e as BackupError).code).toBe("version");
    }
  });

  it("version 非法（0）→ invalid", () => {
    const bad = { ...validEnvelope, version: 0 };
    try {
      parseEnvelope(JSON.stringify(bad));
      expect.unreachable();
    } catch (e) {
      expect((e as BackupError).code).toBe("invalid");
    }
  });
});

describe("BACKUP_TABLES", () => {
  it("9 张表且顺序满足外键依赖（被引用表在前）", () => {
    expect(BACKUP_TABLES).toEqual([
      "ledgers", "accounts", "categories", "tags", "transactions",
      "transaction_tags", "team_members", "member_aliases", "app_kv",
    ]);
  });
});
