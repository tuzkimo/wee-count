import { describe, it, expect } from "vitest";
import {
  isAmountRefKey,
  maskAmountRefs,
  maskMessageText,
  shouldMaskAmounts,
} from "@/components/ai/amountMask";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";

describe("isAmountRefKey（键空间来自 tools.ts，白名单只认最后一段）", () => {
  it("钱：total / avg / net / amount，包含分桶与分组形态", () => {
    for (const key of [
      "q1.total",
      "q1.avg",
      "q1.net",
      "q1.amount",
      "q1.expense.total",
      "q1.transfer.total",
      "q1.g0.total",
      "q1.g2.avg",
    ]) {
      expect(isAmountRefKey(key)).toBe(true);
    }
  });

  it("不是钱：count / matched / label（遮掉它们只会让回答读不懂）", () => {
    for (const key of ["q1.count", "q1.matched", "q1.expense.count", "q1.g0.label"]) {
      // 杀手：把白名单放宽成 `key.includes("total")` 之类，或改成"所有键都遮" ⇒ 这条红
      expect(isAmountRefKey(key)).toBe(false);
    }
  });

  it("空段与无后缀不误判", () => {
    expect(isAmountRefKey("total")).toBe(true); // 裸键也算（没有前缀就是它自己）
    expect(isAmountRefKey("")).toBe(false);
  });
});

describe("maskAmountRefs", () => {
  it("只换金额键的值，非金额键**原样**（键还在 ⇒ fillRefs 不会因查不到而 warn）", () => {
    const out = maskAmountRefs({ "q1.total": 128.5, "q1.count": 3, "q1.g0.label": "买菜" });
    expect(out).toEqual({ "q1.total": AMOUNT_PLACEHOLDER, "q1.count": 3, "q1.g0.label": "买菜" });
  });

  it("返回新对象，不改进参（回填要能拿到原值）", () => {
    const refs = { "q1.total": 128.5 };
    maskAmountRefs(refs);
    expect(refs["q1.total"]).toBe(128.5);
  });
});

describe("maskMessageText（回填与遮蔽在同一个函数里定序）", () => {
  it("masked ⇒ 金额变占位符、笔数照旧、文字与标点一字不动", () => {
    const text = maskMessageText(
      "上个月买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。",
      { "q1.total": "128.5", "q1.count": "3" },
      true,
    );
    expect(text).toBe(`上个月买菜花了 ${AMOUNT_PLACEHOLDER} 元，一共 3 笔。`);
    // 反向：真值不许出现（否则可能只是"占位符恰好也在"）
    expect(text).not.toContain("128");
  });

  it("不 masked ⇒ 与今天的 fillRefs 完全一致（逐字相等）", () => {
    const content = "上个月买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。";
    const refs = { "q1.total": "128.5", "q1.count": "3" };
    // 杀手：不 masked 时也去遮（少写那个三元）⇒ 这条红
    expect(maskMessageText(content, refs, false)).toBe("上个月买菜花了 128.5 元，一共 3 笔。");
  });

  it("用户消息（没有 refs）不受影响：文字原样", () => {
    expect(maskMessageText("这个月花了多少", {}, true)).toBe("这个月花了多少");
  });

  it("refs 里查不到的键保持占位符原文（与 fillRefs 同一行为，不塞错数字）", () => {
    expect(maskMessageText("花了 {{q9.total}} 元", {}, true)).toBe("花了 {{q9.total}} 元");
  });
});

describe("shouldMaskAmounts（§7.4 乙方案的唯一判定）", () => {
  it("历史消息（不在 revealed 里）⇒ 跟随全局遮罩", () => {
    expect(shouldMaskAmounts(true, false)).toBe(true);
    // 用户手动点开眼睛（全局不遮）⇒ 历史也显示真值（"需要时主动点开"）
    expect(shouldMaskAmounts(false, false)).toBe(false);
  });

  it("本轮问出来的 ⇒ 一律真值（全局遮着也给看）", () => {
    // 杀手：把判定写成只看 `amountsHidden`（不看 revealed）⇒ 这条红
    expect(shouldMaskAmounts(true, true)).toBe(false);
    expect(shouldMaskAmounts(false, true)).toBe(false);
  });
});
