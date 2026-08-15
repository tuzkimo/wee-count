import { ref, computed } from "vue";
import { useRoute } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { evaluateExpression } from "@/utils/expression";
import { toLocalDatetimeString, utcToLocalDatetimeString } from "@/utils/datetime";
import type { Category, Tag, Transaction, TransactionType } from "@/types";

export function useTransactionForm() {
  const route = useRoute();
  const ledgerStore = useLedgerStore();
  const accountStore = useAccountStore();
  const categoryStore = useCategoryStore();
  const tagStore = useTagStore();
  const transactionStore = useTransactionStore();
  const auth = useAuthStore();

  const isEdit = computed(() => !!route.params.id);
  const editId = computed(() => route.params.id as string | undefined);

  // 表单状态
  const txType = ref<TransactionType>("expense");
  const categoryId = ref<string | null>(null);
  const fromAccountId = ref<string | null>(null);
  const toAccountId = ref<string | null>(null);
  const occurredAt = ref("");
  const expression = ref("");
  const selectedTagIds = ref<string[]>([]);
  const note = ref("");
  const saveError = ref("");
  const isSaving = ref(false);

  // 派生
  const filteredCategories = computed(() =>
    categoryStore.categories.filter((c) => c.type === txType.value)
  );
  const defaultCategoryId = computed(() => {
    const cats = [...filteredCategories.value].sort((a, b) => a.sort_order - b.sort_order);
    return cats[0]?.id ?? null;
  });
  const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
  const currentUserId = computed(() => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "");
  const availableAccounts = computed(() =>
    accountStore.accounts.filter((a) => {
      if (a.is_deleted) return false;
      if (isTeamLedger.value && a.owner_id !== currentUserId.value) return false;
      return true;
    })
  );
  const calcResult = computed(() => evaluateExpression(expression.value));
  const isValid = computed(() => calcResult.value !== null);
  const isOwner = computed(() => {
    if (!isEdit.value || !editId.value) return true;
    const tx = transactionStore.transactions.find((t) => t.id === editId.value);
    if (!tx) return true;
    const uid = auth.currentLocalUser?.server_user_id || getCurrentUserId();
    return tx.user_id === uid;
  });
  const selectedTags = computed(() =>
    selectedTagIds.value
      .map((id) => tagStore.tags.find((t) => t.id === id))
      .filter((t): t is Tag => t != null)
  );

  // handler
  function switchType(t: TransactionType) {
    txType.value = t;
    categoryId.value = defaultCategoryId.value;
  }
  function selectCategory(cat: Category) {
    categoryId.value = cat.id;
  }
  function onTagConfirm(tagIds: string[]) {
    selectedTagIds.value = tagIds;
  }
  function toggleTag(tagId: string) {
    const idx = selectedTagIds.value.indexOf(tagId);
    if (idx >= 0) selectedTagIds.value.splice(idx, 1);
    else selectedTagIds.value.push(tagId);
  }
  function getAccountName(id: string | null): string {
    if (!id) return "";
    return accountStore.accounts.find((a) => a.id === id)?.name ?? "";
  }
  function onKeypadInput(key: string) {
    if (key === "delete") {
      expression.value = expression.value.slice(0, -1);
    } else {
      const last = expression.value.slice(-1);
      if ((key === "+" || key === "-") && (last === "+" || last === "-")) {
        expression.value = expression.value.slice(0, -1) + key;
      } else if (key === "." && last === ".") {
        return;
      } else {
        expression.value += key;
      }
    }
  }

  // 编辑预填
  function prefill(tx: Transaction) {
    txType.value = tx.type;
    categoryId.value = tx.category_id;
    fromAccountId.value = tx.from_account_id;
    toAccountId.value = tx.to_account_id;
    occurredAt.value = utcToLocalDatetimeString(tx.occurred_at);
    expression.value = tx.amount.toString();
    selectedTagIds.value = tx.tags?.map((t) => t.id) ?? [];
    note.value = tx.note ?? "";
  }

  // 新增初始化
  function initNew() {
    occurredAt.value = toLocalDatetimeString(new Date());
    const qAccount = route.query.account as string | undefined;
    const defaultAcc = qAccount
      ? availableAccounts.value.find((a) => a.id === qAccount)
      : availableAccounts.value[0];
    if (defaultAcc) {
      fromAccountId.value = defaultAcc.id;
      toAccountId.value = defaultAcc.id;
    }
    categoryId.value = defaultCategoryId.value;
    note.value = "";
  }

  async function doSave(): Promise<boolean> {
    const ledgerId = ledgerStore.currentLedger?.id;
    if (!isOwner.value || !ledgerId || isSaving.value || !isValid.value) return false;

    saveError.value = "";
    const amt = calcResult.value!;

    if (txType.value !== "transfer" && !categoryId.value) {
      saveError.value = "请选择分类";
      return false;
    }
    if ((txType.value === "expense" || txType.value === "transfer") && !fromAccountId.value) {
      return false;
    }
    if ((txType.value === "income" || txType.value === "transfer") && !toAccountId.value) {
      return false;
    }

    isSaving.value = true;
    try {
      const data = {
        ledger_id: ledgerId,
        user_id: auth.currentLocalUser?.server_user_id || getCurrentUserId()!,
        type: txType.value,
        amount: amt,
        category_id: txType.value === "transfer" ? null : categoryId.value,
        from_account_id: txType.value === "expense" || txType.value === "transfer" ? fromAccountId.value : null,
        to_account_id: txType.value === "income" || txType.value === "transfer" ? toAccountId.value : null,
        occurred_at: new Date(occurredAt.value).toISOString(),
        tag_ids: selectedTagIds.value,
        note: note.value.trim() || null,
      };

      if (isEdit.value && editId.value) {
        await transactionStore.update(editId.value, data);
      } else {
        await transactionStore.add(data);
      }
      return true;
    } catch (e) {
      console.error("Save transaction failed:", e);
      return false;
    } finally {
      isSaving.value = false;
    }
  }

  return {
    txType, categoryId, fromAccountId, toAccountId, occurredAt, expression,
    selectedTagIds, note, saveError, isSaving,
    filteredCategories, defaultCategoryId, availableAccounts, calcResult, isValid, isOwner, selectedTags,
    isEdit, editId,
    switchType, selectCategory, onTagConfirm, toggleTag, getAccountName, onKeypadInput,
    doSave, prefill, initNew,
  };
}
