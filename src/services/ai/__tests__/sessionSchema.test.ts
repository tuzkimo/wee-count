import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initUserTables } from "@/db/userDb";

/**
 * 表结构的**唯一权威是生产代码里那份 DDL**，所以这里不抄 DDL、也不 mock：
 * 直接 import 真实的 `initUserTables`，把它接到一个真 `node:sqlite`（`DatabaseSync`）库上，
 * 再用 `PRAGMA table_info` 逐列核对。
 *
 * 为什么不能用 mock 代替：`sqlSmoke.test.ts` 自己抄了一份 SCHEMA（那是它的夹具，不是被测物），
 * 而本文件要验的恰恰是"生产 DDL 里有什么" —— 手抄一份的后果是"实现里漏了列、测试里那份没漏"，
 * 两边永远不会同时红。侦察结论（约束 15）指的就是这个盲区。
 *
 * 依赖环境下限：**Node >= 22.13.0**（`node:sqlite` 不再需要 --experimental-sqlite）。
 * 本机 Node 24.19.0。若将来环境回落，本文件会在 import 阶段红 —— 那正是想要的信号，
 * 不做"拿不到就跳过"的兜底（会静默跳过的验收测试不算验收测试）。
 */

/** 把真库包成 `@tauri-apps/plugin-sql` 的 `Database` 形状（initUserTables 只用 execute/select） */
function asTauriDb(sqlite: DatabaseSync) {
  return {
    execute: async (sql: string, params: unknown[] = []): Promise<unknown> =>
      sqlite.prepare(sql).run(...(params as never[])),
    select: async <T,>(sql: string, params: unknown[] = []): Promise<T> =>
      sqlite.prepare(sql).all(...(params as never[])) as unknown as T,
  };
}

/** 空库 + 跑一遍真实 initUserTables（默认跑一次，幂等用例会再跑一次） */
async function freshDb(times = 1): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  for (let i = 0; i < times; i++) {
    await initUserTables(asTauriDb(sqlite) as never);
  }
  return sqlite;
}

function tableNames(sqlite: DatabaseSync): string[] {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ai_%' ORDER BY name")
    .all()
    .map((r) => String(r.name));
}

function cols(sqlite: DatabaseSync, table: string): string[] {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().map((r) => String(r.name));
}

/** 列名 → { notnull, dflt }；用来核对单列的约束而不是只看列名 */
function colMeta(sqlite: DatabaseSync, table: string, col: string) {
  const row = sqlite.prepare(`PRAGMA table_info(${table})`).all()
    .find((r) => String(r.name) === col);
  return row ? { notnull: Number(row.notnull), dflt: row.dflt_value } : null;
}

describe("initUserTables 建出的 AI 会话两张表（真 node:sqlite）", () => {
  it("建出 ai_conversations 与 ai_messages 两张表", async () => {
    const sqlite = await freshDb();
    // 这一条是"表根本没建"的唯一判据：PRAGMA table_info(不存在的表) 返回空数组而不是抛错，
    // 只靠下面的列断言，红会是 `[] !== [列清单]`，看不出是"没建表"还是"建了个空列的表"。
    expect(tableNames(sqlite)).toEqual(["ai_conversations", "ai_messages"]);
    sqlite.close();
  });

  it("ai_conversations 的列与规格 §4.5 一致", async () => {
    const sqlite = await freshDb();
    expect(cols(sqlite, "ai_conversations")).toEqual(
      ["id", "ledger_id", "title", "created_at", "updated_at", "is_deleted"]);
    sqlite.close();
  });

  it("ai_messages 的列与规格 §4.5 一致", async () => {
    const sqlite = await freshDb();
    expect(cols(sqlite, "ai_messages")).toEqual(
      ["id", "conversation_id", "role", "content", "payload", "created_at"]);
    sqlite.close();
  });

  it("约束也在：ledger_id NOT NULL、is_deleted 默认 0、messages 声明了指向会话表的外键", async () => {
    const sqlite = await freshDb();
    // 杀掉"只抄列名、丢掉 NOT NULL/DEFAULT"的 DDL 变体：去掉 NOT NULL → notnull 变 0；
    // 去掉 `DEFAULT 0` → dflt_value 变 null（v1 读会话一律 `is_deleted = ?`，默认值丢了会写进 NULL 行）
    expect(colMeta(sqlite, "ai_conversations", "ledger_id")).toEqual({ notnull: 1, dflt: null });
    expect(colMeta(sqlite, "ai_conversations", "is_deleted")).toEqual({ notnull: 0, dflt: "0" });

    const fks = sqlite.prepare("PRAGMA foreign_key_list(ai_messages)").all()
      .map((r) => ({ table: String(r.table), from: String(r.from), to: String(r.to) }));
    // 删掉 `REFERENCES ai_conversations(id)` → fks 变 []，这条红
    expect(fks).toEqual([{ table: "ai_conversations", from: "conversation_id", to: "id" }]);
    sqlite.close();
  });

  it("幂等：连跑两次不抛，且列不变（IF NOT EXISTS 真的生效）", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const adapter = asTauriDb(sqlite) as never;
    await initUserTables(adapter);
    // 先确认这一跑确实建了表 —— 否则下面"两次列相同"在"表根本没建"时也成立（[] === []），本用例就是空转
    expect(tableNames(sqlite)).toEqual(["ai_conversations", "ai_messages"]);
    const first = { c: cols(sqlite, "ai_conversations"), m: cols(sqlite, "ai_messages") };
    // 去掉 IF NOT EXISTS → 第二次 `table ai_conversations already exists` 当场抛
    await expect(initUserTables(adapter)).resolves.toBeUndefined();
    expect({ c: cols(sqlite, "ai_conversations"), m: cols(sqlite, "ai_messages") }).toEqual(first);
    sqlite.close();
  });

  it("ledger_id 唯一：同一账本插两条会话必须抛（v1 每账本单会话）", async () => {
    const sqlite = await freshDb();
    const insert = (id: string) =>
      sqlite.prepare(
        `INSERT INTO ai_conversations (id, ledger_id, title, created_at, updated_at)
         VALUES (?, 'L1', NULL, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
      ).run(id);
    insert("c1");
    // 去掉 UNIQUE → 第二条静默插入成功，本断言红（Ruling 14 的根因就在这里）
    expect(() => insert("c2")).toThrow(/UNIQUE/i);
    // 反证：换一个账本必须插得进去（否则"抛"可能来自别的约束，本用例就是空转）
    expect(() =>
      sqlite.prepare(
        `INSERT INTO ai_conversations (id, ledger_id, title, created_at, updated_at)
         VALUES ('c3', 'L2', NULL, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`,
      ).run(),
    ).not.toThrow();
    sqlite.close();
  });
});
