// 日期范围（day 粒度）的单一事实来源：快捷范围、日历网格、范围归一化与展示文案。
// 本模块产出的边界串一律是 "YYYY-MM-DD"（含首尾整天），不含时分：
// transactionStore.fetchAll 对不带 "T" 的 dateTo 取「次日 00:00」作上界，
// 因此含首尾整天的语义由 store 保证，导出 datetime 串反而会因 +1 分钟而越界。
import { localDateKeyToDate, toLocalDatetimeString } from "@/utils/datetime";

/** 一周起始日：1 = 周一。中国习惯，也是国内记账 App 的默认。 */
export const WEEK_START = 1;

export type PresetKey =
  | "today"
  | "yesterday"
  | "thisWeek"
  | "lastWeek"
  | "thisMonth"
  | "lastMonth"
  | "last7Days"
  | "last30Days"
  | "last3Months"
  | "last6Months"
  | "thisYear"
  | "lastYear";

/** 日期范围，含首尾端点。"YYYY-MM-DD"；单边范围时另一端为 ""。 */
export interface DateRange {
  start: string;
  end: string;
}

/** 网格单元：null 表示本月之外的占位格（不可点击，保留固定 6 行高度）。 */
export type CalendarCell = string | null;

const DAY_MS = 86_400_000;

