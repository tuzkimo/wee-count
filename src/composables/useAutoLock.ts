// src/composables/useAutoLock.ts
import { onMounted, onUnmounted } from "vue";
import { TauriEvent } from "@tauri-apps/api/event";
import { useLockStore } from "@/stores/lock";
import { computeElapsed, shouldLock } from "@/utils/autoLock";

/**
 * 前后台切换的自动锁定。
 *
 * 事件源：用 `document.visibilitychange` 作为可移植的挂起/恢复信号
 * （Android WebView 随 Activity 切后台触发 hidden），并额外订阅 Tauri 窗口的
 * 前台恢复事件；非 Tauri 环境（浏览器 dev / 单测）拿不到后者，只靠前者。
 *
 * `pagehide` / `pageshow` 是一对兜底：有些 WebView（尤其 iOS 与部分 Android 版本）
 * 只派发 pagehide/pageshow 而不派发 visibilitychange，只订阅后者会漏掉挂起信号。
 * 两者必须配对——只加 `pagehide` 而缺 `pageshow`，隐藏之后就再没有任何事件
 * 触发判定，整个前台会话都不判定（fail-open，不是「判得更严」）。
 *
 * 只记「隐藏时刻」，在「恢复时」判定：不依赖任何后台定时器，也就不会被
 * 系统对后台进程的挂起所影响。
 */
export function useAutoLock(): void {
  const lock = useLockStore();

  let wallClockAtHide = 0;
  let monotonicAtHide = 0;
  let hidden = false;
  let disposed = false;

  function markHidden(): void {
    if (hidden) return;
    hidden = true;
    wallClockAtHide = Date.now();
    monotonicAtHide = performance.now();
  }

  function judgeOnResume(): void {
    if (!hidden) return;
    hidden = false;
    if (!lock.isLockConfigured || lock.isLocked) return;

    const elapsed = computeElapsed(wallClockAtHide, monotonicAtHide, Date.now(), performance.now());
    if (shouldLock(elapsed, lock.autoLockSeconds)) lock.lock();
  }

  function onVisibilityChange(): void {
    if (document.visibilityState === "hidden") markHidden();
    else judgeOnResume();
  }

  let unlisten: (() => void) | null = null;

  onMounted(async () => {
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", markHidden);
    window.addEventListener("pageshow", judgeOnResume);
    // 挂载时文档可能已经处于隐藏态（组件在挂起期间才挂载）。若仍从 false 起步，
    // 恢复时的第一个 `visibilitychange: visible` 会被 `if (!hidden) return` 吞掉，
    // 起始的隐藏时段永远不会被判定。播种后 composable 自身即自洽。
    // 此时 hidden 为 false 的话 pageshow 会走到 `if (!hidden) return` 空转，安全。
    if (document.visibilityState === "hidden") markHidden();
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const stop = await getCurrentWindow().listen(TauriEvent.WINDOW_RESUMED, judgeOnResume);
      // 订阅是异步完成的：若组件在 await 期间已卸载，就地退订，
      // 否则这个监听会挂到窗口上无人回收。
      if (disposed) stop();
      else unlisten = stop;
    } catch {
      // 非 Tauri 环境（浏览器 dev / 单测）：只靠 visibilitychange。
    }
  });

  onUnmounted(() => {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", markHidden);
    window.removeEventListener("pageshow", judgeOnResume);
    unlisten?.();
  });
}
