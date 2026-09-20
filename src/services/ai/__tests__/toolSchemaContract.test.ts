import { describe, it, expect } from "vitest";
import { TOOLS, MAX_PROMPT_ITEMS } from "@/services/ai/tools";
import {
  AGGREGATES,
  GROUP_BYS,
  ORDER_BYS,
  PRESET_KEYS,
  TX_TYPES,
  validateQuery,
} from "@/services/ai/dsl";
import { buildSystemPrompt, type LedgerSnapshot } from "@/services/ai/prompt";

/**
 * §8.E：工具 JSON Schema 与 `dsl.ts` 校验器是**两份手写的真相**，必须夹住。
 *
 * ⚠️ 字段名的唯一权威是规格 §4.1 的 `AiFilter` / `AiQuery` 类型声明。
 * `dsl.ts` 导出的 `PRESET_KEYS` / `AGGREGATES` / `GROUP_BYS` … 装的是**取值**
 * （"today" / "sum" / "category"），**不是字段名** —— 把它们当字段名用会写出
 * 恒真或恒假的断言（本计划初稿就在这里错过一次）。所以下面这份 golden 是
 * 手写的**字段名**清单，且每一条都用 `validateQuery` 的**行为**验证：
 * 合法样本必须 ok，字段名必须被校验器认识（不能报 unknown_key）。
 */
const CONTRACT_FIELDS = [
  "date",
  "type",
  "categories",
  "account",
  "tags",
  "members",
  "merchant",
  "amount",
  "aggregate",
  "groupBy",
  "orderBy",
  "limit",
] as const;

/**
 * 每个字段一个**合法**样本（行为级断言的输入）。
 * 用 `Record<string, unknown>` 而不是从 CONTRACT_FIELDS 派生的精确键类型，
 * 是因为"少写一个样本"会变成 `[field]: undefined` —— 那等于"没给这个字段"，
 * validateQuery 反而报 ok:true（空转）。所以下面显式断言样本必须存在。
 */
const SAMPLE: Record<string, unknown> = {
  date: { preset: "thisMonth" },
  type: "expense",
  categories: ["买菜"],
  account: "招行储蓄卡",
  tags: ["生鲜"],
  members: ["老婆"],
  merchant: "盒马",
  amount: { min: 1, max: 100 },
  aggregate: "sum",
  groupBy: "category",
  orderBy: "value_desc",
  limit: 5,
};

const queryTool = TOOLS[0];
const params = queryTool.function.parameters as { properties: Record<string, unknown> };
const toolProps = Object.keys(params.properties);

describe("§8.E 工具 schema 与 validateQuery 的对称性", () => {
  it("工具声明的字段与 §4.1 的字段集合逐字相同（多一个、少一个都红）", () => {
    expect([...toolProps].sort()).toEqual([...CONTRACT_FIELDS].sort());
  });

  it("工具声明的每个字段都被校验器真接受（不是集合比大小，是行为）", () => {
    // 若把工具字段改名成校验器不认识的名字（types / noteKeyword / amountMin…），
    // 这里拿到的是 unknown_key → ok:false → 红。
    for (const field of toolProps) {
      // 先跑行为断言，再跑样本存在性守卫：发明一个校验器不认的字段时，
      // 红必须红在"validateQuery 拒了它"上，而不是被后面的守卫遮住。
      const result = validateQuery({ aggregate: "sum", [field]: SAMPLE[field] });
      expect(result.ok, `${field} 的合法样本必须被 validateQuery 接受`).toBe(true);
      expect(SAMPLE[field], `缺少 ${field} 的合法样本（undefined 会被当成"没给这个字段"而恒绿）`).toBeDefined();
    }
  });

  it("每个 golden 字段名都被校验器**认识**（不报 unknown_key）", () => {
    // 与上一条互补：上一条证明"样本合法"，这一条证明"字段名在白名单里"。
    // 两条一起才排掉"字段名拼错但恰好被当未知字段忽略"的假绿。
    for (const field of CONTRACT_FIELDS) {
      const result = validateQuery({ aggregate: "sum", [field]: SAMPLE[field] });
      const codes = result.ok ? [] : result.errors.map((e) => e.code);
      expect(codes, `${field} 不该是未知字段`).not.toContain("unknown_key");
    }
  });

  it("反向：校验器不认的字段必须被拒（工具不得发明字段）", () => {
    const result = validateQuery({ aggregate: "sum", notAField: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.code)).toEqual(["unknown_key"]);
      // 错误里点名是哪个字段，模型才知道删谁
      expect(result.errors[0].path).toBe("notAField");
    }
  });
});

