<!-- src/views/LocalSetupPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">本地模式</h1>
      <p class="text-gray-500 text-center mb-8">创建本地账户开始记账</p>

      <div class="space-y-3">
        <input
          v-model="nickname"
          type="text"
          class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="你的昵称"
        />
        <input
          v-model="password"
          type="password"
          class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="设置密码"
        />
        <p v-if="error" class="text-red-500 text-sm">{{ error }}</p>
        <button
          :disabled="!valid || loading"
          class="w-full py-3 rounded-xl font-medium text-white bg-blue-500 disabled:opacity-50"
          @click="handleCreate"
        >
          {{ loading ? '创建中...' : '开始使用' }}
        </button>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/welcome" class="text-blue-500">返回</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const nickname = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const valid = computed(() => nickname.value.trim().length > 0 && password.value.length >= 4)

async function handleCreate(): Promise<void> {
  if (!valid.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.createLocalAccount(nickname.value.trim(), nickname.value.trim(), password.value)
    router.replace('/')
  } catch {
    error.value = '创建失败，请重试'
  } finally {
    loading.value = false
  }
}
</script>
