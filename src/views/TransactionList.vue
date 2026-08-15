<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDown, Filter, Plus, Pencil, ListChecks, Trash2, Circle, CheckCircle } from "lucide-vue-next";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTagStore } from "@/stores/tag";
import { useCategoryStore } from "@/stores/category";
import { useTransactionStore } from "@/stores/transaction";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId, getTeamMembers, upsertTeamMembers } from "@/db/userDb";
import { useMemberInfo } from "@/composables/useMemberInfo";
import MemberAvatar from "@/components/MemberAvatar.vue";
import { fetchTeamMembers } from "@/services/api";
import AppHeader from "@/components/AppHeader.vue";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { formatDateRange } from "@/utils/datetime";
import { isDefaultCurrentMonth } from "@/utils/filter";
import { getTxIcon, getTxDescription, getTxCategoryName, formatAmount, transferFromUid, transferToUid, isCrossMemberTransfer, transferMemberIds, groupTransactionsByDate } from "@/utils/transaction";
import type { Transaction } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const tagStore = useTagStore();
const categoryStore = useCategoryStore();
const transactionStore = useTransactionStore();
const authStore = useAuthStore();

const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === 'team');

const { getMember } = useMemberInfo();
const memberDisplay = ref<Record<string, string>>({});

async function loadMemberDisplay(userIds: string[]) {
  const unique = [...new Set(userIds)];
  for (const uid of unique) {
    if (!memberDisplay.value[uid]) {
      const info = await getMember(uid);
      memberDisplay.value[uid] = info.displayName;
    }
  }
}

// 预加载每条流水涉及成员的展示名：记录创建者 + 跨成员转账的双方账户所属成员
async function loadTxMemberDisplay() {
  const ids = new Set<string>();
  for (const t of transactionStore.transactions) {
    if (t.user_id) ids.add(t.user_id);
    for (const mid of transferMemberIds(t)) ids.add(mid);
  }
  await loadMemberDisplay([...ids]);
}

const currentUserId = computed(() => authStore.currentLocalUser?.server_user_id || getCurrentUserId() || "");

function isTxOwner(tx: Transaction): boolean {
  return tx.user_id === currentUserId.value;
}

// query 中选中的成员 id（用于筛选摘要解析展示名）
const queryMemberIds = computed(() => {
  const q = route.query.members as string | undefined;
  return q ? q.split(",").filter(Boolean) : [];
});
watch(queryMemberIds, (ids) => { if (ids.length) loadMemberDisplay(ids); }, { immediate: true });

async function refreshTeamMembers() {
  memberDisplay.value = {};
  if (isTeamLedger.value && ledgerStore.currentLedger?.team_id) {
    const teamId = ledgerStore.currentLedger.team_id;
    try {
      const members = await fetchTeamMembers(teamId);
      await upsertTeamMembers(teamId, members);
    } catch (e) {
      console.warn("[TransactionList] fetchTeamMembers failed:", e);
    }
    // 预加载所有成员的展示名，供筛选摘要同步解析（避免短暂显示 id）
    const all = await getTeamMembers(teamId);
    await loadMemberDisplay(all.map((m) => m.user_id));
  }
}

const filterAccountId = ref<string>("");
const isLoading = ref(true);
const showLedgerSwitcher = ref(false);

// 多选模式（仅账户详情模式）
const isMultiSelectMode = ref(false);
const selectedTxIds = ref<Set<string>>(new Set());

function enterMultiSelectMode() {
  isMultiSelectMode.value = true;
  selectedTxIds.value = new Set();
}

function exitMultiSelectMode() {
  isMultiSelectMode.value = false;
  selectedTxIds.value = new Set();
}

function toggleTxSelection(txId: string) {
  const next = new Set(selectedTxIds.value);
  if (next.has(txId)) {
    next.delete(txId);
  } else {
    next.add(txId);
  }
  selectedTxIds.value = next;
}

const selectedCount = computed(() => selectedTxIds.value.size);

// 批量删除确认
const batchDeleteDialogVisible = ref(false);

async function doBatchDelete() {
  if (selectedCount.value === 0) return;
  await transactionStore.batchRemove([...selectedTxIds.value]);
  exitMultiSelectMode();
  batchDeleteDialogVisible.value = false;
  // batchRemove 内部 fetchAll 不带 accountId 过滤，需重新按当前账户过滤
  const ledgerId = ledgerStore.currentLedger?.id;
  if (ledgerId && accountId.value) {
    await transactionStore.fetchAll(ledgerId, { accountId: accountId.value });
    await accountStore.fetchAll(ledgerId);
  }
}

