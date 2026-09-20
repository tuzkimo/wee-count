import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

/**
 * session 层的两层覆盖：
 *  - 单元层：mock `getUserDb`，验"DB 未就绪/约束冲突时降级而不是抛"（Ruling 13/14）。
 *  - 真库层：把 `getUserDb()` 指向一个真 `node:sqlite` 适配器，用**真实的 initUserTables**
 *    建表后跑一遍。mock 只能证明"SQL 字符串长得对"，证明不了"这条 SQL 真能执行、
 *    列名真存在、LIMIT 真的生效" —— 本仓已经因此吃过两次亏（见 sqlSmoke.test.ts 顶部注释）。
 *
 * 注意 mock 工厂用的是 `importOriginal`：只替换 `getUserDb`，`initUserTables` 仍是生产代码那一份，
 * 所以真库层的表结构不会和实现漂移。
 */
const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/db/userDb", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/userDb")>();
  return { ...actual, getUserDb: () => state.db as never };
});

import { initUserTables } from "@/db/userDb";
import {
  ensureConversation, appendMessage, loadMessages, recentTurns, clearConversation,
  setTitleIfEmpty, type AiMessagePayload,
} from "@/services/ai/session";

const T0 = "2026-03-01T00:00:00.000Z";

/** 把真库包成 `@tauri-apps/plugin-sql` 的 `Database` 形状 */
// ⚠️ `execute` 的返回值照安装包产物：插件恒返回 `{ rowsAffected, lastInsertId }`
// （`node_modules/@tauri-apps/plugin-sql/dist-js/index.js:88-98`，2.4.0）—— 不是
// `node:sqlite` 的 `{ changes, lastInsertRowid }`（R86-2）。
function asTauriDb(sqlite: DatabaseSync) {
  return {
    execute: async (sql: string, params: unknown[] = []): Promise<unknown> => {
      const r = sqlite.prepare(sql).run(...(params as never[]));
      return { rowsAffected: r.changes, lastInsertId: Number(r.lastInsertRowid) };
    },
    select: async <T,>(sql: string, params: unknown[] = []): Promise<T> =>
      sqlite.prepare(sql).all(...(params as never[])) as unknown as T,
  };
}

async function realDb(): Promise<DatabaseSync> {
  const sqlite = new DatabaseSync(":memory:");
  await initUserTables(asTauriDb(sqlite) as never);
  return sqlite;
}

/** 一个只记调用的假 db；execute/select 的返回值按用例覆盖 */
function fakeDb(over: { execute?: ReturnType<typeof vi.fn>; select?: ReturnType<typeof vi.fn> } = {}) {
  return { execute: vi.fn().mockResolvedValue({ rowsAffected: 1 }), select: vi.fn().mockResolvedValue([]), ...over };
}

const msg = (over: Partial<Parameters<typeof appendMessage>[0]> = {}) => ({
  id: "m1", conversation_id: "c1", role: "user" as const, content: "这个月花了多少", created_at: T0, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.db = null;
});

