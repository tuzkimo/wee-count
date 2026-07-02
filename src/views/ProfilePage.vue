<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import AppHeader from "@/components/AppHeader.vue";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const currentAvatar = computed(() =>
  auth.onlineUser?.avatar_url || auth.currentLocalUser?.avatar_url || ""
);

const nickname = ref(auth.currentLocalUser?.nickname || "");
const selectedEmoji = ref(currentAvatar.value);

// emoji 头像选项
const avatarOptions = ["😀", "🐱", "🐶", "🦊", "🐼", "🐨", "🐯", "🦁", "🐮", "🐷", "🐸", "🐵", "🐔", "🐧", "🐦", "🐤", "🦄", "🐌", "🐛", "🦋"];

const saving = ref(false);
const saved = ref(false);

async function handleSave(): Promise<void> {
  saving.value = true;
  saved.value = false;
  try {
    await auth.updateProfile({
      nickname: nickname.value.trim() || undefined,
      avatar_url: selectedEmoji.value || null,
    });
    router.back();
  } catch (e) {
    console.error("Save profile failed:", e);
  } finally {
    saving.value = false;
  }
}

const hasChanges = computed(() =>
  nickname.value.trim() !== (auth.currentLocalUser?.nickname || "") ||
  selectedEmoji.value !== currentAvatar.value
);
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="个人信息" :show-back="true" @back="router.back()" />

    <div class="flex-1 overflow-auto px-4 py-4">
      <!-- 头像 -->
      <label class="mb-2 block text-sm font-medium text-text">头像</label>
      <div class="mb-6 flex flex-wrap gap-2">
        <button
          v-for="emoji in avatarOptions"
          :key="emoji"
          class="flex h-12 w-12 items-center justify-center rounded-xl text-2xl transition-colors"
          :class="selectedEmoji === emoji
            ? 'bg-primary/10 ring-2 ring-primary ring-offset-1'
            : 'bg-gray-100 hover:bg-gray-200'"
          @click="selectedEmoji = selectedEmoji === emoji ? '' : emoji"
        >
          {{ emoji }}
        </button>
      </div>

      <!-- 昵称 -->
      <label class="mb-1 block text-sm font-medium text-text">昵称</label>
      <input
        v-model="nickname"
        type="text"
        maxlength="20"
        class="mb-6 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        placeholder="你的昵称"
      />

      <!-- 在线模式额外信息 -->
      <div v-if="auth.isOnline" class="mb-6 rounded-lg bg-gray-50 p-3">
        <p class="text-xs text-text-secondary">
          用户名：{{ auth.onlineUser?.username || '-' }}
        </p>
      </div>

      <!-- 保存按钮 -->
      <button
        class="w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors disabled:opacity-50"
        :disabled="!hasChanges || saving"
        @click="handleSave"
      >
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>
  </div>
</template>
