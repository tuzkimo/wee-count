import { describe, it, expect, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AmountMaskToggle from "@/components/AmountMaskToggle.vue";
import { usePrefsStore } from "@/stores/prefs";

describe("AmountMaskToggle", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("隐藏状态下无障碍标签为「显示金额」", () => {
    const w = mount(AmountMaskToggle);
    expect(w.attributes("aria-label")).toBe("显示金额");
  });

  it("点击后切换全局遮蔽状态并更新标签", async () => {
    const w = mount(AmountMaskToggle);
    const prefs = usePrefsStore();

    await w.trigger("click");
    expect(prefs.amountsHidden).toBe(false);
    expect(w.attributes("aria-label")).toBe("隐藏金额");

    await w.trigger("click");
    expect(prefs.amountsHidden).toBe(true);
    expect(w.attributes("aria-label")).toBe("显示金额");
  });

  it("外部改动 store 时按钮标签跟随（证明是同一状态源）", async () => {
    const w = mount(AmountMaskToggle);
    usePrefsStore().showAmounts();
    await w.vm.$nextTick();
    expect(w.attributes("aria-label")).toBe("隐藏金额");
  });
});
