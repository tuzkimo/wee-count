import { describe, it, expect, vi, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import type { UiMessage } from "@/stores/aiChat";

// 真 UUID：id 断言必须拿真形状的串去查，用一个 "id-1" 之类的假串会让断言恒真（Ruling 13）
const UUID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const UUID2 = "11111111-2222-4333-8444-555555555555";

/**
 * 遍历整棵渲染树的**文本与属性值**，收集所有"见过"的字符串。
 *
 * 为什么不能只查 `wrapper.text()`：漏 id 的形态不止"文本里多一行"——
 * `data-ledger-id="…"` 这种**属性**上的泄漏同样是泄漏，而 `.text()` 看不见它（任务 3 的 5 种泄漏形态之一）。
 * 这个 walker 是"不渲染任何 id"这条守卫的**判别工具**，它自己也被下面一条用例钉住（探针）。
 */
function collectStrings(root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element): void => {
    for (const attr of Array.from(el.attributes)) out.push(attr.value);
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) out.push(node.textContent ?? "");
      else if (node.nodeType === 1) walk(node as Element);
    }
  };
  walk(root);
  return out;
}

function makeMessage(over: Partial<UiMessage> = {}): UiMessage {
  return {
    id: UUID,
    role: "assistant",
    content: "上个月买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。",
    payload: { refs: { "q1.total": "128.5", "q1.count": "3" } },
    createdAt: "2026-09-18T10:00:00.000Z",
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MessageBubble", () => {
  it("用 payload.refs 把占位符回填成真值（回填只发生在渲染）", () => {
    const message = makeMessage();
    const w = mount(MessageBubble, { props: { message } });

    expect(w.get('[data-test="message-bubble-text"]').text()).toBe(
      "上个月买菜花了 128.5 元，一共 3 笔。",
    );
    // 反面对照：库里那条消息的 content 一个字符都没被改（占位符原文是落库口径，§4.5）
    expect(message.content).toBe("上个月买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。");
    expect(message.payload?.refs).toEqual({ "q1.total": "128.5", "q1.count": "3" });
  });

  it("refs 缺失的键保留原文并 warn（宁可暴露占位符，也不塞错数字）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = mount(MessageBubble, {
      props: { message: makeMessage({ content: "共 {{q9.count}} 笔", payload: { refs: {} } }) },
    });

    expect(w.get('[data-test="message-bubble-text"]').text()).toBe("共 {{q9.count}} 笔");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("值 0 也会被回填（0 是有效值，不是「没给」）", () => {
    const w = mount(MessageBubble, {
      props: { message: makeMessage({ content: "共 {{q1.count}} 笔", payload: { refs: { "q1.count": "0" } } }) },
    });
    expect(w.get('[data-test="message-bubble-text"]').text()).toBe("共 0 笔");
  });

  it("没有 payload 时按原文渲染，不抛", () => {
    const w = mount(MessageBubble, {
      props: { message: makeMessage({ content: "这次没能查。", payload: null }) },
    });
    expect(w.get('[data-test="message-bubble-text"]').text()).toBe("这次没能查。");
  });

  it("用户消息靠右、assistant 靠左", () => {
    const user = mount(MessageBubble, { props: { message: makeMessage({ role: "user" }) } });
    const assistant = mount(MessageBubble, { props: { message: makeMessage({ role: "assistant" }) } });
    expect(user.get('[data-test="message-bubble"]').classes()).toContain("justify-end");
    expect(assistant.get('[data-test="message-bubble"]').classes()).toContain("justify-start");
  });

  it("**绝不渲染 id**：payload 里带真 id 的 chip / applied / ledgerId 都不出现在 DOM 的任何位置", () => {
    // payload 在库里是 **JSON 文本**（`AiMessagePayload` 只是它的声明形状）。这里刻意塞进
    // 类型上没有、运行期可能的键（`ledgerId` / `applied` / trace 条目上的 `args`）——
    // 它们正是"有人在 payload 里多放一份本地数据"的真实形态，而 `parsePayload` 只做
    // `isRecord` 判断、原样转成 `AiMessagePayload`，所以这条数据**真的能到达组件**。
    // 用 `as` 是这份"越界数据"的必要表达；实现侧的白名单不需要任何 as（它根本不读这些键）。
    const payload = {
      refs: { "q1.total": "128.5" },
      chips: [
        {
          // 真值与形状都照 tools.ts 的 applied：chip 里带着真 id，它是**本地**数据
          dateFrom: "2026-08-01",
          dateTo: "2026-08-31",
          type: "expense",
          categories: [{ id: UUID, name: "买菜" }],
          account: { id: UUID2, name: "招行" },
          tags: [],
          members: [],
          merchant: null,
          amountMin: null,
          amountMax: null,
        },
      ],
      drafts: [{ draftId: UUID, draft: {}, resolved: { categoryId: UUID2 } }],
      ledgerId: UUID,
      trace: [{ round: 1, name: "query_transactions", ok: true, args: { ledgerId: UUID } }],
      applied: { ledgerId: UUID2 },
    } as unknown as UiMessage["payload"];

    // 注入真 UUID（Ruling 13：fixture 里放真 UUID，否则 id 断言恒真）
    const w = mount(MessageBubble, {
      props: {
        message: makeMessage({
          id: UUID2,
          content: "上月买菜花了 {{q1.total}} 元",
          payload,
        }),
      },
    });

    const seen = collectStrings(w.element);
    // 探针：walker 真的看得见"文本 + 属性"两类位置（否则这条守卫是空的）
    expect(seen).toContain("上月买菜花了 128.5 元");
    expect(seen).toContain("message-bubble-text");
    // 两个真 UUID 一个都不许出现
    for (const s of seen) {
      expect(s).not.toContain(UUID);
      expect(s).not.toContain(UUID2);
    }
  });
});
