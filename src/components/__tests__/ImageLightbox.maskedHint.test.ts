// `ImageLightbox`：**"有图、但被遮住了"必须在视觉上说得清** + 顶部/底部避开系统状态栏与手势条。
//
// 两条实机反馈（Android）催生的这一层：
//  1. 模糊后图片与纯黑背景糊成一片 —— 用户看到的形态是"图片没显示出来"；
//  2. ✕ 顶到状态栏下面，被顶栏压住点不到。
// 手势 / 关闭 / 历史哨兵仍在 `ImageLightbox.test.ts` 里钉着，**那个文件一个字不动**。
//
// ⚠️ 描边**不能画在 `<img>` 上**：`blur-lg` 是 `filter: blur()`，会把它自己的 border/ring/box-shadow
// 一起糊掉（1px 的线在 16px 模糊下等于不存在）。所以描边必须是**模糊元素之外**的另一层 ——
// 用例 2 断的就是"存在一层与 `<img>` 平级的描边层"，而不是"`<img>` 上有 ring class"。
import { describe, it, expect } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { defineComponent, ref } from "vue";
import ImageLightbox from "@/components/ImageLightbox.vue";

const SRC = "data:image/jpeg;base64,AAAA";

/** 宿主：`visible` / `masked` 由它管（组件是受控的），关闭事件回到它这里 */
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
    // Teleport 的内容在 happy-dom 下不在 wrapper 元素树里 ⇒ stub 成透传（同 ImageLightbox.test.ts:46）
    global: { stubs: { Teleport: true, Transition: false } },
  });
}

async function open(w: VueWrapper): Promise<void> {
  await w.get('[data-test="host-open"]').trigger("click");
}

async function toggleMask(w: VueWrapper): Promise<void> {
  await w.get('[data-test="host-mask"]').trigger("click");
}

const ROOT = '[data-test="image-lightbox"]';
const IMAGE = '[data-test="lightbox-image"]';
const PLATE = '[data-test="lightbox-masked-plate"]';
const BADGE = '[data-test="lightbox-masked-badge"]';
const CLOSE = '[data-test="lightbox-close"]';

/**
 * 安全区读的是 **class 名**（Tailwind 任意值 `pt-[env(safe-area-inset-top)]`），不是行内 style：
 * 组件刻意不写行内 `calc(env(...) + …)` —— 那类值在 happy-dom 的 CSS 解析器里会被整条丢掉
 * （实测 `style` 属性序列化后为空），钉不住也没法确认它到底是什么。
 * 代价：class 名写错 Tailwind 就不会生成规则 —— 所以另外用一次构建产物核对了这些规则真的在
 * （见提交说明：`pt/pb/top/bottom-[env(safe-area-inset-*)]` 均出现在 dist 的 CSS 里）。
 */
const SAFE_TOP_CLASS = "top-[env(safe-area-inset-top)]";
const SAFE_BOTTOM_CLASS = "bottom-[env(safe-area-inset-bottom)]";

describe("ImageLightbox：被遮的图看得见（描边 + 「已模糊」徽标）", () => {
  // 杀手：把模板里 `data-test="lightbox-masked-badge"` 那段（或它的 `v-if="masked"`）删掉 ⇒ 第一条红
  it("被遮 ⇒ 居中位置出现「已模糊」徽标；揭示后徽标消失（图片清晰如常）", async () => {
    const w = mountHost();
    await open(w);
    expect(w.find(BADGE).exists()).toBe(false);

    await toggleMask(w);
    expect(w.find(BADGE).exists()).toBe(true);
    expect(w.get(BADGE).text()).toContain("已模糊");

    await toggleMask(w);
    expect(w.find(BADGE).exists()).toBe(false);
    // 揭示后不该留下任何"被遮"的痕迹：徽标与描边层都走
    expect(w.find(PLATE).exists()).toBe(false);
    expect(w.get(IMAGE).classes()).not.toContain("blur-lg");
  });
});

describe("ImageLightbox：被遮时的浅色描边/底", () => {
  // 杀手：把 `data-test="lightbox-masked-plate"` 那层删掉、或把它的 `ring-1` 去掉 ⇒ 第一条红；
  // 把描边挂回 `<img>` 的 class 上（`${PLATE}` 不再存在）⇒ 也是第一条红
  it("被遮 ⇒ 有一层浅色描边/底，且它在被模糊的 <img> **之外**（不会被 blur 一起糊掉）", async () => {
    const w = mountHost();
    await open(w);
    expect(w.find(PLATE).exists()).toBe(false);

    await toggleMask(w);

    const plate = w.get(PLATE);
    expect(plate.classes()).toContain("ring-1");
    // 模糊只作用于 `<img>` 自己；描边层必须是它的**兄弟**（同级），否则 filter 会把描边一起糊掉
    expect(plate.element.parentElement).toBe(w.get(ROOT).element);
    expect(w.get(IMAGE).classes()).toContain("blur-lg");
  });
});

describe("ImageLightbox：顶部/底部安全区与 ✕ 点击热区", () => {
  // 杀手：把根节点上的 `pt-[env(safe-area-inset-top)]` / `pb-[env(safe-area-inset-bottom)]` 删掉
  // （或只留顶部那一条）⇒ 第一、二条红
  it("根节点上下都留出安全区内边距（env(safe-area-inset-top/bottom)）", async () => {
    const w = mountHost();
    await open(w);

    expect(w.get(ROOT).classes()).toContain("pt-[env(safe-area-inset-top)]");
    expect(w.get(ROOT).classes()).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  // 杀手：把描边层的 `top-[env(...)]` / `bottom-[env(...)]` 换回固定的 `top-4` / `bottom-4`
  //（不吃安全区）⇒ 红
  it("被遮时的描边/底同样上下避开状态栏与手势条", async () => {
    const w = mountHost();
    await open(w);
    await toggleMask(w);

    const classes = w.get(PLATE).classes();
    expect(classes).toContain(SAFE_TOP_CLASS);
    expect(classes).toContain(SAFE_BOTTOM_CLASS);
  });

  // 杀手：把 ✕ 的 `h-11 w-11` 换回 `h-10 w-10`（40px < 44px）⇒ 第一条红；
  // 把 ✕ 的 `top-[env(...)]` 换回固定 `top-3`（不吃安全区）⇒ 第二条红；把 `z-10` 删掉（被描边层盖住）⇒ 第三条红
  it("✕ 的热区 ≥ 44×44px、落在顶部安全区内、且在遮罩层之上", async () => {
    const w = mountHost();
    await open(w);
    await toggleMask(w);

    const close = w.get(CLOSE);
    // Tailwind 间距：1 档 = 0.25rem = 4px ⇒ h-11 / w-11 = 2.75rem = 44px（≥ Android 建议的最小热区）
    expect(close.classes()).toContain("h-11");
    expect(close.classes()).toContain("w-11");
    expect(close.classes()).toContain(SAFE_TOP_CLASS);
    expect(close.classes()).toContain("z-10");
  });
});