/** 本地 timezone 下的 "YYYY-MM-DD"。 */
export function toDateKey(d: Date): string {
  return toLocalDatetimeString(d).slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function makeDateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function splitDateKey(key: string): { year: number; month: number; day: number } {
  const [y, m, d] = key.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** 日期 key 加减天数，跨月/跨年/闰年由 Date 处理。 */
export function addDays(key: string, days: number): string {
  const d = localDateKeyToDate(key);
  d.setDate(d.getDate() + days);
  return toDateKey(d);
}

/** 年月加减，month 为 1-12。 */
export function addMonths(
  year: number,
  month: number,
  delta: number
): { year: number; month: number } {
  const total = year * 12 + (month - 1) + delta;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/**
 * 生成固定 42 格（6 行 × 7 列）的月历网格，周一为首日。
 * 固定行数是为了切换月份时面板高度不跳。
 */
export function buildMonthGrid(
  year: number,
  month: number,
  weekStartsOn: number = WEEK_START
): CalendarCell[] {
  const lead = (new Date(year, month - 1, 1).getDay() - weekStartsOn + 7) % 7;
  const total = daysInMonth(year, month);
  const cells: CalendarCell[] = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= total; d++) cells.push(makeDateKey(year, month, d));
  while (cells.length < 42) cells.push(null);
  return cells;
}

/** 星期表头，与 buildMonthGrid 的列顺序一致。 */
export function weekdayHeaders(weekStartsOn: number = WEEK_START): string[] {
  const labels = ["日", "一", "二", "三", "四", "五", "六"];
  return Array.from({ length: 7 }, (_, i) => labels[(weekStartsOn + i) % 7]);
}

/** 归一化两端，保证 start <= end（date key 的字典序即时间序）。 */
export function normalizeRange(a: string, b: string): DateRange {
  if (!a) return { start: "", end: b };
  if (!b) return { start: a, end: "" };
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** 含首尾的天数；任一端缺失返回 0。用 Math.round 规避夏令时造成的 23/25 小时误差。 */
export function diffDaysInclusive(start: string, end: string): number {
  if (!start || !end) return 0;
  const { start: s, end: e } = normalizeRange(start, end);
  return Math.round((localDateKeyToDate(e).getTime() - localDateKeyToDate(s).getTime()) / DAY_MS) + 1;
}

/** 本周内的天数偏移：周一 = 0 … 周日 = 6。 */
function weekdayOffset(now: Date, weekStartsOn: number = WEEK_START): number {
  return (now.getDay() - weekStartsOn + 7) % 7;
}

/**
 * 快捷范围。全部为 day 粒度、含首尾。
 * 「近 3 月 / 近 6 月」按自然月计（含当月），与 useReports 的 twelveMonths 口径一致。
 */
export function buildPresetRange(key: PresetKey, now: Date = new Date()): DateRange {
  const today = toDateKey(now);
  const { year, month } = splitDateKey(today);

  switch (key) {
    case "today":
      return { start: today, end: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { start: y, end: y };
    }
    case "thisWeek": {
      const start = addDays(today, -weekdayOffset(now));
      return { start, end: addDays(start, 6) };
    }
    case "lastWeek": {
      const end = addDays(today, -weekdayOffset(now) - 1);
      return { start: addDays(end, -6), end };
    }
    case "thisMonth":
      return { start: makeDateKey(year, month, 1), end: makeDateKey(year, month, daysInMonth(year, month)) };
    case "lastMonth": {
      const prev = addMonths(year, month, -1);
      return {
        start: makeDateKey(prev.year, prev.month, 1),
        end: makeDateKey(prev.year, prev.month, daysInMonth(prev.year, prev.month)),
      };
    }
    case "last7Days":
      return { start: addDays(today, -6), end: today };
    case "last30Days":
      return { start: addDays(today, -29), end: today };
    case "last3Months":
    case "last6Months": {
      const span = key === "last3Months" ? 2 : 5;
      const from = addMonths(year, month, -span);
      return {
        start: makeDateKey(from.year, from.month, 1),
        end: makeDateKey(year, month, daysInMonth(year, month)),
      };
    }
    case "thisYear":
      return { start: makeDateKey(year, 1, 1), end: makeDateKey(year, 12, 31) };
    case "lastYear":
      return { start: makeDateKey(year - 1, 1, 1), end: makeDateKey(year - 1, 12, 31) };
  }
}

/** chips 展示顺序：先放高频的（用户点名的本周/本月/上月/今年/上年占据首屏）。 */
export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "thisWeek", label: "本周" },
  { key: "thisYear", label: "今年" },
  { key: "lastYear", label: "上年" },
  { key: "last7Days", label: "近7天" },
  { key: "last30Days", label: "近30天" },
  { key: "last3Months", label: "近3月" },
  { key: "last6Months", label: "近6月" },
  { key: "today", label: "今天" },
  { key: "yesterday", label: "昨天" },
  { key: "lastWeek", label: "上周" },
];

/**
 * 当前范围命中的快捷项，用于 chips 高亮。
 * 高亮是派生状态而非独立 flag：手动改日期后自动失配、高亮消失，
 * 从根上避免「chip 显示本月、实际是自定义范围」的错配。
 */
export function matchPreset(range: DateRange, now: Date = new Date()): PresetKey | null {
  if (!range.start || !range.end) return null;
  for (const p of PRESETS) {
    const r = buildPresetRange(p.key, now);
    if (r.start === range.start && r.end === range.end) return p.key;
  }
  return null;
}

/** 「M月D日」，跨年范围会带上年份，见 formatRangeLabel。 */
function formatDay(key: string): string {
  const { month, day } = splitDateKey(key);
  return `${month}月${day}日`;
}

/**
 * 范围展示文案：
 * 同一天 → 「2026年8月15日」；同年 → 「2026年8月1日 - 8月15日 · 15天」；
 * 跨年 → 「2025年12月1日 - 2026年1月15日 · 46天」；单边 → 「2026年8月1日 起」/「至 2026年8月15日」。
 */
export function formatRangeLabel(start: string, end: string): string {
  if (!start && !end) return "";
  if (start && !end) return `${splitDateKey(start).year}年${formatDay(start)} 起`;
  if (!start && end) return `至 ${splitDateKey(end).year}年${formatDay(end)}`;

  const s = splitDateKey(start);
  const e = splitDateKey(end);
  const days = diffDaysInclusive(start, end);
  if (start === end) return `${s.year}年${formatDay(start)}`;
  if (s.year === e.year) return `${s.year}年${formatDay(start)} - ${formatDay(end)} · ${days}天`;
  return `${s.year}年${formatDay(start)} - ${e.year}年${formatDay(end)} · ${days}天`;
}