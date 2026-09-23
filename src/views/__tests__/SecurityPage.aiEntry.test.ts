// src/views/__tests__/SecurityPage.aiEntry.test.ts
//
// T2/T4（G2/C2/C6.3）：AI 区块**恒渲染**、入口开关**恒可点**、「重新检测」**恒可点** ——
// 三者都不许再拿 `host` 当渲染/可操作性判据（那正是死锁的那一半）。
//
// 与 `SecurityPage.aiSwitch.test.ts` 的分工：那份逐步接管旧断言（host 未知 ⇒ 整块不渲染），
// 这份**新增**契约（C2.1/C2.2/C2.3/C2.4/C6.3）与"同意卡就在开启入口上面"这条时机要求。
//
// 杀手（每条都能让对应用例红）：
//   - `SecurityPage.vue` 的 `ai-privacy-group` 加回 `v-if="ai.host !== null"` ⇒ 用例①②红；
//   - `ai-sending-enabled` 加 `:disabled="ai.host === null"` ⇒ 用例①红；
//   - `ai-entry-enabled` / `ai-recheck` 不渲染、或点它不调 store ⇒ 用例②③红；
//   - 把守卫塞进 `refreshStatus()`（地址没配就早退）⇒ 用例③红（本文件从不配 base URL）；
//   - 状态行改回直接插值 `ai.host` ⇒ 用例④红（host 未知时渲染成空串，"还没有连接到服务器"那句没了）。
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

/** `/ai/status`：`unknownHost` 打开时给 host:null（真机事故形态），否则给一个可知的 host */
const unknownHost = vi.hoisted(() => ({ value: true }));
const fetchAiStatus = vi.hoisted(() => vi.fn());

vi.mock("@/services/ai/transport", async () => {
  const actual = await vi.importActual<typeof import("@/services/ai/transport")>(
    "@/services/ai/transport",
  );
  return { ...actual, createTransport: () => ({ chat: vi.fn() }), fetchAiStatus };
});

import SecurityPage from "@/views/SecurityPage.vue";
import { useAiChatStore } from "@/stores/aiChat";

beforeEach(() => {
  vi.clearAllMocks();
  readSetting.mockResolvedValue({ kind: "absent" });
  writeSetting.mockResolvedValue(undefined);
  unknownHost.value = true;
  fetchAiStatus.mockImplementation(async () =>
    unknownHost.value
      ? { enabled: true, model: null, host: null, failure: { kind: "network" } }
      : { enabled: true, model: "m", host: HOST },
  );
  setActivePinia(createPinia());
  localStorage.clear();
});

describe("隐私区 AI 区块：恒可达（G2/C2）", () => {
  it("① `host` 未知 ⇒ 区块、发送开关、重新检测**都在**，且开关都不是禁用态（只允许落盘中临时禁用）", async () => {
    await useAiChatStore().refreshStatus();
    expect(useAiChatStore().host).toBeNull();

    const w = mount(SecurityPage);
    await flushPromises();

    // 杀手：`ai-privacy-group` 加回 `v-if="ai.host !== null"` ⇒ 这三条红
    expect(w.find('[data-test="ai-privacy-group"]').exists()).toBe(true);
    expect(w.get('[data-test="ai-sending-enabled"]').element).toHaveProperty("disabled", false);
    expect(w.get('[data-test="ai-entry-enabled"]').element).toHaveProperty("disabled", false);
    expect(w.get('[data-test="ai-recheck"]').element).toHaveProperty("disabled", false);
    // 说明卡仍然只在 host 可知且未看过时渲染（C2.4 的安全半边）
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
  });

  it("② `host` 未知也能**开启入口**：落盘 `ai_entry_enabled` + store 跟随（入口不再依赖 host）", async () => {
    const w = mount(SecurityPage);
    await flushPromises();
    expect(fetchAiStatus).not.toHaveBeenCalled(); // 页面不自动探（第 47 条）

    await w.get('[data-test="ai-entry-enabled"]').setValue(true);
    await flushPromises();

    // 杀手：`toggleAiEntry` 里加回 `if (ai.host === null) return` ⇒ 三条红（死锁搬家）
    expect(writeSetting).toHaveBeenCalledWith("ai_entry_enabled", true, expect.anything());
    expect(useAiChatStore().entryEnabled).toBe(true);
    // 开启动作串起一次"用户显式触发"的探测（第 47 条允许，C6.3）
    expect(fetchAiStatus).toHaveBeenCalledTimes(1);
  });

  it("③ 点「重新检测」⇒ 恰好一次探测；地址没配也照发（C6.3：不受 `hasBaseUrl` 守卫限制）", async () => {
    const w = mount(SecurityPage);
    await flushPromises();

    // 本文件从不 `setBaseUrl` ⇒ 真 `hasBaseUrl()` 为假。杀手：把守卫塞进 `refreshStatus()`
    // （地址没配就早退）⇒ 这条红，且用户永远拿不到 C3.4 那条说明
    await w.get('[data-test="ai-recheck"]').trigger("click");
    await flushPromises();

    expect(fetchAiStatus).toHaveBeenCalledTimes(1);
  });

  it("④ 状态行**绝不插值出 `null`**：host 未知时给一句实话，host 可知时逐字写出域名", async () => {
    await useAiChatStore().refreshStatus();
    const w = mount(SecurityPage);
    await flushPromises();

    const text = w.get('[data-test="ai-host-state"]').text();
    // 杀手：状态行改回直接插值 `ai.host` ⇒ Vue 把 null 渲染成**空串** ⇒ 这一条红
    // （所以不能只断言"不含 `null`"：空串也不含，会假绿）
    expect(text).toContain("服务器");
    expect(text).not.toContain("服务端未配置 AI"); // 真机那句谎话

    // 探测成功之后（用户点「重新检测」）⇒ 同一行说真话
    unknownHost.value = false;
    await w.get('[data-test="ai-recheck"]').trigger("click");
    await flushPromises();

    expect(w.get('[data-test="ai-host-state"]').text()).toContain(HOST);
  });

  it("⑤ 同意卡就在**开启入口**上面（时机：知道了 → 才能谈开启；host 可知且未看过才渲染）", async () => {
    unknownHost.value = false;
    await useAiChatStore().refreshStatus();
    const w = mount(SecurityPage);
    await flushPromises();

    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(true);
    // 卡片与入口开关同属一个 `ai-privacy-group`（同一个"开启"动作的上下文里）
    const group = w.get('[data-test="ai-privacy-group"]');
    expect(group.find('[data-test="ai-privacy-card"]').exists()).toBe(true);
    expect(group.find('[data-test="ai-entry-enabled"]').exists()).toBe(true);
    expect(group.find('[data-test="ai-privacy-host"]').text()).toBe(HOST);
  });

  it("⑥ 入口开关落盘失败 ⇒ 报错 + DOM 勾选态拉回真相（不许显示一个没写进去的入口）", async () => {
    const w = mount(SecurityPage);
    await flushPromises();

    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    await w.get('[data-test="ai-entry-enabled"]').setValue(true);
    await flushPromises();

    // 杀手：失败路径不 `syncCheckbox(aiEntryToggleEl, ...)` ⇒ 第二条红（界面说开了、磁盘没开）
    expect(w.get('[data-test="security-error"]').text()).toBe("设置保存失败，请重试");
    expect(w.get('[data-test="ai-entry-enabled"]').element).toHaveProperty("checked", false);
    expect(useAiChatStore().entryEnabled).toBe(false);
  });
});
