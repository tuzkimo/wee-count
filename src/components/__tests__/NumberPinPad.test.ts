import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import NumberPinPad from "@/components/lock/NumberPinPad.vue";
import { PIN_LENGTH } from "@/utils/pin";

async function press(w: ReturnType<typeof mount>, digit: string) {
  await w.find(`[data-test="pin-key-${digit}"]`).trigger("click");
}

describe("NumberPinPad", () => {
  it("渲染 0-9 十个数字键", () => {
    const w = mount(NumberPinPad);
    for (const d of ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]) {
      expect(w.find(`[data-test="pin-key-${d}"]`).exists()).toBe(true);
    }
  });

  it("满 PIN_LENGTH 位时提交", async () => {
    const w = mount(NumberPinPad);
    for (const d of "194726") await press(w, d);
    const submitted = w.emitted("submit");
    expect(submitted).toHaveLength(1);
    expect(submitted?.[0]).toEqual(["194726"]);
  });

  it("未满位数不提交", async () => {
    const w = mount(NumberPinPad);
    for (const d of "1947") await press(w, d);
    expect(w.emitted("submit")).toBeUndefined();
  });

  it("退格删除最后一位，补满后提交剩余位数", async () => {
    const w = mount(NumberPinPad);
    for (const d of "19472") await press(w, d);
    await w.find('[data-test="pin-backspace"]').trigger("click");
    // 退格精确删除一位：末位的 2 被删掉，剩余 1947。
    expect(w.findAll('[data-test="pin-dot-filled"]')).toHaveLength(4);
    for (const d of "6") await press(w, d);
    // 仍是 5 位，不足以提交。
    expect(w.emitted("submit")).toBeUndefined();
    // 补满第 6 位后提交，且被删掉的 2 不会回来。
    for (const d of "5") await press(w, d);
    expect(w.emitted("submit")?.[0]).toEqual(["194765"]);
  });

  it("error 变为 true 时清空已输入位数", async () => {
    const w = mount(NumberPinPad);
    for (const d of "1947") await press(w, d);
    await w.setProps({ error: true });
    expect(w.findAll('[data-test="pin-dot-filled"]')).toHaveLength(0);
  });

  it("禁用时不接受输入", async () => {
    const w = mount(NumberPinPad, { props: { disabled: true } });
    for (const d of "194726") await press(w, d);
    expect(w.emitted("submit")).toBeUndefined();
  });

  it("biometricAvailable 为真时显示指纹按钮并透传事件", async () => {
    const w = mount(NumberPinPad, { props: { biometricAvailable: true } });
    await w.find('[data-test="pin-biometric"]').trigger("click");
    expect(w.emitted("biometric")).toHaveLength(1);
  });

  it("biometricAvailable 为假时不显示指纹按钮", () => {
    const w = mount(NumberPinPad);
    expect(w.find('[data-test="pin-biometric"]').exists()).toBe(false);
  });

  it("PIN_LENGTH 为 6，因此渲染 6 个位数指示点", () => {
    expect(PIN_LENGTH).toBe(6);
    expect(mount(NumberPinPad).findAll('[data-test^="pin-dot"]')).toHaveLength(6);
  });
});