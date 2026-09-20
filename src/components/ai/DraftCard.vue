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
// 与记账页的一处**刻意**差异：**不**再调 `round2` —— `tools.ts:787` 生成草稿时已经 `round2` 过，
// `transactionStore.add` 也不做金额变换 ⇒ 这里再 round 一次是**等价冗余**（不是防线）。
// ⚠️ 内联编辑**改了**这条：编辑区是**用户输入**，进来的是任意字符串 ⇒ `applyDraftEdit` 里
// 必须 `round2`（§4.4:162 / §10.7 点名复用 `utils/transaction.ts` 的规则），这不是冗余。
//
// ⚠️ **对外契约只有三个事件**（`confirm` / `undo` / `reject`）：`confirm` 带新交易 id，页面据此把
// **决定**写进 payload（`aiChat.confirmDraft`）并**保留这张卡**（§4.4:164 的「已记账 ✓ + 撤销」）；
// 曾经同时发 `confirm` + `saved` 两个同 id 同义事件 —— 页面两个都监听就会把同一个决定处理两次
// （复审指出的两条会打架的契约）⇒ 已合并成一个。
//
// ⚠️ **没有事件层守卫**（`if (saving) return` 之类）：`onConfirm` / `onReject` 的唯一入口是模板里
// `:disabled` 的那两颗按钮，禁用态在真实浏览器的**事件派发层**就挡住点击（happy-dom 同样按
// `:disabled` 拒绝派发，探针实测过）⇒ 脚本里的守卫既走不到、也没有任何变异能红它。
// 按 Ruling 35（等价防御不许留）删掉；"双击只记一笔"由 `:disabled` 承担，并有一条用例钉它。
//
// ⚠️ **`props.draft` 一变就自清**（`watch`）：卡片每次代表**一条**草稿，而同实例被复用时
// （页面换 `draft`、不换 `:key`）`savedId` 会指向**上一笔** ⇒ 用户点「撤销」删掉的是**旧账**。
// 卡内自清 + 6c 按 `draftId` 加 `:key`，两边都做（复审 ③-2）。
import { computed, ref, watch } from "vue";
import { Check, Pencil, Undo2, X } from "lucide-vue-next";
import { useTransactionStore } from "@/stores/transaction";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { useAmountMask } from "@/composables/useAmountMask";
import {
  applyDraftEdit,
  buildDraftData,
  validateDraft,
  type DraftEditForm,
} from "@/components/ai/draftData";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

const props = withDefaults(
  defineProps<{
    draft: AiDraftFields;
    resolved: AiDraftIds;
    /**
     * 金额遮罩（§7.4）：**历史消息**里的草稿卡跟随遮罩，本轮问出来的显示真值。
     * `undefined` = 调用方没判定（旧调用点）⇒ 跟随全局 `amountsHidden`，与 6d 之前完全一致。
     */
    masked?: boolean;
    /**
     * 库里那条消息上**已经持久化**的决定（收口 C-P1）。`undefined`（组件单独挂载 / 旧调用点）
     * = 没有决定可恢复 ⇒ 当"待确认"，与 6c 之前完全一致。
     *
     * 它不是"页面越权管组件状态"：卡的状态机由卡自己走（`state`），这个 prop 只负责**播种**与
     * **同步**（重进页面时把 `confirmed` 恢复成「已记账 ✓ + 撤销」）。不接它的话，重进页面后
     * 那张卡会显示成"待确认"—— 用户再点一次就写**第二笔**。
     */
    status?: "pending" | "confirmed" | "rejected";
    /** 已记账那笔的交易 id（`add` 的返回值，随决定一起落库）：重进页面后撤销仍要知道删哪一笔 */
    transactionId?: string | null;
    /**
     * 递增即"刚才那次决定**没落库**"（收口 R86-4）。页面在这一层做两件事：把账上那笔撤回来
     * （`transactionStore.remove`），再把这里 +1 —— 卡据此**回退**成待确认并显示 `rollbackMessage`。
     *
     * 为什么需要它：卡片是"记账"的写入方（`add` 成功即进「已记账 ✓」视图），而"决定"落库是**页面**
     * 的事（`ai.confirmDraft`）。两者不一致时（库里仍是 pending、账上已经多了一笔）不许静默：
     * 用户会以为记上了，重进页面草稿复活、再点一次确认就是**第二笔**真账。
     */
    rollback?: number;
    /** 回退时显示给用户的那句话（由页面决定文案：它知道账上那笔有没有撤回成功） */
    rollbackMessage?: string;
  }>(),
  // ⚠️ `masked: undefined` **必须显式写出来**：Vue 对 Boolean 类型 prop 有"缺席 ⇒ false"的强制转换
  // （`resolvePropValue`：没有 default 时，缺席的 Boolean prop 会被赋成 `false`），
  // 而这里"缺席"的语义是**没有判定**（跟随全局开关），不是"不遮"。显式给了 default 之后，
  // 缺席就保持 `undefined` ⇒ 下面 `?? amountsHidden.value` 才成立（实测：去掉它，跟随全局那条直接变"不遮"）。
  { masked: undefined, status: "pending", transactionId: null, rollback: 0, rollbackMessage: "" },
);

