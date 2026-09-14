import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import PatternLock from "@/components/lock/PatternLock.vue";

const SIZE = 300;

/** happy-dom 不做布局，getBoundingClientRect 恒为 0，必须手动给尺寸才能算命中。 */
function stubLayout(width: number) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0, top: 0, right: width, bottom: width,
    width, height: width, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}

/** 点位中心（size=300 时 cell=100） */
const center = (dot: number) => ({
  clientX: ((dot - 1) % 3 + 0.5) * (SIZE / 3),
  clientY: (Math.floor((dot - 1) / 3) + 0.5) * (SIZE / 3),
  pointerId: 1,
});

async function drag(w: ReturnType<typeof mount>, dots: number[]) {
  const svg = w.find("svg");
  await svg.trigger("pointerdown", center(dots[0]));
  for (const dot of dots.slice(1)) await svg.trigger("pointermove", center(dot));
  await svg.trigger("pointerup", { pointerId: 1 });
}

describe("PatternLock", () => {
  beforeEach(() => stubLayout(SIZE));
  afterEach(() => vi.restoreAllMocks());

  it("渲染 9 个点位", () => {
    const w = mount(PatternLock, { props: { size: SIZE } });
    expect(w.findAll('[data-test^="pattern-dot-"]')).toHaveLength(9);
  });

  it("连出 4 个点后提交规范化序列", async () => {
    const w = mount(PatternLock, { props: { size: SIZE } });
    await drag(w, [1, 2, 3, 5]);
    expect(w.emitted("complete")?.[0]).toEqual([[1, 2, 3, 5]]);
  });

  it("跨过中间点时自动补入（1→3 得到 [1,2,3,4]）", async () => {
    const w = mount(PatternLock, { props: { size: SIZE } });
    await drag(w, [1, 3, 6, 9]);
    expect(w.emitted("complete")?.[0]).toEqual([[1, 2, 3, 6, 9]]);
  });

  it("少于 4 点时不提交，发出 invalid", async () => {
    const w = mount(PatternLock, { props: { size: SIZE } });
    await drag(w, [1, 2, 3]);
    expect(w.emitted("complete")).toBeUndefined();
    expect(w.emitted("invalid")).toHaveLength(1);
  });

  it("disabled 时不响应手势", async () => {
    const w = mount(PatternLock, { props: { size: SIZE, disabled: true } });
    await drag(w, [1, 2, 3, 5]);
    expect(w.emitted("complete")).toBeUndefined();
    expect(w.emitted("invalid")).toBeUndefined();
  });
});
