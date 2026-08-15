/**
 * 将 Date 对象转为本地时间的 datetime-local 格式字符串 "YYYY-MM-DDTHH:mm"。
 * 区别于 toISOString() 返回 UTC 时间，本函数返回用户所在时区的本地时间。
 */
export function toLocalDatetimeString(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

/**
 * 将 UTC ISO 字符串转为本地时间的 datetime-local 格式。
 * 用于从数据库读出的 UTC 时间转为表单可用的本地时间。
 */
export function utcToLocalDatetimeString(isoString: string): string {
  return toLocalDatetimeString(new Date(isoString));
}

/**
 * 将 UTC ISO 字符串转为本地时区的 "YYYY-MM-DD" 日期 key。
 * 用于流水按天分组：直接 slice(0,10) 取的是 UTC 日期，
 * 东八区 0–8 点的流水会被并到 UTC 的上一天。
 * 这里通过 Date 的本地年/月/日取值，确保按用户所在时区归天。
 */
export function utcToLocalDateKey(isoString: string): string {
  const d = new Date(isoString);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 将本地时区的 "YYYY-MM-DD" 日期 key 解析为 Date（本地当天 00:00）。
 * 注意：必须用 "YYYY-MM-DDTHH:mm" 形式构造，避免 "YYYY-MM-DD" 被当作 UTC 解析。
 */
export function localDateKeyToDate(dateKey: string): Date {
  return new Date(`${dateKey}T00:00`);
}

// 日期 key（"YYYY-MM-DD"）→ "M月D日 周X"
export function formatDateLabel(dateKey: string): string {
  const d = localDateKeyToDate(dateKey);
  const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekDay = weekDays[d.getDay()];
  return `${month}月${day}日 ${weekDay}`;
}

// 筛选摘要的日期范围展示（from/to 是含 "T" 的本地时间串）
export function formatDateRange(from: string, to: string): string {
  if (from && to) {
    const [fd] = from.split("T");
    const [td] = to.split("T");
    if (fd === td) return fd;
    return `${fd} ~ ${td}`;
  }
  if (from) return `${from.split("T")[0]} 起`;
  if (to) return `至 ${to.split("T")[0]}`;
  return "";
}
