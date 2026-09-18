import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { DatabaseSync } from "node:sqlite";

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
  getCurrentUserId: vi.fn(() => "local-user-1"),
  openUserDb: vi.fn(),
  closeUserDb: vi.fn(),
}));

// Mock account store
const mockFetchAll = vi.fn();
vi.mock("@/stores/account", () => ({
  useAccountStore: vi.fn(() => ({
    fetchAll: mockFetchAll,
  })),
}));

vi.mock("@/services/sync", () => ({
  enqueueSync: vi.fn(),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: vi.fn(() => ({ isAuthenticated: true })),
}));

// 包一层 spy 但保留真实实现：只有「fetchAll 真的调用了共用片段」这一层能被行为性钉住。
// 纯文本断言（sql 里含片段文本）抓不住「手抄一份逐字相同的 SQL」——那种副本产出的 SQL
// 字符串与调用共用片段**完全相同**，任何字符串比较都区分不了，只有调用记录能区分。
// 这正是 ledger R34-3 要求的：不能让 like.ts 的注释变成空头支票。
vi.mock("@/utils/like", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/like")>();
  return { ...actual, noteOrTagLikeClause: vi.fn(actual.noteOrTagLikeClause) };
});

import { enqueueSync } from "@/services/sync";
import { useTransactionStore } from "@/stores/transaction";
import { dayRangeToIso } from "@/services/ai/range";
import { noteOrTagLikeClause } from "@/utils/like";
import { buildWhere } from "@/services/ai/querySql";
import type { ResolvedFilter } from "@/services/ai/resolve";
import type { Transaction } from "@/types";

function makeTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "tx-1",
    ledger_id: "pl-1",
    user_id: "u-1",
    amount: 100,
    type: "expense",
    from_account_id: "acc-1",
    to_account_id: null,
    category_id: "cat-1",
    note: null,
    occurred_at: "2026-06-09T12:00:00Z",
    created_at: "2026-06-09T12:00:00Z",
    updated_at: "2026-06-09T12:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

