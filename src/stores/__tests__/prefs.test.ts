import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { usePrefsStore } from "@/stores/prefs";

describe("prefs store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("默认隐藏金额", () => {
    expect(usePrefsStore().amountsHidden).toBe(true);
  });

  it("toggleAmounts 在显示与隐藏之间切换", () => {
    const prefs = usePrefsStore();
    prefs.toggleAmounts();
    expect(prefs.amountsHidden).toBe(false);
    prefs.toggleAmounts();
    expect(prefs.amountsHidden).toBe(true);
  });

  it("showAmounts / hideAmounts 幂等", () => {
    const prefs = usePrefsStore();
    prefs.showAmounts();
    prefs.showAmounts();
    expect(prefs.amountsHidden).toBe(false);
    prefs.hideAmounts();
    prefs.hideAmounts();
    expect(prefs.amountsHidden).toBe(true);
  });

  it("不同 pinia 实例之间不共享状态（确认不是模块级单例）", () => {
    const first = usePrefsStore();
    first.showAmounts();
    setActivePinia(createPinia());
    expect(usePrefsStore().amountsHidden).toBe(true);
  });
});
