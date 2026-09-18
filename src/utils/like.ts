/**
 * SQLite LIKE 模式里的转义字符。
 *
 * 单引号在本项目里不需要处理——所有查询都用 `?` 占位符绑定参数，不走字符串拼接。
 */
export const LIKE_ESCAPE_CHAR = "\\";

/**
 * 转义 LIKE 模式中的元字符。`%` / `_` 是通配符，`\` 是转义字符本身，三者都必须转义；
 * 且 SQL 里必须写 `ESCAPE '\'`，否则转义符不生效、反斜杠会被当成普通字符。
 *
 * 不转义的后果不是「查不到」，是「查错」：搜「打折 50%」会命中所有备注，
 * 搜「a_b」会命中 "axb"。在记账场景里就是"这个月盒马花了多少"答出一个错数字。
 *
 * 实现必须是**单趟** regex replace：分成多趟替换会让先插入的反斜杠被后续趟次二次转义。
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `${LIKE_ESCAPE_CHAR}${ch}`);
}

/** 包成 LIKE 的「包含」模式并转义元字符。调用方一律用它，避免有人忘了转义 */
export function likePattern(keyword: string): string {
  return `%${escapeLike(keyword)}%`;
}

/**
 * 「备注或标签名命中关键词」的 SQL 条件片段（含外层括号，可直接用 AND 拼接）。
 *
 * **抽出来是因为有两处必须逐字一致**：AI 聚合（`services/ai/querySql.ts` 的
 * `buildWhere`）与流水页列表（`stores/transaction.ts` 的 `fetchAll`）。两边的
 * 关键词语义只要差一点，"AI 说这个月盒马花了 800"和"点进流水页看到 5 条"就会
 * 对不上，而用户无从判断哪个是错的。复制粘贴是让它们漂移的最快方式。
 *
 * 子查询用 `sq_tt` / `sq_tg` 而不是 `tt` / `tg`：`fetchAll` 的 QUERY 里外层已经
 * 有 `tg` 这个别名，同名会被内层遮蔽且**不报错**——一个手误就变成静默关联到外层表。
 * 取不冲突的名字，让笔误直接变成硬错误。
 *
 * 调用方负责按出现顺序 push 两次参数（同一个 LIKE 模式）。
 */
export function noteOrTagLikeClause(): string {
  return (
    `(t.note LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}' OR t.id IN (` +
    `SELECT sq_tt.transaction_id FROM transaction_tags sq_tt ` +
    `JOIN tags sq_tg ON sq_tg.id = sq_tt.tag_id AND sq_tg.is_deleted = 0 ` +
    `WHERE sq_tg.name LIKE ? ESCAPE '${LIKE_ESCAPE_CHAR}'))`
  );
}
