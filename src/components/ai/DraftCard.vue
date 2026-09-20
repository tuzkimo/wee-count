<script setup lang="ts">
// 草稿卡（规格 §4.5 / §10.7）：AI 生成的"待确认"记账。
//
// **本层零写入**（store 的注释也是这条边界）：组件只调**既有**记账入口
// `transactionStore.add` / `transactionStore.remove`，一次 `getUserDb()` 都不碰、
// 一次 `db.execute` 都不发 —— 「AI 只能只读 + 新增草稿（经用户确认）」这条权限边界靠**结构**保证，
// 不靠约定。落 AI 会话表的写入是 `agent → session` 的事，这里一次都不调（测试钉着）。
//
// 字段口径逐条照 `useTransactionForm.doSave`（`src/composables/useTransactionForm.ts:156-173`），
// 因为那张表**已经**是"记账写什么"的唯一实现 —— 这里分叉会让草稿卡记出与记账页不同的账。
// 映射与校验抽在 `draftData.ts`（纯函数，另有一份纯函数测试直接钉字段来源）。
//
// 与记账页的一处**刻意**差异：**不**再调 `round2` —— `tools.ts:778` 生成草稿时已经 `round2` 过，
// `transactionStore.add` 也不做金额变换 ⇒ 这里再 round 一次是**等价冗余**（不是防线）。
// 见任务 6b 报告。
import { ref } from "vue";
import { Check, X } from "lucide-vue-next";
import { useTransactionStore } from "@/stores/transaction";
import { useLedgerStore } from "@/stores/ledger";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { useAmountMask } from "@/composables/useAmountMask";
import { buildDraftData, validateDraft } from "@/components/ai/draftData";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

const props = defineProps<{
  draft: AiDraftFields;
  resolved: AiDraftIds;
  /** 这条草稿是从哪来的（现在只有"AI 草稿"一种；显式写出是为了让页面传得明确） */
  source: "draft";
  /** 本卡属于哪条 assistant 消息（页面用来在确认后收起草稿区） */
  messageId: string;
}>();

const emit = defineEmits<{
  confirm: [];
  reject: [];
}>();

const transactionStore = useTransactionStore();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();
const { maskCurrency } = useAmountMask();

const saving = ref(false);
const error = ref("");

const TYPE_LABEL: Record<AiDraftFields["type"], string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

function onConfirm(): void {
  if (saving.value) return;
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) {
    error.value = "没有可用的账本";
    return;
  }
  const invalid = validateDraft(props.draft, props.resolved);
  if (invalid !== "") {
    error.value = invalid;
    return;
  }
  const userId = auth.currentLocalUser?.server_user_id || getCurrentUserId() || "";
  if (userId === "") {
    error.value = "拿不到当前用户，不能记账";
    return;
  }

  error.value = "";
  saving.value = true;
  void (async () => {
    try {
      await transactionStore.add(buildDraftData(props.draft, props.resolved, ledgerId, userId));
      emit("confirm");
    } catch (e) {
      // 记不上账必须让用户看见（静默 = 用户以为记上了）
      console.warn("[ai/draft] 记账失败：", e);
      error.value = "记账失败，请稍后再试";
    } finally {
      saving.value = false;
    }
  })();
}

/** 拒绝：**只发事件**（拆不拆卡由页面调 store 的 `dismissDraft` 决定，本层不写任何东西） */
function onReject(): void {
  if (saving.value) return;
  emit("reject");
}
</script>

<template>
  <div class="rounded-xl border border-gray-100 bg-surface p-3" data-test="draft-card">
    <p class="mb-2 text-xs text-text-secondary">待确认的记账</p>
    <p class="text-sm font-medium text-text">
      {{ TYPE_LABEL[draft.type] }} {{ maskCurrency(draft.amount) }}
    </p>
    <dl class="mt-1 space-y-0.5 text-xs text-text-secondary">
      <div v-if="draft.category" class="flex gap-1">
        <dt>分类</dt>
        <dd data-test="draft-category">{{ draft.category }}</dd>
      </div>
      <div v-if="draft.fromAccount" class="flex gap-1">
        <dt>转出</dt>
        <dd data-test="draft-from">{{ draft.fromAccount }}</dd>
      </div>
      <div v-if="draft.toAccount" class="flex gap-1">
        <dt>转入</dt>
        <dd data-test="draft-to">{{ draft.toAccount }}</dd>
      </div>
      <div class="flex gap-1">
        <dt>日期</dt>
        <dd data-test="draft-occurred-at">{{ draft.occurredAt }}</dd>
      </div>
      <div v-if="draft.note" class="flex gap-1">
        <dt>备注</dt>
        <dd data-test="draft-note">{{ draft.note }}</dd>
      </div>
    </dl>
    <p v-if="error" class="mt-2 text-xs text-red-500" data-test="draft-error">{{ error }}</p>
    <div class="mt-3 flex gap-2">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary py-2 text-sm text-white disabled:opacity-50"
        :disabled="saving"
        data-test="draft-confirm"
        @click="onConfirm"
      >
        <Check :size="16" />确认记账
      </button>
      <button
        type="button"
        class="flex items-center justify-center gap-1 rounded-lg border border-gray-200 px-4 py-2 text-sm text-text-secondary disabled:opacity-50"
        :disabled="saving"
        data-test="draft-reject"
        @click="onReject"
      >
        <X :size="16" />不要
      </button>
    </div>
  </div>
</template>