/**
 * 修正第 14 条：工具名在 `prompt.ts` 里手写了一份，在 `TOOLS` 里又定义一份 ⇒
 * **两份手写真相**。不把 `TOOLS` 引进 `prompt.ts`（会把 `@/db/userDb` 拖进
 * prompt 的纯函数模块图），改为在这里夹住：prompt 文本必须包含每个工具名。
 */
/**
 * 工具名候选取样器（F4）：**锚在名词上**（transaction(s) / draft(s) / tx），
 * 而不是锚在 `query_` / `create_` 这两个动词前缀上 —— 后者会让
 * `delete_transaction`（不存在的写工具）、`queryTx`（无下划线）、
 * `Query_transactions`（首字母大写）全部溜过去（实测三种形态下契约文件 7/7 全绿）。
 *
 * 实现是"把文本切成 ASCII 词，再挑出含名词的词"，**不是**用一个正则同时干两件事：
 * `\b…(?=…名词)` 这种写法在 `Query_transactions` 上只抽到 `Query_`（实测），
 * 因为前瞻的字符类允许 `_` 跨越下划线，回溯后落在一个错误的位置上。
 * 先切词再过滤没有歧义：`queryTx` / `Query_transactions` / `delete_transaction` 都是**一个词**。
 *
 * 名词集合里有 **tx**（审查 F4 点名的形态之一）：`\b\w*(?:transaction|draft)\w*` 抓不到
 * `queryTx`，而 `Tx` 恰好是"流水"最常用的缩写 ⇒ 一个不存在的工具名又溜过去了。
 * 代价（接受）：prompt 若写英文散文 "documents in tax" 之类会被误抽 —— 那是**误报方向安全**
 * 的一侧（改措辞即可），比漏掉 `queryTx` 好。
 * `\w` 不含中文与引号，所以 prompt 里的 JSON 键 `"query":` 与中文散文都不会被误抽。
 *
 * ### 增量复审的两种绕过（逐条堵）
 *
 * 复审对抗性实测：上面的词级扫描有 2 种形态**全绿**（在场 ≠ 能红）：
 *
 * 1. `DELETE_TRANSACTION`（全大写）：名词过滤写的是 `[Tt]ransaction` ⇒ 只对**首字母**
 *    大小写不敏感，整词被漏掉。⇒ 过滤改成 `/transaction|draft|tx/i`。**候选仍保留原样
 *    拼法**：判断"是不是真工具名"必须按原样（`TOOLS[i].function.name` 是逐字比较的），
 *    `Query_transactions` 大写开头同样不是真名字（那条元测试钉着它）。
 * 2. `q u e r y _ t r a n s a c t i o n s`（字母被拆开）：词级扫描看到的是 23 个单字母词，
 *    一个名词都匹配不上。⇒ 增加**块级**扫描：按"强边界"（中文 / 标点 / 引号 / 括号 / 顿号…
 *    —— 任何不属于 `[A-Za-z0-9\s_.-]` 的字符）切块，块内**先剥掉非字母数字**
 *    （`_` / `.` / `-` / 空白）再比对真名字。
 *
 * 块级的两条判定（顺序有意义）：
 * - 归一化后**逐字等于**某个真名字（`- query_transactions` 去掉行首列表记号后就是它）
 *   ⇒ 正常拼法，报真名字 —— 这一步也让"真 prompt 至少有一条候选"继续成立（防空转）。
 * - 归一化后等于真名字的归一化形态、但**原样不等于**（`DELETE_TRANSACTION`、拆开的写法）
 *   ⇒ 报原样，它在 `TOOLS` 里查不到 ⇒ 反向断言红。
 *
 * **残留（如实记录，不装作没有）**：块级只认"剥掉非字母数字后**恰好**是真名字"的形态，
 * 所以 `q u e r y _ t r a n s X c t i o n s` 这种改过字母的写法仍然绕过 —— 它已经不是真
 * 名字了（模型也未必认得）。真正的根治仍然是"`prompt.ts` 不要再手写第二份工具名"。
 */
