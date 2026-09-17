// src/stores/privacy.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  SCREENSHOT_PROTECTION_DEFAULT,
  readScreenshotProtection,
  writeScreenshotProtection,
} from "@/services/privacySettings";

/**
 * 隐私设置（目前只有截屏防护一项）。
 *
 * **与应用锁无关**：`FLAG_SECURE` 是窗口级开关，配不配应用锁它都成立。
 * 1.1.x 把它塞在 AppLockConfig 里，于是「没有应用锁」就等于「这个设置既读不出也写不进」，
 * 界面只能把开关藏起来（那时这是老实的做法，不是偷懒）；默认值又是开启，
 * 用户想关就必须先建一把应用锁。独立成键之后开关随时可写，
 * 关掉应用锁也不会再把它复位成开 —— 那是存储耦合的副产物，不是用户意图。
 */
export const usePrivacyStore = defineStore("privacy", () => {
  const screenshotProtection = ref(SCREENSHOT_PROTECTION_DEFAULT);

  /** 读盘。读不出来时 `readScreenshotProtection` 自己回落默认值，因此这里不抛。 */
  async function load(): Promise<void> {
    screenshotProtection.value = await readScreenshotProtection();
  }

  /** 先落盘、后改内存：失败即 reject，绝不让界面显示一个没写进去的状态（R57）。 */
  async function setScreenshotProtection(enabled: boolean): Promise<void> {
    await writeScreenshotProtection(enabled);
    screenshotProtection.value = enabled;
  }

  return { screenshotProtection, load, setScreenshotProtection };
});
