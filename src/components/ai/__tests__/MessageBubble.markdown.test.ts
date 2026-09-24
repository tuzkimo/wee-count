// src/components/ai/__tests__/MessageBubble.markdown.test.ts
//
// 渲染器接进**气泡**这一层的行为：
//  - 走的还是 `maskMessageText()` 之后的那串**最终文本** ⇒ markdown 作用在回填+遮蔽之后（§4.5:483）
//  - 安全是**结构性的**：正文只以文本节点 / `h()` 的字符串子节点进 DOM，没有 `v-html`、没有 innerHTML
//  - 只对 **assistant** 气泡生效：用户自己打的 `**` 不该被解释成标记
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import { AMOUNT_PLACEHOLDER } from "@/composables/useAmountMask";
import type { UiMessage } from "@/stores/aiChat";

function assistant(content: string, refs: Record<string, string> = {}): UiMessage {
  return {
    id: "m-md-1",
    role: "assistant",
    content,
    payload: { chips: [], drafts: [], refs, trace: [] },
    createdAt: "2026-03-01T00:00:00.000Z",
  };
}

/** 挂载后取 `[data-test="message-bubble-text"]` 的 textContent（= 用户看得见的正文） */
function renderedText(content: string): string {
  return mount(MessageBubble, { props: { message: assistant(content) } })
    .get('[data-test="message-bubble-text"]')
    .text();
}

describe("AI 气泡的 markdown 渲染", () => {
  it("`**粗体**` / `*斜体*` / `` `行内代码` `` 各自渲染成对应元素，定界符不上屏", () => {
    const w = mount(MessageBubble, {
      props: { message: assistant("这是 **粗体**、*斜体* 与 `code`。") },
    });
    const body = w.get('[data-test="message-bubble-text"]');

    expect(body.text()).toBe("这是 粗体、斜体 与 code。");
    // 杀手：让渲染器只返回纯字符串（丢掉 strong/em/code 的包裹）⇒ 这三条红
    expect(body.get("strong").text()).toBe("粗体");
    expect(body.get("em").text()).toBe("斜体");
    expect(body.get("code").text()).toBe("code");
  });

  it("无序列表 / 有序列表渲染成 ul、ol + li", () => {
    const ul = mount(MessageBubble, { props: { message: assistant("- 买菜\n- 打车") } });
    const ulBody = ul.get('[data-test="message-bubble-text"]');
    expect(ulBody.find("ul").exists()).toBe(true);
    expect(ulBody.findAll("li").map((li) => li.text())).toEqual(["买菜", "打车"]);

    const ol = mount(MessageBubble, { props: { message: assistant("1. 第一步\n2. 第二步") } });
    const olBody = ol.get('[data-test="message-bubble-text"]');
    expect(olBody.find("ol").exists()).toBe(true);
    expect(olBody.findAll("li").map((li) => li.text())).toEqual(["第一步", "第二步"]);
  });

  it("空行分段、段内换行原样保留", () => {
    const w = mount(MessageBubble, {
      props: { message: assistant("第一段\n\n第二段第一行\n第二段第二行") },
    });
    const ps = w.get('[data-test="message-bubble-text"]').findAll("p");
    // 杀手：把段落拍平成一个文本节点（丢掉块级分段的换行处理）⇒ 这条红
    expect(ps.map((p) => p.text())).toEqual(["第一段", "第二段第一行\n第二段第二行"]);
  });

  it("模型输出里的 HTML 只当文本：不生成元素，序列化后是转义实体", () => {
    const src = '<script>alert("x")</script> & \'引号\' <img src=x onerror="boom">';
    const w = mount(MessageBubble, { props: { message: assistant(src) } });
    const body = w.get('[data-test="message-bubble-text"]');

    expect(body.text()).toBe(src); // 原文逐字上屏
    // 杀手：把 `inline()` 的字符串子节点换成 `{ innerHTML: value }` ⇒ 这两条 querySelector 先红
    expect(w.element.querySelector("script")).toBeNull();
    expect(w.element.querySelector("img")).toBeNull();
    expect(body.html()).toContain("&lt;script&gt;");
    expect(body.html()).not.toContain("<script");
  });

  it("畸形标记不吞正文：渲染不出来就逐字原样显示", () => {
    const BROKEN = [
      "只有一个 ** 星号",
      "混杂 * 和 ** 的标记",
      "未闭合的 `行内代码",
      "3 * 4 = 12，2 ** 3 = 8",
      "***三个星号***",
      "*先开后关**",
      "**先开后关*",
      "**",
      "`",
    ];
    for (const src of BROKEN) expect(renderedText(src)).toBe(src);
  });

  it("用户消息不是 AI 回复：`**粗体**` 原样显示，不生成标记元素", () => {
    const w = mount(MessageBubble, {
      props: { message: { ...assistant("**粗体**"), role: "user" } },
    });
    const body = w.get('[data-test="message-bubble-text"]');
    // 杀手：去掉 `isUser` 分支（改成所有角色都渲染 markdown）⇒ 这条红
    expect(body.text()).toBe("**粗体**");
    expect(body.find("strong").exists()).toBe(false);
  });

  it("不支持的语法原样显示，且不生成对应元素（标题/表格/链接/图片/引用/HTML/代码块）", () => {
    const src = [
      "# 标题",
      "> 引用",
      "| a | b |",
      "[链接](http://x)",
      "![图片](http://x)",
      "```",
      "code",
      "```",
      "<div>html</div>",
    ].join("\n\n");
    const w = mount(MessageBubble, { props: { message: assistant(src) } });
    const body = w.get('[data-test="message-bubble-text"]');

    for (const frag of ["# 标题", "> 引用", "| a | b |", "[链接](http://x)", "![图片](http://x)", "<div>html</div>"]) {
      expect(body.text()).toContain(frag);
    }
    for (const tag of ["a", "h1", "blockquote", "table", "pre", "img", "div"]) {
      expect(body.find(tag).exists()).toBe(false);
    }
  });
});

describe("markdown 与金额遮蔽共存（§7.4）", () => {
  it("markdown 作用在**回填 + 遮蔽之后**的最终文本上", () => {
    const w = mount(MessageBubble, {
      props: {
        message: assistant("**上月**买菜花了 {{q1.total}} 元，一共 {{q1.count}} 笔。", {
          "q1.total": "128.5",
          "q1.count": "3",
        }),
        masked: true,
      },
    });
    const body = w.get('[data-test="message-bubble-text"]');
    // 杀手：把渲染器接到 `props.message.content`（未回填的占位符原文）上 ⇒ 这条红
    expect(body.text()).toBe(`上月买菜花了 ${AMOUNT_PLACEHOLDER} 元，一共 3 笔。`);
    expect(body.get("strong").text()).toBe("上月");
    expect(w.text()).not.toContain("128");
  });

  it("遮罩占位符被 `**` 包住也不会被吃掉", () => {
    const w = mount(MessageBubble, {
      props: {
        message: assistant("**{{q1.total}}** 元", { "q1.total": "128.5" }),
        masked: true,
      },
    });
    const body = w.get('[data-test="message-bubble-text"]');
    // 杀手：先渲染 markdown、再对结果做字符串替换遮蔽 ⇒ 占位符已经不是 `{{q1.total}}`，替换失效
    expect(body.get("strong").text()).toBe(AMOUNT_PLACEHOLDER);
    expect(w.text()).not.toContain("128");
  });
});
