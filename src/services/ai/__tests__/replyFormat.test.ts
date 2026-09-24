import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type LedgerSnapshot } from "@/services/ai/prompt";
import { TOOLS } from "@/services/ai/tools";
import { PRESETS } from "@/utils/dateRange";

/**
 * 回复格式的口径（人类补充）：**不要 markdown 表格**。
 *
 * 理由：聊天气泡在手机上渲染表格必然横向溢出；而且表格里的金额会绕过遮蔽
 * （金额遮蔽另有专人修，这里先把"别产出表格"这条路堵住）。
 * 替代方案两条：能用列表就用列表；要列明细时**指向气泡下面那排可点的查询条件标签**，
 * 不在回复里铺明细。
 *
 * ⚠️ 2026-09-24 修订（规格 §4.7）：旧口径是"让他去流水页 / 报表页看"，已作废 ——
 * `/reports` 不接受任何筛选参数（`useReports.ts:8-9`），指过去可能看到与回答**不同的周期**；
 * 而气泡下面那排芯片（`FilterChips.vue`，`AiChatPage.vue:297-301` 渲染）本来就是可点的一次下钻。
 * 下面是这次修订的守卫：口径换成"指向那排标签"、标签文字只许由**这次真传进工具的条件**推导、
 * 没查过就不许提那排标签。
 *
 * 断言全部锚在**具体某一行**上，并配反空转：措辞一漂移就必须有人重新表态，
 * 而不是"顺带提了一句 markdown 就算过"。
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

function draftToolDescription(): string {
  return TOOLS[1].function.description;
}

function queryToolDescription(): string {
  return TOOLS[0].function.description;
}

/**
 * few-shot 的 4b 那一整块（示例横跨多行：用户行 / 工具行 / 回答行 / 说明行）。
 * 用"从 4b 那行起、到这一块结束"的切片断言，而不是逐行断言 —— 否则会把
 * "工具行在下一行"这种排版事实钉进用例里。
 */
function example4b(): string {
  const lines = prompt().split("\n");
  const start = lines.findIndex((l) => l.includes("4b."));
  if (start < 0) return "";
  return lines.slice(start, start + 5).join("\n");
}

describe("回复格式：禁止 markdown 表格", () => {
  it("prompt 里明说不要用 markdown 表格", () => {
    const p = prompt();
    // 必须点出"表格"这个对象 + 禁止语气，避免只是泛泛谈格式
    expect(p).toMatch(/不要用[^。\n]*表格|别用[^。\n]*表格|不使用[^。\n]*表格|禁止[^。\n]*表格/);
    expect(p).toMatch(/markdown|Markdown|MD/);
  });

  it("prompt 自己也不示范表格（不然模型照样会学）", () => {
    // 反空转：这条原本对任何实现恒真（prompt 里本来就没表格），但一旦有人"顺手加个表格示例"
    // 它立刻变红 —— 这正是本次要防的形态。
    const rows = prompt()
      .split("\n")
      .filter((l) => /^\s*\|/.test(l) || /^\s*[-:| ]{6,}\s*$/.test(l));
    expect(rows, `prompt 里出现了 markdown 表格行：${rows.join(" / ")}`).toEqual([]);
  });

  it("替代做法写明了：能用列表就用列表", () => {
    expect(prompt()).toMatch(/列表/);
    expect(prompt()).toMatch(/列表[^。\n]*(?:可以|就行|即可|优先|用)|能(?:用|够)列表/);
  });
});