/** 对外契约 `confirm` 带新交易 id（撤销另有 `undo`，拒绝是 `reject`） */
const emit = defineEmits<{
  confirm: [transactionId: string];
  undo: [transactionId: string];
  reject: [];
}>();

const transactionStore = useTransactionStore();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const categoryStore = useCategoryStore();
const auth = useAuthStore();
const { maskCurrency, amountsHidden } = useAmountMask();

/**
 * 遮罩判定（§7.4）：调用方给了 `masked` 就用它（按消息判），没给就跟随全局开关。
 * ⚠️ **编辑区的金额输入框也要跟着遮** —— 否则"历史消息遮住了金额"，用户一点「修改」,
 * 输入框里就明明白白写着 128.5（同一个屏幕上、同一个数字）。做法见 `onStartEdit`。
 */
const hidden = computed(() => props.masked ?? amountsHidden.value);

/**
 * `saving` / `undoing` 分开：两者都"有事在途"，但**视图不同**
 * —— 加账在途仍是待确认视图（两颗按钮禁用），撤销在途必须**留在已记账视图**。
 * 曾共用一个 `"saving"`：点下「撤销」的同一帧卡片会翻回"待确认"，remove 落地才翻回来（复审 ③-1）。
 */
const state = ref<"pending" | "saving" | "saved" | "undoing">(
  // 播种**持久化的决定**（收口 C-P1）：重进页面那张卡一上来就是「已记账 ✓ + 撤销」。
  // `saving`/`undoing` 是**在途**态，永远不可能来自库（没有"在途"落库这一说）。
  props.status === "confirmed" ? "saved" : "pending"
);
/** 已记账那笔的 id（`add` 的返回值，或从 payload 恢复回来的那个）。撤销只用它。 */
const savedId = ref(props.transactionId ?? "");
const error = ref("");

/**
 * 内联编辑的**本地覆盖**（§4.4:162）。`null` = 用户还没改过 ⇒ 一律读 props。
 *
 * 为什么不是"把 props 拷一份进 ref"：那样 `resolved` 单独变化（页面换草稿、`readDrafts` 重产）
 * 就再也进不来，而"没编辑过的卡必须跟着 props 走"是这张卡本来的行为。
 * 也不用把编辑写回 store：`pendingDrafts` 是草稿的唯一真相，多一个可变点没有规格依据
 * （`§4.4` 只要求"卡上能改"）；代价是**实例销毁即丢**（页面按 `draftId` 给了 `:key`，
 * 同账本内新消息不重建它，`load()`/切账本会）。
 */
const editedFields = ref<AiDraftFields | null>(null);
const editedIds = ref<AiDraftIds | null>(null);
/** 编辑区开着（只可能出现在 `pending`） */
const editing = ref(false);
/** 编辑区当前的表单值（字符串，由 `<input>` / `<select>` 直接 v-model） */
const form = ref<DraftEditForm>({
  amount: "",
  categoryId: null,
  fromAccountId: null,
  toAccountId: null,
  occurredAt: "",
  note: "",
});

/** 这张卡**当前**代表的草稿：用户改过就是改后的，否则就是 props（唯一真相仍是 props/store） */
const fields = computed<AiDraftFields>(() => editedFields.value ?? props.draft);
const ids = computed<AiDraftIds>(() => editedIds.value ?? props.resolved);

const TYPE_LABEL: Record<AiDraftFields["type"], string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

/** 支出/转账要转出账户；收入/转账要转入账户（与 `buildDraftData` 的两个三元同一判据） */
const needFrom = computed(() => fields.value.type !== "income");
const needTo = computed(() => fields.value.type !== "expense");

