import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import LineChart from "@/components/charts/LineChart.vue";

describe("LineChart", () => {
  const props = {
    labels: ["08-01", "08-02", "08-03"],
    series: [
      { name: "收入", color: "#16a34a", values: [100, 0, 200] },
      { name: "支出", color: "#dc2626", values: [50, 80, 0] },
    ],
  };
  it("renders one <path> per series", () => {
    const w = mount(LineChart, { props });
    // 默认 fill=true 时每条系列额外渲染面积 path，故只统计折线 path（fill="none"）
    expect(w.findAll("path[fill='none']")).toHaveLength(props.series.length);
  });
  it("renders x-axis labels", () => {
    const w = mount(LineChart, { props });
    const text = w.findAll("text").map((t) => t.text());
    expect(text).toContain("08-01");
    expect(text).toContain("08-03");
  });
  it("shows tooltip on pointerdown and hides on pointerleave", async () => {
    const w = mount(LineChart, { props });
    const svg = w.find("svg");
    await svg.trigger("pointerdown", { clientX: 10, clientY: 10 });
    expect(w.find('[data-test="tooltip"]').exists()).toBe(true);
    await svg.trigger("pointerleave");
    expect(w.find('[data-test="tooltip"]').exists()).toBe(false);
  });
});
