import { describe, it, expect, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import CalendarMonth from "@/components/CalendarMonth.vue";
import DateRangePicker from "@/components/DateRangePicker.vue";
import { buildPresetRange, toDateKey, type DateRange } from "@/utils/dateRange";

// 组件在 onMounted 读 matchMedia 决定单月/双月，测试里直接替换 window.matchMedia
const originalMatchMedia = window.matchMedia;

function setWide(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({
      matches,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
});

// 月内某天（样例月份固定为 2026-08，便于断言）
function mountPicker(modelValue: DateRange, wide = false) {
  setWide(wide);
  return mount(DateRangePicker, {
    props: { visible: false, modelValue },
    global: {
      // Teleport 内容在 happy-dom 下不在 wrapper 内，stub 成透传
      stubs: { Teleport: true, Transition: false },
    },
  });
}

/** 挂载后再打开：与真实用法一致，会触发 visible watcher 重建草稿 */
async function openPicker(modelValue: DateRange, wide = false) {
  const wrapper = mountPicker(modelValue, wide);
  await wrapper.setProps({ visible: true });
  await flushPromises();
  return wrapper;
}

const AUG = { start: "2026-08-01", end: "2026-08-15" };

describe("DateRangePicker 日期连选", () => {
  it("打开时恢复已有范围并定位到起始月", async () => {
    const wrapper = await openPicker(AUG);
    expect(wrapper.find('[data-test="range-label"]').text()).toBe("2026年8月1日 - 8月15日 · 15天");
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2026年8月");
  });

  it("点两次日期生成范围并回传（含首尾整天，day 粒度）", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-date="2026-08-03"]').trigger("click");
    await wrapper.find('[data-date="2026-08-20"]').trigger("click");
    expect(wrapper.find('[data-test="range-label"]').text()).toBe("2026年8月3日 - 8月20日 · 18天");
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ start: "2026-08-03", end: "2026-08-20" }]);
  });

  it("第二次点早于起点时交换两端，不逼用户重来", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-date="2026-08-20"]').trigger("click");
    await wrapper.find('[data-date="2026-08-03"]').trigger("click");
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ start: "2026-08-03", end: "2026-08-20" }]);
  });

  it("已有完整范围时再次点击，该日成为新起点并清掉旧终点", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-date="2026-08-20"]').trigger("click");
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ start: "2026-08-20", end: "" }]);
  });

  it("只选一天即确定 → 单边「从该日起」", async () => {
    const wrapper = await openPicker({ start: "", end: "" });
    const todayKey = toDateKey(new Date());
    const prefix = todayKey.slice(0, 7);
    const year = Number(prefix.slice(0, 4));
    const month = Number(prefix.slice(5, 7));
    await wrapper.find(`[data-date="${prefix}-10"]`).trigger("click");
    expect(wrapper.find('[data-test="range-label"]').text()).toBe(`${year}年${month}月10日 起`);
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ start: `${prefix}-10`, end: "" }]);
  });

  it("清除按钮清空草稿并可回传空范围", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-test="range-clear"]').trigger("click");
    expect(wrapper.find('[data-test="range-label"]').text()).toBe("请选择日期范围");
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ start: "", end: "" }]);
  });

  it("取消不 emit confirm，只 emit close", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-date="2026-08-20"]').trigger("click");
    await wrapper.find('[data-test="range-cancel"]').trigger("click");
    expect(wrapper.emitted("confirm")).toBeUndefined();
    expect(wrapper.emitted("close")).toHaveLength(1);
  });

  it("重新打开时不残留上次未确认的草稿", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-date="2026-08-20"]').trigger("click");
    await wrapper.setProps({ visible: false });
    await wrapper.setProps({ visible: true });
    await flushPromises();
    expect(wrapper.find('[data-test="range-label"]').text()).toBe("2026年8月1日 - 8月15日 · 15天");
  });

  it("悬停预览待选范围；反向悬停（早于起点）同样成带", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-date="2026-08-10"]').trigger("click");

    // 正向悬停：中间日带上浅色带，悬停日为预览终点
    await wrapper.find('[data-date="2026-08-15"]').trigger("mouseenter");
    expect(wrapper.find('[data-cell="2026-08-12"]').classes()).toContain("bg-primary/10");
    expect(wrapper.find('[data-date="2026-08-15"]').classes()).toContain("bg-primary");

    // 反向悬停：8/5 早于起点 8/10，仍应预览 8/5-8/10 这条带
    await wrapper.find('[data-date="2026-08-05"]').trigger("mouseenter");
    expect(wrapper.find('[data-cell="2026-08-08"]').classes()).toContain("bg-primary/10");
    expect(wrapper.find('[data-date="2026-08-05"]').classes()).toContain("bg-primary");
    expect(wrapper.find('[data-date="2026-08-10"]').classes()).toContain("bg-primary");

    // 移出日历后回到单点，不带残留预览
    await wrapper.find('[data-date="2026-08-05"]').trigger("mouseleave");
    expect(wrapper.find('[data-cell="2026-08-08"]').classes()).not.toContain("bg-primary/10");
    expect(wrapper.find('[data-date="2026-08-10"]').classes()).toContain("bg-primary");
  });
});

