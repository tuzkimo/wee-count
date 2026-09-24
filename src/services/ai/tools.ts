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
  type AiGroupBy,
  type AiQuery,
  type AiQueryError,
  type AiTxType,
} from "@/services/ai/dsl";
import {
  resolveFilter,
  type LookupAccount,
  type LookupContext,
  type ResolveError,
} from "@/services/ai/resolve";
import type { AiGroup, AiTotals, AiQueryItem } from "@/services/ai/querySql";
import { runQuery, type RunQueryFailure } from "@/services/ai/runQuery";
// 工具名来自**唯一来源**（Ruling 43）：schema 与 prompt 都从这里取值，不再各写一份。
// 这里给常量取别名 `…_NAME`：本文件已有同名的 `QUERY_TOOL` / `DRAFT_TOOL`（ToolSchema 对象），
// 别名把"名字"与"schema"两件事在代码里也区分开。
import {
  DRAFT_TOOL as DRAFT_TOOL_NAME,
  QUERY_TOOL as QUERY_TOOL_NAME,
  TOOL_NAMES,
} from "@/services/ai/toolNames";
import { getUserDb } from "@/db/userDb";
import { otherAccountLabel } from "@/services/ai/prompt";
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
 * 它们的关系由一条前提守卫钉住（`AI_QUERY_MAX_ITEMS <= MAX_PROMPT_ITEMS`），
 * 而那条守卫是"本层 slice 不会真的丢条"这个结论的**前提**（见 queryTool 里的注释）。
 */
export const MAX_PROMPT_ITEMS = 20;

const BUCKET_LABEL: Record<AiTxType, string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

/**
 * `refs` 的键 → 它是什么（生成给模型的 `refsNote` 用）。
 *
 * **每个键都必须在这里有说法**：`describeRefs` 只遍历 `Object.keys(refs)`，
 * 遇到没有说法的键直接抛 —— "note 提到的键 ⊆ refs 的键"和"refs 的键都被解释过"
 * 这两条同时成立，而且都只有一个来源（`refs` 自己）。
 * 注意 `*.avg` 断言的是"平均值"而不是"总额"：金额引用写错语义是静默错数字。
 */
const REF_PROMISES: Record<string, (key: string) => string> = {
  total: (key) => `${key} 是总额`,
  count: (key) => `${key} 是笔数`,
  avg: (key) => `${key} 是平均值`,
  matched: (key) => `${key} 是命中的全部笔数`,
  net: (key) => `${key} 是净额`,
};

/** 分组桶的引用键（`q1.g0.total` 这类）与它的说法。F1 的同一份派生逻辑覆盖了它们 */
const GROUP_REF_PROMISES: Record<string, string> = {
  total: "总额",
  label: "分组名",
  count: "笔数",
};

const REF_KEY_RE = /^q(\d+)\.(.+)$/;
const GROUP_REF_KEY_RE = /^g(\d+)\.(\w+)$/;

/**
 * M1 的成员分组用 `user_id` 作分组键，`runQuery` 用 `ctx.members` 里的昵称替换；
 * 查不到时它兜底成 `id.slice(0, 8)`（`runQuery.ts` 的 `SHORT_ID_LEN`）。
 *
 * ⚠️ **8 位十六进制片段也是 id 片段，§7.3 说"绝不发 id"**。今天漏出去的形态恰好躲过
 * 所有断言（`UUID_RE` 看不见 8 位短串、账本 id 也不出现），所以这一层不依赖"猜它像不像
 * id"，而是**按来源判别**：member 分组的 label 必须能在 `lookup.members` 里找到同名成员，
 * 找不到就换成这个中性标签（原始 id 若要本地用，只留在 `payload` 里）。
 */
const UNKNOWN_MEMBER_LABEL = "未知成员";

/**
 * 逐字段取值。写成泛型索引而不是 `it[k]`：`AiGroup`/`AiQueryItem` 上没有索引签名，
 * `it[k]` 在 TS 严格模式下取到的是 `any`（本仓禁止）。
 */
