// WHERE 子句与汇总查询的纯构造模块：只产出 `{ sql, params }`，**不执行查询**（执行是
// runQuery.ts 的事，任务 8）。因此本文件绝不 import `@/db/userDb` 或任何 Tauri 模块——
// 一旦引入，任务 8 的冒烟测试会在 import 阶段就倒，"纯函数零 DB"这条约束也会被击穿。
import { likePattern, noteOrTagLikeClause } from "@/utils/like";
import { round2 } from "@/utils/transaction";
// offsetModifier 从 utils/datetime 引，**不从 services/reports** —— reports.ts 里有
// `import { getUserDb } from "@/db/userDb"`，会经 userDb 把 @tauri-apps/plugin-sql 拖进
// 本模块的导入链。那样 sqlSmoke.test.ts（不 mock userDb）会在 import 阶段就倒，
// 而且本模块「纯函数、零 DB」这条架构约束会被打破。
// utils/datetime.ts 本身零 import，是这条边唯一干净的落点。
import { offsetModifier } from "@/utils/datetime";
import {
  AI_QUERY_DEFAULT_LIMIT,
  AI_QUERY_MAX_ITEMS,
  AI_QUERY_MAX_LIMIT,
  type AiGroupBy,
  type AiQuery,
  type AiTxType,
} from "@/services/ai/dsl";
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

  // 下面三处判空一律用 `?.length`，**不能用真值判断 `if (f.categoryIds)`**：
  // 空数组 `[]` 在 JS 里是真值，真值判断会放行并拼出 `IN ()`，而 SQLite 对 `IN ()`
  // 不报错、静默返回 0 行——空数组就被当成了"匹配空集"而不是"不过滤"，静默给出
  // 错误答案。契约（与 resolveFilter / fetchAll 一致）：空数组 = 不过滤。
  if (f.categoryIds?.length) {
    clauses.push(`t.category_id IN (${placeholders(f.categoryIds.length)})`);
    params.push(...f.categoryIds);
  }

  if (f.tagIds?.length) {
    // AND 交集：同时拥有所有选中标签。与 fetchAll 的写法一致
    for (const tagId of f.tagIds) {
      clauses.push("t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id = ?)");
      params.push(tagId);
    }
  }

  if (f.memberIds?.length) {
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

export interface AiGroup {
  label: string;
  expense: number;
  income: number;
  transfer: number;
  count: number;
}

export interface AiQueryItem {
  date: string;
  amount: number;
  type: AiTxType;
  category: string | null;
  fromAccount: string | null;
  toAccount: string | null;
  note: string | null;
}

export interface AiQueryResult extends AiSummary {
  groups: AiGroup[] | null;
  items: AiQueryItem[] | null;
  truncated: boolean;
}

export interface GroupRow {
  key: string;
  expense_total: number;
  income_total: number;
  transfer_total: number;
  cnt: number;
}

export interface ItemRow {
  day: string;
  amount: number;
  type: AiTxType;
  category_name: string | null;
  from_account_name: string | null;
  to_account_name: string | null;
  note: string | null;
}

export function clampLimit(limit: number | undefined, max: number): number {
  const n = limit ?? AI_QUERY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** 分组维度的 join。member / month / day 不需要 join */
function groupJoin(groupBy: AiGroupBy): string {
  switch (groupBy) {
    case "category":
      return "\n    LEFT JOIN categories c ON c.id = t.category_id AND c.is_deleted = 0";
    case "account":
      return "\n    LEFT JOIN accounts fa ON fa.id = t.from_account_id" +
        "\n    LEFT JOIN accounts ta ON ta.id = t.to_account_id";
    case "tag":
      return "\n    LEFT JOIN transaction_tags gtt ON gtt.transaction_id = t.id" +
        "\n    LEFT JOIN tags gtg ON gtg.id = gtt.tag_id AND gtg.is_deleted = 0";
    case "member":
    case "month":
    case "day":
      return "";
  }
}

/**
 * 分组键表达式。
 *
 * - 分类/标签用 COALESCE 兜底文案，使"未分类 / 未打标签"成为可见的一桶，
 *   否则它们会聚成一个 label 为 null 的桶，模型无法解释。
 * - 月份/天用显式时区偏移修饰符归桶，与 reports.ts 同源：occurred_at 是 UTC，
 *   直接用 strftime 会把东八区凌晨的流水算到前一天/前一月。
 * - member 的 key 是 user_id，显示名由调用方（runQuery）替换——本模块是纯函数，
 *   拿不到成员昵称/别名。
 */
function groupKeyExpr(groupBy: AiGroupBy): string {
  switch (groupBy) {
    case "category":
      return "COALESCE(c.name, '未分类')";
    case "account":
      return "COALESCE(fa.name, ta.name, '未知账户')";
    case "tag":
      return "COALESCE(gtg.name, '未打标签')";
    case "member":
      return "t.user_id";
    case "month":
      return `strftime('%Y-%m', t.occurred_at, '${offsetModifier()}')`;
    case "day":
      return `date(t.occurred_at, '${offsetModifier()}')`;
  }
}

/**
 * 分组聚合。
 *
 * 注意 tag 分组下，一笔多标签的交易会同时计入每个标签的桶，各桶之和因此可能大于
 * 总计。这是标签统计的标准行为（一笔交易确实同时属于这两个标签），不是 bug。
 */
export function buildGroupsSql(
  ledgerId: string,
  q: AiQuery,
  f: ResolvedFilter,
): SqlFragment {
  const groupBy = q.groupBy;
  if (!groupBy) throw new Error("buildGroupsSql 需要 groupBy");
  const where = buildWhere(ledgerId, f);
  const orderDir = q.orderBy === "value_asc" || q.orderBy === "date_asc" ? "ASC" : "DESC";
  // value_* 排序按【对外可见的那些桶】求和。type 缺省时对外只有收入与支出，
  // 把转账也算进排序键会让转账占主导的分组排到最前面，而它的金额在用户看到的
  // 回答里根本不出现——"为什么第一个分类是这个"会变成一个解释不清的问题。
  const valueExpr = f.type === "expense"
    ? "expense_total"
    : f.type === "income"
      ? "income_total"
      : f.type === "transfer"
        ? "transfer_total"
        : "(expense_total + income_total)";
  const orderBy = q.orderBy === "date_desc" || q.orderBy === "date_asc"
    ? `key ${orderDir}`
    : `${valueExpr} ${orderDir}`;
  const limit = clampLimit(q.limit, AI_QUERY_MAX_LIMIT);
  const sql = `
    SELECT ${groupKeyExpr(groupBy)} AS key,
      COALESCE(SUM(CASE WHEN t.type='expense'  THEN t.amount END), 0) AS expense_total,
      COALESCE(SUM(CASE WHEN t.type='income'   THEN t.amount END), 0) AS income_total,
      COALESCE(SUM(CASE WHEN t.type='transfer' THEN t.amount END), 0) AS transfer_total,
      COUNT(*) AS cnt
    FROM transactions t${groupJoin(groupBy)}${where.sql}
    GROUP BY key
    ORDER BY ${orderBy}
    LIMIT ${limit}`;
  return { sql, params: where.params };
}

/** 明细查询。字段刻意精简：这些内容会发给 LLM，不该带上账户余额之类无关信息 */
export function buildItemsSql(
  ledgerId: string,
  q: AiQuery,
  f: ResolvedFilter,
): SqlFragment {
  const where = buildWhere(ledgerId, f);
  const limit = clampLimit(q.limit, AI_QUERY_MAX_ITEMS);
  const sql = `
    SELECT
      date(t.occurred_at, '${offsetModifier()}') AS day,
      t.amount, t.type,
      c.name AS category_name,
      fa.name AS from_account_name,
      ta.name AS to_account_name,
      substr(t.note, 1, 60) AS note
    FROM transactions t
    LEFT JOIN categories c ON c.id = t.category_id AND c.is_deleted = 0
    LEFT JOIN accounts fa ON fa.id = t.from_account_id
    LEFT JOIN accounts ta ON ta.id = t.to_account_id${where.sql}
    ORDER BY t.occurred_at DESC, t.created_at DESC
    LIMIT ${limit}`;
  return { sql, params: where.params };
}

export function shapeGroups(rows: GroupRow[]): AiGroup[] {
  return rows.map((r) => ({
    label: r.key,
    expense: round2(r.expense_total),
    income: round2(r.income_total),
    transfer: round2(r.transfer_total),
    count: r.cnt,
  }));
}

export function shapeItems(rows: ItemRow[]): AiQueryItem[] {
  return rows.map((r) => ({
    date: r.day,
    amount: round2(r.amount),
    type: r.type,
    category: r.category_name,
    fromAccount: r.from_account_name,
    toAccount: r.to_account_name,
    note: r.note,
  }));
}
