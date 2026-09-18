import { describe, it, expect } from "vitest";
import {
  buildGroupsSql, buildItemsSql, clampLimit, shapeGroups, shapeItems,
  type ItemRow,
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
    expect(sql).toContain("COALESCE(gtg.name, '未打标签')");
  });

  it("month 分组按时区偏移归桶", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "month" }), makeFilter());
    expect(sql).toMatch(/strftime\('%Y-%m', t\.occurred_at, '[+-]\d+ minutes'\)/);
  });

  it("day 分组按时区偏移归桶", () => {
    const { sql } = buildGroupsSql("L1", makeQuery({ groupBy: "day" }), makeFilter());
    expect(sql).toMatch(/date\(t\.occurred_at, '[+-]\d+ minutes'\)/);
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
});
