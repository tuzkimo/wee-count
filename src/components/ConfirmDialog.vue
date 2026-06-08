<script setup lang="ts">
defineProps<{
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}>();

defineEmits<{
  confirm: [];
  cancel: [];
}>();
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
        @click.self="$emit('cancel')"
      >
        <Transition name="scale">
          <div
            v-if="visible"
            class="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-xl"
          >
            <h3 class="text-base font-semibold text-text">{{ title }}</h3>
            <p v-if="description" class="mt-2 text-sm text-text-secondary">
              {{ description }}
            </p>
            <div class="mt-6 flex gap-3">
              <button
                class="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
                @click="$emit('cancel')"
              >
                {{ cancelText || "取消" }}
              </button>
              <button
                class="flex-1 rounded-xl py-2.5 text-sm font-medium text-white transition-colors"
                :class="danger ? 'bg-expense hover:bg-red-600' : 'bg-primary hover:bg-primary-dark'"
                @click="$emit('confirm')"
              >
                {{ confirmText || "确认" }}
              </button>
            </div>
          </div>
        </Transition>
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

.scale-enter-active,
.scale-leave-active {
  transition: all 0.2s ease;
}
.scale-enter-from,
.scale-leave-to {
  opacity: 0;
  transform: scale(0.95);
}
</style>
