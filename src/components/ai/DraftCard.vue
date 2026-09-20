<script setup lang="ts">
// 草稿卡（规格 §4.5 / §4.4:164 / §8.C:524 / §10.7）：AI 生成的"待确认"记账。
//
// 状态机（`state`）：**pending → saving → saved**（+ 撤销在途 `undoing`，视图**仍是**已记账）。
// 撤销用的 id **只来自 `transactionStore.add` 的返回值**（`transaction.ts:261-311` 返回新交易 id）
// —— 绝不用"最后一笔"这类猜法（§4.4 要的是"手滑确认的廉价安全网"，猜错等于删掉用户的另一笔账）。
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
// ⚠️ **对外契约只有三个事件**（`confirm` / `undo` / `reject`）：`confirm` 带新交易 id，页面**只监听它**
// 做 `dismissDraft`。曾经同时发 `confirm` + `saved` 两个同 id 同义事件 —— 页面两个都监听就会把
// `dismissDraft` 调两次（复审指出的两条会打架的契约）⇒ 已合并成一个。
//
// ⚠️ **没有事件层守卫**（`if (saving) return` 之类）：`onConfirm` / `onReject` 的唯一入口是模板里
// `:disabled` 的那两颗按钮，禁用态在真实浏览器的**事件派发层**就挡住点击（happy-dom 同样按
// `:disabled` 拒绝派发，探针实测过）⇒ 脚本里的守卫既走不到、也没有任何变异能红它。
// 按 Ruling 35（等价防御不许留）删掉；"双击只记一笔"由 `:disabled` 承担，并有一条用例钉它。
//
// ⚠️ **`props.draft` 一变就自清**（`watch`）：卡片每次代表**一条**草稿，而同实例被复用时
// （页面换 `draft`、不换 `:key`）`savedId` 会指向**上一笔** ⇒ 用户点「撤销」删掉的是**旧账**。
// 卡内自清 + 6c 按 `draftId` 加 `:key`，两边都做（复审 ③-2）。
import { ref, watch } from "vue";
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

/** 对外契约 `confirm` 带新交易 id（撤销另有 `undo`，拒绝是 `reject`） */
const emit = defineEmits<{
  confirm: [transactionId: string];
  undo: [transactionId: string];
  reject: [];
}>();

const transactionStore = useTransactionStore();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();
const { maskCurrency } = useAmountMask();

/**
 * `saving` / `undoing` 分开：两者都"有事在途"，但**视图不同**
 * —— 加账在途仍是待确认视图（两颗按钮禁用），撤销在途必须**留在已记账视图**。
 * 曾共用一个 `"saving"`：点下「撤销」的同一帧卡片会翻回"待确认"，remove 落地才翻回来（复审 ③-1）。
 */
const state = ref<"pending" | "saving" | "saved" | "undoing">("pending");
/** 已记账那笔的 id（`add` 的返回值）。撤销只用它。 */
const savedId = ref("");
const error = ref("");

const TYPE_LABEL: Record<AiDraftFields["type"], string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

/** 清掉"上一笔"的状态：换草稿时调，别让 `savedId` 指着别人的账 */
function resetForNewDraft(): void {
  state.value = "pending";
  savedId.value = "";
  error.value = "";
}

// 同一个实例换草稿（**若**页面没给 `:key` —— 今天的生产路径按 `draftId` 给了）⇒ 自清。`watch(() => props.draft)` 默认按**引用比较**（不 deep）：
// `props.draft` 是父级直接传下来的**新对象**（payload 反序列化出来的），引用一变就触发。
watch(() => props.draft, resetForNewDraft);

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
      // 对外只发这一个（带 id）
      emit("confirm", transactionId);
    } catch (e) {
      // 记不上账必须让用户看见（静默 = 用户以为记上了）
      console.warn("[ai/draft] 记账失败：", e);
      error.value = "记账失败，请稍后再试";
      // 回到**可确认态**（按钮可用）：卡在"记账中"就永远不能重试
      state.value = "pending";
    }
  })();
}

/** 撤销刚才那笔（§4.4：确认后仍可反悔）。id 用 `onConfirm` 拿到的那个，不重算、不猜。 */
function onUndo(): void {
  // ⚠️ 这里**没有**空 id 守卫：`savedId` 只可能被 `onConfirm` 写入，而撤销按钮只在
  // `state === "saved"` 时渲染，两者是一体的（`resetForNewDraft` 会把它们一起清掉）。
  // 原 `if (savedId.value === "") return;` 变异实测全绿 = 走不到的等价防御，按 Ruling 35 删。
  const removeId = savedId.value;
  error.value = "";
  // 留在**已记账视图**里撤销（`undoing` 而不是 `saving`）
  state.value = "undoing";
  void (async () => {
    try {
      await transactionStore.remove(removeId);
      // 撤销成功 ⇒ 这张卡回到"待确认"，用户可以重新确认（commit/rollback 的语义）
      resetForNewDraft();
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
  <div
    class="rounded-xl border border-gray-100 bg-surface p-3"
    :data-draft-state="state"
    data-test="draft-card"
  >
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

    <!-- 已记账（含撤销在途）：确认/不要 换成 已记账 ✓ + 撤销（§4.4） -->
    <div v-if="state === 'saved' || state === 'undoing'" class="mt-3 flex gap-2" data-test="draft-saved">
      <p class="flex flex-1 items-center gap-1 text-sm text-text" data-test="draft-saved-text">
        <Check :size="16" class="text-income" />已记账
      </p>
      <button
        type="button"
        class="flex items-center justify-center gap-1 rounded-lg border border-gray-200 px-4 py-2 text-sm text-text-secondary disabled:opacity-50"
        :disabled="state === 'undoing'"
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
