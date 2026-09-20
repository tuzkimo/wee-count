// 两个工具的 JSON Schema + 执行器 + LookupContext 组装。
//
// 依赖关系：本文件**可以**碰 DB（`buildLookupContext` 要读名字表），但两个执行器本身
// 只有 `query_transactions` 会经 `runQuery` 读库；`create_transaction_draft` 是**纯构造**，
// 一次 `db.execute`/`db.select` 都没有（tools.test.ts 的 ③ 是这条权限边界的唯一技术保证）。
//
// §7.3 的两条边界在本文件里落地，且各有独立的结构保证：
// 1. **进模型的内容不含任何 id**：`content` 由这里的白名单函数拼出来，
//    `payload`（带 id 的 chips / resolved）**只给本地**，绝不进 content。
// 2. **明细最多 20 条**：`MAX_PROMPT_ITEMS` 是这一层自己的常量（见其注释）。
import {
  AI_QUERY_MAX_LIMIT,
  AMOUNT_KEYS,
  AGGREGATES,
  DATE_KEYS,
  GROUP_BYS,
  ORDER_BYS,
  PRESET_KEYS,
  TX_TYPES,
  validateQuery,
  type AiQuery,
  type AiQueryError,
  type AiTxType,
} from "@/services/ai/dsl";
import {
  resolveFilter,
  type LookupContext,
  type ResolveError,
} from "@/services/ai/resolve";
import type { AiTotals, AiQueryItem } from "@/services/ai/querySql";
import { runQuery, type RunQueryFailure } from "@/services/ai/runQuery";
import { getUserDb } from "@/db/userDb";
import { toDateKey } from "@/utils/dateRange";
import { localDateKeyToDate, toLocalDatetimeString } from "@/utils/datetime";
import { round2 } from "@/utils/transaction";

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

export interface ToolContext {
  ledgerId: string;
  lookup: LookupContext;
  now: Date;
  /** 本次调用在编排循环里的序号（从 1 开始）。refs 的键前缀就是 `q<refIndex>` */
  refIndex: number;
}

export type ToolOutcome =
  | { ok: true; refs: Record<string, string | number>; payload: unknown; content: string }
  | { ok: false; error: string };

/**
 * 发给模型的明细条数上限（§7.3「明细条目最多发送前 20 条」）。
 *
 * **刻意不从 `AI_QUERY_MAX_ITEMS` 派生**：那个常量是 M1 的"SQL 取多少行"，
 * 这个是"最多发几条给模型"，是**隐私边界**的一部分。两者今天同值，但语义不同 ——
 * M1 若为了别的用途把取数放宽，隐私上限不该跟着悄悄放宽。
 * 它们的关系由一条前提守卫钉住（`MAX_PROMPT_ITEMS <= AI_QUERY_MAX_ITEMS`），
 * 而那条守卫是"truncated 原样透传"这个做法成立的**前提**（见 queryTool 里的注释）。
 */
export const MAX_PROMPT_ITEMS = 20;

const BUCKET_LABEL: Record<AiTxType, string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

// ---------------------------------------------------------------------------
// JSON Schema
//
// 字段名与 `dsl.ts` 的 `AiFilter` / `AiQuery` **逐字一致**（§8.E：两份手写的真相必须夹住，
// toolSchemaContract.test.ts 用"字段集合相同 + 每个字段的合法样本真被 validateQuery 接受"
// 两条行为级断言夹住它）。取值一律引用 dsl.ts 的常量，不在这里手写第二份字面量。
// ---------------------------------------------------------------------------

