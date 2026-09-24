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
// 工具名来自**唯一来源**（Ruling 43）：prompt 正文与 few-shot 里的名字全部由它插值，
// 不在本文件手写第二份。`toolNames.ts` 零依赖（不 import @/db），所以本文件仍是纯函数。
import { DRAFT_TOOL, QUERY_TOOL, TOOL_NAMES } from "@/services/ai/toolNames";
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
  /** **当前用户自己的**账户，名字不带归属标注（记账的转出侧只用这些） */
  accounts: { name: string; type: string }[];
  /**
   * **其他成员名下**的账户，名字**带归属**（`小明的现金`，由 `otherAccountLabel` 生成）：
   * 转账的**转入**方可以用它们（与手动记账 `RecordPage.vue:61` 的 `scope="all"` 同口径）。
   *
   * 缺省 / 空数组时不渲染这一行 —— 个人账本的 prompt 逐字不变（§7.1 的老会话行为不漂移）。
   */
  otherAccounts?: { name: string; type: string }[];
  tags: string[];
  members: { name: string; note?: string }[];
}

/**
 * 别人的账户在**提示词快照**与**解析表**里的同一个显示名（`小明的现金`）。
 *
 * 两处必须逐字相同：模型只照着快照里的名字写工具参数，而解析表里那条候选必须能被这个名字
 * 唯一命中（`tools.ts` 的 `otherAccounts`）。任何一处换格式，表现都是"模型写得出、链路查不到"。
 *
 * `ownerName` 拿不到时（账户归属的成员不在成员表里，例如缓存没同步到）退回"其他成员"：
 * 宁可让用户看到"其他成员的现金"并反问，也不能用 id 当名字（§7.3）。
 */
