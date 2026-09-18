import { describe, it, expect, vi, beforeEach } from "vitest";

// mock 掉唯一碰 DB 的那一层。本文件只能证明「SQL 被正确地组织、整形、回传」，
// **证明不了「数字算得对」**——后者是 sqlSmoke.test.ts 在真实 SQLite 上做的事。
const mockDb = { select: vi.fn(), execute: vi.fn() };

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
}));

import { runQuery } from "@/services/ai/runQuery";
import type { LookupContext } from "@/services/ai/resolve";

const ctx: LookupContext = {
  categories: [{ id: "c-food", name: "买菜", type: "expense" }],
  accounts: [{ id: "a-cmb", name: "招行储蓄卡" }],
  tags: [{ id: "t-hm", name: "盒马" }],
  members: [{ id: "u-me", name: "我" }, { id: "u-wife", name: "老婆" }],
};

const emptyRow = {
  expense_total: 0, expense_count: 0, income_total: 0, income_count: 0,
  transfer_total: 0, transfer_count: 0, matched: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  // execute 若被调用就直接抛，而不是返回 undefined。
  //
  // 这不只是"更严格"：`vi.fn()` 返回 undefined 时，被变异成 `db.execute(...)` 的
  // runQuery 会拿着 undefined 继续往下走，在某些用例里最终崩在 `summaryRows[0]` 上，
  // 于是**测试确实是红的，但红的原因不是那条「绝不写库」的断言**——审查者据此无法
  // 判断真正的护栏在不在。让它当场抛，红的位置就精确落在那条越权调用上，
  // 且"execute 从未被调用"的断言在所有成功/失败用例里都能独立成立。
  mockDb.execute.mockImplementation(() => {
    throw new Error("runQuery 越权调用了 db.execute：AI 只能读，写操作只能产出草稿");
  });
});

