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
//
// ⚠️ **选图按钮（M4 §7）用的是同一个 `enabled`**：`:disabled="!enabled"`，与发送按钮那一行**逐字同源**。
// 规格 §7 要的是"关闭时选图与发送**一并**不可用"⇒ 必须是**同一道闸**，不许新造第二条判据。
// `sending` 期间它**不禁用**：发送按钮在 `sending` 时是"不渲染"而非"禁用"（见上），
// 所以两枚按钮唯一共有的禁用来源就是 `enabled`；选图期间不禁用也不越权 ——
// 图片是本地选、本地压，发送仍要用户再点一次（§7 的意愿层闸门在 `enabled` 上）。
import { ref } from "vue";
import { ImagePlus, Send, Square } from "lucide-vue-next";
import AttachmentPreview from "@/components/ai/AttachmentPreview.vue";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import { type ImageAttachment, pickImage } from "@/services/ai/imageInput";

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
  attach: [image: ImageAttachment];
}>();

const text = ref("");
const inset = useKeyboardInset();

/** 已选中的截图（本地状态：发送前只活在这里，落库是任务 4 的 store 的事） */
const attached = ref<ImageAttachment | null>(null);
/** 选图失败的 §8 文案（空串 = 没有错误）—— 失败**不抛**，页面只展示这句话 */
const imageError = ref("");

/**
 * 选图（§3 步骤 1–3）：**取消只清掉上一轮的失败文案**；失败只显示文案；成功进预览并发 `attach`。
 * `pickImage()` 无参 ⇒ 走**生产默认依赖**（真插件 + 真 canvas），本组件不注入任何东西。
 */
async function onPickImage(): Promise<void> {
  const result = await pickImage();
  if (result === null) {
    // 取消 = 用户放弃了这次挑选 ⇒ 上一轮的"这张图片打不开"不该继续挂在输入区上方误导人
    imageError.value = "";
    return;
  }
  if (!result.ok) {
    imageError.value = result.message;
    return;
  }
  imageError.value = "";
  attached.value = result.image;
  emit("attach", result.image);
}

/** 撤掉附件：只影响**待发**内容（已落库的历史图不动，§7「不追溯删除」） */
function onRemoveImage(): void {
  attached.value = null;
}

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
    <p v-if="imageError" class="mb-2 text-xs text-red-500" data-test="composer-image-error">{{ imageError }}</p>
    <AttachmentPreview v-if="attached" :image="attached" class="mb-2" @remove="onRemoveImage" />
    <div class="flex items-end gap-2">
      <button
        type="button"
        class="flex items-center rounded-lg border border-gray-200 px-2 py-2 text-text-secondary disabled:opacity-50"
        :disabled="!enabled"
        aria-label="选择截图"
        title="选一张截图记账"
        data-test="composer-pick-image"
        @click="onPickImage"
      >
        <ImagePlus :size="16" />
      </button>
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
