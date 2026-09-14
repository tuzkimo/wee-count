// src/utils/pin.ts
/** 应用锁 PIN 的形态与弱口令规则。 */
export const PIN_LENGTH = 6;

/**
 * 拒绝不合规或易猜的 6 位数字 PIN。
 * 只挡全同与连续序列这两类退化输入——它们占真实弱 PIN 的绝大多数，
 * 再加更多规则会开始干扰正常用户，收益迅速下降。
 */
export function isWeakPin(pin: string): boolean {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) return true;
  if (/^(\d)\1+$/.test(pin)) return true;

  const digits = [...pin].map(Number);
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  return ascending || descending;
}
