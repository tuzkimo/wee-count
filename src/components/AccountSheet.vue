<script setup lang="ts">
import { ref, watch } from "vue";
import { X } from "lucide-vue-next";
import type { AccountType } from "@/types";
import AccountFormFields from "@/components/AccountFormFields.vue";

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    data: {
      name: string;
      type: AccountType;
      initial_balance: number;
      credit_limit?: number;
      repayment_day?: number;
      color: string;
    }
  ];
}>();

const name = ref("");
const categoryTab = ref<"asset" | "liability">("asset");
const accountType = ref<AccountType>("bank");
const initialBalance = ref("0");
const creditLimit = ref("");
const repaymentDay = ref("");
const color = ref("#3b82f6");

// 重置表单
watch(() => props.visible, (v) => {
  if (v) {
    name.value = "";
    categoryTab.value = "asset";
    accountType.value = "bank";
    initialBalance.value = "0";
    creditLimit.value = "";
    repaymentDay.value = "";
    color.value = "#3b82f6";
  }
});

function handleSubmit() {
  if (!name.value.trim()) return;
  emit("submit", {
    name: name.value.trim(),
    type: accountType.value,
    initial_balance: parseFloat(initialBalance.value) || 0,
    color: color.value,
    credit_limit: creditLimit.value ? parseFloat(creditLimit.value) : undefined,
    repayment_day: repaymentDay.value ? parseInt(repaymentDay.value, 10) : undefined,
  });
  emit("close");
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <!-- 面板 -->
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">添加账户</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <AccountFormFields
          v-model:name="name"
          v-model:category-tab="categoryTab"
          v-model:account-type="accountType"
          v-model:initial-balance="initialBalance"
          v-model:credit-limit="creditLimit"
          v-model:repayment-day="repaymentDay"
          v-model:color="color"
        />

        <!-- 提交 -->
        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
          :disabled="!name.trim()"
          @click="handleSubmit"
        >
          添加
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
