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
//
// ⚠️ **卡片只读**（§4.4.2/§4.4.3，2026-09-24 人工批准的设计变更）：金额、分类、账户、日期、备注、
// tag 一律不能在卡上改，卡上**没有任何输入控件**、也没有「修改」按钮。觉得 AI 生成得不对 ⇒ 在
// 对话里用自然语言重说一句（重新生成一张卡）；要精修 ⇒ 去**流水列表**改那条已入账的流水。
// 原内联编辑区（编辑缓冲、编辑期校验、`applyDraftEdit`）整条路径已随新设计删除。
//
// **四个可见形态**（§4.4.1）：待确认 / 已记账 ✓ + 撤销 / **已撤回**（静态卡，零按钮）/ 已撤销回退
// 到待确认。已撤回那一份**照样渲染**（页面的 `draftsFor()` 收它），且与待确认卡**共用同一份摘要**——
// 摘要不缩水是硬要求：两张卡各写一份渲染就是"撤回过一次就少显示两个字段"这类缺陷的温床。
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
import { Check, Undo2, X } from "lucide-vue-next";
import { useTransactionStore } from "@/stores/transaction";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { useAmountMask } from "@/composables/useAmountMask";
import { useMemberInfo } from "@/composables/useMemberInfo";
// 别人的账户名与提示词快照 / 解析表**同一个格式来源**（`小明的现金`）。本组件不碰 AI 编排，
// 只借这一个纯函数：两处各写一份模板串，漂移的表现就是"卡上的名字与快照里的对不上"。
import { otherAccountLabel } from "@/services/ai/prompt";
import { buildDraftData, validateDraft } from "@/components/ai/draftData";
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
const auth = useAuthStore();
const { maskCurrency, amountsHidden } = useAmountMask();

/**
 * 遮罩判定（§7.4）：调用方给了 `masked` 就用它（按消息判），没给就跟随全局开关。
 */
const hidden = computed(() => props.masked ?? amountsHidden.value);

/**
 * `saving` / `undoing` 分开：两者都"有事在途"，但**视图不同**
 * —— 加账在途仍是待确认视图（两颗按钮禁用），撤销在途必须**留在已记账视图**。
 * 曾共用一个 `"saving"`：点下「撤销」的同一帧卡片会翻回"待确认"，remove 落地才翻回来（复审 ③-1）。
 *
 * `rejected` 是**静态卡**（§4.4.4）：没有按钮、也不会有在途态。
 */
const state = ref<"pending" | "saving" | "saved" | "undoing" | "rejected">(
  // 播种**持久化的决定**（收口 C-P1）：重进页面那张卡一上来就是「已记账 ✓ + 撤销」/「已撤回」。
  // `saving`/`undoing` 是**在途**态，永远不可能来自库（没有"在途"落库这一说）。
  props.status === "confirmed" ? "saved" : props.status === "rejected" ? "rejected" : "pending"
);
/** 已记账那笔的 id（`add` 的返回值，或从 payload 恢复回来的那个）。撤销只用它。 */
const savedId = ref(props.transactionId ?? "");
const error = ref("");

/**
 * 这张卡**当前**代表的草稿。卡片只读（§4.4.3）⇒ 没有本地覆盖，一律就是 props；
 * 保留这两个 computed 只是为了让模板与 `onConfirm` 读同一个名字（曾经它们是"编辑后的值 vs props"
 * 那个二选一的落点，编辑路径删除后二选一消失，唯一真相回到 props/store）。
 */
const fields = computed<AiDraftFields>(() => props.draft);
const ids = computed<AiDraftIds>(() => props.resolved);

const TYPE_LABEL: Record<AiDraftFields["type"], string> = {
  expense: "支出",
  income: "收入",
  transfer: "转账",
};

/**
 * 当前用户 id：只服务**归属名**（"这个账户是谁的"）—— 与快照（`aiChat.ts:1073-1075`）、
 * 解析表（`resolve.ts`）同一判据。
 *
 * ⚠️ 卡片只读（§4.4.3）之后，这里**不再**有"账户下拉候选"那两份（`ownAccountOptions` /
 * `toAccountOptions`）：候选清单是**编辑**才需要的东西，随编辑路径一起删除。只读展示要的是
 * `displayAccount`（下面那个以 `resolved` 的 id 为准的反查）。
 */
const currentUserId = computed(
  () => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "",
);