const QUERY_PROPERTIES: Record<string, unknown> = {
  date: {
    type: "object",
    description:
      `时间范围：{preset:"…"} 或 {from:"YYYY-MM-DD", to:"YYYY-MM-DD"}。` +
      `date 里只允许这些键：${DATE_KEYS.join(" / ")}`,
    properties: {
      preset: {
        type: "string",
        enum: [...PRESET_KEYS],
        description: "相对日期预设，按 system prompt 里的「今天」计算",
      },
      from: { type: "string", description: "起始日 YYYY-MM-DD（含当天）" },
      to: { type: "string", description: "结束日 YYYY-MM-DD（含当天）" },
    },
    additionalProperties: false,
  },
  type: {
    type: "string",
    enum: [...TX_TYPES],
    description: "收支类型；省略表示不按类型筛选（此时转账也会计入 matched）",
  },
  categories: {
    type: "array",
    items: { type: "string" },
    description: "分类名数组，必须与 system prompt 快照里的名字一致",
  },
  account: {
    type: "string",
    description: "单个账户名（流水页的账户筛选也是单选）",
  },
  tags: { type: "array", items: { type: "string" }, description: "标签名数组" },
  members: { type: "array", items: { type: "string" }, description: "成员昵称数组" },
  merchant: {
    type: "string",
    description: "备注或标签名的关键词（模糊匹配）",
  },
  amount: {
    type: "object",
    description: `金额区间（金额恒为正，比较绝对值）。amount 里只允许这些键：${AMOUNT_KEYS.join(" / ")}`,
    properties: {
      min: { type: "number", description: "下界（含），0 是有效值" },
      max: { type: "number", description: "上界（含）" },
    },
    additionalProperties: false,
  },
  aggregate: { type: "string", enum: [...AGGREGATES], description: "聚合方式（必填）" },
  groupBy: { type: "string", enum: [...GROUP_BYS], description: "分组维度" },
  orderBy: { type: "string", enum: [...ORDER_BYS], description: "排序方式" },
  limit: {
    type: "integer",
    description: `正整数；超过 ${AI_QUERY_MAX_LIMIT} 会被截断成 ${AI_QUERY_MAX_LIMIT}`,
  },
};

const QUERY_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "query_transactions",
    description:
      "查询当前账本的流水，只返回汇总值（各桶总额 / 笔数 / 分组）与" +
      `最多 ${MAX_PROMPT_ITEMS} 条精简明细，绝不返回完整流水或账户余额。` +
      "返回值里有一个 refs 键值表；回答里陈述数字时必须写 {{refs 的键}}（如 {{q1.total}}），不要自己写数字。",
    parameters: {
      type: "object",
      properties: QUERY_PROPERTIES,
      required: ["aggregate"],
      additionalProperties: false,
    },
  },
};

const DRAFT_PROPERTIES: Record<string, unknown> = {
  type: { type: "string", enum: [...TX_TYPES], description: "收支类型（必填）" },
  amount: { type: "number", description: "金额，恒为正（必填）" },
  category: { type: "string", description: "分类名；expense / income 必填，transfer 不给" },
  fromAccount: { type: "string", description: "扣款 / 转出账户名；expense / transfer 必填" },
  toAccount: { type: "string", description: "入账 / 转入账户名；income / transfer 必填" },
  occurredAt: { type: "string", description: '本地时间 "YYYY-MM-DDTHH:mm"；省略表示现在' },
  note: { type: "string", description: "备注" },
  tags: { type: "array", items: { type: "string" }, description: "标签名数组" },
};

const DRAFT_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "create_transaction_draft",
    description:
      "生成一条待用户确认的草稿（金额、分类、账户、日期、备注），**不写库**。" +
      "草稿已生成，等待用户确认；你不得声称已经记账成功——用户点了「确认」之后才会真正入账。",
    parameters: {
      type: "object",
      properties: DRAFT_PROPERTIES,
      required: ["type", "amount"],
      additionalProperties: false,
    },
  },
};

/** 模型能看到的两个工具，次序即 §4.2 的次序 */
export const TOOLS: ToolSchema[] = [QUERY_TOOL, DRAFT_TOOL];

// ---------------------------------------------------------------------------
// 错误文本：一律是**回给模型的一句话**，绝不抛（§4.3 的两条纠错路径都靠它）
// ---------------------------------------------------------------------------

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const FIELD_LABEL: Record<ResolveError["field"], string> = {
  categories: "分类",
  accounts: "账户",
  tags: "标签",
  members: "成员",
};

/**
 * 名字解析失败的文字说明（§4.3 的第二条纠错路径：**不是错误，是语义歧义**）。
 *
 * `candidates` 是空数组时**必须把事实说出来**（M1 约束 7）：给模型一个空候选列表，
 * 它只能干猜一个名字硬试。所以这里显式区分"账本里一个都没有"与"有候选但对不上"。
 */
