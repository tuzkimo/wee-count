<script lang="ts">
// src/components/ai/MarkdownText.vue
//
// 把 `markdown.ts` 的**纯数据**渲染成 VNode。这里只做一件事：**建文本节点**。
//
// 为什么用 render 函数而不是模板：
//  1. `strong`/`em` 的 children 是行内节点，可以任意嵌套 ⇒ 模板得靠"自引用组件"绕一圈，
//     render 函数里就是一个递归调用。
//  2. **安全性看得见**：`h("strong", props, children)` 里的 children 若是字符串，Vue 建的是
//     **文本节点**（`createTextNode`），不会走 `innerHTML`。整个文件里没有 `v-html`、
//     没有 `innerHTML`、没有 `dangerouslySetInnerHTML` 的等价物 —— 模型输出里的 `<script>`
//     在 DOM 里就是一个 `<` 字符。
import { defineComponent, h, type PropType, type VNodeChild } from "vue";
import type { BlockNode, InlineNode } from "@/components/ai/markdown";

const CODE_CLASS = "rounded bg-black/10 px-1 py-0.5 font-mono text-[0.9em]";
const BLOCK_CLASS = "my-1 first:mt-0 last:mb-0";

function renderInline(nodes: InlineNode[]): VNodeChild[] {
  return nodes.map((node): VNodeChild => {
    if (node.type === "text") return node.value; // 裸字符串 ⇒ 文本节点（值就是原文）
    if (node.type === "code") return h("code", { class: CODE_CLASS }, node.value);
    if (node.type === "strong") {
      return h("strong", { class: "font-semibold" }, renderInline(node.children));
    }
    return h("em", { class: "italic" }, renderInline(node.children));
  });
}

export default defineComponent({
  name: "MarkdownText",
  props: {
    blocks: { type: Array as PropType<BlockNode[]>, required: true },
  },
  setup(props) {
    return (): VNodeChild[] =>
      props.blocks.map((block, i): VNodeChild => {
        if (block.type === "paragraph") {
          return h("p", { key: `p${i}`, class: BLOCK_CLASS }, renderInline(block.children));
        }
        return h(
          block.ordered ? "ol" : "ul",
          {
            key: `l${i}`,
            class: `${BLOCK_CLASS} pl-5 ${block.ordered ? "list-decimal" : "list-disc"}`,
          },
          block.items.map((item, j) => h("li", { key: j }, renderInline(item))),
        );
      });
  },
});
</script>
