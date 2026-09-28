// `ImageLightbox`（点图片 ⇒ 全屏预览）组件层用例。
//
// 这一层钉的是**接线**：
//  1. 手势事件（pointer down/move/up）确实是接到 `imageZoom` 那三个纯函数上的 ——
//     算术本身在 `imageZoom.test.ts` 里逐条钉，这里只看"事件驱动了状态"。
//  2. 关闭的三条路：背板、✕、Android 返回键（popstate）。
//  3. 哨兵条目的收尾：程序化关闭要自己收回，外部前进后退不许残留
//     （残留的形态就是"查看器关掉了，但返回键从此被吞掉一次"）。
//
// 断言读的是**图片上的 transform**（`translate(...) scale(...)`）—— 它是用户真正看得见的那份输出，
// 不是内部状态。所以每个手势用例都配一句"改哪一行能让它红"。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import ImageLightbox from "@/components/ImageLightbox.vue";

const SRC = "data:image/jpeg;base64,AAAA";

/** 宿主：`visible` 由它管（组件本身是受控的），关闭事件回到它这里 */
const Host = defineComponent({
  components: { ImageLightbox },
  setup() {
    const visible = ref(false);
    const masked = ref(false);
    return {
      visible,
      masked,
      SRC,
      onClose: () => {
        visible.value = false;
      },
    };
  },
  template: `
    <div>
      <button data-test="host-open" @click="visible = true">打开</button>
      <button data-test="host-mask" @click="masked = !masked">模糊</button>
      <ImageLightbox :visible="visible" :src="SRC" :masked="masked" @close="onClose" />
    </div>
  `,
});

function mountHost(): VueWrapper {
  return mount(Host, {
    // Teleport 的内容在 happy-dom 下不在 wrapper 元素树里 ⇒ stub 成透传（同 FilterPage.test.ts:108）
    global: { stubs: { Teleport: true, Transition: false } },
  });
}

async function open(w: VueWrapper): Promise<void> {
  await w.get('[data-test="host-open"]').trigger("click");
}

const ROOT = '[data-test="image-lightbox"]';
const IMAGE = '[data-test="lightbox-image"]';

function el(w: VueWrapper, selector: string): HTMLElement {
  return w.get(selector).element as HTMLElement;
}

function rect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/**
 * 图片当前的手势状态：从 `transform` 里读回来。
 * 格式是 `translate(<x>px, <y>px) scale(<s>)`（组件恒渲染它，所以解析失败 = 组件没写 transform）。
 */
function stateOf(w: VueWrapper): { x: number; y: number; scale: number } {
  const style = w.get(IMAGE).attributes("style") ?? "";
  const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)\s*scale\(\s*([\d.]+)\s*\)/.exec(style);
  if (m === null) throw new Error(`transform 解析失败：${style}`);
  return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

/**
 * 给"屏幕"和"图片"装上尺寸。图片那一侧按**当前倍率**回报（真浏览器里
 * `getBoundingClientRect()` 是含 transform 的）—— 组件据此反推基准尺寸。
 */
function stubRects(
  w: VueWrapper,
  frame: { width: number; height: number },
  base: { width: number; height: number },
): void {
  el(w, ROOT).getBoundingClientRect = () => rect(frame.width, frame.height);
  el(w, IMAGE).getBoundingClientRect = () => {
    const s = stateOf(w).scale;
    return rect(base.width * s, base.height * s);
  };
}

async function pointer(
  w: VueWrapper,
  type: "pointerdown" | "pointermove" | "pointerup",
  id: number,
  at: { x: number; y: number },
): Promise<void> {
  await w
    .get(ROOT)
    .trigger(type, { pointerId: id, clientX: at.x, clientY: at.y, pointerType: "touch" });
}

/** 一次完整的点按（按下即抬起，不动）：双击的第二下靠它 */
async function tap(w: VueWrapper, id: number, at: { x: number; y: number }): Promise<void> {
  await pointer(w, "pointerdown", id, at);
  await pointer(w, "pointerup", id, at);
}

/** 历史栈里铺两层已知状态：`{deep}` 是更深的那层，当前是 `{app}` */
function seedHistory(): void {
  window.history.pushState({ deep: true }, "");
  window.history.pushState({ app: true }, "");
}

beforeEach(() => {
  seedHistory();
});

describe("ImageLightbox：渲染与模糊", () => {
  // 杀手：把模板最外层那个 `v-if="visible"` 去掉（改成恒渲染）⇒ 这条红
  it("visible=false 什么都不渲染；true 才出现，src 原样给 <img>（base64 直接给，不经任何转换）", async () => {
    const w = mountHost();
    expect(w.find(ROOT).exists()).toBe(false);

    await open(w);

    expect(w.get(IMAGE).attributes("src")).toBe(SRC);
  });

  // 杀手：把 `:class="masked ? 'blur-lg' : ''"` 删掉（或写成恒 false）⇒ 这条红
  it("masked=true ⇒ 全屏图带模糊 class；改回 false ⇒ 摘掉（眼睛揭示后必须清晰）", async () => {
    const w = mountHost();
    await open(w);
    expect(w.get(IMAGE).classes()).not.toContain("blur-lg");

    await w.get('[data-test="host-mask"]').trigger("click");
    expect(w.get(IMAGE).classes()).toContain("blur-lg");

    await w.get('[data-test="host-mask"]').trigger("click");
    expect(w.get(IMAGE).classes()).not.toContain("blur-lg");
  });
});

