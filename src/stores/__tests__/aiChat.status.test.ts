// src/stores/__tests__/aiChat.status.test.ts
//
// AI 能力探测（`refreshStatus` / `enabled` / `host` / `model`）—— 计划步骤 1 的 store 草图里
// 这一块，6a 明确留给"tab 显隐那片"（`task-6a-store.md:156-159`）。
//
// 只换 `fetchAiStatus` 这一个网络入口（`transport.ts` 的分类逻辑有它自己的用例）：
// 这里要验的是"探测结果怎么写进 store、失败时是不是安全的一侧"。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const state = vi.hoisted(() => ({ status: null as unknown }));

vi.mock("@/services/ai/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/ai/transport")>();
  return { ...actual, fetchAiStatus: vi.fn(async () => state.status) };
});

import { fetchAiStatus } from "@/services/ai/transport";
import { useAiChatStore } from "@/stores/aiChat";

const fetchMock = () => vi.mocked(fetchAiStatus);

beforeEach(() => {
  vi.clearAllMocks();
  state.status = null;
  setActivePinia(createPinia());
});

describe("refreshStatus：能力探测", () => {
  it("探之前 enabled 为 false（tab 不显示）、status 为 null（不是'没启用'）", () => {
    const store = useAiChatStore();
    expect(store.status).toBeNull();
    expect(store.enabled).toBe(false);
    expect(store.host).toBeNull();
    expect(store.model).toBeNull();
  });

  it("探成功：enabled/host/model 三项都写进 store（tab 门控与隐私卡各取所需）", async () => {
    state.status = { enabled: true, model: "deepseek-chat", host: "ai.example.com" };
    const store = useAiChatStore();

    await store.refreshStatus();

    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(store.enabled).toBe(true);
    expect(store.host).toBe("ai.example.com");
    expect(store.model).toBe("deepseek-chat");
    // 整份结果都留着：任务 7 的隐私卡要的 `host` 就是这里来的
    expect(store.status).toEqual({ enabled: true, model: "deepseek-chat", host: "ai.example.com" });
  });

  it("探失败：enabled 落回 false、host/model 清空，且不抛（安全的一侧）", async () => {
    state.status = { enabled: true, model: "m", host: "h" };
    const store = useAiChatStore();
    await store.refreshStatus();
    expect(store.enabled).toBe(true);

    // 第二次探测失败（网络 / 401 / 429…）：`fetchAiStatus` 永不抛，回的是 enabled:false + failure
    state.status = { enabled: false, model: null, host: null, failure: { kind: "network" } };
    await expect(store.refreshStatus()).resolves.toBeUndefined();

    expect(store.enabled).toBe(false);
    expect(store.host).toBeNull();
    expect(store.model).toBeNull();
  });

  it("status 为空对象/缺字段时 enabled 恒 false（形状坏 = 拿不到能力）", async () => {
    state.status = {};
    const store = useAiChatStore();

    await store.refreshStatus();

    expect(store.enabled).toBe(false);
  });
});
