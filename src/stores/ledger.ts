import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getUserDb, getAppValue, setAppValue } from "@/db/userDb";
import type { Ledger } from "@/types";

// app_kv 中存储当前账本选择的键
const CURRENT_LEDGER_KEY = "current_ledger_id";

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

    const [rows, storedId] = await Promise.all([
      db.select<Ledger[]>(
        'SELECT id, name, type, owner_id, team_id, created_at, updated_at FROM ledgers WHERE is_deleted = 0'
      ),
      getAppValue(CURRENT_LEDGER_KEY),
    ]);
    ledgers.value = rows;

    // 优先恢复上次选中的账本；若已不存在（如迁移后旧 ID 被替换）则回退第一个
    const stillExists = storedId && rows.some((l) => l.id === storedId);
    if (rows.length > 0) {
      currentLedgerId.value = stillExists ? storedId : rows[0].id;
      // 落库保持一致：首次进入或回退后同步持久化值
      void setAppValue(CURRENT_LEDGER_KEY, currentLedgerId.value);
    } else {
      currentLedgerId.value = null;
    }
  }

  function setCurrentLedger(id: string): void {
    currentLedgerId.value = id;
    void setAppValue(CURRENT_LEDGER_KEY, id);
  }

  async function addLedger(ledger: Ledger): Promise<void> {
    const db = getUserDb();
    if (!db) return;
    await db.execute(
      `INSERT OR IGNORE INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ledger.id, ledger.name, ledger.type, ledger.owner_id ?? null, ledger.team_id ?? null, ledger.created_at, ledger.updated_at],
    );
    if (!ledgers.value.some((l) => l.id === ledger.id)) {
      ledgers.value.push(ledger);
    }
    currentLedgerId.value = ledger.id;
    void setAppValue(CURRENT_LEDGER_KEY, ledger.id);
  }

  return { ledgers, currentLedgerId, currentLedger, init, setCurrentLedger, addLedger };
});
