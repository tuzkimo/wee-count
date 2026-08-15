// 筛选「是否默认查当月」判定的单一事实来源。
// 首页模式（非账户详情）且无任何筛选参数时，列表默认查当月；
// buildFetchOpts 与 filterSummary 共用它，避免「列表实际查全时间、摘要却显示当月」的错配。
export interface DefaultMonthFilter {
  account?: string;
  dateFrom?: string;
  dateTo?: string;
  tags?: string;
  categories?: string;
  members?: string;
}

export function isDefaultCurrentMonth(
  isAccountMode: boolean,
  accountId: string | null | undefined,
  q: DefaultMonthFilter,
): boolean {
  const accId = isAccountMode ? accountId : q.account;
  return !isAccountMode && !q.dateFrom && !q.dateTo && !q.tags && !q.categories && !q.members && !accId;
}