/**
 * 分类候选：照 `useTransactionForm.filteredCategories:39-41`（只按 `type` 过滤）。
 * `categoryStore.categories` 自己已经排除软删行，这里不重复判。
 */
const categoryOptions = computed(() =>
  categoryStore.categories.filter((c) => c.type === fields.value.type),
);

/**
 * 账户候选：照 `useTransactionForm.availableAccounts:48-54`（排除软删；团队账本只给自己名下的账户）。
 * ⚠️ 这两行是那条规则的**第二份**写法，改一处必须改另一处；不复用 composable 是因为它
 * `useRoute()`（记账页的路由形态），草稿卡要能在没有 router 的组件测试里挂起来。
 */
const currentUserId = computed(
  () => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "",
);
const accountOptions = computed(() =>
  accountStore.accounts.filter((a) => {
    if (a.is_deleted) return false;
    if (ledgerStore.currentLedger?.type === "team" && a.owner_id !== currentUserId.value) return false;
    return true;
  }),
);

/** 清掉"上一笔"的状态：换草稿时调，别让 `savedId` 指着别人的账 */
function resetForNewDraft(): void {
  state.value = "pending";
  savedId.value = "";
  error.value = "";
}

// 同一个实例换草稿（**若**页面没给 `:key` —— 今天的生产路径按 `draftId` 给了）⇒ 自清。`watch(() => props.draft)` 默认按**引用比较**（不 deep）：
// `props.draft` 是父级直接传下来的**新对象**（payload 反序列化出来的），引用一变就触发。
watch(() => props.draft, () => {
  resetForNewDraft();
  // 换草稿连编辑缓冲一起丢：留着就成"这张卡显示 A、确认时写 B"
  editedFields.value = null;
  editedIds.value = null;
  editing.value = false;
});

/**
 * 跟随**持久化的决定**（收口 C-P1）：同一张草稿的 `status` 从 `confirmed` 变回 `pending`
 * （用户撤销了，`aiChat.undoDraft` 写回 payload）⇒ 卡回到"待确认"，用户可以重新确认一次。
 *
 * ⚠️ 这里**不能**清 `savedId`：`applyDraftDecision` 是"先写库、后改内存"，`status` 变 `pending`
 * 与 `savedId` 清空发生在同一次 await 之后 —— 撤销在途（`state === "undoing"`）时若把
 * `savedId` 清掉，`onUndo` 里那次 `remove` 的收尾就会对着一个空 id。真正的清空在 `onUndo` 成功之后。
 *
 * ⚠️ 反向（`pending → confirmed`）不在这里处理：那一路是**卡自己**确认的（`onConfirm` 已经进了
 * 已记账态），重复置位会把状态机踩回去。
 */
watch(() => props.status, (next) => {
  if (next === "pending" && state.value !== "pending") resetForNewDraft();
});

/**
 * 页面说"刚才那次决定没落库"（R86-4）：**回退**成待确认 + 让用户看见这句人话。
 *
 * 与上面那个 `props.status` watch 的分工：`status` 只管"库里那份决定变没变"（撤销时 `confirmed
 * → pending`），而**失败**那条路上 `status` 一直就是 `pending`（值没变，watch 不会触发）——
 * 可卡片本地已经因为 `add` 成功进了 `saved`。这个计数器就是那种"值没变但必须回退"的信号。
 *
 * 不回退的后果（实测形态）：账上多了一笔、库里没有决定 ⇒ 卡片写着「已记账 ✓」，重进页面草稿复活成
 * 待确认 ⇒ 用户再确认一次 = 第二笔真账。
 *
 * ⚠️ 只调 `resetForNewDraft()`，**不**清 `editedFields`：用户手改过的金额还在，重试时不用重敲
 * （与"换草稿就清编辑缓冲"那条区分开 —— 这里换的不是草稿，是同一条草稿的失败重试）。
 */
watch(() => props.rollback, (next, prev) => {
  if (next === prev) return;
  resetForNewDraft();
  error.value = props.rollbackMessage;
});

