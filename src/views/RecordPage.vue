<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDown, Trash2 } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import TagSheet from "@/components/TagSheet.vue";
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import CalculatorKeypad from "@/components/CalculatorKeypad.vue";
import DateTimePicker from "@/components/DateTimePicker.vue";
import CategorySheet from "@/components/CategorySheet.vue";
import { toLocalDatetimeString, utcToLocalDatetimeString } from "@/utils/datetime";
import { getCurrentUserId } from "@/db/userDb";
import { useAuthStore } from "@/stores/auth";
import type { Account, Category, Tag, TransactionType } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();
const accountStore = useAccountStore();
const categoryStore = useCategoryStore();
const tagStore = useTagStore();
const transactionStore = useTransactionStore();

const isEdit = computed(() => !!route.params.id);
const editId = computed(() => route.params.id as string | undefined);

// 表单状态
const txType = ref<TransactionType>("expense");
const categoryId = ref<string | null>(null);
const fromAccountId = ref<string | null>(null);
const toAccountId = ref<string | null>(null);
const occurredAt = ref("");
const expression = ref(""); // 表达式原文
const selectedTagIds = ref<string[]>([]);

const tagSheetVisible = ref(false);
const deleteDialogVisible = ref(false);
const accountPickerVisible = ref(false);
const accountPickerTarget = ref<"from" | "to">("from");
const categorySheetVisible = ref(false);
const saveError = ref("");
const isSaving = ref(false);
const isReady = ref(false);
const datePickerVisible = ref(false);

// 按类型过滤分类
const filteredCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === txType.value)
);

// 按 sort_order 排序，找出默认分类
const defaultCategoryId = computed(() => {
  const cats = [...filteredCategories.value].sort((a, b) => a.sort_order - b.sort_order);
  return cats[0]?.id ?? null;
});

// 可用账户
const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => !a.is_deleted)
);

// 表达式求值结果
const calcResult = computed<number | null>(() => {
  const expr = expression.value.trim();
  if (!expr || /[+\-.]$/.test(expr)) return null;
  // 安全求值：只允许数字、+、-、.
  if (!/^[\d.\-+]+$/.test(expr)) return null;
  try {
    // 用 Function 安全求值
    const result = new Function(`return (${expr})`)() as number;
    if (isNaN(result) || result <= 0) return null;
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
});

const isValid = computed(() => calcResult.value !== null);

const isOwner = computed(() => {
  if (!isEdit.value || !editId.value) return true;
  const tx = transactionStore.transactions.find((t) => t.id === editId.value);
  if (!tx) return true;
  const currentUserId = auth.currentLocalUser?.server_user_id || getCurrentUserId();
  return tx.user_id === currentUserId;
});

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await Promise.all([
    accountStore.fetchAll(ledgerId),
    categoryStore.fetchAll(ledgerId),
    tagStore.fetchAll(ledgerId),
  ]);

  // 编辑模式：预填数据
  if (isEdit.value && editId.value) {
    await transactionStore.fetchAll(ledgerId);
    const tx = transactionStore.transactions.find((t) => t.id === editId.value);
    if (tx) {
      txType.value = tx.type;
      categoryId.value = tx.category_id;
      fromAccountId.value = tx.from_account_id;
      toAccountId.value = tx.to_account_id;
      occurredAt.value = utcToLocalDatetimeString(tx.occurred_at);
      expression.value = tx.amount.toString();
      selectedTagIds.value = tx.tags?.map((t) => t.id) ?? [];
    }
  } else {
    // 新增模式：默认当前本地时间
    occurredAt.value = toLocalDatetimeString(new Date());
    // 从 query 读取默认账户
    const qAccount = route.query.account as string | undefined;
    const defaultAcc = qAccount
      ? availableAccounts.value.find((a) => a.id === qAccount)
      : availableAccounts.value[0];
    if (defaultAcc) {
      fromAccountId.value = defaultAcc.id;
      toAccountId.value = defaultAcc.id;
    }
    // 默认分类
    categoryId.value = defaultCategoryId.value;
  }

  isReady.value = true;
});

// 切换交易类型时重置分类
watch(txType, () => {
  categoryId.value = defaultCategoryId.value;
});

// 分类选择
function selectCategory(cat: Category) {
  categoryId.value = cat.id;
}

// 标签
function onTagConfirm(tagIds: string[]) {
  selectedTagIds.value = tagIds;
  tagSheetVisible.value = false;
}

const selectedTags = computed(() =>
  selectedTagIds.value
    .map((id) => tagStore.tags.find((t) => t.id === id))
    .filter((t): t is Tag => t != null)
);

function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx >= 0) {
    selectedTagIds.value.splice(idx, 1);
  } else {
    selectedTagIds.value.push(tagId);
  }
}