// 判断是否为账户详情模式
const isAccountMode = computed(() => !!route.params.id);
const accountId = computed(() => route.params.id as string | undefined);

// 是否「默认查当月」：与 buildFetchOpts 共用同一判定，供摘要栏显示与实际查询保持一致
const isDefaultMonth = computed(() => isDefaultCurrentMonth(isAccountMode.value, accountId.value, {
  account: route.query.account as string | undefined,
  dateFrom: route.query.dateFrom as string | undefined,
  dateTo: route.query.dateTo as string | undefined,
  tags: route.query.tags as string | undefined,
  categories: route.query.categories as string | undefined,
  members: route.query.members as string | undefined,
}));

// 当前账户信息
const currentAccount = computed(() => {
  if (!accountId.value) return null;
  return accountStore.accounts.find((a) => a.id === accountId.value) ?? null;
});

// 当前账户是否属于当前用户（团队账本中他人账户为只读）
const isAccountOwner = computed(() => {
  if (!isAccountMode.value || !currentAccount.value) return true;
  return currentAccount.value.owner_id === currentUserId.value;
});

// 使用 store 的 totalIncome / totalExpense
const totalIncome = computed(() => transactionStore.totalIncome);
const totalExpense = computed(() => transactionStore.totalExpense);
const totalBalance = computed(() => totalIncome.value - totalExpense.value);

function closeLedgerSwitcher() {
  showLedgerSwitcher.value = false;
}

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await accountStore.fetchAll(ledgerId);
  await tagStore.fetchAll(ledgerId);
  await categoryStore.fetchAll(ledgerId);

  // 刷新团队成员缓存（团队账本）
  await refreshTeamMembers();

  // 从 route params 判断模式
  if (isAccountMode.value && accountId.value) {
    filterAccountId.value = accountId.value;
  } else {
    // 从 query 读取筛选条件
    const qAccount = route.query.account as string | undefined;
    if (qAccount) filterAccountId.value = qAccount;
  }

  const opts = buildFetchOpts();
  await transactionStore.fetchAll(ledgerId, opts);
  await loadTxMemberDisplay();
  isLoading.value = false;

  // 点击外部关闭账本切换下拉
  document.addEventListener("click", closeLedgerSwitcher);
});

onUnmounted(() => {
  document.removeEventListener("click", closeLedgerSwitcher);
});

function switchLedger(id: string) {
  ledgerStore.setCurrentLedger(id);
  showLedgerSwitcher.value = false;
}

// 切换账本后重新加载数据
watch(
  () => ledgerStore.currentLedgerId,
  async (newId) => {
    if (!newId || isLoading.value) return;
    isLoading.value = true;
    filterAccountId.value = "";
    await accountStore.fetchAll(newId);
    await tagStore.fetchAll(newId);
    await categoryStore.fetchAll(newId);
    await refreshTeamMembers();
    await transactionStore.fetchAll(newId, buildFetchOpts());
    await loadTxMemberDisplay();
    isLoading.value = false;
  },
);

// 监听路由 query 变化，重新获取数据
watch(
  () => route.query,
  async () => {
    if (isLoading.value) return;
    const ledgerId = ledgerStore.currentLedger?.id;
    if (!ledgerId) { isLoading.value = false; return; }

    const qAccount = route.query.account as string | undefined;
    filterAccountId.value = qAccount || "";
    const opts = buildFetchOpts();
    await transactionStore.fetchAll(ledgerId, opts);
    await loadTxMemberDisplay();
    // 刷新账户余额
    await accountStore.fetchAll(ledgerId);
  }
);

// 在线同步完成后自动刷新
watch(
  () => authStore.syncVersion,
  async () => {
    const ledgerId = ledgerStore.currentLedger?.id;
    if (!ledgerId) return;
    await accountStore.fetchAll(ledgerId);
    await tagStore.fetchAll(ledgerId);
    await transactionStore.fetchAll(ledgerId, buildFetchOpts());
    await loadTxMemberDisplay();
  }
);

