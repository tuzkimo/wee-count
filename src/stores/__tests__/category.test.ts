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

vi.mock("@/services/sync", () => ({
  enqueueSync: vi.fn(),
}));

import { enqueueSync } from "@/services/sync";
import { useCategoryStore } from "@/stores/category";
import type { Category } from "@/types";

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat-1",
    ledger_id: "ledger-1",
    owner_id: "user-1",
    name: "餐饮",
    type: "expense",
    icon: "🍔",
    sort_order: 1,
    updated_at: "2026-06-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

describe("categoryStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load categories by ledger_id and filter is_deleted", async () => {
      const rows = [
        { ...makeCategory({ id: "cat-1", name: "餐饮" }), is_deleted: 0 },
        { ...makeCategory({ id: "cat-2", name: "交通" }), is_deleted: 0 },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useCategoryStore();
      await store.fetchAll("ledger-1");

      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("WHERE ledger_id = $1 AND is_deleted = 0"),
        ["ledger-1"],
      );
      expect(store.categories).toHaveLength(2);
      expect(store.categories[0].name).toBe("餐饮");
      expect(store.categories[0].is_deleted).toBe(false);
    });

    it("should return empty array when no categories exist", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useCategoryStore();
      await store.fetchAll("ledger-1");

      expect(store.categories).toHaveLength(0);
    });
  });

  describe("add", () => {
    it("should insert category with correct fields and call sync", async () => {
      // 1st select: duplicate check returns empty
      mockDb.select.mockResolvedValueOnce([]);
      // 2nd select: max sort_order returns 2
      mockDb.select.mockResolvedValueOnce([{ max_sort: 2 }]);
      // execute: INSERT
      mockDb.execute.mockResolvedValueOnce(undefined);
      // 3rd select: fetchAll returns the newly inserted category
      mockDb.select.mockResolvedValueOnce([
        { ...makeCategory({ id: "cat-new", name: "购物", icon: "🛒", sort_order: 3 }), is_deleted: 0 },
      ]);

      const store = useCategoryStore();
      await store.add("ledger-1", "购物", "expense", "🛒");

      // Verify INSERT contains name, type, icon, sort_order
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO categories"),
        expect.arrayContaining(["购物", "expense", "🛒", 3]),
      );

      // Verify fetchAll refreshes the list
      expect(store.categories).toHaveLength(1);
      expect(store.categories[0].name).toBe("购物");

      // Verify enqueueSync was called
      expect(enqueueSync).toHaveBeenCalledOnce();
      const syncPayload = vi.mocked(enqueueSync).mock.calls[0][0];
      expect(syncPayload.categories).toHaveLength(1);
      expect(syncPayload.categories![0]).toMatchObject({
        name: "购物",
        type: "expense",
        icon: "🛒",
        sort_order: 3,
        is_deleted: false,
      });
    });

    it("should throw error when category with same name and type exists", async () => {
      // 1st select: duplicate check finds existing
      mockDb.select.mockResolvedValueOnce([{ id: "cat-1" }]);

      const store = useCategoryStore();
      await expect(store.add("ledger-1", "餐饮", "expense", "🍔")).rejects.toThrow(
        "同名分类已存在",
      );

      // Verify execute was NOT called
      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("should update name, icon and call sync", async () => {
      // execute: UPDATE
      mockDb.execute.mockResolvedValueOnce(undefined);
      // select: fetchAll after update
      mockDb.select.mockResolvedValueOnce([
        { ...makeCategory({ name: "美食", icon: "🍜" }), is_deleted: 0 },
      ]);

      const store = useCategoryStore();
      // Pre-populate so the store finds the existing category for sync
      store.categories = [makeCategory()];
      await store.update("cat-1", "美食", "🍜");

      // Verify UPDATE contains name, icon, updated_at
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE categories SET name = $1, icon = $2, updated_at = $3 WHERE id = $4"),
        expect.arrayContaining(["美食", "🍜", expect.any(String), "cat-1"]),
      );

      // Verify enqueueSync was called with updated data
      expect(enqueueSync).toHaveBeenCalledOnce();
      const syncPayload = vi.mocked(enqueueSync).mock.calls[0][0];
      expect(syncPayload.categories![0]).toMatchObject({
        name: "美食",
        icon: "🍜",
      });
    });
  });

  describe("remove", () => {
    it("should soft-delete when no related transactions exist", async () => {
      // select: COUNT(*) returns 0
      mockDb.select.mockResolvedValueOnce([{ count: 0 }]);
      // execute: UPDATE is_deleted = 1
      mockDb.execute.mockResolvedValueOnce(undefined);
      // select: fetchAll after soft-delete
      mockDb.select.mockResolvedValueOnce([]);

      const store = useCategoryStore();
      store.categories = [makeCategory()];
      await store.remove("cat-1");

      // Verify soft delete SQL
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["cat-1"]),
      );

      // Verify enqueueSync was called with is_deleted: true
      expect(enqueueSync).toHaveBeenCalledOnce();
      const syncPayload = vi.mocked(enqueueSync).mock.calls[0][0];
      expect(syncPayload.categories![0].is_deleted).toBe(true);
    });

    it("should throw error when category has related transactions", async () => {
      // select: COUNT(*) returns 3
      mockDb.select.mockResolvedValueOnce([{ count: 3 }]);

      const store = useCategoryStore();
      await expect(store.remove("cat-1")).rejects.toThrow("该分类下有 3 笔交易，无法删除");

      // Verify execute was NOT called
      expect(mockDb.execute).not.toHaveBeenCalled();
    });
  });
});
