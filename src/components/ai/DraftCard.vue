<script setup lang="ts">
// 草稿卡（规格 §4.5 / §4.4:164 / §8.C:524 / §10.7）：AI 生成的"待确认"记账。
//
// 三态：**待确认 → 记账中 → 已记账 ✓（可撤销）**。撤销用的 id **只来自
// `transactionStore.add` 的返回值**（`transaction.ts:261-311` 返回新交易 id）——
// 绝不用"最后一笔"这类猜法（§4.4 要的是"手滑确认的廉价安全网"，猜错等于删掉用户的另一笔账）。
//
// **本层零写入**：组件只调**既有**记账入口 `transactionStore.add` / `transactionStore.remove`，
// 一次 `getUserDb()` 都不碰、一次 `db.execute` 都不发 —— 「AI 只能只读 + 新增草稿（经用户确认）」
// 这条权限边界靠**结构**保证。落 AI 会话表的写入是 `agent → session` 的事（测试钉着零调用）。
//
// 字段口径逐条照 `useTransactionForm.doSave`（`src/composables/useTransactionForm.ts:156-173`），
// 因为那张表**已经**是"记账写什么"的唯一实现 —— 这里分叉会让草稿卡记出与记账页不同的账。
// 映射与校验抽在 `draftData.ts`（纯函数，另有一份纯函数测试直接钉字段来源）。
//
// 与记账页的一处**刻意**差异：**不**再调 `round2` —— `tools.ts:778` 生成草稿时已经 `round2` 过，
// `transactionStore.add` 也不做金额变换 ⇒ 这里再 round 一次是**等价冗余**（不是防线）。
//
// ⚠️ 这里**没有** `if (saving) return` 这类事件层守卫：`onConfirm` 的唯一入口是模板里
// `:disabled="saving"` 的那颗按钮，禁用态在真实浏览器的**事件派发层**就挡住了点击（jsdom/happy-dom
// 同样按 `:disabled` 拒绝派发）⇒ 脚本里的守卫既走不到、也没有任何变异能红它。
// 按 Ruling 35（等价防御不许留）删掉；"双击只记一笔"由 `:disabled` 承担，并有一条用例钉它。
import { ref } from "vue";
import { Check, Undo2, X } from "lucide-vue-next";
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
}>();

// `confirm` 带新交易 id：页面要拿它去 `dismissDraft`（§4.4 的"确认后收起这张卡"）。
// `saved` 是同一件事的**成功信号**（确认流水走完后才发），页面只监听它做收起 —— 两个事件都带 id，
// 免得页面为了拿 id 去猜"最后一笔"。
const emit = defineEmits<{
  confirm: [transactionId: string];
  saved: [transactionId: string];
  undo: [transactionId: string];
  reject: [];
}>();

const transactionStore = useTransactionStore();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();
const { maskCurrency } = useAmountMask();

const state = ref<"pending" | "saving" | "saved">("pending");
/** 已记账那笔的 id（`add` 的返回值）。撤销只用它。 */
const savedId = ref("");
const error = ref("");

const TYPE_LABEL: Record<AiDraftFields["type"], string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

function onConfirm(): void {
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
  state.value = "saving";
  void (async () => {
    try {
      // ⚠️ 返回值**必须接着**：它就是撤销要用的 id
      const transactionId = await transactionStore.add(
        buildDraftData(props.draft, props.resolved, ledgerId, userId),
      );
      savedId.value = transactionId;
      state.value = "saved";
      emit("confirm", transactionId);
      emit("saved", transactionId);
    } catch (e) {
      // 记不上账必须让用户看见（静默 = 用户以为记上了）
      console.warn("[ai/draft] 记账失败：", e);
      error.value = "记账失败，请稍后再试";
      // 回到可确认态：用户还能重试（卡在"记账中"会永远转下去）
      state.value = "pending";
    }
  })();
}

/** 撤销刚才那笔（§4.4：确认后仍可反悔）。id 用 `onConfirm` 拿到的那个，不重算、不猜。 */
function onUndo(): void {
  if (savedId.value === "") return;
  const removeId = savedId.value;
  error.value = "";
  state.value = "saving";
  void (async () => {
    try {
      await transactionStore.remove(removeId);
      savedId.value = "";
      state.value = "pending";
      emit("undo", removeId);
    } catch (e) {
      console.warn("[ai/draft] 撤销失败：", e);
      error.value = "撤销失败，请到流水页删除";
      state.value = "saved";
    }
  })();
}

/** 拒绝：**只发事件**（拆不拆卡由页面调 store 的 `dismissDraft` 决定，本层不写任何东西） */
function onReject(): void {
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

    <!-- 已记账：确认/不要 换成 已记账 ✓ + 撤销（§4.4） -->
    <div v-if="state === 'saved'" class="mt-3 flex gap-2" data-test="draft-saved">
      <p class="flex flex-1 items-center gap-1 text-sm text-text" data-test="draft-saved-text">
        <Check :size="16" class="text-income" />已记账
      </p>
      <button
        type="button"
        class="flex items-center justify-center gap-1 rounded-lg border border-gray-200 px-4 py-2 text-sm text-text-secondary"
        data-test="draft-undo"
        @click="onUndo"
      >
        <Undo2 :size="16" />撤销
      </button>
    </div>
    <div v-else class="mt-3 flex gap-2">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary py-2 text-sm text-white disabled:opacity-50"
        :disabled="state === 'saving'"
        data-test="draft-confirm"
        @click="onConfirm"
      >
        <Check :size="16" />确认记账
      </button>
      <button
        type="button"
        class="flex items-center justify-center gap-1 rounded-lg border border-gray-200 px-4 py-2 text-sm text-text-secondary disabled:opacity-50"
        :disabled="state === 'saving'"
        data-test="draft-reject"
        @click="onReject"
      >
        <X :size="16" />不要
      </button>
    </div>
  </div>
</template>
