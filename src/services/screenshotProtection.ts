// src/services/screenshotProtection.ts
import { invoke } from "@tauri-apps/api/core";

/**
 * 开关截屏防护：阻止系统截屏、并让最近任务列表不显示内容缩略图
 * （Android 侧就是给窗口置上 `FLAG_SECURE`；桌面端是空实现）。
 *
 * **失败会 reject**：Rust command 把系统层的失败沿 `Err` 冒泡回来
 * （JNI 失败、拿不到回执都算失败），这里如实外泄，绝不吞掉。
 * 吞掉的代价是调用方那句「截屏防护设置失败，请重试」变成死代码 ——
 * 用户看到界面已经关掉防护，实际系统层还开着，且没有任何反馈。
 *
 * 两个调用方都自有 try/catch 兜底，rejection 不会外泄成白屏：
 * `main.ts` 记一条 warn 后继续挂载，`SecurityPage.vue` 显示失败提示。
 */
export async function applyScreenshotProtection(enabled: boolean): Promise<void> {
  await invoke("set_screenshot_protection", { enabled });
}
