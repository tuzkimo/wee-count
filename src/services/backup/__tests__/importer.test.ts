// src/services/backup/__tests__/importer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rewriteRow, resolveUsername, readBackup, restoreBackup } from "../importer";
import { BACKUP_FORMAT, PAYLOAD_SCHEMA_VERSION, type BackupPayload } from "../types";
import { encryptJson } from "../crypto";
import { stubWebCrypto } from "./webcrypto";

// --- 纯函数 ---

describe("rewriteRow", () => {
  const oldId = "old-user";
  const newId = "new-user";

  it("等值列改写为新 id", () => {
    expect(rewriteRow("ledgers", { owner_id: "old-user", name: "x" }, oldId, newId))
      .toEqual({ owner_id: "new-user", name: "x" });
    expect(rewriteRow("member_aliases", { target_user_id: "old-user" }, oldId, newId))
      .toEqual({ target_user_id: "new-user" });
  });

  it("他人 id 与无关表原样保留", () => {
    expect(rewriteRow("ledgers", { owner_id: "someone-else" }, oldId, newId))
      .toEqual({ owner_id: "someone-else" });
    expect(rewriteRow("app_kv", { key: "k", value: "v" }, oldId, newId))
      .toEqual({ key: "k", value: "v" });
  });
});

describe("resolveUsername", () => {
  it("无冲突原样返回", async () => {
    await expect(resolveUsername("tuzki", async () => false)).resolves.toBe("tuzki");
  });
  it("冲突时追加递增数字", async () => {
    const taken = new Set(["tuzki", "tuzki2"]);
    const name = await resolveUsername("tuzki", async (u) => taken.has(u));
    expect(name).toBe("tuzki3");
  });
});

// --- readBackup ---

const account = {
  id: "old-user", username: "tuzki", nickname: "Tuzki",
  avatar_url: null, password_hash: "$2a$10$hash",
};
function makePayload(): BackupPayload {
  return {
    schema_version: PAYLOAD_SCHEMA_VERSION,
    account,
    tables: {
      ledgers: [], accounts: [], categories: [], tags: [], transactions: [],
      transaction_tags: [], team_members: [], member_aliases: [], app_kv: [],
    },
  };
}

beforeEach(() => stubWebCrypto());
afterEach(() => vi.unstubAllGlobals());

describe("readBackup", () => {
  it("合法文件解密出 payload 与导出时间", async () => {
    const payload = makePayload();
    const { salt, iv, data } = await encryptJson(payload, "password123");
    const raw = JSON.stringify({
      format: BACKUP_FORMAT, version: 1, app_version: "0.11.0",
      exported_at: "2026-09-10T12:00:00.000Z",
      kdf: { algo: "PBKDF2-SHA256", iterations: 600000, salt },
      cipher: "AES-256-GCM", iv, data,
    });

    const result = await readBackup(raw, "password123");
    expect(result.payload).toEqual(payload);
    expect(result.exportedAt).toBe("2026-09-10T12:00:00.000Z");
  });

  it("密码错误 → decrypt", async () => {
    const payload = makePayload();
    const { salt, iv, data } = await encryptJson(payload, "password123");
    const raw = JSON.stringify({
      format: BACKUP_FORMAT, version: 1, app_version: "0.11.0",
      exported_at: "2026-09-10T12:00:00.000Z",
      kdf: { algo: "PBKDF2-SHA256", iterations: 600000, salt },
      cipher: "AES-256-GCM", iv, data,
    });
    await expect(readBackup(raw, "wrong")).rejects.toMatchObject({ code: "decrypt" });
  });

  it("payload 结构异常（缺表）→ schema", async () => {
    const { salt, iv, data } = await encryptJson({ foo: 1 }, "password123");
    const raw = JSON.stringify({
      format: BACKUP_FORMAT, version: 1, app_version: "0.11.0",
      exported_at: "2026-09-10T12:00:00.000Z",
      kdf: { algo: "PBKDF2-SHA256", iterations: 600000, salt },
      cipher: "AES-256-GCM", iv, data,
    });
    await expect(readBackup(raw, "password123")).rejects.toMatchObject({ code: "schema" });
  });
});

// --- restoreBackup（编排）---

const restoreMocks = vi.hoisted(() => ({
  execute: vi.fn(),
  close: vi.fn(),
  createLocalUser: vi.fn(),
  updateLocalUserProfile: vi.fn(),
  getLocalUserByUsername: vi.fn(async (u: string) => (u === "taken" ? { id: "x" } : null)),
  remove: vi.fn(),
}));

