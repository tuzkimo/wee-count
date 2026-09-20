// src/views/__tests__/SecurityPage.aiSwitch.test.ts
//
// §7.3 的「我的 → 隐私」入口：AI 意愿层开关 + 说明卡。
//
// 单独一份（而不是往 `SecurityPage.test.ts` 里加）：那份文件里**没有** AI 的桩
// （`/ai/status` 探不到 ⇒ `host` 为 null ⇒ 这一整块根本不渲染），而本文件必须先让 `host` 可知。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const HOST = "ai.example.com";

const readSetting = vi.hoisted(() => vi.fn(async () => ({ kind: "absent" }) as unknown));
const writeSetting = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/services/settingsFile", () => ({ readSetting, writeSetting }));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => {
    throw new Error("not in tauri");
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ localLogin: vi.fn(async () => true), currentLocalUser: null }),
}));
vi.mock("@/services/screenshotProtection", () => ({
  applyScreenshotProtection: vi.fn(async () => undefined),
}));
vi.mock("vue-router", () => ({ useRouter: () => ({ back: vi.fn(), push: vi.fn() }) }));
// `/ai/status`：默认给一个可知的 host；`unknownHost` 打开时给 null（拿来钉"没 host 就整块不渲染"）
const unknownHost = vi.hoisted(() => ({ value: false }));
vi.mock("@/services/ai/transport", async () => {
  const actual = await vi.importActual<typeof import("@/services/ai/transport")>(
    "@/services/ai/transport",
  );
  return {
    ...actual,
    createTransport: () => ({ chat: vi.fn() }),
    fetchAiStatus: vi.fn(async () =>
      unknownHost.value
        ? { enabled: true, model: null, host: null }
        : { enabled: true, model: "m", host: HOST },
    ),
  };
});

import SecurityPage from "@/views/SecurityPage.vue";
import { useAiChatStore } from "@/stores/aiChat";

/** 进页面之前先把 `host` 探出来（模拟"启动时探过一次"的真实形态） */
async function withHost(): Promise<void> {
  await useAiChatStore().refreshStatus();
}

beforeEach(() => {
  vi.clearAllMocks();
  readSetting.mockResolvedValue({ kind: "absent" });
  writeSetting.mockResolvedValue(undefined);
  unknownHost.value = false;
  setActivePinia(createPinia());
  localStorage.clear();
});

describe("SecurityPage 的 AI 意愿层开关（§7.3）", () => {
  it("拿不到 `host` ⇒ 说明卡与开关**都不渲染**（M2→M3 的硬约束）", async () => {
    unknownHost.value = true;
    await withHost();
    const w = mount(SecurityPage);
    await flushPromises();

    // 杀手：把 `v-if="ai.host !== null"` 换成 `v-if="true"`（或改成"变灰"）⇒ 三条全红
    expect(w.find('[data-test="ai-privacy-group"]').exists()).toBe(false);
    expect(w.find('[data-test="ai-sending-enabled"]').exists()).toBe(false);
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
  });

  it("`host` 可知 + 未看过 ⇒ 说明卡在开关**上面**，且开关默认关闭", async () => {
    await withHost();
    const w = mount(SecurityPage);
    await flushPromises();

    expect(w.find('[data-test="ai-privacy-group"]').exists()).toBe(true);
    expect(w.get('[data-test="ai-privacy-host"]').text()).toBe(HOST);
    expect(w.get('[data-test="ai-sending-enabled"]').element).toHaveProperty("checked", false);
    // 杀手：把卡片的 `seen` 写死 true（或干脆不渲染卡片）⇒ 这一条红
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(true);
  });

  it("点「知道了」⇒ 落盘 `ai_privacy_card_seen`，卡片收起（写失败则留在原地）", async () => {
    await withHost();
    const w = mount(SecurityPage);
    await flushPromises();

    await w.get('[data-test="ai-privacy-card-dismiss"]').trigger("click");
    await flushPromises();

    expect(writeSetting).toHaveBeenCalledWith("ai_privacy_card_seen", true, expect.anything());
    expect(useAiChatStore().privacyCardSeen).toBe(true);
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(false);

    // 写失败：状态不许变成"已看过"，页面如实报错（假确认比"再弹一次"糟得多）
    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    useAiChatStore().privacyCardSeen = false;
    const w2 = mount(SecurityPage);
    await flushPromises();
    await w2.get('[data-test="ai-privacy-card-dismiss"]').trigger("click");
    await flushPromises();
    expect(w2.get('[data-test="security-error"]').text()).toBe("设置保存失败，请重试");
    expect(useAiChatStore().privacyCardSeen).toBe(false);
  });

  it("打开开关 ⇒ 落盘 `ai_sending_enabled`，store 状态跟着变（用户随后就能在 AI 页发问）", async () => {
    await withHost();
    const w = mount(SecurityPage);
    await flushPromises();

    await w.get('[data-test="ai-sending-enabled"]').setValue(true);
    await flushPromises();

    // 杀手：`toggleAiSending` 里不调 `ai.setSendingEnabled` ⇒ 这两条红
    expect(writeSetting).toHaveBeenCalledWith("ai_sending_enabled", true, expect.anything());
    expect(useAiChatStore().sendingEnabled).toBe(true);
    expect(w.get('[data-test="ai-sending-enabled"]').element).toHaveProperty("checked", true);
  });

  it("落盘失败 ⇒ 报错 + DOM 勾选态拉回真相（不许显示一个没写进去的开关）", async () => {
    await withHost();
    const w = mount(SecurityPage);
    await flushPromises();

    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    await w.get('[data-test="ai-sending-enabled"]').setValue(true);
    await flushPromises();

    // 杀手：失败路径不 `syncCheckbox` ⇒ 第二条红（界面显示已开启，磁盘上没开）
    expect(w.get('[data-test="security-error"]').text()).toBe("设置保存失败，请重试");
    expect(w.get('[data-test="ai-sending-enabled"]').element).toHaveProperty("checked", false);
    expect(useAiChatStore().sendingEnabled).toBe(false);
  });

  it("本页文案不出现「加密」这类词（与截屏防护同一条措辞纪律）", async () => {
    await withHost();
    const w = mount(SecurityPage);
    await flushPromises();
    expect(w.text()).not.toContain("加密");
  });
});
