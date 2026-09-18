import { describe, it, expect } from "vitest";
import { appliedToQuery } from "@/services/ai/filterQuery";
import type { AppliedFilter } from "@/services/ai/resolve";

function makeApplied(over: Partial<AppliedFilter> = {}): AppliedFilter {
  return {
    dateFrom: null, dateTo: null, type: null,
    categories: [], account: null, tags: [], members: [],
    merchant: null, amountMin: null, amountMax: null,
    ...over,
  };
}

describe("appliedToQuery", () => {
  it("空条件返回空 query", () => {
    // 零条件的芯片不该出现：DSL 没给 date 时 runQuery 会派生一个真实区间填进 applied，
    // 所以「真的什么都没有」只可能是账本一笔记录都没有，那时也没有可下钻的内容
    expect(appliedToQuery(makeApplied())).toEqual({});
  });

  it("日期范围映射为 dateFrom / dateTo 的 YYYY-MM-DD", () => {
    const q = appliedToQuery(makeApplied({ dateFrom: "2026-01-01", dateTo: "2026-12-31" }));
    expect(q.dateFrom).toBe("2026-01-01");
    expect(q.dateTo).toBe("2026-12-31");
  });

  it("分类、标签、成员用逗号连接 id", () => {
    const q = appliedToQuery(makeApplied({
      categories: [{ id: "c1", name: "买菜" }, { id: "c2", name: "餐饮" }],
      tags: [{ id: "t1", name: "生鲜" }],
      members: [{ id: "u1", name: "老婆" }],
    }));
    expect(q.categories).toBe("c1,c2");
    expect(q.tags).toBe("t1");
    expect(q.members).toBe("u1");
  });

  it("账户用单数 account 参数（流水页的账户筛选是单选）", () => {
    const q = appliedToQuery(makeApplied({ account: { id: "a1", name: "招行" } }));
    expect(q.account).toBe("a1");
    expect(q.accounts).toBeUndefined();
  });

  it("关键词映射为 note", () => {
    expect(appliedToQuery(makeApplied({ merchant: "盒马" })).note).toBe("盒马");
  });

  it("金额区间映射为字符串，0 也要保留", () => {
    const q = appliedToQuery(makeApplied({ amountMin: 0, amountMax: 500 }));
    expect(q.amountMin).toBe("0");
    expect(q.amountMax).toBe("500");
  });

  it("type 直接映射", () => {
    expect(appliedToQuery(makeApplied({ type: "income" })).type).toBe("income");
  });

  it("type=transfer 不被丢弃（转账是用户能选的合法类型）", () => {
    // 修前实测：把 `if (applied.type)` 改成 `!== "transfer"`（丢弃 transfer）→ 36/36 全绿。
    // transfer 在 M1 会被「转账」芯片产出，丢弃它等于那一跳变成「不按类型过滤」，
    // 而两侧都不会报错——与 ledger R45 同类的静默错数据。
    expect(appliedToQuery(makeApplied({ type: "transfer" })).type).toBe("transfer");
  });

  it("带别的条件时不带日期：首页对「有其它筛选」的既有行为就是不限时间", () => {
    const q = appliedToQuery(makeApplied({ merchant: "盒马" }));
    expect(q.note).toBe("盒马");
    expect(q.dateFrom).toBeUndefined();
    expect(q.dateTo).toBeUndefined();
  });

  it("全部条件齐全时产出完整且无空串参数的对象", () => {
    const q = appliedToQuery(makeApplied({
      dateFrom: "2026-01-01", dateTo: "2026-06-30", type: "expense",
      categories: [{ id: "c1", name: "买菜" }],
      account: { id: "a1", name: "招行" },
      tags: [{ id: "t1", name: "生鲜" }],
      members: [{ id: "u1", name: "老婆" }],
      merchant: "盒马", amountMin: 10, amountMax: 500,
    }));
    // 显式断言期望对象，而不是 `Object.values(q).every(v => v !== "")`：
    // 后者在**空对象上恒真**（修前实测：`return {}` 变异下这条仍绿），
    // 即它对「参数被整个丢光」零检测力，只能检测「写出了空串」。
    expect(q).toEqual({
      dateFrom: "2026-01-01", dateTo: "2026-06-30", type: "expense",
      account: "a1", categories: "c1", tags: "t1", members: "u1",
      note: "盒马", amountMin: "10", amountMax: "500",
    });
  });

  it("amountMax 为 0 也要保留（0 是有效上界，不是「没给」）", () => {
    // 与上面 amountMin: 0 同一条道理，但**上面那条抓不住这一侧**：它的 amountMax 是 500（真值），
    // 把 `amountMax !== null` 写成真值判断它照样绿。0 是合法金额，写成真值判断会让
    // 「最多 0 元」这类筛选静默消失，而它正是本模块要防的那类不一致。
    expect(appliedToQuery(makeApplied({ amountMax: 0 })).amountMax).toBe("0");
    // 两侧都是 0 时也必须两个都在
    const q = appliedToQuery(makeApplied({ amountMin: 0, amountMax: 0 }));
    expect(q.amountMin).toBe("0");
    expect(q.amountMax).toBe("0");
  });

  it("空数组不产生参数，而不是产生空串参数", () => {
    // 上一条用例里所有数组都非空，**抓不住**「无条件 join、空数组写出 ""」这个变异。
    // 这一条把「数组为空」这一侧钉住：空数组的契约是「不加条件」，连参数都不该出现——
    // 写出 categories="" 会让下游 `qCategories ? split : undefined` 之类的判断
    // 时而真时而假，是"同一筛选、两种解释"的来源。
    const q = appliedToQuery(makeApplied({ dateFrom: "2026-01-01", dateTo: "2026-12-31" }));
    // 同样改成显式期望对象：`Object.values(q).every(v => v !== "")` 在空对象上恒真，
    // 而 `toBeUndefined` 三条全是「缺失型」断言，`return {}` 变异下**全都绿**（修前实测）。
    expect(q).toEqual({ dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    expect(q.categories).toBeUndefined();
    expect(q.tags).toBeUndefined();
    expect(q.members).toBeUndefined();
  });
});
