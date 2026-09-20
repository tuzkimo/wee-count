<script setup lang="ts">
// 输入栏（规格 §5.2 / §5.3）：输入 + 发送 + **生成中可取消**。
//
// 本组件**不碰 store、不发请求**：`send` 与 `cancel` 都是事件，由页面转给 `aiChat`。
// 于是「空串不发」这条规则只在一处 —— 这里（store 里也有一道 `trim() === ""` 守卫，
// 但那是纵深防御：输入栏是唯一能产生空串的地方，两条都留着，各自的测试分开钉）。
//
// ⚠️ `sending` 时**两个入口各有各的防线，而且都不是脚本守卫**（复审把"唯一防线"按下述入口拆开了）：
//  1. **回车**：`@keydown.enter` 挂在那个 `:disabled="sending"` 的 `<input>` 上 ——
//     禁用元素在浏览器的**事件派发层**就不派发（happy-dom 同样；探针实测 `sending=true` 时
//     先 `setValue` 再 `trigger("keydown.enter")`，`emitted("send")` 仍是 `undefined`）⇒ 到不了 `onSend`。
//  2. **发送按钮**：`v-if="sending"` ⇒ sending 时它**根本不渲染**（换成了取消按钮）。
//     它**没有** `:disabled="sending"` —— 那在 `v-else` 分支里**恒为假**（渲染时 `sending` 必为 false），
//     是一条死的等价防御，按 Ruling 35 删掉（复审 m22 实测：留着它删掉它都全绿）。
//     但 `:disabled="!enabled"`（§7.3 意愿层）在这个分支里**是活的** —— 它是另一件事，不冲突。
// ⇒ 脚本里的 `if (sending) return` 也是同类走不到的防御（复审 m8 实测全绿），已删。
// 没有第三条用户可达入口：无 `<form>` / 无 `@submit` / script setup 无 `expose`
// （`vm.onSend()` 只有 dev/test 的代理能直调，不是生产入口）。
import { ref } from "vue";
import { Send, Square } from "lucide-vue-next";
import { useKeyboardInset } from "@/composables/useKeyboardInset";

/**
 * `enabled`（默认 `true`）：§7.3 的意愿层开关关着时**输入框与发送键都禁用**。
 *
 * 为什么不像 `sending` 那样只靠"入口不存在"：那个开关是**用户可见的状态**（"我的 → 隐私"里
 * 明明关着），输入框却还能打字、还能点发送 —— 那不是防御问题，是界面在说谎。
 * store 里 `send` 另有一道 `if (!sendingEnabled) return`：这里是"不让做"，那里是"做了也不发"。
 */
withDefaults(defineProps<{ sending: boolean; enabled?: boolean }>(), { enabled: true });

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
        :disabled="sending || !enabled"
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
        :disabled="!enabled"
        data-test="composer-send"
        @click="onSend"
      >
        <Send :size="16" />发送
      </button>
    </div>
  </div>
</template>
