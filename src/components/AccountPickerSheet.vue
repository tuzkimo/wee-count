<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { X, Plus } from "lucide-vue-next";
import { useAccountStore } from "@/stores/account";
import { useLedgerStore } from "@/stores/ledger";
import { useMemberInfo } from "@/composables/useMemberInfo";
import type { Account } from "@/types";

defineProps<{
  visible: boolean;
  showAllOption?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  select: [account: Account];
  selectAll: [];
  create: [];
}>();

const accountStore = useAccountStore();
const ledgerStore = useLedgerStore();

const isTeamLedger = computed(() => ledgerStore.currentLedger?.type === 'team');

const { getMember } = useMemberInfo();
const ownerNames = ref<Record<string, string>>({});

async function loadOwnerName(ownerId: string) {
  if (!ownerNames.value[ownerId]) {
    const info = await getMember(ownerId);
    ownerNames.value[ownerId] = info.displayName;
  }
}

const availableAccounts = computed(() =>
  accountStore.accounts.filter((a) => !a.is_deleted)
);

watch(availableAccounts, (accs) => {
  for (const a of accs) {
    if (a.owner_id) loadOwnerName(a.owner_id);
  }
}, { immediate: true });

function select(acc: Account) {
  emit("select", acc);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[60vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">选择账户</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <div class="flex-1 overflow-auto">
          <button
            v-if="showAllOption"
            class="flex w-full items-center gap-3 px-2 py-3 text-sm transition-colors hover:bg-gray-50"
            @click="$emit('selectAll')"
          >
            <span class="flex h-3 w-3 shrink-0 items-center justify-center rounded-full bg-gray-300 text-[8px] text-white">✓</span>
            <span class="text-text">全部账户</span>
          </button>

          <button
            v-for="acc in availableAccounts"
            :key="acc.id"
            class="flex w-full items-center gap-3 px-2 py-3 text-sm transition-colors hover:bg-gray-50"
            @click="select(acc)"
          >
            <span
              class="h-3 w-3 shrink-0 rounded-full"
              :style="{ backgroundColor: acc.color || '#3b82f6' }"
            />
            <span class="text-text">{{ acc.name }}</span>
            <span v-if="isTeamLedger && acc.owner_id" class="text-[10px] text-text-secondary">
              ({{ ownerNames[acc.owner_id] ?? acc.owner_id.slice(0,8) }})
            </span>
          </button>

          <div v-if="availableAccounts.length === 0" class="py-8 text-center text-sm text-text-secondary">
            暂无可用账户
          </div>

          <button
            class="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-gray-300 py-3 text-sm text-text-secondary transition-colors hover:border-primary hover:text-primary"
            @click="$emit('create')"
          >
            <Plus :size="16" />
            <span>新建账户</span>
          </button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
