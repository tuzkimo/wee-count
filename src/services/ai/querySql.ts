// WHERE 子句与汇总查询的纯构造模块：只产出 `{ sql, params }`，**不执行查询**（执行是
// runQuery.ts 的事，任务 8）。因此本文件绝不 import `@/db/userDb` 或任何 Tauri 模块——
// 一旦引入，任务 8 的冒烟测试会在 import 阶段就倒，"纯函数零 DB"这条约束也会被击穿。
import { likePattern, noteOrTagLikeClause } from "@/utils/like";
import { round2 } from "@/utils/transaction";
import type { AiTxType } from "@/services/ai/dsl";
import type { ResolvedFilter } from "@/services/ai/resolve";

export interface SqlFragment {
  sql: string;
  params: (string | number)[];
}

export interface AiTotals {
  total: number;
  count: number;
  avg: number;
}

export interface AiSummary {
  /** 未被查询的桶为 null，不是 0 —— 见规格 §4.2 */
  expense: AiTotals | null;
  income: AiTotals | null;
  transfer: AiTotals | null;
  net: number | null;
  matched: number;
}

export interface SummaryRow {
  expense_total: number;
  expense_count: number;
  income_total: number;
  income_count: number;
  transfer_total: number;
  transfer_count: number;
  matched: number;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

/**
 * 构造 WHERE 子句，返回值以 " WHERE " 开头。
 *
 * 两条恒定约束一个都不能漏：
 * - `t.ledger_id = ?`：不带就是跨账本串数据
 * - `t.is_deleted = 0`：软删的交易不该进统计
 *
 * **不在 type 缺省时加 `t.type != 'transfer'`。** 转账不进收支这件事由聚合里的
 * `CASE WHEN t.type='expense' / 'income'` 分桶保证（见 buildSummarySql），
 * WHERE 里再排除一次是过度应用，代价是 `matched` 少算转账——而流水页的列表是
 * **包含**转账的（fetchAll 不排除它，只在算收支总额时跳过）。结果就是 AI 说
 * "共 5 笔"、用户点进去看到 6 条。宁可让 WHERE 只表达"用户筛了什么"。
 *
 * 账户、标签、成员的匹配语义与 transactionStore.fetchAll 保持一致，
 * 否则"AI 回答的数字"与"点进流水页看到的列表"会对不上。
 */
export function buildWhere(ledgerId: string, f: ResolvedFilter): SqlFragment {
  const clauses: string[] = ["t.ledger_id = ?", "t.is_deleted = 0"];
  const params: (string | number)[] = [ledgerId];

  // 只有用户明确指定类型时才加类型条件
  if (f.type !== null) {
    clauses.push("t.type = ?");
    params.push(f.type);
  }

  if (f.range) {
    // 半开区间：上界必须是 `<`。endIso 是「次日 00:00」（range.ts 用 addDays(to,1)），
    // 写成 `<=` 会把第二天零点整那笔算进来——链路三个环节（fetchAll 的 setDate(+1)、
    // range.ts、这里）任何一处改成闭区间，都会静默差一天。
    clauses.push("t.occurred_at >= ? AND t.occurred_at < ?");
    params.push(f.range.startIso, f.range.endIso);
  }

  if (f.accountId) {
    clauses.push("(t.from_account_id = ? OR t.to_account_id = ?)");
    params.push(f.accountId, f.accountId);
  }

  if (f.categoryIds) {
    clauses.push(`t.category_id IN (${placeholders(f.categoryIds.length)})`);
    params.push(...f.categoryIds);
  }

  if (f.tagIds) {
    // AND 交集：同时拥有所有选中标签。与 fetchAll 的写法一致
    for (const tagId of f.tagIds) {
      clauses.push("t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id = ?)");
      params.push(tagId);
    }
  }

  if (f.memberIds) {
    clauses.push(`t.user_id IN (${placeholders(f.memberIds.length)})`);
    params.push(...f.memberIds);
  }

  if (f.merchant) {
    // 与 fetchAll 共用同一个片段：两边语义只要差一点，AI 的总额和流水页的条数
    // 就会对不上。转义由 likePattern 负责，ESCAPE 由片段自带。
    // 绝不在这里手拼一遍等价 SQL——那正是 F1 裁决要消灭的漂移源。
    clauses.push(noteOrTagLikeClause());
    const like = likePattern(f.merchant);
    params.push(like, like);
  }

  // 金额恒存正数（正负由 type 承载），所以区间比较的是绝对值。
  // 判空必须用 `!== null`：0 是有效下界（「至少 0 元」），用 truthiness 会把 0 当成"没给"。
  if (f.amountMin !== null) {
    clauses.push("t.amount >= ?");
    params.push(f.amountMin);
  }
  if (f.amountMax !== null) {
    clauses.push("t.amount <= ?");
    params.push(f.amountMax);
  }

  return { sql: ` WHERE ${clauses.join(" AND ")}`, params };
}

/**
 * 一次查询取回三个桶与命中笔数。
 *
 * 三个桶全算、由 shapeSummary 按 type 决定哪几个对外可见：SQL 里少算一列会让
 * "type 没给时要双返回"这条契约没法满足，而多算两列的代价只是一次聚合扫描。
 *
 * 转账不进收支是**靠分桶**保证的，不是靠 WHERE 排除：每笔钱只会落进它自己那个
 * `CASE WHEN` 桶，收入与支出永远不会被转账污染。`matched` 则统计**所有**命中筛选
 * 条件的行（含转账），这样它才等于用户点进流水页后看到的条数。
 */
export function buildSummarySql(ledgerId: string, f: ResolvedFilter): SqlFragment {
  const where = buildWhere(ledgerId, f);
  const sql = `
    SELECT
      COALESCE(SUM(CASE WHEN t.type='expense'  THEN t.amount END), 0) AS expense_total,
      COALESCE(SUM(CASE WHEN t.type='expense'  THEN 1 END), 0)        AS expense_count,
      COALESCE(SUM(CASE WHEN t.type='income'   THEN t.amount END), 0) AS income_total,
      COALESCE(SUM(CASE WHEN t.type='income'   THEN 1 END), 0)        AS income_count,
      COALESCE(SUM(CASE WHEN t.type='transfer' THEN t.amount END), 0) AS transfer_total,
      COALESCE(SUM(CASE WHEN t.type='transfer' THEN 1 END), 0)        AS transfer_count,
      COUNT(*) AS matched
    FROM transactions t${where.sql}`;
  return { sql, params: where.params };
}

function toTotals(total: number, count: number): AiTotals {
  const t = round2(total);
  // count 为 0 时 avg 必须给 0：0/0 是 NaN，NaN 会一路流进给模型的 JSON 变成 null，
  // 于是"没查"与"除零"在模型眼里长得一样。
  return { total: t, count, avg: count > 0 ? round2(t / count) : 0 };
}

/**
 * 整形汇总，并按 type 决定哪些桶可见。
 *
 * 未查询的桶给 **null 而不是 0**：模型看到 `expense: {total: 0}` 会照实回答
 * "你这个月支出 0 元"——把"没查"说成"没有"，是个会直接吓到用户的错误结论。
 */
export function shapeSummary(
  row: SummaryRow | undefined,
  type: AiTxType | null,
): AiSummary {
  const expense = toTotals(row?.expense_total ?? 0, row?.expense_count ?? 0);
  const income = toTotals(row?.income_total ?? 0, row?.income_count ?? 0);
  const transfer = toTotals(row?.transfer_total ?? 0, row?.transfer_count ?? 0);
  const wantExpense = type === null || type === "expense";
  const wantIncome = type === null || type === "income";
  return {
    expense: wantExpense ? expense : null,
    income: wantIncome ? income : null,
    transfer: type === "transfer" ? transfer : null,
    net: type === null ? round2(income.total - expense.total) : null,
    matched: row?.matched ?? 0,
  };
}
