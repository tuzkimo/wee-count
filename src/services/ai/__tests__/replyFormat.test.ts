import { describe, it, expect } from "vitest";
import { buildSystemPrompt, type LedgerSnapshot } from "@/services/ai/prompt";
import { TOOLS } from "@/services/ai/tools";

/**
 * 回复格式的口径（人类补充）：**不要 markdown 表格**。
 *
 * 理由：聊天气泡在手机上渲染表格必然横向溢出；而且表格里的金额会绕过遮蔽
 * （金额遮蔽另有专人修，这里先把"别产出表格"这条路堵住）。
 * 替代方案两条：能用列表就用列表；要列明细时**引导用户去对应页面看**，不在回复里铺明细。
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

describe("回复格式：明细引导到对应页面，不在回复里罗列", () => {
  it("明说不要在回复里罗列明细，而是让用户去页面看", () => {
    const p = prompt();
    expect(p).toMatch(/明细/);
    expect(p).toMatch(/去[^。\n]*页[^。\n]*(?:看|查)|页[^。\n]*(?:里|上)看|到[^。\n]*页看/);
  });

  it("点出了具体去处（流水页 / 报表页），不是「去别处看」这种空话", () => {
    const p = prompt();
    expect(p).toMatch(/流水页|报表页/);
    // 两个去处至少都要能被模型照着说：明细→流水页，各类别金额→报表页
    expect(p).toMatch(/流水页/);
    expect(p).toMatch(/报表页/);
  });

  it("few-shot 里有一条「明细引导到页面」的示例", () => {
    const p = prompt();
    const line = p.split("\n").find((l) => l.includes("最近") && /流水页/.test(l));
    expect(line, "没有一条示例把「想看最近这几笔」引导到流水页").toBeDefined();
    // 示例不能一边说去页面看、一边把明细铺出来：
    // 判据是"回答行里没有逐条列表"（汇总数字照旧要写 refs，所以不能笼统地禁 {{q1.}}）。
    const answer = p
      .split("\n")
      .find((l) => l.includes("最近的支出共") && l.includes("流水页"));
    expect(answer, "示例缺了「回答」那一行").toBeDefined();
    expect(answer, "示例的回答不该是列表（那就成了在回复里罗列明细）").not.toMatch(/(^|\s)[-*]\s|^\s*\d+\.\s/);
    const refs = [...answer!.matchAll(/\{\{[^}]+\}\}/g)].map((m) => m[0]);
    // 汇总（{{q1.total}} / {{q1.matched}}）可以有，逐条明细的引用不行 —— 用条数上限把"罗列"挡住
    expect(refs.length, `示例回答里引用太多（像是罗列明细）：${refs.join(" ")}`).toBeLessThanOrEqual(2);
  });
});

describe("工具描述：与回复格式口径一致", () => {
  it("草稿工具描述仍然只谈草稿，不新增与格式冲突的说法", () => {
    // 这条是「口径同步」的兜底：容器里若有与「去页面看」冲突的措辞（例如教模型罗列明细），
    // 这里先钉住草稿工具描述仍只讲草稿 + 不写库。
    const d = draftToolDescription();
    expect(d).toContain("不写库");
    expect(d).toContain("等待用户确认");
    expect(d).not.toMatch(/表格/);
  });
});
