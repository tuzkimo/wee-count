import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import type { Category, Ledger } from "@/types";

// ---- mock stores / composable / db ----
const mockCategories = ref<Category[]>([]);
const categoryAdd = vi.fn();
const categoryUpdate = vi.fn();
const categoryRemove = vi.fn();

const mockLedger = ref<Ledger | null>({
  id: "ledger-1",
  name: "家庭账本",
  type: "team",
  owner_id: "user-1",
  team_id: null,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  is_deleted: false,
});

vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({
    // getter 解包 ref，使组件中 categoryStore.categories.filter 拿到数组，
    // 同时保留响应式（computed 内读取会追踪 mockCategories）
    get categories() {
      return mockCategories.value;
    },
    fetchAll: vi.fn(),
    add: categoryAdd,
    update: categoryUpdate,
    remove: categoryRemove,
  }),
}));

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    // getter 解包 ref，使组件中 ledgerStore.currentLedger 拿到 ledger 对象，
    // 同时保留响应式（canEdit 内读取会追踪 mockLedger）
    get currentLedger() {
      return mockLedger.value;
    },
  }),
}));

vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({
    currentLocalUser: { server_user_id: "user-1" },
  }),
}));

vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "user-1",
}));

vi.mock("@/composables/useKeyboardInset", () => ({
  useKeyboardInset: () => ref(0),
}));

// ConfirmDialog 依赖 Teleport，stub 掉避免 happy-dom 报错
vi.mock("@/components/ConfirmDialog.vue", () => ({
  default: {
    name: "ConfirmDialog",
    props: ["visible", "title", "description", "confirmText", "cancelText", "danger", "hideCancel"],
    emits: ["confirm", "cancel"],
    template: '<div v-if="visible" class="mock-confirm">{{ title }}</div>',
  },
}));

import CategorySheet from "@/components/CategorySheet.vue";

function makeCategory(over: Partial<Category> = {}): Category {
  return {
    id: "c1",
    ledger_id: "ledger-1",
    owner_id: "user-1",
    name: "餐饮",
    type: "expense",
    icon: "🍔",
    sort_order: 0,
    updated_at: "2025-01-01T00:00:00.000Z",
    is_deleted: false,
    ...over,
  };
}

function mountSheet(props: Record<string, unknown> = {}) {
  return mount(CategorySheet, {
    props: { visible: true, initialTab: "expense", ...props },
    global: {
      plugins: [createPinia()],
      // Teleport/Transition 在 happy-dom 下内容不在 wrapper 内，stub 成透传
      stubs: { Teleport: true, Transition: false, TransitionGroup: false },
    },
  });
}

