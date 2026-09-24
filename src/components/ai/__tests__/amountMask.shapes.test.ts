// src/components/ai/__tests__/amountMask.shapes.test.ts
//
// Bug 2 的**隐私**那一半：遮蔽开着时，**模型自己写在正文里的数字一律不许上屏**。
//
// ## 根因（两半，缺一不可）
//  1. `payload.refs` 那一路（`maskAmountRefs`）**只认占位符**：`content` 里的 `{{q1.total}}`
//     会被遮住 —— 这一半是好的；
//  2. 但工具回给模型的 `items[].amount` 是**字面数字**（`tools.ts` 的 `toPromptItem`），
//     模型把它们抄进回答时，`refs` 这条路**一点用都没有** ⇒ 明文金额直接上屏。
//
// ## 所以漏的**不是"表格"这一种形状**，而是"正文里成文的数字"这一整类
// 实测漏网形状（修之前全漏，因为它们都不是占位符）：段落金额、列表项金额、表格单元格、
// 千分位 `1,234.56`、带单位 `128元` / `128.50 元`、货币前缀 `¥` `￥` `$`、全角数字 `１２８`、
// 全角小数点 `１２８．５０`、粘连 `金额为128.5万`、"万" `约12万`、负数 `-128.5` / `(128.50)`、
// 空格分组的 `1 234.56`、阿拉伯-印度数字 `١٢٨`、行内代码 `` `128.5` ``、引用行 ——
// 表格只是模型最常把明细列出来的地方。
//
// ## 本文件钉的契约是 **fail-safe**
// 遮蔽开着 ⇒ 遮完之后正文里**一个十进制数字都不许剩**（`\p{Nd}` 判据），无论模型用什么写法。
// 代价（人类要权衡，见文件末的"过度遮蔽"用例）：模型写在正文里的**日期 / 笔数 / 编号**也会被
// 一起遮（`2026-03-01` → `••••-••-••`）。
//
// 本文件**不动渲染器的语法范围**（表格仍按普通文本显示，见 `markdown.ts` 的"不支持"清单）。
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import { maskMessageText } from "@/components/ai/amountMask";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import type { UiMessage } from "@/stores/aiChat";

/** 正文里还剩十进制数字吗（Unicode 全部数字，含全角）—— 这就是 fail-safe 的判据本身 */
function hasDigit(text: string): boolean {
  return /\p{Nd}/u.test(text);
}

/** 遮蔽后必须**一个数字都不剩** */
function masked(content: string): string {
  return maskMessageText(content, {}, true);
}