describe("ImageLightbox：手势", () => {
  const frame = { width: 400, height: 800 };
  const base = { width: 400, height: 400 };

  // 杀手：把 pointerdown/move/up 里对 `pinchScale` 的调用去掉（或写死 1）
  // ⇒ 下面第一条红；把 `clampScale` 的上限去掉 ⇒ 第二条红
  it("双指捏合：距离翻倍 ⇒ 2x；继续捏 ⇒ 夹在 4x 上限", async () => {
    const w = mountHost();
    await open(w);
    stubRects(w, frame, base);

    await pointer(w, "pointerdown", 1, { x: 100, y: 100 });
    await pointer(w, "pointerdown", 2, { x: 200, y: 100 });
    await pointer(w, "pointermove", 2, { x: 300, y: 100 });

    expect(stateOf(w).scale).toBeCloseTo(2);

    await pointer(w, "pointermove", 2, { x: 500, y: 100 });
    expect(stateOf(w).scale).toBeCloseTo(4);

    await pointer(w, "pointermove", 2, { x: 900, y: 100 });
    expect(stateOf(w).scale).toBeCloseTo(4);
  });

  // 杀手：把双击判定（`doubleTapScale`）换成"永远放大"⇒ 第二条红
  it("双击在 1x / 2x 之间切换", async () => {
    const w = mountHost();
    await open(w);
    stubRects(w, frame, base);

    await tap(w, 1, { x: 100, y: 100 });
    await tap(w, 1, { x: 100, y: 100 });
    expect(stateOf(w).scale).toBeCloseTo(2);

    await tap(w, 1, { x: 100, y: 100 });
    await tap(w, 1, { x: 100, y: 100 });
    expect(stateOf(w).scale).toBeCloseTo(1);
  });

  // 杀手：把拖动那行的 `clampOffset(...)` 换成裸加法 ⇒ 第二、三条红；
  // 把"回到 1x 时平移归零"去掉 ⇒ 第四条红
  it("放大后单指拖动 ⇒ 平移；超出部分被夹在限位上；回到 1x ⇒ 平移归零", async () => {
    const w = mountHost();
    await open(w);
    stubRects(w, frame, base);

    await tap(w, 1, { x: 100, y: 100 });
    await tap(w, 1, { x: 100, y: 100 });
    expect(stateOf(w).scale).toBeCloseTo(2);

    // 2x 下：宽 800 对框 400 ⇒ 左右各可拖 200；高 800 与框等高 ⇒ 上下不许拖
    await pointer(w, "pointerdown", 1, { x: 100, y: 100 });
    await pointer(w, "pointermove", 1, { x: 400, y: 200 });
    expect(stateOf(w)).toMatchObject({ x: 200, y: 0 });

    await pointer(w, "pointermove", 1, { x: -4900, y: 100 });
    expect(stateOf(w)).toMatchObject({ x: -200, y: 0 });

    await pointer(w, "pointerup", 1, { x: -4900, y: 100 });

    // 双击回到 1x：图片完整可见 ⇒ 平移必须一并归零（否则它被推出边界）
    await tap(w, 1, { x: 100, y: 100 });
    await tap(w, 1, { x: 100, y: 100 });
    expect(stateOf(w)).toMatchObject({ scale: 1, x: 0, y: 0 });
  });

  // 杀手：把 tap 判定里的位移阈值删掉（拖动也算点按）⇒ 这条红
  it("拖动之后紧接着抬起，不算一次点按（不会误触发双击放大）", async () => {
    const w = mountHost();
    await open(w);
    stubRects(w, frame, base);

    await pointer(w, "pointerdown", 1, { x: 100, y: 100 });
    await pointer(w, "pointermove", 1, { x: 300, y: 100 });
    await pointer(w, "pointerup", 1, { x: 300, y: 100 });
    // 第二次真的点按：若上一次拖动被当成点按，这一下就会凑成"双击"⇒ 变成 2x
    await tap(w, 1, { x: 100, y: 100 });

    expect(stateOf(w).scale).toBeCloseTo(1);
  });
});

