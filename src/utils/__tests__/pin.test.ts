import { describe, it, expect } from "vitest";
import { isWeakPin } from "@/utils/pin";

describe("isWeakPin", () => {
  it("接受普通 6 位数字", () => {
    expect(isWeakPin("194726")).toBe(false);
    expect(isWeakPin("502814")).toBe(false);
  });

  it("拒绝非 6 位数字", () => {
    expect(isWeakPin("12345")).toBe(true);
    expect(isWeakPin("1234567")).toBe(true);
    expect(isWeakPin("12345a")).toBe(true);
    expect(isWeakPin("")).toBe(true);
  });

  it("拒绝全同数字", () => {
    expect(isWeakPin("000000")).toBe(true);
    expect(isWeakPin("888888")).toBe(true);
  });

  it("拒绝连续递增与递减", () => {
    expect(isWeakPin("123456")).toBe(true);
    expect(isWeakPin("654321")).toBe(true);
    expect(isWeakPin("012345")).toBe(true);
  });

  it("接受只重复但不连续的数字", () => {
    expect(isWeakPin("100100")).toBe(false);
    expect(isWeakPin("121212")).toBe(false);
  });
});
