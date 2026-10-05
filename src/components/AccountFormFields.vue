<script setup lang="ts">
import { computed } from "vue";
import { Building2, CreditCard, Smartphone, Banknote, Wallet, Scale } from "lucide-vue-next";
import type { AccountType } from "@/types";
import { ACCOUNT_CATEGORY, ACCOUNT_TYPE_LABELS } from "@/types";

const props = defineProps<{
  name: string;
  categoryTab: "asset" | "liability";
  accountType: AccountType;
  initialBalance: string;
  creditLimit: string;
  repaymentDay: string;
  color: string;
  /**
   * 期初金额只读（账户已有流水时由 AccountEdit 传入）。
   *
   * 判据是「账户有没有流水」而不是「是不是编辑态」：没有流水的账户改期初只是
   * 修正一个刚填错的数字，锁死它等于逼用户删账户重建；有流水再改，已发生的
   * 报表会跟着变形。
   */
  initialBalanceLocked?: boolean;
}>();

const emit = defineEmits<{
  "update:name": [value: string];
  "update:categoryTab": [value: "asset" | "liability"];
  "update:accountType": [value: AccountType];
  "update:initialBalance": [value: string];
  "update:creditLimit": [value: string];
  "update:repaymentDay": [value: string];
  "update:color": [value: string];
}>();

const ASSET_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "cash", icon: Banknote },
  { type: "bank", icon: Building2 },
  { type: "digital", icon: Smartphone },
];

const LIABILITY_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "credit_card", icon: CreditCard },
  { type: "huabei", icon: Wallet },
  { type: "meituan_monthly", icon: Wallet },
  { type: "other_loan", icon: Scale },
];

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#64748b",
];

const isLiability = computed(() => ACCOUNT_CATEGORY[props.accountType] === "liability");

function switchCategory(tab: "asset" | "liability") {
  emit("update:categoryTab", tab);
  emit("update:accountType", tab === "asset" ? "bank" : "credit_card");
}

/**
 * readonly 只挡用户输入，挡不住程序化赋 value + 派发 input 事件。锁定态必须在
 * 处理器里吞掉事件：否则 AccountEdit 会拿着被改过的期初金额去提交/推同步。
 */
function onInitialBalanceInput(event: Event) {
  if (props.initialBalanceLocked) return;
  emit("update:initialBalance", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <!-- 名称 -->
  <label class="mb-1 block text-sm font-medium text-text">账户名称</label>
  <input
    :value="name"
    type="text"
    placeholder="如：招商储蓄卡"
    class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
    @input="emit('update:name', ($event.target as HTMLInputElement).value)"
  />

  <!-- 账户类型 Tab -->
  <div class="mb-3 flex rounded-lg bg-gray-100 p-0.5">
    <button
      class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
      :class="categoryTab === 'asset' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
      @click="switchCategory('asset')"
    >资产账户</button>
    <button
      class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
      :class="categoryTab === 'liability' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
      @click="switchCategory('liability')"
    >负债账户</button>
  </div>

  <!-- 资产类型 -->
  <div v-if="categoryTab === 'asset'" class="mb-4 grid grid-cols-3 gap-2">
    <button
      v-for="item in ASSET_TYPES"
      :key="item.type"
      class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
      :class="accountType === item.type ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
      @click="emit('update:accountType', item.type)"
    >
      <component :is="item.icon" :size="18" />
      <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
    </button>
  </div>

  <!-- 负债类型 -->
  <div v-if="categoryTab === 'liability'" class="mb-4 grid grid-cols-4 gap-2">
    <button
      v-for="item in LIABILITY_TYPES"
      :key="item.type"
      class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
      :class="accountType === item.type ? 'bg-primary text-white' : 'bg-gray-100 text-text-secondary'"
      @click="emit('update:accountType', item.type)"
    >
      <component :is="item.icon" :size="18" />
      <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
    </button>
  </div>

  <!-- 初始余额/欠款 -->
  <label class="mb-1 block text-sm font-medium text-text">
    {{ isLiability ? "初始欠款" : "初始余额" }}
  </label>
  <input
    :value="initialBalance"
    type="number"
    step="0.01"
    placeholder="0.00"
    :readonly="initialBalanceLocked"
    class="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none"
    :class="initialBalanceLocked
      ? 'mb-1 cursor-not-allowed bg-gray-50 text-text-secondary'
      : 'mb-4 text-text focus:border-primary'"
    @input="onInitialBalanceInput"
  />
  <p v-if="initialBalanceLocked" class="mb-4 text-xs text-text-secondary">
    该账户已有流水，期初金额不可再修改；余额变动请通过「记一笔」体现
  </p>

  <!-- 负债条件字段 -->
  <template v-if="isLiability">
    <label class="mb-1 block text-sm font-medium text-text">信用额度（选填）</label>
    <input
      :value="creditLimit"
      type="number"
      step="0.01"
      placeholder="如：50000"
      class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      @input="emit('update:creditLimit', ($event.target as HTMLInputElement).value)"
    />
    <label class="mb-1 block text-sm font-medium text-text">还款日（选填）</label>
    <input
      :value="repaymentDay"
      type="number"
      min="1"
      max="31"
      placeholder="如：15"
      class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
      @input="emit('update:repaymentDay', ($event.target as HTMLInputElement).value)"
    />
  </template>

  <!-- 颜色 -->
  <label class="mb-2 block text-sm font-medium text-text">颜色标记</label>
  <div class="mb-4 flex gap-2 py-0.5">
    <button
      v-for="c in COLORS"
      :key="c"
      class="h-8 w-8 rounded-full border-2 transition-transform"
      :class="color === c ? 'scale-110 border-gray-800' : 'border-transparent'"
      :style="{ backgroundColor: c }"
      @click="emit('update:color', c)"
    />
  </div>
</template>
