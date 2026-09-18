import type { PresetKey } from "@/utils/dateRange";

/**
 * 12 个快捷范围字面量。`satisfies` 保证每个字面量都是合法的 PresetKey（写错 TS 就报错），
 * dsl.test.ts 再断言它与 dateRange.PRESETS 的键集合一致（dateRange 新增 preset 时测试会红）。
 * 不做成从 PRESETS 派生：模型看到的是字面量枚举，独立列出来才好写进 JSON Schema。
 */
export const PRESET_KEYS = [
  "today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth",
  "last7Days", "last30Days", "last3Months", "last6Months", "thisYear", "lastYear",
] as const satisfies readonly PresetKey[];

export const AGGREGATES = ["sum", "count", "avg", "max", "min", "list"] as const;
export const GROUP_BYS = ["category", "account", "member", "month", "day", "tag"] as const;
export const ORDER_BYS = ["value_desc", "value_asc", "date_desc", "date_asc"] as const;
export const TX_TYPES = ["expense", "income", "transfer"] as const;

export type AiAggregate = (typeof AGGREGATES)[number];
export type AiGroupBy = (typeof GROUP_BYS)[number];
export type AiOrderBy = (typeof ORDER_BYS)[number];
export type AiTxType = (typeof TX_TYPES)[number];

export type AiDateFilter =
  | { preset: PresetKey }
  | { from: string; to: string };

export interface AiFilter {
  date?: AiDateFilter;
  type?: AiTxType;
  categories?: string[];
  /** 单个账户。流水页的账户筛选是单选，多账户无法回填（见规格 §4.1） */
  account?: string;
  tags?: string[];
  members?: string[];
  /** 命中 note 或标签名 */
  merchant?: string;
  amount?: { min?: number; max?: number };
}

export interface AiQuery extends AiFilter {
  aggregate: AiAggregate;
  groupBy?: AiGroupBy;
  orderBy?: AiOrderBy;
  limit?: number;
}

export const AI_QUERY_DEFAULT_LIMIT = 10;
export const AI_QUERY_MAX_LIMIT = 50;
export const AI_QUERY_MAX_ITEMS = 20;

export type AiQueryErrorCode =
  | "not_an_object"
  | "unknown_key"
  | "bad_date"
  | "bad_date_preset"
  | "bad_type"
  | "bad_string_array"
  | "bad_merchant"
  | "bad_amount"
  | "missing_aggregate"
  | "bad_aggregate"
  | "bad_group_by"
  | "bad_order_by"
  | "bad_limit";

export interface AiQueryError {
  code: AiQueryErrorCode;
  path: string;
  message: string;
}

export type ValidateResult =
  | { ok: true; query: AiQuery }
  | { ok: false; errors: AiQueryError[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FILTER_KEYS = [
  "date", "type", "categories", "account", "tags", "members", "merchant", "amount",
] as const;
const QUERY_KEYS: readonly string[] = [
  ...FILTER_KEYS, "aggregate", "groupBy", "orderBy", "limit",
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((it) => typeof it === "string");
}

function isEnum<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (list as readonly string[]).includes(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/**
 * 校验模型给出的 query 对象。
 *
 * 刻意**一次性收集全部错误**而不是遇到第一个就返回：模型一次拿到所有问题才有机会
 * 一轮改对；只报第一个会让它在多轮纠错里烧掉好几次调用。
 */
export function validateQuery(raw: unknown): ValidateResult {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [{ code: "not_an_object", path: "", message: "query 必须是一个对象" }],
    };
  }

  const errors: AiQueryError[] = [];
  const fail = (code: AiQueryErrorCode, path: string, message: string): void => {
    errors.push({ code, path, message });
  };

  for (const key of Object.keys(raw)) {
    if (!QUERY_KEYS.includes(key)) {
      fail("unknown_key", key, `不认识的字段 ${key}`);
    }
  }

  if (raw.date !== undefined) {
    const d = raw.date;
    if (!isPlainObject(d)) {
      fail("bad_date", "date", "date 必须是 {preset} 或 {from,to}");
    } else if ("preset" in d) {
      if (!isEnum(PRESET_KEYS, d.preset)) {
        fail("bad_date_preset", "date.preset", `preset 必须是 ${PRESET_KEYS.join(" / ")} 之一`);
      }
    } else if ("from" in d && "to" in d) {
      const fromOk = typeof d.from === "string" && DATE_RE.test(d.from);
      const toOk = typeof d.to === "string" && DATE_RE.test(d.to);
      if (!fromOk) fail("bad_date", "date.from", "from 必须是 YYYY-MM-DD");
      if (!toOk) fail("bad_date", "date.to", "to 必须是 YYYY-MM-DD");
      if (fromOk && toOk && (d.from as string) > (d.to as string)) {
        fail("bad_date", "date", "from 不能晚于 to");
      }
    } else {
      fail("bad_date", "date", "date 必须是 {preset} 或 {from,to} 二者之一");
    }
  }

  if (raw.type !== undefined && !isEnum(TX_TYPES, raw.type)) {
    fail("bad_type", "type", `type 必须是 ${TX_TYPES.join(" / ")} 之一`);
  }

  for (const key of ["categories", "tags", "members"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (!isStringArray(v) || v.some((s) => s.trim() === "")) {
      fail("bad_string_array", key, `${key} 必须是非空字符串组成的数组`);
    }
  }

  if (raw.account !== undefined && !isNonEmptyString(raw.account)) {
    fail("bad_string_array", "account", "account 必须是非空字符串");
  }

  if (raw.merchant !== undefined && !isNonEmptyString(raw.merchant)) {
    fail("bad_merchant", "merchant", "merchant 必须是非空字符串");
  }

  if (raw.amount !== undefined) {
    const a = raw.amount;
    if (!isPlainObject(a)) {
      fail("bad_amount", "amount", "amount 必须是 {min?, max?}");
    } else {
      const boundOk = (v: unknown): boolean =>
        v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
      if (!boundOk(a.min)) fail("bad_amount", "amount.min", "min 必须是非负有限数字");
      if (!boundOk(a.max)) fail("bad_amount", "amount.max", "max 必须是非负有限数字");
      if (typeof a.min === "number" && typeof a.max === "number" && a.min > a.max) {
        fail("bad_amount", "amount", "min 不能大于 max");
      }
    }
  }

  if (raw.aggregate === undefined) {
    fail("missing_aggregate", "aggregate", "aggregate 必填");
  } else if (!isEnum(AGGREGATES, raw.aggregate)) {
    fail("bad_aggregate", "aggregate", `aggregate 必须是 ${AGGREGATES.join(" / ")} 之一`);
  }

  if (raw.groupBy !== undefined && !isEnum(GROUP_BYS, raw.groupBy)) {
    fail("bad_group_by", "groupBy", `groupBy 必须是 ${GROUP_BYS.join(" / ")} 之一`);
  }

  if (raw.orderBy !== undefined && !isEnum(ORDER_BYS, raw.orderBy)) {
    fail("bad_order_by", "orderBy", `orderBy 必须是 ${ORDER_BYS.join(" / ")} 之一`);
  }

  if (raw.limit !== undefined) {
    const v = raw.limit;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      fail("bad_limit", "limit", "limit 必须是正整数");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  // 逐字段校验已在上方完成，此处断言整体形状。不做逐字段重建：那样反而容易漏抄字段。
  return { ok: true, query: raw as unknown as AiQuery };
}
