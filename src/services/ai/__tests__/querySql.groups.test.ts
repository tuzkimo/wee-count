import { describe, it, expect } from "vitest";
// 执行级回归要用**真实** SQLite：Node 22.5+ 起 `node:sqlite` 内置，无需 flag，绝不 mock。
// mock 掉的恰好就是本层唯一能查的东西（"SQL 合法但结果错"），见下方 describe("执行级：真跑一次")。
import { DatabaseSync } from "node:sqlite";
// 期望值用 offsetModifier() 本尊现算（审查 M-3）：写死 '+480 minutes' 只在 UTC+8 的
// 机器上成立，而且换个常量（'+0 minutes' = 不偏移、'-480 minutes' = 忘记取反）也依然全绿。
import { offsetModifier } from "@/utils/datetime";
import {
  buildGroupsSql, buildItemsSql, buildSummarySql, clampLimit, shapeGroups, shapeItems, shapeSummary,
  type AiGroup, type GroupRow, type ItemRow, type SummaryRow,
} from "@/services/ai/querySql";
import type { AiQuery } from "@/services/ai/dsl";
import type { ResolvedFilter } from "@/services/ai/resolve";

function makeFilter(over: Partial<ResolvedFilter> = {}): ResolvedFilter {
  return {
    range: null, type: null, categoryIds: null, accountId: null, tagIds: null,
    memberIds: null, merchant: null, amountMin: null, amountMax: null, ...over,
  };
}

function makeQuery(over: Partial<AiQuery> = {}): AiQuery {
  return { aggregate: "sum", ...over };
}

