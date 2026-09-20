<script setup lang="ts">
// 一次性隐私说明卡（规格 §7.3:472-480）。
//
// ⚠️ **`host === null` ⇒ 整个组件不渲染**（§7.3:476 明写：「拿不到 `host` 时不得展示这张卡片、
// 也不得允许开启开关——不知道数据发往哪里就不该让用户同意」）。这是 M2→M3 的硬约束，
// 不是"显示成灰色"：卡片里必须写出数据发往哪个服务器，写不出就不要问用户同不同意。
//
// 卡片的三件事：① 说清发什么到哪个 `host`；② 说清 20 条明细上限；③ 说清**会话历史是明文落盘**
// （§7.3:480 明确要求"必须在隐私说明里讲清楚"）。措辞里**不出现**任何"加密"字样 ——
// 这条落盘与 `transactions` 表同级别，说成加密就是制造安全错觉（`SecurityPage` 页尾同一原则）。
//
// 「知道了」这个动作是**持久化**的（`store.dismissPrivacyCard` 先写盘再改内存，失败即 reject）：
// 写失败时卡片**留在原地**，由调用方如实提示 —— 假装记住 = 用户以为看过了，下次却又弹。
import { CircleAlert } from "lucide-vue-next";

const props = defineProps<{
  /** `/ai/status` 给的服务器地址；`null` = 不可知 ⇒ 不渲染 */
  host: string | null;
  /** 说明卡是否已经看过（持久化标记）；`true` ⇒ 不渲染 */
  seen: boolean;
}>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div
    v-if="props.host !== null && !props.seen"
    class="m-3 rounded-xl border border-amber-200 bg-amber-50 p-3"
    data-test="ai-privacy-card"
  >
    <p class="mb-1 flex items-center gap-1 text-sm font-medium text-text">
      <CircleAlert :size="16" class="text-amber-500" />启用 AI 助手前请先了解
    </p>
    <p class="text-xs leading-relaxed text-text-secondary">
      启用后，你的提问、分类/账户名称、以及查询到的汇总数字会发送到
      <span class="font-medium text-text" data-test="ai-privacy-host">{{ props.host }}</span>。
      明细条目最多发送前 20 条。可随时在「我的 → 隐私」关闭。
    </p>
    <p class="mt-1 text-xs leading-relaxed text-text-secondary" data-test="ai-privacy-plaintext">
      会话历史是明文落盘（含金额与备注，与流水表同级别），请与数据文件本身同等看待。
    </p>
    <button
      type="button"
      class="mt-2 rounded-lg border border-gray-200 bg-surface px-3 py-1.5 text-xs text-text-secondary"
      data-test="ai-privacy-card-dismiss"
      @click="emit('dismiss')"
    >
      知道了
    </button>
  </div>
</template>
