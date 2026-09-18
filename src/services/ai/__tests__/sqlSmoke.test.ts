import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildGroupsSql, buildItemsSql, buildSummarySql, buildWhere, shapeSummary,
  type GroupRow, type ItemRow, type SummaryRow,
} from "@/services/ai/querySql";
import type { AiQuery } from "@/services/ai/dsl";
import type { ResolvedFilter } from "@/services/ai/resolve";
// 直接引被测实现里的那条 SQL，而不是在测试里抄一份：抄一份的后果是
// "实现里漏了 is_deleted、测试里那份没漏"，两边永远不会同时红。
import { FULL_RANGE_SQL } from "@/services/ai/runQuery";

/**
 * 直接 import `node:sqlite`，**不做"拿不到就跳过"的兜底**（这是 R48 的裁决）。
 *
 * 曾经想写成 `createRequire` + `describe.skipIf(!sqlite)`，理由是"Node 22 上可能需要
 * --experimental-sqlite"。**这个前提已被官方文档否掉**：node:sqlite 的 History 表写着
 * `v22.13.0 | SQLite is no longer behind --experimental-sqlite`（v22.5.0 引入），
 * 而 CI 的 `node-version: 22` 解析到**最新** 22.x（当前 22.23.2），本机是 24.19.0。
 *
 * 更要紧的是：**会静默跳过的验收测试不算验收测试**。如果有人把运行环境降到 22.12 以下，
 * 我们应该看到**一条失败的测试**，而不是"全绿但其实什么都没验"。
 * 所以这里让 import 直接失败——那正是我们想要的信号。
 *
 * 依赖的环境下限：**Node >= 22.13.0**（无 flag）。若将来 Node 升级改了这个模块的 API，
 * 本文件会在 import 或断言阶段红，那也是正确的信号。
 *
 * 为什么非要用真库：`vi.mock` 只能证明"SQL 字符串长得对"。上一轮审查用真实 node:sqlite
 * 发现过一个**任何文本断言都抓不住的数据错误**（tag 分组按软删标签重复计钱，桶和 350 ≠
 * 总额 240，SQL 字符串完全正确）。会生成 SQL 的模块，执行级测试不是加分项，是必需品。
 */
const SCHEMA = `
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, user_id TEXT NOT NULL,
    amount REAL NOT NULL, type TEXT NOT NULL,
    from_account_id TEXT, to_account_id TEXT, category_id TEXT,
    note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, is_deleted INTEGER DEFAULT 0);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT);
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT, is_deleted INTEGER DEFAULT 0);
  CREATE TABLE transaction_tags (transaction_id TEXT, tag_id TEXT);
`;

/**
 * 本地时间 → ISO 串。
 *
 * **必须用本地构造，不能硬编码 Z 时刻。** 这套夹具要同时验证"三月的流水都在区间内"
 * 和"时区边界上的流水归属正确"，而区间边界本身就是按本地日算的（MARCH 那两个
 * `new Date(2026, ...)`）。混用本地边界 + 固定 UTC 夹具，会让断言在 UTC 运行的 CI 上
 * 悄悄翻转——本地跑绿、CI 跑红那种最难查的失败。
 */
function at(month: number, day: number, hour = 10, minute = 0): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString();
}

/** 2026-03-01 ~ 2026-03-31（本地日）对应的半开区间 */
const MARCH = {
  from: "2026-03-01",
  to: "2026-03-31",
  startIso: new Date(2026, 2, 1).toISOString(),
  endIso: new Date(2026, 3, 1).toISOString(),
};

function makeFilter(over: Partial<ResolvedFilter> = {}): ResolvedFilter {
  return {
    range: MARCH, type: null, categoryIds: null, accountId: null, tagIds: null,
    memberIds: null, merchant: null, amountMin: null, amountMax: null, ...over,
  };
}

