<script setup lang="ts">
// 输入栏（规格 §5.2 / §5.3）：输入 + 发送 + **生成中可取消**。
//
// 本组件**不碰 store、不发请求**：`send` 与 `cancel` 都是事件，由页面转给 `aiChat`。
// 于是「空串不发」这条规则只在一处 —— 这里（store 里也有一道 `trim() === ""` 守卫，
// 但那是纵深防御：输入栏是唯一能产生空串的地方，两条都留着，各自的测试分开钉）。
//
// ⚠️ `sending` 时输入框**禁用**：§5.2 说"生成中又发一条"会掐掉在途那一轮，
// 那是给键盘快捷键/外部调用留的语义，不该让用户在一个正在生成的输入框里"以为能发第二条"。
// 想发新的先点取消（取消按钮在同一个位置，不需要移动手指）。
import { ref } from "vue";
import { Send, Square } from "lucide-vue-next";
import { useKeyboardInset } from "@/composables/useKeyboardInset";

const props = defineProps<{ sending: boolean }>();

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
}>();

const text = ref("");
const inset = useKeyboardInset();

function onSend(): void {
  if (props.sending) return;
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
