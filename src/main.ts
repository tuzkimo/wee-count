import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import "@/assets/main.css";
import { useLockStore } from "@/stores/lock";
import { applyScreenshotProtection } from "@/services/screenshotProtection";

const app = createApp(App);
app.use(createPinia()); // 必须先装 Pinia，useLockStore() 才有活跃实例
app.use(router);

/**
 * 启动引导。
 *
 * 首帧门禁：必须在 mount() 之前完成。否则路由守卫是 async 的（要 await getLocalUsers()），
 * 这段空窗会渲染出真实数据。
 *
 * 顺序是刻意的：lock.load() / lock.lock() 在任何可能失败的调用之前，
 * 这样即使后面失败，应用也是「锁着启动」而非「没锁启动」。
 * 门禁整体再包一层 try：门禁本身若意外抛错，也要降级为「不锁启动」，
 * 而绝不能跳过 mount —— Android 上跳过 mount 就是白屏。
 */
async function bootstrap(): Promise<void> {
  const lock = useLockStore();
  try {
    await lock.load();
    if (lock.isLockConfigured) lock.lock();
  } catch (cause) {
    console.error("启动门禁失败，降级为不锁启动", cause);
  }
  try {
    await applyScreenshotProtection(lock.screenshotProtection);
  } catch (cause) {
    console.warn("应用截屏防护启用失败", cause);
  }
  app.mount("#app");
}

void bootstrap();
