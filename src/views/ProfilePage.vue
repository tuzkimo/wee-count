<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { Camera } from "lucide-vue-next";
import AppHeader from "@/components/AppHeader.vue";
import AvatarCropper from "@/components/AvatarCropper.vue";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const currentAvatar = computed(() =>
  auth.onlineUser?.avatar_url || auth.currentLocalUser?.avatar_url || ""
);

const nickname = ref(auth.currentLocalUser?.nickname || "");
const selectedEmoji = ref(currentAvatar.value);

const fileInput = ref<HTMLInputElement | null>(null);
const cropperFile = ref<File | null>(null);

function triggerUpload() {
  fileInput.value?.click();
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  cropperFile.value = file;
}

// 仅暂存到本地选中态，随「保存」按钮与昵称一起提交；
// 不在此处立即落库，否则 currentAvatar 同步更新会导致 hasChanges 失效、保存按钮不可点。
function onCropperConfirm(dataUrl: string) {
  cropperFile.value = null;
  selectedEmoji.value = dataUrl;
}

function onCropperCancel() {
  cropperFile.value = null;
}

function onCropperError() {
  cropperFile.value = null;
  alert("图片无法读取，请换一张");
}

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
      <div class="mb-3 flex flex-col items-center">
        <button
          type="button"
          class="group relative h-24 w-24 rounded-full bg-gray-100 ring-2 ring-gray-200 transition hover:ring-primary"
          @click="triggerUpload"
        >
          <span class="flex h-full w-full items-center justify-center overflow-hidden rounded-full">
            <img
              v-if="selectedEmoji.startsWith('data:') || selectedEmoji.startsWith('http') || selectedEmoji.startsWith('/')"
              :src="selectedEmoji"
              class="h-full w-full object-cover"
              alt="头像"
            />
            <span
              v-else-if="selectedEmoji"
              class="text-4xl"
            >{{ selectedEmoji }}</span>
            <span
              v-else
              class="text-3xl text-text-secondary"
            >{{ (nickname || "我").charAt(0) }}</span>
          </span>
          <span
            class="absolute bottom-0 right-0 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-white shadow ring-2 ring-surface"
          >
            <Camera :size="16" />
          </span>
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="hidden"
          @change="onFileChange"
        />
        <p class="mt-2 text-xs text-text-secondary">点击更换头像，或选择下方 emoji</p>
      </div>
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
      <AvatarCropper
        v-if="cropperFile"
        :file="cropperFile"
        @confirm="onCropperConfirm"
        @cancel="onCropperCancel"
        @error="onCropperError"
      />
    </div>
  </div>
</template>
