<script setup lang="ts">
import { Check, X } from "lucide-vue-next";
import type { Ledger } from "@/types";

const props = defineProps<{
  visible: boolean;
  ledgers: Ledger[];
  selectedId?: string | null;
}>();

const emit = defineEmits<{
  close: [];
  select: [ledger: Ledger];
}>();

function select(ledger: Ledger) {
  emit("select", ledger);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[60vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">选择团队账本</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="flex-1 overflow-auto">
          <button
            v-for="l in ledgers"
            :key="l.id"
            class="flex w-full items-center gap-3 px-2 py-3 text-left transition-colors hover:bg-gray-50"
            @click="select(l)"
          >
            <span class="flex h-5 w-5 shrink-0 items-center justify-center">
              <Check
                v-if="l.id === props.selectedId"
                :size="18"
                class="text-primary"
              />
            </span>
            <span class="text-sm text-text">{{ l.name }}的账本</span>
          </button>

          <div v-if="ledgers.length === 0" class="py-8 text-center text-sm text-text-secondary">
            暂无团队账本
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
