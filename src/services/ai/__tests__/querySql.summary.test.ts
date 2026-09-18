import { describe, it, expect } from "vitest";
import { noteOrTagLikeClause } from "@/utils/like";
import { buildWhere, buildSummarySql, shapeSummary } from "@/services/ai/querySql";
import type { ResolvedFilter } from "@/services/ai/resolve";

function makeFilter(over: Partial<ResolvedFilter> = {}): ResolvedFilter {
  return {
    range: null,
    type: null,
    categoryIds: null,
    accountId: null,
    tagIds: null,
    memberIds: null,
    merchant: null,
    amountMin: null,
    amountMax: null,
    ...over,
  };
}

describe("buildWhere 恒定约束", () => {
  it("无条件查询带 ledger 隔离与软删过滤", () => {
    const { sql, params } = buildWhere("L1", makeFilter());
    expect(params).toEqual(["L1"]);
    expect(sql).toContain("t.ledger_id = ?");
    expect(sql).toContain("t.is_deleted = 0");
  });

  it("type 未给时不加任何类型条件：转账也要算进命中记录数", () => {
    // 容易写错的一点：曾经在 type 缺省时加 `t.type != 'transfer'`。
    // 那是过度应用——汇总 SQL 用 CASE WHEN 按类型分桶，收支聚合本来就不会被转账污染，
    // 而 WHERE 里多这一条会让 matched 少算转账，于是 AI 说"共 5 笔"、
    // 用户点进流水页看到 6 条。数字对不上比算错更伤信任。
    //
    // ⚠️ 这里**必须断言整串**，不能用 `not.toContain("t.type != 'transfer'")` 那种点名断言：
    // 审查实测，把变异写成 `t.type <> 'transfer'`（SQL 里与 `!=` 完全等价）时，
    // 点名断言 **47/47 全绿**——同一件事换个写法就绕过去了。
    // 断言整串还顺带钉住"没多出任何别的条件"，这正是本用例真正要保证的。
    const { sql, params } = buildWhere("L1", makeFilter());
    expect(sql).toBe(" WHERE t.ledger_id = ? AND t.is_deleted = 0");
    expect(params).toEqual(["L1"]);
  });

  it("type 指定时用等值条件", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ type: "expense" }));
    expect(sql).toContain("t.type = ?");
    expect(params).toEqual(["L1", "expense"]);
  });

  it("type=transfer 时按转账精确过滤", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ type: "transfer" }));
    expect(sql).toContain("t.type = ?");
    expect(params).toEqual(["L1", "transfer"]);
  });
});

