<script setup lang="ts">
import { ref, watch } from "vue";
import { X } from "lucide-vue-next";

const props = defineProps<{
  visible: boolean;
  dateTime: string; // ISO datetime-local format "YYYY-MM-DDTHH:mm"
}>();

const emit = defineEmits<{
  close: [];
  confirm: [value: string];
}>();

const localDate = ref("");
const localTime = ref("");

watch(
  () => props.dateTime,
  (val) => {
    if (val) {
      localDate.value = val.slice(0, 10);
      localTime.value = val.slice(11, 16);
    }
  },
  { immediate: true }
);

function confirm() {
  if (localDate.value && localTime.value) {
    emit("confirm", `${localDate.value}T${localTime.value}`);
  }
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
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">选择日期时间</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="mb-4">
          <label class="mb-1 block text-xs text-text-secondary">日期</label>
          <input
            v-model="localDate"
            type="date"
            class="w-full rounded-lg border border-gray-200 bg-bg px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
        </div>

        <div class="mb-6">
          <label class="mb-1 block text-xs text-text-secondary">时间</label>
          <input
            v-model="localTime"
            type="time"
            class="w-full rounded-lg border border-gray-200 bg-bg px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
        </div>

        <button
          class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="confirm"
        >
          确定
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
