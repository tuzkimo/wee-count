import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type LedgerSnapshot } from "@/services/ai/prompt";
import { TOOLS } from "@/services/ai/tools";

/**
 * 「tags 优先于备注」这条**产品原则**必须落进模型看得见的两处文本：system prompt 与工具描述。
 *
 * 背景（本用例的由来）：标签是"用标签代替备注、方便检索"这个卖点的载体，工具**能力**
 * 早就有（`tools.ts` 的 `DRAFT_FIELDS` 含 tags、schema 里有 tags 参数），但
 * `prompt.ts` 的字段枚举与 few-shot、`tools.ts` 的草稿工具描述里都没有它 ⇒
 * 模型没有任何理由去写 tags（实机上只会照 few-shot 写 `note="盒马"`）。
 *
 * 每条断言都直接钉在**具体某一行的具体措辞**上，并配了"反空转"断言：
 * 断言不能因为措辞漂移而恒真（措辞一改就必须有人重新表态）。
 */

const SNAPSHOT: LedgerSnapshot = {
  kind: "personal",
  categories: [
    { name: "买菜", type: "expense" },
    { name: "交通", type: "expense" },
  ],
  accounts: [{ name: "招行储蓄卡", type: "银行卡" }],
  tags: ["生鲜", "报销"],
  members: [{ name: "我" }],
};

const prompt = (): string => buildSystemPrompt(SNAPSHOT, new Date(2026, 2, 1));

/** 三个工具说明行（`- 工具名：…`），断言落在行上而不是全文，避免"别处碰巧出现"的假绿 */
function toolLines(p: string): { query: string; draft: string } {
  const lines = p.split("\n");
  const query = lines.find((l) => l.startsWith("- query_transactions："));
  const draft = lines.find((l) => l.startsWith("- create_transaction_draft："));
  if (query === undefined || draft === undefined) {
    throw new Error("prompt 里的工具说明行不见了（措辞改了？重新表态这两行）");
  }
  return { query, draft };
}

/** few-shot 里所有 `create_transaction_draft（…）` 的调用行 */
function draftCallLines(p: string): string[] {
  return p.split("\n").filter((l) => l.includes("create_transaction_draft（"));
}

/**
 * 草稿工具 tags 参数的 schema 描述。
 *
 * 取 `properties.tags.description`（不是 `DRAFT_FIELDS` 那串字段名）：模型读的是
 * JSON Schema 里这一行描述，而"什么时候该用标签"必须写在这里才算真的引导到。
 */
function tagsDescription(): string {
  const params = TOOLS[1].function.parameters as {
    properties: Record<string, { description?: string }>;
  };
  const d = params.properties.tags?.description;
  if (d === undefined) throw new Error("草稿工具的 tags 参数没有 description");
  return d;
}

function draftToolDescription(): string {
  return TOOLS[1].function.description;
}

describe("system prompt：字段枚举必须含 tags", () => {
  it("草稿工具的说明行枚举了 tags（漏了它，模型没有理由写标签）", () => {
    const { draft } = toolLines(prompt());
    expect(draft).toContain("tags");
  });

  it("反空转：tags 出现在这一行的字段枚举里（与备注并列），不是别处提了一句", () => {
    // 只断言 `toContain("tags")` 的话，别处随便提一句标签就能满足它 ⇒ 钉住"括号里的那份枚举"。
    const { draft } = toolLines(prompt());
    const enumeration = /（([^）]*)）/.exec(draft);
    expect(enumeration, "草稿工具说明行里没有字段枚举括号").not.toBeNull();
    expect(enumeration![1]).toContain("备注");
    expect(enumeration![1]).toContain("tags");
  });
});

describe("system prompt：写明「能用标签就用标签」（保守措辞）", () => {
  it("有「优先 / 尽量」这类引导，且点明目的是少写 / 不写备注", () => {
    const p = prompt();
    // 断两半是因为措辞可能微调，但"优先用标签以少写备注"这个意思不能被稀释掉
    expect(p).toMatch(/优先[^。\n]*标签|尽量[^。\n]*标签/);
    expect(p).toMatch(/少写备注|不写备注|替代备注|代替备注/);
  });

  it("是「优先/尽量」而不是「必须」——不把标签写成硬要求", () => {
    const p = prompt();
    // 硬性措辞会让模型为了打标签而丢信息（备注里的话被丢掉），与"不许丢信息"直接冲突
    expect(p).not.toMatch(/必须(?:要)?(?:优先)?(?:写上|使用|打)?标签/);
    expect(p).not.toMatch(/一律(?:写|用)标签/);
  });

  it("不许因为引导 tags 而丢信息：装不下的仍要写进备注", () => {
    const p = prompt();
    expect(p).toMatch(/备注[^。\n]*(?:仍|还是|照样|要写|写进|写进备注)|装不下[^。\n]*备注/);
  });

  it("只用账本里**已有**的标签名，明说解析不到会失败、不许编造", () => {
    const p = prompt();
    // 依据 tools.ts:770-781 的草稿解析：名字对不上账本 ⇒ ok:false，草稿根本出不来
    expect(p).toMatch(/已有|已存在|现有的标签|现有标签|快照里(?:的|已有)标签/);
    expect(p).toMatch(/生成失败|解析不到|解析失败|名字对不上|对不上的标签/);
    expect(p).toMatch(/不要编造|不许编造|不得编造|不要自己编|别编造/);
  });

  it("反空转：这几句话必须落在「工具与示例」一节里，不是别处的偶然撞词", () => {
    const p = prompt();
    const section = p.slice(p.indexOf("## 4. 工具与示例"), p.indexOf("## 5."));
    expect(section).toMatch(/优先[^。\n]*标签|尽量[^。\n]*标签/);
    expect(section).toMatch(/已有|已存在|现有/);
  });
});