/**
 * 孤立代理字符（半个 emoji）：高代理后面没跟低代理，或低代理前面没有高代理。
 * 截断一旦按 UTF-16 单元来（JS 的 `slice(0, 60)`）就会切出这种东西，
 * 而它在 JS 里是合法字符串、`JSON.stringify` 也只是转义成 `\ud83d`——静默的坏数据。
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("clampLimit", () => {
  it("缺省用 10", () => {
    expect(clampLimit(undefined, 50)).toBe(10);
  });
  it("超过上限被夹住", () => {
    expect(clampLimit(999, 50)).toBe(50);
    expect(clampLimit(999, 20)).toBe(20);
  });
  it("小于 1 被抬到 1", () => {
    expect(clampLimit(0, 50)).toBe(1);
  });
});

describe("buildGroupsSql", () => {
  it("category 分组 join categories 且软删分类视为未分类", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "category" }), makeFilter());
    expect(sql).toContain("LEFT JOIN categories c ON c.id = t.category_id AND c.is_deleted = 0");
    expect(sql).toContain("COALESCE(c.name, '未分类')");
    expect(sql).toContain("GROUP BY key");
  });

  it("account 分组优先取转出方，落到转入方", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "account" }), makeFilter());
    expect(sql).toContain("COALESCE(fa.name, ta.name");
  });

  it("tag 分组 join 标签，一笔多标签会计入每个标签桶", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "tag" }), makeFilter());
    expect(sql).toContain("LEFT JOIN transaction_tags gtt ON gtt.transaction_id = t.id");
    // 关联行这一侧必须限活跃标签，否则软删标签的关联行会扇出多行、把同一笔计 N 份（I-1）。
    // 文本断言只是护栏——真正钉住它的是下面 describe("执行级：真跑一次") 里的执行级用例，
    // 因为 SQL 字符串"看起来对"这件事本身没有任何信息量。
    expect(sql).toContain("gtt.tag_id IN (SELECT id FROM tags WHERE is_deleted = 0)");
    expect(sql).toContain("COALESCE(gtg.name, '未打标签')");
  });

  it("month 分组按时区偏移归桶", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "month" }), makeFilter());
    // 形状与取值一起钉：`${offsetModifier()}` 是断言的一部分，换个写死的常量就红
    expect(sql).toContain(`strftime('%Y-%m', t.occurred_at, '${offsetModifier()}')`);
  });

  it("day 分组按时区偏移归桶", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "day" }), makeFilter());
    expect(sql).toContain(`date(t.occurred_at, '${offsetModifier()}')`);
  });

  it("member 分组直接用 user_id 作 key（显示名由调用方替换）", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "member" }), makeFilter());
    expect(sql).toContain("t.user_id AS key");
  });

  it("默认按可见桶之和降序，limit 被夹到 50", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "category", limit: 999 }), makeFilter());
    expect(sql).toContain("ORDER BY (expense_total + income_total) DESC");
    expect(sql).toContain("LIMIT 50");
  });

  it("value_asc 反向排序", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "category", orderBy: "value_asc" }), makeFilter());
    expect(sql).toContain("ORDER BY (expense_total + income_total) ASC");
  });

  it("指定 type 时只按那一个桶排序", () => {
    // type=expense 时对外只有支出，排序键必须跟着窄下来
    const { sql } = buildGroupsSql(
      "L1", makeQuery({ groupBy: "category" }), makeFilter({ type: "expense" }),
    );
    expect(sql).toContain("ORDER BY expense_total DESC");
  });

  it("date_desc 按 key 排序（月份分组时即时间序）", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "month", orderBy: "date_desc" }), makeFilter());
    expect(sql).toContain("ORDER BY key DESC");
  });

  it("date_asc 按 key 升序（审查 M-4：此前零覆盖，date_asc 静默落到 DESC 也没人发现）", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "month", orderBy: "date_asc" }), makeFilter());
    expect(sql).toContain("ORDER BY key ASC");
  });

  it("WHERE 条件仍然生效", () => {
    const { sql, params } = buildGroupsSql("L1", makeQuery({ groupBy: "category" }), makeFilter({ merchant: "盒马" }));
    expect(sql).toContain("t.note LIKE ?");
    expect(params).toContain("%盒马%");
  });
});

describe("buildItemsSql", () => {
  it("按发生时间倒序，limit 被夹到 20", () => {
    const { sql } = buildItemsSql("L1", makeQuery({ aggregate: "list", limit: 999 }), makeFilter());
    expect(sql).toContain("ORDER BY t.occurred_at DESC, t.created_at DESC");
    expect(sql).toContain("LIMIT 20");
  });

  it("date_asc 时升序：模型问「最早的 N 笔」必须拿到最早的（M-5）", () => {
    const { sql } = buildItemsSql("L1", makeQuery({ aggregate: "list", orderBy: "date_asc" }), makeFilter());
    expect(sql).toContain("ORDER BY t.occurred_at ASC, t.created_at ASC");
  });

  it("value_asc / value_desc 对平铺列表没有意义，落回时间倒序", () => {
    // 只有 date_asc 反转。这里把「其余一律 DESC」这条契约也钉住，
    // 免得有人把 value_asc 也当成升序信号
    for (const orderBy of ["value_asc", "value_desc", "date_desc"] as const) {
      const { sql } = buildItemsSql("L1", makeQuery({ aggregate: "list", orderBy }), makeFilter());
      expect(sql).toContain("ORDER BY t.occurred_at DESC, t.created_at DESC");
    }
  });

  it("备注截断到 60 字", () => {
    const { sql } = buildItemsSql("L1", makeQuery({ aggregate: "list" }), makeFilter());
    expect(sql).toContain("substr(t.note, 1, 60)");
  });

  it("日期按本地时区归天", () => {
    const { sql } = buildItemsSql("L1", makeQuery({ aggregate: "list" }), makeFilter());
    expect(sql).toMatch(/date\(t\.occurred_at, '[+-]\d+ minutes'\) AS day/);
  });
});

describe("shapeGroups", () => {
  it("round2 并保留三个桶", () => {
    const rows = [
      { key: "买菜", expense_total: 800.005, income_total: 0, transfer_total: 0, cnt: 8 },
      { key: "餐饮", expense_total: 300, income_total: 50.5, transfer_total: 0, cnt: 3 },
    ];
    expect(shapeGroups(rows)).toEqual([
      { label: "买菜", expense: 800.01, income: 0, transfer: 0, count: 8 },
      { label: "餐饮", expense: 300, income: 50.5, transfer: 0, count: 3 },
    ]);
  });

  it("空输入返回空数组", () => {
    expect(shapeGroups([])).toEqual([]);
  });
});

describe("shapeItems", () => {
  it("字段名映射到 camelCase 并 round2", () => {
    // 显式标注 ItemRow[]：字面量里的 "expense" 会被推断成 string，不加标注在
    // 严格模式下 vue-tsc 直接报错（测试文件同样参与类型检查）
    const rows: ItemRow[] = [{
      day: "2026-03-02", amount: 120.005, type: "expense",
      category_name: "买菜", from_account_name: "招行", to_account_name: null,
      note: "盒马",
    }];
    expect(shapeItems(rows)).toEqual([{
      date: "2026-03-02", amount: 120.01, type: "expense",
      category: "买菜", fromAccount: "招行", toAccount: null, note: "盒马",
    }]);
  });

  it("字段缺失时给 null 而不是 undefined", () => {
    const rows: ItemRow[] = [{
      day: "2026-03-02", amount: 1, type: "transfer",
      category_name: null, from_account_name: "A", to_account_name: "B", note: null,
    }];
    expect(shapeItems(rows)[0].category).toBeNull();
    expect(shapeItems(rows)[0].note).toBeNull();
  });

  it("备注只透传，不在 JS 侧按 UTF-16 截断（含 emoji 的长备注）", () => {
    // 截断在 SQL 侧 substr(t.note, 1, 60)，SQLite 的 substr 按**码点**计数，安全。
    // 危险的是将来有人把截断挪进 shapeItems 用 `slice(0, 60)`：那按 UTF-16 单元计数，
    // 会切开代理对。80 个 emoji 正好覆盖这条边界（160 个 UTF-16 单元 / 80 个码点）。
    const note = "😀".repeat(80);
    const rows: ItemRow[] = [{
      day: "2026-03-02", amount: 1, type: "expense",
      category_name: null, from_account_name: null, to_account_name: null, note,
    }];
    const out = shapeItems(rows)[0].note ?? "";
    expect(out).toBe(note);
    expect([...out].length).toBe(80);
    expect(out).not.toMatch(LONE_SURROGATE);
  });
});

// ---------------------------------------------------------------------------
// 执行级回归（审查 I-1 / M-5）。
//
// 为什么非有这一层不可：I-1（软删标签把同一笔在「未打标签」桶里计 N 份）的 SQL
// 字符串**长得完全正确**，任何文本断言都抓不住；M-5（list 忽略 date_asc）同样只是
// "顺序反了"而没有语法问题。绑定错位更是连报错都没有。所以这里不 mock、真跑一遍。
// ---------------------------------------------------------------------------

/** 真实 schema（与 src-tauri 的迁移一致的最小集）。两个夹具库共用 */
const FIXTURE_SCHEMA = `
  CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL,
    occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
    category_id TEXT, from_account_id TEXT, to_account_id TEXT, user_id TEXT, note TEXT,
    is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE transaction_tags (
    transaction_id TEXT NOT NULL, tag_id TEXT NOT NULL,
    PRIMARY KEY (transaction_id, tag_id)
  );
`;

