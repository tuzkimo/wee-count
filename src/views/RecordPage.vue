<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
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
import type { Account, Category, Tag, TransactionType } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
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
const amount = ref("");
const selectedTagIds = ref<string[]>([]);

const tagSheetVisible = ref(false);
const deleteDialogVisible = ref(false);
const accountPickerVisible = ref(false);
const accountPickerTarget = ref<"from" | "to">("from");
const isSaving = ref(false);
const isReady = ref(false);

// 按类型过滤分类
const filteredCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === txType.value)
);

// 资产/负债账户（全部账户都可用于交易）
const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => !a.is_deleted)
);

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
      occurredAt.value = tx.occurred_at.slice(0, 16);
      amount.value = tx.amount.toString();
      selectedTagIds.value = tx.tags?.map((t) => t.id) ?? [];
    }
  } else {
    // 新增模式：默认当前时间，默认选中第一个账户
    const now = new Date();
    occurredAt.value = now.toISOString().slice(0, 16);
    if (availableAccounts.value.length > 0) {
      fromAccountId.value = availableAccounts.value[0].id;
      toAccountId.value = availableAccounts.value[0].id;
    }
  }

  isReady.value = true;
});

// 切换交易类型
function switchType(type: TransactionType) {
  txType.value = type;
  categoryId.value = null;
}

// 选择分类
function selectCategory(cat: Category) {
  categoryId.value = cat.id;
}

// 标签 Sheet 确认
function onTagConfirm(tagIds: string[]) {
  selectedTagIds.value = tagIds;
  tagSheetVisible.value = false;
}

// 已选标签对象列表
const selectedTags = computed(() =>
  selectedTagIds.value
    .map((id) => tagStore.tags.find((t) => t.id === id))
    .filter((t): t is Tag => t != null)
);

// 切换标签选中
function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx >= 0) {
    selectedTagIds.value.splice(idx, 1);
  } else {
    selectedTagIds.value.push(tagId);
  }
}

function getAccountName(id: string | null): string {
  if (!id) return "";
  return accountStore.accounts.find((a) => a.id === id)?.name ?? "";
}

// 账户选择
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

// 保存
async function save() {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isSaving.value) return;

  const amt = parseFloat(amount.value);
  if (!amt || amt <= 0) return;
  if (txType.value !== "transfer" && !categoryId.value) return;
  if (!fromAccountId.value) return;
  if (txType.value !== "expense" && !toAccountId.value) return;

  isSaving.value = true;
  try {
    const data = {
      ledger_id: ledgerId,
      user_id: "local-user-1",
      type: txType.value,
      amount: Math.round(amt * 100) / 100,
      category_id: txType.value === "transfer" ? null : categoryId.value,
      from_account_id: fromAccountId.value,
      to_account_id: txType.value === "income" || txType.value === "transfer" ? toAccountId.value : null,
      occurred_at: new Date(occurredAt.value).toISOString(),
      tag_ids: selectedTagIds.value,
    };

    if (isEdit.value && editId.value) {
      await transactionStore.update(editId.value, data);
    } else {
      await transactionStore.add(data);
    }

    router.replace("/transactions");
  } catch (e) {
    console.error("Save transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

// 删除
async function deleteTx() {
  if (!editId.value || isSaving.value) return;
  isSaving.value = true;
  try {
    await transactionStore.remove(editId.value);
    router.replace("/transactions");
  } catch (e) {
    console.error("Delete transaction failed:", e);
  } finally {
    isSaving.value = false;
  }
}

function goBack() {
  if (isEdit.value) {
    router.push("/transactions");
  } else {
    router.push("/");
  }
}

// 格式化金额显示
const amountDisplay = computed(() => {
  const v = parseFloat(amount.value);
  if (isNaN(v)) return "";
  return v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

const saveLabel = computed(() => (isEdit.value ? "保存" : "记一笔"));
</script>

<template>
  <div class="flex flex-1 flex-col bg-bg">
    <AppHeader
      :title="isEdit ? '编辑记录' : '记账'"
      :show-back="isEdit"
      @back="goBack"
    >
      <template v-if="isEdit" #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="deleteDialogVisible = true"
        >
          <Trash2 :size="18" class="text-expense" />
        </button>
      </template>
    </AppHeader>

    <div v-if="!isReady" class="flex flex-1 items-center justify-center">
      <p class="text-text-secondary">加载中...</p>
    </div>

    <div v-else class="flex-1 overflow-auto px-4 py-4">
      <!-- 类型切换 -->
      <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
        <button
          v-for="t in (['expense', 'income', 'transfer'] as TransactionType[])"
          :key="t"
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="txType === t ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="switchType(t)"
        >
          {{ t === 'expense' ? '支出' : t === 'income' ? '收入' : '转账' }}
        </button>
      </div>

      <!-- 分类网格（转账时隐藏） -->
      <div v-if="txType !== 'transfer'" class="mb-4">
        <div class="grid grid-cols-4 gap-2">
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
      </div>

      <!-- 账户选择器 -->
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

      <!-- 日期时间 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">日期时间</label>
        <input
          v-model="occurredAt"
          type="datetime-local"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />
      </div>

      <!-- 金额 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">金额</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-lg font-semibold text-text">¥</span>
          <input
            v-model="amount"
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            class="w-full rounded-lg border border-gray-200 bg-surface py-2.5 pl-8 pr-3 text-right text-lg font-semibold text-text outline-none focus:border-primary"
          />
        </div>
        <p v-if="amountDisplay" class="mt-1 text-right text-xs text-text-secondary">
          {{ amountDisplay }}
        </p>
      </div>

      <!-- 标签 -->
      <div class="mb-6">
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

    <!-- 保存按钮 -->
    <div v-if="isReady" class="bg-surface border-t border-gray-200 px-4 py-3">
      <button
        class="w-full rounded-xl py-3 text-center text-base font-semibold text-white transition-colors disabled:opacity-50"
        :class="txType === 'expense' ? 'bg-expense hover:bg-red-600' : txType === 'income' ? 'bg-income hover:bg-green-600' : 'bg-primary hover:bg-primary-dark'"
        :disabled="isSaving"
        @click="save"
      >
        {{ isSaving ? '保存中...' : saveLabel }}
      </button>
    </div>

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
  </div>
</template>
