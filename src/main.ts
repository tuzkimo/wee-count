import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "@/App.vue";
import router from "@/router";
import "@/assets/main.css";
import { useLockStore } from "@/stores/lock";
import { applyScreenshotProtection } from "@/services/screenshotProtection";

const app = createApp(App);
app.use(createPinia()); // 必须先装 Pinia，useLockStore() 才有活跃实例

/**
 * 启动引导。三条顺序约束，改动前先读这里——每一条都对应一个已复现的故障：
 *
 * 1. 门禁必须**早于 `app.use(router)`**。vue-router 在 install 时就发起初始导航
 *    （`push(routerHistory.location)`）并跑守卫；若那时锁还没装上，守卫读到的
 *    `isLocked` 仍是 `false`，首屏会直接渲染业务页 —— 而 `auth.ts` 会经
 *    `localStorage.current_user_id` 无口令恢复会话并打开用户库，页面能读到真实数据。
 *    真实链路里 `load()` 有 ≥3 个 await（Tauri 下还要等 plugin-store 的 IPC），
 *    所以「先 use(router) 再装锁」不是偶发竞态，是稳定输掉。
 *    冷启动总是要求解锁：`load()` 之后立刻 `lock()`。
 * 2. 整个门禁——**包括 `useLockStore()` 本身**——必须包在 try 里。它抛错时降级为
 *    「不锁启动」，但绝不能因此跳过 mount：Android 上跳过 mount 就是白屏。
 *    `app.use(router)` 同理包在 try 里：注册失败只是功能降级，同样不许挡住宿主流程
 *    （否则这条 rejection 会直接冲出 `bootstrap()`，成为无人处理的失败）。
 * 3. `app.mount()` **无条件执行**，且在任何 await 之后：它放在最外层 `finally` 里，
 *    这一层里任何同步抛错都不许跳过挂载（R45：Android 白屏防线）。
 *
 * 另外不能用顶层 await：vite 默认的模块目标不含 top-level await，`npm run build` 会失败。
 */
async function bootstrap(): Promise<void> {
  // 截屏防护的取值。门禁失败时保持这里的从严默认值，
  // 与 stores/lock.ts 的 LOCK_SETTINGS_DEFAULTS.screenshotProtection 一致。
  let screenshotProtection = true;

  try {
    try {
      const lock = useLockStore();
      await lock.load();
      if (lock.isLockConfigured) lock.lock();
      screenshotProtection = lock.screenshotProtection;
    } catch (cause) {
      console.error("启动门禁失败，降级为不锁启动", cause);
    }

    // 锁已就位，现在才让 router install：初始导航的守卫因此能读到真实的 isLocked。
    try {
      app.use(router);
    } catch (cause) {
      // 装不上 router 仍然必须 mount：没有路由只是功能降级，白屏是彻底不可用。
      console.error("路由注册失败，继续挂载", cause);
    }

    try {
      await applyScreenshotProtection(screenshotProtection);
    } catch (cause) {
      console.warn("应用截屏防护启用失败", cause);
    }
  } finally {
    // 兜底中的兜底：把 mount 放在最外层 finally，bootstrap 里任何同步抛错
    // （包括将来新加的语句）都不会再跳过它。
    app.mount("#app");
  }
}

void bootstrap();