/** 按真实 schema 建内存库并填入夹具。每个用例各开一个，互不干扰 */
function openFixtureDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(FIXTURE_SCHEMA);
  db.exec(`
    INSERT INTO tags (id, name, is_deleted) VALUES
      ('t_live',  '工作日',  0),
      ('t_live2', '出差',    0),
      ('t_dead1', '旧标签A', 1),
      ('t_dead2', '旧标签B', 1);

    -- 4 笔全为支出、合计 240。**没有一笔带两个活跃标签**，所以 tag 分组下
    -- 「桶和 === 总额」这条不变式应当精确成立（多活跃标签导致桶和大于总额是另一件事，
    -- 见 buildGroupsSql 的注释）。
    INSERT INTO transactions (id, ledger_id, type, amount, occurred_at, created_at, is_deleted) VALUES
      ('x_plain',          'L1', 'expense', 100, '2026-03-01T01:00:00.000Z', '2026-03-01T01:00:00.000Z', 0),
      ('x_two_dead',       'L1', 'expense',  40, '2026-03-02T01:00:00.000Z', '2026-03-02T01:00:00.000Z', 0),
      ('x_live_plus_dead', 'L1', 'expense',  70, '2026-03-03T01:00:00.000Z', '2026-03-03T01:00:00.000Z', 0),
      ('x_active',         'L1', 'expense',  30, '2026-03-04T01:00:00.000Z', '2026-03-04T01:00:00.000Z', 0);

    INSERT INTO transaction_tags (transaction_id, tag_id) VALUES
      ('x_two_dead',       't_dead1'),   -- 两个软删标签：关联行不限活跃时会扇出成 2 行 → 金额计 2 份
      ('x_two_dead',       't_dead2'),
      ('x_live_plus_dead', 't_live2'),   -- 活跃标签：这笔只该进「出差」桶
      ('x_live_plus_dead', 't_dead1'),   -- 软删标签：关联行不限活跃时会把同一笔再塞进「未打标签」
      ('x_active',         't_live');
  `);
  return db;
}

/** 只有一笔、备注可控的库：专供截断/字符边界用例，不污染 tag 分组夹具的数字 */
function openNoteDb(note: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(FIXTURE_SCHEMA);
  db.prepare(
    "INSERT INTO transactions (id, ledger_id, type, amount, occurred_at, created_at, note, is_deleted)" +
    " VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
  ).run("x_note", "L1", "expense", 10, "2026-03-01T01:00:00.000Z", "2026-03-01T01:00:00.000Z", note);
  return db;
}

/** 取指定标签桶。缺失时抛出比 `undefined.expense` 有用得多的报错 */
function tagBucket(groups: AiGroup[], label: string): AiGroup {
  const g = groups.find((it) => it.label === label);
  if (!g) throw new Error(`分组里没有「${label}」桶，实际有：${groups.map((it) => it.label).join(" / ")}`);
  return g;
}

