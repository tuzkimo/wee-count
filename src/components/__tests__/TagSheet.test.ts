import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import type { Tag } from "@/types";

// ---- mock stores / composable ----
const mockTags = ref<Tag[]>([]);
const tagAdd = vi.fn();

vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({
    // getter 解包 ref，使组件中 tagStore.tags.filter 拿到数组并保留响应式
    get tags() {
      return mockTags.value;
    },
    add: tagAdd,
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

function makeTag(over: Partial<Tag> = {}): Tag {
  return {
    id: "t1",
    ledger_id: "ledger-1",
    name: "xxxyy",
    updated_at: "2025-01-01T00:00:00.000Z",
    is_deleted: false,
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

describe("TagSheet", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    mockTags.value = [];
    tagAdd.mockReset();
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
