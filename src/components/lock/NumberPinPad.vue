<!-- src/components/lock/NumberPinPad.vue -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Delete, Fingerprint } from "lucide-vue-next";
import { PIN_LENGTH } from "@/utils/pin";

const props = withDefaults(defineProps<{
  biometricAvailable?: boolean;
  disabled?: boolean;
  /** 父组件在校验失败时置真，键盘据此清空已输入位数。 */
  error?: boolean;
}>(), { biometricAvailable: false, disabled: false, error: false });

const emit = defineEmits<{
  submit: [pin: string];
  biometric: [];
}>();

const digits = ref<string[]>([]);

watch(
  () => props.error,
  (isError) => {
    if (isError) digits.value = [];
  },
);

const dotStates = computed(() =>
  Array.from({ length: PIN_LENGTH }, (_, i) => i < digits.value.length),
);

function press(digit: string): void {
  if (props.disabled || digits.value.length >= PIN_LENGTH) return;
  digits.value = [...digits.value, digit];
  if (digits.value.length === PIN_LENGTH) {
    emit("submit", digits.value.join(""));
  }
}

function backspace(): void {
  if (props.disabled) return;
  digits.value = digits.value.slice(0, -1);
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
</script>

<template>
  <div class="flex flex-col items-center gap-6">
    <!-- 位数指示 -->
    <div class="flex gap-3">
      <span
        v-for="(isFilled, i) in dotStates"
        :key="i"
        :data-test="isFilled ? 'pin-dot-filled' : 'pin-dot-empty'"
        class="h-3 w-3 rounded-full border transition-colors"
        :class="isFilled ? 'border-primary bg-primary' : 'border-gray-300'"
      />
    </div>

    <!-- 键盘 -->
    <div class="grid grid-cols-3 gap-3">
      <button
        v-for="key in KEYS"
        :key="key"
        type="button"
        :data-test="`pin-key-${key}`"
        class="h-16 w-16 rounded-full bg-surface text-xl font-medium text-text shadow-sm transition-colors hover:bg-gray-100 active:bg-gray-200 disabled:opacity-40"
        :disabled="disabled"
        @click="press(key)"
      >
        {{ key }}
      </button>

      <button
        v-if="biometricAvailable"
        type="button"
        data-test="pin-biometric"
        class="flex h-16 w-16 items-center justify-center rounded-full text-primary transition-colors hover:bg-gray-100"
        :disabled="disabled"
        aria-label="使用生物识别解锁"
        @click="emit('biometric')"
      >
        <Fingerprint :size="24" />
      </button>
      <span v-else class="h-16 w-16" />

      <button
        type="button"
        data-test="pin-key-0"
        class="h-16 w-16 rounded-full bg-surface text-xl font-medium text-text shadow-sm transition-colors hover:bg-gray-100 active:bg-gray-200 disabled:opacity-40"
        :disabled="disabled"
        @click="press('0')"
      >
        0
      </button>

      <button
        type="button"
        data-test="pin-backspace"
        class="flex h-16 w-16 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-gray-100 disabled:opacity-40"
        :disabled="disabled"
        aria-label="退格"
        @click="backspace"
      >
        <Delete :size="22" />
      </button>
    </div>
  </div>
</template>