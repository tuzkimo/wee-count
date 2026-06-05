import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

// Mock db 模块
const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

vi.mock("@/db", () => ({
  getDb: vi.fn(() => Promise.resolve(mockDb)),
  ensureDefaultData: vi.fn(() => Promise.resolve()),
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
          initial_balance: 5000,
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

  describe("add", () => {
    it("should insert account and refresh list", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]);
      // 第一次是 add 里的 INSERT 后 fetchAll
      mockDb.select.mockResolvedValueOnce([
        { ...makeAccount({ name: "新账户" }), is_deleted: 0 },
      ]);

      const store = useAccountStore();
      await store.add({
        ledger_id: "pl-1",
        owner_id: "u-1",
        name: "新账户",
        type: "digital",
        initial_balance: 0,
        color: "#22c55e",
      });

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO accounts"),
        expect.arrayContaining(["新账户"])
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
  });
});
