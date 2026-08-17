import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(),
}));

import { load } from "@tauri-apps/plugin-store";
import { readRefreshToken, writeRefreshToken, deleteRefreshToken } from "@/services/tokenStorage";

describe("tokenStorage", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("非 Tauri 环境回落 localStorage（按用户隔离）", async () => {
    (load as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no tauri"));
    await writeRefreshToken("u1", "r-token");
    expect(localStorage.getItem("refresh_token:u1")).toBe("r-token");
    await expect(readRefreshToken("u1")).resolves.toBe("r-token");
    await deleteRefreshToken("u1");
    expect(localStorage.getItem("refresh_token:u1")).toBeNull();
  });

  it("不同用户的 refresh_token 互不覆盖", async () => {
    (load as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no tauri"));
    await writeRefreshToken("u1", "r1");
    await writeRefreshToken("u2", "r2");

    // 写 u2 不应覆盖 u1
    await expect(readRefreshToken("u1")).resolves.toBe("r1");
    await expect(readRefreshToken("u2")).resolves.toBe("r2");
  });
});