function pick<T, K extends keyof T>(it: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = it[k];
  return out;
}

const GROUP_FIELDS = ["label", "expense", "income", "transfer", "count"] as const;

/** 进内容的 group：**逐字段白名单**（与 `items` 的 `toPromptItem` 同一条纪律），
 *  且 member 分组的 label 必须来自 lookup，否则换成中性标签（见 UNKNOWN_MEMBER_LABEL）。
 *
 *  **导出只为测试**：这条白名单要挡的形态是"M1 将来给 `AiGroup` 多加一个字段"，
 *  而那种字段今天不存在，只有直接喂一个带多余字段的对象才验得出来（tools.test.ts 的 F6）。
 *  从 `executeTool` 走的话多余字段得先经过 M1 的类型，测不了；改 M1 又是禁区。
 *  断言方式是"两条一起"：`toEqual` 五字段**且** `Object.keys` 里没有多余键。 */
export function toPromptGroups(groups: AiGroup[] | null, groupBy: AiGroupBy | undefined, lookup: LookupContext): AiGroup[] | null {
  if (groups === null) return null;
  return groups.map((g) => {
    const safe = pick(g, GROUP_FIELDS);
    const resolved = groupBy !== "member" || lookup.members.some((m) => m.name === safe.label);
    return resolved ? safe : { ...safe, label: UNKNOWN_MEMBER_LABEL };
  });
}

/**
 * 把这份 `refs` 的**每个键**解释给模型。文字全部由 `Object.keys(refs)` 派生 ——
 * 这里没有第二份"键清单"，所以 note 不可能承诺一个 `refs` 里不存在的键。
 *
 * 为什么非这样不可：note 里出现而 `refs` 里没有的键，会诱导模型写出一条
 * `fillRefs` 查不到的引用，于是**用户直接看到裸 `{{q1.transfer.total}}`**（§7.2 的
 * 既定行为：宁可暴露占位符，也不塞错数字）。旧版 note 无条件宣称
 * "`q1.expense / income / transfer.*` 是各桶、`q1.net` 是净额"，而 `type` 省略时
 * `transfer` 桶是 `null`（不给键）、`type` 指定时没有 `net` —— 两种形态各承诺了一个
 * 不存在的键。派生之后这类承诺在结构上不可能出现。
 */
