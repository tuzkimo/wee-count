<!-- src/views/WelcomePage.vue -->
<template>
  <div class="min-h-screen flex flex-col items-center justify-center px-6 bg-white">
    <div class="w-full max-w-sm">
      <h1 class="text-3xl font-bold text-center mb-2">一起记账</h1>
      <p class="text-gray-500 text-center mb-8">选择你的记账方式</p>

      <!-- 本地模式 -->
      <button
        class="w-full mb-4 flex items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-left transition-colors hover:bg-gray-100"
        @click="router.push('/welcome/local')"
      >
        <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600">
          <Smartphone :size="24" />
        </div>
        <div class="flex-1">
          <p class="text-base font-semibold text-text">本地模式</p>
          <p class="text-sm text-text-secondary">数据仅存储在本地，无需网络</p>
        </div>
        <ChevronRight :size="18" class="text-gray-300" />
      </button>

      <!-- 在线模式 -->
      <button
        class="w-full flex items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-left transition-colors hover:bg-gray-100"
        @click="router.push('/bind-sync')"
      >
        <div class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-green-100 text-green-600">
          <Cloud :size="24" />
        </div>
        <div class="flex-1">
          <p class="text-base font-semibold text-text">在线模式</p>
          <p class="text-sm text-text-secondary">数据同步至服务器，支持多设备与团队协作</p>
        </div>
        <ChevronRight :size="18" class="text-gray-300" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { Smartphone, Cloud, ChevronRight } from 'lucide-vue-next'

const router = useRouter()
</script>
