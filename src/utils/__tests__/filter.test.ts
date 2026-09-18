import { describe, it, expect } from "vitest";
import { isDefaultCurrentMonth } from "@/utils/filter";

describe("isDefaultCurrentMonth", () => {
  it("无任何筛选时默认当月", () => {
    expect(isDefaultCurrentMonth(false, undefined, {})).toBe(true);
  });

  it("账户详情模式不默认当月", () => {
    expect(isDefaultCurrentMonth(true, "acc-1", {})).toBe(false);
  });

  it("按账户筛选（非账户详情）不默认当月", () => {
    expect(isDefaultCurrentMonth(false, undefined, { account: "acc-1" })).toBe(false);
  });

  it("按分类/标签/成员筛选时不默认当月", () => {
    expect(isDefaultCurrentMonth(false, undefined, { categories: "c1" })).toBe(false);
    expect(isDefaultCurrentMonth(false, undefined, { tags: "t1" })).toBe(false);
    expect(isDefaultCurrentMonth(false, undefined, { members: "m1" })).toBe(false);
  });

  it("指定日期时不算默认当月", () => {
    expect(isDefaultCurrentMonth(false, undefined, { dateFrom: "2026-08-01" })).toBe(false);
    expect(isDefaultCurrentMonth(false, undefined, { dateTo: "2026-08-31" })).toBe(false);
  });
});

describe("isDefaultCurrentMonth 与新增筛选参数", () => {
  it("只带关键词时不再是默认当月", () => {
    expect(isDefaultCurrentMonth(false, null, { note: "盒马" })).toBe(false);
  });

  it("只带金额区间时不再是默认当月", () => {
    expect(isDefaultCurrentMonth(false, null, { amountMin: "10" })).toBe(false);
    expect(isDefaultCurrentMonth(false, null, { amountMax: "500" })).toBe(false);
  });

  it("只带收支类型时不再是默认当月", () => {
    expect(isDefaultCurrentMonth(false, null, { type: "income" })).toBe(false);
  });

  it("完全无参数时仍是默认当月", () => {
    expect(isDefaultCurrentMonth(false, null, {})).toBe(true);
  });

  it("账户详情模式永远不是默认当月", () => {
    expect(isDefaultCurrentMonth(true, "acc-1", {})).toBe(false);
  });
});
