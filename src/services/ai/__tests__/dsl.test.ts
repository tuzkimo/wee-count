import { describe, it, expect } from "vitest";
import { PRESETS } from "@/utils/dateRange";
import {
  validateQuery,
  PRESET_KEYS,
  AI_QUERY_MAX_ITEMS,
  AI_QUERY_MAX_LIMIT,
} from "@/services/ai/dsl";

/** 取出错误码列表，便于断言 */
function codes(raw: unknown): string[] {
  const r = validateQuery(raw);
  return r.ok ? [] : r.errors.map((e) => e.code);
}

describe("PRESET_KEYS", () => {
  it("与 dateRange.PRESETS 的键集合完全一致（防止两边漂移）", () => {
    expect([...PRESET_KEYS].sort()).toEqual(PRESETS.map((p) => p.key).sort());
  });
});

describe("validateQuery 常量", () => {
  it("明细上限 20、分组上限 50", () => {
    expect(AI_QUERY_MAX_ITEMS).toBe(20);
    expect(AI_QUERY_MAX_LIMIT).toBe(50);
  });
});

describe("validateQuery 合法输入", () => {
  it("最小合法输入：只有 aggregate", () => {
    const r = validateQuery({ aggregate: "sum" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.aggregate).toBe("sum");
  });

  it("所有字段都给时原样透传", () => {
    const input = {
      date: { preset: "thisYear" },
      type: "expense",
      categories: ["买菜"],
      account: "招行",
      tags: ["生鲜"],
      members: ["老婆"],
      merchant: "盒马",
      amount: { min: 10, max: 500 },
      aggregate: "sum",
      groupBy: "category",
      orderBy: "value_desc",
      limit: 5,
    };
    const r = validateQuery(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query).toEqual(input);
  });

  it("自定义日期区间", () => {
    const r = validateQuery({
      date: { from: "2026-03-01", to: "2026-04-01" },
      aggregate: "list",
    });
    expect(r.ok).toBe(true);
  });

  it("12 个 preset 全都合法", () => {
    for (const preset of PRESET_KEYS) {
      const r = validateQuery({ date: { preset }, aggregate: "count" });
      expect(r.ok, `preset=${preset} 应当合法`).toBe(true);
    }
  });
});

describe("validateQuery 非法输入", () => {
  it("不是对象", () => {
    expect(codes("今年花了多少")).toEqual(["not_an_object"]);
    expect(codes(null)).toEqual(["not_an_object"]);
    expect(codes([])).toEqual(["not_an_object"]);
  });

  it("缺少 aggregate", () => {
    expect(codes({})).toEqual(["missing_aggregate"]);
  });

  it("aggregate 是中文（模型最常见的幻觉）", () => {
    expect(codes({ aggregate: "总数" })).toEqual(["bad_aggregate"]);
  });

  it("不认识的字段", () => {
    expect(codes({ aggregate: "sum", category: "买菜" })).toEqual(["unknown_key"]);
  });

  it("preset 拼错", () => {
    expect(codes({ date: { preset: "thisYears" }, aggregate: "sum" })).toEqual(["bad_date_preset"]);
  });

  it("date 既不是 preset 也不是 from/to", () => {
    expect(codes({ date: { start: "2026-01-01" }, aggregate: "sum" })).toEqual(["bad_date"]);
  });

  it("from 格式不对", () => {
    expect(codes({ date: { from: "2026/03/01", to: "2026-04-01" }, aggregate: "sum" }))
      .toEqual(["bad_date"]);
  });

  it("from 晚于 to", () => {
    expect(codes({ date: { from: "2026-04-01", to: "2026-03-01" }, aggregate: "sum" }))
      .toEqual(["bad_date"]);
  });

  it("type 不认识", () => {
    expect(codes({ type: "支出", aggregate: "sum" })).toEqual(["bad_type"]);
  });

  it("categories 不是字符串数组", () => {
    expect(codes({ categories: "买菜", aggregate: "sum" })).toEqual(["bad_string_array"]);
    expect(codes({ categories: [1, 2], aggregate: "sum" })).toEqual(["bad_string_array"]);
    expect(codes({ categories: ["买菜", ""], aggregate: "sum" })).toEqual(["bad_string_array"]);
  });

  it("merchant 是空串", () => {
    expect(codes({ merchant: "  ", aggregate: "sum" })).toEqual(["bad_merchant"]);
  });

  it("amount 为负或非有限数", () => {
    expect(codes({ amount: { min: -1 }, aggregate: "sum" })).toEqual(["bad_amount"]);
    expect(codes({ amount: { max: Number.POSITIVE_INFINITY }, aggregate: "sum" }))
      .toEqual(["bad_amount"]);
  });

  it("amount.min 大于 max", () => {
    expect(codes({ amount: { min: 500, max: 10 }, aggregate: "sum" })).toEqual(["bad_amount"]);
  });

  it("limit 不是正整数", () => {
    expect(codes({ aggregate: "sum", limit: 0 })).toEqual(["bad_limit"]);
    expect(codes({ aggregate: "sum", limit: 2.5 })).toEqual(["bad_limit"]);
    expect(codes({ aggregate: "sum", limit: "5" })).toEqual(["bad_limit"]);
  });

  it("groupBy / orderBy 不认识", () => {
    expect(codes({ aggregate: "sum", groupBy: "商户" })).toEqual(["bad_group_by"]);
    expect(codes({ aggregate: "sum", orderBy: "asc" })).toEqual(["bad_order_by"]);
  });

  it("多个错误一次性全部返回，而不是只报第一个", () => {
    // 一次全给，模型才有机会一次改对；只报第一个会让它来回好几轮
    expect(codes({ type: "支出", limit: -1 }).sort()).toEqual(["bad_limit", "bad_type", "missing_aggregate"].sort());
  });
});