function seed(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO categories VALUES ('c-food', '买菜', 0), ('c-dead', '已删分类', 1);
    INSERT INTO accounts VALUES ('a-cmb', '招行'), ('a-cash', '现金');
    -- t-dead 的名字刻意**含「盒马」**：它是一条「本该命中、但因为已软删而必须被忽略」
    -- 的标签。名字若不含关键词，挂多少笔交易都测不出 sq_tg.is_deleted = 0 有没有生效。
    INSERT INTO tags VALUES ('t-hm', '盒马', 0), ('t-dead', '盒马已删标签', 1);
  `);
  const insert = db.prepare(
    `INSERT INTO transactions
       (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  type SeedRow = [string, string, string, number, string, string | null, string | null, string | null, string | null, string, string];
  const rows: SeedRow[] = [
    // 三月的两笔支出（备注含「盒马」）
    ["t1", "L1", "u-wife", 100, "expense", "a-cmb", null, "c-food", "盒马买菜", at(3, 2), at(3, 2)],
    ["t2", "L1", "u-wife", 200, "expense", "a-cmb", null, "c-food", "盒马买肉", at(3, 20), at(3, 20)],
    // 三月一笔收入
    ["t3", "L1", "u-me", 5000, "income", null, "a-cmb", null, "工资", at(3, 5), at(3, 5)],
    // 一笔转账：绝不能进收支
    ["t4", "L1", "u-me", 300, "transfer", "a-cmb", "a-cash", null, null, at(3, 6), at(3, 6)],
    // 二月：区间外
    ["t5", "L1", "u-me", 999, "expense", "a-cmb", null, "c-food", "盒马二月的", at(2, 10), at(2, 10)],
    // 三月但软删：绝不能进统计（下面统一 UPDATE 成 is_deleted=1）
    ["t6", "L1", "u-me", 888, "expense", "a-cmb", null, "c-food", "盒马已删", at(3, 8), at(3, 8)],
    // 别的账本：绝不能串进来
    ["t7", "L2", "u-me", 777, "expense", "a-cmb", null, "c-food", "盒马别账本", at(3, 9), at(3, 9)],
    // 标签命中（备注里没有「盒马」）
    ["t8", "L1", "u-me", 50, "expense", "a-cmb", null, "c-food", "生鲜采购", at(3, 11), at(3, 11)],
    // 时区边界：本地 3 月 31 日 23:30，必须落在三月内
    ["t9", "L1", "u-me", 30, "expense", "a-cmb", null, "c-food", "月末", at(3, 31, 23, 30), at(3, 31, 23, 30)],
    // 时区边界：本地 4 月 1 日 00:30，必须落在三月外
    ["t10", "L1", "u-me", 40, "expense", "a-cmb", null, "c-food", "四月头", at(4, 1, 0, 30), at(4, 1, 0, 30)],
  ];
  for (const r of rows) insert.run(...r);
  db.prepare("INSERT INTO transaction_tags VALUES (?, ?)").run("t8", "t-hm");
  // t9 的备注是「月末」（不含「盒马」），只挂着那个**已软删**的「盒马已删标签」。
  // 这条挂载是必需的：没有它，「不误伤已删标签」的断言就是空转的——
  // 去掉 sq_tg.is_deleted = 0 结果仍是 350，测试照样绿。
  // 挂 t9 而不是新造一笔交易，是因为 t9 本来就在汇总/成员分组的期望里（30 元），
  // 加一根标签行不改变任何既有期望数字。
  db.prepare("INSERT INTO transaction_tags VALUES (?, ?)").run("t9", "t-dead");
  db.prepare("UPDATE transactions SET is_deleted = 1 WHERE id = ?").run("t6");
  return db;
}

describe("真实 SQLite 冒烟测试", () => {
  it("汇总：排除转账/软删/其他账本，且时区边界正确", () => {
    const db = seed();
    const frag = buildSummarySql("L1", makeFilter());
    const row = db.prepare(frag.sql).get(...frag.params) as unknown as SummaryRow | undefined;
    const s = shapeSummary(row, null);
    // 支出命中：t1(100) + t2(200) + t8(50) + t9(30) = 380
    expect(s.expense!.total).toBe(380);
    expect(s.expense!.count).toBe(4);
    // 收入：t3
    expect(s.income!.total).toBe(5000);
    // matched 含转账 t4，不含 t5/t6/t7/t10
    expect(s.matched).toBe(6);
    db.close();
  });

  it("merchant=盒马 同时命中备注与标签，且不误伤「已删标签」", () => {
    const db = seed();
    const frag = buildSummarySql("L1", makeFilter({ merchant: "盒马" }));
    const row = db.prepare(frag.sql).get(...frag.params) as unknown as SummaryRow | undefined;
    // t1 + t2（备注命中）+ t8（活跃标签「盒马」命中）= 350
    // t9 挂的「盒马已删标签」名字含关键词、但已软删，必须被忽略；
    // 少了 sq_tg.is_deleted = 0 它就会被算进来变成 380 —— 这条断言才有意义。
    expect(shapeSummary(row, "expense").expense!.total).toBe(350);
    db.close();
  });

  it("merchant 里的 % 被当成字面量而不是通配符", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, occurred_at, created_at)
       VALUES ('p1', 'L1', 'u-me', 10, 'expense', 'a-cmb', '2026-03-12T10:00:00.000Z', '2026-03-12T10:00:00.000Z')`,
    ).run();
    const withPct = buildSummarySql("L1", makeFilter({ merchant: "50%" }));
    const r1 = db.prepare(withPct.sql).get(...withPct.params) as unknown as SummaryRow | undefined;
    // 没有任何备注含字面量 "50%"，若未转义则 % 会匹配全部 → 断言为 0 才说明转义生效
    expect(shapeSummary(r1, "expense").expense!.total).toBe(0);
    db.close();
  });

  it("转账被排除在收支之外，但 type=transfer 时单独统计", () => {
    const db = seed();
    const onlyTransfer = buildSummarySql("L1", makeFilter({ type: "transfer" }));
    const row = db.prepare(onlyTransfer.sql).get(...onlyTransfer.params) as unknown as SummaryRow | undefined;
    const s = shapeSummary(row, "transfer");
    expect(s.transfer!.total).toBe(300);
    expect(s.expense).toBeNull();
    db.close();
  });

  it("按分类分组：软删分类落到「未分类」", () => {
    const db = seed();
    db.prepare(
      `INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, category_id, occurred_at, created_at)
       VALUES ('d1', 'L1', 'u-me', 70, 'expense', 'a-cmb', 'c-dead', '2026-03-13T10:00:00.000Z', '2026-03-13T10:00:00.000Z')`,
    ).run();
    const q: AiQuery = { aggregate: "sum", groupBy: "category" };
    const frag = buildGroupsSql("L1", q, makeFilter());
    const rows = db.prepare(frag.sql).all(...frag.params) as unknown as GroupRow[];
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.expense_total]));
    expect(byKey["买菜"]).toBe(380);
    expect(byKey["未分类"]).toBe(70);
    db.close();
  });

  it("组合筛选（时间+商户+金额+标签）真跑一次，且 ? 的个数与 params 长度一致", () => {
    // 审查者 B 项建议。为什么必须有：实测 SQLite 对**少传参数不报错**——
    // 缺失的占位符被当成 NULL，查询**静默返回 0 行**（只有多传才报 column index out of range）。
    // 也就是说 params 少一个、或 push 顺序错位，SQL 照样执行成功、数字却是错的，
    // 而且**不改 `?` 的计数**。只有"真跑 + 对黄金数字"能发现。
    const db = seed();
    const f = makeFilter({
      range: MARCH,
      merchant: "盒马",
      amountMin: 50,
      amountMax: 200,
      tagIds: ["t-hm"],
    });
    const frag = buildSummarySql("L1", f);

    // 不变式：占位符个数必须等于 params 长度（少传会被静默当 NULL）
    expect((frag.sql.match(/\?/g) ?? []).length).toBe(frag.params.length);

    const row = db.prepare(frag.sql).get(...frag.params) as unknown as SummaryRow | undefined;
    const s = shapeSummary(row, null);
    // 黄金数字（**按上面 seed 的夹具手工推导**，不是从被测代码反推）：
    //   t1 100 元三月、备注含「盒马」、金额在区间内 → 但**没有 t-hm 标签**，被 tagIds 排除
    //   t2 200 元同上（同样没标签）→ 排除
    //   t3 5000 收入 → 超金额上限；t4 转账 → 无 note 且 merchant 不命中
    //   t8 50 元三月、备注「生鲜采购」不含关键词，但**挂 t-hm（名字就叫「盒马」）** → 命中
    //   t9 30 元 → 低于金额下限；t5/t10 出区间；t6 软删；t7 别的账本
    // 所以恰好 1 笔、50 元。**若实测与此不符，先怀疑我的推导，把过程写进报告再改。**
    expect(s.matched).toBe(1);
    expect(s.expense!.total).toBe(50);
    db.close();
  });

  it("系统扫一遍筛选组合：? 计数 === params 长度，且都能在真库上绑定执行", () => {
    // 审查者用 92160 个组合验证过现状 0 例外；这里放一个**小规模笛卡尔积**作为常驻护栏，
    // 覆盖"将来有人加了一个条件却忘了 push/多 push"这类改动。
    const db = seed();
    // 数组轴显式标注为 `string[] | null`：`as const` 元组是 readonly，
    // 赋给 ResolvedFilter 的 `string[] | null` 会 TS2322（严格模式下不能把 readonly 给可变）。
    const axes = {
      type: [undefined, "expense", "income", "transfer"] as const,
      range: [undefined, MARCH] as const,
      categoryIds: [null, ["c-food"], ["c-food", "c-dead"]] as (string[] | null)[],
      tagIds: [null, ["t-hm"]] as (string[] | null)[],
      memberIds: [null, ["u-me"]] as (string[] | null)[],
      accountId: [null, "a-cmb"] as const,
      merchant: [null, "盒马"] as const,
      amountMin: [null, 0, 50] as const,
      amountMax: [null, 0, 200] as const,
    };
    let checked = 0;
    for (const type of axes.type)
      for (const range of axes.range)
        for (const categoryIds of axes.categoryIds)
          for (const tagIds of axes.tagIds)
            for (const memberIds of axes.memberIds)
              for (const accountId of axes.accountId)
                for (const merchant of axes.merchant)
                  for (const amountMin of axes.amountMin)
                    for (const amountMax of axes.amountMax) {
                      const f = makeFilter({
                        type: type ?? null, range: range ?? null,
                        categoryIds, tagIds, memberIds, accountId,
                        merchant, amountMin, amountMax,
                      });
                      const frags = [
                        buildSummarySql("L1", f),
                        buildGroupsSql("L1", { aggregate: "sum", groupBy: "month" }, f),
                        buildItemsSql("L1", { aggregate: "list" }, f),
                      ];
                      // buildWhere 只产出 ` WHERE ...` 片段（本模块的契约），**单独执行不是合法 SQL**
                      // （`near "WHERE": syntax error`）。要真库执行它就得先拼进一条 SELECT，
                      // 而这正是上面三个构造函数做的事——所以这里对它只做占位符计数，
                      // 执行交给那三个完整查询。
                      for (const frag of [buildWhere("L1", f), ...frags]) {
                        expect((frag.sql.match(/\?/g) ?? []).length).toBe(frag.params.length);
                      }
                      for (const frag of frags) {
                        // 真库绑定执行：少传会被当 NULL 静默 0 行，多传才抛错，
                        // 所以这里必须真执行一次而不是只看字符串
                        db.prepare(frag.sql).all(...frag.params);
                        checked++;
                      }
                    }
    expect(checked).toBeGreaterThan(10_000);
    db.close();
  });

  it("按成员分组，金额按成员分开", () => {
    const db = seed();
    const q: AiQuery = { aggregate: "sum", groupBy: "member" };
    const frag = buildGroupsSql("L1", q, makeFilter());
    const rows = db.prepare(frag.sql).all(...frag.params) as unknown as GroupRow[];
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.expense_total]));
    expect(byKey["u-wife"]).toBe(300);
    expect(byKey["u-me"]).toBe(80);
    db.close();
  });

  it("按标签分组：一笔多标签会同时计入两个桶", () => {
    const db = seed();
    db.prepare("INSERT INTO tags VALUES ('t-fresh', '生鲜', 0)").run();
    db.prepare("INSERT INTO transaction_tags VALUES ('t1', 't-hm')").run();
    db.prepare("INSERT INTO transaction_tags VALUES ('t1', 't-fresh')").run();
    const q: AiQuery = { aggregate: "sum", groupBy: "tag" };
    const frag = buildGroupsSql("L1", q, makeFilter());
    const rows = db.prepare(frag.sql).all(...frag.params) as unknown as GroupRow[];
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.expense_total]));
    expect(byKey["盒马"]).toBe(150);  // t1(100) + t8(50)
    expect(byKey["生鲜"]).toBe(100);  // t1(100)
    db.close();
  });

  it("明细查询返回精简字段且按时间倒序", () => {
    const db = seed();
    const q: AiQuery = { aggregate: "list" };
    const frag = buildItemsSql("L1", q, makeFilter({ merchant: "盒马" }));
    const rows = db.prepare(frag.sql).all(...frag.params) as unknown as ItemRow[];
    // 按 occurred_at 倒序：t2(3/20, 200) → t8(3/11, 50) → t1(3/2, 100)
    expect(rows[0].day).toBe("2026-03-20");
    expect(rows[0].amount).toBe(200);
    expect(rows.map((r) => r.amount)).toEqual([200, 50, 100]);
    db.close();
  });

  it("派生区间（runQuery 的 MIN/MAX）覆盖全账本，且带账本隔离与软删过滤", () => {
    // runQuery 里那条 FULL_RANGE_SQL 的执行级对应：mock 版本只能断言字符串，
    // 这里证明它真的取到「该账本全部未删流水」的两端。
    const db = seed();
    const row = db.prepare(FULL_RANGE_SQL).get("L1") as unknown as { min_at: string; max_at: string };
    // 注意这个区间**故意比查询自身的 MARCH 更宽**：它的语义是"覆盖全账本"，
    // 用来给芯片一个跳转到流水页后不会被改写的显式区间，而不是给聚合加过滤。
    // MIN = t5（本地 2/10）、MAX = t10（本地 4/1 00:30）——两个都在 MARCH 之外，
    // 正好证明它不是"把 MARCH 拿来重算一遍"。
    expect(row.min_at).toBe(at(2, 10));
    expect(row.max_at).toBe(at(4, 1, 0, 30));
    db.close();

    const db2 = new DatabaseSync(":memory:");
    db2.exec(SCHEMA);
    db2.exec(`
      INSERT INTO transactions (id, ledger_id, user_id, amount, type, occurred_at, created_at, is_deleted)
      VALUES ('k1', 'L1', 'u-me', 10, 'expense', '2026-05-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z', 0),
             ('k2', 'L1', 'u-me', 10, 'expense', '2026-09-01T10:00:00.000Z', '2026-09-01T10:00:00.000Z', 1),
             ('k3', 'L2', 'u-me', 10, 'expense', '2026-12-01T10:00:00.000Z', '2026-12-01T10:00:00.000Z', 0);
    `);
    const only = db2.prepare(FULL_RANGE_SQL).get("L1") as unknown as { min_at: string; max_at: string };
    // 少了 is_deleted = 0 → max 会变成 k2 的九月；少了 ledger_id → max 会变成 k3 的十二月。
    expect(only.min_at).toBe("2026-05-01T10:00:00.000Z");
    expect(only.max_at).toBe("2026-05-01T10:00:00.000Z");
    db2.close();
  });

  it("账本一笔都没有时派生查询返回两个 NULL", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
    const row = db.prepare(FULL_RANGE_SQL).get("L-empty") as unknown as { min_at: null; max_at: null };
    // runQuery 据此放弃派生（applied 的日期保持 null）。若这里变成了 '' 之类的假值，
    // deriveFullRange 的 `!row?.min_at` 守卫会失效并产出两个假日期。
    expect(row.min_at).toBeNull();
    expect(row.max_at).toBeNull();
    db.close();
  });
});