function describeResolveError(e: ResolveError): string {
  const label = FIELD_LABEL[e.field];
  if (e.kind === "ambiguous") {
    return `${label}「${e.value}」有多个候选：${e.candidates.join("、")}。请反问用户指的是哪一个，不要自己猜`;
  }
  if (e.candidates.length === 0) {
    return `这个账本还没有${label}，所以「${e.value}」不存在。把这件事直接告诉用户，不要猜名字`;
  }
  return `${label}「${e.value}」在账本里找不到。账本现有的${label}是：${e.candidates.join("、")}。请反问用户指的是哪一个，不要自己猜`;
}

/** 校验错（§4.3 的第一条纠错路径：模型的格式错，让它照着 code/path 改一次） */
function describeInvalidQuery(errors: AiQueryError[]): string {
  const lines = errors.map((e) => `${e.path || "<根>"} ${e.code}: ${e.message}`);
  return `query 参数校验失败（请按下面的 code 与字段改正后重试一次）：${lines.join("；")}`;
}

function describeFailure(failure: RunQueryFailure): string {
  switch (failure.kind) {
    case "invalid":
      return describeInvalidQuery(failure.errors);
    case "unresolved":
      return `查询条件里的名字没能对上账本：${failure.errors.map(describeResolveError).join("；")}`;
    case "no_db":
      // 本地 DB 没就绪（冷启动/未登录）。这不是模型的错，也不该让它重试同一个查询。
      return "本地数据库还没就绪，这次查询没有执行。请告诉用户稍后再试，不要编造数字";
  }
}

// ---------------------------------------------------------------------------
// arguments 解析
// ---------------------------------------------------------------------------

type ArgsResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * 模型给的 arguments 可能是对象（正常）、JSON 字符串（把对象写成了字符串）、
 * 坏 JSON 字符串（截断/带解释文字）或别的什么东西。**一律不抛**：
 * 抛出去就变成编排循环的未捕获异常，而不是一条可以纠错的工具错误。
 */
function parseArgs(raw: unknown): ArgsResult {
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        ok: false,
        error: `arguments 不是合法 JSON（${errText(e)}）：请只输出一个 JSON 对象，不要带解释文字或多余的换行`,
      };
    }
    return parseArgs(parsed);
  }
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, value: raw as Record<string, unknown> };
  }
  return { ok: false, error: `arguments 必须是一个 JSON 对象，收到的是 ${Array.isArray(raw) ? "数组" : typeof raw}` };
}

// ---------------------------------------------------------------------------
// query_transactions
// ---------------------------------------------------------------------------

/**
 * 发给模型的明细项：**逐字段白名单**。
 *
 * 不用展开运算符 `{...item}`：§7.3 只允许日期 / 金额 / 类型 / 分类名 / 账户名 / 备注出去。
 * M1 的 `shapeItems` 今天已经只给这几个字段，但那是**另一层**的白名单 —— 将来 M1 若给
 * `AiQueryItem` 加上 id（芯片跳转要用），}`{...item}` 会把它顺手送给模型，而链路上
 * 没有任何地方会报错。这一层重抄一遍的代价是 7 行，换来的是"隐私边界不依赖上游"。
 */
function toPromptItem(it: AiQueryItem): Record<string, unknown> {
  return {
    date: it.date,
    amount: it.amount,
    type: it.type,
    category: it.category,
    fromAccount: it.fromAccount,
    toAccount: it.toAccount,
    note: it.note,
  };
}

