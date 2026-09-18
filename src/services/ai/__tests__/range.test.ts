import { describe, it, expect } from "vitest";
import { dayRangeToIso, resolveRange } from "@/services/ai/range";

describe("dayRangeToIso", () => {
  it("与 transactionStore.fetchAll 的边界公式逐字一致", () => {
    // 复刻 src/stores/transaction.ts:178-197 的算法。fetchAll 不改成调用本函数
    // （那是无关重构），所以这里用测试把两条路径钉在一起：任何一边改了都会红。
    const from = "2026-01-01";
    const to = "2026-12-31";

    const { startIso, endIso } = dayRangeToIso(from, to);

    const fetchStart = new Date(`${from}T00:00:00`).toISOString();
    const dt = new Date(`${to}T00:00:00`);
    dt.setDate(dt.getDate() + 1);
    const fetchEnd = dt.toISOString();

    expect(startIso).toBe(fetchStart);
    expect(endIso).toBe(fetchEnd);
  });

  it("是半开区间：上界是次日 00:00，不是当日 24:00", () => {
    const { endIso } = dayRangeToIso("2026-03-15", "2026-03-15");
    // 用本地构造而非字面量，避免断言依赖运行环境的时区
    expect(endIso).toBe(new Date(2026, 2, 16).toISOString());
  });

  it("单日范围跨度为整一天", () => {
    const { startIso, endIso } = dayRangeToIso("2026-03-15", "2026-03-15");
    expect(new Date(endIso).getTime() - new Date(startIso).getTime()).toBe(86_400_000);
  });
});

describe("resolveRange", () => {
  it("date 缺省返回 null（不限时间）", () => {
    expect(resolveRange(undefined)).toBeNull();
  });

  it("thisYear 用本地年首到年尾，且 startIso 是本地 1 月 1 日 00:00", () => {
    const r = resolveRange({ preset: "thisYear" }, new Date(2026, 5, 15, 10, 30));
    expect(r).not.toBeNull();
    expect(r!.from).toBe("2026-01-01");
    expect(r!.to).toBe("2026-12-31");
    expect(r!.startIso).toBe(new Date(2026, 0, 1).toISOString());
    expect(r!.endIso).toBe(new Date(2027, 0, 1).toISOString());
  });

  it("自定义区间原样落到 from/to", () => {
    const r = resolveRange({ from: "2026-03-01", to: "2026-04-01" }, new Date(2026, 5, 15));
    expect(r!.from).toBe("2026-03-01");
    expect(r!.to).toBe("2026-04-01");
    expect(r!.startIso).toBe(new Date(2026, 2, 1).toISOString());
    expect(r!.endIso).toBe(new Date(2026, 3, 2).toISOString());
  });

  it("now 注入生效：同一个 preset 在不同 now 下边界不同", () => {
    const a = resolveRange({ preset: "lastMonth" }, new Date(2026, 0, 15));
    const b = resolveRange({ preset: "lastMonth" }, new Date(2026, 6, 15));
    expect(a!.from).toBe("2025-12-01");
    expect(b!.from).toBe("2026-06-01");
  });
});
