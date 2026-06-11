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