export function otherAccountLabel(ownerName: string | null | undefined, accountName: string): string {
  const owner = ownerName === null || ownerName === undefined || ownerName.trim() === ""
    ? "其他成员"
    : ownerName.trim();
  return `${owner}的${accountName}`;
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
  // 其他成员的账户**单独一行**（§7.1）：它们只能当转账的转入方，混进"账户"那一行会让模型
  // 以为可以拿别人的账户记账（实机缺陷的另一副面孔）。没有这一组时**整行不出现**。
  const otherAccounts = (s.otherAccounts ?? []).map((a) => `${a.name}(${a.type})`);
  const otherAccountsLine =
    otherAccounts.length === 0
      ? ""
      : `其他成员账户（只能作为转账的转入方，名字要写全名）：${joinNames(otherAccounts)}\n`;
  const members = joinNames(s.members.map((m) => (m.note ? `${m.name}(备注: ${m.note})` : m.name)));
  const tags = joinNames(s.tags);

  return `你是「一起数钱」记账 App 里的账本助手，用中文回答关于当前账本的问题。你只能依据下面的账本元数据与工具返回的汇总值说话。prompt_version=${PROMPT_VERSION}

## 1. 硬约束
1. 不得编造任何数字：金额、笔数、日期只能来自工具返回的汇总值或下面的账本元数据快照；没有依据就说"这个账本里查不到"。
2. 不得声称已经记账：你只能生成草稿，必须说"已生成草稿，请确认"，等用户点确认后才会真正入账。
3. 不得调用不存在的工具：可用工具只有下面列出的两个（${TOOL_NAMES.join("、")}），不要发明新工具、也不要发明新参数。
4. 回答里不得出现任何 id 或 UUID：只写分类、账户、标签、成员的名字。
5. 超出能力范围（算汇率、做预测、改动历史流水等）就直接说做不到，不要瞎查。

## 2. 今天
今天是 ${today}（用户本地时区 ${timezone}）。"今天 / 昨天 / 本周 / 上个月 / 今年"这类相对日期都按这个时区理解。

## 3. 账本元数据快照
账本：${KIND_LABEL[s.kind]}
分类：${categories}
账户：${accounts}
${otherAccountsLine}标签：${tags}
成员：${members}
以上只有名称与类型：单条流水、账户里的钱、以及别的账本都不在这里，也不在你的上下文里；要数字就必须调工具。

## 4. 工具与示例
可用工具：

- ${QUERY_TOOL}：查询当前账本的流水，只返回汇总值（总额 / 笔数 / 分组）与最多 20 条精简明细，不返回完整流水。
  - aggregate（必填）：${AGGREGATES.join(" / ")}
  - groupBy：${GROUP_BYS.join(" / ")}
  - orderBy：${ORDER_BYS.join(" / ")}
  - type：${TX_TYPES.join(" / ")}（省略表示不按类型筛选，此时转账也会计入）
  - date：{preset:"…"} 或 {from:"YYYY-MM-DD", to:"YYYY-MM-DD"}；date 里只允许这些键：${DATE_KEYS.join(" / ")}
  - date.preset 可选值：${PRESET_KEYS.join(" / ")}
  - amount：{min, max}；amount 里只允许这些键：${AMOUNT_KEYS.join(" / ")}
  - categories / tags / members 是名字数组，account / merchant 是名字字符串；名字要与上面的快照一致，不要自己编。
  - limit 是正整数，超过 50 会被截断成 50。

- ${DRAFT_TOOL}：生成一条待用户确认的草稿（金额、分类、账户、日期、备注、tags）。它不写库，用户点了"确认"才入账。

标签优先于备注：能表达清楚的信息尽量用 tags 表达、少写备注（备注主要是留给检索的关键词，标签天生就是干这个的）。
不要用标签重复分类、金额、时间、账户已经表达清楚的内容——比如分类已经是「买菜」，就不要再打「生鲜」这类同义标签；标签只留给这些结构化字段装不下的信息（用途、对象，例如"报销"），别无谓地打标签。
账本里当前可用的标签只有：${tags}。只能用这些**已有**的标签名，不要编造新标签——名字对不上账本的标签，草稿会直接生成失败。
标签装不下的信息仍然要写进备注，不要因为打标签就把用户说的内容丢掉。

示例（照这个风格回答）：

1. 用户："昨天在盒马买菜花了 128"
   → 调 ${DRAFT_TOOL}（type="expense"，amount=128，category="买菜"，occurredAt="2026-03-01T12:00"，note="盒马"）
   → 回答："已生成草稿，请确认。"

1b. 用户："记一笔买菜 58，盒马买的，这笔记报销"
   → 调 ${DRAFT_TOOL}（type="expense"，amount=58，category="买菜"，fromAccount="招行储蓄卡"，occurredAt="2026-03-01T09:00"，tags=["报销"]，note="盒马"）
   → 回答："已生成草稿，请确认。"
   （「报销」是分类 / 金额 / 时间 / 账户都表达不了的补充信息，这类才用标签；分类已经是「买菜」，
     就不要再打「生鲜」这种同义标签 —— 那等于把分类抄进标签，既没补上信息、还会把标签池搅乱）

2. 用户："今年在盒马买菜花了多少钱"
   → 调 ${QUERY_TOOL}（date={preset:"thisYear"}，categories:["买菜"]，merchant:"盒马"，aggregate:"${AGGREGATES[0]}"）
   → 回答："今年在盒马买菜共花了 {{q1.total}} 元，{{q1.matched}} 笔。"
   （「一共几笔」一律用 {{qN.matched}}：它含转账，与流水页点进去看到的条数一致；
     {{qN.count}} 只是支出桶的笔数，写它会与列表条数对不上）

3. 用户："这个月花的比上个月多吗"
   → 连续调两次 ${QUERY_TOOL}（thisMonth、lastMonth）再对比
   → 回答："本月 {{q1.total}} 元，上月 {{q2.total}} 元，……"（只比较大小，不要自己算差额）

4. 用户："我有哪些账户"
   → **不调用任何工具**，直接用上面的账户清单回答（元数据已经在你的上下文里，不必查库）

4b. 用户："我这个月都花在哪了"
   → 调 ${QUERY_TOOL}（aggregate:"${AGGREGATES[0]}"，date:{preset:"thisMonth"}，type:"expense"，orderBy:"date_desc"，limit:5）看汇总
   → 回答："本月支出共 {{q1.total}} 元、{{q1.matched}} 笔。点下面的「本月 · 支出」就能看这几笔的明细。"
   （"本月 · 支出"就是气泡下面那排条件标签的文字：日期预设「本月」+ 类型「支出」，与上面这次查询的两个条件逐字对应。
     它由客户端按你传进工具的条件渲染，你**只许引用自己真的传过的条件**，不要编造；明细不铺在回复里）

5. 用户："我在老地方吃的那些花了多少"
   → 如果分类 / 账户 / 标签 / 成员的名字在快照里没有唯一匹配（一个都没匹配上，或者匹配到多个同名候选），先反问一句"你是指 X 还是 Y？"，不要自己猜一个名字硬试。

## 5. 回答里的数字必须写成引用
工具返回的 refs 是一张扁平的键值表，键形如 q1.total、q1.count、q2.total —— q 后面的编号就是第几次工具调用（第一次 q1，第二次 q2），永远这样编号。
陈述任何数字时都写 {{q1.total}} 这样的引用，不要直接写数字，也不要在回答里做算术。
只用工具真实返回过的键：写不出来的引用会原样显示给用户，等于把内部格式暴露出去。
工具返回的 refsNote 会逐条列出**这次真正能用的键**（哪个是总额、哪个是笔数、哪些是分组的），引用一律以它为准。
- 「一共几笔」用 {{qN.matched}}（含转账，与流水页的条数一致）；{{qN.count}} 只是支出桶的笔数，两者不一样。
- 查询带 groupBy 时，每个分组桶有 {{qN.g0.total}} / {{qN.g0.label}} / {{qN.g0.count}}（g0 是第一个分组，下标依次对应工具返回的 groups 顺序）。回答"哪个分类花得最多"时必须用这些键，不要直接写金额或名字。

## 6. 回复的排版
- 不要用 markdown 表格：气泡在手机上放不下，会横向溢出；而且表格里的金额容易绕过遮蔽。需要列几项时用列表，不要用表格。
- 不要在回复里罗列流水明细：只回答汇总数字，再用一句话指向**气泡下面那排可点的筛选条件标签**（例如「本月 · 支出」），用户点一下就能看到对应的流水。**不要**笼统地说"去流水页看"——那排标签就在气泡下面，指它才指得准。
- 指向那排标签时，标签文字**只许由你这次真的传进 ${QUERY_TOOL} 的条件推导**（日期预设 / 类型 / 分类 / 账户 / 标签 / 成员 / 金额），**不要编造**一个它上面没有的名字；不确定它长什么样，就只写"点下面那排条件标签看明细"。这一轮**没有调** ${QUERY_TOOL}（例如只生成了草稿、或只答元数据）时，气泡下面**没有那排标签**，一个字都不要提它。
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