/** 真跑一次 tag 分组 */
function runTagGroups(db: DatabaseSync): AiGroup[] {
  const { sql, params } = buildGroupsSql("L1", makeQuery({ groupBy: "tag" }), makeFilter());
  return shapeGroups(db.prepare(sql).all(...params) as unknown as GroupRow[]);
}

describe("执行级：真跑一次", () => {
  it("tag 分组「未打标签」桶 = 140（软删标签的关联行不重复计入）", () => {
    const db = openFixtureDb();
    // 100（无标签）+ 40（两个软删标签，只算 1 份）。关联行不限活跃时会变成
    // 100 + 80 + 70 = 250（两个软删各计一份，外加带活跃标签的那笔也被塞进来）
    expect(tagBucket(runTagGroups(db), "未打标签").expense).toBe(140);
  });

  it("tag 分组「未打标签」桶 count = 2（不是 4）", () => {
    const db = openFixtureDb();
    // x_plain 1 份 + x_two_dead 1 份。修好前是 4 份
    expect(tagBucket(runTagGroups(db), "未打标签").count).toBe(2);
  });

  it("tag 分组「工作日」桶 = 30，带活跃标签的交易不被误归入「未打标签」", () => {
    const db = openFixtureDb();
    const groups = runTagGroups(db);
    // 这一条在 I-1 修好前的错误实现下**也是绿的**（那笔本来就该进活跃桶），
    // 它钉的是"修 JOIN 不要把正常路径一起改坏"
    expect(tagBucket(groups, "工作日").expense).toBe(30);
    // x_live_plus_dead（70）只该进它自己的活跃桶「出差」
    expect(tagBucket(groups, "出差").expense).toBe(70);
    // 软删标签名一律不可见
    expect(groups.map((it) => it.label)).not.toContain("旧标签A");
  });

  it("不变式：tag 分组所有桶的金额之和 === 该筛选下的总额", () => {
    const db = openFixtureDb();
    const groups = runTagGroups(db);
    const { sql, params } = buildSummarySql("L1", makeFilter());
    const summary = shapeSummary(db.prepare(sql).get(...params) as unknown as SummaryRow, null);
    // 先钉住总额本身：否则"桶和 === 总额"可能两边一起错、互相抵消
    expect(summary.expense?.total).toBe(240);
    // 最强的那条：不预设出错方式，只要存在扇出/重复计入，和就对不上
    expect(groups.reduce((s, g) => s + g.expense, 0)).toBe(summary.expense?.total);
  });

  it("明细 list + date_asc：第一条是最早那笔（M-5 的回归护栏）", () => {
    const db = openFixtureDb();
    const asc = buildItemsSql("L1", makeQuery({ aggregate: "list", orderBy: "date_asc" }), makeFilter());
    const ascItems = shapeItems(db.prepare(asc.sql).all(...asc.params) as unknown as ItemRow[]);
    expect(ascItems.map((it) => it.amount)).toEqual([100, 40, 70, 30]);
    expect(ascItems[0].amount).toBe(100);

    // 对照：不传 orderBy 时仍是最新在前。没有这一条，"顺序恒定"的实现也能碰巧过上面那条
    const desc = buildItemsSql("L1", makeQuery({ aggregate: "list" }), makeFilter());
    const descItems = shapeItems(db.prepare(desc.sql).all(...desc.params) as unknown as ItemRow[]);
    expect(descItems.map((it) => it.amount)).toEqual([30, 70, 40, 100]);
  });

  it("备注截断按码点、不切开代理对（真跑 SQL 侧的 substr）", () => {
    // 59 个 ASCII + 1 个 emoji + 1 个 ASCII = 61 个码点。SQL 侧
    // `substr(t.note, 1, 60)` 按**码点**截，第 60 个码点正好是 emoji 的边界 →
    // 得到「59 个 a + 完整 emoji」（60 码点 / 61 个 UTF-16 单元）。
    // 若有人把截断挪进 shapeItems 用 `slice(0, 60)`（按 UTF-16 单元），
    // 这里会变成「59 个 a + 孤立高代理」——SQL 不报错、JSON 也照样序列化，纯静默坏数据。
    const db = openNoteDb(`${"a".repeat(59)}😀b`);
    const { sql, params } = buildItemsSql("L1", makeQuery({ aggregate: "list" }), makeFilter());
    const items = shapeItems(db.prepare(sql).all(...params) as unknown as ItemRow[]);
    expect(items).toHaveLength(1);
    expect(items[0].note).toBe(`${"a".repeat(59)}😀`);
    expect([...(items[0].note ?? "")].length).toBe(60);
    expect(items[0].note).not.toMatch(LONE_SURROGATE);
  });
});
