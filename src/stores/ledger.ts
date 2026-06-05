import { defineStore } from "pinia";
import { ref } from "vue";
import { ensureDefaultData } from "@/db";
import type { Ledger } from "@/types";

export const useLedgerStore = defineStore("ledger", () => {
  const currentLedger = ref<Ledger | null>(null);
  const initialized = ref(false);

  async function init(): Promise<void> {
    if (initialized.value) return;
    await ensureDefaultData();
    currentLedger.value = {
      id: "personal-ledger-1",
      name: "个人账本",
      type: "personal",
      team_id: null,
      owner_id: "local-user-1",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      is_deleted: false,
    };
    initialized.value = true;
  }

  return { currentLedger, initialized, init };
});
