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
// ⚠️ 本组件**不做金额遮罩**：§7.4 的乙方案（`revealed` 内存 Set + `useAmountMask`）整体属于任务 7，
// 这一层没有开关可读，也没有 id 可判 —— 现在去"顺手"遮蔽会让任务 7 多一条必须拆掉的分支。
import { computed } from "vue";
import { fillRefs } from "@/services/ai/prompt";
import type { UiMessage } from "@/stores/aiChat";

const props = defineProps<{ message: UiMessage }>();

/** 回填后的展示文本。键查不到时 `fillRefs` 保留原文并 warn（宁可暴露占位符，也不塞错数字）。 */
const text = computed(() => fillRefs(props.message.content, props.message.payload?.refs ?? {}));

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
