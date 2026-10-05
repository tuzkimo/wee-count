import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

/**
 * 期初金额的锁定判据是「该账户是否已有流水」，不是「是否处于编辑态」。
 *
 * 危害来自历史：账户一旦有流水，改期初会让已发生的报表跟着变形；而没有流水的
 * 账户改期初只是修正一个刚填错的数字，锁死它反而逼用户删账户重建。
 */
const h = vi.hoisted(() => ({
  account: {
    id: "acc-1",
    ledger_id: "l1",
    owner_id: "u1",
    name: "招商银行",
    type: "bank",
    category: "asset",
    initial_balance: 1000,
    color: "#3b82f6",
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    is_deleted: false,
    current_balance: 1000,
  },
  mockBack: vi.fn(),
  mockReplace: vi.fn(),
  mockUpdate: vi.fn(),
  mockRemove: vi.fn(),
  mockSelect: vi.fn(),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "acc-1" }, query: {} }),
  useRouter: () => ({ back: h.mockBack, replace: h.mockReplace }),
}));
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ init: vi.fn(async () => {}), currentLedger: { id: "l1" } }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({
    accounts: [h.account],
    fetchAll: vi.fn(async () => {}),
    update: h.mockUpdate,
    remove: h.mockRemove,
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: { server_user_id: "u1" } }),
}));
vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "u1",
  getUserDb: () => ({ select: h.mockSelect }),
}));

import AccountEdit from "@/views/AccountEdit.vue";

async function mountPage(txCount: number) {
  h.mockSelect.mockResolvedValue([{ count: txCount }]);
  const w = mount(AccountEdit, {
    global: { stubs: { AppHeader: true, ConfirmDialog: true } },
  });
  await flushPromises();
  return w;
}

function initialInput(wrapper: Awaited<ReturnType<typeof mountPage>>) {
  const input = wrapper.find('input[type="number"]');
  if (!input.exists()) throw new Error("未找到期初金额输入框");
  return input;
}

describe("AccountEdit 期初金额锁定", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    h.mockSelect.mockReset();
    h.mockUpdate.mockReset();
    h.mockRemove.mockReset();
  });

  it("账户无流水：期初金额可改（留一条填错能救回来的路）", async () => {
    const w = await mountPage(0);
    expect(initialInput(w).attributes("readonly")).toBeUndefined();
  });

  it("账户已有流水：期初金额只读，且查询按账户两侧统计未删除流水", async () => {
    const w = await mountPage(3);
    expect(initialInput(w).attributes("readonly")).toBeDefined();
    expect(w.text()).toContain("不可再修改");

    expect(h.mockSelect).toHaveBeenCalledTimes(1);
    const [sql, params] = h.mockSelect.mock.calls[0];
    expect(sql).toContain("COUNT(*)");
    expect(sql).toContain("from_account_id = ?");
    expect(sql).toContain("to_account_id = ?");
    expect(params).toEqual(["acc-1", "acc-1"]);
  });

  it("账户无流水：保存仍会提交 initial_balance（否则能编辑却改不动，等于静默丢弃）", async () => {
    const w = await mountPage(0);
    await initialInput(w).setValue("2500");
    const saveBtn = w.findAll("button").find((b) => b.text().includes("保存"));
    if (!saveBtn) throw new Error("未找到保存按钮");
    await saveBtn.trigger("click");
    await flushPromises();

    expect(h.mockUpdate).toHaveBeenCalledTimes(1);
    const [, payload] = h.mockUpdate.mock.calls[0];
    expect(payload.initial_balance).toBe(2500);
  });

  it("保存只提交账户字段：payload 不含 initial_balance，期初值不可能被顺手改掉", async () => {
    const w = await mountPage(3);
    const saveBtn = w.findAll("button").find((b) => b.text().includes("保存"));
    if (!saveBtn) throw new Error("未找到保存按钮");
    await saveBtn.trigger("click");
    await flushPromises();

    expect(h.mockUpdate).toHaveBeenCalledTimes(1);
    const [id, payload] = h.mockUpdate.mock.calls[0];
    expect(id).toBe("acc-1");
    expect(Object.keys(payload)).not.toContain("initial_balance");
    expect(payload.name).toBe("招商银行");
  });
});
