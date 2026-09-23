// src/stores/__tests__/aiChat.entry.test.ts
//
// T2（G1/G2/C1）：**入口**开关（`entryEnabled`）是 tab 显隐的唯一判据，且**不依赖 `host`**。
//
// 与 `aiChat.privacy.test.ts`（发送开关）分开：两者是意愿层的两个不同键 —— 入口是"要不要看到
// 这个功能"，发送是"看到之后要不要把数据发出去"。合成一个键的后果是"关掉发送 = 入口消失"，
// 用户再也找不到回来开它的地方。
//
// 杀手（每条都能让对应用例红）：
//   - `setEntryEnabled` 里去掉 `writeEntryEnabled` ⇒ 用例②③红（内存变了、磁盘没变）；
//   - 改成"先改内存、后落盘"（或吞掉写失败）⇒ 用例③红；
//   - 去掉 `setEntryEnabled` 里的 `refreshStatus()` ⇒ 用例②的"恰好补探 1 次"红；
//   - 给 `setEntryEnabled` 加回 `host === null` 拒绝（老实现）⇒ 用例②红（死锁搬家）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const readSetting = vi.hoisted(() => vi.fn());
const writeSetting = vi.hoisted(() =>
  vi.fn(async (_key: string, _value: unknown, _log?: unknown) => {}),
);

vi.mock("@/services/settingsFile", () => ({ readSetting, writeSetting }));
vi.mock("@/db/userDb", () => ({
  getUserDb: () => null,
  getCurrentUserId: () => "local-1",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async () => null,
}));

/** 真机形态：地址没就绪 ⇒ 探测不可判定（`enabled:true` 是上一次已知值，`host` 仍是 null） */
const state = vi.hoisted(() => ({
  status: { enabled: true, model: null, host: null, failure: { kind: "network" } } as unknown,
}));
const fetchAiStatus = vi.hoisted(() => vi.fn(async () => state.status));
vi.mock("@/services/ai/transport", () => ({
  createTransport: () => ({ chat: vi.fn() }),
  fetchAiStatus,
}));
vi.mock("@/services/ai/agent", () => ({ runAgent: vi.fn() }));

import { useAiChatStore } from "@/stores/aiChat";

beforeEach(() => {
  vi.clearAllMocks();
  readSetting.mockResolvedValue({ kind: "absent" });
  writeSetting.mockResolvedValue(undefined);
  setActivePinia(createPinia());
});

describe("AI 入口开关（G1/G2/C1）", () => {
  it("① 默认**不显示**：读到 absent 时 store 里是 false，且读的是 `ai_entry_enabled`", async () => {
    const store = useAiChatStore();
    expect(store.entryEnabled).toBe(false); // 建 store 那一刻的初值

    await store.loadPrivacySettings();

    // 杀手：把 `AI_ENTRY_ENABLED_DEFAULT` 改成 true ⇒ 上面两条变成 true ⇒ 红
    expect(store.entryEnabled).toBe(false);
    expect(readSetting).toHaveBeenCalledWith("ai_entry_enabled", expect.any(Function));
  });

  it("② 拿不到 `host` 也**必须能开启**：落盘 `ai_entry_enabled` + 内存跟随 + 顺带补探一次", async () => {
    const store = useAiChatStore();
    expect(store.host).toBeNull();

    await store.setEntryEnabled(true);

    // 杀手：加回 `if (enabled && host === null) return`（老实现的死锁）⇒ 这条红
    expect(writeSetting).toHaveBeenCalledWith("ai_entry_enabled", true, expect.anything());
    expect(store.entryEnabled).toBe(true);
    // 杀手：去掉 `setEntryEnabled` 里的 `refreshStatus()` ⇒ 这条红（用户点进去会看到一句过期的话）
    expect(fetchAiStatus).toHaveBeenCalledTimes(1);
  });

  it("③ 落盘失败 ⇒ reject 且内存**不变**（不许假确认一个没写进去的入口）", async () => {
    const store = useAiChatStore();

    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    await expect(store.setEntryEnabled(true)).rejects.toThrow("disk full");

    // 杀手：先改内存后写盘（或吞掉写失败）⇒ 这条红
    expect(store.entryEnabled).toBe(false);
  });

  it("④ 关闭方向同样落盘（拒绝只针对「服务端明确没配」时的**发送**开关，入口不设门槛）", async () => {
    const store = useAiChatStore();
    await store.setEntryEnabled(true);

    await store.setEntryEnabled(false);

    expect(writeSetting).toHaveBeenLastCalledWith("ai_entry_enabled", false, expect.anything());
    expect(store.entryEnabled).toBe(false);
  });
});