async function runQueryTool(
  raw: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // 先自己校验再交给 runQuery：这样拿到的是**类型化**的 AiQuery（下面拼 refs 要用它的
  // type/groupBy），而不是从原始 JSON 里再猜一次。校验器只有一份，不是第二次实现。
  const validated = validateQuery(raw);
  if (!validated.ok) return { ok: false, error: describeInvalidQuery(validated.errors) };
  const query: AiQuery = validated.query;

  const outcome = await runQuery(ctx.ledgerId, query, ctx.lookup, ctx.now);
  if (!outcome.ok) return { ok: false, error: describeFailure(outcome.failure) };
  const { result, applied } = outcome;

  const prefix = `q${ctx.refIndex}`;
  const refs: Record<string, string | number> = {};

  // ⚠️ type 省略时 `total / count / avg` 指**支出**桶。
  // 依据是 prompt 自己的 few-shot：示例 2「今年在盒马买菜花了多少钱」调工具时
  // **没有给 type**，回答却写 `{{q1.total}} 元`（"花了"= 支出）。若省掉 type 时
  // 不给 total，示例给出的引用就会变成未知 key、原样漏给用户。
  // 为避免"没说清就错数字"，下面 refsNote 会把这件事写进给模型的内容里。
  const primary: AiTxType = query.type ?? "expense";
  const primaryBucket = bucketOf(result, primary);
  if (primaryBucket !== null) {
    refs[`${prefix}.total`] = primaryBucket.total;
    refs[`${prefix}.count`] = primaryBucket.count;
    refs[`${prefix}.avg`] = primaryBucket.avg;
  }
  // 各桶都给出显式键：模型问"收入多少"时能写 `q1.income.total`，不必再查一次。
  // null 的桶**不给键**（不是给 0）：用了未知 key 会原样暴露占位符并 console.warn，
  // 而给 0 会被模型当成"没有"（§4.2 的 null vs 0 同一条理由）。
  for (const type of TX_TYPES) {
    const bucket = bucketOf(result, type);
    if (bucket === null) continue;
    refs[`${prefix}.${type}.total`] = bucket.total;
    refs[`${prefix}.${type}.count`] = bucket.count;
  }
  if (result.net !== null) refs[`${prefix}.net`] = result.net;
  refs[`${prefix}.matched`] = result.matched;

  // ⚠️ truncated **原样透传**，不重算、不吞（M1 裁决 9）。
  // 本层还有一次 `MAX_PROMPT_ITEMS` 截断，为什么仍可以用原值：
  // M1 的明细 SQL 本身就 `LIMIT min(limit, 20)`（AI_QUERY_MAX_ITEMS），生产链路上
  // `items.length <= 20` 恒成立 ⇒ 本层的 slice 从不真的丢东西；能出现 `> 20` 条的状态，
  // 必然同时满足 `matched <= items.length`（M1 才会判 false），那也说明没有条目被丢掉。
  // 这条推理的前提由 `MAX_PROMPT_ITEMS <= AI_QUERY_MAX_ITEMS` 钉住（tools.test.ts 的 ②）。
  const items = result.items === null
    ? null
    : result.items.slice(0, MAX_PROMPT_ITEMS).map(toPromptItem);

  const refsNote =
    `${prefix}.total / count / avg 指「${BUCKET_LABEL[primary]}」桶` +
    (query.type === undefined ? "（你没指定 type，所以按支出桶给；" : "（") +
    `${prefix}.expense / income / transfer.* 是各桶，${prefix}.net 是净额，` +
    `${prefix}.matched 是命中的全部笔数（含转账）。明细最多 ${MAX_PROMPT_ITEMS} 条。`;

  const content = JSON.stringify({
    summary: {
      expense: result.expense,
      income: result.income,
      transfer: result.transfer,
      net: result.net,
      matched: result.matched,
    },
    groups: result.groups,
    items,
    truncated: result.truncated,
    refs,
    refsNote,
  });

  return {
    ok: true,
    refs,
    // payload 只给本地（芯片跳转 / 会话回放）：**带 id**，绝不进 content。
    payload: { chips: [applied], refs, matched: result.matched, truncated: result.truncated },
    content,
  };
}

function bucketOf(
  result: { expense: AiTotals | null; income: AiTotals | null; transfer: AiTotals | null },
  type: AiTxType,
): AiTotals | null {
  return type === "expense" ? result.expense : type === "income" ? result.income : result.transfer;
}

// ---------------------------------------------------------------------------
// create_transaction_draft
// ---------------------------------------------------------------------------

const DRAFT_FIELDS = [
  "type", "amount", "category", "fromAccount", "toAccount", "occurredAt", "note", "tags",
] as const;

const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/;

/**
 * 本地时间字符串 "YYYY-MM-DD" / "YYYY-MM-DDTHH:mm" 的完整校验。
 *
 * 日历合法性用 `localDateKeyToDate` + `toDateKey` 这对往返比较（与 dsl.ts 同一套解释，
 * 见那里的注释）：`2026-02-31` 会被 Date 滚到 3/3，光看形状看不出来；放它过去，
 * 用户点"确认"时 `new Date(occurredAt)` 会得到一个不存在的日期。
 */
