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

/**
 * `date` 对象允许的内层键。
 *
 * 顶层键有白名单（QUERY_KEYS），**内层同样必须有**。否则 `{date:{presett:"thisYear"}}`
 * 这种拼错会静默通过校验，下游 `resolveRange` 才发现"既没有 preset 也没有 from/to"，
 * 报一句泛化的 bad_date——错误离出错点太远，模型看不出是哪个键拼错了。
 */
export const DATE_KEYS = ["preset", "from", "to"] as const;

/** `amount` 对象允许的内层键。理由同 DATE_KEYS：
 * `{amount:{minn:500}}` 若放行，会变成"整个金额过滤被静默丢弃"，用户拿到一个没有任何提示的错数字。 */
export const AMOUNT_KEYS = ["min", "max"] as const;

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
  | "bad_account"
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
    } else {
      // 内层键白名单。理由见 DATE_KEYS 的注释：放行拼错的键 = 静默丢过滤条件 = 错数字
      let hasUnknownKey = false;
      for (const key of Object.keys(d)) {
        if (!(DATE_KEYS as readonly string[]).includes(key)) {
          hasUnknownKey = true;
          fail("unknown_key", `date.${key}`, `date 里不认识的字段 ${key}`);
        }
      }
      const hasPreset = "preset" in d;
      const hasRange = "from" in d || "to" in d;
      if (hasPreset && hasRange) {
        // {preset} 与 {from,to} 是 AiDateFilter 联合类型里互斥的两个分支。
        // 两个都给时若默默采用 preset，返回的对象就不再满足 AiDateFilter——
        // 「ok:true 蕴含结果符合 AiQuery」这条保证会被击穿，而它正是函数末尾那个
        // `raw as unknown as AiQuery` 转型唯一的依据。
        fail("bad_date", "date", "preset 与 from/to 不能同时给");
      } else if (hasPreset) {
        if (!isEnum(PRESET_KEYS, d.preset)) {
          fail("bad_date_preset", "date.preset", `preset 必须是 ${PRESET_KEYS.join(" / ")} 之一`);
        }
      } else if (hasRange && !("from" in d && "to" in d)) {
        // 只给了一边：点明缺的是哪个，比泛化的「二者之一」有用得多
        fail("bad_date", "from" in d ? "date.to" : "date.from", "from 与 to 必须同时给");
      } else if ("from" in d && "to" in d) {
        const fromOk = typeof d.from === "string" && DATE_RE.test(d.from);
        const toOk = typeof d.to === "string" && DATE_RE.test(d.to);
        if (!fromOk) fail("bad_date", "date.from", "from 必须是 YYYY-MM-DD");
        if (!toOk) fail("bad_date", "date.to", "to 必须是 YYYY-MM-DD");
        if (fromOk && toOk && (d.from as string) > (d.to as string)) {
          fail("bad_date", "date", "from 不能晚于 to");
        }
      } else {
        // 走到这里说明 preset / from / to 一个都没有。若原因是键名拼错（start、presett…），
        // 上方已给出精确到键的 unknown_key——再补一句泛化的「必须是 {preset} 或 {from,to}」
        // 等于把同一个问题报两遍，模型拿到的是噪音而不是线索。所以只在键都认识、
        // 单纯没给够（`{}`）时才报形状错误。
        if (!hasUnknownKey) {
          fail("bad_date", "date", "date 必须是 {preset} 或 {from,to} 二者之一");
        }
      }
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
    // account 是**标量**（单个账户名，由 resolveFilter 走 matchOne），所以不能复用
    // bad_string_array——那会告诉模型「这里该给数组」，而 merchant 这种同样为标量的字段
    // 又有自己的 bad_merchant 码，两边不一致。错误码是模型用来改错的唯一线索，不能含糊。
    fail("bad_account", "account", "account 必须是非空字符串");
  }

  if (raw.merchant !== undefined && !isNonEmptyString(raw.merchant)) {
    fail("bad_merchant", "merchant", "merchant 必须是非空字符串");
  }

  if (raw.amount !== undefined) {
    const a = raw.amount;
    if (!isPlainObject(a)) {
      fail("bad_amount", "amount", "amount 必须是 {min?, max?}");
    } else {
      // 内层键白名单。放行 {minn:500} 的后果最严重：金额过滤被**静默丢弃**，
      // 模型得不到任何错误线索，用户拿到一个看起来正常、其实没按金额筛选的答案。
      for (const key of Object.keys(a)) {
        if (!(AMOUNT_KEYS as readonly string[]).includes(key)) {
          fail("unknown_key", `amount.${key}`, `amount 里不认识的字段 ${key}`);
        }
      }
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
