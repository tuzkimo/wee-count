import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getUserDb } from "@/db/userDb";
import type { Ledger } from "@/types";

export const useLedgerStore = defineStore("ledger", () => {
  const ledgers = ref<Ledger[]>([]);
  const currentLedgerId = ref<string | null>(null);

  const currentLedger = computed(() => {
    if (!currentLedgerId.value) return null;
    return ledgers.value.find((l) => l.id === currentLedgerId.value) ?? null;
  });

  async function init(): Promise<void> {
    const db = getUserDb();
    if (!db) return;

    const rows = await db.select<Ledger[]>(
      'SELECT id, name, type, owner_id, team_id, created_at, updated_at FROM ledgers WHERE is_deleted = 0'
    );
    ledgers.value = rows;

    // 如果之前选的账本已不存在（如迁移后旧 ID 被替换），改用第一个
    const stillExists = currentLedgerId.value && rows.some((l) => l.id === currentLedgerId.value);
    if (rows.length > 0 && !stillExists) {
      currentLedgerId.value = rows[0].id;
    }
  }

  function setCurrentLedger(id: string): void {
    currentLedgerId.value = id;
  }

  return { ledgers, currentLedgerId, currentLedger, init, setCurrentLedger };
});