/**
 * 别人名下账户在卡上的名字：**与提示词快照 / 解析表逐字相同**（`otherAccountLabel`，`小明的现金`）。
 * 裸名不行 —— 卡上那一行写着「小明的现金」而快照里是「现金」，两处对不上；两个成员各有一个
 * 「现金」时更是两条一模一样的行，用户分不出这笔钱进了谁的口袋。归属名拿不到时
 * `otherAccountLabel` 回落「其他成员」，与 `prompt.ts:54-56` 同一口径（绝不用 id 前缀当名字）。
 *
 * 名字走 `useMemberInfo`（别名 > 昵称 > username）—— 它也是 `AccountPickerSheet:39-44`
 * 在手动记账的账户面板里给成员加归属时用的同一个实现。
 */
const ownerNames = ref<Record<string, string>>({});
const { getMember } = useMemberInfo();
async function loadOwnerName(ownerId: string): Promise<void> {
  if (ownerNames.value[ownerId] !== undefined) return;
  const info = await getMember(ownerId);
  ownerNames.value[ownerId] = info.displayName;
}
/** 归属人 id 的**串**当 watch 键：数组字面量每次都是新引用，直接 watch 会每轮重算都触发一次 */
const otherOwnerIds = computed(() => {
  if (ledgerStore.currentLedger?.type !== "team") return [];
  // 这张卡指向的那两个账户**无论如何都要**有归属名（哪怕它已被软删）：只读展示要显示它，
  // 而选择器才需要过滤软删行 —— 两件事的判据不同，别把 `is_deleted` 混进来。
  const referenced = new Set([ids.value.fromAccountId, ids.value.toAccountId]);
  const ownerIds = accountStore.accounts
    .filter((a) => a.owner_id !== currentUserId.value && (!a.is_deleted || referenced.has(a.id)))
    .map((a) => a.owner_id);
  return [...new Set(ownerIds)].sort();
});
watch(
  () => otherOwnerIds.value.join(","),
  () => {
    for (const id of otherOwnerIds.value) {
      if (id !== "") void loadOwnerName(id);
    }
  },
  { immediate: true },
);

/**
 * 只读展示里那一行账户名：**以解析出的账户为准**（`resolved` 里的 id 才是"确认后会写进账"的
 * 那个账户），解析不到才回落到模型/用户写的那串字。
 *
 * ⚠️ 不能照抄 `fields.fromAccount` / `fields.toAccount`：那是**模型写的字**。用户说"转到现金"、
 * 而"现金"是别人名下的账户时，工具的匹配是"精确 → 双向包含"（`resolve.ts:117-123`），转入侧的
 * 同名保护（`tools.ts:696-702`）**只在解析结果落在我名下**时才拦 ⇒ 解析成功、落到**小明**的
 * 账户，而模型写下的 `toAccount` 是裸名「现金」。照抄的表现就是卡上只写「转入 现金」，
 * 用户看不出这笔钱要进谁的账户（实机缺陷）。id 是账的真相，字只是模型的转述。
 *
 * 归属名只在"团队账本 + 身份已知 + 不是我名下"时加，与快照（`aiChat.ts:1073-1075`）同一判据；
 * 名字格式复用 `otherAccountLabel`（`小明的现金`）—— 且前缀加在**账户自己的 name** 上，
 * 所以模型即便已经写了「小明的现金」也不会叠成「小明的小明的现金」。
 */
function displayAccount(id: string | null, written: string | null): string | null {
  if (id === null) return written;
  const account = accountStore.accounts.find((a) => a.id === id);
  if (account === undefined) return written;
  const scoped = ledgerStore.currentLedger?.type === "team" && currentUserId.value !== "";
  if (!scoped || account.owner_id === currentUserId.value) return account.name;
  return otherAccountLabel(ownerNames.value[account.owner_id], account.name);
}
const displayFrom = computed(() => displayAccount(ids.value.fromAccountId, fields.value.fromAccount));
const displayTo = computed(() => displayAccount(ids.value.toAccountId, fields.value.toAccount));

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
 *
 * `pending → rejected` 要跟（撤回的决定由 `aiChat.rejectDraft` 写库）：同一实例被复用、`status`
 * 变了而 `state` 不跟，卡上就还挂着两颗按钮 —— 用户再点一次「确认记账」，那笔**不该入账**的钱
 * 就真进流水了（静态卡的意义正是"这张卡不再有任何动作"）。
 */