describe("DB 未就绪（getUserDb() 返回 null，Ruling 13）", () => {
  it("六个函数都不抛、各自降级成 null / false / []，且一次 warn 都不打（null 是预期状态）", async () => {
    // DB 未就绪是**预期**降级路径（冷启动 / 未登录还没开库），不是异常 ⇒ 不该 warn。
    // 这条是本组守卫的**唯一**独立杀手：删掉任一函数第一行的 `if (!db) return …` 之后，
    // 余下的 try/catch 会吃掉随之而来的 TypeError、交出**同样的降级值**（所以返回值断言仍绿），
    // 但它会打一次 warn ⇒ 下面 `not.toHaveBeenCalled()` 变红。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensureConversation("L1", new Date())).resolves.toBeNull();
    await expect(appendMessage(msg())).resolves.toBe(false);
    await expect(loadMessages("c1")).resolves.toEqual([]);
    await expect(recentTurns("c1")).resolves.toEqual([]);
    await expect(clearConversation("L1", new Date())).resolves.toBeUndefined();
    await expect(setTitleIfEmpty("c1", "这个月花了多少")).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ensureConversation", () => {
  it("已有会话时只 SELECT、不 INSERT（第二次调用绝不能撞 ledger_id UNIQUE）", async () => {
    const db = fakeDb({ select: vi.fn().mockResolvedValue([{ id: "c-existing", is_deleted: 0 }]) });
    state.db = db;

    await expect(ensureConversation("L1", new Date(T0))).resolves.toBe("c-existing");
    expect(db.execute).not.toHaveBeenCalled();
    expect(String(db.select.mock.calls[0]![0])).toContain("FROM ai_conversations");
    expect(db.select.mock.calls[0]![1] as unknown[]).toEqual(["L1"]);
  });

  it("没有会话时插一条，时间戳用**传入的** now（UTC ISO）", async () => {
    const db = fakeDb();
    state.db = db;
    const now = new Date("2026-03-01T05:06:07.000Z");

    const id = await ensureConversation("L1", now);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const [sql, params] = db.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO ai_conversations");
    expect(params).toContain("L1");
    expect(params[0]).toBe(id);
    // 改用 `new Date().toISOString()` 而忽略注入的 now → 这两个时间戳就不是 05:06:07Z 了，本条红
    expect(params.filter((p) => p === now.toISOString())).toHaveLength(2);
    expect(params.some((p) => typeof p === "string" && p.includes("05:06:07.000Z"))).toBe(true);
  });

  it("并发下 INSERT 撞 UNIQUE 时回查已建好的会话，不抛、不建第二条", async () => {
    // Ruling 14 的真实触发点：ledger_id UNIQUE 冲突来自这里，而不是 appendMessage。
    const db = fakeDb({
      select: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "c-won" }]),
      execute: vi.fn().mockRejectedValue(new Error("UNIQUE constraint failed: ai_conversations.ledger_id")),
    });
    state.db = db;

    await expect(ensureConversation("L1", new Date(T0))).resolves.toBe("c-won");
    expect(db.execute).toHaveBeenCalledTimes(1); // 没有重试插入
  });
});