// 账户相关
function getAccountName(id: string | null): string {
  if (!id) return "";
  return accountStore.accounts.find((a) => a.id === id)?.name ?? "";
}

function openAccountPicker(target: "from" | "to") {
  accountPickerTarget.value = target;
  accountPickerVisible.value = true;
}

function onAccountSelect(acc: Account) {
  if (accountPickerTarget.value === "from") {
    fromAccountId.value = acc.id;
  } else {
    toAccountId.value = acc.id;
  }
  accountPickerVisible.value = false;
}

// 键盘输入处理
function onKeypadInput(key: string) {
  if (key === "delete") {
    expression.value = expression.value.slice(0, -1);
  } else {
    // 防止连续两个运算符
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

// 保存逻辑
async function doSave(): Promise<boolean> {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!isOwner.value || !ledgerId || isSaving.value || !isValid.value) return false;

  saveError.value = "";
  const amt = calcResult.value!;

  // 基础校验
  if (txType.value !== "transfer" && !categoryId.value) {
    saveError.value = "请选择分类";
    return false;
  }
  if (!fromAccountId.value) return false;
  if (txType.value !== "expense" && !toAccountId.value) return false;

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

async function onDone() {
  const ok = await doSave();
  if (ok) {
    // 从账户详情页进入时，返回该账户详情页
    const qAccount = route.query.account as string | undefined;
    if (qAccount) {
      router.replace(`/accounts/${qAccount}`);
    } else {
      router.replace("/");
    }
  }
}

async function onSaveNext() {
  const ok = await doSave();
  if (ok) {
    // 重置表单
    expression.value = "";
    selectedTagIds.value = [];
    categoryId.value = defaultCategoryId.value;
    occurredAt.value = toLocalDatetimeString(new Date());
    // 保留账户和标签
  }
}

// 删除
async function deleteTx() {
  if (!editId.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await transactionStore.remove(editId.value);
    // 从账户详情页进入时，删除后返回该账户详情页
    const qAccount = route.query.account as string | undefined;
    if (qAccount) {
      router.replace(`/accounts/${qAccount}`);
    } else {
      router.replace("/");
    }
  } catch (e) {
    console.error("Delete transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

function onDateTimeConfirm(value: string) {
  occurredAt.value = value;
  datePickerVisible.value = false;
}

function goBack() {
  router.back();
}

</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader
      :title="isEdit ? '编辑记录' : '记账'"
      :show-back="true"
      @back="goBack"
    >
      <template v-if="isEdit" #action>
        <button
          v-if="isOwner"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="deleteDialogVisible = true"
        >
          <Trash2 :size="18" class="text-expense" />
        </button>
        <span v-else class="text-xs text-text-secondary">他人记录</span>
      </template>
    </AppHeader>

    <div v-if="!isReady" class="flex flex-1 items-center justify-center">
      <p class="text-text-secondary">加载中...</p>
    </div>

    <div v-else class="flex-1 min-h-0 overflow-auto px-4 py-4">
      <!-- 1. 类型切换 -->
      <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
        <button
          v-for="t in (['expense', 'income', 'transfer'] as TransactionType[])"
          :key="t"
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="txType === t ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="txType = t"
        >
          {{ t === 'expense' ? '支出' : t === 'income' ? '收入' : '转账' }}
        </button>
      </div>

      <!-- 2. 金额 (表达式输入) -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">金额</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-lg font-semibold text-text">¥</span>
          <div
            class="w-full rounded-lg border border-gray-200 bg-surface py-2.5 pl-8 pr-3 text-right text-lg font-semibold text-text outline-none focus:border-primary"
          >
            <span v-if="expression">{{ expression }}</span>
            <span v-else class="text-gray-300">0</span>
          </div>
        </div>
        <p v-if="calcResult !== null" class="mt-1 text-right text-xs text-text-secondary">
          = {{ calcResult.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </p>
      </div>

      <!-- 3. 分类网格（转账时隐藏） -->
      <div v-if="txType !== 'transfer'" class="mb-4">
        <div class="mb-2 flex items-center justify-between">
          <label class="text-xs text-text-secondary">分类</label>
          <button
            class="text-xs text-primary hover:underline"
            @click="categorySheetVisible = true"
          >管理</button>
        </div>
        <div
          v-if="filteredCategories.length === 0"
          class="rounded-lg bg-gray-50 py-8 text-center text-sm text-text-secondary"
        >
          暂无分类，点击<button class="text-primary underline" @click="categorySheetVisible = true">管理</button>添加
        </div>
        <div v-else class="grid grid-cols-4 gap-2">
          <button
            v-for="cat in filteredCategories"
            :key="cat.id"
            class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
            :class="categoryId === cat.id ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
            @click="selectCategory(cat)"
          >
            <span class="text-lg">{{ cat.icon }}</span>
            <span>{{ cat.name }}</span>
          </button>
        </div>
        <p v-if="saveError" class="mb-2 text-sm text-expense">{{ saveError }}</p>
      </div>

      <!-- 4. 账户 -->
      <div class="mb-4 space-y-2">
        <div v-if="txType === 'transfer'" class="space-y-2">
          <div>
            <label class="mb-1 block text-xs text-text-secondary">转出账户</label>
            <button
              class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
              @click="openAccountPicker('from')"
            >
              <span class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :style="{ backgroundColor: availableAccounts.find(a => a.id === fromAccountId)?.color || '#ccc' }"
                />
                {{ getAccountName(fromAccountId) || '请选择' }}
              </span>
              <ChevronDown :size="14" class="text-text-secondary" />
            </button>
          </div>
          <div class="flex justify-center text-text-secondary">
            <ChevronDown :size="16" />
          </div>
          <div>
            <label class="mb-1 block text-xs text-text-secondary">转入账户</label>
            <button
              class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
              @click="openAccountPicker('to')"
            >
              <span class="flex items-center gap-2">
                <span
                  class="h-2.5 w-2.5 shrink-0 rounded-full"
                  :style="{ backgroundColor: availableAccounts.find(a => a.id === toAccountId)?.color || '#ccc' }"
                />
                {{ getAccountName(toAccountId) || '请选择' }}
              </span>
              <ChevronDown :size="14" class="text-text-secondary" />
            </button>
          </div>
        </div>
        <div v-else>
          <label class="mb-1 block text-xs text-text-secondary">
            {{ txType === 'expense' ? '扣款账户' : '入账账户' }}
          </label>
          <button
            class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            @click="openAccountPicker(txType === 'expense' ? 'from' : 'to')"
          >
            <span class="flex items-center gap-2">
              <span
                class="h-2.5 w-2.5 shrink-0 rounded-full"
                :style="{ backgroundColor: availableAccounts.find(a => a.id === (txType === 'expense' ? fromAccountId : toAccountId))?.color || '#ccc' }"
              />
              {{ getAccountName(txType === 'expense' ? fromAccountId : toAccountId) || '请选择' }}
            </span>
            <ChevronDown :size="14" class="text-text-secondary" />
          </button>
        </div>
      </div>

      <!-- 5. 日期时间 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">日期时间</label>
        <button
          class="flex w-full items-center gap-2 rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          @click="datePickerVisible = true"
        >
          <span>📅</span>
          <span>{{ occurredAt }}</span>
        </button>
      </div>

      <!-- 6. 标签 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">标签</label>
        <div class="flex flex-wrap gap-1.5">
          <span
            v-for="tag in selectedTags"
            :key="tag.id"
            class="inline-flex items-center gap-0.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
          >
            🏷️ {{ tag.name }}
            <button class="ml-0.5 text-primary/60 hover:text-primary" @click="toggleTag(tag.id)">×</button>
          </span>
          <button
            class="inline-flex items-center gap-0.5 rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-xs text-text-secondary hover:border-primary hover:text-primary"
            @click="tagSheetVisible = true"
          >
            + 添加标签
          </button>
        </div>
      </div>
    </div>

    <!-- 自定义键盘 -->
    <CalculatorKeypad
      v-if="isReady"
      :expression="expression"
      :result="calcResult"
      :is-valid="isValid"
      @input="onKeypadInput"
      @done="onDone"
      @save-next="onSaveNext"
    />

    <!-- 标签选择 Sheet -->
    <TagSheet
      :visible="tagSheetVisible"
      :selected-ids="selectedTagIds"
      @close="tagSheetVisible = false"
      @confirm="onTagConfirm"
    />

    <!-- 账户选择 Sheet -->
    <AccountPickerSheet
      :visible="accountPickerVisible"
      @close="accountPickerVisible = false"
      @select="onAccountSelect"
    />

    <!-- 删除确认 -->
    <ConfirmDialog
      :visible="deleteDialogVisible"
      title="删除记录"
      description="确定要删除这条记录吗？此操作不可撤销。"
      confirm-text="删除"
      :danger="true"
      @confirm="deleteTx"
      @cancel="deleteDialogVisible = false"
    />

    <!-- 日期时间选择器 -->
    <DateTimePicker
      :visible="datePickerVisible"
      :model-value="occurredAt"
      @confirm="onDateTimeConfirm"
      @close="datePickerVisible = false"
    />

    <!-- 分类管理 Sheet -->
    <CategorySheet
      :visible="categorySheetVisible"
      :initial-tab="txType === 'transfer' ? 'expense' : txType"
      @close="categorySheetVisible = false"
    />
  </div>
</template>
