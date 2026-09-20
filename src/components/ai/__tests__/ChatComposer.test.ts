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
    // ⚠️ 这条用例是**唯一**守着「生成中不许再发」的地方，因为它守的是模板的 `:disabled`
    // —— 那是这条规则**唯一**的防线（脚本里没有 `if (sending) return`，Ruling 35：等价防御不留）。
    // 判别力实测（探针，跑完已移走）：`sending=true` 时对输入框 `trigger("keydown.enter")`
    // ⇒ `emitted("send") === undefined`（禁用元素在**事件派发层**就不触发处理器，
    // happy-dom 如此、真实浏览器亦如此）；`composer-send` 在 sending 时**根本不渲染**。
    // 反面对照在下面：把 `:disabled` 去掉（或让发送按钮照常渲染），这条必须红。
    const w = mountComposer(true);
    const input = w.get('[data-test="composer-input"]');
    // 绕过 UI 直接改 DOM 值，把"能不能发出去"这件事逼到事件层来判
    (input.element as HTMLInputElement).value = "还要再问一句";
    await input.trigger("keydown.enter");
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
