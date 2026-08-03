import { describe, it, expect, vi, beforeEach } from "vitest";

const getReportData = vi.fn();
const computeDeltas = vi.fn((..._args: unknown[]) => ({ incomeDeltaPct: 10, expenseDeltaPct: -5 }));
vi.mock("@/services/reports", () => ({
  getReportData: (...a: unknown[]) => getReportData(...a),
  computeDeltas: (...a: unknown[]) => computeDeltas(...a),
}));

// 模拟 Pinia setup store 的 ref 解包：store.currentLedgerId 读出来是 string|null（参考真实 useLedgerStore 契约）
const currentLedgerId = ref<string | null>("l1");
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ get currentLedgerId() { return currentLedgerId.value; } }),
}));

import { useReports } from "@/composables/useReports";
import { nextTick, ref } from "vue";

describe("useReports", () => {
  beforeEach(() => {
    getReportData.mockReset();
    computeDeltas.mockReset().mockReturnValue({ incomeDeltaPct: 10, expenseDeltaPct: -5 });
    getReportData.mockResolvedValue({ label: "2026年8月", totals: { income: 10, expense: 5, balance: 5 }, prevTotals: { income: 10, expense: 5, balance: 5 } });
  });

  it("loads data with current ledger on mount", async () => {
    const r = useReports();
    await nextTick();
    await nextTick();
    expect(getReportData).toHaveBeenCalledWith("l1", "month", 0);
    expect(r.data.value!.label).toBe("2026年8月");
  });
  it("setUnit resets offset and reloads", async () => {
    const r = useReports();
    await nextTick(); await nextTick();
    getReportData.mockClear();
    r.setUnit("year");
    await nextTick(); await nextTick();
    expect(getReportData).toHaveBeenCalledWith("l1", "year", 0);
  });
  it("shift changes offset and reloads", async () => {
    const r = useReports();
    await nextTick(); await nextTick();
    getReportData.mockClear();
    r.shift(-1);
    await nextTick(); await nextTick();
    expect(getReportData).toHaveBeenCalledWith("l1", "month", -1);
  });
  it("deltas computed from totals and prevTotals", async () => {
    const r = useReports();
    await nextTick(); await nextTick();
    expect(r.deltas.value).toEqual({ incomeDeltaPct: 10, expenseDeltaPct: -5 });
    expect(computeDeltas).toHaveBeenCalled();
  });
  it("null ledger clears data without throwing", async () => {
    currentLedgerId.value = null;
    const r = useReports();
    await nextTick(); await nextTick();
    expect(r.data.value).toBeNull();
    expect(getReportData).not.toHaveBeenCalled();
    currentLedgerId.value = "l1";
  });
});
