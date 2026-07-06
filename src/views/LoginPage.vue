<!-- src/views/LoginPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">一起记账</h1>
      <p class="text-gray-500 text-center mb-8">输入账户信息登录</p>

      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">用户名</label>
          <input
            v-model="username"
            type="text"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="输入用户名"
            @keyup.enter="handleLogin"
          />
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input
            v-model="password"
            type="password"
            class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="输入密码"
            @keyup.enter="handleLogin"
          />
        </div>
      </div>

      <p v-if="error" class="text-red-500 text-sm mt-3">{{ error }}</p>

      <button
        :disabled="!valid || loading"
        class="w-full mt-6 py-3 rounded-xl font-medium text-white bg-blue-500 disabled:opacity-50"
        @click="handleLogin"
      >
        {{ loading ? '登录中...' : '登录' }}
      </button>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/welcome" class="text-blue-500">创建新用户</router-link>
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

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const valid = computed(() => username.value.trim().length > 0 && password.value.length > 0)

async function handleLogin(): Promise<void> {
  if (!valid.value) return
  loading.value = true
  error.value = ''
  try {
    const ok = await auth.localLogin(username.value.trim(), password.value)
    if (!ok) {
      error.value = '用户名或密码错误'
      return
    }
    router.replace('/')
  } catch {
    error.value = '登录失败，请重试'
  } finally {
    loading.value = false
  }
}
</script>