const TOOL_NOUN_RE = /transaction|draft|tx/i;

/** 强边界：会切断一个标识符的字符。空白 / `_` / `.` / `-` 是**弱**分隔符，不切。 */
const IDENT_STRONG_BOUNDARY_RE = /[^A-Za-z0-9\s_.-]+/;

/** 剥掉非字母数字再小写 —— "先归一化再比对"（F4 的两种绕过都靠它现形） */
function squashIdent(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
}

function toolNameCandidates(text: string): string[] {
  const out: string[] = [];
  const push = (c: string): void => {
    if (c !== "" && !out.includes(c)) out.push(c);
  };

  // ① 词级：原样拼法 + 大小写不敏感的名词过滤
  for (const w of text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) {
    if (TOOL_NOUN_RE.test(w)) push(w);
  }

  // ② 块级：归一化后比对（补"字母被拆开"的形态）
  const known = new Map(TOOLS.map((t) => [squashIdent(t.function.name), t.function.name]));
  for (const chunk of text.split(IDENT_STRONG_BOUNDARY_RE)) {
    const squashed = squashIdent(chunk);
    if (!TOOL_NOUN_RE.test(squashed)) continue;
    // 行首列表记号（`- `）不是标识符的一部分：`- query_transactions` 是正常拼法
    const bare = chunk.trim().replace(/^[-*.]+/, "").trim();
    const canonical = known.get(squashed);
    if (canonical !== undefined && bare === canonical) {
      push(canonical);
      continue;
    }
    push(bare);
  }
  return out;
}