describe("DateRangePicker 快捷范围", () => {  it("点 chip 一键选定并高亮，确定回传该范围", async () => {
    const wrapper = await openPicker({ start: "", end: "" });
    const chip = wrapper.find('[data-preset="thisMonth"]');
    await chip.trigger("click");
    expect(chip.classes()).toContain("bg-primary");
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([buildPresetRange("thisMonth", new Date())]);
  });

  it("chip 高亮是派生状态：手动改日期后自动消失", async () => {
    const wrapper = await openPicker({ start: "", end: "" });
    await wrapper.find('[data-preset="thisMonth"]').trigger("click");
    expect(wrapper.find('[data-preset="thisMonth"]').classes()).toContain("bg-primary");

    const todayKey = toDateKey(new Date());
    await wrapper.find(`[data-date="${todayKey}"]`).trigger("click");
    expect(wrapper.find('[data-preset="thisMonth"]').classes()).not.toContain("bg-primary");
  });

  it("命中快捷范围时同样高亮（外部传入的范围也能识别）", async () => {
    const wrapper = await openPicker(buildPresetRange("lastMonth", new Date()));
    expect(wrapper.find('[data-preset="lastMonth"]').classes()).toContain("bg-primary");
  });

  it("点 chip 后日历定位到该范围的起始月", async () => {
    const wrapper = await openPicker({ start: "", end: "" });
    await wrapper.find('[data-preset="lastYear"]').trigger("click");
    const expected = buildPresetRange("lastYear", new Date());
    expect(wrapper.find('[data-test="month-title"]').text()).toBe(
      `${expected.start.slice(0, 4)}年1月`
    );
  });
});

describe("DateRangePicker 月份导航", () => {
  it("翻上/下月", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-test="next-month"]').trigger("click");
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2026年9月");
    await wrapper.find('[data-test="prev-month"]').trigger("click");
    await wrapper.find('[data-test="prev-month"]').trigger("click");
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2026年7月");
  });

  it("年/月面板可快速跳到任意年月", async () => {
    const wrapper = await openPicker(AUG);
    await wrapper.find('[data-test="month-title"]').trigger("click");
    expect(wrapper.find('[data-test="month-panel"]').exists()).toBe(true);
    // 面板打开时日历让位
    expect(wrapper.find('[data-date="2026-08-10"]').exists()).toBe(false);

    await wrapper.find('[data-test="prev-year"]').trigger("click");
    await wrapper.find('[data-test="prev-decade"]').trigger("click");
    expect(wrapper.find('[data-test="panel-year"]').text()).toBe("2015年");

    await wrapper.find('[data-month="3"]').trigger("click");
    expect(wrapper.find('[data-test="month-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2015年3月");
    expect(wrapper.find('[data-date="2015-03-10"]').exists()).toBe(true);
  });
});

describe("DateRangePicker 单月 / 双月", () => {
  it("窄屏渲染单月", async () => {
    const wrapper = await openPicker(AUG, false);
    expect(wrapper.findAllComponents(CalendarMonth)).toHaveLength(1);
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2026年8月");
  });

  it("宽屏并排两个月，翻月以后一个月为基准", async () => {
    const wrapper = await openPicker(AUG, true);
    expect(wrapper.findAllComponents(CalendarMonth)).toHaveLength(2);
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2026年8月 / 2026年9月");
    // 两个月的日期都可点
    expect(wrapper.find('[data-date="2026-08-10"]').exists()).toBe(true);
    expect(wrapper.find('[data-date="2026-09-10"]').exists()).toBe(true);

    await wrapper.find('[data-test="next-month"]').trigger("click");
    expect(wrapper.find('[data-test="month-title"]').text()).toBe("2026年9月 / 2026年10月");
  });

  it("宽屏下跨月连选", async () => {
    const wrapper = await openPicker(AUG, true);
    await wrapper.find('[data-date="2026-08-28"]').trigger("click");
    await wrapper.find('[data-date="2026-09-03"]').trigger("click");
    await wrapper.find('[data-test="range-confirm"]').trigger("click");
    expect(wrapper.emitted("confirm")?.[0]).toEqual([{ start: "2026-08-28", end: "2026-09-03" }]);
  });
});
