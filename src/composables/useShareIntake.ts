// src/composables/useShareIntake.ts
// 系统分享进来的截图的**拉取点**与生产依赖装配（判定全在 services/ai/shareIntake.ts）。
//
// 五个拉取点（设计 §5.4）：
//  1. 挂载（冷启动）；
//  2. **扑空后的延迟重拉**（`retryDelayMs`）：原生侧的拷贝在后台线程里跑，云端 provider
//     可能数秒才读完 ⇒ 拉取可能早于落盘。**每一次事件触发的拉取扑空后都适用**，不只是挂载
//     那一次 —— 热启动时 `App.vue` 不会重新挂载，挂载时排的那个定时器早已不在，只剩
//     `visibilitychange` / `tauri://resumed` 两次拉取，扑空后若不再补，用户看到的就是
//     "分享了一把，什么都没发生"。只补一次，不做轮询；
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
import {
  intakeShare,
  type IntakeOutcome,
  type PendingPayload,
  type ShareIntakeDeps,
} from "@/services/ai/shareIntake";

/** inbox 的两个名字与 Kotlin 侧逐字一致（`MainActivity.kt` 的 INBOX_DIR / PENDING_NAME） */
const INBOX_DIR = "share-inbox";
const PENDING_NAME = "pending.json";

/** 扑空后补拉的默认延迟：本地图（几十毫秒）够落盘，也不至于让用户等出感觉 */
const PULL_RETRY_MS = 1200;

function inboxPath(name: string): string {
  return `${INBOX_DIR}/${name}`;
}

/**
 * plugin-fs 对"文件不存在"的报错来自 Rust `io::Error` 的 Display（含 `"os error 2"`）。
 *
 * ⚠️ 这条判定**失手是良性的**：把"不存在"误判成错误 ⇒ 只是多一条 `console.warn`（行为不变）；
 * 把真错误误判成"不存在" ⇒ 与修复前逐字相同（返回 `null`）。两个方向的代价都不高于现状。
 */
function isNotFound(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /not found|no such file|os error 2/i.test(text);
}

/** `retryDelayMs` 只为测试可注入（传小值 ⇒ 补拉很快到点） */
export function useShareIntake(options: { retryDelayMs?: number } = {}): void {
  const retryDelayMs = options.retryDelayMs ?? PULL_RETRY_MS;
  const router = useRouter();
  const lock = useLockStore();
  const ai = useAiChatStore();
  /** 待命中的补拉定时器：非 null 时不再排第二个（多个拉取点撞在一起也不叠定时器） */
  let retryTimer: number | null = null;

  const deps: ShareIntakeDeps = {
    isLocked: () => lock.isLocked,
    readPending: async () => {
      try {
        // AppCache = `<cacheDir>`，与 Kotlin 写盘的目录是同一个
        return await readTextFile(inboxPath(PENDING_NAME), { baseDir: BaseDirectory.AppCache });
      } catch (e) {
        // 文件不存在 = 没有待消费的分享（绝大多数启动都走这条，**不打日志**）；
        // 其它错误（capability/scope 配错、权限、磁盘）必须**抛出去**：由 shareIntake 的 catch
        // 与 pull() 的边界 catch 记录，并且**不消费** —— 否则真机上最可能的失败与"这次没有分享"
        // 表现逐字相同（不崩、不提示、不消费、图还躺在 inbox），根本查不出原因。
        if (isNotFound(e)) return null;
        throw e;
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
   * 拉取。**边界在这里兜异常**：拉取点都是事件回调，异常抛出去没人接；
   * 服务内部已把可预期的失败都转成了返回值 + 文案。
   *
   * `mayRetry`：本次是"事件触发"（true）还是"补拉定时器触发"（false）。扑空 ⇒ 排一次补拉；
   * 定时器触发的那次不再排（只补一次，绝不变成轮询）。
   */
  async function pull(mayRetry: boolean): Promise<void> {
    let outcome: IntakeOutcome;
    try {
      outcome = await intakeShare(deps);
    } catch (e) {
      console.warn("[ai/share] 拉取失败：", e);
      return;
    }
    // "none" = 这次没拉到东西，可能后台还在落盘 ⇒ 值得补一次；"attached"/"failed"/
    // "skipped" 都不排（"failed" 已消费并出文案；"skipped" 是锁定态，解锁后那次会处理）
    if (outcome === "none" && mayRetry) scheduleRetry();
  }

  /** 排一次补拉。已有待命定时器 ⇒ 什么都不做（同一时刻最多一个） */
  function scheduleRetry(): void {
    if (retryTimer !== null) return;
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      void pull(false);
    }, retryDelayMs);
  }

  // 解锁后补一次：锁定时 intakeShare 直接返回 skipped、pending 留在磁盘（设计 §5.4）
  watch(
    () => lock.isLocked,
    (locked) => {
      if (!locked) void pull(true);
    },
  );

  let stopped = false;
  let unlisten: (() => void) | null = null;

  function onVisibilityChange(): void {
    if (document.visibilityState === "visible") void pull(true);
  }

  onMounted(async () => {
    void pull(true);
    document.addEventListener("visibilitychange", onVisibilityChange);
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const stop = await getCurrentWindow().listen(TauriEvent.WINDOW_RESUMED, () => void pull(true));
      // 订阅是异步完成的：若组件在 await 期间已卸载，就地退订（照 useAutoLock 的写法）
      if (stopped) stop();
      else unlisten = stop;
    } catch {
      // 非 Tauri 环境（浏览器 dev / 单测）：只靠 visibilitychange
    }
  });

  onUnmounted(() => {
    stopped = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    unlisten?.();
  });
}
