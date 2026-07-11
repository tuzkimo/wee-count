import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

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

import { enqueueSync } from "@/services/sync";
import { useTransactionStore } from "@/stores/transaction";
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
  });
});
