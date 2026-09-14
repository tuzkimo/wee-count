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
