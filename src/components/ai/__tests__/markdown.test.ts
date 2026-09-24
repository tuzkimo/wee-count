// src/components/ai/__tests__/markdown.test.ts
//
// 手写极小 markdown 渲染器的**纯函数**契约（无 Vue、无依赖）。
//
// 两条贯穿全程的硬线：
//  1. **绝不把模型输出当 HTML**：数据模型里 text 节点的 `value` 就是原文（**不做实体转义**）——
//     转义是渲染层的事（Vue 的文本节点天生不含 HTML 语义，见 `MessageBubble.markdown.test.ts`）。
//     所以这里刻意钉住"原文进、原文出"：谁要是往解析器里塞 `escapeHtml()`，这份用例立刻红
//     （而在渲染层再转义一次就是双重转义，用户会看见 `&lt;`）。
//  2. **畸形标记不吞正文**：渲染不出来就原样显示，且原文一个字都不能少。
import { describe, it, expect } from "vitest";
import { parseInline, renderMarkdown } from "@/components/ai/markdown";
import type { BlockNode, InlineNode } from "@/components/ai/markdown";

/**
 * 把渲染结果摊平成纯文本 —— 这是"原文一个字都不能少"的**判别工具**，不是实现的一部分。
 * 只用它做整串比对（列表项之间不插分隔符，所以整串比对只对段落/列表项内部有意义）。
 */
function plainText(blocks: BlockNode[]): string {
  const inline = (nodes: InlineNode[]): string =>
    nodes
      .map((n) => (n.type === "text" || n.type === "code" ? n.value : inline(n.children)))
      .join("");
  return blocks
    .map((b) => (b.type === "paragraph" ? inline(b.children) : b.items.map(inline).join("")))
    .join("");
}

describe("renderMarkdown：块级结构", () => {
  it("空串渲染成零个块（不是空段落）", () => {
    expect(renderMarkdown("")).toEqual([]);
  });

  it("单行文本渲染成一个段落，内容逐字相同", () => {
    expect(renderMarkdown("上个月买菜花了 128.5 元。")).toEqual([
      { type: "paragraph", children: [{ type: "text", value: "上个月买菜花了 128.5 元。" }] },
    ]);
  });

  it("空行分段；段内单个换行原样留在文本里", () => {
    const blocks = renderMarkdown("第一段\n\n第二段第一行\n第二段第二行");
    expect(blocks).toHaveLength(2);
    expect(plainText([blocks[0]])).toBe("第一段");
    expect(plainText([blocks[1]])).toBe("第二段第一行\n第二段第二行");
  });

  it("无序列表：`-` / `*` / `+` 都认，连续行并成一个列表，记号与空格不进正文", () => {
    expect(renderMarkdown("- 买菜\n* 打车\n+ 停车")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", value: "买菜" }],
          [{ type: "text", value: "打车" }],
          [{ type: "text", value: "停车" }],
        ],
      },
    ]);
  });

  it("有序列表：`1.` 与 `2)` 都认，编号本身不进正文", () => {
    expect(renderMarkdown("1. 第一步\n2) 第二步")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          [{ type: "text", value: "第一步" }],
          [{ type: "text", value: "第二步" }],
        ],
      },
    ]);
  });

  it("列表项的正文照常走行内解析（列表里的粗体也是粗体）", () => {
    expect(renderMarkdown("- **买菜** 花了 128")).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [
            { type: "strong", children: [{ type: "text", value: "买菜" }] },
            { type: "text", value: " 花了 128" },
          ],
        ],
      },
    ]);
  });

  it("`**粗体**` 那一行不是列表项（列表记号后面必须跟至少一个空白）", () => {
    expect(renderMarkdown("**全部**")).toEqual([
      { type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value: "全部" }] }] },
    ]);
  });

  it("CRLF 也能认出列表（先归一换行再分行）", () => {
    // 杀手：删掉 `source.replace(/\r\n?/g, "\n")` ⇒ `- 买菜\r` 认不出列表，这条红
    const blocks = renderMarkdown("- 买菜\r\n- 打车");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "list",
      ordered: false,
      items: [[{ type: "text", value: "买菜" }], [{ type: "text", value: "打车" }]],
    });
  });
});

