<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useTagStore } from "@/stores/tag";
import AppHeader from "@/components/AppHeader.vue";
import AccountPickerSheet from "@/components/AccountPickerSheet.vue";
import DateTimeSheet from "@/components/DateTimeSheet.vue";
import type { Account } from "@/types";

const route = useRoute();
const router = useRouter();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const tagStore = useTagStore();

const selectedAccountId = ref("");
const selectedAccountName = ref("全部账户");
const dateFrom = ref("");
const dateTo = ref("");
const selectedTagIds = ref<string[]>([]);

const accountPickerVisible = ref(false);
const datePickerTarget = ref<"from" | "to">("from");
const datePickerVisible = ref(false);

onMounted(async () => {
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  await Promise.all([
    accountStore.fetchAll(ledgerId),
    tagStore.fetchAll(ledgerId),
  ]);

  // 从 query 恢复筛选状态
  if (route.query.account) {
    selectedAccountId.value = route.query.account as string;
    const acc = accountStore.accounts.find((a) => a.id === selectedAccountId.value);
    if (acc) selectedAccountName.value = acc.name;
  }
  if (route.query.dateFrom) dateFrom.value = route.query.dateFrom as string;
  if (route.query.dateTo) dateTo.value = route.query.dateTo as string;
  if (route.query.tags) {
    selectedTagIds.value = (route.query.tags as string).split(",").filter(Boolean);
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

function apply() {
  const query: Record<string, string> = {};
  if (selectedAccountId.value) query.account = selectedAccountId.value;
  if (dateFrom.value) query.dateFrom = dateFrom.value;
  if (dateTo.value) query.dateTo = dateTo.value;
  if (selectedTagIds.value.length > 0) query.tags = selectedTagIds.value.join(",");
  router.push({ path: "/", query });
}

function reset() {
  selectedAccountId.value = "";
  selectedAccountName.value = "全部账户";
  dateFrom.value = "";
  dateTo.value = "";
  selectedTagIds.value = [];
}

function goBack() {
  router.back();
}

function openDatePicker(target: "from" | "to") {
  datePickerTarget.value = target;
  datePickerVisible.value = true;
}

function onDateConfirm(val: string) {
  if (datePickerTarget.value === "from") {
    dateFrom.value = val;
  } else {
    dateTo.value = val;
  }
  datePickerVisible.value = false;
}

function formatDateDisplay(dateStr: string): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekDays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${month}月${day}日 ${weekDays[d.getDay()]}`;
}

const dateFromDisplay = computed(() => formatDateDisplay(dateFrom.value));
const dateToDisplay = computed(() => formatDateDisplay(dateTo.value));
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
        <div class="flex items-center gap-2">
          <button
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
            @click="openDatePicker('from')"
          >
            {{ dateFromDisplay || '开始日期' }}
          </button>
          <span class="text-text-secondary">─</span>
          <button
            class="flex-1 rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
            @click="openDatePicker('to')"
          >
            {{ dateToDisplay || '结束日期' }}
          </button>
        </div>
      </div>

      <!-- 标签 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">🏷️ 标签</label>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="tag in tagStore.tags"
            :key="tag.id"
            class="rounded-full px-3 py-1.5 text-xs transition-colors"
            :class="selectedTagIds.includes(tag.id)
              ? 'bg-primary text-white'
              : 'bg-gray-100 text-text-secondary'"
            @click="toggleTag(tag.id)"
          >
            {{ selectedTagIds.includes(tag.id) ? '☑' : '☐' }} {{ tag.name }}
          </button>
          <p v-if="tagStore.tags.length === 0" class="text-xs text-text-secondary">暂无标签</p>
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

    <!-- 日期选择 Sheet -->
    <DateTimeSheet
      :visible="datePickerVisible"
      :show-time="false"
      :date-time="datePickerTarget === 'from' ? dateFrom : dateTo"
      @close="datePickerVisible = false"
      @confirm="onDateConfirm"
    />
  </div>
</template>
