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

  it("sending 时两个入口都真的发不出去（事件层，不只看禁用属性）", async () => {
    // ⚠️ 这条用例守的是**回车入口的唯一防线**：`<input>` 的 `:disabled="sending"`。
    // 判别力全靠下一行**必须走 `setValue`** —— 它会真派发 `input` 事件把 `text` 写成非空。
    // 曾经这里写的是 `(input.element).value = "..."`（只改 DOM、绕过 v-model）：`text` 仍是 `""`，
    // `onSend` 被**更早的** `if (value === "") return` 挡住 ⇒ 删掉 `:disabled` 这条用例照绿 = 零判别力
    // （复审 m15 定位到具体一行；改回 `setValue` 后 m15b 实测 2 红）。
    const w = mountComposer(true);
    const input = w.get('[data-test="composer-input"]');
    await input.setValue("还要再问一句");
    await input.trigger("keydown.enter");
    // 发送按钮在 sending 时**不渲染**（v-if），所以这里没有第二颗可点的按钮
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
