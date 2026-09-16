import { describe, it, expect } from "vitest";
import {
  WEEK_START,
  PRESETS,
  buildMonthGrid,
  buildPresetRange,
  weekdayHeaders,
  normalizeRange,
  diffDaysInclusive,
  formatRangeLabel,
  matchPreset,
  addDays,
  addMonths,
  daysInMonth,
  toDateKey,
} from "@/utils/dateRange";

// 用本地分量构造，保证断言与运行环境时区无关
function local(y: number, m: number, d: number): Date {
  return new Date(y, m - 1, d, 10, 0);
}

describe("toDateKey", () => {
  it("取本地日期而非 UTC 日期", () => {
    // 本地 2026-08-15 00:30，UTC 可能是前一天
    expect(toDateKey(new Date(2026, 7, 15, 0, 30))).toBe("2026-08-15");
  });
});

describe("addDays", () => {
  it("跨月与跨年", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("闰年 2 月 29 日可被访问", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });
});

describe("addMonths / daysInMonth", () => {
  it("跨年前后平移", () => {
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -13)).toEqual({ year: 2024, month: 12 });
  });

  it("各月天数含闰年", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 8)).toBe(31);
  });
});

describe("buildMonthGrid", () => {
  it("周一首日：2026-06-01 是周一，落在第 0 格", () => {
    expect(WEEK_START).toBe(1);
    const grid = buildMonthGrid(2026, 6);
    expect(grid).toHaveLength(42);
    expect(grid[0]).toBe("2026-06-01");
  });

  it("月首前留空且固定 42 格（切月不跳高度）", () => {
    // 2026-08-01 是周六 → 周一为首日时前面空 5 格
    const aug = buildMonthGrid(2026, 8);
    expect(aug).toHaveLength(42);
    expect(aug.slice(0, 5).every((c) => c === null)).toBe(true);
    expect(aug[5]).toBe("2026-08-01");
    expect(aug[35]).toBe("2026-08-31");
    expect(aug.slice(36).every((c) => c === null)).toBe(true);

    // 2026-02-01 是周日 → 前面空 6 格
    const feb = buildMonthGrid(2026, 2);
    expect(feb).toHaveLength(42);
    expect(feb.slice(0, 6).every((c) => c === null)).toBe(true);
    expect(feb[6]).toBe("2026-02-01");
    expect(feb[33]).toBe("2026-02-28");
  });

  it("闰年 2 月含 29 日", () => {
    const feb = buildMonthGrid(2028, 2);
    expect(feb).toContain("2028-02-29");
  });

  it("星期表头与列顺序对齐（周一首日）", () => {
    expect(weekdayHeaders()).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    expect(weekdayHeaders(0)).toEqual(["日", "一", "二", "三", "四", "五", "六"]);
  });
});

describe("normalizeRange", () => {
  it("反序输入交换两端", () => {
    expect(normalizeRange("2026-08-15", "2026-08-01")).toEqual({
      start: "2026-08-01",
      end: "2026-08-15",
    });
  });

  it("单边与空值原样保留", () => {
    expect(normalizeRange("2026-08-01", "")).toEqual({ start: "2026-08-01", end: "" });
    expect(normalizeRange("", "2026-08-15")).toEqual({ start: "", end: "2026-08-15" });
    expect(normalizeRange("", "")).toEqual({ start: "", end: "" });
  });
});

describe("diffDaysInclusive", () => {
  it("含首尾计数", () => {
    expect(diffDaysInclusive("2026-08-15", "2026-08-15")).toBe(1);
    expect(diffDaysInclusive("2026-08-01", "2026-08-15")).toBe(15);
    expect(diffDaysInclusive("2025-12-31", "2026-01-01")).toBe(2);
  });

  it("反序输入先归一化；缺端点返回 0", () => {
    expect(diffDaysInclusive("2026-08-15", "2026-08-01")).toBe(15);
    expect(diffDaysInclusive("2026-08-01", "")).toBe(0);
  });
});

