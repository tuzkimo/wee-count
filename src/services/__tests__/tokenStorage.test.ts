import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(),
}));

import { load } from "@tauri-apps/plugin-store";
import { readRefreshToken, writeRefreshToken, deleteRefreshToken } from "@/services/tokenStorage";

describe("tokenStorage", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("非 Tauri 环境回落 localStorage", async () => {
    (load as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("no tauri"));
    await writeRefreshToken("r-token");
    expect(localStorage.getItem("refresh_token")).toBe("r-token");
    await expect(readRefreshToken()).resolves.toBe("r-token");
    await deleteRefreshToken();
    expect(localStorage.getItem("refresh_token")).toBeNull();
  });
});