describe("system prompt：few-shot 要有带 tags 的草稿示例", () => {
  it("至少一条草稿示例调用里写了 tags=[…]", () => {
    const withTags = draftCallLines(prompt()).filter((l) => /tags\s*=\s*\[/.test(l));
    expect(withTags.length).toBeGreaterThanOrEqual(1);
  });

  it("该示例里用的标签名来自快照的标签清单（不是凭空的例子）", () => {
    const withTags = draftCallLines(prompt()).filter((l) => /tags\s*=\s*\[/.test(l));
    const tags = withTags.flatMap((l) => [...l.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    // 防空转：正则抽不到内容时下面的循环一条都不跑
    expect(tags.length).toBeGreaterThan(0);
    const known = SNAPSHOT.tags;
    expect(tags.some((t) => known.includes(t))).toBe(true);
  });

  it("示例体现「能用标签就不写备注」：不再给同一个示例塞一个长备注", () => {
    const withTags = draftCallLines(prompt()).filter((l) => /tags\s*=\s*\[/.test(l));
    for (const line of withTags) {
      const note = /note\s*=\s*"([^"]*)"/.exec(line);
      // 备注要么省略，要么极短（"盒马" 这种长度以内）——长句备注说明这条示例
      // 仍然在教"用备注承载信息"，与本次引导相反
      if (note !== null) expect(note[1].length).toBeLessThanOrEqual(4);
    }
  });

  it("既有示例的字段含义没被改动（示例 1 仍是 occurredAt + note）", () => {
    // 这是对"不要改动示例既有字段含义"这条纪律的回归钉：新增示例不得挤掉老示例
    const first = draftCallLines(prompt())[0];
    expect(first).toContain("amount=128");
    expect(first).toContain('occurredAt="2026-03-01T12:00"');
    expect(first).toContain('note="盒马"');
  });
});

describe("工具描述：草稿工具与 tags schema 都要引导标签", () => {
  it("草稿工具 description 的字段枚举含 tags", () => {
    expect(draftToolDescription()).toContain("tags");
  });

  it("反空转：tags 出现在字段枚举括号里（与备注并列），不是散文里提了一句", () => {
    const d = draftToolDescription();
    const enumeration = /（([^）]*)）/.exec(d);
    expect(enumeration, "草稿工具描述里没有字段枚举括号").not.toBeNull();
    expect(enumeration![1]).toContain("备注");
    expect(enumeration![1]).toContain("tags");
  });

  it("tags 的 schema 描述写明了使用时机：能表达清楚就优先用、少写备注", () => {
    const d = tagsDescription();
    expect(d).toMatch(/优先|尽量/);
    expect(d).toMatch(/少写备注|不写备注|替代备注|代替备注|备注/);
  });

  it("tags 的 schema 描述写明：只能用账本里已存在的标签名，不许自己编造", () => {
    const d = tagsDescription();
    expect(d).toMatch(/已存在|已有|现有/);
    expect(d).toMatch(/不要编造|不许编造|不得编造|不要自己编|编造/);
  });

  it("tags 的 schema 描述仍然说清了它是什么（名字数组），没把原意弄丢", () => {
    expect(tagsDescription()).toContain("标签");
  });

  it("note 的描述与 tags 分工一致：备注只装标签装不下的信息", () => {
    const params = TOOLS[1].function.parameters as {
      properties: Record<string, { description?: string }>;
    };
    const note = params.properties.note?.description;
    expect(note, "草稿工具的 note 参数没有 description").toBeDefined();
    // 引导 tags 的同时把备注的定位说清楚，避免模型把该说的话从备注里删掉（不许丢信息）
    expect(note).toMatch(/标签装不下|标签之外|标签表达不了/);
  });
});
