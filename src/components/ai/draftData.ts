// 草稿 → 记账参数的**纯**映射（`DraftCard.vue` 的实现细节，单独成文件是为了能被纯函数测试钉住）。
//
// 为什么要有这个文件：`DraftCard` 的映射一旦写错，表现是"记出了一笔脏账"——
// 挂载组件来断言"每个字段从哪来"既慢又只能看个大概。抽成纯函数后，每个字段的来源逐条可钉。
//
// 字段口径的**唯一**依据是既有记账路径 `useTransactionForm.doSave`
// （`src/composables/useTransactionForm.ts:156-173`）；这里逐条照抄，**不新增规则**。
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
 * `tools.ts:792` 生成草稿时已经拦过，且这里拿不到"名字不同但 id 相同"以外的信息）。
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
