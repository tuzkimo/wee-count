import { describe, it, expect, vi } from "vitest";
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  fillRefs,
  type LedgerSnapshot,
} from "@/services/ai/prompt";
import {
  AGGREGATES,
  AMOUNT_KEYS,
  DATE_KEYS,
  GROUP_BYS,
  ORDER_BYS,
  PRESET_KEYS,
  TX_TYPES,
} from "@/services/ai/dsl";
import { TOOLS } from "@/services/ai/tools";
import { toDateKey } from "@/utils/dateRange";

/**
 * 上游（DB / store）交给 prompt 的快照**带 id**，账户还带余额与信用额度。
 *
 * 为什么 fixture 要刻意"脏"：§7.1 要求「元数据里刻意不给 id」、§7.3 要求「绝不发余额、
 * 信用额度、其他账本数据、任何凭据」。若只喂一份干净快照，那两条"不得出现"的断言
 * 对任何实现都恒真（空转）；喂一份带这些字段的对象，才只有"逐字段白名单渲染"的实现
 * 能绿 —— `JSON.stringify(s)` 或展开运算符会把它们一起吐出来。
 * 必须是**非新鲜对象**（先赋给带类型的变量），否则 TS 的多余属性检查会拦下这个 fixture。
 */
interface ContaminatedSnapshot extends LedgerSnapshot {
  categories: (LedgerSnapshot["categories"][number] & { id: string })[];
  accounts: (LedgerSnapshot["accounts"][number] & {
    id: string;
    balance: number;
    creditLimit?: number;
  })[];
  members: (LedgerSnapshot["members"][number] & { id: string })[];
  backupPassword: string;
  apiKey: string;
  otherLedgerSummary: string;
}

