// M1 的执行入口：校验 → 解析名字 → 查库 → 整形（必要时派生区间）。
//
// 这是本模块**唯一**碰 DB 的地方；dsl / range / resolve / querySql 全是纯函数，
// 可以脱离 Tauri 单独单测。因此「AI 只能读」这条约束在这里最容易失守，也只需要
// 在这里守一次：本文件只调用 `db.select`，**一次 `db.execute` 都没有**。
import { getUserDb } from "@/db/userDb";
import { utcToLocalDateKey } from "@/utils/datetime";
import {
  validateQuery,
  type AiQuery,
  type AiQueryError,
} from "@/services/ai/dsl";
import {
  resolveFilter,
  type AppliedFilter,
  type LookupContext,
  type ResolveError,
} from "@/services/ai/resolve";
import {
  buildGroupsSql,
  buildItemsSql,
  buildSummarySql,
  shapeGroups,
  shapeItems,
  shapeSummary,
  type AiQueryResult,
  type GroupRow,
  type ItemRow,
  type SummaryRow,
} from "@/services/ai/querySql";

export type RunQueryFailure =
  | { kind: "invalid"; errors: AiQueryError[] }
  | { kind: "unresolved"; errors: ResolveError[] }
  | { kind: "no_db" };

export type RunQueryOutcome =
  | { ok: true; result: AiQueryResult; applied: AppliedFilter }
  | { ok: false; failure: RunQueryFailure };

/** 成员显示名的兜底长度，与 useMemberInfo 一致：绝不把完整 UUID 交给模型 */
const SHORT_ID_LEN = 8;

/**
 * 成员分组时把 user_id 换成显示名。
 *
 * querySql 是纯函数、拿不到成员昵称/别名，所以这一层负责替换。兜底取 id 前 8 位：
 * 直接回传完整 UUID 会让模型把一串十六进制当成有意义的内容复述给用户。
 */
function memberLabel(userId: string, ctx: LookupContext): string {
  return ctx.members.find((m) => m.id === userId)?.name ?? userId.slice(0, SHORT_ID_LEN);
}

/**
 * 「不限时间」时用来把边界显式化的派生查询。
 *
 * 两条恒定约束与 buildWhere 一致，**一个都不能漏**：漏 `ledger_id` 会把别的账本的
 * 时间跨度带进来，漏 `is_deleted = 0` 则让已删流水把芯片的日期区间撑大。
 *
 * 导出是为了让 sqlSmoke.test.ts 在真实 SQLite 上执行**同一条** SQL——在测试里
 * 抄一份字符串，抄错或只改一处都不会有人发现。
 */
export const FULL_RANGE_SQL =
  "SELECT MIN(t.occurred_at) AS min_at, MAX(t.occurred_at) AS max_at" +
  " FROM transactions t WHERE t.ledger_id = ? AND t.is_deleted = 0";

interface FullRangeRow {
  min_at: string | null;
  max_at: string | null;
}

/**
 * 派生「覆盖该账本全部数据」的真实区间。
 *
 * 存在的理由是首页那条规则：`isDefaultCurrentMonth` 把「零筛选条件」当成「默认查当月」。
 * 所以当一个查询不限时间时，"不带 dateFrom/dateTo"这个表达在跳转到流水页后会**被悄悄
 * 改写成当月**——AI 回答的总额和用户点进去看到的数字对不上。加一个 URL 标志位也能解决，
 * 但那要 `FilterPage` 多一个控件，且它现有的日期按钮本来就写着「全部时间」，两个同名
 * 概念会打架。
 *
 * 把无边界变成有边界更干净：查一次 MIN/MAX，把范围显式化。这个区间覆盖全部交易，
 * 对聚合 SQL 不产生任何过滤效果（`matched` 不变），只是让 applied 有具体日期可带。
 *
 * 注意只在 `f.range === null` 时调用；账本一笔记录都没有时返回 null，退回无条件——
 * 此时给出一个"有边界"的区间反而是凭空造出两个假日期。
 */
async function deriveFullRange(
  db: NonNullable<ReturnType<typeof getUserDb>>,
  ledgerId: string,
): Promise<{ from: string; to: string } | null> {
  const rows = await db.select<FullRangeRow[]>(FULL_RANGE_SQL, [ledgerId]);
  const row = rows[0];
  // 只给半边（理论上不会发生，但 MIN/MAX 分属两列）也必须整体放弃：
  // 半边区间会让芯片跳转后静默截掉一半数据。
  if (!row?.min_at || !row?.max_at) return null;
  return { from: utcToLocalDateKey(row.min_at), to: utcToLocalDateKey(row.max_at) };
}

/**
 * 查询执行入口。
 *
 * 失败分支（not_an_object / 校验失败 / 名字解析失败 / 无 DB 连接）**一律不查库**：
 * 模型拿到错误后要能便宜地重试，而一个"条件没解析成功却先扫了一遍全表"的实现
 * 会在多轮纠错里反复付出全表扫描的代价。
 *
 * 只读：本函数（以及整个 M1）**不产生任何写操作**，`db.execute` 一次都不会被调用。
 * 「AI 只能读 + 生成草稿，绝不直接落库」这条权限边界在 M1 就由结构保证，不靠约定。
 * 对应的断言在 runQuery.test.ts 的成功/失败两类用例里都有。
 */
export async function runQuery(
  ledgerId: string,
  raw: unknown,
  ctx: LookupContext,
  now: Date = new Date(),
): Promise<RunQueryOutcome> {
  const validated = validateQuery(raw);
  if (!validated.ok) {
    return { ok: false, failure: { kind: "invalid", errors: validated.errors } };
  }
  const q: AiQuery = validated.query;

  const resolved = resolveFilter(q, ctx, now);
  if (!resolved.ok) {
    return { ok: false, failure: { kind: "unresolved", errors: resolved.errors } };
  }
  const f = resolved.resolved;

  const db = getUserDb();
  if (!db) return { ok: false, failure: { kind: "no_db" } };

  const summarySql = buildSummarySql(ledgerId, f);
  const summaryRows = await db.select<SummaryRow[]>(summarySql.sql, summarySql.params);
  const summary = shapeSummary(summaryRows[0], f.type);

  let groups: AiQueryResult["groups"] = null;
  let groupsTruncated = false;
  const groupBy = q.groupBy;
  if (groupBy) {
    const frag = buildGroupsSql(ledgerId, q, f);
    const rows = await db.select<GroupRow[]>(frag.sql, frag.params);
    groups = shapeGroups(rows).map((row) =>
      groupBy === "member" ? { ...row, label: memberLabel(row.label, ctx) } : row,
    );
    // 分组被 LIMIT 截断时，各桶之和会小于 matched。不标记就是让模型拿一份残缺的
    // 分布去回答"哪个分类花得最多"。
    groupsTruncated = summary.matched > groups.length;
  }

  let items: AiQueryResult["items"] = null;
  if (q.aggregate === "list") {
    const frag = buildItemsSql(ledgerId, q, f);
    items = shapeItems(await db.select<ItemRow[]>(frag.sql, frag.params));
  }

  // 不限时间时把边界显式化，让芯片跳转不会被首页的「默认当月」改写
  const applied = resolved.applied;
  if (f.range === null) {
    const derived = await deriveFullRange(db, ledgerId);
    if (derived) {
      applied.dateFrom = derived.from;
      applied.dateTo = derived.to;
    }
  }

  return {
    ok: true,
    applied,
    result: {
      ...summary,
      groups,
      items,
      truncated: groupsTruncated || (items !== null && summary.matched > items.length),
    },
  };
}
