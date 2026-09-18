// DSL 里的名字 → 本地 id。纯模块：不 import @/db/userDb 或任何 Tauri 模块，
// 查找表全部由调用方以 LookupContext 传入（任务 8 的冒烟测试因此能在 import 阶段就通过）。
import { resolveRange, type ResolvedRange } from "@/services/ai/range";
import type { AiFilter, AiTxType } from "@/services/ai/dsl";

export interface LookupCategory {
  id: string;
  name: string;
  type: "income" | "expense";
}
export interface LookupAccount { id: string; name: string }
export interface LookupTag { id: string; name: string }
export interface LookupMember { id: string; name: string }

/** 解析所需的全部查找表。由调用方从各 store / userDb 组装，本模块不碰 DB */
export interface LookupContext {
  categories: LookupCategory[];
  accounts: LookupAccount[];
  tags: LookupTag[];
  members: LookupMember[];
}

export type LookupField = "categories" | "accounts" | "tags" | "members";

export interface ResolveError {
  kind: "not_found" | "ambiguous";
  field: LookupField;
  value: string;
  candidates: string[];
}

export interface ResolvedFilter {
  range: ResolvedRange | null;
  type: AiTxType | null;
  categoryIds: string[] | null;
  accountId: string | null;
  tagIds: string[] | null;
  memberIds: string[] | null;
  merchant: string | null;
  amountMin: number | null;
  amountMax: number | null;
}

export interface AppliedRef { id: string; name: string }

/** 解析后回显给用户/模型的条件，是芯片渲染与跳转流水页的唯一数据源 */
export interface AppliedFilter {
  dateFrom: string | null;
  dateTo: string | null;
  type: AiTxType | null;
  categories: AppliedRef[];
  account: AppliedRef | null;
  tags: AppliedRef[];
  members: AppliedRef[];
  merchant: string | null;
  amountMin: number | null;
  amountMax: number | null;
}

export type ResolveResult =
  | { ok: true; resolved: ResolvedFilter; applied: AppliedFilter }
  | { ok: false; errors: ResolveError[] };

interface Named { id: string; name: string }

const MAX_CANDIDATES = 5;

/**
 * 名字 → id。两轮匹配：
 * 1. 大小写不敏感的精确匹配
 * 2. 退化为双向包含匹配（模型可能给「招行」而库里是「招行储蓄卡」，也可能反过来）
 *
 * 命中 >1 个时判定 **ambiguous** 而不是随便取第一个：用户说「招行」而库里有储蓄卡和
 * 信用卡两张，猜错就是把钱记到错的账户上。返回候选让模型反问用户，比猜对一次更值钱。
 */
function matchByName(
  values: string[],
  pool: Named[],
  field: LookupField,
  errors: ResolveError[],
): string[] | null {
  if (values.length === 0) return null;
  const ids: string[] = [];
  for (const value of values) {
    const needle = value.trim().toLowerCase();
    // 空串（含"全是空白"的元素）**直接跳过**：若放它进去，`name.includes("")` 对每个名字都为真，
    // 会把整个池子变成"命中"。注意当前这条路径挡在 validateQuery 之后——dsl.ts 的
    // `v.some((s) => s.trim() === "")` 已经先拒掉了整元素为空白的数组，所以正常链路到不了这里。
    // 这里保留判断是**纵深防御**（本模块是导出的纯函数，不该假设调用方一定校验过），
    // 不是死代码，也**不要**因为"反正有校验"就删掉。
    if (needle === "") continue;
    const exact = pool.filter((it) => it.name.toLowerCase() === needle);
    const hits = exact.length > 0
      ? exact
      : pool.filter((it) => {
          const name = it.name.toLowerCase();
          return name.includes(needle) || needle.includes(name);
        });
    if (hits.length === 0) {
      errors.push({
        kind: "not_found",
        field,
        value: value.trim(),
        candidates: pool.slice(0, MAX_CANDIDATES).map((it) => it.name),
      });
      continue;
    }
    if (hits.length > 1) {
      errors.push({
        kind: "ambiguous",
        field,
        value: value.trim(),
        candidates: hits.slice(0, MAX_CANDIDATES).map((it) => it.name),
      });
      continue;
    }
    ids.push(hits[0].id);
  }
  return ids.length > 0 ? ids : null;
}

function matchOne(
  value: string | undefined,
  pool: Named[],
  field: LookupField,
  errors: ResolveError[],
): string | null {
  if (value === undefined) return null;
  const ids = matchByName([value], pool, field, errors);
  return ids === null ? null : ids[0];
}

function toAppliedRefs<T extends Named>(ids: string[] | null, pool: T[]): AppliedRef[] {
  // 去重：模型可能给出重复的名字（"盒马"、"盒马"），那是两个同 id 的 ref，
  // 页面上会出现两个一模一样的芯片。SQL 无害（同一个 tag_id 加两次），但 UI 是缺陷。
  return [...new Set(ids ?? [])].map((id) => ({
    id,
    name: pool.find((it) => it.id === id)?.name ?? id,
  }));
}

function toApplied(resolved: ResolvedFilter, ctx: LookupContext): AppliedFilter {
  const accountPool = ctx.accounts;
  const accountHit = accountPool.find((it) => it.id === resolved.accountId);
  return {
    dateFrom: resolved.range?.from ?? null,
    dateTo: resolved.range?.to ?? null,
    type: resolved.type,
    categories: toAppliedRefs(resolved.categoryIds, ctx.categories),
    account: resolved.accountId === null
      ? null
      : { id: resolved.accountId, name: accountHit?.name ?? resolved.accountId },
    tags: toAppliedRefs(resolved.tagIds, ctx.tags),
    members: toAppliedRefs(resolved.memberIds, ctx.members),
    merchant: resolved.merchant,
    amountMin: resolved.amountMin,
    amountMax: resolved.amountMax,
  };
}

/** 解析 filter。任何名字解析失败都**不**重试——那是语义歧义，该由模型反问用户 */
export function resolveFilter(
  filter: AiFilter,
  ctx: LookupContext,
  now: Date = new Date(),
): ResolveResult {
  const errors: ResolveError[] = [];
  const type = filter.type ?? null;

  // type 已知时用分类的 type 消歧（「其他」在收支两边都有）
  const categoryPool = type === "expense" || type === "income"
    ? ctx.categories.filter((c) => c.type === type)
    : ctx.categories;

  const categoryIds = matchByName(filter.categories ?? [], categoryPool, "categories", errors);
  const accountId = matchOne(filter.account, ctx.accounts, "accounts", errors);
  const tagIds = matchByName(filter.tags ?? [], ctx.tags, "tags", errors);
  const memberIds = matchByName(filter.members ?? [], ctx.members, "members", errors);

  if (errors.length > 0) return { ok: false, errors };

  const resolved: ResolvedFilter = {
    range: resolveRange(filter.date, now),
    type,
    categoryIds,
    accountId,
    tagIds,
    memberIds,
    merchant: filter.merchant?.trim() || null,
    amountMin: filter.amount?.min ?? null,
    amountMax: filter.amount?.max ?? null,
  };
  return { ok: true, resolved, applied: toApplied(resolved, ctx) };
}
