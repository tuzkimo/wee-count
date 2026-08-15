import { describe, it, expect } from "vitest";
import { evaluateExpression } from "@/utils/expression";

describe("evaluateExpression", () => {
  it("空/结尾运算符返回 null", () => {
    expect(evaluateExpression("")).toBeNull();
    expect(evaluateExpression("1+")).toBeNull();
    expect(evaluateExpression("1.")).toBeNull();
  });
  it("非法字符返回 null", () => {
    expect(evaluateExpression("1;alert(1)")).toBeNull();
    expect(evaluateExpression("abc")).toBeNull();
  });
  it("非正数返回 null", () => {
    expect(evaluateExpression("0")).toBeNull();
    expect(evaluateExpression("-5")).toBeNull();
  });
  it("加减运算", () => {
    expect(evaluateExpression("1+2")).toBe(3);
    expect(evaluateExpression("10.5-0.5")).toBe(10);
  });
  it("结果四舍五入到两位", () => {
    expect(evaluateExpression("1.234")).toBe(1.23);
    expect(evaluateExpression("1.236")).toBe(1.24);
  });
  it("乘法", () => {
    expect(evaluateExpression("3*4")).toBe(12);
  });
  it("括号", () => {
    expect(evaluateExpression("(1+2)*3")).toBe(9);
  });
  it("除法", () => {
    expect(evaluateExpression("10/4")).toBe(2.5);
  });
  it("除零返回 null", () => {
    expect(evaluateExpression("1/0")).toBeNull();
  });
  it("禁止函数调用", () => {
    expect(evaluateExpression("1+constructor")).toBeNull();
  });
});
