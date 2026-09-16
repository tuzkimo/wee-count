import { describe, it, expect } from "vitest";
import { amountTierClass, amountWidthEm, pickAmountSizeClass } from "@/utils/amountFit";

describe("amountWidthEm", () => {
  it("按字符类别折算宽度：数字 > ¥ > 负号 > 标点", () => {
    expect(amountWidthEm("0")).toBeCloseTo(0.56, 5);
    expect(amountWidthEm("¥")).toBeCloseTo(0.75, 5);
    expect(amountWidthEm("-")).toBeCloseTo(0.55, 5);
    expect(amountWidthEm(",")).toBeCloseTo(0.3, 5);
    expect(amountWidthEm(".")).toBeCloseTo(0.3, 5);
  });

  it("位数越多越宽，负号更宽", () => {
    expect(amountWidthEm("¥99,999.99")).toBeGreaterThan(amountWidthEm("¥3,000.00"));
    expect(amountWidthEm("-¥3,000.00")).toBeGreaterThan(amountWidthEm("¥3,000.00"));
  });

  it("遮蔽占位符按全角圆点计宽", () => {
    expect(amountWidthEm("¥••••")).toBeCloseTo(0.75 + 4 * 0.86, 5);
  });

  it("空串为 0", () => {
    expect(amountWidthEm("")).toBe(0);
  });
});

describe("amountTierClass", () => {
  it("越大越小，绝不回涨", () => {
    const order = ["text-lg", "text-base", "text-sm", "text-xs", "text-[11px]", "text-[10px]"];
    let prev = -1;
    for (const em of [0, 2, 4, 5.2, 5.5, 6, 6.5, 7, 7.9, 8.2, 8.7, 12, 30]) {
      const idx = order.indexOf(amountTierClass(em));
      expect(idx).toBeGreaterThanOrEqual(prev);
      prev = idx;
    }
  });

  it("两端的边界行为", () => {
    expect(amountTierClass(0)).toBe("text-lg");
    expect(amountTierClass(999)).toBe("text-[10px]");
  });

  it("每一档都可达", () => {
    const reached = new Set([1, 5.5, 6.2, 7.5, 8.5, 9].map(amountTierClass));
    expect(reached).toEqual(
      new Set(["text-lg", "text-base", "text-sm", "text-xs", "text-[11px]", "text-[10px]"])
    );
  });
});

describe("pickAmountSizeClass", () => {
  it("按最长的那一个定档，不逐列各定各的", () => {
    const uniform = pickAmountSizeClass(["¥3,000.00", "-¥1,234.56", "¥1,765.44"]);
    // 长的那个决定整行字号：三列必须一致
    const withHuge = pickAmountSizeClass(["¥3,000.00", "-¥1,234.56", "¥1,234,567.89"]);
    expect(uniform).toBe("text-lg");
    expect(withHuge).not.toBe("text-lg");
  });

  // 回归：本次修的是「大额换行」，不能顺手把常见金额缩小
  it("常见金额维持原字号 18px", () => {
    expect(pickAmountSizeClass(["¥3,000.00", "-¥1,234.56", "¥1,765.44"])).toBe("text-lg");
    expect(pickAmountSizeClass(["¥99,999.99", "¥0.00", "¥99,999.99"])).toBe("text-lg");
    expect(pickAmountSizeClass(["-¥1,234.56"])).toBe("text-lg");
  });

  // 回归：位数变多时逐档缩小，任何量级都排得下单行
  it("大额金额逐档缩小", () => {
    expect(pickAmountSizeClass(["¥999,999.99"])).toBe("text-base");
    expect(pickAmountSizeClass(["-¥999,999.99"])).toBe("text-sm");
    expect(pickAmountSizeClass(["¥9,999,999.99"])).toBe("text-sm");
    expect(pickAmountSizeClass(["¥999,999,999.99"])).toBe("text-xs");
    expect(pickAmountSizeClass(["¥9,999,999,999.99"])).toBe("text-[11px]");
    expect(pickAmountSizeClass(["¥999,999,999,999.99"])).toBe("text-[10px]");
  });

  it("遮蔽占位符本身很窄（¥•••• ≈4.19em），落最大档；组件在遮蔽态另行固定字号", () => {
    expect(pickAmountSizeClass(["¥••••", "¥••••", "¥••••"])).toBe("text-lg");
  });
});
