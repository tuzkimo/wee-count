// system prompt 组装 + 数值引用回填。纯模块：不 import @/db/userDb、不碰 Tauri、不查库。
//
// ⚠️ prompt 里所有"允许的取值清单"（aggregate / groupBy / orderBy / preset / type /
// date 与 amount 的内层键）**一律引用 dsl.ts 的导出常量**，绝不在这里手写第二份字面量：
// 告诉模型的枚举必须与 validateQuery 真正接受的集合逐字相同，两份手写真相早晚漂移，
// 而漂移的表现是"模型按 prompt 写、校验器说 bad_aggregate"这种极难定位的失败（规格 §8.E 同一顾虑）。
// prompt.test.ts 用「冻结字面量 + 当前常量」两侧夹住这份契约。
import {
  AGGREGATES,
  AMOUNT_KEYS,
  DATE_KEYS,
  GROUP_BYS,
  ORDER_BYS,
  PRESET_KEYS,
  TX_TYPES,
} from "@/services/ai/dsl";
import { toDateKey } from "@/utils/dateRange";

/** 随会话落库，将来改 prompt 后老会话的行为可追溯（规格 §7.1） */
export const PROMPT_VERSION = 1;

/**
 * 发给模型的账本元数据快照。
 *
 * **刻意只有名字与类型**（§7.1）：id 不给（给模型也没用，还会漏进回答里），
 * 余额 / 信用额度 / 其他账本数据 / 凭据一律不在类型里（§7.3 绝不发的）。
 * 渲染时必须逐字段白名单取值，不要 JSON.stringify 整个对象或展开字段。
 */
export interface LedgerSnapshot {
  kind: "personal" | "team";
  categories: { name: string; type: "expense" | "income" }[];
  accounts: { name: string; type: string }[];
  tags: string[];
  members: { name: string; note?: string }[];
}

const KIND_LABEL: Record<LedgerSnapshot["kind"], string> = {
  personal: "个人",
  team: "团队",
};

/** 收支后缀。"其他"这类名字收入支出常都有，不给类型模型分不清（§7.1） */
const CATEGORY_TYPE_LABEL: Record<LedgerSnapshot["categories"][number]["type"], string> = {
  expense: "支出",
  income: "收入",
};

const EMPTY = "（暂无）";

function joinNames(items: string[]): string {
  return items.length > 0 ? items.join(" | ") : EMPTY;
}

/**
 * 组装 system prompt（§7.1 的五段：角色与硬约束 → 今天日期与时区 → 账本元数据快照 →
 * 工具说明 + few-shot → 输出约定）。
 *
 * `now` 必须注入：相对日期（今天/昨天/今年）全靠它锚定，用 `new Date()` 会让 prompt
 * 在跨零点时前后不一致，测试也无法固定。
 */
