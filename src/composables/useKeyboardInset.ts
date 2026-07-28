import { ref, onMounted, onUnmounted, type Ref } from "vue";

/**
 * 监听视觉视口，返回当前软键盘占据的视口内高度（px）。
 *
 * 背景：CSS `vh` 单位不会随软键盘弹出而收缩，导致 fixed 在底部的 sheet
 * 被键盘遮挡。用 visualViewport.height 与 window.innerHeight 的差值计算
 * 键盘高度，让 sheet 据此上抬/收高，保证内容可见可点。
 *
 * 不支持 visualViewport 的环境（桌面调试等）返回 0，等同于无键盘。
 */
export function useKeyboardInset(): Ref<number> {
  const inset = ref(0);

  function update() {
    const vv = window.visualViewport;
    if (!vv) {
      inset.value = 0;
      return;
    }
    // 键盘高度 = 布局视口高度 - 视觉视口高度 - 视觉视口顶部偏移（向下取整保护负值）
    const value = window.innerHeight - vv.height - vv.offsetTop;
    inset.value = value > 0 ? value : 0;
  }

  onMounted(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
  });

  onUnmounted(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
  });

  return inset;
}