describe("ImageLightbox：关闭与历史哨兵", () => {
  // 杀手：把背板上的 `@click="onBackdropClick"`（或它里面的 `emit('close')`）删掉 ⇒ 这条红
  it("点背板 ⇒ 关闭", async () => {
    const w = mountHost();
    await open(w);

    await w.get(ROOT).trigger("click");

    expect(w.findComponent(ImageLightbox).emitted("close")).toHaveLength(1);
    expect(w.find(ROOT).exists()).toBe(false);
  });

  // 杀手：把 ✕ 按钮删掉 ⇒ 这条红
  it("点 ✕ ⇒ 关闭", async () => {
    const w = mountHost();
    await open(w);

    await w.get('[data-test="lightbox-close"]').trigger("click");

    expect(w.findComponent(ImageLightbox).emitted("close")).toHaveLength(1);
    expect(w.find(ROOT).exists()).toBe(false);
  });

  // 杀手：把 `onBackdropClick` 里的 `e.target !== root` 判断删掉（照搬 @click.self 换成 @click）
  // ⇒ 第一条红；把 `dragMoved` 那次豁免删掉 ⇒ 第二条红
  it("点图片本身不关闭；拖动之后补的那次 click 也不算点背板", async () => {
    const w = mountHost();
    await open(w);
    stubRects(w, { width: 400, height: 800 }, { width: 400, height: 400 });

    // 图片上的点击会冒泡到背板，但它不是"点背板"
    await w.get(IMAGE).trigger("click");
    expect(w.find(ROOT).exists()).toBe(true);

    // 放大后拖动 ⇒ 抬手时浏览器会补一次 click（target 是背板）⇒ 也不能关
    await tap(w, 1, { x: 100, y: 100 });
    await tap(w, 1, { x: 100, y: 100 });
    await pointer(w, "pointerdown", 1, { x: 100, y: 100 });
    await pointer(w, "pointermove", 1, { x: 300, y: 100 });
    await pointer(w, "pointerup", 1, { x: 300, y: 100 });
    await w.get(ROOT).trigger("click");

    expect(w.find(ROOT).exists()).toBe(true);
    expect(w.findComponent(ImageLightbox).emitted("close")).toBeUndefined();
  });

  // 杀手：把 `history.pushState` 那行删掉 ⇒ 第一条红；把 popstate 监听删掉 ⇒ 第二条红
  it("打开时压入哨兵条目；Android 返回键（popstate）⇒ 关闭", async () => {
    const w = mountHost();
    await open(w);

    expect(window.history.state).toEqual({ app: true, weeCountImageLightbox: true });

    window.history.back();

    await vi.waitFor(() => expect(w.find(ROOT).exists()).toBe(false));
    // 用户自己按的那次返回键就是收哨兵的那一次：指针停在打开前的条目上，没有多退一层
    expect(window.history.state).toEqual({ app: true });
  });

  // 杀手：把关闭分支里的 `history.back()` 删掉 ⇒ 第一条红；
  // 写成"每次都 back()"（不判哨兵还在不在）⇒ 第二条红
  it("点 ✕ 关闭 ⇒ 哨兵被收回：再按一次返回键能退到打开前的上一层，不是被吞掉", async () => {
    const w = mountHost();
    await open(w);

    await w.get('[data-test="lightbox-close"]').trigger("click");
    await vi.waitFor(() => expect(window.history.state).toEqual({ app: true }));

    window.history.back();
    await vi.waitFor(() => expect(window.history.state).toEqual({ deep: true }));
  });

  // 杀手：把"哨兵已消费"的标记去掉（popstate 关闭后仍走一次 history.back()）⇒ 这条红
  it("外部返回键关闭后不会再收一次哨兵（重复关闭不残留）", async () => {
    const w = mountHost();
    await open(w);

    window.history.back();
    await vi.waitFor(() => expect(w.find(ROOT).exists()).toBe(false));
    // 静置一会儿：若关闭路径还额外 back() 了一次，这里会滑到 {deep}
    await new Promise((r) => setTimeout(r, 20));
    expect(window.history.state).toEqual({ app: true });
  });

  // 杀手：把"只在 visible 时监听 popstate"改成常驻 ⇒ 第一条红（前进回来会自己重开）；
  // 把 popstate 里 push 哨兵 ⇒ 第二条红
  it("外部前进回到那个哨兵条目 ⇒ 查看器不会自己重开，也不再压新条目", async () => {
    const w = mountHost();
    await open(w);

    window.history.back();
    await vi.waitFor(() => expect(w.find(ROOT).exists()).toBe(false));

    window.history.forward();
    await vi.waitFor(() =>
      expect(window.history.state).toEqual({ app: true, weeCountImageLightbox: true }),
    );
    expect(w.find(ROOT).exists()).toBe(false);

    window.history.back();
    await vi.waitFor(() => expect(window.history.state).toEqual({ app: true }));
  });

  // 杀手：把 `onBeforeUnmount` 里收回哨兵的那行删掉 ⇒ 这条红
  it("查看器开着时组件被卸载 ⇒ 哨兵照样收回（不留一个吞返回键的空条目）", async () => {
    const w = mountHost();
    await open(w);
    expect(window.history.state).toEqual({ app: true, weeCountImageLightbox: true });

    w.unmount();

    await vi.waitFor(() => expect(window.history.state).toEqual({ app: true }));
  });
});
