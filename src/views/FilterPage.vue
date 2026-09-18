<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTagStore } from "@/stores/tag";
import { useCategoryStore } from "@/stores/category";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId, getTeamMembers, getMemberAliases } from "@/db/userDb";
import type { TeamMemberRow } from "@/db/userDb";
import { fetchTeamMembers } from "@/services/api";
import AppHeader from "@/components/AppHeader.vue";
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import MemberAvatar from "@/components/MemberAvatar.vue";
import DateRangePicker from "@/components/DateRangePicker.vue";
import { formatRangeLabel, type DateRange } from "@/utils/dateRange";
import type { Account, TagWithUsage } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const tagStore = useTagStore();
const categoryStore = useCategoryStore();
const auth = useAuthStore();

const selectedAccountId = ref("");
const selectedAccountName = ref("全部账户");
const dateFrom = ref("");
const dateTo = ref("");
const selectedTagIds = ref<string[]>([]);
const tagSearch = ref("");
const selectedCategoryIds = ref<string[]>([]);
const selectedMemberIds = ref<string[]>([]);
const selectedUncategorized = ref(false);
const teamMembers = ref<TeamMemberRow[]>([]);
const aliasMap = ref<Record<string, string>>({});
const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === "team");
const currentUserId = computed(() => auth.currentLocalUser?.server_user_id || getCurrentUserId() || "");

// 其他成员展示名：别名 > 昵称 > username > id 前 8 位
function memberDisplayName(m: TeamMemberRow): string {
  if (m.user_id === currentUserId.value) return "我";
  return aliasMap.value[m.user_id] || m.nickname || m.username || m.user_id.slice(0, 8);
}

const accountPickerVisible = ref(false);
const dateRangeVisible = ref(false);

// 日期范围已统一为 day 粒度（含首尾整天），store 对不带 "T" 的边界自行取整天
const dateRange = computed<DateRange>(() => ({ start: dateFrom.value, end: dateTo.value }));
const dateRangeLabel = computed(() => formatRangeLabel(dateFrom.value, dateTo.value));

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await Promise.all([
    accountStore.fetchAll(ledgerId),
    tagStore.fetchAll(ledgerId),
    categoryStore.fetchAll(ledgerId),
  ]);

  // 团队账本：拉取并缓存成员
  if (isTeamLedger.value && ledgerStore.currentLedger?.team_id) {
    const teamId = ledgerStore.currentLedger.team_id;
    try {
      const members = await fetchTeamMembers(teamId);
      const { upsertTeamMembers } = await import("@/db/userDb");
      await upsertTeamMembers(teamId, members);
    } catch (e) {
      console.warn("[FilterPage] fetchTeamMembers failed:", e);
    }
    teamMembers.value = await getTeamMembers(teamId);
  }

  // 加载别名缓存（用于成员展示名）
  const aliases = await getMemberAliases();
  aliasMap.value = Object.fromEntries(aliases.map((a) => [a.target_user_id, a.alias_name]));

  // 从 query 恢复筛选状态
  if (route.query.account) {
    selectedAccountId.value = route.query.account as string;
    const acc = accountStore.accounts.find((a) => a.id === selectedAccountId.value);
    if (acc) selectedAccountName.value = acc.name;
  }
  // 旧链接 / 报表下钻可能残留带时分的串，按新契约取日期部分（day 粒度）
  if (route.query.dateFrom) dateFrom.value = (route.query.dateFrom as string).split("T")[0];
  if (route.query.dateTo) dateTo.value = (route.query.dateTo as string).split("T")[0];
  if (route.query.tags) {
    selectedTagIds.value = (route.query.tags as string).split(",").filter(Boolean);
  }
  if (route.query.categories) {
    selectedCategoryIds.value = (route.query.categories as string).split(",").filter(Boolean);
  }
  if (route.query.members) {
    selectedMemberIds.value = (route.query.members as string).split(",").filter(Boolean);
  }
  if (route.query.uncategorized === "1") {
    selectedUncategorized.value = true;
  }
});

function onAccountSelect(acc: Account) {
  selectedAccountId.value = acc.id;
  selectedAccountName.value = acc.name;
  accountPickerVisible.value = false;
}

function onSelectAll() {
  selectedAccountId.value = "";
  selectedAccountName.value = "全部账户";
  accountPickerVisible.value = false;
}