describe("prompt ↔ TOOLS 契约（工具名单一来源）", () => {
  const SNAPSHOT: LedgerSnapshot = {
    kind: "personal",
    categories: [{ name: "买菜", type: "expense" }],
    accounts: [{ name: "招行储蓄卡", type: "银行卡" }],
    tags: ["生鲜"],
    members: [{ name: "我" }],
  };

  it("buildSystemPrompt 的文本包含每一个 TOOLS[i].function.name", () => {
    const prompt = buildSystemPrompt(SNAPSHOT, new Date(2026, 2, 1));
    const names = TOOLS.map((t) => t.function.name);
    // 防空转：TOOLS 若被清空，下面的循环一条断言都不跑，测试会静默恒绿
    expect(names.length).toBe(2);
    for (const name of names) {
      expect(prompt, `prompt 里没有工具 ${name}（prompt.ts 与 TOOLS 漂移了）`).toContain(name);
    }
  });

  it("反向：prompt 里不得提到 TOOLS 之外的工具名", () => {
    // 上一条只保证"每个真工具名都出现过"，**挡不住"只改了一半"**：
    // 把 prompt 里三处 query_transactions 改成 query_tx、第四处忘了改，
    // 上一条仍然绿（旧名字还在文本里），而模型已经在两处读到不存在的工具名。
    //
    // ⚠️ 抽出候选的正则**锚在名词上，不锚在动词前缀上**（审查 F4）：
    // 旧版 `/\b(?:query|create)_[a-z_]+/` 只认"我们已知的两个前缀"，于是
    // `delete_transaction`（一个**不存在的写工具**，直接违反"AI 只能读"）、
    // `queryTx`（无下划线）、`Query_transactions`（首字母大写）全都能溜过去 ——
    // 实测三种形态下本文件 **7/7 全绿**。取样逻辑见 toolNameCandidates。
    const prompt = buildSystemPrompt(SNAPSHOT, new Date(2026, 2, 1));
    const mentioned = toolNameCandidates(prompt);
    // 防空转：正则抽不到任何候选时，下面一条断言都不跑
    expect(mentioned.length).toBeGreaterThan(0);
    const known = TOOLS.map((t) => t.function.name);
    for (const name of mentioned) {
      expect(known, `prompt 提到的工具 ${name} 不在 TOOLS 里`).toContain(name);
    }
  });

  it.each([
    ["delete_transaction", "需要删除流水时可以调 delete_transaction"],
    ["queryTx", "需要查时可以调 queryTx"],
    ["Query_transactions", "可以调 Query_transactions"],
    // 增量复审实测"仍然全绿"的两种形态（⑤）：全大写被旧过滤的 `[Tt]` 漏掉；字母被拆开的
    // 写法在词级扫描里是一个名词都匹配不上的 23 个单字母词。
    ["DELETE_TRANSACTION", "需要删除流水时可以调 DELETE_TRANSACTION"],
    ["q u e r y _ t r a n s a c t i o n s", "需要删除时可以调 q u e r y _ t r a n s a c t i o n s"],
  ])("反向的判别力：%s 这种形态也会被抽成候选并在 TOOLS 里查不到", (expected, text) => {
    // 这条不测 prompt，而测**上面那条断言的抽取能力**：把三种"漏网形态"喂给同一个取样器，
    // 必须都被抽成候选。改窄上面那条正则（例如退回动词前缀）时它会红 —— 否则
    // "反向断言改窄之后仍然全绿"这件事本身没有人看得见（F4 的教训：在场 ≠ 能红）。
    const candidates = toolNameCandidates(text);
    expect(candidates).toContain(expected);
    // 抽到的候选确实不在真工具名单里 ⇒ 上面那条反向断言在这种 prompt 下必然红
    expect(TOOLS.map((t) => t.function.name)).not.toContain(expected);
  });

  it("块级扫描不误伤正常拼法：行首列表记号、裸词都不算异常", () => {
    // 这两条是上面"报警"一侧的对照：归一化后逐字等于真名字 ⇒ 报**真名字**（能过契约），
    // 而不是报 `- query_transactions` 这种带记号的原文（那会变成误报）。
    expect(toolNameCandidates("调 - query_transactions 时")).toEqual(["query_transactions"]);
    expect(toolNameCandidates("调 query_transactions 时")).toEqual(["query_transactions"]);
    // 拆开的真名字：归一化后等于真名字、原样不等于 ⇒ 报原样（它查不到 ⇒ 反向断言红）
    expect(toolNameCandidates("可以调 q u e r y _ t r a n s a c t i o n s")).toEqual([
      "q u e r y _ t r a n s a c t i o n s",
    ]);
  });

  it("反向的抽取不会宽到命中普通散文（不含名词就没有候选）", () => {
    expect(toolNameCandidates("账户与分类名字要与下面的快照一致")).toEqual([]);
    expect(toolNameCandidates("你可以查询、创建草稿")).toEqual([]);
    // prompt 里的 JSON 键 `"query":` 不能把裸 `query` 抽成候选（旧版就栽在这种形状上）
    expect(toolNameCandidates('{"query": "转账"}')).toEqual([]);
  });

  it("两个工具按规格 §4.2 的次序、且描述里写明了草稿不写库", () => {
    expect(TOOLS[0].function.name).toBe("query_transactions");
    expect(TOOLS[1].function.name).toBe("create_transaction_draft");
    expect(TOOLS.every((t) => t.type === "function")).toBe(true);
    // §4.2 硬要求：不写这句，模型会回"已经帮您记好了"，用户以为记上了
    expect(TOOLS[1].function.description).toContain("等待用户确认");
    expect(TOOLS[1].function.description).toContain("不得声称已经记账");
    // §7.3 的"最多前 20 条"也得在工具描述里对模型说清楚
    expect(TOOLS[0].function.description).toContain(String(MAX_PROMPT_ITEMS));
  });
});

