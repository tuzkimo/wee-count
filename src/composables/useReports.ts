import { ref, computed, watch } from "vue";
import { useLedgerStore } from "@/stores/ledger";
import { getReportData, computeDeltas } from "@/services/reports";
import type { PeriodUnit, ReportData } from "@/services/reports";

export function useReports() {
  const ledgerStore = useLedgerStore();
  const unit = ref<PeriodUnit>("month");
  const offset = ref(0);
  const loading = ref(false);
  const data = ref<ReportData | null>(null);
  const breakdownType = ref<"income" | "expense">("expense");

  const deltas = computed(() => {
    const d = data.value;
    if (!d) return { incomeDeltaPct: null, expenseDeltaPct: null };
    return computeDeltas(d.totals, d.prevTotals);
  });

  let reloadSeq = 0;
  async function reload(): Promise<void> {
    const ledgerId = ledgerStore.currentLedgerId;
    if (!ledgerId) { data.value = null; return; }
    const seq = ++reloadSeq;
    loading.value = true;
    try {
      const result = await getReportData(ledgerId, unit.value, offset.value);
      if (seq !== reloadSeq) return; // 过期响应丢弃，防旧响应后到覆盖新值
      data.value = result;
    } finally {
      if (seq === reloadSeq) loading.value = false;
    }
  }

  function setUnit(u: PeriodUnit): void {
    if (unit.value === u) return;
    unit.value = u;
    offset.value = 0;
    void reload();
  }

  function shift(delta: number): void {
    offset.value += delta;
    void reload();
  }

  // 账本切换自动重查
  watch(() => ledgerStore.currentLedgerId, () => { void reload(); });

  void reload();

  return { unit, offset, loading, data, breakdownType, deltas, setUnit, shift, reload };
}