function assistant(content: string, refs: Record<string, string> = {}): UiMessage {
  return {
    id: "m-shape-1",
    role: "assistant",
    content,
    payload: { chips: [], drafts: [], refs, trace: [] },
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

/** 挂载后取正文（= 用户看得见的那串文本） */
function rendered(m: UiMessage, maskedFlag: boolean): string {
  return mount(MessageBubble, { props: { message: m, masked: maskedFlag } })
    .get('[data-test="message-bubble-text"]')
    .text();
}

describe("模型自己写的数字：形状无关，一律遮（fail-safe）", () => {
  // 每条都先证明"这个样例里确实有数字"，否则断言会因为空转变成假绿
  const SHAPES: { name: string; content: string }[] = [
    { name: "段落里的整数金额", content: "上月一共花了 128 元。" },
    { name: "段落里的小数金额", content: "平均每笔 128.50 元。" },
    { name: "千分位", content: "合计 ¥1,234.56。" },
    { name: "数字与单位粘连（没有空格）", content: "房租128元，买菜128.5元。" },
    { name: "全角数字", content: "房租１２８元。" },
    { name: "全角数字 + 全角小数点", content: "房租１２８．５０元。" },
    { name: "美元符前缀", content: "合计 $128.50。" },
    { name: "全角人民币符号前缀", content: "合计 ￥128.50。" },
    { name: "「万」这种中文量级单位", content: "约12万。" },
    { name: "负数", content: "结余 -128.5 元。" },
    { name: "括号负数（会计写法）", content: "结余 (128.50)。" },
    { name: "空格分组的千分位", content: "合计 1 234.56。" },
    { name: "阿拉伯-印度数字（我们没预料到的形状）", content: "合计 ١٢٨ 元。" },
    { name: "无序列表项里的金额", content: "- 买菜 128.5\n- 打车 32" },
    { name: "有序列表项里的金额", content: "1. 买菜 128.5\n2. 打车 32" },
    {
      name: "表格行里的金额（Bug 2 的原始形态）",
      content: "| 分类 | 金额 |\n| --- | --- |\n| 买菜 | 128.50 |",
    },
    { name: "行内代码里的金额", content: "合计 `128.5` 元。" },
    { name: "引用行里的金额", content: "> 合计 128.5 元。" },
    { name: "数字与字母粘连", content: "v2 版一共 128 元。" },
    { name: "小数点后没有数字的写法", content: "合计 128. 元" },
  ];

  for (const { name, content } of SHAPES) {
    it(`${name} ⇒ 遮完一个数字都不剩`, () => {
      // 前提：样例本身确实带数字（否则这条用例什么都没验）
      expect(hasDigit(content)).toBe(true);

      // 杀手：把 `maskLiteralNumbers` 换回"只认货币符号 / 千分位那几种已知写法"（我第一版那个
      // 只在表格行里生效的 `AMOUNT_CELL_RE`）⇒ 一大批样例红（全角、阿拉伯-印度数字、列表、
      // 段落、行内代码、空格分组全漏）
      expect(hasDigit(masked(content))).toBe(false);
      expect(masked(content)).toContain(AMOUNT_PLACEHOLDER);
    });
  }

  it("货币符号与单位留着（它们不暴露金额大小），只有数字变星号", () => {
    expect(masked("合计 ¥1,234.56 元。")).toBe(`合计 ¥${AMOUNT_PLACEHOLDER} 元。`);
    expect(masked("房租128元")).toBe(`房租${AMOUNT_PLACEHOLDER}元`);
  });
});

describe("两路遮蔽的分工", () => {
  const GROUPED_TABLE = [
    "| 分类 | 金额 |",
    "| --- | --- |",
    "| 买菜 | {{q1.g0.total}} |",
  ].join("\n");

  it("占位符落在表格行里也照样回填 + 遮蔽（原来那一半没有坏）", () => {
    const text = maskMessageText(GROUPED_TABLE, { "q1.g0.total": "128.5" }, true);

    // 杀手：把字面量那一扫挪到回填**之后**，占位符会被当成正文扫坏 ⇒ 这条红
    expect(text).toContain(AMOUNT_PLACEHOLDER);
    expect(hasDigit(text)).toBe(false);
  });

  it("`refs` 回填出来的**笔数**照旧显示：语义只有键名知道，不许一并遮掉", () => {
    const text = maskMessageText(
      "上月买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。",
      { "q1.total": "128.5", "q1.count": "3" },
      true,
    );

    // 杀手：先回填再通篇扫数字（`maskLiteralNumbers(filled)`）⇒ 笔数变成 •••• 笔 ⇒ 这条红
    expect(text).toBe(`上月买菜花了 ${AMOUNT_PLACEHOLDER} 元，一共 3 笔。`);
  });

  it("占位符里的 `q1` 是**我们的键名**，不许被涂（涂了 `fillRefs` 就查不到键）", () => {
    // 查不到的键按 §7.2 原样保留（宁可暴露占位符，也不塞错数字）
    expect(maskMessageText("花了 {{q9.total}} 元", {}, true)).toBe("花了 {{q9.total}} 元");
  });

  it("不遮（本轮问出来 / 用户手动点开眼睛）⇒ 逐字不变，遮蔽不许越权", () => {
    const content = "| 日期 | 金额 |\n| --- | --- |\n| 2026-03-01 | 128.50 |";

    // 杀手：不判 `masked` 就对所有数字动手 ⇒ 这条红（本轮的真值被涂掉）
    expect(maskMessageText(content, {}, false)).toBe(content);
  });

  it("用户消息里的字面金额在遮蔽态下同样被遮（同一个函数、同一条规则）", () => {
    // 与草稿卡 / 芯片一致：用户自己口述的金额在"默认不显示"时也不上屏
    const w = mount(MessageBubble, {
      props: { message: { ...assistant("记一笔 128.5 的菜"), role: "user" }, masked: true },
    });
    expect(w.get('[data-test="message-bubble-text"]').text()).toBe(
      `记一笔 ${AMOUNT_PLACEHOLDER} 的菜`,
    );
  });
});

describe("挂载到气泡这一层（接线）", () => {
  it("历史消息（masked=true）的表格明细不许出现任何数字", () => {
    const m = assistant("| 日期 | 分类 | 金额 |\n| --- | --- | --- |\n| 2026-03-01 | 买菜 | 128.50 |");

    // 杀手：`MessageBubble` 把渲染接到 `props.message.content`（未遮蔽）上 ⇒ 这条红
    expect(hasDigit(rendered(m, true))).toBe(false);
    expect(rendered(m, true)).toContain(AMOUNT_PLACEHOLDER);
  });

  it("本轮问出来的（masked=false）表格明细显示真值", () => {
    const m = assistant("| 分类 | 金额 |\n| --- | --- |\n| 买菜 | 128.50 |");
    expect(rendered(m, false)).toContain("128.50");
  });
});

describe("已知代价与残余缺口（如实钉住，不是认可）", () => {
  it("**过度遮蔽**：模型写在正文里的日期 / 笔数 / 编号也一起被遮（fail-safe 的代价，人类权衡）", () => {
    const text = masked("2026-03-01 一共 3 笔，第 1 笔是买菜，花了 128.5 元。");

    // 这是"宁可多遮"的直接后果：日期与笔数读不出来了（`2026-03-01` 的三个数字段各自变星号）。
    // 想改成"日期除外"就等于把判据退回"只认我们预料过的形状"，而那种写法的漏网代价是
    // **明文金额**（上一个 describe 的杀手即此）。
    expect(text).toBe(
      `••••-••••-•••• 一共 ${AMOUNT_PLACEHOLDER} 笔，第 ${AMOUNT_PLACEHOLDER} 笔是买菜，花了 ${AMOUNT_PLACEHOLDER} 元。`,
    );
  });

  it("**残余缺口**：中文数字 / 英文单词写的金额遮不住（与正文里的「一/二/三」无法用形状区分）", () => {
    const content = "买菜花了一百二十八块五，one hundred and twenty eight yuan。";

    // 形状判据（`\p{Nd}`）看不见它们 ⇒ 只能靠提示词"数字必须写成引用"约束，
    // 而提示词**不是隐私边界**（模型不听话就漏）。这条用例的作用是：缺口一旦被修好，
    // 它会立刻红，逼着改注释与报告 —— 不许它悄悄留在那里。
    expect(masked(content)).toBe(content);
  });
});