describe("appendMessage", () => {
  it("execute 抛异常时返回 false 且只 console.warn —— 绝不冒到编排循环", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 用这张表**真会抛**的错：ai_messages 只有 `id TEXT PRIMARY KEY`，重复 id 报的就是这条
    // （真库覆盖在下面的 `同一 id 重复入库` 用例）。`ledger_id UNIQUE` 属于 ai_conversations，appendMessage 打不到它。
    const db = fakeDb({ execute: vi.fn().mockRejectedValue(new Error("UNIQUE constraint failed: ai_messages.id")) });
    state.db = db;

    // 去掉 appendMessage 的 try/catch，这条会变成 rejects → 红
    await expect(appendMessage(msg())).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("payload 走 JSON.stringify，content 存占位符原文，created_at 用传入值", async () => {
    const db = fakeDb();
    state.db = db;
    const payload: AiMessagePayload = { chips: [{ field: "categories", value: "c-food" }], refs: { "q1.total": "128" } };

    await expect(appendMessage(msg({
      id: "m9", role: "assistant", content: "这个月花了 {{q1.total}} 元", payload,
    }))).resolves.toBe(true);

    const [sql, params] = db.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO ai_messages");
    // §4.5：content 存占位符原文、refs 存真值，渲染时才回填 —— 所以这里必须是 {{q1.total}}，不是 128
    expect(params).toEqual(["m9", "c1", "assistant", "这个月花了 {{q1.total}} 元", JSON.stringify(payload), T0]);
  });

  it("没有 payload 时写 null 而不是 undefined", async () => {
    const db = fakeDb();
    state.db = db;
    await appendMessage(msg());
    // `JSON.stringify(undefined)` 返回 undefined，直接当参数会在真库/Tauri 上抛（本文件真库层会红）
    expect((db.execute.mock.calls[0]![1] as unknown[])[4]).toBeNull();
  });
});

describe("loadMessages / recentTurns / clearConversation / setTitleIfEmpty 的读侧降级", () => {
  it("select/execute 真抛时才 warn：每次失败恰好一次，且不抛", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.db = fakeDb({
      select: vi.fn().mockRejectedValue(new Error("no such table: ai_messages")),
      execute: vi.fn().mockRejectedValue(new Error("no such table: ai_messages")),
    });

    // 与上一条（DB 为 null 不打 warn）配对：**真异常**才 warn，且每条失败恰好一次（不是零次、也不是刷屏）
    await expect(loadMessages("c1")).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(recentTurns("c1")).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    await expect(clearConversation("L1", new Date(T0))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    await expect(setTitleIfEmpty("c1", "问")).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});

describe("recentTurns：只带最近 3 轮 user/assistant 文本（§4.5）", () => {
  it("默认 3 轮 = 6 条、按时间正序返回、只含 role/content（不带 payload/工具结果）", async () => {
    // 按 SQL 的 DESC 顺序（最近的在最前）：第 5 轮 → 第 3 轮
    const desc = [
      { role: "assistant", content: "答4" }, { role: "user", content: "问4" },
      { role: "assistant", content: "答3" }, { role: "user", content: "问3" },
      { role: "assistant", content: "答2" }, { role: "user", content: "问2" },
    ];
    const db = fakeDb({ select: vi.fn().mockResolvedValue(desc) });
    state.db = db;

    const turns = await recentTurns("c1");

    const [sql, params] = db.select.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(["c1", 6]);              // 3 轮 × 2 条；把 n 写死/漏掉都红
    expect(sql).toContain("ORDER BY rowid DESC");   // 取"最近"而不是"最早"
    expect(sql).not.toContain("payload");           // 全量回放 tool 结果会让 token 膨胀（§4.5）
    expect(turns).toHaveLength(6);
    expect(Object.keys(turns[0]!)).toEqual(["role", "content"]);
    // 必须翻回正序：漏掉 reverse 的话 turns[0] 是"答4"
    expect(turns.map((t) => t.content)).toEqual(["问2", "答2", "问3", "答3", "问4", "答4"]);
  });

  it("n 可覆盖：recentTurns(id, 1) 只取 2 条", async () => {
    const db = fakeDb({
      select: vi.fn().mockResolvedValue([{ role: "assistant", content: "答4" }, { role: "user", content: "问4" }]),
    });
    state.db = db;

    const turns = await recentTurns("c1", 1);
    expect(db.select.mock.calls[0]![1] as unknown[]).toEqual(["c1", 2]);
    expect(turns.map((t) => t.content)).toEqual(["问4", "答4"]);
  });
});

describe("session.ts 接真实 node:sqlite（SQL 真的能执行）", () => {
  it("建会话 → 复用 → 追加 → 读回 → 最近 3 轮 → 清空，全程真跑", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const base = new Date("2026-03-01T00:00:00.000Z");
    const at = (min: number) => new Date(base.getTime() + min * 60_000).toISOString();

    const cid = await ensureConversation("L1", base);
    expect(cid).toBeTruthy();
    // 同一账本第二次调用必须复用（真库上真的撞 UNIQUE 才算数）
    expect(await ensureConversation("L1", base)).toBe(cid);

    // 5 轮 = 10 条；created_at 各不相同，顺序断言不受时间戳并列影响
    for (let i = 0; i < 5; i++) {
      const okU = await appendMessage({
        id: `u${i}`, conversation_id: cid!, role: "user", content: `问${i}`,
        payload: { refs: { [`q${i}.total`]: String(i) } }, created_at: at(i * 2),
      });
      const okA = await appendMessage({
        id: `a${i}`, conversation_id: cid!, role: "assistant", content: `答${i}`, created_at: at(i * 2 + 1),
      });
      expect([okU, okA]).toEqual([true, true]); // 没 payload 的那条也要真写进去（null 绑定不是 undefined）
    }

    const all = await loadMessages(cid!);
    expect(all.map((m) => m.id)).toEqual(["u0", "a0", "u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]);
    expect(all[0]!.payload).toBe(JSON.stringify({ refs: { "q0.total": "0" } }));
    expect(all[1]!.payload).toBeNull();

    // LIMIT 必须真生效：这里给的是 10 条，只有 SQL 里真带 n*2 才会是 6 条
    const turns = await recentTurns(cid!, 3);
    expect(turns).toEqual([
      { role: "user", content: "问2" }, { role: "assistant", content: "答2" },
      { role: "user", content: "问3" }, { role: "assistant", content: "答3" },
      { role: "user", content: "问4" }, { role: "assistant", content: "答4" },
    ]);

    await clearConversation("L1", new Date(base.getTime() + 30 * 60_000));
    expect(await loadMessages(cid!)).toEqual([]);
    // 清空后同一账本仍复用同一条会话行（软删行被 ensureConversation 复活，不是删会话再建 —— 否则 UNIQUE 之外的语义会漂）
    expect(await ensureConversation("L1", base)).toBe(cid);

    sqlite.close();
  });

  it("同一条消息 id 重复入库真的撞主键：返回 false，不是把异常抛出去", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const cid = await ensureConversation("L1", new Date(T0));

    const row = { id: "m1", conversation_id: cid!, role: "user" as const, content: "hi", created_at: T0 };
    await expect(appendMessage(row)).resolves.toBe(true);
    await expect(appendMessage(row)).resolves.toBe(false); // PRIMARY KEY 冲突
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    sqlite.close();
  });

  it("账本已有会话（别人/上次启动建的）时 ensureConversation 直接复用，不抛 UNIQUE", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    sqlite.prepare(
      `INSERT INTO ai_conversations (id, ledger_id, title, created_at, updated_at)
       VALUES ('preexisting', 'L1', '旧会话', ?, ?)`,
    ).run(T0, T0);

    await expect(ensureConversation("L1", new Date(T0))).resolves.toBe("preexisting");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_conversations").get()).toEqual({ n: 1 });

    sqlite.close();
  });
});

/** 手工造"软删会话 + 残留消息行"这种状态：正常代码路径已经删不出它，只能直接往真库里塞 */
function seedSoftDeletedConversation(sqlite: DatabaseSync, convId: string, msgId: string) {
  sqlite.prepare(
    `INSERT INTO ai_conversations (id, ledger_id, title, created_at, updated_at, is_deleted)
     VALUES (?, ?, NULL, ?, ?, 1)`,
  ).run(convId, `L-${convId}`, T0, T0);
  sqlite.prepare(
    `INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at)
     VALUES (?, ?, 'user', '残留消息', NULL, ?)`,
  ).run(msgId, convId, T0);
}

function titleOf(sqlite: DatabaseSync, convId: string) {
  return sqlite.prepare("SELECT title FROM ai_conversations WHERE id = ?").get(convId);
}

describe("is_deleted 语义（Ruling 7 / 计划修正 7）", () => {
  it("软删会话的消息读不出来：loadMessages / recentTurns 都按所属会话 is_deleted = 0 过滤", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    seedSoftDeletedConversation(sqlite, "c-del", "m-del");
    // 正对照：同一条消息挂在**未删**会话上必须读得出来 —— 否则"读不出来"可能只是 SQL 写坏了（空转）
    sqlite.prepare(
      `INSERT INTO ai_conversations (id, ledger_id, title, created_at, updated_at, is_deleted)
       VALUES ('c-live', 'L-live', NULL, ?, ?, 0)`,
    ).run(T0, T0);
    sqlite.prepare(
      `INSERT INTO ai_messages (id, conversation_id, role, content, payload, created_at)
       VALUES ('m-live', 'c-live', 'user', '在册消息', NULL, ?)`,
    ).run(T0);

    // 去掉 loadMessages 里的 `is_deleted = 0` 过滤 → 本条红
    expect(await loadMessages("c-del")).toEqual([]);
    // 去掉 recentTurns 里的 → 本条红
    expect(await recentTurns("c-del")).toEqual([]);
    expect((await loadMessages("c-live")).map((m) => m.id)).toEqual(["m-live"]);
    expect((await recentTurns("c-live")).map((t) => t.content)).toEqual(["在册消息"]);

    sqlite.close();
  });

  it("clearConversation(ledgerId, now)：真删消息行 + 软删会话行（is_deleted = 1、updated_at = 注入的 now）", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const cid = await ensureConversation("L1", new Date(T0));
    await appendMessage({ id: "m1", conversation_id: cid!, role: "user", content: "问", created_at: T0 });
    const clearAt = new Date("2026-03-02T10:00:00.000Z");

    await clearConversation("L1", clearAt);

    // 消息行必须**真的没了**（直接查库、不经过读路径）：只把会话标删的实现会在这里红
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_messages WHERE conversation_id = ?").get(cid!)).toEqual({ n: 0 });
    // 会话行留着但已软删；updated_at 必须是**注入**的 now（改回 `new Date()` → 本条红）
    expect(sqlite.prepare("SELECT title, is_deleted, updated_at FROM ai_conversations WHERE id = ?").get(cid!))
      .toEqual({ title: null, is_deleted: 1, updated_at: clearAt.toISOString() });

    sqlite.close();
  });

  it("杀手：清空后即使会话被复活，旧消息也**不得复活**（逼出「真删消息行」）", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const base = new Date(T0);
    const cid = await ensureConversation("L1", base);
    await appendMessage({ id: "m1", conversation_id: cid!, role: "user", content: "旧问", created_at: T0 });
    await appendMessage({ id: "m2", conversation_id: cid!, role: "assistant", content: "旧答", created_at: T0 });

    await clearConversation("L1", new Date("2026-03-02T10:00:00.000Z"));
    expect(await loadMessages(cid!)).toEqual([]);

    const reviveAt = new Date("2026-03-03T08:00:00.000Z");
    // 复活同一条会话行：ledger_id UNIQUE 决定了不能插第二行
    expect(await ensureConversation("L1", reviveAt)).toBe(cid);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ai_conversations").get()).toEqual({ n: 1 });
    // 去掉复活（只回查 id）→ is_deleted 仍是 1，本条红
    expect(sqlite.prepare("SELECT is_deleted, updated_at FROM ai_conversations WHERE id = ?").get(cid!))
      .toEqual({ is_deleted: 0, updated_at: reviveAt.toISOString() });

    // 会话已复活（读路径不再被 is_deleted 挡住）⇒ 旧消息还读得到就只能说明"没真删"。
    // 只软删会话、不删消息的实现在这两条上红。
    expect(await loadMessages(cid!)).toEqual([]);
    expect(await recentTurns(cid!)).toEqual([]);

    sqlite.close();
  });
});

