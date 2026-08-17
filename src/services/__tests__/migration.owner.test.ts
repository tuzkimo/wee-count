import { describe, it, expect, vi, beforeEach } from "vitest";

// migrateLocalDataToServer 团队账本归属防串改回归测试。
// 根因：旧实现按「整本账本」改写 owner_id/user_id 且 SELECT ... LIMIT 1 不看类型，
// 团队账本被选为迁移源时，会把其他成员的账户/流水整体翻到当前用户名下。
const mockDb = { select: vi.fn(), execute: vi.fn() };
vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
  getCurrentUserId: vi.fn(() => "local-b"),
}));
vi.mock("@/services/api", () => ({
  apiFetch: vi.fn(),
  hasBaseUrl: vi.fn(() => true),
}));

import { migrateLocalDataToServer } from "@/services/migration";

describe("migrateLocalDataToServer 归属改写", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.select.mockResolvedValue([
      {
        id: "pl-local",
        name: "x",
        type: "personal",
        owner_id: "local-b",
        team_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        is_deleted: 0,
      },
    ]);
    mockDb.execute.mockResolvedValue(undefined);
  });

  it("账本查询限定 personal，不把团队账本当作迁移源", async () => {
    await migrateLocalDataToServer("pl-server", "b-server");

    const selectSql = mockDb.select.mock.calls[0][0] as string;
    expect(selectSql).toContain("type = 'personal'");
  });

  it("accounts 归属改写按 owner_id 限定，不整本覆盖", async () => {
    await migrateLocalDataToServer("pl-server", "b-server");

    const execCalls = mockDb.execute.mock.calls as Array<[string, unknown[]]>;
    const accountOwner = execCalls.find(([sql]) =>
      sql.startsWith("UPDATE accounts SET owner_id")
    );
    expect(accountOwner).toBeDefined();
    expect(accountOwner![0]).toContain("owner_id = $3");
    // 参数带上了旧 owner，作为限定条件，而不是只按 ledger_id 整本覆盖
    expect(accountOwner![1]).toContain("local-b");
  });

  it("categories 归属改写按 owner_id 限定", async () => {
    await migrateLocalDataToServer("pl-server", "b-server");

    const execCalls = mockDb.execute.mock.calls as Array<[string, unknown[]]>;
    const categoryOwner = execCalls.find(([sql]) =>
      sql.startsWith("UPDATE categories SET owner_id")
    );
    expect(categoryOwner).toBeDefined();
    expect(categoryOwner![0]).toContain("owner_id = $3");
  });

  it("重绑分支（本地账本 ID 已等于服务端 ID）同样限定归属", async () => {
    // 重绑：SELECT 返回的账本 id 已等于服务端 id，进入 re-bind 分支
    mockDb.select.mockResolvedValue([
      {
        id: "pl-server",
        name: "x",
        type: "personal",
        owner_id: "local-b",
        team_id: null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        is_deleted: 0,
      },
    ]);

    await migrateLocalDataToServer("pl-server", "b-server");

    const execCalls = mockDb.execute.mock.calls as Array<[string, unknown[]]>;
    const accountOwner = execCalls.find(([sql]) =>
      sql.startsWith("UPDATE accounts SET owner_id")
    );
    expect(accountOwner![0]).toContain("owner_id = $3");
  });
});
