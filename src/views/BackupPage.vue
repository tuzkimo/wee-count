<!-- src/views/BackupPage.vue -->
<template>
  <div class="min-h-screen bg-gray-50 px-4 py-6">
    <div class="mx-auto w-full max-w-sm">
      <button class="mb-4 flex items-center gap-1 text-sm text-text-secondary" @click="router.back()">
        <ChevronLeft :size="16" /> 返回
      </button>
      <h1 class="mb-4 text-xl font-bold text-text">备份与恢复</h1>

      <!-- 导出（已登录可见，全模式） -->
      <template v-if="showExport">
        <p class="mb-2 text-xs font-medium uppercase text-text-secondary">导出</p>
        <div class="rounded-xl border border-gray-200 bg-white p-4">
          <p class="text-sm text-text-secondary">导出加密备份文件（.weecount），重装或换机后可恢复。</p>
          <p v-if="auth.isOnlineBound" class="mt-1 text-xs text-orange-500">
            在线模式：备份只包含已同步到本机的数据，且含账户资料与密码哈希。
          </p>
          <button
            class="mt-3 w-full rounded-lg bg-primary py-2.5 text-sm text-white disabled:opacity-50"
            :disabled="exporting"
            @click="showPasswordDialog = true"
          >
            {{ exporting ? "导出中..." : "导出备份文件" }}
          </button>
          <p v-if="exportDone" class="mt-2 text-xs text-green-600">备份文件已导出</p>
          <p v-if="exportError" class="mt-2 text-xs text-red-500">{{ exportError }}</p>
        </div>
      </template>

      <!-- 恢复（未登录或纯本地未绑定可见） -->
      <template v-if="showRestore">
        <p class="mb-2 mt-6 text-xs font-medium uppercase text-text-secondary">恢复</p>
        <div class="rounded-xl border border-gray-200 bg-white p-4">
          <p class="text-sm text-text-secondary">从备份文件恢复为一个新账户，不影响现有数据。</p>
          <button class="mt-3 w-full rounded-lg border border-gray-200 py-2.5 text-sm text-text" @click="pickBackupFile">
            从备份文件恢复
          </button>
          <template v-if="rawFile">
            <input
              v-model="restorePassword"
              type="password"
              placeholder="备份密码"
              class="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <button class="mt-2 w-full rounded-lg bg-primary py-2.5 text-sm text-white" @click="decryptBackup">
              解密并预览
            </button>
          </template>
          <p v-if="restoreError" class="mt-2 text-xs text-red-500">{{ restoreError }}</p>
        </div>
      </template>

      <BackupPasswordDialog v-if="showPasswordDialog" @confirm="onExportPassword" @cancel="showPasswordDialog = false" />
      <RestoreConfirmDialog
        v-if="pending && showConfirm"
        :summary="summary"
        @confirm="onConfirmRestore"
        @cancel="showConfirm = false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useRouter } from "vue-router";
import { ChevronLeft } from "lucide-vue-next";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { getVersion } from "@tauri-apps/api/app";
import { useAuthStore } from "@/stores/auth";
import { getUserDb } from "@/db/userDb";
import { getLocalUser, getLocalUserByUsername } from "@/db/meta";
import { collectPayload, buildEnvelopeJson, buildBackupFileName } from "@/services/backup/exporter";
import { readBackup, restoreBackup, resolveUsername } from "@/services/backup/importer";
import { BackupError, type BackupPayload } from "@/services/backup/types";
import BackupPasswordDialog from "@/components/BackupPasswordDialog.vue";
import RestoreConfirmDialog, { type RestoreSummary } from "@/components/RestoreConfirmDialog.vue";

const router = useRouter();
const auth = useAuthStore();

const showExport = computed(() => auth.isAuthenticated);
// 未登录（欢迎页进入）或纯本地未绑定（含在线服务降级）时可恢复
const showRestore = computed(
  () => !auth.isAuthenticated || (auth.mode === "local" && !auth.isOnlineBound)
);

