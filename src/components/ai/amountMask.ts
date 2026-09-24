// src/components/ai/amountMask.ts
//
// §7.4 乙方案的**判定**（纯函数）：历史消息跟随遮罩、本轮问出来的显示真值。
//
// 主路径遮的是**回填进去的那些值**（`payload.refs`）：`§4.5:479` 要求 `content` 里存的是
// `{{q1.total}}` 这类占位符，真值只存在 `refs` 里，回填是渲染的最后一步 ⇒ "遮罩能在回填之后
// 施加在渲染结果上"（`§4.5:483`）。
//
// ⚠️ 主路径**够不着**一类真值：**正文里已经成文的数字**（`fillRefs` 看不见它们，因为它们是
// 字面量而不是占位符）。这不是理论问题 —— 工具回给模型的 `items[].amount` 就是字面数字
// （`tools.ts` 的 `toPromptItem`），模型列明细表时会把它们抄进回答（Bug 2 的**隐私**那一半：
// 表格里的金额是明文的，同一段回答里段落中的 `{{q1.total}}` 却遮得好好的）。
//
// 补的那一路是 `maskTableAmounts`：**只**在 markdown 表格行里，**只**动"整格就是一个金额"的
// 单元格。范围刻意收得这么窄，是为了不重演旧注释里那条真实的坏后果 —— 反过来**通篇**扫数字会把
// 日期、笔数、"上个月"里的月份一起涂掉（`2026-08-15` → `••••-••-••`），回答会变得读不懂。
// 仍未覆盖的形态（如实记着）：**段落里**成文的金额（模型不写表格、也不写引用时）与用户自己打的
// "花了 128" —— 两者都遮不住，因为客户端无从分辨那是不是钱。
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
 *
 * ⚠️ 顺序是**回填 → 再补表格里的字面金额**（`maskTableAmounts`），不能反过来：
 * 先扫字面数字会把 `{{q1.total}}` 里的 `q1` 当成正文（而且回填随后又会把真值塞回来）。
 */
export function maskMessageText(
  content: string,
  refs: Record<string, string | number>,
  masked: boolean,
): string {
  const filled = fillRefs(content, masked ? maskAmountRefs(refs) : refs);
  // 不遮（本轮问出来的 / 用户手动点开眼睛）⇒ 一个字都不动：遮蔽不许越权
  return masked ? maskTableAmounts(filled) : filled;
}

/**
 * 表格行里"整格就是一个金额"的单元格。
 *
 * 五组分别是：前导空白 / 货币符号（可省）/ 数字（含千分位与小数）/ 单位（可省）/ 尾随空白。
 * 数字**允许是整数**（`32` 也是钱：工具明细里的 `amount` 就是 number，整元时不带小数点）。
 * 日期（`2026-03-01`，数字后面还有 `-03-01`）与带单位的笔数（`3 笔`）都**不匹配** —— 这两类是
 * 遮蔽最不该碰的东西（见文件头）。
 */
const AMOUNT_CELL_RE =
  /^(\s*)(?:[-+]\s*)?([¥￥$])?\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(元|块|圆|人民币)?(\s*)$/;

/** 单元格遮蔽：货币符号与单位留着（`¥••••` / `•••• 元`），**符号丢掉**（与 `maskCurrency` 的遮蔽态同一口径） */
function maskAmountCell(cell: string): string {
  const m = AMOUNT_CELL_RE.exec(cell);
  if (m === null) return cell;
  const [, lead, currency, , unit, tail] = m;
  const prefix = currency ?? "";
  const suffix = unit === undefined ? "" : ` ${unit}`;
  return `${lead}${prefix}${AMOUNT_PLACEHOLDER}${suffix}${tail}`;
}

/**
 * 把**表格行里**成文的金额换成占位符。
 *
 * 判据是"这一行里有 `|`"（GFM 表格行，含不带首尾竖线的宽松写法）。为什么不要求"首尾都有 `|`"
 * 或"至少两个 `|`"：模型两种写法都会用，而漏判的后果是**明文金额泄露**（本函数的全部理由）；
 * 多做一步的后果只是"一行含竖线的散文里那格纯数字被涂掉" —— 两害相权，取前者。
 * 每格都是**独立**判定的，所以只有真正"整格是个金额"的地方会动。
 */
export function maskTableAmounts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.includes("|") ? line.split("|").map(maskAmountCell).join("|") : line,
    )
    .join("\n");
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
