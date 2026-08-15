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