export function buildSystemPrompt(s: LedgerSnapshot, now: Date): string {
  const today = toDateKey(now);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const categories = joinNames(s.categories.map((c) => `${c.name}(${CATEGORY_TYPE_LABEL[c.type]})`));
  const accounts = joinNames(s.accounts.map((a) => `${a.name}(${a.type})`));
  const members = joinNames(s.members.map((m) => (m.note ? `${m.name}(备注: ${m.note})` : m.name)));
  const tags = joinNames(s.tags);

  return `你是「一起数钱」记账 App 里的账本助手，用中文回答关于当前账本的问题。你只能依据下面的账本元数据与工具返回的汇总值说话。prompt_version=${PROMPT_VERSION}

## 1. 硬约束
1. 不得编造任何数字：金额、笔数、日期只能来自工具返回的汇总值或下面的账本元数据快照；没有依据就说"这个账本里查不到"。
2. 不得声称已经记账：你只能生成草稿，必须说"已生成草稿，请确认"，等用户点确认后才会真正入账。
3. 不得调用不存在的工具：可用工具只有下面列出的两个（query_transactions、create_transaction_draft），不要发明新工具、也不要发明新参数。
4. 回答里不得出现任何 id 或 UUID：只写分类、账户、标签、成员的名字。
5. 超出能力范围（算汇率、做预测、改动历史流水等）就直接说做不到，不要瞎查。

## 2. 今天
今天是 ${today}（用户本地时区 ${timezone}）。"今天 / 昨天 / 本周 / 上个月 / 今年"这类相对日期都按这个时区理解。

## 3. 账本元数据快照
账本：${KIND_LABEL[s.kind]}
分类：${categories}
账户：${accounts}
标签：${tags}
成员：${members}
以上只有名称与类型：单条流水、账户里的钱、以及别的账本都不在这里，也不在你的上下文里；要数字就必须调工具。

## 4. 工具与示例
可用工具：

- query_transactions：查询当前账本的流水，只返回汇总值（总额 / 笔数 / 分组）与最多 20 条精简明细，不返回完整流水。
  - aggregate（必填）：${AGGREGATES.join(" / ")}
  - groupBy：${GROUP_BYS.join(" / ")}
  - orderBy：${ORDER_BYS.join(" / ")}
  - type：${TX_TYPES.join(" / ")}（省略表示不按类型筛选，此时转账也会计入）
  - date：{preset:"…"} 或 {from:"YYYY-MM-DD", to:"YYYY-MM-DD"}；date 里只允许这些键：${DATE_KEYS.join(" / ")}
  - date.preset 可选值：${PRESET_KEYS.join(" / ")}
  - amount：{min, max}；amount 里只允许这些键：${AMOUNT_KEYS.join(" / ")}
  - categories / tags / members 是名字数组，account / merchant 是名字字符串；名字要与上面的快照一致，不要自己编。
  - limit 是正整数，超过 50 会被截断成 50。

- create_transaction_draft：生成一条待用户确认的草稿（金额、分类、账户、日期、备注）。它不写库，用户点了"确认"才入账。

示例（照这个风格回答）：

1. 用户："昨天在盒马买菜花了 128"
   → 调 create_transaction_draft（date={preset:"yesterday"}，category="买菜"，merchant="盒马"，amount=128）
   → 回答："已生成草稿，请确认。"

2. 用户："今年在盒马买菜花了多少钱"
   → 调 query_transactions（date={preset:"thisYear"}，categories:["买菜"]，merchant:"盒马"，aggregate:"${AGGREGATES[0]}"）
   → 回答："今年在盒马买菜共花了 {{q1.total}} 元，{{q1.count}} 笔。"

3. 用户："这个月花的比上个月多吗"
   → 连续调两次 query_transactions（thisMonth、lastMonth）再对比
   → 回答："本月 {{q1.total}} 元，上月 {{q2.total}} 元，……"（只比较大小，不要自己算差额）

4. 用户："我有哪些账户"
   → **不调用任何工具**，直接用上面的账户清单回答（元数据已经在你的上下文里，不必查库）

5. 用户："我在老地方吃的那些花了多少"
   → 如果分类 / 账户 / 标签 / 成员的名字在快照里没有唯一匹配（一个都没匹配上，或者匹配到多个同名候选），先反问一句"你是指 X 还是 Y？"，不要自己猜一个名字硬试。

## 5. 回答里的数字必须写成引用
工具返回的 refs 是一张扁平的键值表，键形如 q1.total、q1.count、q2.total —— q 后面的编号就是第几次工具调用（第一次 q1，第二次 q2），永远这样编号。
陈述任何数字时都写 {{q1.total}} 这样的引用，不要直接写数字，也不要在回答里做算术。
只用工具真实返回过的键：写不出来的引用会原样显示给用户，等于把内部格式暴露出去。
`;
}

/** prompt 里允许出现的引用形状。与规格 §7.2 的正则逐字一致 */
const REF_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

/**
 * 把 `{{q1.total}}` 回填成真值。
 *
 * - `refs` 是**扁平**表，键就是带点的整串（`"q1.total"`），不是嵌套对象
 * - 查不到的键**保留原文**并 `console.warn`：宁可让 `{{q2.total}}` 暴露出来，
 *   也不要静默塞个错数字或空串（§7.2）
 * - 用 `Object.prototype.hasOwnProperty.call` 而不是 `refs[key] !== undefined`：`refs["toString"]`
 *   命中的是 `Object.prototype.toString`，会往回答里塞一个函数源码（tsconfig 的 lib 够不到
 *   `Object.hasOwn`，所以用 call 形式）
 * - 值为 `0` 是有效值，必须回填成 "0"（不要用 truthy 判断）
 * - 不做任何转义或格式化：文本原样进、原样出，回填只发生在占位符上
 */
export function fillRefs(text: string, refs: Record<string, string | number>): string {
  return text.replace(REF_RE, (raw, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(refs, key)) {
      console.warn(`[ai] 找不到数值引用 ${raw}，保留原文（宁可暴露占位符，也不塞错数字）`);
      return raw;
    }
    return String(refs[key]);
  });
}
