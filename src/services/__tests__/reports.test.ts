import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDb = { select: vi.fn(), execute: vi.fn() };
vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
}));

import {
  computeRange, rangeLabels, offsetModifier, fillTrend,
  buildBreakdown, buildNetAssetSeries, computeDeltas,
  getTrend, getPeriodTotals, getCategoryBreakdown, getNetAssetSeries, getReportData,
} from "@/services/reports";
import type { ReportRange } from "@/services/reports";

describe("computeRange", () => {
  it("month: current month, prev month, label, day granularity", () => {
    const r = computeRange("month", 0);
    expect(r.label).toMatch(/^\d{4}年\d{1,2}月$/);
    expect(r.granularity).toBe("day");
    // 周期长度 = 当前月的实际天数（与运行月份无关）
    const expectedDays = new Date(r.range.start.getFullYear(), r.range.start.getMonth() + 1, 0).getDate();
    expect(r.range.end.getTime() - r.range.start.getTime()).toBe(expectedDays * 86400_000);
    expect(r.range.end.getTime()).toBeGreaterThan(r.range.start.getTime());
    expect(r.prevRange.end).toEqual(r.range.start);
  });
  it("offset shifts the month", () => {
    const cur = computeRange("month", 0);
    const prev = computeRange("month", -1);
    expect(prev.range.start.getTime()).toBeLessThan(cur.range.start.getTime());
  });
  it("quarter/year/twelveMonths use month granularity", () => {
    expect(computeRange("quarter", 0).granularity).toBe("month");
    expect(computeRange("year", 0).granularity).toBe("month");
    expect(computeRange("twelveMonths", 0).granularity).toBe("month");
  });
  it("twelveMonths window includes the current month and spans 12 months", () => {
    const now = new Date();
    const r = computeRange("twelveMonths", 0);
    // 结束 = 下月首日（窗口含当前月）
    expect(r.range.end.getFullYear() * 12 + r.range.end.getMonth()
      - (now.getFullYear() * 12 + now.getMonth())).toBe(1);
    // 跨度 12 个月
    expect(r.range.end.getFullYear() * 12 + r.range.end.getMonth()
      - (r.range.start.getFullYear() * 12 + r.range.start.getMonth())).toBe(12);
    // 标签为 "YYYY年M月–YYYY年M月"
    expect(r.label).toMatch(/^\d{4}年\d{1,2}月–\d{4}年\d{1,2}月$/);
  });
});

describe("rangeLabels", () => {
  it("day granularity lists each local day", () => {
    const labels = rangeLabels({ start: new Date(2026, 7, 1), end: new Date(2026, 7, 3) }, "day");
    expect(labels).toEqual(["2026-08-01", "2026-08-02"]);
  });
  it("month granularity lists each local month", () => {
    const labels = rangeLabels({ start: new Date(2026, 0, 1), end: new Date(2026, 2, 1) }, "month");
    expect(labels).toEqual(["2026-01", "2026-02"]);
  });
});

describe("offsetModifier", () => {
  it("returns a minutes offset derived from local timezone", () => {
    expect(offsetModifier()).toMatch(/^[+-]\d+ minutes$/);
  });
});

describe("fillTrend", () => {
  it("fills missing buckets with 0 and keeps order", () => {
    const t = fillTrend(
      [{ bucket: "2026-08-02", income: 10, expense: 3 }],
      ["2026-08-01", "2026-08-02", "2026-08-03"]
    );
    expect(t.labels).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    expect(t.income).toEqual([0, 10, 0]);
    expect(t.expense).toEqual([0, 3, 0]);
  });
});

