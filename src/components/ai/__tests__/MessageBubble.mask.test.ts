// src/components/ai/__tests__/MessageBubble.mask.test.ts
//
// §7.4 乙方案在**气泡这一层**的落点：`masked` 是调用方按消息算好传进来的（组件不读 store）。
// 单独一份（而不是往 `MessageBubble.test.ts` 里加）：那份文件的挂载**没有 pinia** ——
// 它钉的是"回填与绝不渲染 id"，要是在那里读全局开关，那些用例就得被迫挂 pinia。
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import type { UiMessage } from "@/stores/aiChat";

function assistant(content: string, refs: Record<string, string>): UiMessage {
  return {
    id: "m-1",
    role: "assistant",
    content,
    payload: { chips: [], drafts: [], refs, trace: [] },
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

function textOf(m: UiMessage, masked: boolean | undefined): string {
  // 用条件展开而不是 `masked: undefined`：`defineProps` 的类型把"缺席"表达成 `masked?: undefined`，
  // 显式传 `undefined` 与 `boolean` 会拼成一个 TS 不肯收的联合（而运行时两者等价）
  const props: { message: UiMessage; masked?: boolean } = { message: m };
  if (masked !== undefined) props.masked = masked;
  return mount(MessageBubble, { props }).get('[data-test="message-bubble-text"]').text();
}

describe("MessageBubble 金额遮罩（§7.4）", () => {
  it("历史消息（masked=true）⇒ 金额渲染成占位符，笔数不受影响", () => {
    const m = assistant("上月买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。", {
      "q1.total": "128.5",
      "q1.count": "3",
    });
    // 杀手：把 `maskMessageText(..., props.masked === true)` 的第三参数写死 false ⇒ 这条红
    expect(textOf(m, true)).toBe(`上月买菜花了 ${AMOUNT_PLACEHOLDER} 元，一共 3 笔。`);
    expect(textOf(m, true)).not.toContain("128");
  });

  it("本轮消息（masked=false）⇒ 真值上屏", () => {
    const m = assistant("上月买菜花了 {{q1.total}} 元", { "q1.total": "128.5" });
    expect(textOf(m, false)).toBe("上月买菜花了 128.5 元");
  });

  it("不传 `masked`（旧调用点）⇒ 与任务 7 之前完全一致：回填、不遮", () => {
    const m = assistant("上月买菜花了 {{q1.total}} 元", { "q1.total": "128.5" });
    // 杀手：把"未传"也当成"要遮" ⇒ 这条红（会让所有没接线的调用点突然遮起来）
    expect(textOf(m, undefined)).toBe("上月买菜花了 128.5 元");
  });

  it("遮罩不改 `payload` 本身：真值仍在消息对象里（回填与跳转都还要用）", () => {
    const m = assistant("花了 {{q1.total}} 元", { "q1.total": "128.5" });
    textOf(m, true);
    expect(m.payload?.refs).toEqual({ "q1.total": "128.5" });
  });

  it("只遮钱：`label` / `matched` 键在遮罩下照旧渲染", () => {
    const m = assistant("{{q1.g0.label}} 一共 {{q1.matched}} 行", {
      "q1.g0.label": "买菜",
      "q1.matched": "12",
    });
    expect(textOf(m, true)).toBe("买菜 一共 12 行");
  });
});