/** 打开编辑区：从**当前**草稿播种表单（改过就是改后的值，没改过就是 props） */
function onStartEdit(): void {
  error.value = "";
  form.value = {
    // ⚠️ 遮罩态下**不把真金额填进输入框**（那等于把刚遮住的数字又摆到屏幕正中）。
    // 代价是用户得重新输一遍金额 —— 遮蔽的语义本来就是"不该在屏幕上出现"，而不是"看不见但能编辑"。
    // 其余四个字段（分类/账户/时间/备注）不是金额，照常回填。
    amount: hidden.value ? "" : String(fields.value.amount),
    categoryId: ids.value.categoryId,
    fromAccountId: ids.value.fromAccountId,
    toAccountId: ids.value.toAccountId,
    occurredAt: fields.value.occurredAt,
    note: fields.value.note ?? "",
  };
  editing.value = true;
}

function onCancelEdit(): void {
  editing.value = false;
  error.value = "";
}

/** 保存编辑：校验全在 `applyDraftEdit`（纯函数，复用 `utils/transaction.ts` 的规则 + `round2`） */
function onSaveEdit(): void {
  const name = (list: { id: string; name: string }[], id: string | null): string | null =>
    id === null ? null : (list.find((it) => it.id === id)?.name ?? null);

  const result = applyDraftEdit(fields.value, ids.value, form.value, {
    category: name(categoryOptions.value, form.value.categoryId),
    fromAccount: name(accountOptions.value, form.value.fromAccountId),
    toAccount: name(accountOptions.value, form.value.toAccountId),
  });
  if (!result.ok) {
    // 校验没过就**留在编辑区**：收起表单等于把用户刚敲的东西藏起来，而他只看到一句错误
    error.value = result.error;
    return;
  }
  editedFields.value = result.draft;
  editedIds.value = result.resolved;
  editing.value = false;
  error.value = "";
}

function onConfirm(): void {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) {
    error.value = "没有可用的账本";
    return;
  }
  // ⚠️ 用 `fields`/`ids`（可能是编辑后的），不是 props —— 内联编辑的意义就在这里
  const invalid = validateDraft(fields.value, ids.value);
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
        buildDraftData(fields.value, ids.value, ledgerId, userId),
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

/** 撤销刚才那笔。id 用 `onConfirm` 拿到的那个，不重算、不猜。 */
// ⚠️ 依据是 `§4.4:164` 的那颗「撤销」按钮，**不是** spec 里的某句话：`§4.4:160` 的状态机只有
// `pending → confirmed | discarded`，`confirmed → pending` 是本仓的**扩展**（撤销后那张卡可再确认，
// 与 `resetForNewDraft()` 的既有语义一致）。上一轮把「确认后仍可反悔」当原文引用是错的（R86-3）。
function onUndo(): void {
  // ⚠️ 这里**没有**空 id 守卫：`savedId` 只可能被 `onConfirm` 写入或由 `transactionId` prop 播种，
  // 而撤销按钮只在 `state === "saved" | "undoing"` 时渲染，两者是一体的。
  // 原 `if (savedId.value === "") return;` 变异实测全绿 = 走不到的等价防御，按 Ruling 35 删。
  const removeId = savedId.value;
  error.value = "";
  // 留在**已记账视图**里撤销（`undoing` 而不是 `saving`）
  state.value = "undoing";
  void (async () => {
    try {
      await transactionStore.remove(removeId);
      // 撤销成功 ⇒ 这张卡回到"待确认"（**先**清本地，再发事件：页面的 `undoDraft` 会把 status
      // 同步回 `pending`，下面那个 watch 不会把状态机踩回去）
      resetForNewDraft();
      emit("undo", removeId);
    } catch (e) {
      console.warn("[ai/draft] 撤销失败：", e);
      error.value = "撤销失败，请到流水页删除";
      state.value = "saved";
    }
  })();
}

