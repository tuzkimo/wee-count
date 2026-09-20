// src/components/ai/amountMask.ts
//
// §7.4 乙方案的**判定**（纯函数）：历史消息跟随遮罩、本轮问出来的显示真值。
//
// ⚠️ 遮盖的是**回填进去的那些值**（`payload.refs`），不是"正文里长得像数字的东西"。
// 理由是规格字面：`§4.5:479` 要求 `content` 里存的是 `{{q1.total}}` 这类占位符，真值只存在
// `refs` 里，回填是渲染的最后一步 ⇒ "遮罩能在回填之后施加在渲染结果上"（`§4.5:483`）。
// 反过来扫数字会把日期、笔数、"上个月"里的月份一起涂掉（`2026-08-15` → `••••-••-••`），
// 回答会变得读不懂；**代价**是用户自己打的字面金额（"花了 128"）遮不住 —— 如实记在报告里。
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import { fillRefs } from "@/services/ai/prompt";

/**
 * 金额键的**后缀**白名单。
 *
 * 依据是 `tools.ts` 里 refs 键空间的**全部**产出（`:491-525` 汇总键 + `:816` 草稿金额）：
 * `q1.total` / `q1.avg` / `q1.net` / `q1.amount` 是钱；`q1.count` / `q1.matched` / `q1.label`
 * **不是**（笔数与命中行数是整数，遮掉它们既无隐私收益、又让"一共 3 笔"失去依据）。
 *
 * 只认**最后一段**：`q1.g0.total`（分组小计）、`q1.transfer.total`（类型分桶）与 `q1.total`
 * 同一个后缀 ⇒ 一张白名单就够，不必枚举前缀形态。
 */
const MONEY_KEY_SUFFIXES = new Set(["total", "avg", "net", "amount"]);

/** 这个 refs 键装的是钱吗（`q1.transfer.total` → 看 `total`） */
export function isAmountRefKey(key: string): boolean {
  const last = key.split(".").pop() ?? "";
  return MONEY_KEY_SUFFIXES.has(last);
}

/**
 * 遮蔽后的 refs：金额键换成 `••••`，其余键**原样**（键还在 ⇒ `fillRefs` 不会因为
 * "查不到引用"而 warn，也不会把裸 `{{q1.total}}` 漏给用户）。返回新对象，不改入参。
 */
export function maskAmountRefs(
  refs: Record<string, string | number>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(refs)) {
    out[key] = isAmountRefKey(key) ? AMOUNT_PLACEHOLDER : value;
  }
  return out;
}

/**
 * 一条消息最终的展示文本：回填**与**遮蔽在同一个函数里定序（先决定用哪份 refs，再回填一次），
 * 而不是"先回填再拿字符串做替换" —— 后者要么漏掉 `{{}}` 已被替换的事实，要么得再实现一遍替换。
 */
export function maskMessageText(
  content: string,
  refs: Record<string, string | number>,
  masked: boolean,
): string {
  return fillRefs(content, masked ? maskAmountRefs(refs) : refs);
}

/**
 * 该不该遮（§7.4 乙方案的全部规则，一行）。
 *
 * - `amountsHidden`：`useAmountMask` 的全局语义「默认不显示」（`stores/prefs.ts`，默认 `true`）
 * - `revealed`：这条消息是不是**本轮主动问出来的**（store 里的内存 Set）
 *
 * ⇒ 历史消息（不在集合里）跟随遮罩；本轮的显示真值。**用户手动关掉遮蔽时一律显示真值**
 * （"需要时主动点开"就是这个全局开关），所以这里不能写成只看 `revealed`。
 */
export function shouldMaskAmounts(amountsHidden: boolean, revealed: boolean): boolean {
  return amountsHidden && !revealed;
}
