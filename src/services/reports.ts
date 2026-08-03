import { getUserDb } from "@/db/userDb";

export type PeriodUnit = "month" | "quarter" | "year" | "twelveMonths";
export type Granularity = "day" | "month";

export interface ReportRange { start: Date; end: Date } // 本地边界，半开 [start, end)

export interface TrendSeries { labels: string[]; income: number[]; expense: number[] }
export interface PeriodTotals { income: number; expense: number; balance: number }
export interface BreakdownSegment {
  id: string | null; name: string; icon: string | null;
  total: number; percent: number; isMerge?: boolean;
}
export interface BreakdownData { segments: BreakdownSegment[]; list: BreakdownSegment[]; total: number }
export interface NetAssetSeries { labels: string[]; values: number[] }

export function offsetModifier(): string {
  const m = -new Date().getTimezoneOffset(); // +480 表示东八区
  return `${m >= 0 ? "+" : ""}${m} minutes`;
}

function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonths(d: Date, n: number): Date { return new Date(d.getFullYear(), d.getMonth() + n, 1); }

export function computeRange(unit: PeriodUnit, offset: number): {
  range: ReportRange; prevRange: ReportRange; label: string; granularity: Granularity;
} {
  const thisMonth = startOfMonth(new Date());
  if (unit === "month") {
    const start = addMonths(thisMonth, offset);
    const end = addMonths(start, 1);
    return {
      range: { start, end },
      prevRange: { start: addMonths(start, -1), end: start },
      label: `${start.getFullYear()}年${start.getMonth() + 1}月`,
      granularity: "day",
    };
  }
  const granularity: Granularity = "month";
  if (unit === "quarter") {
    const base = new Date(thisMonth.getFullYear(), Math.floor(thisMonth.getMonth() / 3) * 3, 1);
    const start = addMonths(base, offset * 3);
    const end = addMonths(start, 3);
    return {
      range: { start, end },
      prevRange: { start: addMonths(start, -3), end: start },
      label: `${start.getFullYear()}年Q${Math.floor(start.getMonth() / 3) + 1}`,
      granularity,
    };
  }
  if (unit === "year") {
    const start = new Date(thisMonth.getFullYear() + offset, 0, 1);
    const end = new Date(thisMonth.getFullYear() + offset + 1, 0, 1);
    return {
      range: { start, end },
      prevRange: { start: new Date(thisMonth.getFullYear() + offset - 1, 0, 1), end: start },
      label: `${start.getFullYear()}年`,
      granularity,
    };
  }
  // twelveMonths: 窗口 = 截止上月末的 12 个月，offset 按 12 个月平移
  const anchor = addMonths(thisMonth, offset * 12);
  const start = addMonths(anchor, -12);
  const lastShown = addMonths(anchor, -1);
  return {
    range: { start, end: anchor },
    prevRange: { start: addMonths(start, -12), end: start },
    label: `${start.getFullYear()}年${start.getMonth() + 1}月–${lastShown.getFullYear()}年${lastShown.getMonth() + 1}月`,
    granularity,
  };
}

export function rangeLabels(range: ReportRange, granularity: Granularity): string[] {
  const out: string[] = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  if (granularity === "day") {
    const d = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
    while (d.getTime() < range.end.getTime()) {
      out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
      d.setDate(d.getDate() + 1);
    }
  } else {
    const d = startOfMonth(range.start);
    while (d.getTime() < range.end.getTime()) {
      out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
      d.setMonth(d.getMonth() + 1);
    }
  }
  return out;
}

function bucketExpr(granularity: Granularity): string {
  const off = offsetModifier();
  return granularity === "day"
    ? `date(occurred_at, '${off}')`
    : `strftime('%Y-%m', occurred_at, '${off}')`;
}

export function fillTrend(
  rows: { bucket: string; income: number; expense: number }[],
  labels: string[]
): TrendSeries {
  const by = new Map(rows.map((r) => [r.bucket, r]));
  const income: number[] = [];
  const expense: number[] = [];
  for (const l of labels) {
    const r = by.get(l);
    income.push(r?.income ?? 0);
    expense.push(r?.expense ?? 0);
  }
  return { labels, income, expense };
}

