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

/** 取出 (code, path) 对。path 是模型定位"是哪个字段错了"的唯一线索，必须单独钉住——
 * 只断言 code 的话，把 path 写反的变异没有任何用例能抓住。 */
function errs(raw: unknown): { code: string; path: string }[] {
  const r = validateQuery(raw);
  return r.ok ? [] : r.errors.map((e) => ({ code: e.code, path: e.path }));
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
    // 用空对象表达"形状不对"。注意不能再用 {start:...}：加了内层键白名单之后，
    // start 属于"不认识的字段"，那是另一条分支，另有专门用例。
    expect(codes({ date: {}, aggregate: "sum" })).toEqual(["bad_date"]);
  });

  it("date 里的未知键被拒（顶层有白名单，内层同样要有）", () => {
    // 这条用例的存在理由：内层曾有**没有**白名单的版本，`{date:{presett:"thisYear"}}`
    // 会 ok:true 通过校验，直到下游 resolveRange 才报一句泛化的 bad_date，
    // 模型看不出是键拼错了。变异：删掉 date 的内层白名单循环 → 本条变红。
    expect(codes({ date: { presett: "thisYear" }, aggregate: "sum" })).toEqual(["unknown_key"]);
    expect(errs({ date: { presett: "thisYear" }, aggregate: "sum" })[0].path).toBe("date.presett");
    expect(codes({ date: { preset: "thisYear", start: "2026-01-01" }, aggregate: "sum" }))
      .toEqual(["unknown_key"]);
  });

  it("date 同时给 preset 与 from/to 被拒（那是联合类型里互斥的两个分支）", () => {
    // 默默采用 preset 会让返回对象不再满足 AiDateFilter，
    // 「ok:true 蕴含结果符合 AiQuery」这条保证被击穿，而函数末尾的 as 转型正依赖它。
    expect(codes({ date: { preset: "thisYear", from: "2026-01-01" }, aggregate: "sum" }))
      .toEqual(["bad_date"]);
    expect(codes({ date: { preset: "thisYear", to: "2026-01-01" }, aggregate: "sum" }))
      .toEqual(["bad_date"]);
  });

  it("date 只给一边时报错并点明缺的是哪个", () => {
    expect(errs({ date: { from: "2026-03-01" }, aggregate: "sum" }))
      .toEqual([{ code: "bad_date", path: "date.to" }]);
    expect(errs({ date: { to: "2026-03-01" }, aggregate: "sum" }))
      .toEqual([{ code: "bad_date", path: "date.from" }]);
  });

  it("from 格式不对", () => {
    expect(codes({ date: { from: "2026/03/01", to: "2026-04-01" }, aggregate: "sum" }))
      .toEqual(["bad_date"]);
    // 上面这条**抓不住**「删掉 from 的格式校验」：`/`(0x2F) 排在 `-`(0x2D) 之后，from 仍被判为
    // 「晚于 to」，于是从顺序检查那条分支照样报出 bad_date，断言依旧绿（实测过：删掉校验后 22/22 全绿）。
    // 下面这条让 from 在字典序上小于 to：格式校验一旦被删，结果会变成 []（一个错误都没有）。
    expect(codes({ date: { from: "2026-03-1", to: "2026-04-01" }, aggregate: "sum" }))
      .toEqual(["bad_date"]);
  });

  it("to 格式不对", () => {
    // to 侧的格式分支此前完全没有用例（只靠 from 侧覆盖），补上对称的一条
    expect(codes({ date: { from: "2026-03-01", to: "2026-4-1" }, aggregate: "sum" }))
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

  it("account 不是非空字符串", () => {
    // account 是标量（单个账户名），不能用 bad_string_array——那是「该给数组」的意思
    expect(codes({ account: "  ", aggregate: "sum" })).toEqual(["bad_account"]);
    expect(codes({ account: "招行", aggregate: "sum" })).toEqual([]);
  });

  it("amount 为负或非有限数", () => {
    expect(codes({ amount: { min: -1 }, aggregate: "sum" })).toEqual(["bad_amount"]);
    expect(codes({ amount: { max: Number.POSITIVE_INFINITY }, aggregate: "sum" }))
      .toEqual(["bad_amount"]);
  });

  it("amount.min 大于 max", () => {
    expect(codes({ amount: { min: 500, max: 10 }, aggregate: "sum" })).toEqual(["bad_amount"]);
  });

  it("amount 里的未知键被拒（放行 = 静默丢掉整个金额过滤）", () => {
    // 这是全函数里后果最严重的一条：`{amount:{minn:500}}` 若 ok:true，金额条件被静默丢弃，
    // 模型得不到任何错误线索，用户拿到一个看起来正常、其实没按金额筛选的答案。
    // 变异：删掉 amount 的内层白名单循环 → 本条变红（且三条断言全红）。
    expect(codes({ amount: { minn: 500 }, aggregate: "sum" })).toEqual(["unknown_key"]);
    expect(errs({ amount: { minn: 500 }, aggregate: "sum" })[0].path).toBe("amount.minn");
    expect(codes({ amount: { min: 1, bogus: 2 }, aggregate: "sum" })).toEqual(["unknown_key"]);
  });

  it("tags / members 的键名同样受同样的校验（此前只测了 categories）", () => {
    for (const key of ["tags", "members"] as const) {
      expect(codes({ [key]: "工作", aggregate: "sum" })).toEqual(["bad_string_array"]);
      expect(codes({ [key]: [1], aggregate: "sum" })).toEqual(["bad_string_array"]);
      expect(codes({ [key]: ["  "], aggregate: "sum" })).toEqual(["bad_string_array"]);
      expect(codes({ [key]: ["工作"], aggregate: "sum" })).toEqual([]);
    }
  });

  it("categories 为空数组算「不过滤」，不是「匹配空集」", () => {
    // 契约：空数组 = 不加条件。与下游一致（buildWhere 判 `f.categories?.length`、
    // fetchAll 判 `categoryIds.length > 0`），所以校验层放行而不是报错。
    expect(codes({ categories: [], aggregate: "sum" })).toEqual([]);
  });

  it("date / amount 不是对象时报错", () => {
    expect(codes({ date: "2026", aggregate: "sum" })).toEqual(["bad_date"]);
    expect(codes({ amount: 100, aggregate: "sum" })).toEqual(["bad_amount"]);
  });

  it("path 指向出错的字段（模型靠它定位，不能写反）", () => {
    // 只断言 code 的话，把 path 写反的变异没有任何用例能抓住
    expect(errs({ aggregate: "支出" })[0].path).toBe("aggregate");
    expect(errs({ type: "支出", aggregate: "sum" })[0].path).toBe("type");
    expect(errs({ categories: [1], aggregate: "sum" })[0].path).toBe("categories");
    expect(errs({ merchant: "  ", aggregate: "sum" })[0].path).toBe("merchant");
    expect(errs({ account: "  ", aggregate: "sum" })[0].path).toBe("account");
    expect(errs({ amount: { min: -1 }, aggregate: "sum" })[0].path).toBe("amount.min");
    expect(errs({ date: { from: "2026-4-1", to: "2026-05-01" }, aggregate: "sum" })[0].path)
      .toBe("date.from");
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
