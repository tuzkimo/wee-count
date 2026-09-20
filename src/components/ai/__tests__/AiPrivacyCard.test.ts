import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import AiPrivacyCard from "@/components/ai/AiPrivacyCard.vue";

const HOST = "ai.example.com";

describe("AiPrivacyCard（§7.3:472-480）", () => {
  it("① 拿不到 `host` ⇒ **整个组件不渲染**（哨兵，不是「变灰」）", () => {
    const w = mount(AiPrivacyCard, { props: { host: null, seen: false } });
    // 杀手：去掉模板上的 `v-if="props.host !== null"` ⇒ 这条红（会给一个不知道发给谁的同意书）
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
    expect(w.text()).not.toContain("知道了");
  });

  it("② 有 `host` 就渲染，且文案里**逐字**带着那个 host（§7.3:474）", () => {
    const w = mount(AiPrivacyCard, { props: { host: HOST, seen: false } });
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(true);
    expect(w.get('[data-test="ai-privacy-host"]').text()).toBe(HOST);
    // 规格原文的三件事都在（"最多发送前 20 条" / 可随时关闭 / 发什么）
    const text = w.text();
    expect(text).toContain("最多发送前 20 条");
    expect(text).toContain("我的 → 隐私");
    expect(text).toContain("关闭");
  });

  it("③ 看过（`seen=true`）⇒ 不再自动弹；但 `host` 仍在时组件本身还是同一个", () => {
    const w = mount(AiPrivacyCard, { props: { host: HOST, seen: true } });
    // 杀手：把 `seen` 从条件里去掉 ⇒ 这条红（每次进页面都弹一次）
    expect(w.find('[data-test="ai-privacy-card"]').exists()).toBe(false);
  });

  it("④ 必须说明**会话历史是明文落盘**（§7.3:480 明确要求讲清楚）", () => {
    const w = mount(AiPrivacyCard, { props: { host: HOST, seen: false } });
    const plaintext = w.get('[data-test="ai-privacy-plaintext"]').text();
    // 杀手：删掉那一段 ⇒ 这条红
    expect(plaintext).toContain("明文落盘");
    expect(plaintext).toContain("金额与备注");
    // ⚠️ 反向：不许出现"加密"字样（说成加密就是制造安全错觉；`SecurityPage` 页尾同一原则）
    for (const word of ["加密", "保密", "安全存储"]) {
      expect(w.text()).not.toContain(word);
    }
  });

  it("点「知道了」只发事件（写盘由调用方决定，组件不碰 store）", async () => {
    const w = mount(AiPrivacyCard, { props: { host: HOST, seen: false } });
    await w.get('[data-test="ai-privacy-card-dismiss"]').trigger("click");
    expect(w.emitted("dismiss")).toHaveLength(1);
  });
});
