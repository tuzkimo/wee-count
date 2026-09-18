// 筛选 query 参数解读的单一事实来源。
// 首页模式（非账户详情）且无任何筛选参数时，列表默认查当月；
// buildFetchOpts 与 filterSummary 共用 isDefaultCurrentMonth，避免「列表实际查全时间、摘要却显示当月」的错配。
// 同理，金额与类型两个参数也在这里**只解析一次**：两处各写一遍判定，就会出现
// 「列表没过滤、摘要却写着 ¥abc 以上」这种另一种错配。
import type { TransactionType } from "@/types";

export interface DefaultMonthFilter {
  account?: string;
  dateFrom?: string;
  dateTo?: string;
  tags?: string;
  categories?: string;
  members?: string;
  note?: string;
  amountMin?: string;
  amountMax?: string;
  type?: string;
}

export function isDefaultCurrentMonth(
  isAccountMode: boolean,
  accountId: string | null | undefined,
  q: DefaultMonthFilter,
): boolean {
  const accId = isAccountMode ? accountId : q.account;
  return !isAccountMode && !q.dateFrom && !q.dateTo && !q.tags && !q.categories
    && !q.members && !q.note && !q.amountMin && !q.amountMax && !q.type && !accId;
}

/**
 * 金额 query 参数 → `fetchAll` 的 `amountMin/amountMax`（数字）或 undefined（等于没给）。
 *
 * 必须用 `Number.isFinite` 而不是真值判断：
 * - 真值判断会把 `"0"` 当「没给」——0 是**有效下界**（「0 元以上」），丢掉它会让用户选的
 *   金额条件静默消失；
 * - `Number("abc")` 是 `NaN`、`Number("1e999")` 是 `Infinity`，两者都能通过
 *   `fetchAll` 的 `!== undefined` 守卫进入 SQL，而 SQLite 把 NaN 绑成 NULL
 *   （`amount >= NULL` 恒为 NULL）、`>= Inf` 永远不成立、`<= Inf` 匹配全表——
 *   **都是不报错的静默错数据**（Tauri 的 JSON IPC 又把 NaN 序列化成 "null"，两条路等价）。
 *   所以非有限值一律当成「没给」，条件既不进 SQL、也不进摘要。
 */
export function parseAmountParam(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 收支类型 query 参数 → 合法值或 undefined（非法值静默忽略，不抛错）。
 *
 * URL 是用户可改的，非法类型不该让整页白屏；但合法类型一个都不能漏：
 * `transfer` 是用户能选的类型（M1 的「转账」芯片会产出它），漏掉它会让那一跳
 * 静默变成「不按类型过滤」。返回值显式标注 `TransactionType | undefined`，
 * 否则条件表达式窄化出的字面量联合放进对象字面量时会被拓宽回 string。
 */
export function parseTransactionType(raw: string | undefined): TransactionType | undefined {
  return raw === "expense" || raw === "income" || raw === "transfer" ? raw : undefined;
}
