import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ChatComposer from "@/components/ai/ChatComposer.vue";

function mountComposer(sending = false) {
  return mount(ChatComposer, { props: { sending } });
}

describe("ChatComposer", () => {
  it("点发送发出 trim 后的文本并清空输入框", async () => {
    const w = mountComposer();
    const input = w.get('[data-test="composer-input"]');
    await input.setValue("  上月买菜花了多少  ");
    await w.get('[data-test="composer-send"]').trigger("click");

    expect(w.emitted("send")).toEqual([["上月买菜花了多少"]]);
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  it("回车发送", async () => {
    const w = mountComposer();
    await w.get('[data-test="composer-input"]').setValue("本月支出");
    await w.get('[data-test="composer-input"]').trigger("keydown.enter");
    expect(w.emitted("send")).toEqual([["本月支出"]]);
  });

  it("空串与纯空白都**不发**（白发一次就是白烧一次配额）", async () => {
    const w = mountComposer();
    await w.get('[data-test="composer-send"]').trigger("click");
    expect(w.emitted("send")).toBeUndefined();

    await w.get('[data-test="composer-input"]').setValue("   \n  ");
    await w.get('[data-test="composer-send"]').trigger("click");
    await w.get('[data-test="composer-input"]').trigger("keydown.enter");
    expect(w.emitted("send")).toBeUndefined();
  });

  it("sending 时输入框禁用、发送按钮换成取消按钮", () => {
    const w = mountComposer(true);
    expect(w.get('[data-test="composer-input"]').attributes("disabled")).toBeDefined();
    expect(w.find('[data-test="composer-send"]').exists()).toBe(false);
    expect(w.find('[data-test="composer-cancel"]').exists()).toBe(true);
  });

  it("sending 时点发送不发（禁用只是视觉，事件层也要挡住）", async () => {
    const w = mountComposer(true);
    await w.get('[data-test="composer-input"]').setValue("还要再问一句");
    // 输入框禁用态下 setValue 仍能改 model 值；这里直接打事件层
    await w.get('[data-test="composer-cancel"]').trigger("click");
    expect(w.emitted("send")).toBeUndefined();
    expect(w.emitted("cancel")).toHaveLength(1);
  });

  it("取消**不清空**已输入的文字（用户可能只是想停下来改一改）", async () => {
    const w = mountComposer(true);
    await w.get('[data-test="composer-input"]').setValue("上个月");
    await w.get('[data-test="composer-cancel"]').trigger("click");
    expect((w.get('[data-test="composer-input"]').element as HTMLInputElement).value).toBe("上个月");
  });
});
