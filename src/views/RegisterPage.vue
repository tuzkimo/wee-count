<!-- src/views/RegisterPage.vue -->
<!-- 该页面已重定向到 WelcomePage，本地账户创建通过 WelcomePage 完成 -->

<script setup lang="ts">
import { onMounted } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();

onMounted(() => {
  router.replace("/welcome");
});
</script>

<template>
  <div class="flex h-full items-center justify-center">
    <p class="text-text-secondary">跳转中...</p>
  </div>
</template>