function describeRefs(refs: Record<string, string | number>, primary: AiTxType, typed: boolean): string {
  const sorted = Object.keys(refs).sort();
  const notes: string[] = [];

  // 聚合键（`q1.total` 这类）。分组键单独在下面处理。
  const plain = sorted.filter((k) => {
    const m = REF_KEY_RE.exec(k);
    return m !== null && !GROUP_REF_KEY_RE.test(m[2]);
  });
  const grouped = sorted.filter((k) => {
    const m = REF_KEY_RE.exec(k);
    return m !== null && GROUP_REF_KEY_RE.test(m[2]);
  });

  for (const key of plain) {
    const m = REF_KEY_RE.exec(key);
    if (m === null) continue;
    // 键有两级形态：`q1.total` 与 `q1.expense.count`。说法按**最后一段**取，
    // 所以每个 key 都必须匹配到一条说法 —— 遇到没有说法的键直接抛，绝不静默跳过：
    // 新加一个 refs 键却忘了给它说法，模型就会拿到一个没被解释过、只能干猜的键。
    // 用下标取最后一段而不是 `.at(-1)`：本仓的 tsconfig lib 够不到 `Array.prototype.at`
    // （类型门会报 TS2550，运行期也可能在旧 WebView 上缺失）。
    const segments = m[2].split(".");
    const leaf = segments[segments.length - 1] ?? "";
    const promise = REF_PROMISES[leaf];
    if (promise === undefined) throw new Error(`refs 里有 ${key}，但 REF_PROMISES 没有它的说明`);
    if (leaf === "total" || leaf === "avg") {
      let text = promise(key);
      // 桶说明**只贴裸键**（`q1.total` / `q1.avg`：`m[2]` 里没有第二段）。
      //
      // 上一版对**每个** `*.total` 都贴这句，于是 note 里出现
      // `q1.income.total 是总额（你没给 type，这里按「支出」桶给）` —— 它的值是**收入**
      // 桶总额，而 prompt 要求"引用一律以 refsNote 为准"（prompt.ts:132），模型照它
      // 写引用就会把收入金额当支出报给用户。带桶名的键自己就说明了桶（`q1.income.total`），
      // 再贴一句别的桶是**错的**；裸键才是唯一需要说明"没给 type 时指哪个桶"的形态，
      // 而 `q1.avg` 和 `q1.total` 一样是主桶（`runQueryTool` 里同一处赋值）。
      if (!m[2].includes(".")) {
        text += typed
          ? `（${BUCKET_LABEL[primary]}桶；你给了 type，所以只有这一个桶）`
          : `（你没给 type，这里按「${BUCKET_LABEL[primary]}」桶给）`;
      }
      notes.push(text);
      continue;
    }
    notes.push(promise(key));
  }

  if (grouped.length > 0) {
    const order = new Set<number>();
    const prefixes = new Set<string>();
    for (const key of grouped) {
      const m = REF_KEY_RE.exec(key);
      if (m === null) continue;
      const g = GROUP_REF_KEY_RE.exec(m[2]);
      if (g === null) continue;
      const promise = GROUP_REF_PROMISES[g[2]];
      if (promise === undefined) throw new Error(`refs 里有 ${key}，但 GROUP_REF_PROMISES 没有它的说明`);
      order.add(Number(g[1]));
      prefixes.add(m[1]);
    }
    const indexes = [...order].sort((a, b) => a - b);
    // 说明里的示例键必须**逐字取自已存在的 refs 键**：拼一个不存在的键就又会教模型写错引用
    const sample = `q${[...prefixes][0]}.g${indexes[0]}`;
    notes.push(
      `每个分组桶还有 ${sample}.total（总额）/ ${sample}.label（分组名）/ ${sample}.count（笔数）；` +
      `下标 ${indexes.join(" / ")} 依次对应 content.groups 的顺序（g0 是第一个）`,
    );
  }

  notes.push(
    `要报「一共几笔」请用 .matched（含转账，与流水页列出的条数一致）；` +
    `.count 只是「${BUCKET_LABEL[primary]}」桶的笔数，两者不同`,
  );
  return `${notes.join("；")}。明细最多 ${MAX_PROMPT_ITEMS} 条。`;
}

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
    name: QUERY_TOOL_NAME,
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
  note: { type: "string", description: "备注：标签装不下的补充信息" },
  tags: {
    type: "array",
    items: { type: "string" },
    description:
      "标签名数组，只用于补充分类 / 金额 / 时间 / 账户这些结构化字段装不下的信息（如用途、对象）。" +
      "不要用标签重复这些字段已经表达清楚的内容（例如分类已是「买菜」，就不要再打「生鲜」这类同义标签）；" +
      "能表达清楚的信息尽量用标签、少写备注（检索主要靠标签）。" +
      "只能用账本里已存在的标签名，不要自己编造——名字对不上的标签会让草稿生成失败。",
  },
};

const DRAFT_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: DRAFT_TOOL_NAME,
    description:
      "生成一条待用户确认的草稿（金额、分类、账户、日期、备注、tags），**不写库**。" +
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

