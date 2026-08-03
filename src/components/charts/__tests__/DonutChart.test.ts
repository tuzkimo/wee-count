import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import DonutChart from "@/components/charts/DonutChart.vue";

describe("DonutChart", () => {
  const segments = [
    { id: "c1", name: "餐饮", total: 100, color: "#f97316" },
    { id: "c2", name: "交通", total: 50, color: "#3b82f6" },
  ];
  it("renders one path per segment", () => {
    const w = mount(DonutChart, { props: { segments } });
    expect(w.findAll("path")).toHaveLength(2);
  });
  it("emits segment-click with the segment on click", async () => {
    const w = mount(DonutChart, { props: { segments } });
    await w.findAll("path")[0].trigger("click");
    expect(w.emitted("segment-click")![0][0]).toEqual(segments[0]);
  });
  it("shows center value text", () => {
    const w = mount(DonutChart, { props: { segments, centerLabel: "支出", centerValue: "150.00" } });
    expect(w.text()).toContain("支出");
    expect(w.text()).toContain("150.00");
  });
  it("renders a <circle> (not a degenerate path) for a single 100% segment and emits on click", async () => {
    const seg = { id: "only", name: "全部", total: 100, color: "#16a34a" };
    const w = mount(DonutChart, { props: { segments: [seg] } });
    const circles = w.findAll("circle");
    expect(circles).toHaveLength(1);
    expect(w.findAll("path")).toHaveLength(0);
    await circles[0].trigger("click");
    expect(w.emitted("segment-click")![0][0]).toEqual(seg);
  });
});
