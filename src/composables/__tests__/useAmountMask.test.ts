import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { AMOUNT_PLACEHOLDER, useAmountMask } from "@/composables/useAmountMask";
import { usePrefsStore } from "@/stores/prefs";

describe("useAmountMask", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("占位符不含任何数字", () => {
    expect(AMOUNT_PLACEHOLDER).toMatch(/^•+$/);
    expect(AMOUNT_PLACEHOLDER).not.toMatch(/\d/);
  });

  // 上一条只验字符种类，改成任意长度都绿；这一条钉住长度上限。
  // 宽度预算：`•`（U+2022）在中文字体栈里按 ≈0.86em 全角渲染，故
  // `¥${AMOUNT_PLACEHOLDER}` 宽度 ≈ (`¥` + n × 0.86em)。
  // 最窄的两个容器：流水页三列（360px 视口每列 ≈88px）、报表页总览卡内宽
  // （360px 视口 ≈77px、320px 视口 ≈64px）。4 个点在 text-sm（14px）下 ≈58px，装得下；
  // 6 个点在 text-sm 下 ≈82px（320px 视口只有 ≈64px 可用）、在 text-lg（18px）下 ≈105px
  // （连 88px 的流水列也撑破，整行超宽会让 Android WebView 缩放/位移整页）。
  it("占位符点号数量不超过 4（窄布局宽度预算）", () => {
    expect(AMOUNT_PLACEHOLDER.length).toBeGreaterThan(0);
    expect(AMOUNT_PLACEHOLDER.length).toBeLessThanOrEqual(4);
  });

  it("默认状态下 maskNumber 返回占位符", () => {
    const { maskNumber } = useAmountMask();
    expect(maskNumber(1234.56)).toBe(AMOUNT_PLACEHOLDER);
  });

  it("显示状态下 maskNumber 返回千分位数字，无货币符号", () => {
    usePrefsStore().showAmounts();
    const { maskNumber } = useAmountMask();
    expect(maskNumber(1234.56)).toBe("1,234.56");
    expect(maskNumber(0)).toBe("0.00");
  });

  it("maskNumber 负值不变量：显示态保留负号，遮蔽态仍是纯占位符", () => {
    const { maskNumber } = useAmountMask();
    const masked = maskNumber(-1234.56);
    expect(masked).toBe(AMOUNT_PLACEHOLDER);
    expect(masked).not.toContain("-");

    usePrefsStore().showAmounts();
    expect(maskNumber(-1234.56)).toBe("-1,234.56");
  });

  it("默认状态下 maskCurrency 返回带 ¥ 的占位符", () => {
    const { maskCurrency } = useAmountMask();
    expect(maskCurrency(1234.56)).toBe(`¥${AMOUNT_PLACEHOLDER}`);
  });

  it("遮蔽时负号不泄露：正值与负值返回完全相同的占位符", () => {
    const { maskCurrency } = useAmountMask();
    expect(maskCurrency(-1234.56)).toBe(maskCurrency(1234.56));
    expect(maskCurrency(-1234.56)).toBe(`¥${AMOUNT_PLACEHOLDER}`);
  });

  it("显示状态下 maskCurrency 符号在货币符号外侧", () => {
    usePrefsStore().showAmounts();
    const { maskCurrency } = useAmountMask();
    expect(maskCurrency(1234.56)).toBe("¥1,234.56");
    expect(maskCurrency(-1234.56)).toBe("-¥1,234.56");
    expect(maskCurrency(0)).toBe("¥0.00");
  });

  it("toggle 与 prefs store 双向联动", () => {
    const { toggle, amountsHidden } = useAmountMask();
    const prefs = usePrefsStore();
    expect(amountsHidden.value).toBe(true);
    toggle();
    expect(prefs.amountsHidden).toBe(false);
    expect(amountsHidden.value).toBe(false);
    prefs.hideAmounts();
    expect(amountsHidden.value).toBe(true);
  });
});