// --- 导出 ---
const showPasswordDialog = ref(false);
const exporting = ref(false);
const exportDone = ref(false);
const exportError = ref("");

async function onExportPassword(password: string): Promise<void> {
  showPasswordDialog.value = false;
  exporting.value = true;
  exportDone.value = false;
  exportError.value = "";
  try {
    const lu = auth.currentLocalUser;
    if (!lu) throw new BackupError("invalid", "当前未登录，无法导出");
    const account = {
      id: auth.isOnlineBound ? lu.server_user_id! : lu.id,
      username: lu.username,
      nickname: lu.nickname,
      avatar_url: lu.avatar_url,
      password_hash: lu.password_hash,
    };
    const db = getUserDb();
    if (!db) throw new BackupError("invalid", "用户数据库未打开");
    const payload = await collectPayload(db, account);
    const json = await buildEnvelopeJson(payload, password, await getVersion());

    const path = await save({
      defaultPath: buildBackupFileName(),
      filters: [{ name: "WeeCount 备份", extensions: ["weecount"] }],
    });
    if (!path) return; // 用户取消，不算错误
    await writeTextFile(path, json);
    exportDone.value = true;
  } catch (err) {
    exportError.value = err instanceof BackupError ? err.message : `导出失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    exporting.value = false;
  }
}

// --- 恢复 ---
const rawFile = ref<string | null>(null);
const restorePassword = ref("");
const pending = ref<{
  payload: BackupPayload;
  exportedAt: string;
  loginUsername: string;
  usernameAdjusted: boolean;
} | null>(null);
const showConfirm = ref(false);
const restoring = ref(false);
const restoreError = ref("");

async function pickBackupFile(): Promise<void> {
  restoreError.value = "";
  const picked = await open({
    multiple: false,
    filters: [{ name: "WeeCount 备份", extensions: ["weecount"] }],
  });
  if (!picked) return; // 用户取消
  try {
    rawFile.value = await readTextFile(picked as string);
  } catch (err) {
    restoreError.value = `读取失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

async function decryptBackup(): Promise<void> {
  restoreError.value = "";
  if (!rawFile.value) return;
  try {
    const { payload, exportedAt } = await readBackup(rawFile.value, restorePassword.value);
    // 确认弹窗前解析最终登录名并展示，让用户明确知道恢复出的账户叫什么
    const base = payload.account.username ?? payload.account.nickname;
    const loginUsername = await resolveUsername(base, async (u) => (await getLocalUserByUsername(u)) !== null);
    pending.value = { payload, exportedAt, loginUsername, usernameAdjusted: loginUsername !== base };
    showConfirm.value = true;
  } catch (err) {
    restoreError.value = err instanceof BackupError ? err.message : `读取失败：${String(err)}`;
  }
}

const summary = computed<RestoreSummary>(() => ({
  nickname: pending.value?.payload.account.nickname ?? "",
  username: pending.value?.payload.account.username ?? null,
  loginUsername: pending.value?.loginUsername ?? "",
  usernameAdjusted: pending.value?.usernameAdjusted ?? false,
  exportedAt: pending.value?.exportedAt ?? "",
  transactions: pending.value?.payload.tables.transactions.length ?? 0,
  accounts: pending.value?.payload.tables.accounts.length ?? 0,
  categories: pending.value?.payload.tables.categories.length ?? 0,
}));

async function onConfirmRestore(): Promise<void> {
  if (!pending.value) return;
  showConfirm.value = false;
  restoring.value = true;
  restoreError.value = "";
  try {
    const newUserId = crypto.randomUUID();
    await restoreBackup(pending.value.payload, newUserId, pending.value.loginUsername);
    const row = await getLocalUser(newUserId);
    if (!row) throw new BackupError("restore", "恢复完成但账户行缺失");
    await auth.switchToLocalUser(row);
    router.push("/");
  } catch (err) {
    restoreError.value = err instanceof BackupError ? err.message : `恢复失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    restoring.value = false;
  }
}
</script>