function normalizeOccurredAt(v: unknown, now: Date): { ok: true; value: string } | { ok: false } {
  if (v === undefined) return { ok: true, value: toLocalDatetimeString(now) };
  if (typeof v !== "string") return { ok: false };
  const m = DATETIME_RE.exec(v.trim());
  if (m === null) return { ok: false };
  if (toDateKey(localDateKeyToDate(m[1])) !== m[1]) return { ok: false };
  if (m[2] !== undefined && (Number(m[2]) > 23 || Number(m[3]) > 59)) return { ok: false };
  return { ok: true, value: m[2] === undefined ? `${m[1]}T00:00` : v.trim() };
}

interface NormalizedDraft {
  type: AiTxType;
  amount: number;
  category: string | null;
  fromAccount: string | null;
  toAccount: string | null;
  occurredAt: string;
  note: string | null;
  tags: string[];
}

/** 名字列表的统一读法：非空字符串数组，元素去空白 */
function readNames(v: unknown): { ok: true; value: string[] } | { ok: false } {
  if (v === undefined) return { ok: true, value: [] };
  if (!Array.isArray(v) || v.some((it) => typeof it !== "string" || it.trim() === "")) {
    return { ok: false };
  }
  return { ok: true, value: (v as string[]).map((it) => it.trim()) };
}

function readName(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  return { ok: true, value: v.trim() === "" ? null : v.trim() };
}

function accountCandidates(ctx: ToolContext): string {
  const names = ctx.lookup.accounts.map((a) => a.name);
  return names.length > 0 ? names.join("、") : "（这个账本还没有账户）";
}

/**
 * 名字 → id 的解析**复用 `resolveFilter`**（唯一那份匹配器：精确匹配、退化包含匹配、
 * 歧义判定、候选列表都在那里）。这里绝不重写一份 matcher —— 两份匹配器早晚语义分叉，
 * 而分叉的表现是"AI 解析出的账户"与"芯片/流水页的账户"不是同一个。
 *
 * 账户有两个方向（from / to），而 `AiFilter.account` 是**单个**字段（规格 §4.1 的决定），
 * 所以分两次调用：每次只解析一个账户，返回的 id 合并。分类用 `type` 消歧（「其他」收支都有）。
 */
function resolveDraftNames(
  draft: NormalizedDraft,
  ctx: ToolContext,
): { ok: true; resolved: ResolvedDraftIds } | { ok: false; error: string } {
  const errors: ResolveError[] = [];
  const collect = (filter: Parameters<typeof resolveFilter>[0]): ReturnType<typeof resolveFilter> => {
    const r = resolveFilter(filter, ctx.lookup, ctx.now);
    if (!r.ok) errors.push(...r.errors);
    return r;
  };

  let categoryId: string | null = null;
  if (draft.category !== null) {
    const r = collect({
      type: draft.type === "transfer" ? undefined : draft.type,
      categories: [draft.category],
    });
    if (r.ok) categoryId = r.resolved.categoryIds?.[0] ?? null;
  }

  let fromAccountId: string | null = null;
  if (draft.fromAccount !== null) {
    const r = collect({ account: draft.fromAccount });
    if (r.ok) fromAccountId = r.resolved.accountId;
  }

  let toAccountId: string | null = null;
  if (draft.toAccount !== null) {
    const r = collect({ account: draft.toAccount });
    if (r.ok) toAccountId = r.resolved.accountId;
  }

  let tagIds: string[] = [];
  if (draft.tags.length > 0) {
    const r = collect({ tags: draft.tags });
    if (r.ok) tagIds = r.resolved.tagIds ?? [];
  }

  if (errors.length > 0) {
    return {
      ok: false,
      error: `草稿里的名字没能对上账本（请反问用户，不要自己猜）：${errors.map(describeResolveError).join("；")}`,
    };
  }
  return { ok: true, resolved: { categoryId, fromAccountId, toAccountId, tagIds } };
}

interface ResolvedDraftIds {
  categoryId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  tagIds: string[];
}

