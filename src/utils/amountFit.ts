// 多列金额汇总的字号自适应：位数多时逐档缩小字号，保证金额始终单行。
//
// 为什么不截断也不用 万/亿 缩写：汇总条展示的是账目原值，缩写会改变数字本身；
// 截断则直接丢信息。三列并排时唯一不损失信息的办法就是把字号压下去。
//
// 宽度模型：把每个字符折算成 em（字符宽 ÷ 字号），阈值由列宽预算反推。
//
// 列宽预算取 96px，是标定值而不是随手写的：360dp 视口下流水页三列每列 ≈93px
// （`px-4` + 右侧 `pr-8` 让位眼睛按钮 + `gap-4` 之后），而 ≥393dp 的机器上 ≈104px。
// 预算落在两者之间，保证「现在看着正常的金额不降档」：最典型的 `-¥1,234.56`
// 在 18px 下 ≈95px，因此 18px 档的上界必须 ≥95px，否则这次修复会把常见金额也缩小一档。
// 代价是 360dp 窄机上 6 位数金额可能横向溢出 1-2px（列是 `min-w-0 flex-1`，
// 只是墨迹溢出，不会撑宽页面）——比换行或整体变小都轻。
//
// 字符权重按 Roboto / Noto Sans 的等宽数字度量：数字 0.556em（配 `tabular-nums` 即此宽度）、
// `,`/`.` 0.3em、`¥` 0.75em、负号 0.55em、遮蔽占位符 `•` 0.86em（与 useAmountMask 的宽度说明一致）。
const EM_DIGIT = 0.56;
const EM_PUNCT = 0.3;
const EM_CURRENCY = 0.75;
const EM_BULLET = 0.86;
const EM_OTHER = 0.55;

/** 列宽预算（px），见文件头标定说明。 */
const COLUMN_BUDGET_PX = 96;

/** 由宽到窄的字号档位（class 必须是字面量，供 Tailwind 扫描生成）。 */
const FONT_TIERS: { px: number; className: string }[] = [
  { px: 18, className: "text-lg" },
  { px: 16, className: "text-base" },
  { px: 14, className: "text-sm" },
  { px: 12, className: "text-xs" },
  { px: 11, className: "text-[11px]" },
];

/** 每档能单行排下的最大宽度（em）= 列宽预算 ÷ 该档字号。 */
const SIZE_TIERS = FONT_TIERS.map((tier) => ({
  maxEm: COLUMN_BUDGET_PX / tier.px,
  className: tier.className,
}));

/** 兜底档：家庭账本到不了这里（需要万亿级），只为「任何位数都不换行」兜底。 */
const FALLBACK_CLASS = "text-[10px]";

/** 按宽度模型估算一个金额字符串占多少 em。 */
export function amountWidthEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") em += EM_DIGIT;
    else if (ch === "," || ch === ".") em += EM_PUNCT;
    else if (ch === "¥") em += EM_CURRENCY;
    else if (ch === "•") em += EM_BULLET;
    else em += EM_OTHER;
  }
  return em;
}

/** 给定最宽金额的 em 值，返回能单行排下的字号档位 class。 */
export function amountTierClass(longestEm: number): string {
  const tier = SIZE_TIERS.find((t) => longestEm <= t.maxEm);
  return tier ? tier.className : FALLBACK_CLASS;
}

/**
 * 多列汇总共用一个字号：按最长的那个金额定档。
 * 逐列各自定档会让同一行的数字大小不一，比整体小一号更难看。
 */
export function pickAmountSizeClass(texts: string[]): string {
  return amountTierClass(Math.max(0, ...texts.map(amountWidthEm)));
}