/**
 * 拒绝：**只发事件**（本层不写任何东西 —— 卡从列表里消失是**页面**调 `rejectDraft` 的结果：
 * 那条决定落库后草稿进 `rejectedDrafts`，而页面只渲染待确认 + 已确认两份）。
 */
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
    <!-- ⚠️ 这一行只在**待确认视图**里出现（R86-5）：已记账卡同一屏写着「待确认的记账」与「已记账 ✓」
         是自相矛盾的文案（本轮之前 saved 视图在页面里画不出来，所以看不出来）。 -->
    <p v-if="state !== 'saved' && state !== 'undoing'" class="mb-2 text-xs text-text-secondary">
      待确认的记账
    </p>
    <p class="text-sm font-medium text-text">
      {{ TYPE_LABEL[fields.type] }} {{ maskCurrency(fields.amount, hidden) }}
    </p>

    <!-- 编辑区（§4.4:162）：只列规格点名的五个字段，type / tags 不给改 -->
    <div v-if="editing" class="mt-1 space-y-1.5 text-xs" data-test="draft-edit-form">
      <label class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-text-secondary">金额</span>
        <input
          v-model="form.amount"
          type="text"
          inputmode="decimal"
          :placeholder="hidden ? '请输入金额' : '0.00'"
          class="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-text"
          data-test="draft-edit-amount"
        />
      </label>
      <label v-if="fields.type !== 'transfer'" class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-text-secondary">分类</span>
        <select
          v-model="form.categoryId"
          class="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-text"
          data-test="draft-edit-category"
        >
          <option :value="null">请选择分类</option>
          <option v-for="c in categoryOptions" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label v-if="needFrom" class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-text-secondary">转出</span>
        <select
          v-model="form.fromAccountId"
          class="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-text"
          data-test="draft-edit-from"
        >
          <option :value="null">请选择账户</option>
          <option v-for="a in accountOptions" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label v-if="needTo" class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-text-secondary">转入</span>
        <select
          v-model="form.toAccountId"
          class="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-text"
          data-test="draft-edit-to"
        >
          <option :value="null">请选择账户</option>
          <option v-for="a in accountOptions" :key="a.id" :value="a.id">{{ a.name }}</option>
        </select>
      </label>
      <label class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-text-secondary">时间</span>
        <input
          v-model="form.occurredAt"
          type="datetime-local"
          class="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-text"
          data-test="draft-edit-occurred-at"
        />
      </label>
      <label class="flex items-center gap-2">
        <span class="w-10 shrink-0 text-text-secondary">备注</span>
        <input
          v-model="form.note"
          type="text"
          class="min-w-0 flex-1 rounded border border-gray-200 px-2 py-1 text-text"
          data-test="draft-edit-note"
        />
      </label>
    </div>

    <dl v-else class="mt-1 space-y-0.5 text-xs text-text-secondary">
      <div v-if="fields.category" class="flex gap-1">
        <dt>分类</dt>
        <dd data-test="draft-category">{{ fields.category }}</dd>
      </div>
      <div v-if="fields.fromAccount" class="flex gap-1">
        <dt>转出</dt>
        <dd data-test="draft-from">{{ fields.fromAccount }}</dd>
      </div>
      <div v-if="fields.toAccount" class="flex gap-1">
        <dt>转入</dt>
        <dd data-test="draft-to">{{ fields.toAccount }}</dd>
      </div>
      <div class="flex gap-1">
        <dt>日期</dt>
        <dd data-test="draft-occurred-at">{{ fields.occurredAt }}</dd>
      </div>
      <div v-if="fields.note" class="flex gap-1">
        <dt>备注</dt>
        <dd data-test="draft-note">{{ fields.note }}</dd>
      </div>
    </dl>
    <p v-if="error" class="mt-2 text-xs text-red-500" data-test="draft-error">{{ error }}</p>

    <!-- 编辑中：确认/不要 收起，换成 保存/取消（不验收就等于没改） -->
    <div v-if="editing" class="mt-3 flex gap-2">
      <button
        type="button"
        class="flex flex-1 items-center justify-center gap-1 rounded-lg bg-primary py-2 text-sm text-white"
        data-test="draft-edit-save"
        @click="onSaveEdit"
      >
        <Check :size="16" />保存修改
      </button>
      <button
        type="button"
        class="flex items-center justify-center gap-1 rounded-lg border border-gray-200 px-4 py-2 text-sm text-text-secondary"
        data-test="draft-edit-cancel"
        @click="onCancelEdit"
      >
        <X :size="16" />取消
      </button>
    </div>

    <!-- 已记账（含撤销在途）：确认/不要 换成 已记账 ✓ + 撤销（§4.4） -->
    <div
      v-else-if="state === 'saved' || state === 'undoing'"
      class="mt-3 flex gap-2"
      data-test="draft-saved"
    >
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
        class="flex items-center justify-center gap-1 rounded-lg border border-gray-200 px-3 py-2 text-sm text-text-secondary disabled:opacity-50"
        :disabled="state === 'saving'"
        data-test="draft-edit"
        @click="onStartEdit"
      >
        <Pencil :size="16" />修改
      </button>
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