function toggleTag(tagId: string) {
  const idx = selectedTagIds.value.indexOf(tagId);
  if (idx >= 0) {
    selectedTagIds.value.splice(idx, 1);
  } else {
    selectedTagIds.value.push(tagId);
  }
}

// 标签很多时靠搜索找；已选标签无论是否命中关键词都保持可见并置顶，否则筛掉后无法取消
const visibleTags = computed<TagWithUsage[]>(() => {
  const kw = tagSearch.value.trim().toLowerCase();
  const selected: TagWithUsage[] = [];
  const rest: TagWithUsage[] = [];
  for (const tag of tagStore.tags) {
    if (selectedTagIds.value.includes(tag.id)) {
      selected.push(tag);
    } else if (!kw || tag.name.toLowerCase().includes(kw)) {
      rest.push(tag);
    }
  }
  return [...selected, ...rest];
});

function clearTags() {
  selectedTagIds.value = [];
}

// 分类按 type 分组展示：sort_order 是各 type 内部自增的（见 categoryStore.add），
// 混在一个 flex-wrap 里必然出现"支出1 / 收入1 / 支出2"的交错。空组直接隐藏。
const categoryGroups = computed(() =>
  [
    { key: "expense", label: "支出", color: "text-expense", items: categoryStore.categories.filter((c) => c.type === "expense") },
    { key: "income", label: "收入", color: "text-income", items: categoryStore.categories.filter((c) => c.type === "income") },
  ].filter((g) => g.items.length > 0)
);

function toggleCategory(catId: string) {
  const idx = selectedCategoryIds.value.indexOf(catId);
  if (idx >= 0) {
    selectedCategoryIds.value.splice(idx, 1);
  } else {
    selectedCategoryIds.value.push(catId);
  }
}

function toggleMember(memberId: string) {
  const idx = selectedMemberIds.value.indexOf(memberId);
  if (idx >= 0) {
    selectedMemberIds.value.splice(idx, 1);
  } else {
    selectedMemberIds.value.push(memberId);
  }
}

function toggleUncategorized() {
  selectedUncategorized.value = !selectedUncategorized.value;
}

function apply() {
  const query: Record<string, string> = {};
  if (selectedAccountId.value) query.account = selectedAccountId.value;
  if (dateFrom.value) query.dateFrom = dateFrom.value;
  if (dateTo.value) query.dateTo = dateTo.value;
  if (selectedTagIds.value.length > 0) query.tags = selectedTagIds.value.join(",");
  if (selectedCategoryIds.value.length > 0) query.categories = selectedCategoryIds.value.join(",");
  if (selectedMemberIds.value.length > 0) query.members = selectedMemberIds.value.join(",");
  if (selectedUncategorized.value) query.uncategorized = "1";
  router.push({ path: "/", query });
}

function reset() {
  selectedAccountId.value = "";
  selectedAccountName.value = "全部账户";
  dateFrom.value = "";
  dateTo.value = "";
  selectedTagIds.value = [];
  selectedCategoryIds.value = [];
  selectedMemberIds.value = [];
  selectedUncategorized.value = false;
  tagSearch.value = "";
}

function onDateRangeConfirm(range: DateRange) {
  dateFrom.value = range.start;
  dateTo.value = range.end;
  dateRangeVisible.value = false;
}