describe("buildWhere 各条件", () => {
  it("时间半开区间", () => {
    const { sql, params } = buildWhere("L1", makeFilter({
      range: { from: "2026-01-01", to: "2026-12-31", startIso: "S", endIso: "E" },
    }));
    expect(sql).toContain("t.occurred_at >= ? AND t.occurred_at < ?");
    expect(params).toEqual(["L1", "S", "E"]);
  });

  it("账户同时匹配转出与转入", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ accountId: "A1" }));
    expect(sql).toContain("(t.from_account_id = ? OR t.to_account_id = ?)");
    expect(params).toEqual(["L1", "A1", "A1"]);
  });

  it("多分类用 IN", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ categoryIds: ["c1", "c2"] }));
    expect(sql).toContain("t.category_id IN (?,?)");
    expect(params).toEqual(["L1", "c1", "c2"]);
  });

  it("多标签是 AND 交集，与 fetchAll 语义一致", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ tagIds: ["t1", "t2"] }));
    expect(sql.match(/t\.id IN \(SELECT transaction_id FROM transaction_tags WHERE tag_id = \?\)/g))
      .toHaveLength(2);
    expect(params).toEqual(["L1", "t1", "t2"]);
  });

  it("多成员用 IN", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ memberIds: ["u1", "u2"] }));
    expect(sql).toContain("t.user_id IN (?,?)");
    expect(params).toEqual(["L1", "u1", "u2"]);
  });

  // 下面三条钉住「空数组 = 不过滤」这条契约（resolveFilter 返回 null、fetchAll 用
  // `.length > 0`，这一层也必须一致）。契约为什么重要：空数组 `[]` 在 JS 里是真值，
  // 判空一旦退化成真值判断，`placeholders()` 形的条件就会拼出 `IN ()`；而 SQLite 对
  // `IN ()` **不报错，只静默返回 0 行**——调用方拿到的是"匹配空集"而不是"没过滤"，
  // 是个无声的错误答案。
  //
  // 但**不是三处都一样**：会拼 `IN ()` 的只有走 `placeholders()` 的 `categoryIds` 与
  // `memberIds`；`tagIds` 那一处是 `for (const tagId of f.tagIds)` 的**循环体**，空数组
  // 循环零次，`if (f.tagIds)` 与 `if (f.tagIds?.length)` 输出完全相同——真值判断在
  // `tagIds` 上是**等价变异体**，打不红它（实测过）。三条断言分开写，是为了让
  // 「只漏改其中一处」也能被单独定位。

  it("categoryIds 为空数组时不加条件，与 categoryIds 为 null 完全等价（空数组 = 不过滤）", () => {
    // 为什么不写 `not.toContain("IN")`（审查 M-1）：那太宽——WHERE 里出现任何 `IN`
    // 都算违规，将来合法地补一个 `IN (?)` 形的条件（例如把 tagIds 改成列表、
    // 或补 uncategorized 的 `NOT EXISTS`/`IN`）会被误报，而 `IN ()` 这个真正要防的
    // 东西反倒不一定被抓到。按契约写成「与 null 逐字相同」更贴：一旦真值判断放行空数组、
    // 拼出 `t.category_id IN ()`，sql 与 params 都不再与 null 相同，这条必红。
    const empty = buildWhere("L1", makeFilter({ categoryIds: [] }));
    const none = buildWhere("L1", makeFilter({ categoryIds: null }));
    expect(empty.sql).toBe(none.sql);
    expect(empty.params).toEqual(none.params);
  });

  it("tagIds 为空数组时不加条件，与 tagIds 为 null 完全等价（空数组 = 不过滤）", () => {
    // 这一处的标题**不**声称能抓"真值判断拼出 IN ()"：`tagIds` 走的是循环体而不是
    // `placeholders()`，真值判断在这里是等价变异体（见上方共用注释）。它钉的是契约
    // 本身，按契约写成「与 null 逐字相同」比「不含 IN」更贴：一旦有人把 `tagIds` 也
    // 改成 `placeholders()` 形式的 `IN`，空数组就会产出 `IN ()`，sql 与 params 都
    // 不再与 null 相同，这条断言随即变红。
    const empty = buildWhere("L1", makeFilter({ tagIds: [] }));
    const none = buildWhere("L1", makeFilter({ tagIds: null }));
    expect(empty.sql).toBe(none.sql);
    expect(empty.params).toEqual(none.params);
  });

  it("memberIds 为空数组时不加条件，与 memberIds 为 null 完全等价（空数组 = 不过滤）", () => {
    // 与 categoryIds 那条同一形式、同一理由（审查 M-1）：`not.toContain("IN")` 过宽，
    // 契约形式「与 null 逐字相同」才精确对准 `IN ()` 这一个要防的错误产物。
    // 两条分开写，是为了让「只漏改其中一处」也能被单独定位。
    const empty = buildWhere("L1", makeFilter({ memberIds: [] }));
    const none = buildWhere("L1", makeFilter({ memberIds: null }));
    expect(empty.sql).toBe(none.sql);
    expect(empty.params).toEqual(none.params);
  });

  it("merchant 同时匹配备注与标签名，且带 ESCAPE", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ merchant: "盒马" }));
    expect(sql).toContain("t.note LIKE ? ESCAPE '\\'");
    expect(sql).toContain("sq_tg.name LIKE ? ESCAPE '\\'");
    expect(params).toEqual(["L1", "%盒马%", "%盒马%"]);
  });

  it("merchant 直接复用 utils/like 的共用片段，不自己拼 SQL", () => {
    // 与 fetchAll 必须逐字一致，所以只能来自同一个函数。这里断言片段原样出现，
    // 若实现改成手写一份，这条会红
    const { sql } = buildWhere("L1", makeFilter({ merchant: "盒马" }));
    expect(sql).toContain(noteOrTagLikeClause());
  });

  it("merchant 里的 LIKE 元字符被转义", () => {
    const { params } = buildWhere("L1", makeFilter({ merchant: "50%" }));
    expect(params).toEqual(["L1", "%50\\%%", "%50\\%%"]);
  });

  it("金额区间", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ amountMin: 10, amountMax: 500 }));
    expect(sql).toContain("t.amount >= ?");
    expect(sql).toContain("t.amount <= ?");
    expect(params).toEqual(["L1", 10, 500]);
  });

  it("金额下界为 0 时仍然生效（0 是有效下界，不能被当成没给）", () => {
    const { sql, params } = buildWhere("L1", makeFilter({ amountMin: 0 }));
    expect(sql).toContain("t.amount >= ?");
    expect(params).toEqual(["L1", 0]);
  });

  it("子句按固定顺序拼接：每个条件的占位符与它自己的值一一绑定", () => {
    // 占位符是按出现顺序绑定的：子句顺序与 push 顺序一旦错位，SQL 依然合法、
    // 查询依然返回结果，但每个条件都绑到了别人的值上——静默错。
    // 这里只用**各条件的稳定前缀**定位（有意不写死区间的开闭、金额段的完整文本），
    // 让它只对「顺序」负责：区间开闭、0 下界、片段来源各自有专门的用例钉住。
    const { sql, params } = buildWhere("L1", makeFilter({
      type: "expense",
      range: { from: "2026-01-01", to: "2026-01-31", startIso: "S", endIso: "E" },
      accountId: "A1",
      categoryIds: ["c1"],
      tagIds: ["t1"],
      memberIds: ["u1"],
      merchant: "盒马",
      amountMin: 10,
      amountMax: 100,
    }));
    const positions = [
      "t.ledger_id = ?",
      "t.is_deleted = 0",
      "t.type = ?",
      "t.occurred_at >=",
      "(t.from_account_id = ? OR t.to_account_id = ?)",
      "t.category_id IN (?)",
      "t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id = ?)",
      "t.user_id IN (?)",
      "t.note LIKE ?",
      "t.amount >=",
      "t.amount <=",
    ].map((marker) => sql.indexOf(marker));
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // ⚠️ 上面只钉了 **SQL 里子句的顺序**，那**不足以**证明绑定正确（审查 M-2）：
    // 把某一次 `params.push` 挪到函数末尾，SQL 字符串一字不变、上面全绿，
    // 而实际绑定整体错位——SQLite 对此**不报错**（少传的参数当 NULL，静默 0 行）。
    // 审查者执行级复现：故意错位后 `matched=0` 而非 1，SQL 照样执行成功、无任何提示。
    // 所以必须**显式断言 params 数组本身**（顺序与值都要）。
    // 期望值推导：按上面 positions 的顺序数出每个子句有几个 `?`——
    // 账户条件是 2 个 `?`（同一个 accountId 出现 2 次）；共用片段 noteOrTagLikeClause
    // 自带 **2** 个占位符（备注 + 标签名），所以同一个 merchant 模式也要出现 2 次。
    expect(params).toEqual([
      "L1", "expense", "S", "E",
      "A1", "A1",
      "c1", "t1", "u1",
      "%盒马%", "%盒马%",
      10, 100,
    ]);
  });
});