const SNAPSHOT_WITH_EXTRAS: ContaminatedSnapshot = {
  kind: "team",
  categories: [
    { id: "3f4a1b2c-9d8e-4f5a-b6c7-8d9e0f1a2b3c", name: "餐饮", type: "expense" },
    { id: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f", name: "其他", type: "expense" },
    { id: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d", name: "其他", type: "income" },
    { id: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e", name: "工资", type: "income" },
  ],
  accounts: [
    {
      id: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
      name: "招行储蓄卡",
      type: "银行卡",
      balance: 12345.67,
      creditLimit: 50000,
    },
    { id: "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a", name: "微信零钱", type: "电子钱包", balance: 8.5 },
  ],
  tags: ["生鲜", "报销"],
  members: [
    { id: "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d", name: "老婆", note: "太太" },
    { id: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e", name: "妈妈" },
  ],
  backupPassword: "hunter2-not-in-prompt",
  apiKey: "sk-live-not-in-prompt",
  otherLedgerSummary: "另一个账本的流水汇总",
};

const SNAPSHOT: LedgerSnapshot = SNAPSHOT_WITH_EXTRAS;

const NOW = new Date("2026-03-01T00:00:00Z");

const prompt = (): string => buildSystemPrompt(SNAPSHOT, NOW);
const promptWith = (s: LedgerSnapshot, now: Date): string => buildSystemPrompt(s, now);

/**
 * few-shot 里唯一一处 `aggregate:"…"` 的取值（示例 2）。
 *
 * 它必须由 `AGGREGATES` 派生，不能手写第二份字面量：常量一旦改名，手写的示例会教
 * 模型一个 `validateQuery` 不认的取值（`bad_aggregate`），而清单行的断言看不见示例行。
 */
function fewShotAggregate(p: string): string {
  const m = /aggregate:"([^"]*)"/.exec(p);
  if (m === null) throw new Error("few-shot 里没有 aggregate:\"…\" 示例（示例 2 被删了？）");
  return m[1];
}

describe("PROMPT_VERSION", () => {
  it("是数字，且以 prompt_version=<值> 落进 prompt 文本（老会话可追溯）", () => {
    expect(typeof PROMPT_VERSION).toBe("number");
    // 必须带前缀断言：裸的 String(PROMPT_VERSION) 会被文本里的 "20 条"、"50" 之类碰巧满足（恒真）
    expect(prompt()).toContain(`prompt_version=${PROMPT_VERSION}`);
  });
});

describe("buildSystemPrompt 账本元数据快照", () => {
  it("账本类型、分类带收支后缀（同名的「其他」必须靠后缀区分）", () => {
    const p = prompt();
    expect(p).toContain("账本：团队");
    expect(p).toContain("其他(支出)");
    expect(p).toContain("其他(收入)");
    expect(p).toContain("工资(收入)");
  });

  it("账户带类型、成员带备注（没备注的成员不带空括号）", () => {
    const p = prompt();
    expect(p).toContain("招行储蓄卡(银行卡)");
    expect(p).toContain("微信零钱(电子钱包)");
    expect(p).toContain("老婆(备注: 太太)");
    expect(p).toContain("妈妈");
    expect(p).not.toContain("妈妈(");
  });

  it("标签是名字清单", () => {
    expect(prompt()).toContain("生鲜");
    expect(prompt()).toContain("报销");
  });

  it("快照里带 id 也不许漏进 prompt（不得出现 id/UUID）", () => {
    // 输入 fixture 的每一项都带真实 UUID，所以这条不是恒真断言：
    // 任何 JSON.stringify / 展开字段的实现都会红。
    expect(prompt()).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("空账本（还没有标签/成员）渲染成「（暂无）」而不是空串", () => {
    const empty: LedgerSnapshot = {
      kind: "personal",
      categories: [],
      accounts: [],
      tags: [],
      members: [],
    };
    const p = promptWith(empty, NOW);
    expect(p).toContain("账本：个人");
    expect(p).toContain("分类：（暂无）");
    expect(p).toContain("标签：（暂无）");
    expect(p).toContain("成员：（暂无）");
  });
});

describe("buildSystemPrompt 今天日期", () => {
  it("用传入的 now 渲染成 YYYY-MM-DD（不是跑测试那天的日期）", () => {
    const p = promptWith(SNAPSHOT, new Date("2026-03-01T00:00:00Z"));
    expect(p).toContain(toDateKey(new Date("2026-03-01T00:00:00Z")));
    expect(p).toContain("2026-03-01");
  });

  it("按本地时区取日期：UTC 的 2/28 16:30 在东八区已经是 3/1", () => {
    // 这条与上一条是**两条独立的防线**：上一条的 now 在 UTC 与本地同一天，
    // 用 toISOString().slice(0,10) 的实现也能过；只有这一条能抓住 UTC/本地混淆。
    //
    // ⚠️ 「东八区」必须由测试自己钉住，不能靠跑测试那台机器的偏移：CI 的
    // ubuntu-latest 是 UTC，`2026-02-28T16:30Z` 在那里本来就还是 2/28，
    // 断言会与实现无关地红。写法照仓内先例（`src/utils/__tests__/datetime.test.ts:44-51`）：
    // 临时设 `process.env.TZ` 并在 finally 里逐字还原。
    const prevTZ = process.env.TZ;
    process.env.TZ = "Asia/Shanghai";
    try {
      const p = promptWith(SNAPSHOT, new Date("2026-02-28T16:30:00Z"));
      expect(p).toContain("2026-03-01");
      expect(p).not.toContain("2026-02-28");
    } finally {
      if (prevTZ === undefined) delete process.env.TZ;
      else process.env.TZ = prevTZ;
    }
  });

  it("写明了时区，否则「今天」在跨时区时会被模型理解错", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(prompt()).toContain(zone);
  });
});

describe("buildSystemPrompt few-shot 示例", () => {
  it("四个形状都在：日期预设查询 / 猜不出名字要反问 / 建草稿 / 不调工具直接答", () => {
    const p = prompt();
    // 工具名（两个都得出现，模型只能看见 prompt 里写过的名字）
    expect(p).toContain("query_transactions");
    expect(p).toContain("create_transaction_draft");
    // (1) 带日期预设的查询
    expect(p).toContain("今年在盒马买菜花了多少钱");
    // (2) 名字可能解析不出来 → 反问而不是硬猜
    expect(p).toContain("你是指");
    expect(p).toContain("不要自己猜");
    // (3) 建草稿
    expect(p).toContain("昨天在盒马买菜花了 128");
    // (4) 不调工具的直接回答
    expect(p).toContain("我有哪些账户");
    expect(p).toContain("不调用任何工具");
  });

  it("还带上了规格 §7.1 的第三次查询示例（两次查询后对比）", () => {
    expect(prompt()).toContain("这个月花的比上个月多吗");
  });

  it("「一共几笔」的示例引用的是 matched（不是支出桶的 count）", () => {
    // F3：芯片的 applied.type=null ⇒ 流水页列表**含转账**（filterQuery.ts:27），
    // 而 `{{q1.count}}` 是支出桶笔数 ⇒ 用户会看到"AI 说 1 笔、列表 2 条"，
    // 正是 M1 约束 8 警告的形态。所以示例里的笔数引用必须是 matched。
    // ⚠️ 断言落在**引用的是哪个键**上（不是"这句话在"）：把实现改回 q1.count 必须红。
    const p = prompt();
    expect(p).toContain("{{q1.matched}} 笔");
    expect(p).not.toContain("{{q1.count}}");
  });

  it("输出约定写明了 matched 与 count 的区别、以及分组引用的形状（F7）", () => {
    const p = prompt();
    expect(p).toContain("{{qN.matched}}");
    expect(p).toContain("{{qN.count}}");
    expect(p).toContain("groupBy");
    expect(p).toContain("{{qN.g0.total}}");
    expect(p).toContain("{{qN.g0.label}}");
  });
});

/**
 * few-shot 里**参数名**的通用契约（计划修正第 19 条的通用化）。
 *
 * 同族缺陷已经出现过三次（`PRESET_KEYS` 取值、`AGGREGATES` 取值、这一次的工具参数名），
 * 每次只修一个示例必然复发 ⇒ 这里从 prompt 文本里**抽出工具调用行**的参数名，
 * 逐个要求它属于该工具的 `properties`。模型照着 prompt 调用时，参数名写错就是一条
 * 必然吃到的错误（`create_transaction_draft` 的未知字段分支），而不是"模型自己发挥"。
 *
 * 抽取规则（有意写窄，避免全篇抓 `=`）：
 * - 工具调用形状是 `工具名（…）`（中文全角括号，与 prompt 正文一致）
 * - 参数名是紧跟全角/半角括号或逗号的标识符，后面接 `=` 或 `:`（`amount=128`、`categories:["买菜"]`）
 * - 后视 `(?<![\w{:.])` 排除 `{date:{preset:"yesterday"}}` 里的 `preset`、`{from/to}` 里的键，
 *   以及 `{{q1.matched}}` 这类引用
 */
function toolCallParams(p: string): { tool: string; name: string }[] {
  const propsOf = (tool: string): string[] => {
    const schema = TOOLS.find((t) => t.function.name === tool);
    if (schema === undefined) return [];
    const params = schema.function.parameters as { properties: Record<string, unknown> };
    return Object.keys(params.properties);
  };
  const out: { tool: string; name: string }[] = [];
  for (const call of p.matchAll(/([a-z_]+)（([^）]*)）/g)) {
    const [, tool, args] = call;
    const known = propsOf(tool);
    if (known.length === 0) {
      // `ident（…）` 这个形状也会命中**散文**（`aggregate（必填）`、`transfer（省略表示…）`）
      // 与**参数赋值里嵌的对象**（`aggregate:"sum"`）。真正的"调用不在 TOOLS 里"判别式是
      // 「括号里以 ASCII 参数名赋值开头」——`delete_transaction（foo=1）` 命中它，
      // 上面两条散文都不命中。工具名自身的漂移另有 toolSchemaContract.test.ts 的反向断言。
      if (!/^[A-Za-z_][A-Za-z0-9_]*\s*[=:]/.test(args)) continue;
      expect(TOOLS.map((t) => t.function.name), `prompt 调了未知工具 ${tool}`).toContain(tool);
      continue;
    }
    // 按分隔符切开后**只看每段的开头**：段首的 `ident=` / `ident:` 才是这一层的参数名。
    // 这样既不会把值里的内容算进来，也不会被 `{preset:` 这种嵌套键混进来（它不是段首）。
    // ⚠️ 不要把 `ident[=:]` 直接全文 match：`type="expense"，amount=128` 这种写法下，
    // 第一段之后的扫描会从值里继续，段首判断就失效（实测 4 个参数只抽到 1 个）。
    for (const part of args.split(/[，,]/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[=:]/.exec(part);
      if (m !== null) out.push({ tool, name: m[1] });
    }
  }
  return out;
}

describe("few-shot 里的工具参数名必须属于对应工具的 schema", () => {
  it("每个抽到的参数名都在该工具的 properties 里（抽取式，不是改一个示例）", () => {
    const params = toolCallParams(prompt());
    // 防空转：抽取失败（正则与 prompt 措辞脱节）时下面的循环一条断言都不跑，
    // 这条测试就会变成恒真 —— 4 个示例里真参数名至少有 6 个（见示例 1/2/3）。
    expect(params.length).toBeGreaterThanOrEqual(6);
    for (const { tool, name } of params) {
      const schema = TOOLS.find((t) => t.function.name === tool);
      expect(schema, `prompt 调了未知工具 ${tool}`).toBeDefined();
      const props = (schema!.function.parameters as { properties: Record<string, unknown> }).properties;
      expect(
        Object.keys(props),
        `few-shot 教模型用 ${tool}（${name}=…），但工具没有这个参数`,
      ).toContain(name);
    }
  });

  it("示例 1 用的是草稿工具真有的字段（occurredAt / note，不是 date / merchant）", () => {
    // Ruling 30 第 1 条：旧示例教 model 调 `create_transaction_draft（date=…, merchant=…）`，
    // 而草稿工具只有 occurredAt / note ⇒ 模型照示例调用**必然**吃一条未知字段错误。
    const draftLine = prompt()
      .split("\n")
      .find((line) => line.includes("create_transaction_draft（"));
    expect(draftLine).toBeDefined();
    expect(draftLine).toContain("occurredAt=");
    expect(draftLine).toContain("note=");
    expect(draftLine).not.toMatch(/\bdate\s*=/);
    expect(draftLine).not.toMatch(/\bmerchant\s*=/);
  });
});

describe("buildSystemPrompt 禁止清单", () => {
  it.each([
    ["不得编造数字", "不得编造任何数字"],
    ["不得声称已记账", "不得声称已经记账"],
    ["不得调用不存在的工具", "不得调用不存在的工具"],
    ["回答里不得出现 id", "回答里不得出现任何 id"],
  ])("%s：prompt 里有这句话", (_name, phrase) => {
    expect(prompt()).toContain(phrase);
  });

  it("「已生成草稿，请确认」是唯一允许的记账措辞", () => {
    expect(prompt()).toContain("已生成草稿，请确认");
  });
});

describe("prompt 的取值清单来自 dsl.ts 的导出常量", () => {
  /**
   * 每项两侧夹住：golden 是**冻结的字面量**（不是 import 进来再 join 的），
   * live 是 dsl.ts 的当前常量。
   * - `golden === live` 失败 ⇒ dsl.ts 的常量变了，而 prompt 的契约没跟着表态 → 红
   * - `p 含 golden` 失败 ⇒ prompt 没把这份清单印出来（或印成了另一份）→ 红
   * 两条都必要、互不替代：任何一条被删掉，下面每种漂移方向都会有一个"假绿"口子。
   * 刻意**不**再断言 `p 含 live.join(...)`：那在常量漂移时两边一起变、恒绿，是空转。
   */
  const LISTS: { name: string; live: string; golden: string }[] = [
    {
      name: "aggregate",
      live: AGGREGATES.join(" / "),
      golden: "sum / count / avg / max / min / list",
    },
    {
      name: "groupBy",
      live: GROUP_BYS.join(" / "),
      golden: "category / account / member / month / day / tag",
    },
    {
      name: "orderBy",
      live: ORDER_BYS.join(" / "),
      golden: "value_desc / value_asc / date_desc / date_asc",
    },
    {
      name: "type",
      live: TX_TYPES.join(" / "),
      golden: "expense / income / transfer",
    },
    {
      name: "date.preset",
      live: PRESET_KEYS.join(" / "),
      golden:
        "today / yesterday / thisWeek / lastWeek / thisMonth / lastMonth / " +
        "last7Days / last30Days / last3Months / last6Months / thisYear / lastYear",
    },
    {
      name: "date 内层键",
      live: DATE_KEYS.join(" / "),
      golden: "preset / from / to",
    },
    {
      name: "amount 内层键",
      live: AMOUNT_KEYS.join(" / "),
      golden: "min / max",
    },
  ];

  it.each(LISTS)("$name：dsl.ts 的常量没漂，且 prompt 印的就是这一份", ({ live, golden }) => {
    expect(golden).toBe(live);
    expect(prompt()).toContain(golden);
  });

  it("few-shot 里印的取值也是同一份常量（示例行不手写第二份真相）", () => {
    // 这一段的分辨力来自**变异实验**（把 `AGGREGATES[0]` 改名 ⇒ 这条与上面的清单断言一起红）；
    // 断言本身只钉「示例的取值是常量里的一员」——写死成别的合法值时它绿，那是**契约**问题
    // （示例不再跟着常量走），由上面 `golden === live` 与变异实验共同负责，不在这里制造恒真口子。
    expect(AGGREGATES).toContain(fewShotAggregate(prompt()));
  });

  it('few-shot 文本里每一个 preset:"…" 字面量都属于 PRESET_KEYS（任务 2 收尾）', () => {
    // F3 的 few-shot「取值」守卫只覆盖 aggregate 一处（上面那条），而示例里还有
    // preset 字面量：它们同样是**手写的第二份真相**——常量改名后示例会教模型一个
    // validateQuery 不认的 preset（bad_date_preset），而清单行断言看不见示例行。
    //
    // 正则形如 `preset:"xxx"`，字符类排除 `…`：工具说明里那处 `{preset:"…"}` 是
    // **省略号形状示例**、不是取值，把它算进来会让断言恒假。
    // 不用 `PRESET_KEYS[?]` 索引插值来"修好"示例：索引耦合，改常量顺序会静默错位 ✗。
    const names = [...prompt().matchAll(/preset:"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]);
    // 防空转：正则若因为措辞变化匹配不到任何东西，下面的循环一条断言都不跑
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(PRESET_KEYS as readonly string[]).toContain(name);
    }
  });
});

describe("prompt 的隐私边界（§7.3 绝不发的）", () => {
  it("快照里的余额 / 信用额度 / 凭据 / 其他账本数据一个都不许出现", () => {
    const p = prompt();
    // 每种金额**两种形态都要钉**（裸值 + 本仓惯用的 zh-CN 格式化形态）：
    // `"12,345.67".includes("12345.67") === false`，只钉裸值的断言看不见
    // 「写完 toLocaleString 再漏出去」这条路径，而金额在本仓照例走
    // `toLocaleString("zh-CN", …)`（`src/utils/useAmountMask.ts:35`、`src/utils/transaction.ts:36`
    // 的用法）⇒ 格式化形态恰恰是最可能被顺手抄进取值路径的那一种。
    // 形态实测（minimumFractionDigits 0/2 两档）：
    //   12345.67 → "12,345.67" | "12,345.67"
    //   8.5      → "8.5"       | "8.50"
    //   50000    → "50,000"    | "50,000.00"
    expect(p).not.toContain("12345.67"); // 账户余额（裸值）
    expect(p).not.toContain("12,345.67"); // 账户余额（zh-CN 格式化）
    expect(p).not.toContain("8.5"); // 第二个账户余额（裸值 "8.5" / 格式化 "8.50" 都含它）
    expect(p).not.toContain("50000"); // 信用额度（裸值）
    expect(p).not.toContain("50,000"); // 信用额度（两档格式化都含它）
    expect(p).not.toContain("sk-live-not-in-prompt"); // API key
    expect(p).not.toContain("hunter2-not-in-prompt"); // 备份密码
    expect(p).not.toContain("另一个账本的流水汇总"); // 其他账本数据
  });

  it("prompt 自己也不提余额 / 信用额度 / 凭据（这些字段根本不该出现在给模型的话里）", () => {
    const p = prompt();
    expect(p).not.toContain("余额");
    expect(p).not.toContain("信用额度");
    expect(p).not.toContain("凭据");
    expect(p).not.toContain("密码");
  });
});

describe("fillRefs", () => {
  it("带点的扁平键（key 就是 \"q1.total\"，不是嵌套对象）", () => {
    expect(fillRefs("花了 {{q1.total}} 元", { "q1.total": 128 })).toBe("花了 128 元");
  });

  it("一条文本里的多个引用各自回填（数字与字符串都支持）", () => {
    expect(
      fillRefs("今年在{{q1.merchant}}共花了 {{q1.total}} 元，{{q1.count}} 笔", {
        "q1.merchant": "盒马",
        "q1.total": 128.5,
        "q1.count": 3,
      }),
    ).toBe("今年在盒马共花了 128.5 元，3 笔");
  });

  it("值为 0 的 ref 回填成 0（0 是有效值，不是查不到）", () => {
    expect(fillRefs("共 {{q1.count}} 笔", { "q1.count": 0 })).toBe("共 0 笔");
  });

  it("未知 key 原样保留，并 console.warn 一次", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 先断言文本：红必须红在"原文被替换成空串"这个原因上，不能被后面的 warn 断言遮住
    expect(fillRefs("花了 {{q9.total}} 元", {})).toBe("花了 {{q9.total}} 元");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("原型链上的名字（{{toString}}）也算未知 key，不得被 String() 出来", () => {
    // refs["toString"] 命中的是 Object.prototype.toString，是函数、不是 undefined。
    // 只判 `refs[key] === undefined` 的实现会把它塞进回答里 —— 与"未知 key 保留原文"是同一个契约。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = fillRefs("{{toString}}", {});
    expect(out).toBe("{{toString}}");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("没有占位符时原样透传，不做任何转义或格式化", () => {
    const text = '一共 100 元 <b> & "引号" 50% {{a-b}} {{ }}';
    expect(fillRefs(text, { "q1.total": 1 })).toBe(text);
  });

  it("空文本仍是空文本", () => {
    expect(fillRefs("", {})).toBe("");
  });
});
