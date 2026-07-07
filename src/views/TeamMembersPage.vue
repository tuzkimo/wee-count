<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import AppHeader from "@/components/AppHeader.vue";
import MemberAvatar from "@/components/MemberAvatar.vue";
import { useLedgerStore } from "@/stores/ledger";
import { fetchTeamMembers } from "@/services/api";
import { upsertTeamMembers, getTeamMembers, setMemberAlias, getMemberAlias } from "@/db/userDb";
import { enqueueSync } from "@/services/sync";
import type { TeamMemberRow } from "@/db/userDb";

const ledgerStore = useLedgerStore();
const teamLedgers = computed(() => ledgerStore.ledgers.filter((l) => l.type === "team"));
const selectedLedgerId = ref<string>("");
const members = ref<TeamMemberRow[]>([]);
const loading = ref(false);

// 别名编辑
const editingUserId = ref<string | null>(null);
const editingAlias = ref("");

const selectedLedger = computed(() => ledgerStore.ledgers.find((l) => l.id === selectedLedgerId.value));
const selectedTeamId = computed(() => selectedLedger.value?.team_id ?? null);

async function loadMembers() {
  if (!selectedTeamId.value) return;
  loading.value = true;
  try {
    const teamId = selectedTeamId.value;
    const remote = await fetchTeamMembers(teamId);
    await upsertTeamMembers(teamId, remote);
    members.value = await getTeamMembers(teamId);
  } catch (e) {
    console.warn("[TeamMembersPage] load failed:", e);
    members.value = await getTeamMembers(selectedTeamId.value);
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await ledgerStore.init();
  if (teamLedgers.value.length > 0) {
    // 默认选当前账本（若是团队账本）或第一个团队账本
    const current = ledgerStore.currentLedger;
    selectedLedgerId.value = (current?.type === "team" ? current.id : teamLedgers.value[0].id);
    await loadMembers();
  }
});

watch(selectedLedgerId, () => { loadMembers(); });

async function startEdit(userId: string) {
  const existing = await getMemberAlias(userId);
  editingUserId.value = userId;
  editingAlias.value = existing?.alias_name ?? "";
}

function cancelEdit() {
  editingUserId.value = null;
  editingAlias.value = "";
}

async function saveAlias() {
  if (!editingUserId.value) return;
  await setMemberAlias(editingUserId.value, editingAlias.value.trim());
  enqueueSync({ member_aliases: [] }); // 触发 sync，performSync 会全量带本地别名
  cancelEdit();
}

function goBack() {
  history.back();
}
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="成员管理" :show-back="true" @back="goBack" />

    <div class="flex-1 overflow-auto px-4 py-4">
      <!-- 团队账本切换 -->
      <div class="mb-4">
        <label class="mb-1 block text-xs text-text-secondary">团队账本</label>
        <select
          v-model="selectedLedgerId"
          class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        >
          <option v-for="l in teamLedgers" :key="l.id" :value="l.id">
            {{ l.name }}的账本
          </option>
        </select>
      </div>

      <p v-if="teamLedgers.length === 0" class="py-8 text-center text-sm text-text-secondary">
        还没有团队账本
      </p>

      <div v-else-if="loading" class="py-8 text-center text-text-secondary">加载中...</div>

      <!-- 成员列表 -->
      <div v-else class="space-y-2">
        <div
          v-for="m in members"
          :key="m.user_id"
          class="flex items-center gap-3 rounded-xl bg-surface p-3"
        >
          <MemberAvatar :user-id="m.user_id" :size="40" />
          <div class="flex-1">
            <p class="text-sm font-medium text-text">{{ m.nickname || m.username || m.user_id.slice(0,8) }}</p>
            <p class="text-xs text-text-secondary">
              {{ m.role === 'owner' ? '管理员' : '成员' }}
              <span v-if="m.username" class="ml-1">@{{ m.username }}</span>
            </p>
          </div>
          <!-- 别名编辑 -->
          <template v-if="editingUserId === m.user_id">
            <input
              v-model="editingAlias"
              type="text"
              maxlength="20"
              placeholder="别名"
              class="w-24 rounded-lg border border-gray-200 px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <button class="text-sm text-primary" @click="saveAlias">保存</button>
            <button class="text-sm text-text-secondary" @click="cancelEdit">取消</button>
          </template>
          <template v-else>
            <button class="text-sm text-primary" @click="startEdit(m.user_id)">改别名</button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