/**
 * 成员身份表不可用时的**响亮失败**（§5.3 的失败矩阵：`{ok:false}` ⇒ 回喂模型一次 ⇒ 人话）。
 *
 * `LookupContext.members` 是"成员名 → `transactions.user_id`"的**唯一**桥梁，而真 id
 * 只有调用方能给：成员显示名要走 `useMemberInfo`（别名 > 昵称 > username 的唯一实现，
 * 是 Vue 侧的东西），工具层不依赖 Vue、不自己查 `team_members` —— 这条边界由
 * `tools.test.ts` 的「成员名只来自传入参数」钉着。
 *
 * ⇒ 空表意味着"这次对话没有成员身份信息"，此时**任何依赖成员的查询都必须拒绝**：
 *   - 成员筛选：`resolveFilter` 会在空池上判 `not_found`，把"没有身份信息"说成
 *     "这个账本还没有成员"（§M1 约束 7 明确要求区分这两件事）；
 *   - member 分组：`runQuery` 的兜底是 `user_id.slice(0, 8)`，再被 `toPromptGroups`
 *     换成「未知成员」⇒ 几个桶全叫「未知成员」，同样是**静默**答错。
 * 两种都比"查不了"更坏：用户会据此以为"小明没花过钱"。
 */
const MEMBERS_UNAVAILABLE_ERROR =
  "members_unavailable: 这次对话没拿到成员身份表（只有成员名字，没有对应的用户 id），所以按成员筛选 / 分组的结果不可信。" +
  "请直接告诉用户这次按成员查不了，建议到流水页用成员筛选；不要报 0，也不要猜成员";

async function runQueryTool(
  raw: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // 先自己校验再交给 runQuery：这样拿到的是**类型化**的 AiQuery（下面拼 refs 要用它的
  // type/groupBy），而不是从原始 JSON 里再猜一次。校验器只有一份，不是第二次实现。
  const validated = validateQuery(raw);
  if (!validated.ok) return { ok: false, error: describeInvalidQuery(validated.errors) };
  const query: AiQuery = validated.query;

  // 依赖成员的查询必须先确认"这次真有成员身份表"（见 MEMBERS_UNAVAILABLE_ERROR）。
  // 放在 `runQuery` **之前**：它连一次库都不该碰 —— 用一个空表去查，得到的是"0 行"这个
  // 看起来合理的结果，而不是"查不了"。
  const needsMembers = (query.members?.length ?? 0) > 0 || query.groupBy === "member";
  if (needsMembers && ctx.lookup.members.length === 0) {
    return { ok: false, error: MEMBERS_UNAVAILABLE_ERROR };
  }

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

  // 分组的引用键（F7：没有它们，"哪个分类花得最多"这类旗舰问题就写不出任何合法引用 ——
  // prompt 又禁止直接写数字，唯一的绕法是再查一次，而对 COALESCE 兜底标签必然 not_found）。
  // 顺序与 content.groups 逐项对应，下标就是 g 后面的编号。
  const groups = toPromptGroups(result.groups, query.groupBy, ctx.lookup);
  groups?.forEach((g, i) => {
    refs[`${prefix}.g${i}.label`] = g.label;
    refs[`${prefix}.g${i}.total`] = groupBucket(g, primary);
    refs[`${prefix}.g${i}.count`] = g.count;
  });

  // 明细上限：**两层截断都要如实上报**。
  //
  // `truncated` 不是"M1 的那个布尔值原样透传"这么简单：本层还有一次
  // `MAX_PROMPT_ITEMS` 截断，而 M1 的判据（`matched > items.length`）对"我们砍掉的
  // 条数"一无所知。于是旧实现在 `items.length > MAX_PROMPT_ITEMS` 时会把**砍掉 10 条**
  // 的结果标成 `truncated:false` —— 对模型撒谎说"这份明细是完整的"。哪一层截断都算。
  //
  // 前提守卫（tools.test.ts 的 ②）：`AI_QUERY_MAX_ITEMS <= MAX_PROMPT_ITEMS`。
  // 生产链路上 M1 的明细 SQL 自带 `LIMIT min(limit, AI_QUERY_MAX_ITEMS)`
  // （`buildItemsSql` ⇒ querySql.ts:356），所以今天 slice 从不真的丢条；守卫写反了
  // 就永远红不了，也就保护不了这条推理。
  const rawItems = result.items;
  const items = rawItems === null
    ? null
    : rawItems.slice(0, MAX_PROMPT_ITEMS).map(toPromptItem);
  const droppedItems = rawItems !== null && rawItems.length > MAX_PROMPT_ITEMS;
  const truncated = result.truncated || droppedItems;

  // refsNote 的键清单**完全由 refs 派生**（见 describeRefs 的注释）：note 只解释
  // 这份结果里真实存在的键，不承诺任何别的。
  const refsNote = describeRefs(refs, primary, query.type !== undefined);

  const content = JSON.stringify({
    summary: {
      expense: result.expense,
      income: result.income,
      transfer: result.transfer,
      net: result.net,
      matched: result.matched,
    },
    groups,
    items,
    truncated,
    refs,
    refsNote,
  });

  return {
    ok: true,
    refs,
    // payload 只给本地（芯片跳转 / 会话回放）：**带 id**，绝不进 content。
    payload: { chips: [applied], refs, matched: result.matched, truncated },
    content,
  };
}

