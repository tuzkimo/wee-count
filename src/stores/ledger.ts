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

    if (rows.length > 0 && !currentLedgerId.value) {
      currentLedgerId.value = rows[0].id;
    }
  }

  function setCurrentLedger(id: string): void {
    currentLedgerId.value = id;
  }

  return { ledgers, currentLedgerId, currentLedger, init, setCurrentLedger };
});
