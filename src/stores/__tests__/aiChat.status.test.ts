// src/stores/__tests__/aiChat.status.test.ts
//
// AI 能力探测（`refreshStatus` / `enabled` / `host` / `model`）—— 计划步骤 1 的 store 草图里
// 这一块，6a 明确留给"tab 显隐那片"（`task-6a-store.md:156-159`）。
//
// 只换 `fetchAiStatus` 这一个网络入口（`transport.ts` 的分类逻辑有它自己的用例）：
// 这里要验的是"探测结果怎么写进 store"。
//
// ⚠️ 第 47 条（本轮的 Critical）：**只有服务端明确表态才改已知状态**。
// 上一版这里把"探失败 ⇒ enabled 落回 false"钉成了期望值 —— 那正是缺陷本身
// （用户刚用完 `/ai/chat`，进页面时探针吃 429 ⇒ tab 从底栏消失，且一直留到下次冷启动）。
// 现在的口径：网络 / 超时 / 429 / 形状坏 / 401 / 5xx 一律**保留上一次已知状态**（未知 ⇒ 保持可用），
// 只有 200 + `enabled:false`（服务端说没配）与 503 `ai_disabled`（明确关闭）才关 tab。
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

/** 一次"给不出结论"的探测结果（`AiStatus` 的安全一侧：enabled:false + failure） */
function uninformative(failure: unknown) {
  return { enabled: false, model: null, host: null, failure };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.status = null;
  setActivePinia(createPinia());
});

describe("refreshStatus：能力探测", () => {
  it("还没探过：enabled=false、status=null、host/model=null（启动瞬间不闪一个可能点不进去的入口）", () => {
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

  it("服务端明确说没配（200 + enabled:false）⇒ 关 tab（这是「明确表态」，不是「未知」）", async () => {
    state.status = { enabled: false, model: null, host: null };
    const store = useAiChatStore();

    await store.refreshStatus();

    expect(store.enabled).toBe(false);
    expect(store.status).toEqual({ enabled: false, model: null, host: null });
  });

  it("一次成功后再遇 429 ⇒ enabled 仍为 true（保留上一次已知状态），host/model 不变", async () => {
    state.status = { enabled: true, model: "deepseek-chat", host: "ai.example.com" };
    const store = useAiChatStore();
    await store.refreshStatus();
    expect(store.enabled).toBe(true);

    // 同一个每分钟桶被 `/ai/chat` 吃掉 ⇒ 探针 429。`fetchAiStatus` 永不抛。
    state.status = uninformative({ kind: "rate_limited", scope: "minute" });
    await expect(store.refreshStatus()).resolves.toBeUndefined();

    // 杀手：把 429 当关闭信号（`status.value = await fetchAiStatus()` 那种写法）⇒ 三条全红
    expect(store.enabled).toBe(true);
    expect(store.host).toBe("ai.example.com");
    expect(store.model).toBe("deepseek-chat");
    expect(store.status).toEqual({ enabled: true, model: "deepseek-chat", host: "ai.example.com" });
  });

  it("一次成功后再遇网络失败 / 形状坏 ⇒ 同样保留上一次已知状态", async () => {
    for (const failure of [
      { kind: "network" },
      { kind: "timeout" },
      { kind: "invalid_response" },
      { kind: "upstream", code: "" },
      { kind: "unauthorized" },
    ]) {
      setActivePinia(createPinia());
      state.status = { enabled: true, model: "m", host: "h" };
      const store = useAiChatStore();
      await store.refreshStatus();

      state.status = uninformative(failure);
      await store.refreshStatus();

      expect(store.enabled).toBe(true);
      expect(store.host).toBe("h");
    }
  });

  it("明确的 ai_disabled（503）⇒ 关 tab（只有它才允许关）", async () => {
    state.status = { enabled: true, model: "m", host: "h" };
    const store = useAiChatStore();
    await store.refreshStatus();
    expect(store.enabled).toBe(true);

    state.status = uninformative({ kind: "disabled" });
    await store.refreshStatus();

    expect(store.enabled).toBe(false);
  });

  it("首次探测就给不出结论（429 / 网络 / 形状坏）⇒ 未知 ⇒ 保持可用（不把用户关在门外）", async () => {
    for (const failure of [
      { kind: "rate_limited", scope: "minute" },
      { kind: "network" },
      { kind: "invalid_response" },
    ]) {
      setActivePinia(createPinia());
      state.status = uninformative(failure);
      const store = useAiChatStore();

      await store.refreshStatus();

      // 自动探针只有 App 启动那一处 ⇒ "不知道"不能等于"关掉"，否则断网冷启动的用户再也进不去
      expect(store.enabled).toBe(true);
      // 但它是"未知"而不是"已知"：没有可判定的结果，`host` 仍不可知（任务 7 据此不显示隐私卡）
      expect(store.status).toBeNull();
      expect(store.host).toBeNull();
    }
  });
});
