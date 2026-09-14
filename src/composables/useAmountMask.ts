// src/composables/useAmountMask.ts
import { storeToRefs } from "pinia";
import { usePrefsStore } from "@/stores/prefs";

/** 遮蔽占位符的唯一来源。6 个 U+2022 BULLET，不含任何数字。 */
export const AMOUNT_PLACEHOLDER = "••••••";

const NUMBER_FORMAT: Intl.NumberFormatOptions = {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
};

/**
 * 金额遮蔽原语。
 *
 * 两个入口都接收 number 而不是格式化后的字符串：遮蔽判定发生在取绝对值与加符号
 * **之前**。否则 `-¥••••••` 会暴露「结余为负」这个信息，用字符串原语做不到。
 */
export function useAmountMask() {
  const prefs = usePrefsStore();
  const { amountsHidden } = storeToRefs(prefs);

  /** 报表类场景：只要数字，不带货币符号、不带正负号（与报表页原先的 formatMoney 输出一致）。 */
  function maskNumber(n: number): string {
    if (amountsHidden.value) return AMOUNT_PLACEHOLDER;
    return n.toLocaleString("zh-CN", NUMBER_FORMAT);
  }

  /** 账户类场景：带 ¥ 前缀；显示负值时输出 `-¥1,234.56`。 */
  function maskCurrency(n: number): string {
    if (amountsHidden.value) return `¥${AMOUNT_PLACEHOLDER}`;
    const abs = Math.abs(n).toLocaleString("zh-CN", NUMBER_FORMAT);
    return n < 0 ? `-¥${abs}` : `¥${abs}`;
  }

  function toggle(): void {
    prefs.toggleAmounts();
  }

  return { amountsHidden, maskNumber, maskCurrency, toggle };
}