describe("parseInline：行内标记", () => {
  it("`**粗体**`", () => {
    expect(parseInline("**粗体**")).toEqual([
      { type: "strong", children: [{ type: "text", value: "粗体" }] },
    ]);
  });

  it("`*斜体*`", () => {
    expect(parseInline("*斜体*")).toEqual([{ type: "em", children: [{ type: "text", value: "斜体" }] }]);
  });

  it("`` `行内代码` ``：内容不做任何行内解析", () => {
    expect(parseInline("`a **b** <c>`")).toEqual([{ type: "code", value: "a **b** <c>" }]);
  });

  it("三种混排：定界符被吃掉，正文与前后普通文本一字不差", () => {
    expect(parseInline("这是 **粗体**、*斜体* 与 `code`。")).toEqual([
      { type: "text", value: "这是 " },
      { type: "strong", children: [{ type: "text", value: "粗体" }] },
      { type: "text", value: "、" },
      { type: "em", children: [{ type: "text", value: "斜体" }] },
      { type: "text", value: " 与 " },
      { type: "code", value: "code" },
      { type: "text", value: "。" },
    ]);
  });

  it("粗体里嵌斜体", () => {
    expect(parseInline("**粗 *斜* 体**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "粗 " },
          { type: "em", children: [{ type: "text", value: "斜" }] },
          { type: "text", value: " 体" },
        ],
      },
    ]);
  });

  it("外层成对就照常加粗：里层没成对的星号原样留在粗体里", () => {
    // 不算"吞正文"：外层那一对确实成对，被吃掉的只是**定界符**；里层的孤儿 `*` 一个没少
    expect(plainText([{ type: "paragraph", children: parseInline("**加粗 *没关的斜体**") }])).toBe(
      "加粗 *没关的斜体",
    );
  });
});

describe("畸形标记：渲染不出来就原样显示，原文一个字都不能少", () => {
  // 每一条都逐字比对整串。杀手：任何"找不到闭合就把剩下的内容丢掉"的写法
  // （例如 `**` 未闭合时 `i = src.length` 或提前 `return`）都会让其中若干条红。
  const BROKEN = [
    "只有一个 ** 星号",
    "混杂 * 和 ** 的标记",
    "未闭合的 `行内代码",
    "3 * 4 = 12，2 ** 3 = 8",
    "***三个星号***",
    "*先开后关**",
    "**先开后关*",
    "**",
    "*",
    "`",
    "``",
    "**粗",
    "结尾一个反斜杠 \\",
  ];

  for (const src of BROKEN) {
    it(`原样保留：${src}`, () => {
      expect(plainText(renderMarkdown(src))).toBe(src);
    });
  }
});

describe("不支持的语法一律当普通文本（宁少勿错）", () => {
  it("标题 / 引用 / 表格 / 链接 / 图片 / 代码块围栏 / HTML 标签都不认，一个字不丢", () => {
    const lines = [
      "# 标题",
      "> 引用",
      "| a | b |",
      "[链接](http://x)",
      "![图片](http://x)",
      "```",
      "code",
      "```",
      "<div>html</div>",
    ];
    const src = lines.join("\n\n");
    // 每个不支持的行各自成为一个段落，段与段之间不插字符 ⇒ 摊平后等于"原文去掉空行分隔"
    expect(plainText(renderMarkdown(src))).toBe(src.replace(/\n\n/g, ""));
  });
});

describe("HTML 只当文本数据（安全靠渲染层，不靠这里转义）", () => {
  it("含 <script> / & / 引号的输入，文本节点的值就是原文（未被实体转义）", () => {
    // 杀手：在解析器里加 `escapeHtml()`（"先转义再处理标记"若落在这一层就会双重转义）⇒ 这条红
    const src = '<script>alert("x")</script> & \'引号\'';
    expect(renderMarkdown(src)).toEqual([{ type: "paragraph", children: [{ type: "text", value: src }] }]);
    expect(parseInline("`<b>`")).toEqual([{ type: "code", value: "<b>" }]);
  });
});