/**
 * §8.E 的另一半：**取值层与必填层**。
 *
 * 字段名层（上面那个 describe）已经被夹住了，但把 `aggregate.enum` 从 `[...AGGREGATES]`
 * 硬编码成 `["sum","count"]`、再把 `required` 清空 ⇒ 当时三个文件 73 用例**全绿**
 * （审查 F5）⇒ "工具声明了但校验器不认/少认"的取值层与必填层今天没有防线。
 *
 * 这里逐项比对：工具声明的每个 enum 必须**逐字等于** dsl.ts 的常量（多一个少一个都红，
 * 顺序也钉住，因为模型读的是这份顺序）；`required` 必须与 `validateQuery` 的
 * **必填行为**一致（清空 required ⇒ 红）。
 */
describe("§8.E 取值层与必填层：schema 的 enum / required 必须与 dsl.ts 的常量一致", () => {
  function queryProps(): Record<string, { enum?: unknown; type?: unknown }> {
    return (TOOLS[0].function.parameters as { properties: Record<string, { enum?: unknown }> }).properties;
  }

  const ENUM_CONTRACT: { field: string; live: readonly string[]; golden: readonly string[] }[] = [
    { field: "aggregate", live: AGGREGATES, golden: ["sum", "count", "avg", "max", "min", "list"] },
    { field: "groupBy", live: GROUP_BYS, golden: ["category", "account", "member", "month", "day", "tag"] },
    { field: "orderBy", live: ORDER_BYS, golden: ["value_desc", "value_asc", "date_desc", "date_asc"] },
    { field: "type", live: TX_TYPES, golden: ["expense", "income", "transfer"] },
    { field: "date.preset", live: PRESET_KEYS, golden: [
      "today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "lastMonth",
      "last7Days", "last30Days", "last3Months", "last6Months", "thisYear", "lastYear",
    ] },
  ];

  it.each(ENUM_CONTRACT)("$field：dsl 常量没漂，且 schema 的 enum 就是这一份（顺序也一致）", ({ field, live, golden }) => {
    // golden 是冻结的字面量（不是拿常量再 join 出来），所以常量漂移时这条会红；
    // 第二条断言才是"schema 的 enum 与常量一致"。
    expect(golden).toEqual([...live]);
    const enumList =
      field === "date.preset"
        ? (queryProps().date as { properties: Record<string, { enum?: unknown }> }).properties.preset.enum
        : queryProps()[field].enum;
    expect(enumList).toEqual([...live]);
  });

  it("required 与校验器的必填行为一致：aggregate 必填（清空 required ⇒ 红）", () => {
    const required = (TOOLS[0].function.parameters as { required: unknown }).required;
    expect(required).toEqual(["aggregate"]);
    // 行为侧：aggregate 缺了就真被拒（否则 required 声明与校验器各说各话）
    const missing = validateQuery({ type: "expense" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.map((e) => e.code)).toContain("missing_aggregate");
  });

  it("草稿工具的 required 与它的两条硬必填一致（type / amount）", () => {
    const required = (TOOLS[1].function.parameters as { required: unknown }).required;
    expect(required).toEqual(["type", "amount"]);
  });

  it("schema 里不出现 dsl 不认的取值（枚举是引用常量、不是手写第二份）", () => {
    // 硬编码成 ["sum","count"] 时，`aggregate` 的 enum 会**丢**掉 dsl 认得的 max/min/list：
    // 上面 each 已经逐字比过了；这一条把"丢掉的取值"直接点出来，失败原因更可读。
    const dropped = [...AGGREGATES].filter((v) => !(queryProps().aggregate.enum as unknown[]).includes(v));
    expect(dropped).toEqual([]);
  });
});
