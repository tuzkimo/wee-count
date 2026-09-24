// src/components/ai/__tests__/MessageBubble.tableMask.test.ts
//
// Bug 2 的一半（**隐私**，优先级高于"表格不渲染"）：**表格行里的金额必须被遮蔽**。
//
// 真机形态：模型回一张表（例如「上月各分类花费」或工具明细的逐条清单），表格里的金额
// 仍然是**明文数字**，而同一段回答里段落中的 `{{q1.total}}` 却被正常遮成了 `••••`。
//
// 根因（本文件两条用例把两半分开钉住）：
//  1. 遮蔽只管 `payload.refs` 里的**占位符**（`maskAmountRefs`）—— 这是管用的那一半；
//  2. 但工具返回给模型的 `items[].amount` 是**字面数字**（`tools.ts` 的 `toPromptItem`），
//     模型做表格时直接把它们抄进正文 ⇒ 这些数字不在 `refs` 里，**遮蔽机制根本看不见它们**。
//     与表格无关。表格只是模型最常把明细列出来的地方。
//
// 本文件**不动渲染器的语法范围**（表格仍按普通文本显示，见 `markdown.ts` 的"不支持"清单）。
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import { maskMessageText } from "@/components/ai/amountMask";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import type { UiMessage } from "@/stores/aiChat";

function assistant(content: string, refs: Record<string, string> = {}): UiMessage {
  return {
    id: "m-table-1",
    role: "assistant",
    content,
    payload: { chips: [], drafts: [], refs, trace: [] },
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

/** 挂载后取正文（= 用户看得见的那串文本） */
function rendered(m: UiMessage, masked: boolean): string {
  return mount(MessageBubble, { props: { message: m, masked } })
    .get('[data-test="message-bubble-text"]')
    .text();
}

const GROUPED_TABLE = [
  "| 分类 | 金额 |",
  "| --- | --- |",
  "| 买菜 | {{q1.g0.total}} |",
  "| 打车 | {{q1.g1.total}} |",
].join("\n");

const DETAIL_TABLE = [
  "| 日期 | 分类 | 金额 |",
  "| --- | --- | --- |",
  "| 2026-03-01 | 买菜 | 128.50 |",
  "| 2026-03-02 | 打车 | 32 |",
].join("\n");

describe("表格里的金额遮蔽（§7.4）", () => {
  it("① 占位符落在表格行里，回填 + 遮蔽照样生效（管用的那一半）", () => {
    const m = assistant(GROUPED_TABLE, { "q1.g0.total": "128.5", "q1.g1.total": "32" });

    const text = rendered(m, true);
    // 杀手：把 `masked` 判定接到"表格不支持 ⇒ 原样输出"的分支上 ⇒ 这两条红
    expect(text).toContain(AMOUNT_PLACEHOLDER);
    expect(text).not.toContain("128");
    expect(text).not.toContain("32");
  });

  it("② 表格行里的**字面**金额（模型抄工具明细的形态）也必须变星号", () => {
    // 杀手：只遮 `refs` 里的占位符、不管正文里已经成文的数字（= 修之前的行为）⇒ 这几条红
    const text = maskMessageText(DETAIL_TABLE, {}, true);

    expect(text).not.toContain("128.50");
    expect(text).not.toContain("128");
    expect(text).toContain(AMOUNT_PLACEHOLDER);
  });

  it("③ 表格里的**整数**金额一样要遮（128 与 128.50 都是钱）", () => {
    const text = maskMessageText(DETAIL_TABLE, {}, true);
    // 单独的 `32` 是 2026-03-02 那一笔的金额：它是整数，但不许因此漏出去
    expect(text).not.toContain("| 32 |");
  });

  it("④ 日期 / 笔数这类非金额单元格不被吃掉（遮蔽不许把回答弄成读不懂）", () => {
    const text = maskMessageText(DETAIL_TABLE, {}, true);

    // 杀手：把"表格行里的所有数字都涂掉"当成实现 ⇒ 日期被涂成 ••••-••-•• ⇒ 这条红
    expect(text).toContain("2026-03-01");
    expect(text).toContain("2026-03-02");
  });

  it("⑤ 带货币符号 / 单位的单元格：符号与单位留着，数字变星号", () => {
    const content = "| 项目 | 金额 |\n| --- | --- |\n| 房租 | ¥3,200.00 |\n| 买菜 | 128.50 元 |";
    const text = maskMessageText(content, {}, true);

    expect(text).not.toContain("3,200");
    expect(text).not.toContain("128.5");
    expect(text).toContain(`¥${AMOUNT_PLACEHOLDER}`);
    expect(text).toContain(`${AMOUNT_PLACEHOLDER} 元`);
  });

  it("⑥ 本轮问出来的（masked=false）表格显示真值：遮蔽不许越权", () => {
    const text = maskMessageText(DETAIL_TABLE, {}, false);

    // 杀手：不判 `masked` 就对所有表格数字动手 ⇒ 这条红（本轮的真值被涂掉）
    expect(text).toBe(DETAIL_TABLE);
  });

  it("⑦ 段落里成文的金额（不构成表格）不受影响：不误伤用户自己打的字", () => {
    const content = "你说「昨天买菜花了 128」，这里没有表格。";
    const text = maskMessageText(content, {}, true);

    // 杀手：把"数字都遮掉"当成实现（不看表格这个范围）⇒ 这条红
    expect(text).toBe(content);
  });
});
