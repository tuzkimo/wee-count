// src/stores/prefs.ts
import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * 会话级 UI 偏好。
 *
 * 注意：这里的状态**故意不持久化**。「金额默认隐藏」的语义要求每次冷启动都回到
 * 隐藏态；一旦持久化，用户上次点开眼睛的状态会延续到下次启动，需求即失效。
 * 应用锁配置属于另一件事，存 plugin-store 的 settings.json，不放这里。
 */
export const usePrefsStore = defineStore("prefs", () => {
  const amountsHidden = ref(true);

  function hideAmounts(): void {
    amountsHidden.value = true;
  }

  function showAmounts(): void {
    amountsHidden.value = false;
  }

  function toggleAmounts(): void {
    amountsHidden.value = !amountsHidden.value;
  }

  return { amountsHidden, hideAmounts, showAmounts, toggleAmounts };
});
