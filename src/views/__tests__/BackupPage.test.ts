// src/views/__tests__/BackupPage.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

const authMock = vi.hoisted(() => ({
  isAuthenticated: false,
  mode: "none" as string,
  isOnlineBound: false,
  currentLocalUser: null as Record<string, unknown> | null,
}));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => authMock }));
vi.mock("@/db/userDb", () => ({ getUserDb: vi.fn(() => ({})) }));
vi.mock("@/db/meta", () => ({
  getLocalUserByUsername: vi.fn(async () => null),
  getLocalUser: vi.fn(async () => null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn(), readTextFile: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.11.0") }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));

import BackupPage from "@/views/BackupPage.vue";

beforeEach(() => {
  authMock.isAuthenticated = false;
  authMock.mode = "none";
  authMock.isOnlineBound = false;
  authMock.currentLocalUser = null;
});

describe("BackupPage 区块自适应", () => {
  it("未登录（欢迎页进入）：只有恢复区块", () => {
    const wrapper = mount(BackupPage);
    expect(wrapper.text()).toContain("从备份文件恢复");
    expect(wrapper.text()).not.toContain("导出备份文件");
  });

  it("纯本地模式：导出与恢复都有", () => {
    authMock.isAuthenticated = true;
    authMock.mode = "local";
    const wrapper = mount(BackupPage);
    expect(wrapper.text()).toContain("导出备份文件");
    expect(wrapper.text()).toContain("从备份文件恢复");
  });

  it("在线模式（已绑定）：只有导出区块，含在线提示文案", () => {
    authMock.isAuthenticated = true;
    authMock.mode = "online";
    authMock.isOnlineBound = true;
    const wrapper = mount(BackupPage);
    expect(wrapper.text()).toContain("导出备份文件");
    expect(wrapper.text()).not.toContain("从备份文件恢复");
    expect(wrapper.text()).toContain("备份只包含已同步到本机的数据");
  });
});
