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
 *
 * `image`（默认 `null`）：**待发送的截图，真相在 store**（E12.1）—— 组件只渲染它、只发事件。
 * 附件放进 store 而不是留在这里的局部 `ref`，是因为"选完图切页再回来"必须还在（见 store 上
 * `attachedImage` 的注释）：组件被重挂载时局部状态会连同 DOM 一起消失。
 */
const props = withDefaults(
  defineProps<{
    sending: boolean;
    enabled?: boolean;
    image?: ImageAttachment | null;
    /**
     * 待发附件要不要打码。**判定在页面**（`useAmountMask` + `revealed` 属于页面/消息，
     * 不属于输入栏）⇒ 这里只透传给 `AttachmentPreview`，不自己读 store。
     *
     * 页面目前**恒传 `false`**（实机反馈：「预览窗格的图片不用模糊的，历史对话的再模糊」）
     * —— 能力保留、语义不变，将来若要恢复"预览也遮"，改页面那一处即可。
     */
    imageMasked?: boolean;
  }>(),
  {
    enabled: true,
    image: null,
    imageMasked: false,
  },
);

const emit = defineEmits<{
  send: [text: string];
  cancel: [];
  /** 选图成功 ⇒ 页面把它交给 store（本组件不碰 store）。`✕` 那一侧见 `removeAttachment` */
  attach: [image: ImageAttachment];
  /** 用户撤掉**待发**附件（已落库的历史图不动，§7「不追溯删除」） */
  removeAttachment: [];
  /** 用户点待发附件的缩略图要看大图 ⇒ 页面打开查看器（与历史缩略图同一个） */
  preview: [];
}>();

const text = ref("");
const inset = useKeyboardInset();

/** 选图失败的 §8 文案（空串 = 没有错误）—— 失败**不抛**，页面只展示这句话 */
const imageError = ref("");

/**
 * 选图（§3 步骤 1–3）：**取消只清掉上一轮的失败文案**；失败只显示文案；成功发 `attach`。
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
  emit("attach", result.image);
}

function onSend(): void {
  const value = text.value.trim();
  // "没内容可发" = 没有文字**且**没有图（M4 起"只发一张图、一个字不写"是合法形态，§4.2）。
  // 老路径（没有图）逐字不变：空串/纯空白仍然什么都不发 —— 让模型回答空问题是浪费一次配额。
  if (value === "" && props.image === null) return;
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
    <AttachmentPreview
      v-if="props.image !== null"
      :image="props.image"
      :masked="props.imageMasked"
      class="mb-2"
      @remove="emit('removeAttachment')"
      @preview="emit('preview')"
    />
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