const TREND_SQL = (granularity: Granularity) => `
  SELECT ${bucketExpr(granularity)} AS bucket,
    COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) AS income,
    COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
  FROM transactions
  WHERE ledger_id=? AND is_deleted=0 AND type!='transfer'
    AND occurred_at>=? AND occurred_at<?
  GROUP BY bucket ORDER BY bucket`;

export async function getTrend(
  ledgerId: string, range: ReportRange, granularity: Granularity
): Promise<TrendSeries> {
  const db = getUserDb();
  if (!db) return { labels: rangeLabels(range, granularity), income: [], expense: [] };
  const rows = await db.select<{ bucket: string; income: number; expense: number }[]>(
    TREND_SQL(granularity),
    [ledgerId, range.start.toISOString(), range.end.toISOString()]
  );
  return fillTrend(rows, rangeLabels(range, granularity));
}

const TOTALS_SQL = `
  SELECT
    COALESCE(SUM(CASE WHEN type='income' THEN amount END),0) AS income,
    COALESCE(SUM(CASE WHEN type='expense' THEN amount END),0) AS expense
  FROM transactions
  WHERE ledger_id=? AND is_deleted=0 AND occurred_at>=? AND occurred_at<?`;

export async function getPeriodTotals(ledgerId: string, range: ReportRange): Promise<PeriodTotals> {
  const db = getUserDb();
  if (!db) return { income: 0, expense: 0, balance: 0 };
  const rows = await db.select<{ income: number; expense: number }[]>(
    TOTALS_SQL,
    [ledgerId, range.start.toISOString(), range.end.toISOString()]
  );
  const r = rows[0] ?? { income: 0, expense: 0 };
  return { income: r.income, expense: r.expense, balance: r.income - r.expense };
}

export function computeDeltas(
  cur: PeriodTotals, prev: PeriodTotals
): { incomeDeltaPct: number | null; expenseDeltaPct: number | null } {
  const pct = (curV: number, prevV: number) =>
    prevV === 0 ? null : Math.round(((curV - prevV) / prevV) * 1000) / 10;
  return { incomeDeltaPct: pct(cur.income, prev.income), expenseDeltaPct: pct(cur.expense, prev.expense) };
}

export function buildBreakdown(
  rows: { cid: string | null; name: string | null; icon: string | null; total: number }[]
): BreakdownData {
  // 排序保证 top-6 取最大额类别（单测契约：按 total 降序）
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  const list: BreakdownSegment[] = sorted.map((r) => ({
    id: r.cid ?? null,
    name: r.name ?? "未分类",
    icon: r.icon,
    total: r.total,
    percent: 0,
  }));
  const total = list.reduce((s, it) => s + it.total, 0);
  for (const it of list) it.percent = total > 0 ? Math.round((it.total / total) * 1000) / 10 : 0;
  const top = list.slice(0, 6);
  const rest = list.slice(6);
  const segments = [...top];
  if (rest.length > 0) {
    const restTotal = rest.reduce((s, it) => s + it.total, 0);
    segments.push({
      id: "other", name: "其他", icon: null,
      total: restTotal,
      percent: total > 0 ? Math.round((restTotal / total) * 1000) / 10 : 0,
      isMerge: true,
    });
  }
  return { segments, list, total };
}

const BREAKDOWN_SQL = `
  SELECT t.category_id AS cid, c.name, c.icon,
    COALESCE(SUM(t.amount),0) AS total
  FROM transactions t
  LEFT JOIN categories c ON t.category_id=c.id
  WHERE t.ledger_id=? AND t.is_deleted=0 AND t.type=?
    AND t.occurred_at>=? AND t.occurred_at<?
  GROUP BY t.category_id ORDER BY total DESC`;

export async function getCategoryBreakdown(
  ledgerId: string, type: "income" | "expense", range: ReportRange
): Promise<BreakdownData> {
  const db = getUserDb();
  if (!db) return { segments: [], list: [], total: 0 };
  const rows = await db.select<{ cid: string | null; name: string | null; icon: string | null; total: number }[]>(
    BREAKDOWN_SQL,
    [ledgerId, type, range.start.toISOString(), range.end.toISOString()]
  );
  return buildBreakdown(rows);
}

