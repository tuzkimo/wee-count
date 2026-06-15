<!-- src/views/RegisterPage.vue -->
<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const auth = useAuthStore();

const email = ref("");
const password = ref("");
const nickname = ref("");
const error = ref("");
const loading = ref(false);

async function handleRegister(): Promise<void> {
  error.value = "";
  if (!email.value || !password.value || !nickname.value) {
    error.value = "请填写所有字段";
    return;
  }
  if (password.value.length < 6) {
    error.value = "密码至少 6 位";
    return;
  }
  loading.value = true;
  const err = await auth.register(email.value, password.value, nickname.value);
  loading.value = false;
  if (err) {
    error.value = err;
  } else {
    router.replace("/me");
  }
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <div class="flex min-h-14 items-center border-b border-gray-200 bg-surface px-4 py-2">
      <button class="text-primary" @click="router.back()">取消</button>
      <h1 class="flex-1 text-center text-lg font-semibold text-text">注册</h1>
      <div class="w-10" />
    </div>

    <form class="flex flex-col gap-4 p-6" @submit.prevent="handleRegister">
      <div>
        <label class="mb-1 block text-sm text-text-secondary">昵称</label>
        <input
          v-model="nickname"
          type="text"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入昵称"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-text-secondary">邮箱</label>
        <input
          v-model="email"
          type="email"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入邮箱"
          autocomplete="email"
        />
      </div>

      <div>
        <label class="mb-1 block text-sm text-text-secondary">密码</label>
        <input
          v-model="password"
          type="password"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-3 text-text"
          placeholder="请输入密码（至少 6 位）"
          autocomplete="new-password"
        />
      </div>

      <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

      <button
        type="submit"
        :disabled="loading"
        class="mt-2 rounded-lg bg-primary py-3 text-white font-medium disabled:opacity-50"
      >
        {{ loading ? "注册中..." : "注册" }}
      </button>

      <p class="text-center text-sm text-text-secondary">
        已有账号？
        <router-link to="/login" class="text-primary">登录</router-link>
      </p>
    </form>
  </div>
</template>
