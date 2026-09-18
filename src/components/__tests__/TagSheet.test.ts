import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import type { TagWithUsage } from "@/types";

// ---- mock stores / composable ----
const mockTags = ref<TagWithUsage[]>([]);
const tagAdd = vi.fn();
const tagUpdate = vi.fn();
const tagRemove = vi.fn();

vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({
    // getter 解包 ref，使组件中 tagStore.tags.filter 拿到数组并保留响应式
    get tags() {
      return mockTags.value;
    },
    add: tagAdd,
    update: tagUpdate,
    remove: tagRemove,
  }),
}));

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    get currentLedger() {
      return {
        id: "ledger-1",
        name: "家庭账本",
        type: "personal",
        owner_id: "user-1",
        team_id: null,
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
        is_deleted: false,
      };
    },
  }),
}));

vi.mock("@/composables/useKeyboardInset", () => ({
  useKeyboardInset: () => ref(0),
}));

import TagSheet from "@/components/TagSheet.vue";

function makeTag(over: Partial<TagWithUsage> = {}): TagWithUsage {
  return {
    id: "t1",
    ledger_id: "ledger-1",
    name: "xxxyy",
    updated_at: "2025-01-01T00:00:00.000Z",
    is_deleted: false,
    usage_count: 0,
    ...over,
  };
}

function mountSheet(props: Record<string, unknown> = {}) {
  return mount(TagSheet, {
    props: { visible: true, selectedIds: [], ...props },
    global: {
      plugins: [createPinia()],
      // Teleport/Transition 在 happy-dom 下内容不在 wrapper 内，stub 成透传
      stubs: { Teleport: true, Transition: false, TransitionGroup: false },
    },
  });
}

function buttonByText(wrapper: ReturnType<typeof mountSheet>, text: string) {
  return wrapper.findAll("button").find((b) => b.text() === text)!;
}

async function enterManage(wrapper: ReturnType<typeof mountSheet>) {
  await buttonByText(wrapper, "管理").trigger("click");
}

describe("TagSheet", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockTags.value = [];
    tagAdd.mockReset();
    tagUpdate.mockReset();
    tagRemove.mockReset();
  });

  it("打开时展示已有标签列表", () => {
    mockTags.value = [makeTag({ name: "旅行" })];
    const wrapper = mountSheet();
    expect(wrapper.text()).toContain("添加标签");
    expect(wrapper.text()).toContain("旅行");
  });

  it("输入前缀命中已有标签时，匹配项与新建入口同时展示", async () => {
    mockTags.value = [makeTag({ name: "xxxyy" })];
    const wrapper = mountSheet();
    const input = wrapper.find("input[type='text']");
    await input.setValue("xxx");
    expect(wrapper.text()).toContain("xxxyy");
    expect(wrapper.text()).toContain('创建标签 "xxx"');
  });

  it("输入与已有标签完全同名（忽略大小写）时，不显示新建入口", async () => {
    mockTags.value = [makeTag({ name: "xxxyy" })];
    const wrapper = mountSheet();
    const input = wrapper.find("input[type='text']");
    await input.setValue("XXXYy");
    expect(wrapper.text()).toContain("xxxyy");
    expect(wrapper.text()).not.toContain("创建标签");
  });

  it("空输入不显示新建入口", () => {
    mockTags.value = [makeTag({ name: "旅行" })];
    const wrapper = mountSheet();
    expect(wrapper.text()).not.toContain("创建标签");
  });

  it("点击新建入口调用 store.add 并选中新标签", async () => {
    tagAdd.mockResolvedValue(makeTag({ id: "t-new", name: "xxx" }));
    const wrapper = mountSheet();
    const input = wrapper.find("input[type='text']");
    await input.setValue("xxx");
    const createBtn = wrapper
      .findAll("button")
      .find((b) => b.text().includes("创建标签"))!;
    await createBtn.trigger("click");
    await flushPromises();
    expect(tagAdd).toHaveBeenCalledWith("ledger-1", "xxx");
    // 创建后搜索框清空，新标签进入选中集合
    expect((input.element as HTMLInputElement).value).toBe("");
    const confirmBtn = wrapper
      .findAll("button")
      .find((b) => b.text() === "确定")!;
    await confirmBtn.trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual([["t-new"]]);
  });
});

describe("TagSheet 管理模式", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockTags.value = [];
    tagAdd.mockReset();
    tagUpdate.mockReset();
    tagRemove.mockReset();
  });

  it("切到管理模式后展示标签使用次数，且隐藏确定按钮", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行", usage_count: 3 })];
    const wrapper = mountSheet();

    await enterManage(wrapper);

    expect(wrapper.text()).toContain("管理标签");
    expect(wrapper.text()).toContain("3 次");
    expect(wrapper.findAll("button").some((b) => b.text() === "确定")).toBe(false);
  });

  it("管理模式下点标签行不改变选中集合", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行" })];
    const wrapper = mountSheet();

    await enterManage(wrapper);
    await wrapper.find('[data-test="manage-tag-row"]').trigger("click");
    await buttonByText(wrapper, "完成").trigger("click");
    await buttonByText(wrapper, "确定").trigger("click");

    expect(wrapper.emitted("confirm")![0]).toEqual([[]]);
  });

  it("点编辑打开预填名称的表单，保存调用 store.update", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行", usage_count: 2 })];
    tagUpdate.mockResolvedValue(undefined);
    const wrapper = mountSheet();

    await enterManage(wrapper);
    await wrapper.find('[data-test="tag-edit"]').trigger("click");
    const input = wrapper.find('[data-test="tag-name-input"]');
    expect((input.element as HTMLInputElement).value).toBe("旅行");

    await input.setValue("出差");
    await buttonByText(wrapper, "保存").trigger("click");
    await flushPromises();

    expect(tagUpdate).toHaveBeenCalledWith("t1", "出差");
    // 保存成功后回到管理列表
    expect(wrapper.find('[data-test="tag-name-input"]').exists()).toBe(false);
  });

  it("改名冲突时展示错误并停留在表单", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行" })];
    tagUpdate.mockRejectedValue(new Error("同名标签已存在"));
    const wrapper = mountSheet();

    await enterManage(wrapper);
    await wrapper.find('[data-test="tag-edit"]').trigger("click");
    await buttonByText(wrapper, "保存").trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("同名标签已存在");
    expect(wrapper.find('[data-test="tag-name-input"]').exists()).toBe(true);
  });

  it("删除前二次确认，被使用的标签提示记录数，确认后调用 store.remove", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行", usage_count: 3 })];
    tagRemove.mockResolvedValue(undefined);
    const wrapper = mountSheet();

    await enterManage(wrapper);
    await wrapper.find('[data-test="tag-delete"]').trigger("click");

    expect(wrapper.text()).toContain("该标签被 3 笔记录使用");
    await buttonByText(wrapper, "删除").trigger("click");
    await flushPromises();

    expect(tagRemove).toHaveBeenCalledWith("t1");
  });

  it("未被使用的标签删除时不提示记录数", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行", usage_count: 0 })];
    const wrapper = mountSheet();

    await enterManage(wrapper);
    await wrapper.find('[data-test="tag-delete"]').trigger("click");

    expect(wrapper.text()).not.toContain("笔记录使用");
  });

  it("重新打开 sheet 时回到选择模式", async () => {
    mockTags.value = [makeTag({ id: "t1", name: "旅行" })];
    const wrapper = mountSheet();

    await enterManage(wrapper);
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });

    expect(wrapper.text()).toContain("添加标签");
    expect(wrapper.text()).not.toContain("管理标签");
  });
});
