// src/composables/useAutoLock.ts
import { onMounted, onUnmounted } from "vue";
import { useLockStore } from "@/stores/lock";
import { computeElapsed, shouldLock } from "@/utils/autoLock";

/**
 * 前后台切换的自动锁定。
 *
 * 事件源：用 `document.visibilitychange` 作为可移植的挂起/恢复信号
 * （Android WebView 随 Activity 切后台触发 hidden），并额外订阅 Tauri 窗口的
 * 前台恢复事件；非 Tauri 环境（浏览器 dev / 单测）拿不到后者，只靠前者。
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
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const stop = await getCurrentWindow().listen("tauri://resumed", judgeOnResume);
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
    unlisten?.();
  });
}