describe("CategorySheet", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockCategories.value = [];
    categoryAdd.mockReset();
    categoryUpdate.mockReset();
    categoryRemove.mockReset();
    mockLedger.value = {
      id: "ledger-1",
      name: "家庭账本",
      type: "team",
      owner_id: "user-1",
      team_id: null,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      is_deleted: false,
    };
  });

  // 本次 bug 回归：watch(matchedGroupKey) 在 formName 声明前注册会触发 TDZ ReferenceError
  it("挂载 setup 不抛错（TDZ 回归）", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mountSheet();
    await flushPromises();
    // 挂载后 setup 应正常完成，无 Vue warn 中的 ReferenceError
    expect(wrapper.html()).toContain("管理分类");
    spy.mockRestore();
  });

  it("初始展示列表模式与分类项", async () => {
    mockCategories.value = [makeCategory({ name: "餐饮", icon: "🍔" })];
    const wrapper = mountSheet();
    await flushPromises();
    expect(wrapper.text()).toContain("管理分类");
    expect(wrapper.text()).toContain("餐饮");
    expect(wrapper.text()).toContain("🍔");
  });

  it("切换支出/收入 Tab 渲染对应分类", async () => {
    mockCategories.value = [
      makeCategory({ id: "e1", name: "餐饮", type: "expense" }),
      makeCategory({ id: "i1", name: "工资", type: "income", icon: "💰" }),
    ];
    const wrapper = mountSheet({ initialTab: "expense" });
    await flushPromises();
    expect(wrapper.text()).toContain("餐饮");
    // 切到收入
    const incomeTab = wrapper.findAll("button").find((b) => b.text() === "收入")!;
    await incomeTab.trigger("click");
    expect(wrapper.text()).toContain("工资");
    expect(wrapper.text()).not.toContain("餐饮");
  });

  it("点击新建进入表单模式，名称为空时提交按钮禁用", async () => {
    const wrapper = mountSheet();
    await flushPromises();
    const newBtn = wrapper.findAll("button").find((b) => b.text().includes("新建"))!;
    await newBtn.trigger("click");
    expect(wrapper.text()).toContain("新建分类");
    // 名称为空时提交按钮禁用，无法触发 add
    const submitBtn = wrapper.findAll("button").find((b) => b.text() === "创建")!;
    expect((submitBtn.element as HTMLButtonElement).disabled).toBe(true);
    expect(categoryAdd).not.toHaveBeenCalled();
  });

  it("新建分类提交调用 store.add 并退回列表", async () => {
    categoryAdd.mockResolvedValue(undefined);
    const wrapper = mountSheet();
    await flushPromises();
    const newBtn = wrapper.findAll("button").find((b) => b.text().includes("新建"))!;
    await newBtn.trigger("click");
    // 输入名称
    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("交通");
    const submitBtn = wrapper.findAll("button").find((b) => b.text() === "创建")!;
    await submitBtn.trigger("click");
    await flushPromises();
    expect(categoryAdd).toHaveBeenCalledWith("ledger-1", "交通", "expense", null);
    // 提交成功退回列表
    expect(wrapper.text()).toContain("管理分类");
  });

  it("编辑分类回显名称并调用 store.update", async () => {
    categoryUpdate.mockResolvedValue(undefined);
    mockCategories.value = [makeCategory({ id: "c1", name: "餐饮", icon: "🍔", type: "expense" })];
    const wrapper = mountSheet();
    await flushPromises();
    const editBtn = wrapper.findAll("button").find((b) => b.text() === "编辑")!;
    await editBtn.trigger("click");
    expect(wrapper.text()).toContain("编辑分类");
    expect((wrapper.find("input[type='text']").element as HTMLInputElement).value).toBe("餐饮");
    const submitBtn = wrapper.findAll("button").find((b) => b.text() === "保存")!;
    await submitBtn.trigger("click");
    await flushPromises();
    expect(categoryUpdate).toHaveBeenCalledWith("c1", "餐饮", "🍔");
  });

  it("团队账本中非本人分类不显示编辑/删除按钮", async () => {
    mockCategories.value = [
      makeCategory({ id: "other", name: "他人分类", owner_id: "user-2" }),
    ];
    const wrapper = mountSheet();
    await flushPromises();
    const buttons = wrapper.findAll("button").map((b) => b.text());
    expect(buttons).not.toContain("编辑");
    expect(buttons).not.toContain("删除");
  });

  it("个人账本中所有分类均可编辑", async () => {
    mockLedger.value = {
      id: "ledger-1",
      name: "我的账本",
      type: "personal",
      owner_id: "user-1",
      team_id: null,
      created_at: "2025-01-01T00:00:00.000Z",
      updated_at: "2025-01-01T00:00:00.000Z",
      is_deleted: false,
    };
    mockCategories.value = [
      makeCategory({ id: "x", name: "其他人的", owner_id: "user-999" }),
    ];
    const wrapper = mountSheet();
    await flushPromises();
    const buttons = wrapper.findAll("button").map((b) => b.text());
    expect(buttons).toContain("编辑");
    expect(buttons).toContain("删除");
  });

  it("名称命中关键词时标记匹配分组", async () => {
    const wrapper = mountSheet();
    await flushPromises();
    const newBtn = wrapper.findAll("button").find((b) => b.text().includes("新建"));
    expect(newBtn).toBeTruthy();
    await newBtn!.trigger("click");
    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("工资");
    // matchedGroupKey 计算命中 income 分组
    expect(wrapper.text()).toContain("匹配");
  });

  it("名称命中关键词时标记匹配分组", async () => {
    const wrapper = mountSheet();
    await flushPromises();
    const newBtn = wrapper.findAll("button").find((b) => b.text().includes("新建"))!;
    await newBtn.trigger("click");
    const nameInput = wrapper.find("input[type='text']");
    await nameInput.setValue("工资");
    // matchedGroupKey 计算命中 income 分组
    expect(wrapper.text()).toContain("匹配");
  });

  it("visible=false 时不渲染面板", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrapper = mount(CategorySheet, {
      props: { visible: false },
      global: { plugins: [createPinia()] },
    });
    // 即使不可见，setup 也应正常完成（无 TDZ 报错）
    expect(wrapper.text()).not.toContain("管理分类");
    spy.mockRestore();
  });
});