vi.mock("@/db/userDb", () => ({
  openRestoreUserDb: vi.fn(async () => ({ execute: restoreMocks.execute, close: restoreMocks.close })),
}));
vi.mock("@/db/meta", () => ({
  getLocalUserByUsername: restoreMocks.getLocalUserByUsername,
  getMetaDb: vi.fn(async () => ({ execute: vi.fn() })),
  createLocalUser: restoreMocks.createLocalUser,
  updateLocalUserProfile: restoreMocks.updateLocalUserProfile,
}));
vi.mock("@tauri-apps/plugin-fs", () => ({ remove: restoreMocks.remove }));
vi.mock("@tauri-apps/api/path", () => ({
  appConfigDir: vi.fn(async () => "/cfg/"),
  join: vi.fn(async (a: string, b: string) => a + b),
}));

describe("restoreBackup", () => {
  let payload: BackupPayload;
  beforeEach(() => {
    vi.clearAllMocks();
    restoreMocks.execute.mockResolvedValue(undefined);
    payload = makePayload();
    payload.tables.ledgers = [
      { id: "l1", name: "Tuzki的账本", type: "personal", owner_id: "old-user", team_id: null, created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00", is_deleted: 0 },
    ];
  });

  it("BEGIN→逐表 INSERT（id 已改写）→COMMIT→meta 插入", async () => {
    await restoreBackup(payload, "new-user");

    const calls = restoreMocks.execute.mock.calls as Array<[string, unknown?]>;
    expect(calls[0][0]).toBe("BEGIN");
    expect(calls[calls.length - 1][0]).toBe("COMMIT");
    const insert = calls.find(([sql]) => sql.startsWith("INSERT INTO ledgers"));
    expect(insert![0]).toContain("owner_id");
    expect(insert![1]).toContain("new-user"); // owner_id 改写
    expect(restoreMocks.createLocalUser).toHaveBeenCalledWith(
      "new-user", "tuzki", "Tuzki", "$2a$10$hash"
    );
    expect(restoreMocks.remove).not.toHaveBeenCalled();
  });

  it("恶意/特殊列名 → 标识符引号包裹并转义内部双引号", async () => {
    // 列名来自解密 payload（不可信输入）：含双引号、SQL 关键字与注入形状的值
    payload.tables.app_kv = [
      { key: "k", 'we"ird': "v", order: 1, select: "* FROM users--" },
    ];
    await restoreBackup(payload, "new-user");

    const calls = restoreMocks.execute.mock.calls as Array<[string, unknown?]>;
    const insert = calls.find(([sql]) => sql.startsWith("INSERT INTO app_kv"));
    expect(insert![0]).toBe(
      'INSERT INTO app_kv ("key", "we""ird", "order", "select") VALUES ($1, $2, $3, $4)'
    );
    expect(insert![1]).toEqual(["k", "v", 1, "* FROM users--"]);
  });

  it("username 冲突时 meta 插入用后缀名", async () => {
    payload.account.username = "taken";
    await restoreBackup(payload, "new-user");
    expect(restoreMocks.createLocalUser).toHaveBeenCalledWith(
      "new-user", "taken2", "Tuzki", "$2a$10$hash"
    );
  });

  it("INSERT 失败 → ROLLBACK + 清理库文件 + restore 错误", async () => {
    restoreMocks.execute.mockImplementation(async (sql: string) => {
      if (sql.startsWith("INSERT")) throw new Error("constraint failed");
    });

    await expect(restoreBackup(payload, "new-user")).rejects.toMatchObject({
      name: "BackupError",
      code: "restore",
    });
    const sqls = restoreMocks.execute.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain("ROLLBACK");
    expect(restoreMocks.close).toHaveBeenCalled();
    expect(restoreMocks.remove).toHaveBeenCalledWith("/cfg/new-user.db");
    expect(restoreMocks.createLocalUser).not.toHaveBeenCalled();
  });

  it("meta 插入失败 → 删 meta 行 + 清理库文件", async () => {
    restoreMocks.createLocalUser.mockRejectedValue(new Error("meta fail"));

    await expect(restoreBackup(payload, "new-user")).rejects.toMatchObject({ code: "restore" });
    expect(restoreMocks.remove).toHaveBeenCalledWith("/cfg/new-user.db");
  });

  it("username 查询失败 → restore 错误 + 清理库文件，meta 未插入", async () => {
    restoreMocks.getLocalUserByUsername.mockRejectedValueOnce(new Error("meta query fail"));

    await expect(restoreBackup(payload, "new-user")).rejects.toMatchObject({ code: "restore" });
    expect(restoreMocks.remove).toHaveBeenCalledWith("/cfg/new-user.db");
    expect(restoreMocks.createLocalUser).not.toHaveBeenCalled();
  });
});
