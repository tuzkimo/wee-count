import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock db 模块
const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

const { enqueueSyncMock } = vi.hoisted(() => ({ enqueueSyncMock: vi.fn() }));

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
  getCurrentUserId: vi.fn(() => "local-user-1"),
  openUserDb: vi.fn(),
  closeUserDb: vi.fn(),
}));

vi.mock("@/services/sync", () => ({
  enqueueSync: enqueueSyncMock,
}));

import { useAccountStore } from "@/stores/account";
import type { Account } from "@/types";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    ledger_id: "personal-ledger-1",
    owner_id: "local-user-1",
    name: "测试账户",
    type: "bank",
    category: "asset",
    initial_balance: 100,
    color: "#3b82f6",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    is_deleted: false,
    current_balance: 100,
    ...overrides,
  };
}

describe("accountStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load accounts from db and set current_balance", async () => {
      const rows = [
        {
          id: "acc-1",
          ledger_id: "pl-1",
          owner_id: "u-1",
          name: "招商储蓄卡",
          type: "bank",
          category: "asset",
          initial_balance: 5000,
          credit_limit: null,
          repayment_day: null,
          color: "#ef4444",
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
          is_deleted: 0,
          current_balance: 5200,
        },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.accounts).toHaveLength(1);
      expect(store.accounts[0].name).toBe("招商储蓄卡");
      expect(store.accounts[0].current_balance).toBe(5200);
      expect(mockDb.select).toHaveBeenCalledWith(expect.stringContaining("SUM"), ["pl-1"]);
    });

    it("should return empty array when no accounts exist", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.accounts).toHaveLength(0);
    });
  });

  describe("totalBalance", () => {
    it("should compute sum of all current_balance values", async () => {
      const rows = [
        { ...makeAccount({ id: "a1", current_balance: 100 }), is_deleted: 0 },
        { ...makeAccount({ id: "a2", current_balance: -50 }), is_deleted: 0 },
        { ...makeAccount({ id: "a3", current_balance: 200 }), is_deleted: 0 },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.totalBalance).toBe(250);
    });
  });

  describe("netAssets", () => {
    it("should compute net assets as assets - liabilities", async () => {
      const rows = [
        { ...makeAccount({ id: "a1", category: "asset", current_balance: 50000, type: "bank" }), is_deleted: 0 },
        { ...makeAccount({ id: "a2", category: "asset", current_balance: 10000, type: "digital" }), is_deleted: 0 },
        { ...makeAccount({ id: "a3", category: "liability", current_balance: -37500, type: "credit_card" }), is_deleted: 0 },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useAccountStore();
      await store.fetchAll("pl-1");

      expect(store.assetsTotal).toBe(60000);
      expect(store.liabilitiesTotal).toBe(-37500);
      expect(store.netAssets).toBe(22500);
    });
  });

  describe("add", () => {
    it("should insert account with category and new fields, then refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);
      // 第一次是 add 里的 INSERT 后 fetchAll
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ name: "新信用卡", type: "credit_card", category: "liability" }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.add({
        ledger_id: "pl-1",
        owner_id: "u-1",
        name: "新信用卡",
        type: "credit_card",
        category: "liability",
        initial_balance: 0,
        credit_limit: 50000,
        repayment_day: 15,
        color: "#ef4444",
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO accounts"),
        expect.arrayContaining(["新信用卡", "credit_card", "liability", 50000, 15, "#ef4444"])
      );
    });
  });

  describe("update", () => {
    it("should update account and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ id: "a1", name: "改名后" }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.update("a1", { name: "改名后", color: "#000000" });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        expect.arrayContaining(["改名后", "#000000", "a1"])
      );
    });

    it("should update liability fields", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ id: "a1", type: "credit_card", category: "liability", credit_limit: 80000, repayment_day: 10 }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.update("a1", { credit_limit: 80000, repayment_day: 10 });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE accounts"),
        expect.arrayContaining([80000, 10, "a1"])
      );
    });

    it("should enqueue full account to sync with new updated_at", async () => {
      // clearAllMocks 不清 mockResolvedValueOnce 队列，手动 reset 防止前序测试残留污染
      mockDb.select.mockReset();
      mockDb.execute.mockReset();
      const acc = { ...makeAccount({ id: "a1", initial_balance: 100 }), is_deleted: 0 };
      mockDb.select.mockResolvedValueOnce([acc]); // 初始 fetchAll 填充 store
      mockDb.execute.mockResolvedValueOnce(undefined); // UPDATE
      mockDb.select.mockResolvedValueOnce([{ ...acc, name: "改名后", initial_balance: 200, is_deleted: 0 }]); // 刷新

      const store = useAccountStore();
      await store.fetchAll("personal-ledger-1");
      await store.update("a1", { name: "改名后", initial_balance: 200 });

      expect(enqueueSyncMock).toHaveBeenCalledTimes(1);
      const payload = enqueueSyncMock.mock.calls[0][0];
      expect(payload.accounts).toHaveLength(1);
      expect(payload.accounts[0]).toMatchObject({
        id: "a1",
        ledger_id: "personal-ledger-1",
        owner_id: "local-user-1",
        name: "改名后",
        initial_balance: 200,
        is_deleted: false,
      });
      // 未改动的字段也要带上，否则后端 LWW 会用零值覆盖线上
      expect(payload.accounts[0].created_at).toBe("2026-06-01T00:00:00Z");
      expect(payload.accounts[0].color).toBe("#3b82f6");
    });
  });

  describe("remove", () => {
    it("should soft-delete and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);

      const store = useAccountStore();
      await store.remove("a1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["a1"])
      );
    });

    it("should enqueue account with is_deleted=true to sync", async () => {
      mockDb.select.mockReset();
      mockDb.execute.mockReset();
      const acc = { ...makeAccount({ id: "a1" }), is_deleted: 0 };
      mockDb.select.mockResolvedValueOnce([acc]); // 初始 fetchAll 填充 store
      mockDb.execute.mockResolvedValueOnce(undefined); // 软删除
      mockDb.select.mockResolvedValueOnce([]); // 刷新（已删除，列表空）

      const store = useAccountStore();
      await store.fetchAll("personal-ledger-1");
      await store.remove("a1");

      expect(enqueueSyncMock).toHaveBeenCalledTimes(1);
      const payload = enqueueSyncMock.mock.calls[0][0];
      expect(payload.accounts).toHaveLength(1);
      expect(payload.accounts[0]).toMatchObject({
        id: "a1",
        owner_id: "local-user-1",
        is_deleted: true,
      });
    });
  });
});
