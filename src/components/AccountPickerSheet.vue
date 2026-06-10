<script setup lang="ts">
import { computed } from "vue";
import { X } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import type { Account } from "@/types";

defineProps<{
  visible: boolean;
  showAllOption?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  select: [account: Account];
  selectAll: [];
}>();

const accountStore = useAccountStore();

const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => !a.is_deleted)
);

function select(acc: Account) {
  emit("select", acc);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <Transition name="slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[60vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">选择账户</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="flex-1 overflow-auto">
          <button
            v-if="showAllOption"
            class="flex w-full items-center gap-3 px-2 py-3 text-sm transition-colors hover:bg-gray-50"
            @click="$emit('selectAll')"
          >
            <span class="flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-gray-300 text-[8px] text-white">✓</span>
            <span class="text-text">全部账户</span>
          </button>

          <button
            v-for="acc in availableAccounts"
            :key="acc.id"
            class="flex w-full items-center gap-3 px-2 py-3 text-sm transition-colors hover:bg-gray-50"
            @click="select(acc)"
          >
            <span
              class="h-3 w-3 shrink-0 rounded-full"
              :style="{ backgroundColor: acc.color || '#3b82f6' }"
            />
            <span class="text-text">{{ acc.name }}</span>
          </button>

          <div v-if="availableAccounts.length === 0" class="py-8 text-center text-sm text-text-secondary">
            暂无可用账户
          </div>
        </div>
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