describe("buildPresetRange", () => {
  it("2026-08-15（周六）的各快捷范围", () => {
    const now = local(2026, 8, 15);
    expect(buildPresetRange("today", now)).toEqual({ start: "2026-08-15", end: "2026-08-15" });
    expect(buildPresetRange("yesterday", now)).toEqual({ start: "2026-08-14", end: "2026-08-14" });
    // 本周一 8/10 - 本周日 8/16
    expect(buildPresetRange("thisWeek", now)).toEqual({ start: "2026-08-10", end: "2026-08-16" });
    expect(buildPresetRange("lastWeek", now)).toEqual({ start: "2026-08-03", end: "2026-08-09" });
    expect(buildPresetRange("thisMonth", now)).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(buildPresetRange("lastMonth", now)).toEqual({ start: "2026-07-01", end: "2026-07-31" });
    expect(buildPresetRange("last7Days", now)).toEqual({ start: "2026-08-09", end: "2026-08-15" });
    expect(buildPresetRange("last30Days", now)).toEqual({ start: "2026-07-17", end: "2026-08-15" });
    // 自然月计（含当月），与 useReports 的 twelveMonths 口径一致
    expect(buildPresetRange("last3Months", now)).toEqual({ start: "2026-06-01", end: "2026-08-31" });
    expect(buildPresetRange("last6Months", now)).toEqual({ start: "2026-03-01", end: "2026-08-31" });
    expect(buildPresetRange("thisYear", now)).toEqual({ start: "2026-01-01", end: "2026-12-31" });
    expect(buildPresetRange("lastYear", now)).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("周日仍属本周（周一为首日）", () => {
    const now = local(2026, 8, 16); // 周日
    expect(buildPresetRange("thisWeek", now)).toEqual({ start: "2026-08-10", end: "2026-08-16" });
    expect(buildPresetRange("lastWeek", now)).toEqual({ start: "2026-08-03", end: "2026-08-09" });
  });

  it("跨年：1 月初的上月/上周/近 3 月", () => {
    const now = local(2026, 1, 5); // 周一
    expect(buildPresetRange("thisWeek", now)).toEqual({ start: "2026-01-05", end: "2026-01-11" });
    expect(buildPresetRange("lastWeek", now)).toEqual({ start: "2025-12-29", end: "2026-01-04" });
    expect(buildPresetRange("lastMonth", now)).toEqual({ start: "2025-12-01", end: "2025-12-31" });
    expect(buildPresetRange("last3Months", now)).toEqual({ start: "2025-11-01", end: "2026-01-31" });
    expect(buildPresetRange("lastYear", now)).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("闰年 2 月：本月到 29 日，上年可落在闰年", () => {
    expect(buildPresetRange("thisMonth", local(2028, 2, 10))).toEqual({
      start: "2028-02-01",
      end: "2028-02-29",
    });
    expect(buildPresetRange("lastYear", local(2025, 1, 10))).toEqual({
      start: "2024-01-01",
      end: "2024-12-31",
    });
  });

  it("每个快捷项都有展示标签", () => {
    for (const p of PRESETS) {
      expect(p.label.length).toBeGreaterThan(0);
    }
    // chips 首屏放用户点名的高频项
    expect(PRESETS.slice(0, 5).map((p) => p.key)).toEqual([
      "thisMonth",
      "lastMonth",
      "thisWeek",
      "thisYear",
      "lastYear",
    ]);
  });
});

describe("matchPreset", () => {
  const now = local(2026, 8, 15);

  it("命中快捷范围时返回其 key", () => {
    expect(matchPreset(buildPresetRange("thisMonth", now), now)).toBe("thisMonth");
    expect(matchPreset(buildPresetRange("lastYear", now), now)).toBe("lastYear");
  });

  it("手动改过的范围失配 → 高亮消失", () => {
    expect(matchPreset({ start: "2026-08-01", end: "2026-08-14" }, now)).toBeNull();
  });

  it("单边范围不高亮", () => {
    expect(matchPreset({ start: "2026-08-01", end: "" }, now)).toBeNull();
    expect(matchPreset({ start: "", end: "" }, now)).toBeNull();
  });
});

describe("formatRangeLabel", () => {
  it("同一天只显示一个日期", () => {
    expect(formatRangeLabel("2026-08-15", "2026-08-15")).toBe("2026年8月15日");
  });

  it("同年压缩年份并带天数", () => {
    expect(formatRangeLabel("2026-08-01", "2026-08-15")).toBe("2026年8月1日 - 8月15日 · 15天");
  });

  it("跨年两端都带年份", () => {
    expect(formatRangeLabel("2025-12-31", "2026-01-01")).toBe("2025年12月31日 - 2026年1月1日 · 2天");
  });

  it("单边显示 起 / 至", () => {
    expect(formatRangeLabel("2026-08-01", "")).toBe("2026年8月1日 起");
    expect(formatRangeLabel("", "2026-08-15")).toBe("至 2026年8月15日");
  });

  it("两端为空返回空串", () => {
    expect(formatRangeLabel("", "")).toBe("");
  });
});