describe("buildSummarySql", () => {
  it("一次查询取回三个桶与总笔数", () => {
    const { sql } = buildSummarySql("L1", makeFilter());
    expect(sql).toContain("FROM transactions t");
    expect(sql).toContain("t.type='expense'");
    expect(sql).toContain("t.type='income'");
    expect(sql).toContain("t.type='transfer'");
    expect(sql).toContain("COUNT(*) AS matched");
    // 桶与列必须配对：只断言三个类型字面量"存在"的话，把 transfer 的 CASE 抄进
    // expense_total 列（或把两个别名互换）依然全绿——而那正是"转账被算进支出"。
    expect(sql).toMatch(/CASE WHEN t\.type='expense'\s+THEN t\.amount END\), 0\) AS expense_total/);
    expect(sql).toMatch(/CASE WHEN t\.type='expense'\s+THEN 1 END\), 0\)\s+AS expense_count/);
    expect(sql).toMatch(/CASE WHEN t\.type='income'\s+THEN t\.amount END\), 0\) AS income_total/);
    expect(sql).toMatch(/CASE WHEN t\.type='income'\s+THEN 1 END\), 0\)\s+AS income_count/);
    expect(sql).toMatch(/CASE WHEN t\.type='transfer' THEN t\.amount END\), 0\) AS transfer_total/);
    expect(sql).toMatch(/CASE WHEN t\.type='transfer' THEN 1 END\), 0\)\s+AS transfer_count/);
  });

  it("汇总沿用 WHERE 的参数（含转账，即 type 缺省时不加类型条件）", () => {
    const { sql, params } = buildSummarySql("L1", makeFilter({ amountMin: 10 }));
    expect(params).toEqual(["L1", 10]);
    expect(sql).not.toContain("t.type =");
  });
});

