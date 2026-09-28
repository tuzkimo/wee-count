<script setup lang="ts">
// 待发送截图的预览条（规格 §3 步骤 3 / §7）：缩略图 + **必须看见的隐私提示** + 撤掉。
//
// 为什么提示做在**附件条上**、而不是只放隐私卡：截图里可能有余额、别的账本、备注全文，
// 主规格 §7.3 那张"绝不发的"清单在截图场景下**只能靠"用户看得见"兜底**（规格 §7）⇒
// 提示必须与缩略图同屏：用户点发送之前一定读到它。
//
// 本组件**无状态、零 IO**：只渲染传进来的 `image`、只发 `remove` / `preview`。图片是本地数据，
// 这里一次库都不碰（撤掉只是把附件从输入区拿掉，**不动**已落库的历史图，§7）。
//
// 缩略图是**可点的**（`preview`）：点它看大图，与历史消息里的缩略图同一个查看器。
// 谁打开查看器、要不要打码都由页面决定 —— 这里只发事件（`masked` 由调用方按
// `useAmountMask` 的语义算好传进来：附件没有 messageId ⇒ 不存在"本轮问出来"的 `revealed`）。
import type { ImageAttachment } from "@/services/ai/imageInput";

withDefaults(defineProps<{ image: ImageAttachment; masked?: boolean }>(), { masked: false });

const emit = defineEmits<{ remove: []; preview: [] }>();
</script>

<template>
  <div class="flex items-start gap-2 rounded-lg border border-gray-200 bg-surface p-2" data-test="attachment-preview">
    <!--
      缩略图外那层框：**描边必须落在这里**，不能画在 `<img>` 上 —— `<img>` 上的 `blur-lg`
      是 `filter: blur()`，会把同一元素的边框一起糊掉；`overflow-hidden` 顺便把外溢的模糊夹住
      （外溢正是"小图与背景糊成一片"的来源）。清晰时也留着：小图与浅色背景之间同样要有边界。
    -->
    <div
      class="h-16 w-16 shrink-0 overflow-hidden rounded ring-1 ring-gray-300"
      data-test="attachment-thumb-frame"
    >
      <img
        data-test="attachment-thumb"
        :src="image.dataUrl"
        alt="待发送的截图"
        class="h-full w-full cursor-pointer object-cover"
        :class="masked ? 'blur-lg' : ''"
        @click="emit('preview')"
      />
    </div>
    <p class="min-w-0 flex-1 text-xs text-text-secondary" data-test="attachment-notice">截图会整张发给模型，可能含余额等其他信息</p>
    <button
      type="button"
      class="shrink-0 rounded p-1 text-text-secondary"
      aria-label="撤掉这张截图"
      data-test="attachment-remove"
      @click="emit('remove')"
    >
      ✕
    </button>
  </div>
</template>
