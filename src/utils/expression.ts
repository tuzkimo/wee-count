/**
 * 计算器表达式安全求值：只允许数字、四则运算、括号；返回两位小数，非法/非正返回 null。
 * 手写解析，避免 new Function/eval。
 */
export function evaluateExpression(expr: string): number | null {
  const e = expr.trim();
  if (!e || /[+\-*/]$/.test(e)) return null;
  if (!/^[\d.\-+*/()\s]+$/.test(e)) return null;

  const tokens = e.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens || tokens.join("").replace(/\s/g, "") !== e.replace(/\s/g, "")) return null;

  let pos = 0;
  function parseExpression(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (tokens![pos] === "+" || tokens![pos] === "-") {
      const op = tokens![pos++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (tokens![pos] === "*" || tokens![pos] === "/") {
      const op = tokens![pos++];
      const right = parseFactor();
      if (right === null) return null;
      if (op === "/") {
        if (right === 0) return null;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }
  function parseFactor(): number | null {
    const t = tokens![pos];
    if (t === "-") { pos++; const v = parseFactor(); return v === null ? null : -v; }
    if (t === "(") { pos++; const v = parseExpression(); if (tokens![pos] !== ")") return null; pos++; return v; }
    if (t === "+") { pos++; return parseFactor(); }
    const n = Number(t);
    if (t === undefined || isNaN(n)) return null;
    pos++;
    return n;
  }

  const result = parseExpression();
  if (result === null || pos !== tokens.length) return null;
  if (isNaN(result) || result <= 0) return null;
  // 加 EPSILON 修正浮点表示误差：1.005*100 === 100.4999... 否则会向下舍错 1 分。
  // 结果已保证 >0，直接对齐 transaction.ts 的 round2 写法。
  return Math.round((result + Number.EPSILON) * 100) / 100;
}