/** 分组桶里"主桶"的金额（与 `refs[total]` 同一口径：type 省略时就是支出桶） */
function groupBucket(g: AiGroup, type: AiTxType): number {
  return type === "expense" ? g.expense : type === "income" ? g.income : g.transfer;
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

/**
 * 草稿的**规范形状**（`create_transaction_draft` 的产出）。
 *
 * ⚠️ 导出它是为了让 store 侧**不再重声明第二份**（Ruling 66 R3）：`stores/aiChat.ts` 用
 * `import type` 引它（类型擦除 ⇒ 不会把本文件的 `@/db/userDb` 拖进 store 的运行期模块图）。
 * 两份手写形状一旦漂移是**静默**的 —— store 的 `readDrafts` 会把形状不全的草稿直接跳过，
 * 表现是"草稿卡不显示"而不是报错。
 */
export interface NormalizedDraft {
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

/**
 * 过滤后**一个可用账户都没有**时给模型的那句话。
 *
 * 必须是**确定性**的（"文案说真话"：没有候选时"请反问用户是哪个账户"没有信息量，
 * 模型只会回"无法分辨"，实机上就是这样记不了账）。
 */
export const NO_ACCOUNT_TEXT =
  "当前用户在这个账本里还没有可用的账户（记账只能用你自己的账户），请先在账户页创建一个账户，然后再说一遍这笔账。";

function accountCandidates(pool: LookupAccount[]): string {
  const names = pool.map((a) => a.name);
  return names.length > 0 ? names.join("、") : NO_ACCOUNT_TEXT;
}

/**
 * 转账**转入**侧的候选池：本人的账户 + 其他成员的账户（后者的名字带归属，见
 * `LookupContext.otherAccounts`）—— 与手动记账一致（`RecordPage.vue:61` 转账 to 侧
 * `scope="all"`：还钱给同事、转到家人的卡都是合法操作）。
 *
 * ⚠️ **只给转入用**：转出（fromAccount）与查询/筛选仍只看 `lookup.accounts`（只能是本人的）。
 */
function accountsForTransferIn(lookup: LookupContext): LookupAccount[] {
  return lookup.otherAccounts === undefined ? lookup.accounts : [...lookup.accounts, ...lookup.otherAccounts];
}

/**
 * `toAccount` 该用哪个池：**转账**的转入方可以是所有人的账户（手动记账 `RecordPage.vue:61`
 * 转账 to 侧 `scope="all"`），而**收入**的入账方只能是自己名下的（同处 `else` 分支的
 * `scope="own"`——钱不会进别人的账户）。
 */
function toAccountLookup(lookup: LookupContext, type: AiTxType): LookupContext {
  if (type !== "transfer") return lookup;
  return { ...lookup, accounts: accountsForTransferIn(lookup) };
}

/**
 * 转入侧的**同名保护**：模型只写了一个"我名下也有的裸名字"（`现金`），而别的成员名下也有
 * 同名账户 ⇒ 判歧义、让模型反问，绝不猜（猜错就是把钱转到错的账户上）。
 *
 * ⚠️ 判据刻意是"**值逐字等于本人账户名**"（大小写不敏感，与 `matchByName` 的精确匹配同口径）：
 * 写成"我的现金"或"小明的现金"都算**说了归属**（前者由包含匹配落到本人账户、后者唯一命中
 * 别人那条），不在这里拦 —— 否则"我的"这个说法就没法表达，用户会被反问到没路可走。
 */
function transferInAmbiguity(
  lookup: LookupContext,
  value: string,
  resolvedId: string,
): ResolveError | null {
  const own = lookup.accounts.find((a) => a.id === resolvedId);
  if (own === undefined) return null;
  if (value.trim().toLowerCase() !== own.name.toLowerCase()) return null;
  const shared = (lookup.otherAccounts ?? []).filter(
    (o) => (o.baseName ?? o.name).toLowerCase() === own.name.toLowerCase(),
  );
  if (shared.length === 0) return null;
  return {
    kind: "ambiguous",
    field: "accounts",
    value: value.trim(),
    candidates: [own.name, ...shared.map((o) => o.name)],
  };
}

/**
 * 名字 → id 的解析**复用 `resolveFilter`**（唯一那份匹配器：精确匹配、退化包含匹配、
 * 歧义判定、候选列表都在那里）。这里绝不重写一份 matcher —— 两份匹配器早晚语义分叉，
 * 而分叉的表现是"AI 解析出的账户"与"芯片/流水页的账户"不是同一个。
 *
 * 账户有两个方向（from / to），而 `AiFilter.account` 是**单个**字段（规格 §4.1 的决定），
 * 所以分两次调用：每次只解析一个账户，返回的 id 合并。分类用 `type` 消歧（「其他」收支都有）。
 *
 * ⚠️ 两个方向的**候选池不同**：转出只能是本人的账户，转入可以是所有人的
 * （`accountsForTransferIn`）—— 这是本函数唯一按方向分叉的地方。
 */
function resolveDraftNames(
  draft: NormalizedDraft,
  ctx: ToolContext,
): { ok: true; resolved: ResolvedDraftIds } | { ok: false; error: string } {
  const errors: ResolveError[] = [];
  const collect = (
    filter: Parameters<typeof resolveFilter>[0],
    lookup: LookupContext = ctx.lookup,
  ): ReturnType<typeof resolveFilter> => {
    const r = resolveFilter(filter, lookup, ctx.now);
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

  // 转出：只用**本人**账户（产品规则：不能用别人的账户出账）
  let fromAccountId: string | null = null;
  if (draft.fromAccount !== null) {
    const r = collect({ account: draft.fromAccount });
    if (r.ok) fromAccountId = r.resolved.accountId;
  }

  // 转入：**转账**时本人 + 其他成员的账户（收入只有本人那些）；同名而没说清归属时
  // 由 `transferInAmbiguity` 判歧义
  let toAccountId: string | null = null;
  if (draft.toAccount !== null) {
    const r = collect({ account: draft.toAccount }, toAccountLookup(ctx.lookup, draft.type));
    // `accountId` 为 null 只可能是"压根没给 account"（这里给了），但类型上是 `string | null`：
    // 显式判掉，别用 `!` 把可能性藏起来。
    if (r.ok && r.resolved.accountId !== null) {
      const resolvedId = r.resolved.accountId;
      const ambiguous =
        draft.type === "transfer"
          ? transferInAmbiguity(ctx.lookup, draft.toAccount, resolvedId)
          : null;
      if (ambiguous === null) toAccountId = resolvedId;
      else errors.push(ambiguous);
    }
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

/** 草稿里"名字 → **本地** id"的解析结果（给记账用，绝不上行）。导出理由同 `NormalizedDraft` */
export interface ResolvedDraftIds {
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
        `不认识的字段 ${unknown.join("、")}：${DRAFT_TOOL_NAME} 只接受 ` +
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

  // 过滤后一个可用账户都没有 ⇒ 任何记账**必然**失败（账户名解析不出 id）：直接给确定性的
  // "先去创建账户"，不让模型去反问用户"是哪个账户"（候选为空时那句话没有信息量，
  // 实机上模型会回"无法分辨"，用户就卡在这里）。
  // ⚠️ 放在这里（字段校验之后、必填校验之前）是刻意的：它同时覆盖"模型给了账户名"与
  //    "模型没给账户名"两条路 —— 走到下面那两条 missing_account 时，账户池必定非空。
  if (ctx.lookup.accounts.length === 0) {
    return { ok: false, error: `missing_account: ${accountCandidates(ctx.lookup.accounts)}` };
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
      error: `missing_account: ${BUCKET_LABEL[type]}必须指定 fromAccount（扣款 / 转出账户）。账本里你的账户：${accountCandidates(ctx.lookup.accounts)}。请反问用户是哪个账户`,
    };
  }
  if ((type === "income" || type === "transfer") && toAccount.value === null) {
    return {
      // 转入侧把**其他成员的账户**一起列出来（转账时它们合法，只是名字带归属）：少列了，
      // 用户说"转到小明的现金"时模型看不到这个选项，只能回一句"没有这个账户"。
      // 收入那一侧不列（钱不会进别人的账户，见 `toAccountLookup`）。
      ok: false,
      error: `missing_account: ${BUCKET_LABEL[type]}必须指定 toAccount（入账 / 转入账户）。可选账户：${accountCandidates(toAccountLookup(ctx.lookup, type).accounts)}。请反问用户是哪个账户`,
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
  // 显式标成 `string[]`：`TOOL_NAMES` 是 readonly 字面量元组，直接展开会推成
  // `("query_transactions" | "create_transaction_draft")[]` ⇒ `known.includes(name)` 里
  // 的 `name: string` 会报 TS2345（**类型门抓到的，测试全绿也看不见**）。
  const known: string[] = [...TOOL_NAMES];
  if (!known.includes(name)) {
    return { ok: false, error: `未知工具 ${name}：可用工具只有 ${known.join("、")}。不要发明新工具` };
  }

  const args = parseArgs(argsRaw);
  if (!args.ok) return { ok: false, error: args.error };

  try {
    if (name === QUERY_TOOL_NAME) return await runQueryTool(args.value, ctx);
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
 * 账户候选的作用域：把账本里的账户按归属切成**当前用户自己的**与**其他成员的**两组
 * （产品规则：记账只能用当前用户自己的账户；转入例外，见 `accountsForTransferIn`）。
 *
 * 口径照既有的两处（`useTransactionForm.availableAccounts:46-54`、`DraftCard.accountOptions:178-184`）：
 * **只在团队账本里**按 `owner_id` 过滤 —— 个人账本里账户就是自己的，多一道过滤只会把
 * （历史数据里 owner_id 与当前身份对不上的）自己的账户藏掉。
 *
 * ⚠️ 需要调用方注入：本层是服务层，不依赖 Vue / auth store，自己算不出"当前用户是谁"。
 *    `viewerUserId` 为空串（身份未知）时不过滤：此时说"你没有账户"是**假话**（我们自己不知道），
 *    宁可退回旧行为，也不能把"不知道"说成"没有"。
 */
export interface LookupScope {
  kind: "personal" | "team";
  viewerUserId: string;
}

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
 *
 * `scope` 不给 ⇒ 不过滤账户（旧行为；只该出现在不关心归属的调用里，生产路径由 store 注入）。
 */
export async function buildLookupContext(
  ledgerId: string,
  members: { userId: string; name: string }[],
  scope?: LookupScope,
): Promise<LookupContext> {
  const db = getUserDb();
  if (!db) return { categories: [], accounts: [], tags: [], members: [] };

  // 账户候选的归属过滤：团队账本 + 知道当前用户是谁时，**只**取他自己名下的账户。
  // 少了这一条，两个成员各有一个「现金」时会同时进解析表 ⇒ `resolve.ts:108` 判 ambiguous
  // （同名两个候选）⇒ 工具响亮失败、模型只能回"无法分辨"（实机缺陷）。
  const ownerId =
    scope !== undefined && scope.kind === "team" && scope.viewerUserId !== ""
      ? scope.viewerUserId
      : null;

  // 三条查询都带 ledger_id 与 is_deleted：少任一条件都会把别的账本（或已删）的名字
  // 变成解析候选，而"候选"会直接进反问给用户的那句话里。
  const categories = await db.select<{ id: string; name: string; type: "income" | "expense" }[]>(
    "SELECT id, name, type FROM categories WHERE ledger_id = ? AND is_deleted = 0",
    [ledgerId],
  );
  // 账户的 `owner_id` 仍然**只在本层用**（决定候选），不进返回的 LookupContext ——
  // §7.3：往上走一步就离"进 prompt"更近一步，而模型那边只需要名字。
  const accounts = await db.select<{ id: string; name: string }[]>(
    ownerId === null
      ? "SELECT id, name FROM accounts WHERE ledger_id = ? AND is_deleted = 0"
      : "SELECT id, name FROM accounts WHERE ledger_id = ? AND is_deleted = 0 AND owner_id = ?",
    ownerId === null ? [ledgerId] : [ledgerId, ownerId],
  );

  // 其他成员名下的账户：**只**喂转账的**转入**侧（`accountsForTransferIn`），与手动记账
  // `RecordPage.vue:61` 的 `scope="all"` 同口径。名字**带归属**（`小明的现金`），而且必须与
  // 提示词快照里那一组逐字相同 —— 模型照着快照写名字，这里才唯一命中。
  // 归属显示名来自调用方传进的成员表（store 的 `memberTable()`，走 useMemberInfo 的别名规则）。
  const ownerNames = new Map(
    members.filter((m) => typeof m.userId === "string" && m.userId !== "").map((m) => [m.userId, m.name]),
  );
  const otherRows =
    ownerId === null
      ? []
      : await db.select<{ id: string; name: string; owner_id: string }[]>(
          "SELECT id, name, owner_id FROM accounts WHERE ledger_id = ? AND is_deleted = 0 AND owner_id <> ?",
          [ledgerId, ownerId],
        );
  const otherAccounts = otherRows.map((a) => ({
    id: a.id,
    name: otherAccountLabel(ownerNames.get(a.owner_id), a.name),
    baseName: a.name,
  }));

  const tags = await db.select<{ id: string; name: string }[]>(
    "SELECT id, name FROM tags WHERE ledger_id = ? AND is_deleted = 0",
    [ledgerId],
  );

  return {
    categories,
    accounts,
    otherAccounts,
    tags,
    // ⚠️ 只收**真 id** 的成员行：id 一旦是 `undefined`（形状对不上：例如调用方给的是
    // `{id, name}` 而不是 `{userId, name}`），它就会以"解析成功"的姿态进 `resolveFilter`，
    // 最后变成 SQL 里的 `t.user_id IN (NULL)` ⇒ 对真流水**恒 0 行**，又是一次静默答错。
    // 丢掉这些行之后，成员表要么是真实身份、要么为空 —— 为空时由 `runQueryTool` 响亮失败。
    members: members
      .filter((m) => typeof m.userId === "string" && m.userId !== "")
      .map((m) => ({ id: m.userId, name: m.name })),
  };
}