function goBack() {
  router.back();
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="筛选" :show-back="true" @back="goBack" />

    <div class="flex-1 overflow-auto px-4 py-4">
      <!-- 账户 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📋 账户</label>
        <button
          class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          @click="accountPickerVisible = true"
        >
          <span class="flex items-center gap-2">
            <span
              v-if="selectedAccountId"
              class="h-2.5 w-2.5 shrink-0 rounded-full"
              :style="{ backgroundColor: accountStore.accounts.find(a => a.id === selectedAccountId)?.color || '#3b82f6' }"
            />
            {{ selectedAccountName }}
          </span>
          <span class="text-text-secondary">▽</span>
        </button>
      </div>

      <!-- 日期范围 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📅 日期范围</label>
        <button
          class="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary"
          data-test="date-range-trigger"
          @click="dateRangeVisible = true"
        >
          <span :class="dateRangeLabel ? 'text-text' : 'text-text-secondary'">
            {{ dateRangeLabel || '全部时间' }}
          </span>
          <span class="text-text-secondary">▽</span>
        </button>
      </div>

      <!-- 分类（多选，按收入/支出分组） -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">📂 分类</label>
        <div class="space-y-2">
          <div
            v-for="group in categoryGroups"
            :key="group.key"
            :data-test="`category-group-${group.key}`"
          >
            <p class="mb-1 text-[11px]" :class="group.color">{{ group.label }}</p>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="cat in group.items"
                :key="cat.id"
                data-test="category-chip"
                class="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs transition-colors"
                :class="selectedCategoryIds.includes(cat.id)
                  ? 'bg-primary text-white'
                  : 'bg-gray-100 text-text-secondary'"
                @click="toggleCategory(cat.id)"
              >
                <span>{{ selectedCategoryIds.includes(cat.id) ? '☑' : '☐' }}</span>
                <span>{{ cat.icon }}</span>
                <span>{{ cat.name }}</span>
              </button>
            </div>
          </div>
          <button
            data-test="uncategorized-chip"
            class="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="selectedUncategorized ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
            @click="toggleUncategorized"
          >{{ selectedUncategorized ? '☑' : '☐' }} 未分类</button>
          <p v-if="categoryStore.categories.length === 0" class="text-xs text-text-secondary">暂无分类</p>
        </div>
      </div>

      <!-- 成员（多选，仅团队账本） -->
      <div v-if="isTeamLedger" class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">👥 成员</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="m in teamMembers"
            :key="m.user_id"
            class="flex items-center gap-1 rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="selectedMemberIds.includes(m.user_id)
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'"
            @click="toggleMember(m.user_id)"
          >
            <span>{{ selectedMemberIds.includes(m.user_id) ? '☑' : '☐' }}</span>
            <MemberAvatar v-if="m.user_id !== currentUserId" :user-id="m.user_id" :size="16" />
            <span>{{ memberDisplayName(m) }}</span>
          </button>
          <p v-if="teamMembers.length === 0" class="text-xs text-text-secondary">暂无成员</p>
        </div>
      </div>

      <!-- 标签 -->
      <div class="mb-4">
        <div class="mb-1 flex items-center justify-between">
          <label class="block text-xs text-text-secondary">🏷️ 标签</label>
          <div
            v-if="selectedTagIds.length > 0"
            class="flex items-center gap-2 text-xs text-text-secondary"
          >
            <span>已选 {{ selectedTagIds.length }} 个</span>
            <button class="text-primary" @click="clearTags">清空</button>
          </div>
        </div>
        <input
          v-model="tagSearch"
          data-test="tag-search"
          type="text"
          placeholder="搜索标签"
          class="mb-2 w-full rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        />
        <div class="flex flex-wrap gap-2">
          <button
            v-for="tag in visibleTags"
            :key="tag.id"
            data-test="tag-chip"
            class="rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="selectedTagIds.includes(tag.id)
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'"
            @click="toggleTag(tag.id)"
          >
            {{ selectedTagIds.includes(tag.id) ? '☑' : '☐' }} {{ tag.name }}
          </button>
          <p v-if="tagStore.tags.length === 0" class="text-xs text-text-secondary">暂无标签</p>
          <p v-else-if="visibleTags.length === 0" class="text-xs text-text-secondary">未找到标签</p>
        </div>
      </div>

      <!-- 操作按钮 -->
      <div class="mt-8 space-y-3">
        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="apply"
        >
          应用筛选
        </button>
        <button
          class="w-full rounded-xl border border-gray-200 bg-surface py-3 text-center text-base text-text-secondary transition-colors hover:bg-gray-50"
          @click="reset"
        >
          重置
        </button>
      </div>
    </div>

    <!-- 账户选择 Sheet -->
    <AccountPickerSheet
      :visible="accountPickerVisible"
      :show-all-option="true"
      @close="accountPickerVisible = false"
      @select="onAccountSelect"
      @select-all="onSelectAll"
    />

    <!-- 日期范围选择器 -->
    <DateRangePicker
      :visible="dateRangeVisible"
      :model-value="dateRange"
      @confirm="onDateRangeConfirm"
      @close="dateRangeVisible = false"
    />
  </div>
</template>