describe("runQuery 校验与解析失败", () => {
  it("参数非法时不查库", async () => {
    const r = await runQuery("L1", { aggregate: "总数" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("invalid");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("raw 不是对象时是 not_an_object，且不查库", async () => {
    // 模型可能直接把 query 写成 JSON 字符串（"{\"aggregate\":\"sum\"}"）。那不是
    // 「字段写错」而是「形状错了」，模型需要的是 not_an_object 这条线索，
    // 否则它会盯着一个不存在的字段名反复改。
    const r = await runQuery("L1", "aggregate=sum", ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe("invalid");
      const codes = r.failure.kind === "invalid" ? r.failure.errors.map((e) => e.code) : [];
      expect(codes).toContain("not_an_object");
    }
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("名字解析不了时不查库", async () => {
    const r = await runQuery("L1", { aggregate: "sum", account: "工行" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("unresolved");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("没有 DB 连接时返回 no_db", async () => {
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValueOnce(null);
    const r = await runQuery("L1", { aggregate: "sum" }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("no_db");
  });

  it("失败路径下 execute 从未被调用", async () => {
    // 「AI 只读、写操作只能产出草稿」这条产品约束在 M1 的结构落点。
    // 成功路径的同类断言在各成功用例里；这里把三条失败分支一次性盖住。
    await runQuery("L1", { aggregate: "总数" }, ctx);
    await runQuery("L1", { aggregate: "sum", account: "工行" }, ctx);
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValueOnce(null);
    await runQuery("L1", { aggregate: "sum" }, ctx);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });
});

describe("runQuery 成功路径", () => {
  /**
   * DSL 没给 date 时 runQuery 会补一次 MIN/MAX 派生查询，**排在最后**。
   * 用本地时间构造再转 ISO，断言就不会依赖运行环境的时区。
   */
  function mockDeriveRange(min: Date | null = new Date(2026, 0, 1), max: Date | null = new Date(2026, 2, 15)) {
    mockDb.select.mockResolvedValueOnce([
      { min_at: min === null ? null : min.toISOString(), max_at: max === null ? null : max.toISOString() },
    ]);
  }

  it("只跑汇总时 groups / items 为 null", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, expense_total: 800, expense_count: 2, matched: 2 }]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "sum", type: "expense" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.expense).toEqual({ total: 800, count: 2, avg: 400 });
      expect(r.result.income).toBeNull();
      expect(r.result.groups).toBeNull();
      expect(r.result.items).toBeNull();
      expect(r.result.truncated).toBe(false);
    }
    // 汇总 + 派生区间
    expect(mockDb.select).toHaveBeenCalledTimes(2);
    // 只读：本模块绝不写库。
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("groupBy=member 时把 user_id 换成成员名", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 1, matched: 2 }])
      .mockResolvedValueOnce([
        { key: "u-wife", expense_total: 100, income_total: 0, transfer_total: 0, cnt: 1 },
        { key: "u-unknown", expense_total: 20, income_total: 0, transfer_total: 0, cnt: 1 },
      ]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "sum", groupBy: "member" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 解析得到的用显示名；解析不到的退回 id 前 8 位，绝不把完整 UUID 交给模型。
      expect(r.result.groups!.map((g) => g.label)).toEqual(["老婆", "u-unknow"]);
    }
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("groupBy 不是 member 时不碰 label", async () => {
    // 反例守卫：若把替换写成无条件执行，分类名「买菜」会被切/查表得莫名其妙。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 1, matched: 1 }])
      .mockResolvedValueOnce([
        { key: "买菜", expense_total: 100, income_total: 0, transfer_total: 0, cnt: 1 },
      ]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "sum", groupBy: "category" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.groups!.map((g) => g.label)).toEqual(["买菜"]);
  });

  it("aggregate=list 时返回明细，且 matched 大于条数时标记 truncated", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 300, expense_count: 30, matched: 30 }])
      .mockResolvedValueOnce([
        { day: "2026-03-02", amount: 10, type: "expense", category_name: "买菜", from_account_name: "招行", to_account_name: null, note: "盒马" },
        { day: "2026-03-01", amount: 20, type: "expense", category_name: "买菜", from_account_name: "招行", to_account_name: null, note: null },
      ]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "list", type: "expense" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.items).toHaveLength(2);
      expect(r.result.truncated).toBe(true);
    }
  });

  it("明细条数不少于 matched 时 truncated 为 false", async () => {
    // 反向守卫：`truncated` 若恒为 true，上面那条用例照样绿。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 30, expense_count: 2, matched: 2 }])
      .mockResolvedValueOnce([
        { day: "2026-03-02", amount: 10, type: "expense", category_name: null, from_account_name: null, to_account_name: null, note: null },
        { day: "2026-03-01", amount: 20, type: "expense", category_name: null, from_account_name: null, to_account_name: null, note: null },
      ]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "list", type: "expense" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.truncated).toBe(false);
  });

  it("没有分组、也不是 list 时只有一次查询（除派生外不碰库）", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, matched: 0 }]);
    const r = await runQuery(
      "L1",
      { aggregate: "sum", date: { preset: "thisYear" } },
      ctx,
      new Date(2026, 5, 15),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.groups).toBeNull();
      expect(r.result.items).toBeNull();
      expect(r.result.truncated).toBe(false);
    }
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("分组撞到 LIMIT 时标记 truncated：tag 分组会扇出，桶数可以大于 matched", async () => {
    // 审查 Important（I-1）的回归用例。**这条替代了原来那条期望为 true 的用例**
    // （matched=12、1 个桶），原来那条在修正后的语义下是**错的**：1 个桶覆盖全部 12 笔，
    // 分布是完整的，本该报 false。旧规则 `matched > groups.length` 把"桶比笔数少"
    // 误当成"被截断"——对不扇出的分组，桶的和恒等于 matched，桶少只说明分布集中。
    //
    // 场景：8 笔交易、每笔挂多个标签 → 真实桶 15 个、只返回 10 个（默认 limit=10）。
    // 注意 matched(8) < groups.length(10)：**桶数大于命中数**，这正是 tag 分组扇出的特征，
    // 也正是旧规则失效的原因。任何"桶数不会超过命中数"的直觉在这里都是错的。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 800, expense_count: 8, matched: 8 }])
      .mockResolvedValueOnce(
        Array.from({ length: 10 }, (_, i) => ({
          key: `标签${i}`,
          expense_total: 80,
          income_total: 0,
          transfer_total: 0,
          cnt: 1,
        })),
      );
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "sum", groupBy: "tag" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.truncated).toBe(true);
  });

  it("桶数少于 matched 但没撞到 LIMIT 时不标记 truncated（分布是完整的）", async () => {
    // 这条钉住被修正后的语义。12 笔交易、只有 1 个分类桶、limit 还是默认 10：
    // **1 个桶覆盖了全部 12 笔**，分布是完整的，不该报 truncated。
    // 旧规则（`matched > groups.length` → 12 > 1 → true）会在这里误报。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 12, matched: 12 }])
      .mockResolvedValueOnce([
        { key: "买菜", expense_total: 100, income_total: 0, transfer_total: 0, cnt: 12 },
      ]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "sum", groupBy: "category" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.truncated).toBe(false);
  });

  it("把 orderBy / limit / 账本 / 筛选原样转发给构造函数，且发出去的 SQL 全是 SELECT", async () => {
    // 审查 M-4 + S-3 的回归。此前 mock 的 select 从不看 SQL/params，只按调用顺序吐预置行，
    // 所以 `buildItemsSql(ledgerId, { aggregate: "list" }, f)`（丢掉 orderBy/limit 转发）
    // 这类改动在本文件与 sqlSmoke 上 **31/31 全绿**——审查实测过。
    // 同一个盲区还让"把汇总换成 DELETE"或"把 ledgerId 换成别的账本"零覆盖（S-3）。
    // 这条用例把"发出去的到底是什么"钉住：断言 SQL 片段与 params 本身。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 10, expense_count: 1, matched: 1 }])
      .mockResolvedValueOnce([])  // 分组
      .mockResolvedValueOnce([])  // 明细
      .mockResolvedValueOnce([{ min_at: null, max_at: null }]);  // 派生区间（无 date 时排在最后）
    const r = await runQuery(
      "L1",
      { aggregate: "list", groupBy: "tag", type: "expense", orderBy: "date_asc", limit: 5 },
      ctx,
    );
    expect(r.ok).toBe(true);
    // 调用顺序固定：汇总 → 分组 → 明细 → 派生区间
    expect(mockDb.select).toHaveBeenCalledTimes(4);

    const [summarySql, summaryParams] = mockDb.select.mock.calls[0];
    // ledgerId 与 f 的转发：任一被换掉，这两条都会红
    expect(summaryParams).toEqual(["L1", "expense"]);
    expect(summarySql).toContain("t.ledger_id = ?");

    const [groupsSql, groupsParams] = mockDb.select.mock.calls[1];
    expect(groupsParams).toEqual(["L1", "expense"]);
    expect(groupsSql).toContain("GROUP BY key");
    expect(groupsSql).toContain("LIMIT 5");            // q.limit 转发：丢掉会退回默认 10
    expect(groupsSql).toContain("ORDER BY key ASC");   // q.orderBy 转发：丢掉会退回 DESC

    const [itemsSql, itemsParams] = mockDb.select.mock.calls[2];
    expect(itemsParams).toEqual(["L1", "expense"]);
    expect(itemsSql).toContain("LIMIT 5");                  // 丢掉会退回 AI_QUERY_MAX_ITEMS(20)
    expect(itemsSql).toContain("ORDER BY t.occurred_at ASC"); // 丢掉会退回 DESC，请求与结果相反

    expect(mockDb.execute).not.toHaveBeenCalled();
    // 「发出去的语句必须是 SELECT」这条不变式单独一条用例（下一条），
    // 拆开才能说清是**哪条断言**在杀哪个变异——挤在这里会被上面任何一条先打红，
    // 那个断言就永远证明不了自己能杀人。
  });

  it("只读不变式：所有发出去的语句都以 SELECT 开头", async () => {
    // 审查 S-3：此前只钉了"走 select 而不是 execute"，把汇总换成
    // `select("DELETE FROM transactions")` 照样 19/19 全绿（审查实测）。
    // 「AI 只能读 + 只产出草稿」是产品约束，值得在**语句层面**明说：
    // 只要 select 上出现非查询语句，就是越权，不管它长得像不像一次查询。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, matched: 0 }])
      .mockResolvedValueOnce([{ min_at: null, max_at: null }]);
    const r = await runQuery("L1", { aggregate: "sum" }, ctx);
    expect(r.ok).toBe(true);
    expect(mockDb.select).toHaveBeenCalledTimes(2);
    for (const [sql] of mockDb.select.mock.calls) {
      expect(String(sql).trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  it("分组条数不少于 matched 时不标记 truncated", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 3, matched: 2 }])
      .mockResolvedValueOnce([
        { key: "买菜", expense_total: 60, income_total: 0, transfer_total: 0, cnt: 2 },
        { key: "外卖", expense_total: 40, income_total: 0, transfer_total: 0, cnt: 1 },
      ]);
    mockDeriveRange();
    const r = await runQuery("L1", { aggregate: "sum", groupBy: "category" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.groups).toHaveLength(2);
      expect(r.result.truncated).toBe(false);
    }
  });

  it("回传 applied 供芯片渲染", async () => {
    mockDb.select.mockResolvedValueOnce([emptyRow]);
    const r = await runQuery(
      "L1",
      { aggregate: "sum", account: "招行储蓄卡", merchant: "盒马", date: { preset: "thisYear" } },
      ctx,
      new Date(2026, 5, 15),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied.account).toEqual({ id: "a-cmb", name: "招行储蓄卡" });
      expect(r.applied.merchant).toBe("盒马");
      expect(r.applied.dateFrom).toBe("2026-01-01");
      expect(r.applied.dateTo).toBe("2026-12-31");
    }
    // 有日期时不派生，只有汇总这一次查询
    expect(mockDb.select).toHaveBeenCalledTimes(1);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });
});