function buildFetchOpts() {
  const accId = isAccountMode.value ? accountId.value : (route.query.account as string | undefined);
  const qDateFrom = route.query.dateFrom as string | undefined;
  const qDateTo = route.query.dateTo as string | undefined;
  const qTags = route.query.tags as string | undefined;
  const qCategories = route.query.categories as string | undefined;
  const qMembers = route.query.members as string | undefined;
  const qUncategorized = route.query.uncategorized === "1" ? true : undefined;

  // 首页模式无任何筛选参数时，默认查当月
  let dateFrom = qDateFrom;
  let dateTo = qDateTo;
  if (isDefaultMonth.value) {
    const now = new Date();
    dateFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01T00:00`;
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    dateTo = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, "0")}-${String(lastDay.getDate()).padStart(2, "0")}T23:59`;
  }

  return {
    accountId: accId || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    tagIds: qTags ? qTags.split(",").filter(Boolean) : undefined,
    categoryIds: qCategories ? qCategories.split(",").filter(Boolean) : undefined,
    memberIds: qMembers ? qMembers.split(",").filter(Boolean) : undefined,
    uncategorized: qUncategorized,
  };
}

// 基于 query 参数生成筛选摘要文本（用于筛选状态栏）
const filterSummary = computed(() => {
  const parts: string[] = [];
  const q = route.query;

  // 日期范围：与 buildFetchOpts 的默认当月判定一致，否则显示「全部时间」而非误导成当月
  if (q.dateFrom || q.dateTo) {
    parts.push(`📅 ${formatDateRange(q.dateFrom as string, q.dateTo as string)}`);
  } else if (isDefaultMonth.value) {
    const now = new Date();
    parts.push(`📅 ${now.getFullYear()}年${now.getMonth() + 1}月`);
  } else {
    parts.push("📅 全部时间");
  }

  // 账户
  if (q.account) {
    const acc = accountStore.accounts.find((a) => a.id === q.account);
    parts.push(`📋 ${acc?.name ?? q.account}`);
  } else {
    parts.push("📋 全部账户");
  }

  // 分类筛选摘要
  if (q.categories) {
    const catIds = (q.categories as string).split(",").filter(Boolean);
    const catNames = catIds
      .map((id) => categoryStore.categories.find((c) => c.id === id)?.name)
      .filter(Boolean) as string[];
    const MAX_VISIBLE = 2;
    if (catNames.length <= MAX_VISIBLE) {
      parts.push(`📂 ${catNames.join(", ")}`);
    } else {
      parts.push(`📂 ${catNames.slice(0, MAX_VISIBLE).join(", ")}等${catNames.length}个分类`);
    }
  } else {
    parts.push("📂 全部分类");
  }

  // 成员筛选摘要（仅团队账本）
  if (isTeamLedger.value) {
    if (q.members) {
      const memIds = (q.members as string).split(",").filter(Boolean);
      const names = memIds
        .map((id) => memberDisplay.value[id] ?? id.slice(0, 8))
        .filter(Boolean);
      const MAX_VISIBLE = 2;
      if (names.length <= MAX_VISIBLE) {
        parts.push(`👥 ${names.join(", ")}`);
      } else {
        parts.push(`👥 ${names.slice(0, MAX_VISIBLE).join(", ")}等${names.length}个成员`);
      }
    } else {
      parts.push("👥 全部成员");
    }
  }

  // 标签（放最后）
  if (q.tags) {
    const tagIds = (q.tags as string).split(",").filter(Boolean);
    const tagNames = tagIds
      .map((id) => tagStore.tags.find((t) => t.id === id)?.name)
      .filter(Boolean) as string[];
    const MAX_VISIBLE = 2;
    if (tagNames.length <= MAX_VISIBLE) {
      parts.push(`🏷️ ${tagNames.join(", ")}`);
    } else {
      const visible = tagNames.slice(0, MAX_VISIBLE).join(", ");
      parts.push(`🏷️ ${visible}等${tagNames.length}个标签`);
    }
  } else {
    parts.push("🏷️ 全部标签");
  }

  return parts.join(" · ");
});

// 按日期分组
const groupedTransactions = computed(() => groupTransactionsByDate(transactionStore.transactions));

function goRecord(txId: string) {
  if (isAccountMode.value && accountId.value) {
    router.push(`/record/${txId}?account=${accountId.value}`);
  } else {
    router.push(`/record/${txId}`);
  }
}