describe("buildBreakdown", () => {
  it("merges beyond top 6 into 其他 and names null category 未分类", () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      cid: n === 7 ? null : `c${n}`, name: n === 7 ? null : `类${n}`, icon: null, total: n,
    }));
    const data = buildBreakdown(rows);
    expect(data.segments).toHaveLength(7); // 6 + 其他
    expect(data.segments[6].id).toBe("other");
    expect(data.segments[6].isMerge).toBe(true);
    expect(data.list.find((s) => s.name === "未分类")?.total).toBe(7);
    expect(data.total).toBe(36);
    expect(data.list[0].percent).toBeCloseTo((8 / 36) * 100, 1);
  });
  it("no merge when ≤ 6 categories", () => {
    const data = buildBreakdown([{ cid: "c1", name: "类1", icon: null, total: 5 }]);
    expect(data.segments).toHaveLength(1);
    expect(data.segments[0].isMerge).toBeUndefined();
  });
});

describe("buildNetAssetSeries", () => {
  it("accumulates baseline + flows + new-account initials per bucket", () => {
    const labels = ["2026-08-01", "2026-08-02"];
    const values = buildNetAssetSeries(100, [
      { bucket: "2026-08-01", income: 10, expense: 5 },
      { bucket: "2026-08-02", income: 0, expense: 20 },
    ], [{ bucket: "2026-08-02", v: 1000 }], labels);
    expect(values).toEqual([105, 1085]);
  });
});

describe("computeDeltas", () => {
  it("null when prev is 0", () => {
    expect(computeDeltas({ income: 10, expense: 5, balance: 5 }, { income: 0, expense: 0, balance: 0 }))
      .toEqual({ incomeDeltaPct: null, expenseDeltaPct: null });
  });
  it("computes percent change", () => {
    expect(computeDeltas({ income: 120, expense: 80, balance: 40 }, { income: 100, expense: 100, balance: 0 }))
      .toEqual({ incomeDeltaPct: 20, expenseDeltaPct: -20 });
  });
});

describe("async aggregations via mocked db", () => {
  beforeEach(() => vi.clearAllMocks());
  const range: ReportRange = { start: new Date(2026, 7, 1), end: new Date(2026, 8, 1) };

  it("getPeriodTotals sums income/expense and computes balance", async () => {
    mockDb.select.mockResolvedValue([{ income: 100, expense: 30 }]);
    const t = await getPeriodTotals("l1", range);
    expect(t).toEqual({ income: 100, expense: 30, balance: 70 });
  });
  it("getTrend returns filled series and passes offset modifier", async () => {
    mockDb.select.mockResolvedValue([{ bucket: "2026-08-02", income: 10, expense: 3 }]);
    const t = await getTrend("l1", range, "day");
    expect(t.labels).toHaveLength(31);
    expect(t.income[1]).toBe(10);
    const sql = mockDb.select.mock.calls[0][0] as string;
    expect(sql).toContain("type!='transfer'");
    expect(sql).toContain("date(occurred_at,");
  });
  it("getCategoryBreakdown filters by type", async () => {
    mockDb.select.mockResolvedValue([]);
    const d = await getCategoryBreakdown("l1", "expense", range);
    expect(d.total).toBe(0);
    const sql = mockDb.select.mock.calls[0][0] as string;
    expect(sql).toContain("t.type=?");
  });
  it("getNetAssetSeries composes baseline + flows + initials", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ v: 100 }])   // historical flows
      .mockResolvedValueOnce([{ v: 50 }])    // accounts ≤ start
      .mockResolvedValueOnce([{ bucket: "2026-08-01", income: 10, expense: 0 }]) // flows
      .mockResolvedValueOnce([]);            // new accounts
    const s = await getNetAssetSeries("l1", range, "day");
    expect(s.values[0]).toBe(160);
  });
  it("getReportData orchestrates all four datasets", async () => {
    mockDb.select.mockResolvedValue([]);
    const d = await getReportData("l1", "month", 0);
    expect(d.totals.balance).toBe(0);
    expect(d.breakdownExpense.total).toBe(0);
    expect(d.breakdownIncome.total).toBe(0);
    // 采样点数 = 当前月的实际天数（与运行月份无关）
    const days = new Date(d.range.start.getFullYear(), d.range.start.getMonth() + 1, 0).getDate();
    expect(d.netAsset.labels).toHaveLength(days);
    expect(mockDb.select.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