watch(() => props.status, (next) => {
  if (next === "pending" && state.value !== "pending") resetForNewDraft();
  else if (next === "rejected" && state.value !== "rejected") state.value = "rejected";
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
 * ⚠️ 只调 `resetForNewDraft()`：**不**碰任何"用户输入"（卡片只读，没有输入缓冲可留）。
 */
watch(() => props.rollback, (next, prev) => {
  if (next === prev) return;
  resetForNewDraft();
  error.value = props.rollbackMessage;
});

function onConfirm(): void {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) {
    error.value = "没有可用的账本";
    return;
  }
  // ⚠️ 用 `fields`/`ids`（= props）：校验与写库读同一份，不许一处读 draft 一处读 resolved
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
 * 撤回（文案是「撤回」，代码标识符仍是 `reject`，§4.4.1）：**只发事件**。
 *
 * 本层不写任何东西（权限边界：卡只调 `transactionStore` 的读写，会话表由 `agent → session` 负责）。
 * 卡换成**静态「已撤回」**（§4.4.4）：它**留在消息流里**、摘要照旧、零按钮 —— 对应那笔钱
 * **从未入账**，所以这里既不 `add` 也不 `remove`。`state` 先落位，`emit` 后的落库与页面渲染
 * 由 `aiChat.rejectDraft` 完成（失败时页面用 `rollback` 把它弹回待确认）。
 */
function onReject(): void {
  state.value = "rejected";
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
         是自相矛盾的文案（本轮之前 saved 视图在页面里画不出来，所以看不出来）。
         已撤回卡写它自己的状态（§4.4.1 的四个可见形态：待确认 / 已记账 ✓ / **已撤回** / 已撤销回退）。 -->
    <p v-if="state === 'rejected'" class="mb-2 text-xs text-text-secondary" data-test="draft-rejected-text">
      已撤回
    </p>
    <p v-else-if="state !== 'saved' && state !== 'undoing'" class="mb-2 text-xs text-text-secondary">
      待确认的记账
    </p>
    <p class="text-sm font-medium text-text" data-test="draft-amount">
      {{ TYPE_LABEL[fields.type] }} {{ maskCurrency(fields.amount, hidden) }}
    </p>

    <!-- 摘要（§4.4.2 的字段清单，**全部只读**）：待确认卡与已撤回静态卡**共用这一份**——
         两张卡各写一份渲染就是"撤回过一次就少显示两个字段"这类缺陷的温床（§4.4.4「摘要不缩水」）。 -->
    <dl class="mt-1 space-y-0.5 text-xs text-text-secondary">
      <div v-if="fields.category" class="flex gap-1">
        <dt>分类</dt>
        <dd data-test="draft-category">{{ fields.category }}</dd>
      </div>
      <div v-if="displayFrom" class="flex gap-1">
        <dt>转出</dt>
        <dd data-test="draft-from">{{ displayFrom }}</dd>
      </div>
      <div v-if="displayTo" class="flex gap-1">
        <dt>转入</dt>
        <dd data-test="draft-to">{{ displayTo }}</dd>
      </div>
      <div class="flex gap-1">
        <dt>日期</dt>
        <dd data-test="draft-occurred-at">{{ fields.occurredAt }}</dd>
      </div>
      <div v-if="fields.note" class="flex gap-1">
        <dt>备注</dt>
        <dd data-test="draft-note">{{ fields.note }}</dd>
      </div>
      <!--
        标签芯片（§4.4.2）：草稿里存的是**名字**（`NormalizedDraft.tags`），照名字渲染成只读徽章。
        "有才显示"：空数组时整行（连「标签」这个 dt）都不渲染，不留空壳行。
        产品原则 tags 优先于备注 —— 标签必须和金额、账户一样看得见，用户才能确认"AI 打了什么标签"。
      -->
      <div v-if="fields.tags.length > 0" class="flex gap-1">
        <dt>标签</dt>
        <dd class="flex flex-wrap gap-1" data-test="draft-tags">
          <span
            v-for="tag in fields.tags"
            :key="tag"
            class="rounded-full bg-gray-100 px-2 py-0.5 text-text"
            data-test="draft-tag"
          >{{ tag }}</span>
        </dd>
      </div>
    </dl>
    <p v-if="error" class="mt-2 text-xs text-red-500" data-test="draft-error">{{ error }}</p>

    <!--
      三个动作（§4.4.3）：**待确认** ⇒ 确认记账 / 撤回；**已记账 ✓**（含撤销在途）⇒ 撤销；
      **已撤回** ⇒ 什么都不渲染（静态卡零按钮，§4.4.4：那张卡对应的钱**从未入账**）。
      卡上没有任何输入控件，也没有「修改」按钮 —— 要改就在对话里重说一句（重新出卡）。
    -->
    <div
      v-if="state === 'saved' || state === 'undoing'"
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
    <div v-else-if="state !== 'rejected'" class="mt-3 flex gap-2">
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
        <X :size="16" />撤回
      </button>
    </div>
  </div>
</template>
