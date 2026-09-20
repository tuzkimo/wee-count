<script setup lang="ts">
// 输入栏（规格 §5.2 / §5.3）：输入 + 发送 + **生成中可取消**。
//
// 本组件**不碰 store、不发请求**：`send` 与 `cancel` 都是事件，由页面转给 `aiChat`。
// 于是「空串不发」这条规则只在一处 —— 这里（store 里也有一道 `trim() === ""` 守卫，
// 但那是纵深防御：输入栏是唯一能产生空串的地方，两条都留着，各自的测试分开钉）。
//
// ⚠️ `sending` 时输入框**禁用**，且**唯一的防线就是模板的 `:disabled`**（Ruling 35）：
// §5.2 说"生成中又发一条"会掐掉在途那一轮，那是给外部调用留的语义；而这个组件里 `onSend` 的两个
// 入口（发送按钮、输入框的回车）在 `sending` 时分别是"不渲染"与"`disabled`"—— 禁用/不存在的元素
// 在浏览器的**事件派发层**就不会触发处理器（happy-dom 同样如此）。脚本里再来一个
// `if (sending) return` 是**走不到的等价防御**（变异实测它删掉后 6/6 全绿）⇒ 已删。
// 「双击/重复点击只发一条」由 `:disabled` 承担，并有一条用例真打事件层钉它。
import { ref } from "vue";
import { Send, Square } from "lucide-vue-next";
import { useKeyboardInset } from "@/composables/useKeyboardInset";

defineProps<{ sending: boolean }>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const text = ref("");
const inset = useKeyboardInset();

function onSend(): void {
  const value = text.value.trim();
  // 空串（含"只有空白"）不发：让模型回答一个空问题是纯浪费一次配额
  if (value === "") return;
  text.value = "";
  emit("send", value);
}

/** 取消：**不清空**已输入的文字（用户可能只是想停下来改一改再发） */
function onCancel(): void {
  emit("cancel");
}
</script>

<template>
  <div
    class="border-t border-gray-100 bg-surface px-3 py-2"
    :style="{ paddingBottom: `${8 + inset}px` }"
    data-test="chat-composer"
  >
    <div class="flex items-end gap-2">
      <input
        v-model="text"
        type="text"
        class="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-text disabled:opacity-50"
        :disabled="sending"
        placeholder="问点什么，比如「上月买菜花了多少」"
        data-test="composer-input"
        @keydown.enter.prevent="onSend"
      />
      <button
        v-if="sending"
        type="button"
        class="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-text-secondary"
        data-test="composer-cancel"
        @click="onCancel"
      >
        <Square :size="16" />取消
      </button>
      <button
        v-else
        type="button"
        class="flex items-center gap-1 rounded-lg bg-primary px-3 py-2 text-sm text-white disabled:opacity-50"
        :disabled="sending"
        data-test="composer-send"
        @click="onSend"
      >
        <Send :size="16" />发送
      </button>
    </div>
  </div>
</template>
