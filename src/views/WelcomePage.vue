<!-- src/views/WelcomePage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">一起记账</h1>
      <p class="text-gray-500 text-center mb-8">选择你的记账方式</p>

      <!-- 本地模式 -->
      <div class="mb-4 rounded-xl border border-gray-200 p-4">
        <h2 class="text-lg font-semibold mb-3">📱 本地模式</h2>
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
            :disabled="!localValid || loading"
            class="w-full py-3 rounded-xl font-medium text-white bg-blue-500 disabled:opacity-50"
            @click="handleCreateLocal"
          >
            {{ loading ? '创建中...' : '开始使用' }}
          </button>
        </div>
      </div>

      <!-- 在线模式 -->
      <div class="rounded-xl border border-gray-200 p-4">
        <h2 class="text-lg font-semibold mb-3">🌐 在线模式</h2>
        <p class="text-sm text-gray-500 mb-3">同步数据到服务器，支持多设备和团队协作</p>
        <div class="space-y-3">
          <input
            v-model="apiUrl"
            type="text"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="服务器地址，如 https://api.example.com/api/v1"
          />
          <button
            :disabled="!onlineValid || loading"
            class="w-full py-3 rounded-xl font-medium text-white bg-green-500 disabled:opacity-50"
            @click="handleGoOnline"
          >
            配置在线同步
          </button>
        </div>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        已有本地账户？<router-link to="/login" class="text-blue-500">登录</router-link>
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
const apiUrl = ref('')
const loading = ref(false)
const error = ref('')

const localValid = computed(() => nickname.value.trim().length > 0 && password.value.length >= 4)
const onlineValid = computed(() => apiUrl.value.trim().length > 0)

async function handleCreateLocal(): Promise<void> {
  if (!localValid.value) return
  loading.value = true
  error.value = ''
  try {
    await auth.createLocalAccount(nickname.value.trim(), password.value)
    router.replace('/')
  } catch {
    error.value = '创建失败，请重试'
  } finally {
    loading.value = false
  }
}

function handleGoOnline(): void {
  if (!onlineValid.value) return
  router.push({ path: '/bind-sync', query: { apiUrl: apiUrl.value.trim() } })
}
</script>
