import { describe, it, expect } from "vitest";
import { resolveFilter, type LookupContext, type ResolveError } from "@/services/ai/resolve";

const ctx: LookupContext = {
  categories: [
    { id: "c-food", name: "买菜", type: "expense" },
    { id: "c-dining", name: "餐饮", type: "expense" },
    { id: "c-other-e", name: "其他", type: "expense" },
    { id: "c-other-i", name: "其他", type: "income" },
    { id: "c-salary", name: "工资", type: "income" },
  ],
  accounts: [
    { id: "a-cmb", name: "招行储蓄卡" },
    { id: "a-cmb-cc", name: "招行信用卡" },
    { id: "a-cash", name: "现金" },
  ],
  tags: [
    { id: "t-fresh", name: "生鲜" },
    { id: "t-hm", name: "盒马" },
  ],
  members: [
    { id: "u-me", name: "我" },
    { id: "u-wife", name: "老婆" },
  ],
};

function errs(r: ReturnType<typeof resolveFilter>): ResolveError[] {
  return r.ok ? [] : r.errors;
}

describe("resolveFilter 精确匹配", () => {
  it("分类名精确命中", () => {
    const r = resolveFilter({ categories: ["买菜"] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.categoryIds).toEqual(["c-food"]);
      expect(r.applied.categories).toEqual([{ id: "c-food", name: "买菜" }]);
    }
  });

  it("多个字段一起解析", () => {
    const r = resolveFilter(
      { categories: ["买菜"], account: "现金", tags: ["生鲜"], members: ["老婆"] },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.categoryIds).toEqual(["c-food"]);
      expect(r.resolved.accountId).toBe("a-cash");
      expect(r.resolved.tagIds).toEqual(["t-fresh"]);
      expect(r.resolved.memberIds).toEqual(["u-wife"]);
    }
  });

  it("未给的条件解析为 null，不是空数组", () => {
    const r = resolveFilter({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.categoryIds).toBeNull();
      expect(r.resolved.tagIds).toBeNull();
      expect(r.resolved.merchant).toBeNull();
      expect(r.resolved.amountMin).toBeNull();
      expect(r.resolved.range).toBeNull();
    }
  });

  it("空数组等同于没给条件", () => {
    const r = resolveFilter({ categories: [] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.categoryIds).toBeNull();
  });
});

describe("resolveFilter 名字去空白", () => {
  // 契约（计划「交接给任务 4 的契约」）：validateQuery 只拒绝"整项都是空白"的数组元素，
  // " 买菜 " 这种首尾带空白的会原样放行。resolveFilter 必须在匹配前 trim，
  // 否则模型少给一个空格就变成"分类不存在"，把拼写问题伪装成 not_found 让模型去反问用户。
  it("数组元素与标量名字的首尾空白都会被 trim 后再匹配", () => {
    const r = resolveFilter(
      { categories: ["  买菜  "], tags: [" 盒马 "], members: ["我 "], account: "  现金  " },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.categoryIds).toEqual(["c-food"]);
      expect(r.resolved.tagIds).toEqual(["t-hm"]);
      expect(r.resolved.memberIds).toEqual(["u-me"]);
      expect(r.resolved.accountId).toBe("a-cash");
    }
  });

  it("not_found 报出的是 trim 后的名字，不是原始带空白的串", () => {
    const r = resolveFilter({ account: "  工行  " }, ctx);
    expect(r.ok).toBe(false);
    expect(errs(r)[0].value).toBe("工行");
  });

  it("trim 是「反方向包含」能生效的前提：带空白的「招行」仍要判歧义", () => {
    // 这条用例是 trim 的**唯一判别点**，别删。「  买菜  」那种去掉 trim 照样能被
    // 双向包含兜住（"  买菜  ".includes("买菜") 为真），抓不到 trim 缺失；
    // 而「  招行  」两边都不包含对方，只有先 trim 成「招行」才能靠
    // "招行储蓄卡".includes("招行") 命中两张卡。trim 一去掉，这里就从
    // ambiguous 退化成 not_found——把"该反问用户选哪张卡"伪装成"没听过这个账户"。
    const r = resolveFilter({ account: "  招行  " }, ctx);
    expect(r.ok).toBe(false);
    expect(errs(r)).toEqual([
      {
        kind: "ambiguous",
        field: "accounts",
        value: "招行",
        candidates: ["招行储蓄卡", "招行信用卡"],
      },
    ]);
  });
});

