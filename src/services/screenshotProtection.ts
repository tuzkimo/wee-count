// src/services/screenshotProtection.ts
import { invoke } from "@tauri-apps/api/core";

/**
 * 开关截屏防护：阻止系统截屏、并让最近任务列表不显示内容缩略图
 * （Android 侧就是给窗口置上 `FLAG_SECURE`；桌面端是空实现）。
 *
 * 这个函数**不抛错**，因为它在 `main.ts` 里于 `app.mount()` 之前被调用——
 * 一旦 rejection 外泄，整条启动链路就断在挂载之前，Android 上表现为白屏。
 * 少数派场景（桌面端、浏览器、command 不可用）一律降级为记日志。
 */
export async function applyScreenshotProtection(enabled: boolean): Promise<void> {
  try {
    await invoke("set_screenshot_protection", { enabled });
  } catch (e) {
    console.warn("[screenshot] 切换截屏防护失败:", e);
  }
}
