import { describe, it, expect } from "vitest";
import { TOOLS, MAX_PROMPT_ITEMS } from "@/services/ai/tools";
import { validateQuery } from "@/services/ai/dsl";
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
    // 这里按工具名的构词（query_ / create_ 前缀）抽出候选，逐个要求在 TOOLS 里。
    // 变异实验：把 prompt.ts 里的工具名**部分**改名 → 这条必须红。
    const prompt = buildSystemPrompt(SNAPSHOT, new Date(2026, 2, 1));
    const mentioned = [...new Set(prompt.match(/\b(?:query|create)_[a-z_]+/g) ?? [])];
    // 防空转：正则抽不到任何工具名时，下面一条断言都不跑
    expect(mentioned.length).toBeGreaterThan(0);
    const known = TOOLS.map((t) => t.function.name);
    for (const name of mentioned) {
      expect(known, `prompt 提到的工具 ${name} 不在 TOOLS 里`).toContain(name);
    }
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
