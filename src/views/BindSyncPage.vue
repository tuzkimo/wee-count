<!-- src/views/BindSyncPage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-2xl font-bold text-center mb-6">配置在线同步</h1>

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

      <!-- Tab 切换 -->
      <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
        <button
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="activeTab === 'login' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="activeTab = 'login'"
        >登录</button>
        <button
          class="flex-1 rounded-md py-2 text-sm font-medium transition-colors"
          :class="activeTab === 'register' ? 'bg-surface text-text shadow-sm' : 'text-text-secondary'"
          @click="activeTab = 'register'"
        >注册</button>
      </div>

      <p v-if="error" class="text-red-500 text-sm mb-3">{{ error }}</p>

      <!-- 登录表单 -->
      <div v-if="activeTab === 'login'" class="space-y-3">
        <input v-model="loginUsername" type="text" placeholder="用户名" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <input v-model="loginPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <button
          :disabled="loginLoading || !apiUrl || !loginUsername || !loginPassword"
          class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium disabled:opacity-50"
          @click="handleLogin"
        >
          {{ loginLoading ? '登录中...' : '登录并同步' }}
        </button>
      </div>

      <!-- 注册表单 -->
      <div v-if="activeTab === 'register'" class="space-y-3">
        <input v-model="regUsername" type="text" placeholder="用户名" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <input v-model="regPassword" type="password" placeholder="密码" class="w-full px-4 py-3 rounded-xl border border-gray-300" />
        <p class="text-xs text-gray-400">注册后昵称默认与用户名相同，可在设置中修改</p>
        <button
          :disabled="regLoading || !apiUrl || !regUsername || !regPassword"
          class="w-full py-3 rounded-xl bg-blue-500 text-white font-medium disabled:opacity-50"
          @click="handleRegister"
        >
          {{ regLoading ? '注册中...' : '注册并同步' }}
        </button>
      </div>

      <p class="text-center text-gray-400 text-sm mt-4">
        <router-link to="/" class="text-blue-500">暂不配置，继续使用本地模式</router-link>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import * as api from '@/services/api'
import { migrateLocalDataToServer, firstFullSync } from '@/services/migration'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

const activeTab = ref<'login' | 'register'>('login')
const apiUrl = ref((route.query.apiUrl as string) || '')
const error = ref('')
const loginLoading = ref(false)
const regLoading = ref(false)

const loginUsername = ref('')
const loginPassword = ref('')

const regUsername = ref('')
const regPassword = ref('')

async function doAfterBind(resp: api.AuthResponse, password: string): Promise<void> {
  // 确保已初始化会话（处理从 WelcomePage 直达时 currentLocalUser 为 null 的情况）
  await auth.init()
  const hadLocalUser = !!auth.currentLocalUser
  // 无本地账户时（如登录已有账号），用服务端 profile 创建本地账户
  if (!auth.currentLocalUser) {
    await auth.createLocalAccount(resp.user.nickname || resp.user.username, password)
  }
  await migrateLocalDataToServer(resp.ledger_id, resp.user.id)
  await auth.bindOnline(apiUrl.value, resp)
  // 同步 profile：已有本地用户时推送到服务端，否则从服务端拉取
  if (hadLocalUser) {
    const localNickname = auth.currentLocalUser?.nickname
    const localAvatar = auth.currentLocalUser?.avatar_url
    if ((localNickname && localNickname !== resp.user.nickname) || localAvatar) {
      try { await auth.updateProfile({ nickname: localNickname, avatar_url: localAvatar }) } catch (e) {
        console.warn('[BindSync] profile sync failed:', e)
      }
    }
  } else if (auth.currentLocalUser) {
    // 登录场景：将服务端存储的 profile 写入本地
    if (resp.user.avatar_url || resp.user.nickname !== resp.user.username) {
      const { updateLocalUserProfile } = await import('@/db/meta')
      const nickname = resp.user.nickname || resp.user.username
      await updateLocalUserProfile(auth.currentLocalUser.id, nickname, resp.user.avatar_url || null)
      auth.currentLocalUser = { ...auth.currentLocalUser, nickname, avatar_url: resp.user.avatar_url || null }
    }
  }
  router.replace('/')
  // 后台执行首次同步
  try { await firstFullSync() } catch (e) {
    console.warn("[BindSync] firstFullSync failed (non-fatal):", e)
  }
}

async function handleLogin(): Promise<void> {
  loginLoading.value = true
  error.value = ''
  try {
    api.setBaseUrl(apiUrl.value)
    const resp = await api.login(loginUsername.value, loginPassword.value)
    await doAfterBind(resp, loginPassword.value)
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
    const resp = await api.register(regUsername.value, regPassword.value, auth.currentLocalUser?.nickname)
    await doAfterBind(resp, regPassword.value)
  } catch (e: unknown) {
    error.value = (e as Error)?.message || '注册失败'
  } finally {
    regLoading.value = false
  }
}
</script>
