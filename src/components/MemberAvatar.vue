<script setup lang="ts">
import { ref, watch } from "vue";
import { useMemberInfo } from "@/composables/useMemberInfo";

const props = defineProps<{
  userId: string;
  size?: number;
}>();

const { getMember } = useMemberInfo();
const displayName = ref("");
const avatarUrl = ref<string | null>(null);

async function load() {
  const info = await getMember(props.userId);
  displayName.value = info.displayName;
  avatarUrl.value = info.avatarUrl;
}

watch(() => props.userId, load, { immediate: true });
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center rounded-full bg-gray-200 text-text-secondary overflow-hidden"
    :style="{ width: (size ?? 20) + 'px', height: (size ?? 20) + 'px', fontSize: (size ?? 20) * 0.55 + 'px' }"
  >
    <img
      v-if="avatarUrl && avatarUrl.startsWith('http')"
      :src="avatarUrl"
      :alt="displayName"
      class="h-full w-full object-cover"
    />
    <span v-else-if="avatarUrl">{{ avatarUrl }}</span>
    <span v-else>{{ displayName.charAt(0) }}</span>
  </span>
</template>