describe("回复格式：明细引导指向气泡下面那排可点的查询标签（规格 §4.7）", () => {
  it("明说不要在回复里罗列明细，而是指向下面那排可点的标签", () => {
    const p = prompt();
    expect(p).toMatch(/明细/);
    // 指路的对象必须是"那排标签"（芯片），而不是"某个页面"；
    // 改 `prompt.ts` 的「回复的排版」那条（把"标签"换回"页面"）会让本用例红。
    expect(p).toMatch(/标签/);
    expect(p).toMatch(/可点|点一下|点击/);
    expect(p).toMatch(/下面/);
  });

  it("不再把「去流水页看」当引导口径（旧口径作废，/reports 不接受筛选参数）", () => {
    const p = prompt();
    // 只钉「引导」这一条，不误伤别处对流水页的正当引用（例如 matched 与流水页条数一致）
    const line = p.split("\n").find((l) => l.includes("不要在回复里罗列流水明细"));
    expect(line, "没找到「不要在回复里罗列流水明细」那一条").toBeDefined();
    // 旧口径的两处字面量都必须消失：整句「去流水页看更清楚」+「流水页 / 报表页」这对去处
    expect(p).not.toContain("去流水页看更清楚");
    expect(p).not.toMatch(/流水页\s*\/\s*报表页/);
    expect(line!).not.toContain("报表页");
    // 而且这一条必须是**禁止**语气（"不要笼统地说…"），不是把页面换个说法继续指
    expect(line!).toContain("不要");
  });

  it("示例引用的标签文字与 PRESETS 的中文标签逐字一致（预设改名而不改 prompt ⇒ 红）", () => {
    // 标签文字是**结构派生**的：日期预设的中文标签来自 PRESETS，类型拼中文名
    // （`FilterChips.vue:105-148` 的 chipLabel，用 ` · ` 连接）
    const label = `${PRESETS.find((x) => x.key === "thisMonth")!.label} · 支出`;
    const block = example4b();
    expect(block, "没找到「4b.」那条示例").not.toBe("");
    // 示例这次查询的两个条件必须真的会产出上面那个标签：日期预设 thisMonth + 类型 expense
    expect(block).toContain('date:{preset:"thisMonth"}');
    expect(block).toContain('type:"expense"');
    expect(block).toContain(`「${label}」`);
  });

  it("写明了「不许编造标签文字」与「没查过就不许提那排标签」", () => {
    const p = prompt();
    // 编造标签名 = 让用户去点一个不存在的芯片；没做查询时下面根本没有那排标签
    expect(p).toMatch(/不要编造|不许编造/);
    expect(p).toMatch(/没有(?:那排|这排)|没调|没有调/);
  });

  it("few-shot 里有一条「指向标签」的示例，且回答不罗列明细", () => {
    const block = example4b();
    expect(block, "没有一条示例把「想看最近这几笔」指向那排标签").not.toBe("");
    // 示例不能一边说去看标签、一边把明细铺出来：
    const answer = block.split("\n").find((l) => l.includes("点下面的"));
    expect(answer, "示例缺了「回答」那一行").toBeDefined();
    expect(answer, "示例的回答不该是列表（那就成了在回复里罗列明细）").not.toMatch(/(^|\s)[-*]\s|^\s*\d+\.\s/);
    const refs = [...answer!.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
    // 汇总（{{q1.total}} / {{q1.matched}}）可以有，逐条明细的引用不行 —— 用条数上限把"罗列"挡住
    expect(refs.length, `示例回答里引用太多（像是罗列明细）：${refs.join(" ")}`).toBeLessThanOrEqual(2);
  });
});

describe("工具描述：与回复格式口径一致", () => {
  it("查询工具描述指向那排标签，不再指向页面", () => {
    // 改 `tools.ts` 的 QUERY_TOOL description（把"标签"换回"流水页 / 报表页"）会让本用例红
    const d = queryToolDescription();
    expect(d).toMatch(/标签/);
    expect(d).not.toMatch(/流水页|报表页/);
  });

  it("草稿工具描述仍然只谈草稿，不新增与格式冲突的说法", () => {
    // 这条是「口径同步」的兜底：容器里若有与「去页面看」冲突的措辞（例如教模型罗列明细），
    // 这里先钉住草稿工具描述仍只讲草稿 + 不写库。
    const d = draftToolDescription();
    expect(d).toContain("不写库");
    expect(d).toContain("等待用户确认");
    expect(d).not.toMatch(/表格/);
  });
});