describe("transactionStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load transactions with joined category, tags, and accounts", async () => {
      const row = {
        id: "tx-1",
        ledger_id: "pl-1",
        user_id: "u-1",
        amount: 32.5,
        type: "expense",
        from_account_id: "acc-1",
        to_account_id: null,
        category_id: "cat-1",
        note: null,
        occurred_at: "2026-06-09T12:00:00Z",
        created_at: "2026-06-09T12:00:00Z",
        updated_at: "2026-06-09T12:00:00Z",
        is_deleted: 0,
        category_name: "餐饮",
        category_type: "expense",
        category_icon: "🍜",
        category_sort_order: 1,
        tag_ids: "tag-1,tag-2",
        tag_names: "午餐,工作日",
        from_account_name: "招行卡",
        from_account_type: "bank",
        from_account_color: "#ef4444",
        to_account_name: null,
        to_account_type: null,
        to_account_color: null,
      };
      mockDb.select.mockResolvedValueOnce([row]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.transactions).toHaveLength(1);
      const tx = store.transactions[0];
      expect(tx.amount).toBe(32.5);
      expect(tx.category).toMatchObject({
        id: "cat-1",
        name: "餐饮",
        type: "expense",
        icon: "🍜",
        sort_order: 1,
      });
      expect(tx.tags).toHaveLength(2);
      expect(tx.tags![0]).toMatchObject({ id: "tag-1", name: "午餐" });
      expect(tx.from_account).toMatchObject({
        id: "acc-1",
        name: "招行卡",
        type: "bank",
        color: "#ef4444",
      });
      expect(tx.to_account).toBeUndefined();
    });

    it("should filter by account when accountId is provided", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { accountId: "acc-2" });

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("AND (t.from_account_id = ? OR t.to_account_id = ?)"),
        ["pl-1", "acc-2", "acc-2"]
      );
    });

    it("should return empty when no transactions", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.transactions).toHaveLength(0);
    });

    it("dateTo 上界含所选分钟（+1 分钟），避免月末 23:59 交易漏显", async () => {
      mockDb.select.mockResolvedValue([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { dateTo: "2026-08-31T23:59" });

      const sql = mockDb.select.mock.calls[0][0] as string;
      const params = mockDb.select.mock.calls[0][1] as string[];
      const expected = new Date("2026-08-31T23:59");
      expected.setMinutes(expected.getMinutes() + 1);

      expect(sql).toContain("t.occurred_at <");
      expect(params).toEqual(["pl-1", expected.toISOString()]);
    });

    it("dateTo 不带时刻时上界取次日 00:00，且与 ai/range 的 dayRangeToIso 同值", async () => {
      // 这条同时钉住两侧：既调**真实的** fetchAll，又调**真实的** dayRangeToIso。
      // 任一侧漂移（例如 fetchAll 改成 UTC 解析、或 range.ts 少加一天）都会变红——
      // 这是「AI 回答里的数字与点进流水页看到的必须一致」唯一由测试维持的地方。
      mockDb.select.mockResolvedValue([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { dateFrom: "2026-08-01", dateTo: "2026-08-31" });

      const sql = mockDb.select.mock.calls[0][0] as string;
      const params = mockDb.select.mock.calls[0][1] as string[];
      const range = dayRangeToIso("2026-08-01", "2026-08-31");

      expect(sql).toContain("t.occurred_at >= ?");
      expect(sql).toContain("t.occurred_at <");
      expect(params).toEqual(["pl-1", range.startIso, range.endIso]);
    });

    it("应按收支类型过滤", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { type: "income" });

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("AND t.type = ?"),
        ["pl-1", "income"],
      );
    });

    it("type=transfer 也走进 SQL（转账是合法类型，不能被守卫漏掉）", async () => {
      // 修前实测：把 `if (opts?.type)` 改成 `if (opts?.type && opts.type !== "transfer")`
      // （丢弃 transfer）→ 36/36 全绿。transfer 是用户能选的合法类型，M1 的「转账」芯片
      // 会产出它；丢弃它等于那一跳静默变成「不按类型过滤」，两侧都不报错（同 R45 家族）。
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { type: "transfer" });

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("AND t.type = ?"),
        ["pl-1", "transfer"],
      );
    });

    it("应按备注关键词过滤，同时匹配标签名并转义 LIKE 元字符", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { noteKeyword: "50%" });

      const [sql, params] = mockDb.select.mock.calls[0] as [string, (string | number)[]];
      expect(sql).toContain("t.note LIKE ? ESCAPE '\\'");
      // 片段来自 utils/like 的共用实现，子查询别名是 sq_tg（避开 QUERY 外层的 tg）
      expect(sql).toContain("sq_tg.name LIKE ? ESCAPE '\\'");
      expect(sql).toContain("sq_tg.is_deleted = 0");
      // 「复用共用片段」这一条必须靠调用记录钉：上面那几条文本断言只能抓「片段被改写」，
      // 抓不住「手抄一份逐字相同的 SQL」（实测该变异下三条文本断言全绿，见报告 M1b）。
      expect(vi.mocked(noteOrTagLikeClause)).toHaveBeenCalledTimes(1);
      expect(sql).toContain(noteOrTagLikeClause());
      // 元字符被转义：% 变成 \%
      expect(params).toEqual(["pl-1", "%50\\%%", "%50\\%%"]);
    });

    it("应按金额区间过滤，且 0 是有效下界", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { amountMin: 0, amountMax: 500 });

      const [sql, params] = mockDb.select.mock.calls[0] as [string, (string | number)[]];
      expect(sql).toContain("AND t.amount >= ?");
      expect(sql).toContain("AND t.amount <= ?");
      expect(params).toEqual(["pl-1", 0, 500]);
    });

    it("多个新条件可以叠加，参数顺序与 SQL 顺序一致", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", {
        type: "expense",
        noteKeyword: "盒马",
        amountMin: 10,
        accountId: "acc-2",
      });

      const [sql, params] = mockDb.select.mock.calls[0] as [string, (string | number)[]];
      expect(params).toEqual(["pl-1", "expense", "acc-2", "acc-2", "%盒马%", "%盒马%", 10]);
      // 账户条件在关键词之前、金额在最后，与实现里的拼接顺序一致
      expect(sql.indexOf("t.type = ?")).toBeLessThan(sql.indexOf("t.note LIKE ?"));
      expect(sql.indexOf("t.note LIKE ?")).toBeLessThan(sql.indexOf("t.amount >= ?"));
    });

    // 简报外的补充用例：现有用例没有一处钉住 QUERY 里恒定的 `t.is_deleted = 0`，
    // 去掉它（软删交易会重新出现在流水页）当前全绿 —— 静默错数据且无人拦截。
    // ⚠️ 用例名的限定（审查：「软删交易不进列表」超出文本断言的能力）：这条只比对 SQL 文本，
    // mock db 不执行 SQL，所以「不进列表」是**行为声明**，由下面
    // `fetchAll 的执行级回归（真实 node:sqlite）` 那条真跑去证明；本条只钉文本形状。
    it("QUERY 的 WHERE 段恰好是 ledger_id 与 is_deleted 两个恒定条件", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1", { type: "income" });

      const [sql, params] = mockDb.select.mock.calls[0] as [string, (string | number)[]];
      // 取出的 WHERE 段做**空白归一化后整段相等**，一次修掉两个毛病：
      //   过紧：原来 `toContain("WHERE … = 0")` 会因为语义相同的换行而误红（审查 T9-6）；
      //   过松：原来只要求这段文本作为连续子串存在，在其后追加任何恒定条件（审查 T9-7
      //         追加 `AND t.amount > -1`）都不报 —— 整段相等就绕不过去了。
      const whereSegment = sql
        .slice(sql.indexOf("WHERE"), sql.indexOf("GROUP BY"))
        .replace(/\s+/g, " ")
        .trim();
      expect(whereSegment).toBe("WHERE t.ledger_id = ? AND t.is_deleted = 0 AND t.type = ?");
      expect(params[0]).toBe("pl-1");
    });
  });

  describe("add", () => {
    it("should insert expense transaction and transaction_tags", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after add

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "expense",
        amount: 32.5,
        category_id: "cat-1",
        from_account_id: "acc-1",
        to_account_id: null,
        occurred_at: "2026-06-09T12:00:00Z",
        tag_ids: ["tag-1", "tag-2"],
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["pl-1", "u-1", "expense", 32.5])
      );
      // Verify transaction_tags insert
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        expect.any(Array)
      );
      // Verify account balance refresh
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });

    it("should insert transfer transaction with from and to accounts", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "transfer",
        amount: 500,
        category_id: null,
        from_account_id: "acc-1",
        to_account_id: "acc-2",
        occurred_at: "2026-06-09T12:00:00Z",
        tag_ids: [],
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transactions"),
        expect.arrayContaining(["transfer", 500, "acc-1", "acc-2"])
      );
    });

    it("should insert note into transactions", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTransactionStore();
      await store.add({
        ledger_id: "pl-1",
        user_id: "u-1",
        type: "expense",
        amount: 10,
        category_id: "cat-1",
        from_account_id: "acc-1",
        to_account_id: null,
        occurred_at: "2026-07-07T12:00:00Z",
        tag_ids: [],
        note: "午餐-面馆",
      });

      const insertCall = mockDb.execute.mock.calls.find((c) => String(c[0]).includes("INSERT INTO transactions"));
      expect(insertCall).toBeDefined();
      expect(insertCall![1]).toContain("午餐-面馆");
    });
  });

  describe("update", () => {
    it("should update transaction and rebuild tags", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll during init
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after update

      const store = useTransactionStore();
      await store.fetchAll("pl-1"); // 设置 _ledgerId
      await store.update("tx-1", {
        amount: 50,
        category_id: "cat-2",
        tag_ids: ["tag-3"],
      });

      // Verify transaction UPDATE
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE transactions"),
        expect.arrayContaining([50, "cat-2", "tx-1"])
      );
      // Verify old tags deleted
      expect(mockDb.execute).toHaveBeenCalledWith(
        "DELETE FROM transaction_tags WHERE transaction_id = ?",
        ["tx-1"]
      );
      // Verify new tags inserted
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO transaction_tags"),
        expect.arrayContaining(["tx-1", "tag-3"])
      );
      // Verify account balance refresh
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });

    it("should bump updated_at and enqueue sync when only tags change", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      // 初始 fetchAll 填充 store（旧 updated_at）
      mockDb.select.mockResolvedValueOnce([{ ...makeTx({ id: "tx-1" }), is_deleted: 0 }]);
      // update 后 fetchAll 重读，模拟 DB 已 bump updated_at、新标签已写入
      mockDb.select.mockResolvedValueOnce([
        {
          ...makeTx({ id: "tx-1", updated_at: "2026-06-10T00:00:00Z" }),
          is_deleted: 0,
          tag_ids: "tag-3",
          tag_names: "标签3",
        },
      ]);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");
      vi.mocked(enqueueSync).mockClear();

      await store.update("tx-1", { tag_ids: ["tag-3"] });

      // 只改标签也必须发 UPDATE transactions bump updated_at，
      // 否则 enqueueSync 带旧 updated_at，后端 LWW 跳过 → 标签变更不同步
      const updateCalls = mockDb.execute.mock.calls.filter(
        (c) => String(c[0]).includes("UPDATE transactions")
      );
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0][0]).toContain("updated_at");

      // sync 收到带新 updated_at 的 tx
      expect(enqueueSync).toHaveBeenCalledOnce();
      const payload = vi.mocked(enqueueSync).mock.calls[0][0];
      expect(payload.transactions![0].updated_at).toBe("2026-06-10T00:00:00Z");
      expect(payload.transactions![0].tag_ids).toEqual(["tag-3"]);
    });
  });

  describe("remove", () => {
    it("should soft-delete transaction", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll during init
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after remove

      const store = useTransactionStore();
      await store.fetchAll("pl-1"); // 设置 _ledgerId
      await store.remove("tx-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["tx-1"])
      );
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });
  });

  describe("batchRemove", () => {
    it("should soft-delete multiple transactions", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll during init
      mockDb.select.mockResolvedValueOnce([]); // fetchAll after batchRemove

      const store = useTransactionStore();
      await store.fetchAll("pl-1");
      await store.batchRemove(["tx-1", "tx-2", "tx-3"]);

      expect(mockDb.execute).toHaveBeenCalledWith(
        "UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id IN (?,?,?)",
        expect.arrayContaining(["tx-1", "tx-2", "tx-3"])
      );
      expect(mockFetchAll).toHaveBeenCalledWith("pl-1");
    });

    it("should not execute when ids array is empty", async () => {
      mockDb.select.mockResolvedValueOnce([]);
      const store = useTransactionStore();
      await store.fetchAll("pl-1");
      mockDb.execute.mockClear();

      await store.batchRemove([]);

      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("should not refresh when _ledgerId is not set", async () => {
      mockDb.execute.mockResolvedValue(undefined);
      const store = useTransactionStore();
      // 不调用 fetchAll，所以 _ledgerId 为空
      await store.batchRemove(["tx-1"]);

      // 仍然执行 SQL
      expect(mockDb.execute).toHaveBeenCalled();
      // 但不刷新数据（因为 _ledgerId 未设置）
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe("computed", () => {
    it("should compute totalIncome and totalExpense correctly", async () => {
      const rows = [
        {
          ...makeTx({ id: "tx-1", amount: 100, type: "expense" }),
          is_deleted: 0,
          category_name: "餐饮", category_type: "expense", category_icon: "🍜", category_sort_order: 1,
          tag_ids: null, tag_names: null,
          from_account_name: "招行", from_account_type: "bank", from_account_color: "#ef4444",
          to_account_name: null, to_account_type: null, to_account_color: null,
        },
        {
          ...makeTx({ id: "tx-2", amount: 8000, type: "income" }),
          is_deleted: 0,
          category_name: "工资", category_type: "income", category_icon: "💰", category_sort_order: 1,
          tag_ids: null, tag_names: null,
          from_account_name: null, from_account_type: null, from_account_color: null,
          to_account_name: "招行", to_account_type: "bank", to_account_color: "#ef4444",
        },
        {
          ...makeTx({ id: "tx-3", amount: 500, type: "transfer" }),
          is_deleted: 0,
          category_name: null, category_type: null, category_icon: null, category_sort_order: null,
          tag_ids: null, tag_names: null,
          from_account_name: "招行", from_account_type: "bank", from_account_color: "#ef4444",
          to_account_name: "微信", to_account_type: "digital", to_account_color: "#22c55e",
        },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.totalIncome).toBe(8000);
      expect(store.totalExpense).toBe(100);
    });

    it("should round totalIncome to avoid float precision error (0.1 + 0.2)", async () => {
      const rows = [
        {
          ...makeTx({ id: "tx-1", amount: 0.1, type: "income" }),
          is_deleted: 0,
          category_name: "工资", category_type: "income", category_icon: "💰", category_sort_order: 1,
          tag_ids: null, tag_names: null,
          from_account_name: null, from_account_type: null, from_account_color: null,
          to_account_name: "招行", to_account_type: "bank", to_account_color: "#ef4444",
        },
        {
          ...makeTx({ id: "tx-2", amount: 0.2, type: "income" }),
          is_deleted: 0,
          category_name: "工资", category_type: "income", category_icon: "💰", category_sort_order: 1,
          tag_ids: null, tag_names: null,
          from_account_name: null, from_account_type: null, from_account_color: null,
          to_account_name: "招行", to_account_type: "bank", to_account_color: "#ef4444",
        },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useTransactionStore();
      await store.fetchAll("pl-1");

      expect(store.totalIncome).toBe(0.3);
    });
  });
});

describe("fetchAll uncategorized filter", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("appends uncategorized condition when opt set", async () => {
    mockDb.select.mockResolvedValue([]);
    const store = useTransactionStore();
    await store.fetchAll("pl-1", { uncategorized: true });
    const sql = mockDb.select.mock.calls[0][0] as string;
    expect(sql).toContain("NOT EXISTS(SELECT 1 FROM categories c WHERE c.id=t.category_id AND c.is_deleted=0)");
    expect(sql).toContain("t.category_id IS NULL");
  });

  it("omits condition when opt absent", async () => {
    mockDb.select.mockResolvedValue([]);
    const store = useTransactionStore();
    await store.fetchAll("pl-1", {});
    const sql = mockDb.select.mock.calls[0][0] as string;
    expect(sql).not.toContain("uncategor");
  });
});

describe("remove/batchRemove 推完整墓碑", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("删除时应推送完整流水对象而非部分字段（防零值覆盖）", async () => {
    mockDb.execute.mockResolvedValue(undefined);
    // 首次 fetchAll 返回完整流水（含 tags）
    mockDb.select.mockResolvedValueOnce([{
      ...makeTx({ id: "tx-1", amount: 100, type: "expense" }),
      is_deleted: 0,
      category_name: "餐饮", category_type: "expense", category_icon: "🍜", category_sort_order: 1,
      tag_ids: "tag-1", tag_names: "午餐",
      from_account_name: "招行", from_account_type: "bank", from_account_color: "#ef4444",
      to_account_name: null, to_account_type: null, to_account_color: null,
    }]);
    // remove 内部 fetchAll 重读返回空
    mockDb.select.mockResolvedValueOnce([]);

    const store = useTransactionStore();
    await store.fetchAll("pl-1");
    vi.mocked(enqueueSync).mockClear();

    await store.remove("tx-1");

    expect(enqueueSync).toHaveBeenCalledOnce();
    const payload = vi.mocked(enqueueSync).mock.calls[0][0];
    const tx = payload.transactions![0];
    expect(tx.is_deleted).toBe(true);
    expect(tx.amount).toBe(100); // 完整字段保留，而非被后端零值覆盖
    expect(tx.type).toBe("expense");
    expect(tx.tag_ids).toEqual(["tag-1"]);
  });
});

// M1 的核心诉求：AI 侧算数字走 querySql.buildWhere，流水页列表走 fetchAll，
// 同一个筛选条件在两条链路上必须是同一次筛选。buildWhere 是纯函数（零 DB），
// 所以这里能把它的 SQL 子句与参数序列与 fetchAll 的实际产物逐条对照——
// 「AI 说这个月盒马花了 800、点进去看到 5 条」这类不一致会在这里变红。
describe("fetchAll 与 ai/querySql.buildWhere 的筛选语义逐条一致", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  /** 与下面 fetchAll 的 opts 一一对应的 ResolvedFilter */
  const filter: ResolvedFilter = {
    range: null,
    type: "expense",
    categoryIds: null,
    accountId: "acc-2",
    tagIds: null,
    memberIds: null,
    merchant: "盒马",
    amountMin: 0,
    amountMax: 500,
  };

  it("四个条件的子句文本、参数序列与相对顺序都与 buildWhere 一致", async () => {
    mockDb.select.mockResolvedValue([]);

    const store = useTransactionStore();
    await store.fetchAll("pl-1", {
      type: "expense",
      accountId: "acc-2",
      noteKeyword: "盒马",
      amountMin: 0,
      amountMax: 500,
    });

    const [sql, params] = mockDb.select.mock.calls[0] as [string, (string | number)[]];
    const { sql: whereSql, params: whereParams } = buildWhere("pl-1", filter);

    // 1) 子句文本两边逐字一致（含共用 LIKE 片段，也就是 F1 要求两处同源的那一段）
    const clauses = [
      "t.type = ?",
      "(t.from_account_id = ? OR t.to_account_id = ?)",
      noteOrTagLikeClause(),
      "t.amount >= ?",
      "t.amount <= ?",
    ];
    for (const clause of clauses) {
      expect(sql).toContain(clause);
      expect(whereSql).toContain(clause);
    }

    // 2) 参数序列逐条一致：ledgerId, type, accountId×2, like×2, 0, 500
    //    SQLite 对错序/少传参数**不报错**（缺失占位符当 NULL → 静默 0 行），
    //    所以「参数与子句同序」只能靠断言钉，靠跑不出来的绿是抓不住的。
    //
    //    ⚠️ 限定（审查 Minor 6）：这条整数组 `toEqual` **只在当前夹具下成立**，不能推广。
    //    两侧的**既有**条件块顺序本来就不同（buildWhere：categoryIds → tagIds；
    //    fetchAll：tagIds → categoryIds，见 querySql.ts:106/111 vs transaction.ts:210/218），
    //    本夹具的 categoryIds / tagIds 都是 null，恰好没走到那两块，所以整条序列才相等。
    //    夹具一旦加回分类/标签条件，两侧**都正确**却会在这里假红（审查探针实测：
    //    fetchAll=[pl-1,expense,t1,c1] vs buildWhere=[pl-1,expense,c1,t1]）。
    //    要扩夹具的话，请改成「逐子句 + 各自紧邻的参数」配对断言，而不是把顺序改去对齐。
    expect(params).toEqual(whereParams);
    expect(params).toEqual(["pl-1", "expense", "acc-2", "acc-2", "%盒马%", "%盒马%", 0, 500]);

    // 3) 子句相对顺序两边一致（type → account → note → 金额区间）
    const seq = (s: string) => clauses.map((c) => s.indexOf(c));
    const ascending = (xs: number[]) => xs.every((v, i) => i === 0 || xs[i - 1] < v);
    expect(ascending(seq(sql))).toBe(true);
    expect(ascending(seq(whereSql))).toBe(true);
  });
});

// 执行级回归：`fetchAll` 拼出来的 SQL 交给**真实的 node:sqlite** 跑一遍。
// 为什么非要真跑（与 sqlSmoke.test.ts 同一条方法论）：上一轮审查用真实 node:sqlite 抓到一个
// **任何文本断言都抓不住**的数据错误（tag 分组按软删标签重复计钱，SQL 字符串完全正确）。
// 下面两个恒定子句同属那一族，修前实测「删掉全绿」：
//   · `GROUP BY t.id`：⚠️ 实测后果**不是**"挂 N 个标签的交易重复 N 行"（这是 ledger R56 与
//     批 7+9 审查的推测，探针证明它与 SQL 语义不符）。这条 QUERY 带 `GROUP_CONCAT` 聚合而
//     没有 GROUP BY 时，**整个结果集塌成一行**（真跑：有 GROUP BY 2 行，去掉后 1 行，
//     标量列取 tx-multi 的值、tag_ids 是 "tag-a,tag-b"）——即流水列表**只剩 1 笔**。
//     同样是用户直接看到的静默错数据，只是错法不同，所以照样必须真跑。
//   · `AND tags.is_deleted = 0`：软删标签的名字会重新出现在列表里。
// 文本断言只能证明「SQL 字符串长得对」，证明不了「行数与标签对不对」——所以这里不抄 SQL，
// 而是让 mock 的 db.select **把 fetchAll 真正生成的那条 SQL** 交给真库执行。
describe("fetchAll 的执行级回归（真实 node:sqlite）", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  /** 建库：列与 QUERY 真正读到的那些一一对应 */
  function makeDb() {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, user_id TEXT NOT NULL,
        amount REAL NOT NULL, type TEXT NOT NULL,
        from_account_id TEXT, to_account_id TEXT, category_id TEXT,
        note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, type TEXT, icon TEXT, owner_id TEXT, sort_order INTEGER);
      CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, color TEXT, owner_id TEXT);
      CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT, is_deleted INTEGER DEFAULT 0);
      CREATE TABLE transaction_tags (transaction_id TEXT, tag_id TEXT);
    `);
    const insertTx = db.prepare(
      `INSERT INTO transactions
         (id, ledger_id, user_id, amount, type, note, occurred_at, created_at, updated_at, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // tx-multi 挂 2 个活跃标签：这是 GROUP BY t.id 的判别数据（去掉它 → 扇出成 2 行）
    insertTx.run("tx-multi", "L1", "u1", 100, "expense", "两个标签", "2026-06-09T12:00:00Z", "2026-06-09T12:00:00Z", "2026-06-09T12:00:00Z", 0);
    // tx-dead 只挂 1 个**已软删**标签：这是 tags.is_deleted = 0 的判别数据
    insertTx.run("tx-dead", "L1", "u1", 200, "expense", "软删标签", "2026-06-08T12:00:00Z", "2026-06-08T12:00:00Z", "2026-06-08T12:00:00Z", 0);
    // tx-gone 是软删流水：恒定条件 t.is_deleted = 0 的判别数据
    insertTx.run("tx-gone", "L1", "u1", 300, "expense", "已删流水", "2026-06-07T12:00:00Z", "2026-06-07T12:00:00Z", "2026-06-07T12:00:00Z", 1);
    // tx-other 属于别的账本：ledger_id 条件的判别数据
    insertTx.run("tx-other", "L2", "u1", 400, "expense", "别账本", "2026-06-06T12:00:00Z", "2026-06-06T12:00:00Z", "2026-06-06T12:00:00Z", 0);
    db.exec(`
      INSERT INTO tags VALUES ('tag-a', '午餐', 0), ('tag-b', '工作日', 0), ('tag-z', '软删标签名', 1);
      INSERT INTO transaction_tags VALUES ('tx-multi', 'tag-a'), ('tx-multi', 'tag-b'), ('tx-dead', 'tag-z');
    `);
    return db;
  }

  it("挂多个标签的交易只出现 1 行，软删标签/软删流水/别账本都不进列表", async () => {
    const db = makeDb();
    // 把 fetchAll 真正生成的那条 SQL 交给真库执行，而不是在测试里抄一份 SQL
    // （抄一份的后果是「实现里漏了 GROUP BY、测试里那份没漏」，两边永远不会同时红）。
    mockDb.select.mockImplementation(async (sql: string, params: (string | number)[]) =>
      db.prepare(sql).all(...params),
    );

    const store = useTransactionStore();
    await store.fetchAll("L1");

    // 行数/去重：去掉 GROUP BY t.id 时整个结果集塌成 1 行（实测 received = ["tx-multi"]），
    // 这条断言把「列表笔数」钉死——tx-multi 挂 2 个标签也不能变成 2 笔（扇出）或 1 笔（塌陷）。
    expect(store.transactions.map((t) => t.id)).toEqual(["tx-multi", "tx-dead"]);
    expect(store.transactions.filter((t) => t.id === "tx-multi")).toHaveLength(1);
    // 标签本身不能因 GROUP BY 丢失（GROUP_CONCAT 的两个都还在）
    const multi = store.transactions.find((t) => t.id === "tx-multi");
    expect([...(multi?.tag_ids ?? [])].sort()).toEqual(["tag-a", "tag-b"]);

    // tags.is_deleted = 0：软删标签（名字很显眼）不得出现在任何一笔交易的标签里
    expect(store.transactions.flatMap((t) => (t.tags ?? []).map((tag) => tag.name)).sort())
      .toEqual(["午餐", "工作日"]);

    // t.is_deleted = 0 / t.ledger_id = ?：这两条以前只有文本断言，现在是执行级的
    expect(store.transactions.some((t) => t.id === "tx-gone")).toBe(false);
    expect(store.transactions.some((t) => t.id === "tx-other")).toBe(false);

    db.close();
  });
});

