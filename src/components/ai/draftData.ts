// 草稿 → 记账参数的**纯**映射（`DraftCard.vue` 的实现细节，单独成文件是为了能被纯函数测试钉住）。
//
// 为什么要有这个文件：`DraftCard` 的映射一旦写错，表现是"记出了一笔脏账"——
// 挂载组件来断言"每个字段从哪来"既慢又只能看个大概。抽成纯函数后，每个字段的来源逐条可钉。
//
// 字段口径的**唯一**依据是既有记账路径 `useTransactionForm.doSave`
// （`src/composables/useTransactionForm.ts:156-173`）；这里逐条照抄，**不新增规则**。
import { round2 } from "@/utils/transaction";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

/** `transactionStore.add` 的入参形状（照 `useTransactionForm.doSave` 的 `data`） */
export interface DraftTransactionData {
  ledger_id: string;
  user_id: string;
  type: AiDraftFields["type"];
  amount: number;
  category_id: string | null;
  from_account_id: string | null;
  to_account_id: string | null;
  occurred_at: string;
  tag_ids: string[];
  note: string | null;
}

/**
 * 本地 `"YYYY-MM-DDTHH:mm"` → UTC ISO（与 `useTransactionForm.doSave:164` 同一手法：
 * `new Date(本地串).toISOString()`）。
 *
 * ⚠️ 不转的后果是**静默一个时区**：草稿的 `occurredAt` 来自 `tools.ts` 的
 * `normalizeOccurredAt`，产出的是**不带 Z 的本地串**；而 `transactions.occurred_at` 的口径是
 * UTC ISO（读回来用 `utcToLocalDatetimeString` 解释）。直接把本地串写进去，东八区会整体偏移
 * 8 小时（"今天"的账记成昨天）。
 *
 * 已经是 ISO（带 Z 或毫秒）的串原样返回，不重复解释。
 */
export function normalizeOccurredAt(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(v)) return v;
  return new Date(v.includes("T") ? v : `${v}T00:00`).toISOString();
}

/**
 * 草稿 + 本地 id + 账本/用户 → `transactionStore.add` 的参数。
 *
 * - `category_id` 在转账时**强制 null**（照 `doSave` 的三元：转账没有分类）
 * - `from_account_id` 只在支出/转账时给；`to_account_id` 只在收入/转账时给
 *   （与 `doSave` 的两个 `type === ... ? : null` 逐字对应）
 * - `tag_ids` 用 `resolved.tagIds`（真 id，本地解析出来的；绝不上行）
 */
export function buildDraftData(
  draft: AiDraftFields,
  resolved: AiDraftIds,
  ledgerId: string,
  userId: string,
): DraftTransactionData {
  return {
    ledger_id: ledgerId,
    user_id: userId,
    type: draft.type,
    amount: draft.amount,
    category_id: draft.type === "transfer" ? null : resolved.categoryId,
    from_account_id:
      draft.type === "expense" || draft.type === "transfer" ? resolved.fromAccountId : null,
    to_account_id:
      draft.type === "income" || draft.type === "transfer" ? resolved.toAccountId : null,
    occurred_at: normalizeOccurredAt(draft.occurredAt),
    tag_ids: resolved.tagIds,
    note: draft.note,
  };
}

/**
 * 必填校验（照 `useTransactionForm.doSave:139-152` 的四条，去掉"转出≠转入"——那条在
 * `tools.ts:801` 生成草稿时已经拦过，且这里拿不到"名字不同但 id 相同"以外的信息）。
 *
 * 为什么要在这里也做一遍：`transactionStore.add` **不做**这些校验，缺 id 会**静默写进去**
 * （`category_id = null` 的支出、没有转出账户的转账）。草稿的 id 是模型给的名字解析出来的，
 * payload 又是 JSON（可能被改坏）⇒ 这一层不能假设它一定解析成功。
 * 返回空串 = 可以记账。
 */
export function validateDraft(draft: AiDraftFields, resolved: AiDraftIds): string {
  if (draft.type !== "transfer" && resolved.categoryId === null) return "这张草稿缺分类，不能记账";
  if ((draft.type === "expense" || draft.type === "transfer") && resolved.fromAccountId === null) {
    return "这张草稿缺转出账户，不能记账";
  }
  if ((draft.type === "income" || draft.type === "transfer") && resolved.toAccountId === null) {
    return "这张草稿缺转入账户，不能记账";
  }
  return "";
}