describe("setTitleIfEmpty（规格 §4.5：标题取首条用户消息前 20 字，不覆盖已有）", () => {
  const LONG = "一二三四五六七八九十一二三四五六七八九十一二三"; // 23 字

  it("首条设置标题并截断到 20 字", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const cid = await ensureConversation("L1", new Date(T0));
    expect(LONG.length).toBeGreaterThan(20); // 没有它，"截断"断言在 20 字以内也恒真（空转）

    await setTitleIfEmpty(cid!, LONG);

    // 去掉 `.slice(0, 20)` → 存进去 23 字，本条红
    expect(titleOf(sqlite, cid!)).toEqual({ title: LONG.slice(0, 20) });
    expect((titleOf(sqlite, cid!) as { title: string }).title).toHaveLength(20);

    sqlite.close();
  });

  it("第二条不覆盖已有标题", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const cid = await ensureConversation("L1", new Date(T0));

    await setTitleIfEmpty(cid!, "第一条消息");
    await setTitleIfEmpty(cid!, "第二条消息");

    // 去掉 SQL 里的 `(title IS NULL OR title = '')` 守卫 → 被覆盖成"第二条消息"，本条红
    expect(titleOf(sqlite, cid!)).toEqual({ title: "第一条消息" });

    sqlite.close();
  });

  it("title 是空串也算空（会被填上）", async () => {
    const sqlite = await realDb();
    state.db = asTauriDb(sqlite);
    const cid = await ensureConversation("L1", new Date(T0));
    sqlite.prepare("UPDATE ai_conversations SET title = '' WHERE id = ?").run(cid!);

    await setTitleIfEmpty(cid!, "空标题也要填");

    // 去掉守卫里的 `OR title = ''` → 空串被当成"已有标题"，本条红
    expect(titleOf(sqlite, cid!)).toEqual({ title: "空标题也要填" });

    sqlite.close();
  });
});

afterEach(() => {
  state.db = null;
});
