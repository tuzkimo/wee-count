// src/components/ai/markdown.ts
//
// **手写的极小 markdown 渲染器**（纯函数，零依赖）。只服务一件事：AI 回复里的 `**加粗**`、
// 列表这些标记，别再原样怼到用户脸上。
//
// ## 为什么是"VNode 描述"而不是 HTML 字符串
//
// 输出的是**数据结构**（块 → 行内节点），不是 HTML 字符串 —— 于是渲染层可以只建**文本节点**，
// 没有 `v-html`、没有 `innerHTML`、没有"先转义再替换"这条容易出错的链路可走：
// 模型输出里的 `<script>` 在数据模型里就是一个 `{ type: "text", value: "<script>" }`，
// Vue 建文本节点时**不可能**把它解释成元素。转义因此是**结构性**的，而不是某一行代码的自觉。
// （⚠️ 所以这里**刻意不做**实体转义：在解析器里 `&` → `&amp;` 会在渲染层被当普通字符再转义一次，
// 用户就会看见 `&amp;`。见 `__tests__/markdown.test.ts` 里钉住这条契约的用例。）
//
// ## 支持范围（宁少勿错）
//
//   段落 · 段内换行 · `**粗体**` · `*斜体*` · `` `行内代码` `` · 无序列表 · 有序列表
//
// **不支持**（一律当普通文本原样显示，绝不半吊子渲染）：标题、表格、链接、图片、引用、
// HTML 标签、代码块围栏、嵌套列表、lazy continuation。理由同上：渲染错的破坏力大于不渲染。
//
// ## "畸形标记不吞正文"是怎么保证的
//
// 行内扫描**只在"闭合定界符确实找到"时才消费字符**；找不到闭合就原样吐回缓冲区。
// 星号定界符按**连续长度**判定：长度 1 才是斜体、长度 2 才是粗体，长度 ≥3（`***`）一律字面量。
// 于是 `只有 ** 星号`、`3 * 4`、`未闭合的 \`code`、`***三个***` 全都逐字保留 —— 见测试里
// `plainText(...) === src` 那一组。

/** 行内节点：`text`/`code` 的 `value` 是**原文**（未转义），`strong`/`em` 可嵌套 */
export type InlineNode =
  | { type: "text"; value: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "code"; value: string };

/** 块级节点：段落（段内换行留在 text 里）或列表（每项是一串行内节点） */
export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] };

/** 无序列表记号：`-` / `*` / `+`，**后面必须跟至少一个空白**（所以 `**粗体**` 不是列表项） */
const UNORDERED_ITEM = /^[ \t]*[-*+][ \t]+(.*)$/;
/** 有序列表记号：`1.` 或 `1)`，同样要求后跟空白 */
const ORDERED_ITEM = /^[ \t]*(\d{1,9})[.)][ \t]+(.*)$/;

/** `at` 处连续 `ch` 的个数（`ch` 是 `*` 或 `` ` ``） */
function runAt(src: string, at: number, ch: string): number {
  let n = 0;
  while (at + n < src.length && src[at + n] === ch) n += 1;
  return n;
}

/**
 * 从 `from` 起找**恰好** `len` 个连续 `ch` 的起点，找不到返回 -1。
 *
 * "恰好"是必须的，否则会吃掉正文：
 *  - 星号：`***x***` 里没有合法的 `*`/`**` 定界符 ⇒ 整串当字面量
 *  - 反引号：` ``` ` 是**代码块围栏**（不支持）⇒ 不能按"1 个反引号开、1 个闭合"拆成 `code("`")`
 *
 * 扫到一段 `ch` 就整段跳过（`i += n`）⇒ 只有"段的起点"才是候选，段内部的字符不算定界符。
 */
function findExactRun(src: string, from: number, ch: string, len: number): number {
  let i = from;
  while (i < src.length) {
    if (src[i] === ch) {
      const n = runAt(src, i, ch);
      if (n === len) return i;
      i += n;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * 行内解析：一段（不含空行的）文本 → 行内节点序列。
 *
 * 不变式：**任何没被成对定界符消费掉的字符，都原序出现在某个 `text`/`code` 的 `value` 里**。
 */
export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buffer = "";

  const flush = (): void => {
    if (buffer !== "") {
      out.push({ type: "text", value: buffer });
      buffer = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === "*") {
      const run = runAt(src, i, "*");
      if (run === 1 || run === 2) {
        const close = findExactRun(src, i + run, "*", run);
        // `close > i + run` ⇒ 内容非空（`****` 之类不产生空节点，原样显示）
        if (close > i + run) {
          flush();
          const children = parseInline(src.slice(i + run, close));
          out.push(run === 2 ? { type: "strong", children } : { type: "em", children });
          i = close + run;
          continue;
        }
      }
      // 长度 ≥3 或找不到闭合：整段星号原样进缓冲区
      buffer += src.slice(i, i + run);
      i += run;
      continue;
    }

    if (ch === "`") {
      const run = runAt(src, i, "`");
      const close = findExactRun(src, i + run, "`", run);
      // 闭合段必须**同类同长**：` ``` ` 找不到另一段三个反引号 ⇒ 整段原样
      if (close > i + run) {
        flush();
        out.push({ type: "code", value: src.slice(i + run, close) });
        i = close + run;
        continue;
      }
      buffer += src.slice(i, i + run);
      i += run;
      continue;
    }

    buffer += ch;
    i += 1;
  }

  flush();
  return out;
}

/** 待收尾的列表：`ordered` 记类型（类型一变就换一个块），`items` 存**未解析**的原始行 */
type PendingList = { ordered: boolean; items: string[] };

/**
 * 块级解析：整篇文本 → 块序列。
 *
 * - 空行分段，也终结列表
 * - 连续的同类列表行并成一个列表；`-` 与 `1.` 交替出现就是两个块（不做嵌套、不做 lazy continuation）
 * - 段内的单个换行**留在文本里**（渲染层靠 `whitespace-pre-wrap` 折行），一个字不丢
 */
export function renderMarkdown(source: string): BlockNode[] {
  // 先归一换行：`\r` 会让 `(.*)$` 匹配不上，列表就认不出来了
  const normalized = source.replace(/\r\n?/g, "\n");

  const blocks: BlockNode[] = [];
  let paragraph: string[] = [];
  let openList: PendingList | null = null;

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  const closeList = (): void => {
    if (openList === null) return;
    blocks.push({
      type: "list",
      ordered: openList.ordered,
      items: openList.items.map((item) => parseInline(item)),
    });
    openList = null;
  };

  const addItem = (ordered: boolean, text: string): void => {
    if (openList !== null && openList.ordered !== ordered) closeList();
    const target: PendingList = openList ?? { ordered, items: [] };
    if (openList === null) openList = target;
    target.items.push(text);
  };

  for (const line of normalized.split("\n")) {
    const unordered = UNORDERED_ITEM.exec(line);
    if (unordered !== null) {
      closeParagraph();
      addItem(false, unordered[1]);
      continue;
    }

    const ordered = ORDERED_ITEM.exec(line);
    if (ordered !== null) {
      closeParagraph();
      addItem(true, ordered[2]);
      continue;
    }

    if (line.trim() === "") {
      closeParagraph();
      closeList();
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  closeParagraph();
  closeList();
  return blocks;
}
