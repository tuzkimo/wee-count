// src/components/ai/amountMask.ts
//
// §7.4 乙方案的**判定**（纯函数）：历史消息跟随遮罩、本轮问出来的显示真值。
//
// **两路**遮蔽（缺一路就是真机事故，Bug 2）：
//
//  ① **引用值**：`§4.5:479` 要求 `content` 里存的是 `{{q1.total}}` 这类占位符，真值只存在
//     `refs` 里 ⇒ 回填前把**金额键**的值换成 `••••`（`maskAmountRefs`）。这条按**键名**判语义，
//     所以"笔数"（`q1.count`）能照旧显示。
//
//  ② **正文里已经成文的数字**：`fillRefs` 看不见它们（它们是字面量，不是占位符）。
//     这不是理论问题 —— 工具回给模型的 `items[].amount` 就是字面数字（`tools.ts` 的
//     `toPromptItem`），模型把它们抄进回答（表格、列表、段落都会）时，① 一点用都没有。
//
// ⚠️ ② 是**fail-safe** 的：遮蔽开着时，把模型**自己写的**数字串**一律**换成占位符，
// 而不是只匹配"我们见过的几种金额写法"。理由是隐私边界的性质 —— 它不能建立在
// "模型只用我们预料过的形状"（或"模型听话不写表格"）之上：漏一个形状就是一次明文泄露，
// 而多遮一个数字只是让回答难看。**已知的代价**（如实记着，人类要权衡）：
// 模型写在正文里的日期（`2026-03-01` → `••••-••-••`）、笔数、编号也会被一起遮掉。
//
// **仍未覆盖的形态**（② 也挡不住的，如实记着）：用中文数字/英文单词写的金额
// （"一百二十八块五"、"one hundred"）。它们与正文里正常的"一/二/三"无法用形状区分，
// 只能靠"模型必须写引用"这条提示词约束 —— 而那**不是**隐私边界（见上）。
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
 * 一条消息最终的展示文本：回填**与**两路遮蔽在同一个函数里定序。
 *
 * ⚠️ 顺序不能反（**回填前**遮字面量 → 再回填）：
 *  - 反过来（先回填、再扫数字）会把**从 `refs` 回填出来的笔数**（`q1.count` → `3`）也一起遮掉 ——
 *    那是 ① 明确要保留的东西（"一共 3 笔"），而语义只有键名知道；
 *  - 只在**回填前**遮，模型写的字面数字与回填出来的真值就分得开：前者一律遮，后者按键名判。
 */
export function maskMessageText(
  content: string,
  refs: Record<string, string | number>,
  masked: boolean,
): string {
  // 不遮（本轮问出来的 / 用户手动点开眼睛）⇒ 与今天的 `fillRefs` 逐字一致：遮蔽不许越权
  if (!masked) return fillRefs(content, refs);
  return fillRefs(maskLiteralNumbers(content), maskAmountRefs(refs));
}

/**
 * 模型**自己写在正文里**的数字串（fail-safe 判据）。
 *
 * `\p{Nd}` 是 Unicode 的**全部十进制数字**：ASCII `0-9`、全角 `０-９`、阿拉伯-印度数字…
 * （写成 `[0-9０-９]` 就会漏掉我们没预料到的那几种，而"没预料到的形状"正是本函数要挡的事）。
 * 数字之间的分隔符只认最常见的四种（`,` `.` `，` `．`）—— 认不出来的写法（空格分组 `1 234`、
 * `1'234`）会被切成**多个** token，每个都遮 ⇒ 仍然不泄漏（fail-safe 的方向是宁可多遮）。
 */
const LITERAL_NUMBER = /\p{Nd}+(?:[.,，．]\p{Nd}+)*/gu;

/**
 * 一次扫过整串：**占位符**（排在前面，同一位置优先）原样留着，其余数字串换成占位符。
 *
 * 为什么必须跳过占位符：`{{q1.total}}` 里的 `1` 是**我们自己的键名**，不是模型写的数字；
 * 在这里把它涂掉，`fillRefs` 随后就查不到那个键 ⇒ 用户看到 `{{q••••.total}}`。
 * （形状与 `prompt.ts` 的 `REF_RE` 对齐；那边改了这里要跟着改 —— 漏改的后果是"难看"，
 * 不是"泄漏"。）
 */
const LITERAL_OR_REF = new RegExp(
  String.raw`\{\{[a-zA-Z0-9_.]+\}\}|${LITERAL_NUMBER.source}`,
  "gu",
);

/**
 * 遮蔽**模型自己写的数字**。
 *
 * 只遮"数字串"本身：货币符号（`¥` / `$`）、单位（`元`）、正负号、括号都留着 —— 它们不暴露
 * 金额大小，留着让回答还能读。`¥128.50` ⇒ `¥••••`、`128.50 元` ⇒ `•••• 元`、
 * `1,234.56` ⇒ `••••`（千分位与小数点在同一个 token 里，一起被吃掉）。
 */
export function maskLiteralNumbers(text: string): string {
  return text.replace(LITERAL_OR_REF, (token: string) =>
    token.startsWith("{{") ? token : AMOUNT_PLACEHOLDER,
  );
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