describe("shapeSummary", () => {
  const row = {
    expense_total: 1234.565,
    expense_count: 12,
    income_total: 5000,
    income_count: 3,
    transfer_total: 200,
    transfer_count: 1,
    matched: 16,
  };

  it("type 缺省：收入与支出都有值，转账为 null，net = income - expense", () => {
    const s = shapeSummary(row, null);
    expect(s.expense).toEqual({ total: 1234.57, count: 12, avg: 102.88 });
    expect(s.income).toEqual({ total: 5000, count: 3, avg: 1666.67 });
    expect(s.transfer).toBeNull();
    expect(s.net).toBe(3765.43);
    expect(s.matched).toBe(16);
  });

  it("type=expense：只给支出桶，其余为 null 而不是 0", () => {
    // 给 0 会让模型把「没查」答成「没有」，说出"你本月收入 0 元"这种错误结论
    const s = shapeSummary(row, "expense");
    expect(s.expense).toEqual({ total: 1234.57, count: 12, avg: 102.88 });
    expect(s.income).toBeNull();
    expect(s.transfer).toBeNull();
    expect(s.net).toBeNull();
  });

  it("type=income：只给收入桶", () => {
    const s = shapeSummary(row, "income");
    expect(s.income).toEqual({ total: 5000, count: 3, avg: 1666.67 });
    expect(s.expense).toBeNull();
    expect(s.transfer).toBeNull();
    expect(s.net).toBeNull();
  });

  it("type=transfer：只给转账桶", () => {
    const s = shapeSummary(row, "transfer");
    expect(s.transfer).toEqual({ total: 200, count: 1, avg: 200 });
    expect(s.expense).toBeNull();
    expect(s.income).toBeNull();
    expect(s.net).toBeNull();
  });

  it("无数据时的 row 缺失不炸", () => {
    const s = shapeSummary(undefined, null);
    expect(s.expense).toEqual({ total: 0, count: 0, avg: 0 });
    expect(s.income).toEqual({ total: 0, count: 0, avg: 0 });
    expect(s.net).toBe(0);
    expect(s.matched).toBe(0);
  });

  it("count 为 0 时 avg 是 0，不是 NaN", () => {
    const s = shapeSummary({ ...row, expense_count: 0, expense_total: 0 }, "expense");
    expect(s.expense!.avg).toBe(0);
  });
});