/**
 * 草稿工具：**纯构造，零 DB**。
 *
 * 校验规则**照抄 `RecordPage`**（规格 §10.7：草稿卡与记账页不许分叉）：
 * - 金额 > 0 且 `round2` —— 与 `utils/expression.ts` 的 `result <= 0 → null`、
 *   `utils/transaction.ts` 的 `round2` 同一套；
 * - `expense` / `transfer` 必有 fromAccount，`income` / `transfer` 必有 toAccount、
 *   转出≠转入 —— 与 `useTransactionForm.doSave` 的四个判断逐一对应（连措辞都照抄）。
 */
function createDraftTool(raw: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const unknown = Object.keys(raw).filter((k) => !(DRAFT_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    // 不静默忽略：模型写错字段名时（例如照 prompt 的 few-shot 写了 `merchant`），
    // 忽略等于把用户说的话悄悄丢掉。给一条能一轮改对的错误。
    return {
      ok: false,
      error:
        `不认识的字段 ${unknown.join("、")}：create_transaction_draft 只接受 ` +
        `${DRAFT_FIELDS.join(" / ")}（备注写 note；日期写 occurredAt，不是 date；没有 merchant）`,
    };
  }

  if (!(TX_TYPES as readonly string[]).includes(raw.type as string)) {
    return { ok: false, error: `bad_type: type 必须是 ${TX_TYPES.join(" / ")} 之一` };
  }
  const type = raw.type as AiTxType;

  const amount = raw.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "bad_amount: amount 必须是大于 0 的数字（记账金额恒为正，正负由 type 承载）" };
  }

  const occurredAt = normalizeOccurredAt(raw.occurredAt, ctx.now);
  if (!occurredAt.ok) {
    return { ok: false, error: 'bad_occurred_at: occurredAt 必须是真实存在的本地时间 "YYYY-MM-DD" 或 "YYYY-MM-DDTHH:mm"' };
  }

  const category = readName(raw.category);
  const fromAccount = readName(raw.fromAccount);
  const toAccount = readName(raw.toAccount);
  const note = readName(raw.note);
  const tags = readNames(raw.tags);
  if (!category.ok || !fromAccount.ok || !toAccount.ok || !note.ok || !tags.ok) {
    return { ok: false, error: "bad_string: 分类 / 账户 / 备注必须是非空字符串，tags 必须是非空字符串数组" };
  }

  // —— 必填校验（照抄 useTransactionForm.doSave 的四条） ——
  if (type === "transfer" && category.value !== null) {
    return { ok: false, error: "bad_combination: 转账没有分类，请去掉 category" };
  }
  if (type !== "transfer" && category.value === null) {
    return {
      ok: false,
      error: `missing_category: 请选择分类。账本里现有的分类：${
        ctx.lookup.categories.map((c) => `${c.name}(${BUCKET_LABEL[c.type]})`).join("、") || "（这个账本还没有分类）"
      }。请反问用户是哪个分类`,
    };
  }
  if ((type === "expense" || type === "transfer") && fromAccount.value === null) {
    return {
      ok: false,
      error: `missing_account: ${BUCKET_LABEL[type]}必须指定 fromAccount（扣款 / 转出账户）。账本里的账户：${accountCandidates(ctx)}。请反问用户是哪个账户`,
    };
  }
  if ((type === "income" || type === "transfer") && toAccount.value === null) {
    return {
      ok: false,
      error: `missing_account: ${BUCKET_LABEL[type]}必须指定 toAccount（入账 / 转入账户）。账本里的账户：${accountCandidates(ctx)}。请反问用户是哪个账户`,
    };
  }

  const draft: NormalizedDraft = {
    type,
    amount: round2(amount),
    category: category.value,
    fromAccount: fromAccount.value,
    toAccount: toAccount.value,
    occurredAt: occurredAt.value,
    note: note.value,
    tags: tags.value,
  };

  const names = resolveDraftNames(draft, ctx);
  if (!names.ok) return { ok: false, error: names.error };
  const { resolved } = names;

  // 转出 = 转入：名字相同就是同一个账户；名字不同但解析到同一个 id 也一样（"招行" vs "招行储蓄卡"）
  if (type === "transfer" && resolved.fromAccountId !== null && resolved.fromAccountId === resolved.toAccountId) {
    return { ok: false, error: "转出和转入账户不能相同（照 RecordPage 的同一条规则）" };
  }

  const parts = [
    `${BUCKET_LABEL[type]} ${draft.amount} 元`,
    draft.category === null ? null : `分类「${draft.category}」`,
    draft.fromAccount === null ? null : `转出账户「${draft.fromAccount}」`,
    draft.toAccount === null ? null : `转入账户「${draft.toAccount}」`,
    `日期 ${draft.occurredAt}`,
    draft.note === null ? null : `备注「${draft.note}」`,
    draft.tags.length === 0 ? null : `标签「${draft.tags.join("、")}」`,
  ].filter((s): s is string => s !== null);

  const prefix = `q${ctx.refIndex}`;
  const refs: Record<string, string | number> = { [`${prefix}.amount`]: draft.amount };

  return {
    ok: true,
    refs,
    payload: { drafts: [{ draftId: crypto.randomUUID(), draft, resolved }] },
    content:
      `已生成草稿，等待用户确认；你不得声称已经记账成功。草稿内容：${parts.join("；")}。` +
      `回复时请写「已生成草稿，请确认」，金额用 {{${prefix}.amount}} 引用，不要自己写数字。`,
  };
}

