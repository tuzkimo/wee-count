/**
 * 计算器表达式安全求值：只允许数字、+、-、.；返回两位小数，非法/非正返回 null。
 */
export function evaluateExpression(expr: string): number | null {
  const e = expr.trim();
  if (!e || /[+\-.]$/.test(e)) return null;
  if (!/^[\d.\-+]+$/.test(e)) return null;
  try {
    const result = new Function(`return (${e})`)() as number;
    if (isNaN(result) || result <= 0) return null;
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}
