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

  it("不得用标签重复分类 / 金额 / 时间 / 账户已经表达清楚的内容", () => {
    const p = prompt();
    // 口径（人类补充）：结构化字段说清了的，不再用标签说第二遍（"买菜 58" 不该再打「生鲜」）。
    // 只写"优先用标签"会诱导模型把分类名原样塞进 tags —— 这条把那个方向堵住。
    expect(p).toMatch(/不要(?:再)?(?:用标签)?重复|别重复|重复打标签|重复地?打标签/);
    // 被点名的结构化字段至少要有 分类 / 金额，措辞里必须能看出"是它们已经表达清楚"
    expect(p).toMatch(/分类/);
    expect(p).toMatch(/金额/);
    expect(p).toMatch(/标签[^。\n]*(?:留给|只用于|用于)[^。\n]*(?:装不下|补充|表达不了)/);
  });

  it("点明标签补充的是什么：用途 / 对象这类结构化字段承载不了的信息", () => {
    const p = prompt();
    expect(p).toMatch(/报销|用途|对象/);
  });

  it("只用账本里**已有**的标签名，明说解析不到会失败、不许编造", () => {
    const p = prompt();
    // 依据 tools.ts:770-781 的草稿解析：名字对不上账本 ⇒ ok:false，草稿根本出不来
    expect(p).toMatch(/已有|已存在|现有的标签|现有标签|快照里(?:的|已有)标签/);
    expect(p).toMatch(/生成失败|解析不到|解析失败|名字对不上|对不上的标签/);
    expect(p).toMatch(/不要编造|不许编造|不得编造|不要自己编|别编造/);
  });

  it("把当前可用的标签逐个列给模型（不然它只能猜，或者自己在快照里翻）", () => {
    // ⚠️ 这条**不能**只断言 `toContain("生鲜")`：快照那一行本来就印了标签清单，
    // 那种断言恒真、看不见"引导行有没有把可选值列出来"。所以要钉住引导行本身。
    const line = prompt().split("\n").find((l) => l.startsWith("账本里当前可用的标签只有："));
    expect(line, "引导行里没有把可用标签列出来").toBeDefined();
    expect(line).toContain("生鲜");
    expect(line).toContain("报销");
  });

  it("空标签账本时那一行也自洽（复用「（暂无）」，不留半句话）", () => {
    const empty: LedgerSnapshot = { ...SNAPSHOT, tags: [] };
    const line = buildSystemPrompt(empty, new Date(2026, 2, 1))
      .split("\n")
      .find((l) => l.startsWith("账本里当前可用的标签只有："));
    expect(line).toBeDefined();
    expect(line).toContain("（暂无）");
  });

  it("反空转：这几句话必须落在「工具与示例」一节里，不是别处的偶然撞词", () => {
    const p = prompt();
    const section = p.slice(p.indexOf("## 4. 工具与示例"), p.indexOf("## 5."));
    expect(section).toMatch(/优先[^。\n]*标签|尽量[^。\n]*标签/);
    expect(section).toMatch(/已有|已存在|现有/);
    expect(section).toMatch(/不要(?:再)?用?标签重复|不要重复|别重复|重复打标签/);
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

  it("示例里的标签必须与同一行的分类名不同（不得用标签重复分类）", () => {
    // 口径的直接体现：「买菜」是分类，同一行再出现 tags=["买菜"] 就是把分类抄进标签。
    // 旧的 tags=["生鲜"]（买菜 ⊆ 生鲜）也是同一个毛病，所以这条同时钉住"同义标签也不行"。
    const withTags = draftCallLines(prompt()).filter((l) => /tags\s*=\s*\[/.test(l));
    for (const line of withTags) {
      const category = /category\s*=\s*"([^"]*)"/.exec(line)?.[1];
      expect(category, `带 tags 的草稿示例必须写明 category 才能检查重复：${line}`).toBeDefined();
      const tags = /tags\s*=\s*\[([^\]]*)\]/.exec(line)?.[1] ?? "";
      const names = [...tags.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(0);
      expect(names, "标签不得重复同一行的分类名").not.toContain(category);
      // 与分类同名或互为子串（买菜 / 买菜早餐）都算重复表达，示例里不许出现
      for (const n of names) {
        expect(category!.includes(n) || n.includes(category!), `标签「${n}」与分类「${category}」重复表达`).toBe(false);
      }
    }
  });

  it("示例体现「标签承载结构化字段装不下的信息」：报销这类用途标签 + 极短备注", () => {
    const withTags = draftCallLines(prompt()).filter((l) => /tags\s*=\s*\[/.test(l));
    expect(withTags.some((l) => /报销/.test(l))).toBe(true);
    // 反向：示例里**不再**出现与分类同义的标签（实测把报销换成生鲜时，只有这条会红）
    for (const line of withTags) {
      const names = [...(/tags\s*=\s*\[([^\]]*)\]/.exec(line)?.[1] ?? "").matchAll(/"([^"]+)"/g)]
        .map((m) => m[1]);
      expect(names, "示例里不该再用「生鲜」这种与分类同义的标签").not.toContain("生鲜");
    }
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

  it("tags 的 schema 描述写明：不得把分类 / 金额 / 时间 / 账户已表达的内容重复成标签", () => {
    const d = tagsDescription();
    // 同一口径落到 schema 上，避免模型把分类名（"买菜"）原样填进 tags 再重复一遍
    expect(d).toMatch(/不要(?:再)?重复|别重复|重复/);
    expect(d).toMatch(/分类/);
    expect(d).toMatch(/金额/);
    expect(d).toMatch(/标签[^。；]*(?:留给|只用于|用于|补充)/);
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
