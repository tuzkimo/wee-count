import type { AppliedFilter } from "@/services/ai/resolve";

/**
 * AppliedFilter → 流水页路由 query。
 *
 * 参数名必须与 `FilterPage.apply()` 写出、`TransactionList.buildFetchOpts()` 读取的
 * 那一套完全一致：account / dateFrom / dateTo / tags / categories / members /
 * uncategorized / note / amountMin / amountMax / type。
 * 任何一边改名而另两边没跟着改，条件就会被**静默丢掉**——FilterPage 点「应用筛选」时
 * 是按自己的控件重建 query 的，它不认识的参数会消失。
 *
 * 账户用单数 `account`：流水页与 fetchAll 的账户筛选都是单选，这是刻意对齐（规格 §4.1）。
 *
 * 这里**没有任何特例分支**是设计的结果：首页把「零条件」当成「默认查当月」，所以
 * "不限时间"光靠"不带日期"表达不出来。解法不是在 URL 里造一个标志位，而是让
 * runQuery 在 DSL 没给 date 时派生出覆盖全部数据的真实区间——边界显式了，
 * 芯片就永远带具体日期，这个函数也就只需要做纯粹的字段映射。
 */
export function appliedToQuery(applied: AppliedFilter): Record<string, string> {
  const q: Record<string, string> = {};

  if (applied.dateFrom) q.dateFrom = applied.dateFrom;
  if (applied.dateTo) q.dateTo = applied.dateTo;
  if (applied.type) q.type = applied.type;
  if (applied.account) q.account = applied.account.id;
  if (applied.categories.length > 0) q.categories = applied.categories.map((c) => c.id).join(",");
  if (applied.tags.length > 0) q.tags = applied.tags.map((t) => t.id).join(",");
  if (applied.members.length > 0) q.members = applied.members.map((m) => m.id).join(",");
  if (applied.merchant) q.note = applied.merchant;
  if (applied.amountMin !== null) q.amountMin = String(applied.amountMin);
  if (applied.amountMax !== null) q.amountMax = String(applied.amountMax);

  return q;
}
