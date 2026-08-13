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
  const error = ref<string | null>(null);
  const breakdownType = ref<"income" | "expense">("expense");

  const deltas = computed(() => {
    const d = data.value;
    if (!d) return { incomeDeltaPct: null, expenseDeltaPct: null };
    return computeDeltas(d.totals, d.prevTotals);
  });

  let reloadSeq = 0;
  async function reload(): Promise<void> {
    const ledgerId = ledgerStore.currentLedgerId;
    if (!ledgerId) { data.value = null; error.value = null; return; }
    const seq = ++reloadSeq;
    loading.value = true;
    error.value = null;
    try {
      const result = await getReportData(ledgerId, unit.value, offset.value);
      if (seq !== reloadSeq) return; // 过期响应丢弃，防旧响应后到覆盖新值
      data.value = result;
    } catch (e) {
      if (seq !== reloadSeq) return;
      // 不静默吞错：SQL/DB 异常若被吞掉会伪装成「暂无数据」。留 error 态供页面展示 + 重试。
      console.error("[reports] 报表数据加载失败:", e);
      error.value = e instanceof Error ? e.message : String(e);
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

  // 先确保账本已初始化再拉首屏：报表页不同于其他数据页，此前没有在 onMounted 里
  // 调 ledgerStore.init()，冷启动直达报表时 currentLedgerId 为空会导致「暂无数据」。
  async function bootstrap(): Promise<void> {
    await ledgerStore.init();
    void reload();
  }
  void bootstrap();

  return { unit, offset, loading, data, error, breakdownType, deltas, setUnit, shift, reload };
}
