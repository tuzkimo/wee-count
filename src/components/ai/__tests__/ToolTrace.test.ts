import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ToolTrace from "@/components/ai/ToolTrace.vue";

const ID = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";

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

describe("ToolTrace", () => {
  it("默认收起：只给一条汇总（轮次数 + 失败数），不展开明细", () => {
    const w = mount(ToolTrace, {
      props: {
        trace: [
          { round: 1, name: "query_transactions", ok: true },
          { round: 2, name: "create_transaction_draft", ok: false, note: "缺分类" },
        ],
      },
    });
    expect(w.get('[data-test="tool-trace-summary"]').text()).toBe("查了 2 次，1 次没成功");
    expect(w.find('[data-test="tool-trace-list"]').exists()).toBe(false);
  });

  it("展开后按轮次逐条列出：工具名 + 成败 + 失败原因", async () => {
    const w = mount(ToolTrace, {
      props: {
        trace: [
          { round: 1, name: "query_transactions", ok: true },
          { round: 2, name: "create_transaction_draft", ok: false, note: "缺分类" },
        ],
      },
    });
    await w.get('[data-test="tool-trace-toggle"]').trigger("click");

    const entries = w.findAll('[data-test="tool-trace-entry"]');
    expect(entries).toHaveLength(2);
    expect(entries[0]!.get('[data-test="tool-trace-round"]').text()).toBe("1");
    expect(entries[0]!.get('[data-test="tool-trace-name"]').text()).toBe("query_transactions");
    expect(entries[0]!.get('[data-test="tool-trace-status"]').text()).toBe("成功");
    expect(entries[1]!.get('[data-test="tool-trace-status"]').text()).toBe("失败");
    expect(entries[1]!.get('[data-test="tool-trace-note"]').text()).toBe("缺分类");
  });

  it("全部成功时汇总不提失败", () => {
    const w = mount(ToolTrace, { props: { trace: [{ round: 1, name: "query_transactions", ok: true }] } });
    expect(w.get('[data-test="tool-trace-summary"]').text()).toBe("查了 1 次");
  });

  it("**不泄漏 id 与原始参数**：条目上多带的 args / params / ledgerId 都不进 DOM 任何位置", async () => {
    const w = mount(ToolTrace, {
      props: {
        trace: [
          {
            round: 1,
            name: "query_transactions",
            ok: false,
            // 真实可达的形态：dump 工具调用时把整个 call 塞进 trace（§7.3 绝不上行、更不该上屏）
            args: { categories: [ID], ledgerId: ID },
            params: { members: [ID] },
            id: ID,
            ledgerId: ID,
          },
        ],
      },
    });
    await w.get('[data-test="tool-trace-toggle"]').trigger("click");

    const seen = collectStrings(w.element);
    // 探针：walker 看得见文本与属性（否则这条守卫是空的）
    expect(seen).toContain("query_transactions");
    expect(seen).toContain("tool-trace-entry");
    // 工具名与成败是**聚合**信息，可以出现；原始参数与 id 不行。
    // ⚠️ 本组件**不负责**过滤 note（`note` 由 `agent.ts` 取首行写入，它自己就是给人看的原因文本）；
    // 这里钉的是"条目上**其他**字段一个都不许漏出去"。
    expect(seen.some((s) => s.includes(ID)), `trace 条目上的额外字段漏进了 DOM：${seen.join(" | ")}`).toBe(false);
  });

  it("形状坏的条目被跳过，好的仍渲染", async () => {
    const w = mount(ToolTrace, {
      props: {
        trace: [null, "x", 42, { round: "1", name: "query_transactions", ok: true }, { round: 2, name: "create_transaction_draft", ok: true }],
      },
    });
    expect(w.get('[data-test="tool-trace-summary"]').text()).toBe("查了 1 次");
    await w.get('[data-test="tool-trace-toggle"]').trigger("click");
    expect(w.findAll('[data-test="tool-trace-entry"]')).toHaveLength(1);
  });

  it("空 trace 整块不出现", () => {
    const w = mount(ToolTrace, { props: { trace: [] } });
    expect(w.find('[data-test="tool-trace"]').exists()).toBe(false);
  });
});