// ---------------------------------------------------------------------------
// 执行入口
// ---------------------------------------------------------------------------

/**
 * 执行一次工具调用。**任何情况下都不抛**：模型给的东西（工具名、arguments）全是运行时
 * 数据，抛出去只会变成编排循环里的未捕获异常；回一条 `{ok:false,error}` 才能让模型纠错。
 */
export async function executeTool(
  name: string,
  argsRaw: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const known = TOOLS.map((t) => t.function.name);
  if (!known.includes(name)) {
    return { ok: false, error: `未知工具 ${name}：可用工具只有 ${known.join("、")}。不要发明新工具` };
  }

  const args = parseArgs(argsRaw);
  if (!args.ok) return { ok: false, error: args.error };

  try {
    if (name === "query_transactions") return await runQueryTool(args.value, ctx);
    return createDraftTool(args.value, ctx);
  } catch (e) {
    // 真库错误（database is locked、SQL 拼错…）也走"回给模型的一句话"，
    // 但要说清是执行失败而不是"没有数据"——否则模型会把异常说成"这个账本查不到"。
    return { ok: false, error: `工具 ${name} 执行失败（本地错误，不是账号问题）：${errText(e)}` };
  }
}

// ---------------------------------------------------------------------------
// LookupContext 组装
// ---------------------------------------------------------------------------

/**
 * 组装名字解析所需的查找表：分类 / 账户 / 标签来自**本账本**的本地表，
 * 成员由调用方传入（成员显示名要经 `useMemberInfo` 的别名 > 昵称 > username 规则，
 * 那是 Vue 侧的东西，工具层不依赖 Vue —— 与 resolve.ts「查找表注入」同一条纪律）。
 *
 * DB 未就绪（冷启动 / 未登录）时返回**空表**而不是抛：此时整条 AI 链都不可用，
 * 上层拿到空表会走到"这个账本还没有标签"这类诚实的事实上。
 *
 * ⚠️ 但**不吞真正的查询异常**：若 `db.select` 抛了（库损坏 / 锁住），把它吞成"空表"
 * 会让模型对用户说"这个账本还没有账户"——把故障说成事实。这里让它抛，由编排层
 * 按 §5.3 映射成一条 assistant 错误消息。
 */
export async function buildLookupContext(
  ledgerId: string,
  members: { userId: string; name: string }[],
): Promise<LookupContext> {
  const db = getUserDb();
  if (!db) return { categories: [], accounts: [], tags: [], members: [] };

  // 三条查询都带 ledger_id 与 is_deleted：少任一条件都会把别的账本（或已删）的名字
  // 变成解析候选，而"候选"会直接进反问给用户的那句话里。
  const categories = await db.select<{ id: string; name: string; type: "income" | "expense" }[]>(
    "SELECT id, name, type FROM categories WHERE ledger_id = ? AND is_deleted = 0",
    [ledgerId],
  );
  const accounts = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM accounts WHERE ledger_id = ? AND is_deleted = 0",
    [ledgerId],
  );
  const tags = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM tags WHERE ledger_id = ? AND is_deleted = 0",
    [ledgerId],
  );

  return {
    categories,
    accounts,
    tags,
    members: members.map((m) => ({ id: m.userId, name: m.name })),
  };
}
