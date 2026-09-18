import { describe, it, expect } from "vitest";
import { isDefaultCurrentMonth, parseAmountParam, parseTransactionType } from "@/utils/filter";

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

  it("新增筛选参数是空串时按「没给」处理，仍算无参数（默认当月）", () => {
    // 本条原先是 `(false, null, {})`，与文件开头第 5 行的既有用例**行为等价**（home 模式下
    // accountId 根本不参与判定，审查实测把该实参做成可观测后仍 0 red）→ 属空转，故改造。
    // 现在它钉的是：空串必须按「没给」处理。用 `!== undefined` 判存在性的实现会把空串当成
    // 「有筛选」→ 这条会红（既有用例一条都抓不到这个写法）。
    expect(
      isDefaultCurrentMonth(false, null, { note: "", amountMin: "", amountMax: "", type: "" }),
    ).toBe(true);
    // 反向半边：`amountMin = "0"` 是**有效下界**，不是「没给」→ 不再算默认当月。
    // 它同时挡住「用 Number() 的真值判断当存在性」的写法（Number("0") === 0 为假）。
    expect(isDefaultCurrentMonth(false, null, { amountMin: "0" })).toBe(false);
  });
});

describe("parseAmountParam", () => {
  it("合法数字转成 number，0 是有效下界（不是「没给」）", () => {
    expect(parseAmountParam("10")).toBe(10);
    expect(parseAmountParam("0")).toBe(0);
    expect(parseAmountParam("12.5")).toBe(12.5);
  });

  it("空串 / undefined 表示「没给」，不能变成下界 0", () => {
    // Number("") === 0：直接 Number() 会把「没给」变成「金额 >= 0 的筛选」。
    expect(parseAmountParam("")).toBeUndefined();
    expect(parseAmountParam(undefined)).toBeUndefined();
  });

  it("非数字与溢出值一律拒绝，而不是放行成 NaN / Infinity", () => {
    // 放行的后果是**静默 0 行**：SQLite 把 NaN 绑成 NULL（`amount >= NULL` 恒为 NULL），
    // Infinity 让 `>= Inf` 永远不成立、`<= Inf` 匹配全表；Tauri 的 JSON IPC 又把 NaN
    // 序列化成 "null"，两条路都落成 NULL。三者都不报错，所以只能在入口用 Number.isFinite 拒掉。
    expect(parseAmountParam("abc")).toBeUndefined();
    expect(parseAmountParam("1e999")).toBeUndefined();
    expect(parseAmountParam("Infinity")).toBeUndefined();
    expect(parseAmountParam("NaN")).toBeUndefined();
  });
});

describe("parseTransactionType", () => {
  it("三个合法类型都透传，含 transfer", () => {
    expect(parseTransactionType("expense")).toBe("expense");
    expect(parseTransactionType("income")).toBe("income");
    // transfer 是用户能选的合法类型（M1 的「转账」芯片就会用到）：白名单漏掉它，
    // 转账筛选会静默变成「不过滤」，而 URL 是用户可改的。
    expect(parseTransactionType("transfer")).toBe("transfer");
  });

  it("非法类型与空值返回 undefined", () => {
    expect(parseTransactionType("乱七八糟")).toBeUndefined();
    expect(parseTransactionType("")).toBeUndefined();
    expect(parseTransactionType(undefined)).toBeUndefined();
  });
});