describe("runQuery 派生「不限时间」的真实区间", () => {
  function mockDeriveRange(min: string | null, max: string | null) {
    mockDb.select.mockResolvedValueOnce([{ min_at: min, max_at: max }]);
  }

  it("DSL 没给 date 时用 MIN/MAX 派生出覆盖全部数据的区间", async () => {
    // 首页把「零条件」当成「默认查当月」，所以"不限时间"光靠"不带日期"表达不出来。
    // 把它变成显式区间，芯片跳转才不会悄悄缩成当月——这是这个分支存在的全部理由。
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 1, matched: 1 }]);
    mockDeriveRange(new Date(2026, 0, 1).toISOString(), new Date(2026, 2, 15).toISOString());

    const r = await runQuery("L1", { aggregate: "sum", merchant: "盒马" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied.dateFrom).toBe("2026-01-01");
      expect(r.applied.dateTo).toBe("2026-03-15");
    }
  });

  it("派生查询仍然带账本隔离与软删过滤", async () => {
    mockDb.select.mockResolvedValueOnce([emptyRow]);
    mockDeriveRange(new Date(2026, 0, 1).toISOString(), new Date(2026, 2, 15).toISOString());

    await runQuery("L1", { aggregate: "sum" }, ctx);

    const [sql, params] = mockDb.select.mock.calls[1];
    expect(sql).toContain("MIN(t.occurred_at)");
    expect(sql).toContain("MAX(t.occurred_at)");
    expect(sql).toContain("t.ledger_id = ?");
    expect(sql).toContain("t.is_deleted = 0");
    // 整串断言：点名断言抓不住「过滤条件还在、但参数错位/多一个」这类等价写法（R46/R47）。
    expect(sql).toBe(
      "SELECT MIN(t.occurred_at) AS min_at, MAX(t.occurred_at) AS max_at" +
      " FROM transactions t WHERE t.ledger_id = ? AND t.is_deleted = 0",
    );
    expect(params).toEqual(["L1"]);
    // 派生区间也走 select，绝不走 execute。
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("已有 date 条件时不派生", async () => {
    mockDb.select.mockResolvedValueOnce([emptyRow]);
    const r = await runQuery("L1", { aggregate: "sum", date: { preset: "today" } }, ctx, new Date(2026, 5, 15));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied.dateFrom).toBe("2026-06-15");
      expect(r.applied.dateTo).toBe("2026-06-15");
    }
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });

  it("账本一笔记录都没有时不派生，applied 的日期保持 null", async () => {
    mockDb.select.mockResolvedValueOnce([emptyRow]);
    mockDeriveRange(null, null);
    const r = await runQuery("L1", { aggregate: "sum" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied.dateFrom).toBeNull();
      expect(r.applied.dateTo).toBeNull();
    }
  });

  it("只有 min 或只有 max 时同样不派生（半边区间会静默截掉一半数据）", async () => {
    mockDb.select.mockResolvedValueOnce([emptyRow]);
    mockDeriveRange(new Date(2026, 0, 1).toISOString(), null);
    const r = await runQuery("L1", { aggregate: "sum" }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.applied.dateFrom).toBeNull();
      expect(r.applied.dateTo).toBeNull();
    }
  });
});