describe("resolveFilter 包含匹配", () => {
  it("「招行」包含命中两张卡 → 歧义，不猜", () => {
    const r = resolveFilter({ account: "招行" }, ctx);
    expect(r.ok).toBe(false);
    expect(errs(r)).toEqual([
      {
        kind: "ambiguous",
        field: "accounts",
        value: "招行",
        candidates: ["招行储蓄卡", "招行信用卡"],
      },
    ]);
  });

  it("「信用卡」只命中一张 → 直接解析", () => {
    const r = resolveFilter({ account: "信用卡" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.accountId).toBe("a-cmb-cc");
  });

  it("「盒马」精确命中标签", () => {
    const r = resolveFilter({ tags: ["盒马"] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.tagIds).toEqual(["t-hm"]);
  });

  it("反方向包含也算命中：模型给的名字带后缀，库里是简称", () => {
    const r = resolveFilter({ account: "现金账户" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.accountId).toBe("a-cash");
  });

  it("双向包含是启发式，不做语义理解：过长的名字会误命中简称", () => {
    // 「招商银行现金卡」会被「现金」命中。这是刻意接受的代价——本地解析不猜语义，
    // 想更严格就得让模型先反问用户，那是更差的体验。写下来免得后来人当成 bug 去"修"。
    const r = resolveFilter({ account: "招商银行现金卡" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.accountId).toBe("a-cash");
  });
});

describe("resolveFilter 未命中", () => {
  it("完全没听过名字 → not_found，并给出候选", () => {
    const r = resolveFilter({ account: "工行" }, ctx);
    expect(r.ok).toBe(false);
    const [e] = errs(r);
    expect(e.kind).toBe("not_found");
    expect(e.field).toBe("accounts");
    expect(e.value).toBe("工行");
    expect(e.candidates).toEqual(["招行储蓄卡", "招行信用卡", "现金"]);
  });

  it("候选最多 5 个", () => {
    const many: LookupContext = {
      ...ctx,
      tags: Array.from({ length: 9 }, (_, i) => ({ id: `t${i}`, name: `标签${i}` })),
    };
    const r = resolveFilter({ tags: ["不存在"] }, many);
    expect(errs(r)[0].candidates).toHaveLength(5);
  });
});

describe("resolveFilter 分类按 type 消歧", () => {
  it("type=expense 时「其他」唯一命中支出分类", () => {
    const r = resolveFilter({ type: "expense", categories: ["其他"] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.categoryIds).toEqual(["c-other-e"]);
  });

  it("type=income 时「其他」唯一命中收入分类", () => {
    const r = resolveFilter({ type: "income", categories: ["其他"] }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved.categoryIds).toEqual(["c-other-i"]);
  });

  it("type 缺省时「其他」命中两个 → 歧义", () => {
    const r = resolveFilter({ categories: ["其他"] }, ctx);
    expect(r.ok).toBe(false);
    expect(errs(r)[0].kind).toBe("ambiguous");
    expect(errs(r)[0].candidates).toEqual(["其他", "其他"]);
  });

  it("type=expense 时收入分类「工资」查不到 → not_found", () => {
    const r = resolveFilter({ type: "expense", categories: ["工资"] }, ctx);
    expect(r.ok).toBe(false);
    expect(errs(r)[0].kind).toBe("not_found");
  });
});

describe("resolveFilter 其他字段", () => {
  it("merchant 去空白后保留，空串变 null", () => {
    const a = resolveFilter({ merchant: "  盒马  " }, ctx);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.resolved.merchant).toBe("盒马");

    const b = resolveFilter({ merchant: "   " }, ctx);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.resolved.merchant).toBeNull();
  });

  it("amount 的 min/max 分别落到扁平的 amountMin/amountMax", () => {
    const r = resolveFilter({ amount: { min: 10, max: 500 } }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.amountMin).toBe(10);
      expect(r.resolved.amountMax).toBe(500);
    }
  });

  it("range 一并解析出来，applied 里带 dateFrom/dateTo", () => {
    const r = resolveFilter({ date: { preset: "thisYear" } }, ctx, new Date(2026, 5, 15));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.range!.from).toBe("2026-01-01");
      expect(r.applied.dateFrom).toBe("2026-01-01");
      expect(r.applied.dateTo).toBe("2026-12-31");
    }
  });

  it("多个字段同时失败时错误全部返回", () => {
    const r = resolveFilter({ account: "工行", tags: ["没有这个标签"] }, ctx);
    expect(r.ok).toBe(false);
    expect(errs(r).map((e) => e.field).sort()).toEqual(["accounts", "tags"]);
  });
});
