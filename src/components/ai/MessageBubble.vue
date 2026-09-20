<script setup lang="ts">
// 一条消息气泡（规格 §4.5 / §7.2）。
//
// 本组件只做两件事，各有**一条能红的守卫**：
//  1. **回填**：库里存的 `content` 永远是**占位符原文**（`{{q1.total}}`），真值在 `payload.refs`
//     里 —— 回填**只发生在渲染这一刻**，所以 `props.message.content` 一个字都不许改
//     （改了就等于把真值写回一份"看起来像原文"的东西）。见 `fillRefs`。
//  2. **绝不渲染 id**：payload 里的 `applied` / `ledgerId` / `chips[].id` 都是拿去跳转或记账的
//     **本地**数据（§7.3）。这里是**白名单**渲染：模板只碰 `fillRefs` 的产物，一个字段名都不展开。
//
// ⚠️ 金额遮罩（§7.4 乙方案）由**调用方**按消息判定后传进来（`masked` prop）：
// 判定要用 `revealed`（store 的内存 Set）与全局 `amountsHidden`，两者都不属于"一条气泡"。
// 反过来在组件里读 store 会让本组件的测试必须挂 pinia —— 而那些测试钉的是回填与"绝不渲染 id"，
// 与遮蔽无关（新增的遮罩测试单独一份 `MessageBubble.mask.test.ts`）。
import { computed } from "vue";
import { maskMessageText } from "@/components/ai/amountMask";
import type { UiMessage } from "@/stores/aiChat";

const props = defineProps<{ message: UiMessage; masked?: boolean }>();

/**
 * 回填后的展示文本。键查不到时 `fillRefs` 保留原文并 warn（宁可暴露占位符，也不塞错数字）。
 * 遮蔽是**回填的后一步**（`§4.5:483`）：金额键的值在回填前换成 `••••`，替换实现仍然只有一份。
 */
const text = computed(() =>
  maskMessageText(props.message.content, props.message.payload?.refs ?? {}, props.masked === true),
);

const isUser = computed(() => props.message.role === "user");
</script>

<template>
  <div class="flex" :class="isUser ? 'justify-end' : 'justify-start'" data-test="message-bubble">
    <div
      class="max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap"
      :class="isUser ? 'bg-primary text-white' : 'bg-surface text-text'"
      :aria-live="isUser ? undefined : 'polite'"
      data-test="message-bubble-text"
    >
      {{ text }}
    </div>
  </div>
</template>
