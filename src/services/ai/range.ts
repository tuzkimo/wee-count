// DSL 日期条件 → 可比较的时间边界。纯模块：不 import @/db/userDb 或任何 Tauri 模块。
import { addDays, buildPresetRange, normalizeRange } from "@/utils/dateRange";
import { localDateKeyToDate } from "@/utils/datetime";
import type { AiDateFilter } from "@/services/ai/dsl";

export interface ResolvedRange {
  /** 本地日，含首尾。用于回填流水页——fetchAll 对不带 "T" 的边界自行取整天 */
  from: string;
  to: string;
  /** UTC 半开区间 [startIso, endIso)，供聚合 SQL 直接比较 occurred_at */
  startIso: string;
  endIso: string;
}

/**
 * 本地日范围（含首尾整天）→ UTC 半开区间。
 *
 * 必须与 transactionStore.fetchAll 的算法逐字一致（src/stores/transaction.ts:178-197）：
 * - 不带 "T" 的 dateFrom → 当天 00:00 本地时间
 * - 不带 "T" 的 dateTo   → 【次日】00:00 本地时间（半开上界，否则月末 23:59 的流水会漏）
 *
 * 一致性由 range.test.ts 钉住。两条路径若分叉，同一句「今年」在 AI 回答里和点进
 * 流水页后会是两个数——那比算错更糟，因为用户会认定其中一个在骗他。
 */
export function dayRangeToIso(from: string, to: string): { startIso: string; endIso: string } {
  const start = localDateKeyToDate(from);
  const end = localDateKeyToDate(addDays(to, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/**
 * 把 DSL 的 date 解析成具体边界。date 缺省返回 null，语义是「不限时间」。
 *
 * now 可注入：测试必须固定它，否则跨零点跑测试会偶发失败。
 */
export function resolveRange(
  date: AiDateFilter | undefined,
  now: Date = new Date()
): ResolvedRange | null {
  if (!date) return null;
  const raw =
    "preset" in date ? buildPresetRange(date.preset, now) : normalizeRange(date.from, date.to);
  if (!raw.start || !raw.end) return null;
  return { from: raw.start, to: raw.end, ...dayRangeToIso(raw.start, raw.end) };
}
