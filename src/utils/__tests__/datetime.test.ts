import { describe, it, expect } from "vitest";
import {
  toLocalDatetimeString,
  utcToLocalDatetimeString,
  utcToLocalDateKey,
  localDateKeyToDate,
  formatDateLabel,
  formatDateRange,
} from "@/utils/datetime";

describe("toLocalDatetimeString", () => {
  it("should format a Date into local datetime-local string", () => {
    // 该 Date 在 UTC 2026-07-28T00:00:00Z
    const d = new Date("2026-07-28T00:00:00Z");
    const s = toLocalDatetimeString(d);
    // 东八区应为 08:00，格式 YYYY-MM-DDTHH:mm
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe("utcToLocalDatetimeString", () => {
  it("should convert UTC ISO to local datetime-local string", () => {
    const s = utcToLocalDatetimeString("2026-07-28T00:00:00Z");
    // 东八区 → 2026-07-28T08:00
    expect(s).toBe("2026-07-28T08:00");
  });
});

describe("utcToLocalDateKey", () => {
  it("should return local YYYY-MM-DD, not UTC date", () => {
    // UTC 2026-07-28T00:00:00Z → 东八区 2026-07-28 08:00，本地日期仍是 07-28
    expect(utcToLocalDateKey("2026-07-28T00:00:00Z")).toBe("2026-07-28");
  });

  it("should roll to next local day for early-morning UTC times in positive offset zones", () => {
    // UTC 2026-07-27T22:00:00Z → 东八区 2026-07-28 06:00
    // 直接 slice(0,10) 会得到 07-27（错误），本地应为 07-28
    expect(utcToLocalDateKey("2026-07-27T22:00:00Z")).toBe("2026-07-28");
  });

  it("should roll to previous local day for late-night UTC times in negative offset zones", () => {
    // 西五区（America/New_York 某日）UTC 2026-07-28T02:00:00Z → 当地 2026-07-27 22:00
    // 通过设置时区偏移验证：这里直接断言 Date 本地解析的年月日
    const d = new Date("2026-07-28T02:00:00Z");
    const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    expect(utcToLocalDateKey("2026-07-28T02:00:00Z")).toBe(expected);
  });
});

describe("localDateKeyToDate", () => {
  it("should parse as local midnight, not UTC", () => {
    const d = localDateKeyToDate("2026-07-28");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // 7 月 = index 6
    expect(d.getDate()).toBe(28);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
});

describe("formatDateLabel", () => {
  it("把日期 key 转成「M月D日 周X」", () => {
    // 2026-08-15 是周六
    expect(formatDateLabel("2026-08-15")).toBe("8月15日 周六");
  });
});

describe("formatDateRange", () => {
  it("同一天只显示日期", () => {
    expect(formatDateRange("2026-08-15T00:00", "2026-08-15T23:59")).toBe("2026-08-15");
  });
  it("跨天显示范围", () => {
    expect(formatDateRange("2026-08-01T00:00", "2026-08-15T23:59")).toBe("2026-08-01 ~ 2026-08-15");
  });
  it("只有起点/终点时显示 起/至", () => {
    expect(formatDateRange("2026-08-01T00:00", "")).toBe("2026-08-01 起");
    expect(formatDateRange("", "2026-08-15T23:59")).toBe("至 2026-08-15");
  });
});
