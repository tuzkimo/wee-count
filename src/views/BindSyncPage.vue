<!-- src/views/BindSyncPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-2xl font-bold text-center mb-8">配置在线同步</h1>

      <!-- API 地址 -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-1">服务器地址</label>
        <input
          v-model="apiUrl"
          type="text"
          class="w-full px-4 py-3 rounded-xl border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="https://api.example.com/api/v1"
        />
      </div>

      <p v-if="error" class="text-red-500 text-sm mb-3">{{ error }}</p>

      <!-- 登录已有账号 -->
      <div class="border-t pt-4 mb-4">
        <h2 class="text-sm font-medium text-gray-700 mb-3">已有在线账号</h2>
        <div class="space-y-3">
          <input v-model="email" type="email" placeholder="邮箱" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <input v-model="loginPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <button :disabled="loginLoading" class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium" @click="handleLogin">
            {{ loginLoading ? '登录中...' : '登录并同步' }}
          </button>
        </div>
      </div>

      <!-- 注册新账号 -->
      <div class="border-t pt-4">
        <h2 class="text-sm font-medium text-gray-700 mb-3">没有账号</h2>
        <div class="space-y-3">
          <input v-model="regNickname" type="text" placeholder="昵称" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <input v-model="regEmail" type="email" placeholder="邮箱" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <input v-model="regPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
          <button :disabled="regLoading" class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium" @click="handleRegister">
            {{ regLoading ? '注册中...' : '注册并同步' }}
          </button>
        </div>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/" class="text-blue-500">暂不配置，继续使用本地模式</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/services/api'
import { migrateLocalDataToServer, firstFullSync } from '@/services/migration'

const router = useRouter()
const auth = useAuthStore()

const apiUrl = ref('')
const error = ref('')
const loginLoading = ref(false)
const regLoading = ref(false)

const email = ref('')
const loginPassword = ref('')

const regNickname = ref('')
const regEmail = ref('')
const regPassword = ref('')

async function handleLogin(): Promise<void> {
  loginLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.login(email.value, loginPassword.value)
    await migrateLocalDataToServer(resp.ledger_id, resp.user.id)
    await auth.bindOnline(apiUrl.value, resp)
    await firstFullSync()
    router.replace('/')
  } catch (e: unknown) {
    error.value = (e as Error)?.message || '登录失败'
  } finally {
    loginLoading.value = false
  }
}

async function handleRegister(): Promise<void> {
  regLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.register(regEmail.value, regPassword.value, regNickname.value)
    await migrateLocalDataToServer(resp.ledger_id, resp.user.id)
    await auth.bindOnline(apiUrl.value, resp)
    await firstFullSync()
    router.replace('/')
  } catch (e: unknown) {
    error.value = (e as Error)?.message || '注册失败'
  } finally {
    regLoading.value = false
  }
}
</script>
