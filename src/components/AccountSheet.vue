<script setup lang="ts">
import { ref, watch } from "vue";
import { X, Building2, CreditCard, Smartphone, Scale } from "lucide-vue-next";
import type { Account, AccountType } from "@/types";
import { ACCOUNT_TYPE_LABELS } from "@/types";

const props = defineProps<{
  visible: boolean;
  editAccount?: Account | null; // null = 新增模式, Account = 编辑模式
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    data: {
      name: string;
      type: AccountType;
      initial_balance: number;
      color: string;
    }
  ];
}>();

const name = ref("");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const color = ref("#3b82f6");

const ACCOUNT_TYPES: { type: AccountType; icon: typeof Building2 }[] = [
  { type: "bank", icon: Building2 },
  { type: "credit_card", icon: CreditCard },
  { type: "digital", icon: Smartphone },
  { type: "debt", icon: Scale },
];

const COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#64748b",
];

// 编辑模式下预填
watch(
  () => [props.visible, props.editAccount] as const,
  ([v, acc]) => {
    if (v) {
      if (acc) {
        name.value = acc.name;
        accountType.value = acc.type;
        initialBalance.value = String(acc.initial_balance);
        color.value = acc.color;
      } else {
        name.value = "";
        accountType.value = "bank";
        initialBalance.value = "0";
        color.value = "#3b82f6";
      }
    }
  }
);

function handleSubmit() {
  if (!name.value.trim()) return;
  emit("submit", {
    name: name.value.trim(),
    type: accountType.value,
    initial_balance: parseFloat(initialBalance.value) || 0,
    color: color.value,
  });
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
    <Transition name="fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <!-- 面板 -->
    <Transition name="slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">
            {{ editAccount ? "编辑账户" : "添加账户" }}
          </h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <!-- 名称 -->
        <label class="mb-1 block text-sm font-medium text-text">账户名称</label>
        <input
          v-model="name"
          type="text"
          placeholder="如：招商储蓄卡"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

        <!-- 类型选择 -->
        <label class="mb-2 block text-sm font-medium text-text">账户类型</label>
        <div class="mb-4 grid grid-cols-4 gap-2">
          <button
            v-for="item in ACCOUNT_TYPES"
            :key="item.type"
            class="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2.5 text-xs transition-colors"
            :class="
              accountType === item.type
                ? 'bg-primary text-white'
                : 'bg-gray-100 text-text-secondary'
            "
            @click="accountType = item.type"
          >
            <component :is="item.icon" :size="18" />
            <span>{{ ACCOUNT_TYPE_LABELS[item.type] }}</span>
          </button>
        </div>

        <!-- 初始余额 -->
        <label class="mb-1 block text-sm font-medium text-text">初始余额</label>
        <input
          v-model="initialBalance"
          type="number"
          step="0.01"
          class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

        <!-- 颜色选择 -->
        <label class="mb-2 block text-sm font-medium text-text">颜色标记</label>
        <div class="mb-4 flex gap-2">
          <button
            v-for="c in COLORS"
            :key="c"
            class="h-8 w-8 rounded-full border-2 transition-transform"
            :class="color === c ? 'scale-110 border-gray-800' : 'border-transparent'"
            :style="{ backgroundColor: c }"
            @click="color = c"
          />
        </div>

        <!-- 提交 -->
        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          :disabled="!name.trim()"
          @click="handleSubmit"
        >
          {{ editAccount ? "保存" : "添加" }}
        </button>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition: transform 0.25s ease;
}
.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
