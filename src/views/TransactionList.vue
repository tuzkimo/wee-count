<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Pencil } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import AppHeader from "@/components/AppHeader.vue";

const route = useRoute();
const router = useRouter();
const accountStore = useAccountStore();

const accountId = computed(() => route.params.id as string);
const account = computed(() =>
  accountStore.accounts.find((a) => a.id === accountId.value)
);

function goBack() {
  router.push("/accounts");
}

function goEdit() {
  router.push(`/accounts/${accountId.value}/edit`);
}
</script>

<template>
  <div class="flex min-h-screen flex-col bg-bg">
    <AppHeader
      :title="account?.name ?? '流水'"
      :show-back="true"
      @back="goBack"
    >
      <template #action>
        <button
          v-if="account"
          class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
          @click="goEdit"
        >
          <Pencil :size="18" class="text-text-secondary" />
        </button>
      </template>
    </AppHeader>

    <div class="flex flex-1 items-center justify-center">
      <div class="text-center">
        <p class="text-4xl">📋</p>
        <p class="mt-3 text-text-secondary">暂无流水记录</p>
        <p class="mt-1 text-xs text-text-secondary">
          记账功能将在后续版本中开放
        </p>
      </div>
    </div>
  </div>
</template>