export function buildNetAssetSeries(
  baseline: number,
  flows: { bucket: string; income: number; expense: number }[],
  initials: { bucket: string; v: number }[],
  labels: string[]
): number[] {
  const flowBy = new Map(flows.map((f) => [f.bucket, f]));
  const initBy = new Map(initials.map((i) => [i.bucket, i.v]));
  const values: number[] = [];
  let acc = baseline;
  for (const l of labels) {
    const f = flowBy.get(l);
    if (f) acc += (f.income ?? 0) - (f.expense ?? 0);
    const init = initBy.get(l);
    if (init !== undefined) acc += init;
    values.push(Math.round(acc * 100) / 100);
  }
  return values;
}

const BASELINE_FLOWS_SQL = `
  SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE -amount END),0) AS v
  FROM transactions WHERE ledger_id=? AND is_deleted=0 AND type!='transfer' AND occurred_at<?`;

const BASELINE_ACCOUNTS_SQL = `
  SELECT COALESCE(SUM(CASE WHEN category='asset' THEN initial_balance ELSE -initial_balance END),0) AS v
  FROM accounts WHERE ledger_id=? AND is_deleted=0 AND created_at<=?`;

const INITIALS_SQL = (granularity: Granularity) => `
  SELECT ${bucketExpr(granularity)} AS bucket,
    COALESCE(SUM(CASE WHEN category='asset' THEN initial_balance ELSE -initial_balance END),0) AS v
  FROM accounts WHERE ledger_id=? AND is_deleted=0 AND created_at>=? AND created_at<?
  GROUP BY bucket ORDER BY bucket`;

export async function getNetAssetSeries(
  ledgerId: string, range: ReportRange, granularity: Granularity
): Promise<NetAssetSeries> {
  const db = getUserDb();
  const labels = rangeLabels(range, granularity);
  if (!db) return { labels, values: [] };
  const [flowRows, accRows] = await Promise.all([
    db.select<{ v: number }[]>(BASELINE_FLOWS_SQL, [ledgerId, range.start.toISOString()]),
    db.select<{ v: number }[]>(BASELINE_ACCOUNTS_SQL, [ledgerId, range.start.toISOString()]),
  ]);
  const baseline = (flowRows[0]?.v ?? 0) + (accRows[0]?.v ?? 0);
  const [flows, initials] = await Promise.all([
    db.select<{ bucket: string; income: number; expense: number }[]>(
      TREND_SQL(granularity),
      [ledgerId, range.start.toISOString(), range.end.toISOString()]
    ),
    db.select<{ bucket: string; v: number }[]>(
      INITIALS_SQL(granularity),
      [ledgerId, range.start.toISOString(), range.end.toISOString()]
    ),
  ]);
  const values = buildNetAssetSeries(baseline, flows, initials, labels);
  return { labels, values };
}

export interface ReportData {
  range: ReportRange; prevRange: ReportRange; label: string; granularity: Granularity;
  trend: TrendSeries; totals: PeriodTotals; prevTotals: PeriodTotals;
  breakdownExpense: BreakdownData; breakdownIncome: BreakdownData; netAsset: NetAssetSeries;
}

export async function getReportData(ledgerId: string, unit: PeriodUnit, offset: number): Promise<ReportData> {
  const { range, prevRange, label, granularity } = computeRange(unit, offset);
  const [trend, totals, prevTotals, breakdownExpense, breakdownIncome, netAsset] = await Promise.all([
    getTrend(ledgerId, range, granularity),
    getPeriodTotals(ledgerId, range),
    getPeriodTotals(ledgerId, prevRange),
    getCategoryBreakdown(ledgerId, "expense", range),
    getCategoryBreakdown(ledgerId, "income", range),
    getNetAssetSeries(ledgerId, range, granularity),
  ]);
  return { range, prevRange, label, granularity, trend, totals, prevTotals, breakdownExpense, breakdownIncome, netAsset };
}
