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
import { useTagStore } from "@/stores/tag";
import type { TagWithUsage } from "@/types";

function makeTag(overrides: Partial<TagWithUsage> = {}): TagWithUsage {
  return {
    id: "tag-1",
    ledger_id: "ledger-1",
    name: "工作日",
    updated_at: "2026-06-01T00:00:00Z",
    is_deleted: false,
    usage_count: 0,
    ...overrides,
  };
}

describe("tagStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load tags by ledger_id and filter is_deleted", async () => {
      mockDb.select.mockResolvedValueOnce([
        { ...makeTag({ id: "tag-1", name: "工作日" }), is_deleted: 0 },
        { ...makeTag({ id: "tag-2", name: "周末" }), is_deleted: 0 },
      ]);

      const store = useTagStore();
      await store.fetchAll("ledger-1");

      expect(store.tags).toHaveLength(2);
      expect(store.tags[0].is_deleted).toBe(false);
      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("FROM tags"),
        ["ledger-1", "ledger-1"]
      );
    });

    it("按使用次数倒序取数，已删除交易不计入次数", async () => {
      mockDb.select.mockResolvedValueOnce([]);

      const store = useTagStore();
      await store.fetchAll("ledger-1");

      const sql = mockDb.select.mock.calls[0][0] as string;
      expect(sql).toContain("ORDER BY usage_count DESC");
      expect(sql).toContain("FROM transaction_tags");
      expect(sql).toContain("tx.is_deleted = 0");
    });

    it("映射每行的 usage_count", async () => {
      mockDb.select.mockResolvedValueOnce([
        { ...makeTag({ id: "tag-1", name: "工作日" }), is_deleted: 0, usage_count: 5 },
        { ...makeTag({ id: "tag-2", name: "周末" }), is_deleted: 0, usage_count: 0 },
      ]);

      const store = useTagStore();
      await store.fetchAll("ledger-1");

      expect(store.tags.map((t) => t.usage_count)).toEqual([5, 0]);
    });
  });

  describe("add", () => {
    it("should insert tag and call sync", async () => {
      mockDb.execute.mockResolvedValue(undefined);

      const store = useTagStore();
      await store.add("ledger-1", "工作日");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO tags"),
        expect.arrayContaining(["ledger-1", "工作日"])
      );
      expect(enqueueSync).toHaveBeenCalledOnce();
      const syncPayload = vi.mocked(enqueueSync).mock.calls[0][0];
      expect(syncPayload.tags).toHaveLength(1);
      expect(syncPayload.tags![0]).toMatchObject({
        ledger_id: "ledger-1",
        name: "工作日",
        is_deleted: false,
      });
    });
  });

  describe("remove", () => {
    it("should soft-delete and call sync with is_deleted: true", async () => {
      // 先 fetchAll 填充 store，remove 才能取到 existing 构造完整 payload
      mockDb.select.mockResolvedValueOnce([
        { ...makeTag({ id: "tag-1" }), is_deleted: 0 },
      ]);
      mockDb.execute.mockResolvedValue(undefined);

      const store = useTagStore();
      await store.fetchAll("ledger-1");
      vi.mocked(enqueueSync).mockClear();

      await store.remove("tag-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["tag-1"])
      );
      expect(store.tags).toHaveLength(0);
      expect(enqueueSync).toHaveBeenCalledOnce();
      const syncPayload = vi.mocked(enqueueSync).mock.calls[0][0];
      expect(syncPayload.tags).toHaveLength(1);
      expect(syncPayload.tags![0]).toMatchObject({
        id: "tag-1",
        ledger_id: "ledger-1",
        name: "工作日",
        is_deleted: true,
      });
    });
  });

  describe("update", () => {
    it("名称为空时拒绝，不写库", async () => {
      const store = useTagStore();

      await expect(store.update("tag-1", "   ")).rejects.toThrow("请输入标签名称");
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("同账本重名（忽略大小写、排除自身）时拒绝改名", async () => {
      mockDb.select
        .mockResolvedValueOnce([{ ...makeTag({ id: "tag-1" }), is_deleted: 0 }])
        .mockResolvedValueOnce([{ id: "tag-2" }]);

      const store = useTagStore();
      await store.fetchAll("ledger-1");

      await expect(store.update("tag-1", "周末")).rejects.toThrow("同名标签已存在");
      expect(mockDb.select).toHaveBeenLastCalledWith(
        expect.stringContaining("COLLATE NOCASE"),
        ["ledger-1", "周末", "tag-1"]
      );
      expect(mockDb.execute).not.toHaveBeenCalled();
    });

    it("改名写库、保留使用次数并同步", async () => {
      mockDb.select
        .mockResolvedValueOnce([
          { ...makeTag({ id: "tag-1", name: "工作日" }), is_deleted: 0, usage_count: 5 },
        ])
        .mockResolvedValueOnce([]);
      mockDb.execute.mockResolvedValue(undefined);

      const store = useTagStore();
      await store.fetchAll("ledger-1");
      vi.mocked(enqueueSync).mockClear();

      await store.update("tag-1", " 工作日改 ");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE tags SET name"),
        expect.arrayContaining(["工作日改", "tag-1"])
      );
      expect(store.tags[0]).toMatchObject({
        id: "tag-1",
        name: "工作日改",
        usage_count: 5,
      });
      expect(enqueueSync).toHaveBeenCalledOnce();
      expect(vi.mocked(enqueueSync).mock.calls[0][0].tags![0]).toMatchObject({
        id: "tag-1",
        ledger_id: "ledger-1",
        name: "工作日改",
        is_deleted: false,
      });
    });
  });
});
