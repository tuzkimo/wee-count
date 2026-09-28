// src/composables/useShareIntake.ts
// 系统分享进来的截图的**拉取点**与生产依赖装配（判定全在 services/ai/shareIntake.ts）。
//
// 五个拉取点（设计 §5.4）：
//  1. 挂载（冷启动）；
//  2. 挂载后**一次**延迟重拉（`bootRetryMs`）：原生侧的拷贝在后台线程里跑，云端 provider
//     可能数秒才读完 ⇒ WebView 首次拉取可能早于落盘。只补一次，不做轮询；
//  3. `visibilitychange → visible`（从别的 App 回来）；
//  4. `tauri://resumed`（同 3，部分 WebView 只派发其中一个）；
//  5. 解锁后（`lock.isLocked` 由真变假）。
//
// ⚠️ 注册顺序：`App.vue` 里 `useAutoLock()` 在**前**、本 composable 在**后** ⇒ 同一个
//    `visibilitychange` 事件里自动锁的判定先跑，我们读到的是已经更新过的 `isLocked`。
import { onMounted, onUnmounted, watch } from "vue";
import { useRouter } from "vue-router";
import { BaseDirectory, readFile, readTextFile, remove } from "@tauri-apps/plugin-fs";
import { TauriEvent } from "@tauri-apps/api/event";
import { useAiChatStore } from "@/stores/aiChat";
import { useLockStore } from "@/stores/lock";
import { toAttachmentWithDefaults } from "@/services/ai/imageInput";
import { intakeShare, type PendingPayload, type ShareIntakeDeps } from "@/services/ai/shareIntake";

/** inbox 的两个名字与 Kotlin 侧逐字一致（`MainActivity.kt` 的 INBOX_DIR / PENDING_NAME） */
const INBOX_DIR = "share-inbox";
const PENDING_NAME = "pending.json";

/** 冷启动兜底重拉的默认延迟：本地图（几十毫秒）够落盘，也不至于让用户等出感觉 */
const BOOT_RETRY_MS = 1200;

function inboxPath(name: string): string {
  return `${INBOX_DIR}/${name}`;
}

/** `bootRetryMs` 只为测试可注入（传 0 ⇒ 延迟重拉在下一个 tick 发生） */
export function useShareIntake(options: { bootRetryMs?: number } = {}): void {
  const bootRetryMs = options.bootRetryMs ?? BOOT_RETRY_MS;
  const router = useRouter();
  const lock = useLockStore();
  const ai = useAiChatStore();
  let bootRetryTimer: number | null = null;

  const deps: ShareIntakeDeps = {
    isLocked: () => lock.isLocked,
    readPending: async () => {
      try {
        // AppCache = `<cacheDir>`，与 Kotlin 写盘的目录是同一个
        return await readTextFile(inboxPath(PENDING_NAME), { baseDir: BaseDirectory.AppCache });
      } catch {
        // 文件不存在 = 没有待消费的分享（绝大多数启动都走这条；plugin-fs 对缺失文件是抛错）
        return null;
      }
    },
    readBytes: (file) => readFile(inboxPath(file), { baseDir: BaseDirectory.AppCache }),
    consume: async (payload: PendingPayload | null) => {
      if (payload !== null && payload.kind === "image") {
        await remove(inboxPath(payload.file), { baseDir: BaseDirectory.AppCache });
      }
      await remove(inboxPath(PENDING_NAME), { baseDir: BaseDirectory.AppCache });
    },
    toAttachment: (bytes) => toAttachmentWithDefaults(bytes),
    setAttachedImage: (image) => ai.setAttachedImage(image),
    setNotice: (text) => ai.setImageNotice(text),
    pushAi: () => {
      // 已经在 AI 页就不推：避免历史栈里堆一串重复条目
      if (router.currentRoute.value.path !== "/ai") void router.push("/ai");
    },
  };

  /**
   * 拉取。**边界在这里兜异常**：四个触发点都是事件回调，异常抛出去没人接；
   * 服务内部已把可预期的失败都转成了返回值 + 文案。
   */
  async function pull(): Promise<void> {
    try {
      await intakeShare(deps);
    } catch (e) {
      console.warn("[ai/share] 拉取失败：", e);
    }
  }

  // 解锁后补一次：锁定时 intakeShare 直接返回 skipped、pending 留在磁盘（设计 §5.4）
  watch(
    () => lock.isLocked,
    (locked) => {
      if (!locked) void pull();
    },
  );

  let stopped = false;
  let unlisten: (() => void) | null = null;

  function onVisibilityChange(): void {
    if (document.visibilityState === "visible") void pull();
  }

  onMounted(async () => {
    void pull();
    // 兜住"后台拷贝还没落盘就先被拉了一次"：只补一次。重复拉取由服务自己去重
    // （同一份 pending.json 原文不再处理），所以这一次补拉不会造成二次附加。
    bootRetryTimer = window.setTimeout(() => {
      bootRetryTimer = null;
      void pull();
    }, bootRetryMs);
    document.addEventListener("visibilitychange", onVisibilityChange);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const stop = await getCurrentWindow().listen(TauriEvent.WINDOW_RESUMED, () => void pull());
      // 订阅是异步完成的：若组件在 await 期间已卸载，就地退订（照 useAutoLock 的写法）
      if (stopped) stop();
      else unlisten = stop;
    } catch {
      // 非 Tauri 环境（浏览器 dev / 单测）：只靠 visibilitychange
    }
  });

  onUnmounted(() => {
    stopped = true;
    if (bootRetryTimer !== null) window.clearTimeout(bootRetryTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unlisten?.();
  });
}