function onTxClick(tx: Transaction) {
  if (isTeamLedger.value && !isTxOwner(tx)) {
    // 他人记录，不可编辑：不做任何跳转
    return;
  }
  goRecord(tx.id);
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <!-- Header：账户详情模式 -->
    <AppHeader
      v-if="isAccountMode"
      :title="isMultiSelectMode ? `已选 ${selectedCount} 项` : (currentAccount?.name ?? '账户')"
      show-back
      @back="isMultiSelectMode ? exitMultiSelectMode() : router.push('/accounts')"
    >
      <template #action>
        <!-- 多选模式下的操作 -->
        <template v-if="isMultiSelectMode">
          <button
            class="mr-2 text-sm font-medium text-text-secondary"
            @click="exitMultiSelectMode"
          >
            取消
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full"
            :class="selectedCount === 0 ? 'text-gray-300' : 'text-expense hover:bg-red-50'"
            :disabled="selectedCount === 0"
            @click="batchDeleteDialogVisible = true"
          >
            <Trash2 :size="18" />
          </button>
        </template>
        <!-- 正常模式 -->
        <template v-else>
          <button
            v-if="isAccountOwner"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="enterMultiSelectMode"
          >
            <ListChecks :size="18" class="text-text-secondary" />
          </button>
          <button
            v-if="isAccountOwner"
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="router.push(`/accounts/${accountId}/edit`)"
          >
            <Pencil :size="18" class="text-text-secondary" />
          </button>
        </template>
      </template>
    </AppHeader>

    <!-- Header：首页模式 -->
    <AppHeader v-else title="">
      <template #title>
        <div class="relative flex-1">
          <button
            class="flex items-center gap-1 text-lg font-semibold text-text"
            @click.stop="showLedgerSwitcher = !showLedgerSwitcher"
          >
            {{ ledgerStore.currentLedger?.type === 'team'
              ? (ledgerStore.currentLedger?.name || '团队') + '的账本'
              : (ledgerStore.currentLedger?.name || '我的账本') }}
            <ChevronDown
              :size="16"
              class="text-text-secondary transition-transform"
              :class="{ 'rotate-180': showLedgerSwitcher }"
            />
          </button>
          <div
            v-if="showLedgerSwitcher"
            class="absolute top-full left-0 mt-1 w-44 rounded-lg bg-surface shadow-lg border border-gray-200 z-50 overflow-hidden"
          >
            <button
              v-for="l in ledgerStore.ledgers"
              :key="l.id"
              class="flex w-full items-center gap-2 px-4 py-2.5 text-sm hover:bg-gray-50"
              :class="l.id === ledgerStore.currentLedgerId ? 'text-primary font-medium' : 'text-text'"
              @click.stop="switchLedger(l.id)"
            >
              <span class="truncate">{{ l.type === 'team' ? l.name + '的账本' : (l.name || '个人账本') }}</span>
              <span class="shrink-0 text-xs text-text-secondary">{{ l.type === 'team' ? '团队' : '个人' }}</span>
            </button>
          </div>
        </div>
      </template>
      <template #action>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="router.push({ path: '/filter', query: route.query })"
        >
          <Filter :size="18" class="text-text-secondary" />
        </button>
      </template>
    </AppHeader>

    <!-- 筛选状态栏（仅首页模式） -->
    <div
      v-if="!isAccountMode"
      class="shrink-0 flex items-center gap-1 overflow-x-auto border-b border-gray-100 bg-surface px-4 py-2"
      @click="router.push({ path: '/filter', query: route.query })"
    >
      <span class="whitespace-nowrap text-xs text-text-secondary">{{ filterSummary }}</span>
      <span class="text-[10px] text-gray-400">→</span>
    </div>

    <!-- 汇总卡片 -->
    <div class="shrink-0 bg-surface px-4 py-3">
      <!-- 首页模式：收入 / 支出 / 结余 -->
      <template v-if="!isAccountMode">
        <div class="flex gap-4">
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">收入</p>
            <p class="mt-1 text-lg font-bold text-income">
              ¥{{ totalIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">支出</p>
            <p class="mt-1 text-lg font-bold text-expense">
              -¥{{ totalExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
          <div class="flex-1 text-center">
            <p class="text-xs text-text-secondary">结余</p>
            <p
              class="mt-1 text-lg font-bold"
              :class="totalBalance >= 0 ? 'text-text' : 'text-expense'"
            >
              {{ totalBalance >= 0 ? '' : '-' }}¥{{ Math.abs(totalBalance).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
            </p>
          </div>
        </div>
      </template>

      <!-- 账户详情模式：当前余额 + 收入/支出合计（保持不变） -->
      <template v-else>
        <p class="text-xs text-text-secondary">当前余额</p>
        <p class="mt-0.5 text-2xl font-bold text-text">
          ¥{{ (currentAccount?.current_balance ?? 0).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
        </p>
        <div class="mt-2 flex gap-6 text-xs">
          <span class="text-text-secondary">
            收入 ¥{{ totalIncome.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
          </span>
          <span class="text-text-secondary">
            支出 ¥{{ totalExpense.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }}
          </span>
        </div>
      </template>
    </div>


    <!-- 流水列表 -->
    <div class="flex-1 min-h-0 overflow-auto px-4 py-3">
      <div v-if="isLoading" class="py-12 text-center text-text-secondary">
        加载中...
      </div>

      <div v-else-if="transactionStore.transactions.length === 0" class="py-12 text-center">
        <p class="text-4xl">📋</p>
        <p class="mt-3 text-text-secondary">暂无流水记录</p>
      </div>

      <template v-else>
        <div v-for="group in groupedTransactions" :key="group.date" class="mb-4">
          <p class="mb-2 text-xs font-medium text-text-secondary">{{ group.label }}</p>
          <div class="space-y-1.5">
            <button
              v-for="tx in group.transactions"
              :key="tx.id"
              class="flex w-full items-center gap-3 rounded-xl bg-surface px-3 py-3 text-left transition-colors"
              :class="isMultiSelectMode ? 'hover:bg-gray-50'
                : (isTeamLedger && !isTxOwner(tx)) ? 'opacity-60'
                : 'hover:bg-gray-50'"
              @click="isMultiSelectMode ? toggleTxSelection(tx.id) : onTxClick(tx)"
            >
              <!-- 多选模式：选择指示器 -->
              <template v-if="isMultiSelectMode">
                <CheckCircle
                  v-if="selectedTxIds.has(tx.id)"
                  :size="20"
                  class="text-primary"
                />
                <Circle
                  v-else
                  :size="20"
                  class="text-gray-300"
                />
              </template>
              <!-- 交易图标 -->
              <span class="text-xl">{{ getTxIcon(tx) }}</span>
              <div class="min-w-0 flex-1">
                <p class="text-sm font-medium text-text">{{ getTxCategoryName(tx) }}</p>
                <p class="text-xs text-text-secondary">{{ getTxDescription(tx) }}</p>
                <!-- 跨成员转账：标清 from → to 成员 -->
                <p
                  v-if="isTeamLedger && isCrossMemberTransfer(tx)"
                  class="flex items-center gap-1 text-[10px] text-text-secondary"
                >
                  <MemberAvatar :user-id="transferFromUid(tx)!" :size="14" />
                  {{ memberDisplay[transferFromUid(tx)!] ?? transferFromUid(tx)!.slice(0,8) }}
                  <span class="text-gray-400">→</span>
                  <MemberAvatar :user-id="transferToUid(tx)!" :size="14" />
                  {{ memberDisplay[transferToUid(tx)!] ?? transferToUid(tx)!.slice(0,8) }}
                </p>
                <!-- 普通流水/同人转账：显示创建者 -->
                <p
                  v-else-if="isTeamLedger && tx.user_id"
                  class="flex items-center gap-1 text-[10px] text-text-secondary"
                >
                  <MemberAvatar :user-id="tx.user_id" :size="14" />
                  {{ memberDisplay[tx.user_id] ?? tx.user_id.slice(0,8) }}
                </p>
                <p v-if="tx.tags && tx.tags.length > 0" class="mt-0.5 flex gap-1">
                  <span
                    v-for="tag in tx.tags"
                    :key="tag.id"
                    class="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] text-text-secondary"
                  >
                    🏷️ {{ tag.name }}
                  </span>
                </p>
                <p v-if="tx.note" class="mt-0.5 text-[11px] text-text-secondary truncate">
                  📝 {{ tx.note }}
                </p>
              </div>
              <span
                class="shrink-0 text-sm font-semibold"
                :class="tx.type === 'expense' ? 'text-expense' : tx.type === 'income' ? 'text-income' : 'text-text'"
              >
                {{ formatAmount(tx) }}
              </span>
            </button>
          </div>
        </div>
      </template>
    </div>

    <!-- FAB（多选模式下隐藏） -->
    <router-link
      v-if="!isMultiSelectMode && isAccountOwner"
      :to="isAccountMode ? `/record?account=${accountId}` : '/record'"
      class="fixed right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-primary text-white shadow-lg transition-transform hover:scale-105 active:scale-95"
      style="top: 75%"
    >
      <Plus :size="28" />
    </router-link>

    <!-- 批量删除确认 -->
    <ConfirmDialog
      :visible="batchDeleteDialogVisible"
      title="批量删除"
      :description="`确定删除选中的 ${selectedCount} 条流水吗？此操作不可撤销。`"
      confirm-text="删除"
      :danger="true"
      @confirm="doBatchDelete"
      @cancel="batchDeleteDialogVisible = false"
    />

  </div>
</template>
