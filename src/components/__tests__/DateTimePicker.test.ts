import { describe, it, expect } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// 从 DateTimePicker.vue 的普通 script 块导入纯函数
import DateTimePicker, {
  generateYearMonthOptions,
  generateDayOptions,
  generateHourOptions,
  generateMinuteOptions,
  parseModelValue,
  getDefaultIndex,
} from "@/components/DateTimePicker.vue";

describe("generateYearMonthOptions", () => {
  it("should generate ±10 years of year-month options", () => {
    // Mock 当前年份为 2025
    const options = generateYearMonthOptions(2025);
    // ±10 年 × 12 个月 = 21 × 12 = 252 条
    expect(options.length).toBe(252);
    // 第一条是 2035年12月（未来最远）
    expect(options[0]).toEqual({ year: 2035, month: 12, label: "2035年12月" });
    // 最后一条是 2015年1月（过去最远）
    expect(options[251]).toEqual({ year: 2015, month: 1, label: "2015年1月" });
  });

  it("should start from current year + 10 December and end at current year - 10 January", () => {
    const options = generateYearMonthOptions(2026);
    expect(options[0]).toEqual({ year: 2036, month: 12, label: "2036年12月" });
    expect(options[options.length - 1]).toEqual({ year: 2016, month: 1, label: "2016年1月" });
  });
});

describe("generateDayOptions", () => {
  it("should generate 31 days for January", () => {
    const options = generateDayOptions(2025, 1);
    expect(options.length).toBe(31);
    expect(options[0]).toBe(1);
    expect(options[30]).toBe(31);
  });

  it("should generate 28 days for February non-leap year", () => {
    const options = generateDayOptions(2025, 2);
    expect(options.length).toBe(28);
  });

  it("should generate 29 days for February leap year", () => {
    const options = generateDayOptions(2024, 2);
    expect(options.length).toBe(29);
  });

  it("should generate 30 days for April", () => {
    const options = generateDayOptions(2025, 4);
    expect(options.length).toBe(30);
  });
});

describe("generateHourOptions", () => {
  it("should generate 00-23", () => {
    const options = generateHourOptions();
    expect(options.length).toBe(24);
    expect(options[0]).toBe("00");
    expect(options[23]).toBe("23");
  });
});

describe("generateMinuteOptions", () => {
  it("should generate 00-59 step 1", () => {
    const options = generateMinuteOptions();
    expect(options.length).toBe(60);
    expect(options[0]).toBe("00");
    expect(options[1]).toBe("01");
    expect(options[59]).toBe("59");
  });
});

describe("parseModelValue", () => {
  it("should parse YYYY-MM-DDTHH:mm format", () => {
    const result = parseModelValue("2025-06-12T14:30");
    expect(result).toEqual({
      year: 2025,
      month: 6,
      day: 12,
      hour: 14,
      minute: 30,
    });
  });

  it("should parse single-digit month/day", () => {
    const result = parseModelValue("2025-01-05T08:00");
    expect(result).toEqual({
      year: 2025,
      month: 1,
      day: 5,
      hour: 8,
      minute: 0,
    });
  });

  it("should return null for empty string", () => {
    expect(parseModelValue("")).toBeNull();
  });

  it("should return null for string without T separator", () => {
    expect(parseModelValue("2025-06-12")).toBeNull();
  });

  it("should return null for incomplete date parts", () => {
    expect(parseModelValue("2025-06T14:30")).toBeNull();
  });
});

describe("getDefaultIndex", () => {
  it("should find the index of matching value in array", () => {
    expect(getDefaultIndex(["00", "05", "10", "15"], "10")).toBe(2);
    expect(getDefaultIndex([1, 2, 3, 4, 5], 3)).toBe(2);
  });

  it("should return 0 if not found", () => {
    expect(getDefaultIndex(["00", "05"], "07")).toBe(0);
  });
});

describe("DateTimePicker confirm", () => {
  function mountPicker(props: { visible: boolean; modelValue: string }) {
    return mount(DateTimePicker, {
      props,
      global: {
        // Teleport 内容在 happy-dom 下不在 wrapper 内，stub 成透传
        stubs: { Teleport: true, Transition: false },
      },
    });
  }

  it("modelValue 年份超出 ±10 年范围时，确认原样回传而非回退到当前年", async () => {
    const wrapper = mountPicker({ visible: false, modelValue: "2010-05-01T10:00" });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    await wrapper.find("button.w-full").trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual(["2010-05-01T10:00"]);
  });

  it("越界初始值 + 用户滚动到新日期，确认回传新日期而非原始越界值", async () => {
    const wrapper = mountPicker({ visible: false, modelValue: "2010-05-01T10:00" });
    await wrapper.setProps({ visible: true });
    await flushPromises();

    // 模拟用户把年月列滚到第一个选项（currentYear+10 年 12 月）
    const ymScroll = wrapper.find({ ref: "ymScrollRef" });
    (ymScroll.element as HTMLElement).scrollTop = 0;
    await ymScroll.trigger("scroll");

    await wrapper.find("button.w-full").trigger("click");
    const y = new Date().getFullYear();
    // 回传用户滚动后的新日期，而不是初始越界值 2010-05-01
    expect(wrapper.emitted("confirm")?.[0]).toEqual([`${y + 10}-12-01T10:00`]);
  });

  it("modelValue 年月在范围内时，确认仍按选中值拼接", async () => {
    const y = new Date().getFullYear();
    const modelValue = `${y}-06-12T14:30`;
    const wrapper = mountPicker({ visible: false, modelValue });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    await wrapper.find("button.w-full").trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([modelValue]);
  });
});