// ---------------------------------------------------------------------------
// §4.4 卡片内联可改（编辑区 → 草稿字段）
// ---------------------------------------------------------------------------

/**
 * 编辑区的**表单原始值**（`<input>` / `<select>` 给的都是字符串）。
 *
 * 拆成"表单字符串 → 草稿字段"的纯映射，理由与上面 `buildDraftData` 相同：模板里现算金额
 * （`Number(...)`、`round2`、`> 0`）就只能靠挂载组件去猜，而这三个规则恰恰是
 * `§4.4:162` / `§10.7` 点名"必须复用、不许新写一套"的东西。
 */
export interface DraftEditForm {
  amount: string;
  categoryId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  occurredAt: string;
  note: string;
}

/** 编辑区选中的 id 对应的**名字**（草稿存名字，id 是本地解析出来的；查不到给 null） */
export interface DraftEditNames {
  category: string | null;
  fromAccount: string | null;
  toAccount: string | null;
}

export type DraftEditResult =
  | { ok: true; draft: AiDraftFields; resolved: AiDraftIds }
  | { ok: false; error: string };

/**
 * 编辑区的金额 → 落库用的数字。`round2` 来自 `utils/transaction.ts`（`§4.4:162` 点名复用），
 * 非正数 / 不可解析一律 `null`（`§10.7` 点名的"金额 > 0"）。
 *
 * 空串**不必单独判**：`Number("")` 是 `0`、`Number("  ")` 也是 `0`，两者都落在 `<= 0` 上
 * （单独加一条 `text === ""` 是等价防御，按 Ruling 35 不留）。`isFinite` 不是等价的：
 * `Number("abc")` 是 `NaN`，而 `NaN <= 0` 是 **false** ⇒ 少了它就会返回 `NaN`。
 */
export function parseEditedAmount(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return round2(n);
}

/**
 * 编辑区 → 新草稿 + 新 id。**校验顺序**：金额 → 时间 → 账户/分类（`validateDraft`）→ 账户相同。
 *
 * 为什么"转出≠转入"要在这里补（`validateDraft` 里刻意没有）：`doSave:149` 有这条规则，而草稿
 * 的账户在**生成链路**上由 `tools.ts:801` 拦过 ⇒ 从前它不可达。内联编辑让**用户**能自己挑两个
 * 账户 ⇒ 这条规则第一次变得可达，不复用就会写出一笔"自己转给自己"的账。
 */
export function applyDraftEdit(
  base: AiDraftFields,
  baseIds: AiDraftIds,
  form: DraftEditForm,
  names: DraftEditNames,
): DraftEditResult {
  const amount = parseEditedAmount(form.amount);
  if (amount === null) return { ok: false, error: "金额要大于 0" };

  const occurredAt = form.occurredAt.trim();
  // 空时间会一路写进 `occurred_at`（add 不校验）⇒ 与必填账户同族的守卫，放在这里
  if (occurredAt === "") return { ok: false, error: "请选择时间" };

  const note = form.note.trim();
  const draft: AiDraftFields = {
    type: base.type,
    amount,
    category: base.type === "transfer" ? null : names.category,
    fromAccount: base.type === "expense" || base.type === "transfer" ? names.fromAccount : null,
    toAccount: base.type === "income" || base.type === "transfer" ? names.toAccount : null,
    occurredAt,
    note: note === "" ? null : note,
    tags: base.tags,
  };
  const resolved: AiDraftIds = {
    categoryId: base.type === "transfer" ? null : form.categoryId,
    fromAccountId:
      base.type === "expense" || base.type === "transfer" ? form.fromAccountId : null,
    toAccountId: base.type === "income" || base.type === "transfer" ? form.toAccountId : null,
    tagIds: baseIds.tagIds,
  };

  const invalid = validateDraft(draft, resolved);
  if (invalid !== "") return { ok: false, error: invalid };
  if (
    base.type === "transfer" &&
    form.fromAccountId !== null &&
    form.fromAccountId === form.toAccountId
  ) {
    return { ok: false, error: "转出和转入账户不能相同" };
  }
  return { ok: true, draft, resolved };
}
