package cn.tuzkimo.wee_count

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 应用主 Activity。除 Tauri 的启动骨架外，还负责**接住系统分享进来的截图**：
 * 把字节拷进 App 私有 inbox（`cacheDir/share-inbox/`），供前端拉取。
 *
 * 契约（设计 §4）：
 *  - `<uuid>.bin` 原图字节 —— **不做任何格式判定**（准入判据只有字节头，判定在前端）
 *  - `pending.json` `{"v":1,"kind":"image","file":"…","count":N}` 或
 *    `{"v":1,"kind":"error","code":"no_stream"|"read_failed"|"source_too_large"}`
 *  - 原子写（tmp + rename）⇒ 前端永远不会读到半截 JSON
 *  - latest wins：写新 payload 之前，先删掉旧 payload 引用的那张图
 *
 * ⚠️ 这里**不写任何用户可见中文**：错误只出 code，文案在前端的 attachText.ts。
 *
 * 另外它还写一个**会话记录**（`cacheDir/wee-session/`），供前端在每次启动时决定要不要上锁：
 *  - `session.json` `{"v":1,"at":<epoch ms>,"reason":"background"|"user_closed",`
 *    `"taskId":<int>,"authenticated":<bool>}`
 *    - `taskId`：写记录时的任务号，供下次启动的 `reconcileTask()` 判"还是不是一个 task"
 *    - `authenticated`：离开那一刻本段前台期有没有过门禁（读下面的标记得到）
 *  - `authenticated` 标记文件由前端写、这里删（"本段前台期已过门禁"，内容是一个毫秒时间戳）
 *
 * 为什么这件事必须在原生侧做：JS 在"切到后台"与"被系统杀掉"两种情况下都只是停止运行，
 * 分不出"用户自己划掉了后台"——而那恰恰是唯一必须重新解锁的情形（契约见设计 §4.5）。
 */
class MainActivity : TauriActivity() {
  /** 分享的拷贝串行执行：多次分享按顺序写盘 ⇒ latest wins 语义不变 */
  private val inboxExecutor = Executors.newSingleThreadExecutor()

  /** 已经投递过的分享指纹（跨 Activity 重建保留，见 `onSaveInstanceState`）。 */
  private var handledShare: String? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // 目录先建好：前端在解锁时要往里写"本段前台期已过门禁"标记，而它没有建目录的 ACL
    // （`fs:default` 的 mkdir scope 只到 $APPCACHE 本身），前端那边也会自己 mkdir 一次兜底。
    sessionDir()
    // 先把"这次启动是不是同一个 task"判掉：前端的启动门禁马上要读这个文件。
    reconcileTask()
    handledShare = savedInstanceState?.getString(STATE_HANDLED_SHARE)
    // ⚠️ 不能只认 `savedInstanceState == null`：Activity 被系统回收后重建时，**新的分享意图
    // 也是从 onCreate 进来的**（系统把新的 launch intent 交给重建出来的实例，不走 onNewIntent），
    // 只认冷启动就会把这次分享静默丢掉 —— 用户看到的是"分享过来没反应"。
    // 也不能无条件投递：重建时 intent 还可能是**上一次那份**（配置变更、系统重建），重复投递
    // 会让用户看到一张已经处理过的图。所以按"这次的分享是不是同一份"来判（见 shareFingerprint）。
    if (shareFingerprint(intent) != handledShare) dispatchSharedImage(intent)
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    outState.putString(STATE_HANDLED_SHARE, handledShare)
  }

  override fun onNewIntent(intent: Intent) {
    // 签名与生成代码逐字一致（generated/TauriActivity.kt:46）；super 负责转发给 PluginManager
    super.onNewIntent(intent)
    setIntent(intent)
    // onNewIntent 一定是**新的一次**分享（singleTask 复用实例走这条），不需要比对指纹
    dispatchSharedImage(intent)
  }

  /**
   * 离开前台：记下时刻，并作废"本段前台期已过门禁"的标记。
   *
   * 这两个文件是前端**启动时**判定要不要上锁的输入（`services/sessionLock.ts`）。
   * 配置变更（`isChangingConfigurations`）不算离开前台：Activity 会被重建、前端会重载，
   * 那种情况不该让用户解锁一次。
   */
  override fun onStop() {
    super.onStop()
    if (!isChangingConfigurations) {
      // 离开那一刻本段有没有过门禁：原生读前端写的标记（`unlock()` 或"启动判定为不需要锁"
      // 时写下，每次离开都被 clearSessionMark 删掉）⇒ 它能代表**本段**。
      val authenticated = File(sessionDir(), SESSION_MARK).exists()
      Log.i(SESSION_TAG, "离开前台 ⇒ 写 background（authenticated=$authenticated）")
      writeSessionEnd(SESSION_REASON_BACKGROUND, authenticated)
      clearSessionMark()
    }
  }

  /**
   * `isFinishing` = 用户/系统**结束**了这个 Activity（从最近任务里划掉、任务被移除），
   * 而不是配置变更，也不是系统低内存回收（后者不回调本方法）。
   *
   * ⚠️ 这里**只是第二道信号**：本机 ROM（HyperOS）的"划掉后台"走的是
   * `handleSwipeKill` → force-stop + 立即 SIGKILL，finish 请求只比 SIGKILL 早十几毫秒
   * ⇒ 本方法很可能根本跑不到。第一道信号是 `reconcileTask()` 的 task id 比对（不依赖它）。
   */
  override fun onDestroy() {
    if (isFinishing && !isChangingConfigurations) {
      Log.i(SESSION_TAG, "结束（划掉后台/清任务）⇒ 写 user_closed")
      writeSessionEnd(SESSION_REASON_USER_CLOSED, authenticated = false)
      clearSessionMark()
    } else if (!isChangingConfigurations) {
      // 走到这里＝"被销毁但不是结束"：系统回收 Activity（进程还活着，之后会带着
      // savedInstanceState 重建）。这时**不动**会话记录，留给 onStop 写下的 background。
      Log.i(SESSION_TAG, "被销毁但未 finishing（系统回收？）⇒ 不改会话记录")
    }
    super.onDestroy()
  }

  /**
   * 「这次启动还是上一次那个 task 吗？」——"用户自己划掉后台"的**可靠**判据。
   *
   * 为什么不靠 `onDestroy`：本机 ROM 的划掉是 force-stop + SIGKILL，销毁回调跟杀进程抢时间
   * （见 `onDestroy` 的注释）。而 task id 的差别是确定性的：
   *  - 划掉后台 / 从最近任务清除（以及**待真机确认**的设置里强行停止、更新 App）⇒ 任务被
   *    销毁，再打开是**新 task id**；
   *  - 只是切到后台、之后被系统低内存杀掉进程（本机常态）⇒ AMS 里的任务还在，
   *    重开**沿用同一个 task id**。
   *
   * 「重启后 id 一定不同」**不成立**：AMS 的 per-user task id 计数器是内存态，重启后从低位
   * 重新分配、可能恰好复用同一个 id。那种情形交给前端的窗口判定兜（重启通常早已超出窗口）。
   *
   * 于是把上一次写下的 `background` 记录就地改判成 `user_closed`（时间戳刷新为改判这一刻），
   * 前端照旧只看 `reason` —— 硬要求"自己划掉之后必须解锁"因此不再押在销毁回调上。
   *
   * ⚠️ 时序：必须在 WebView 把页面跑起来、前端读这个文件之前尽量早地写盘。onCreate 里
   * `super.onCreate()` 之后立刻就做（本地文件读写，微秒级），理论上仍可能与前端抢，
   * 抢输的后果只是"这一次没锁"，记录本身已经改对（下一次启动照样从严）。
   */
  private fun reconcileTask() {
    runCatching {
      val record = File(sessionDir(), SESSION_RECORD)
      if (!record.exists()) return
      val json = org.json.JSONObject(record.readText())
      if (json.optString("reason") != SESSION_REASON_BACKGROUND) return
      // 两个方向都从严：记录里没这个字段（老记录/字段漂移），或任何一边给不出有效任务号
      // （AMS 的 INVALID_TASK_ID = -1，`getTaskId()` 是实时 binder 调用，可能失败）
      // ⇒ 无法证明"还是同一个 task" ⇒ 一律按"换过 task"处理。
      val recordedTask = if (json.has("taskId")) json.optInt("taskId", -1) else -1
      val current = currentTaskId()
      if (recordedTask == current && current > 0) return
      Log.i(SESSION_TAG, "task 变了（记录=$recordedTask 当前=$current）⇒ 改判 user_closed")
      // `at` 必须是**改判这一刻**，不能沿用旧记录的时间戳：前端的规则是"标记时间戳晚于记录 at
      // ⇒ 认为本段已过门禁、不锁"。若沿用旧的 at，一次残留标记（onStop 没跑成 / 删标记失败 /
      // unlock 的异步写迟到）就会把这次改判抵消掉 —— 那正好是硬要求失效。设成此刻之后，
      // 任何"改判之前写的标记"必然更旧、必然不被采信，与删标记成功与否无关。
      writeSessionEnd(
        SESSION_REASON_USER_CLOSED,
        authenticated = false,
        at = System.currentTimeMillis(),
      )
      // 标记也删掉（双保险）：它是"**本段**前台期已过门禁"的意思，而本段的 task 已经没了。
      clearSessionMark()
    }.onFailure { Log.w(SESSION_TAG, "会话记录改判失败", it) }
  }

  /**
   * 当前 task id；取不到时返回 AMS 的 `INVALID_TASK_ID`(-1)。
   *
   * 为什么必须单独兜住：`getTaskId()` 是**实时 binder 调用**（`ActivityClient.getTaskForActivity`
   * → 失败会 `rethrowFromSystemServer`），一抛就会把整件事跳过 —— 判据被跳过 ⇒ 记录留在
   * `background`（回到"窗口说了算"，划掉后台可能免解锁）；`writeSessionEnd` 里被跳过 ⇒
   * 连 `at` 都写不下去。返回 -1 之后，判据把它当"无法证明同一个 task"（从严改判），
   * 记录里也留下 -1 ⇒ 下一次启动照旧从严。
   */
  private fun currentTaskId(): Int = runCatching { taskId }.getOrDefault(-1)

  /**
   * 把拷贝丢到**后台单线程**去跑。
   *
   * 为什么不在主线程（更不在 `super.onCreate` 之前）拷：`content://` 背后的云端 provider
   * （相册、网盘）会在 `openInputStream` / `read` 上阻塞数秒 ⇒ 冷启动白屏、热启动卡住输入
   * 分发（ANR）。单线程池保证多次分享按顺序写盘，latest wins 不变。
   *
   * 代价：前端拉取可能早于落盘 ⇒ 由前端补一次延迟重拉兜底（`useShareIntake` 的
   * `retryDelayMs`，常量 `PULL_RETRY_MS`）：**每一次事件触发的拉取**扑空后都补一次，
   * 不只是挂载那一次（热启动不重新挂载），且只补一次、不做轮询，不靠猜时序。
   */
  private fun dispatchSharedImage(intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return
    handledShare = shareFingerprint(intent)
    inboxExecutor.execute { captureSharedImage(intent) }
  }

  /**
   * 分享意图的指纹：动作 + 类型 + 第一张图的 URI。
   *
   * 唯一用途是判断"Activity 重建时拿到的 intent 是不是上次已经处理过的那一份"。
   * 按**内容**比而不是按对象比：系统重建时重新 parcel 出来的是另一个对象，比实例没有意义。
   * 代价是"紧接着重建 + 又分享同一张图"会被当成重复而跳过 —— 用户再分享一次即可，
   * 比"新的分享被静默丢掉"或"同一张图被处理两遍"都轻。
   */
  private fun shareFingerprint(intent: Intent?): String? {
    val action = intent?.action ?: return null
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return null
    val first: Uri? = if (action == Intent.ACTION_SEND_MULTIPLE) {
      IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        ?.firstOrNull()
    } else {
      IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
    }
    return "$action|${intent.type}|${first ?: ""}"
  }

  /** 把分享进来的图片拷进 inbox（在后台线程执行）。 */
  private fun captureSharedImage(intent: Intent) {
    val action = intent.action

    val uris: List<Uri> = if (action == Intent.ACTION_SEND_MULTIPLE) {
      IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
    } else {
      listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
    }
    if (uris.isEmpty()) {
      writeErrorPayload("no_stream")
      return
    }

    val dir = inboxDir()
    val target = File(dir, "${UUID.randomUUID()}.bin")
    var tooLarge = false

    val copied = try {
      contentResolver.openInputStream(uris.first())?.use { input ->
        FileOutputStream(target).use { output ->
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          var total = 0L
          while (!tooLarge) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            if (total > SHARE_SOURCE_MAX_BYTES) {
              tooLarge = true
              break
            }
            output.write(buffer, 0, read)
          }
          !tooLarge
        }
      } ?: false
    } catch (e: Exception) {
      Log.w(TAG, "读分享的图片失败", e)
      false
    }

    if (!copied) {
      target.delete()
      writeErrorPayload(if (tooLarge) "source_too_large" else "read_failed")
      return
    }

    // 多图只取第一张（设计 §1 裁决），把总数带上让前端出一行提示
    sweepOrphanBinaries(target)
    writeAtomicJson("""{"v":1,"kind":"image","file":"${target.name}","count":${uris.size}}""")
  }

  /**
   * 清掉不再被引用的 `.bin`。
   *
   * 设计 §4.3 的"目录里最多两个文件"建立在"删除一定成功"上，而这条前提会被打断：
   * 前端的 compare-and-delete 发现盘上换了一份就不删（那是保护用户的分享）、进程在两步删除
   * 之间被杀、写新 payload 前失败 —— 这些都会留下没人再引用的孤儿（每个上限 8 MiB）。
   * 每次成功落盘后扫一遍即可：一次 `listFiles`，成本可忽略，且**只删 `.bin`**。
   */
  private fun sweepOrphanBinaries(keep: File) {
    runCatching {
      inboxDir().listFiles()?.forEach { file ->
        if (file.name.endsWith(".bin") && file.name != keep.name) {
          runCatching { file.delete() }
        }
      }
    }.onFailure { Log.w(TAG, "清理 inbox 孤儿失败", it) }
  }

  private fun writeErrorPayload(code: String) {
    // 带上唯一 id：同一个 code 两次写出的 JSON 若**逐字节相同**，前端按原文去重（`consumedRaw`）
    // 会把第二次当成"这次没有分享" —— 用户看到的是"分享进来没反应，重启才好"。
    // 前端只挑已知键，多一个 id 不参与解析。
    writeAtomicJson("""{"v":1,"kind":"error","code":"$code","id":"${UUID.randomUUID()}"}""")
  }

  /** 原子写 `pending.json`，并先让旧 payload 引用的图片让位（latest wins）。 */
  private fun writeAtomicJson(json: String) {
    // ⚠️ 写盘也必须兜异常：cacheDir 不可写 / 磁盘满时 writeText 抛 IOException，逃出去会打崩
    // onCreate / onNewIntent。写不进去时前端把"没有 pending.json"当"没有分享" —— 这一次分享
    // 静默失败，但 App 不崩。
    runCatching {
      val dir = inboxDir()
      oldInboxFile(dir)?.let { old -> runCatching { old.delete() } }
      val pending = File(dir, PENDING_NAME)
      val tmp = File(dir, "$PENDING_NAME.tmp")
      tmp.writeText(json)
      if (!tmp.renameTo(pending)) {
        // rename 失败（极罕见）⇒ 退化成直接写：宁可让前端读到内容，也不要静默丢掉这次分享
        pending.writeText(json)
        tmp.delete()
      }
    }.onFailure { Log.w(TAG, "写 inbox 失败", it) }
  }

  /** 旧 payload 引用的图片文件；名字由我们生成，这里仍然拒绝任何路径分隔符（防御性）。 */
  private fun oldInboxFile(dir: File): File? {
    val pending = File(dir, PENDING_NAME)
    if (!pending.exists()) return null
    return runCatching {
      val name = org.json.JSONObject(pending.readText()).optString("file")
      if (name.isEmpty() || name.contains('/') || name.contains("..")) null else File(dir, name)
    }.getOrNull()
  }

  private fun inboxDir(): File = File(cacheDir, INBOX_DIR).apply { mkdirs() }

  /**
   * 写会话记录（前端启动时读它决定要不要上锁）。
   *
   * 与 `writeAtomicJson` 同款：原子写 + 兜异常。这里**绝不能抛**——它跑在 `onStop`/`onDestroy`
   * 里，抛出去就是崩溃；写不进去的后果只是"下次启动读不到记录 ⇒ 从严要求解锁一次"。
   */
  private fun writeSessionEnd(
    reason: String,
    authenticated: Boolean,
    at: Long = System.currentTimeMillis(),
  ) {
    runCatching {
      val dir = sessionDir()
      // taskId 与 authenticated 都写进去：前者供 reconcileTask 判定"这次还是不是一个 task"，
      // 后者供前端判定"本段有没有过门禁"（缺了它，停在解锁页也能靠窗口免口令进来）。
      // task id 走 `currentTaskId()`（不抛，取不到写 -1）：直接读合成属性的话，一次 IPC 失败
      // 会让整条记录（含 at）都写不下去。
      val json =
        """{"v":1,"at":$at,"reason":"$reason","taskId":${currentTaskId()},"authenticated":$authenticated}"""
      val record = File(dir, SESSION_RECORD)
      val tmp = File(dir, "$SESSION_RECORD.tmp")
      tmp.writeText(json)
      if (!tmp.renameTo(record)) {
        record.writeText(json)
        tmp.delete()
      }
    }.onFailure { Log.w(SESSION_TAG, "写会话记录失败", it) }
  }

  /**
   * 删掉前端写的"本段前台期已过门禁"标记：离开前台 / 被关掉之后，这一段就结束了。
   *
   * 删不掉也不会放行错：前端只在标记**晚于**记录里的 `at` 时才采信它，而每次结束这一段
   * （onStop / onDestroy / reconcileTask 改判）都会把 `at` 刷新到现在 ⇒ 残留标记必然更旧。
   * 但真机上要看得见，否则"标记没删掉"这类问题在 logcat 里是空的。
   */
  private fun clearSessionMark() {
    runCatching {
      val mark = File(sessionDir(), SESSION_MARK)
      if (mark.exists() && !mark.delete()) Log.w(SESSION_TAG, "删除门禁标记失败（残留标记不会被采信）")
    }.onFailure { Log.w(SESSION_TAG, "删除门禁标记异常", it) }
  }

  private fun sessionDir(): File = File(cacheDir, SESSION_DIR).apply { mkdirs() }

  private companion object {
    /** Logcat tag：本任务无单测，真机验收（8 MiB 边界 / read_failed）靠它定位。 */
    const val TAG = "WeeCount/Share"

    /** 会话记录（要不要解锁）的 logcat tag：`adb logcat -s WeeCount/Session` 单独看这一路。 */
    const val SESSION_TAG = "WeeCount/Session"

    /** inbox 子目录（契约见设计 §4.1） */
    const val INBOX_DIR = "share-inbox"
    const val PENDING_NAME = "pending.json"

    /**
     * 会话记录：与前端 `services/sessionLock.ts` 的 SESSION_DIR / 文件名**逐字一致**。
     * 两处各写各的会静默漂移，而漂移的后果是"启动判定永远读不到记录 ⇒ 每次都要求解锁"。
     */
    const val SESSION_DIR = "wee-session"
    const val SESSION_RECORD = "session.json"
    const val SESSION_MARK = "authenticated"
    const val SESSION_REASON_BACKGROUND = "background"
    const val SESSION_REASON_USER_CLOSED = "user_closed"

    /** `onSaveInstanceState` 里保存"已投递过的分享指纹"用的键。 */
    const val STATE_HANDLED_SHARE = "weeCount.handledShare"

    /**
     * 源字节上限：**必须大于**压缩后上限 1 MiB（设计 §4.4）。
     * ⚠️ 这是本链路上唯一没有单测的常量（Kotlin 无测试基建）⇒ 真机验收项 20 覆盖它。
     * ⚠️ 前端**不复制**这个数值（复制就是两份真相）。
     */
    const val SHARE_SOURCE_MAX_BYTES = 8L * 1024 * 1024
    const val COPY_BUFFER_BYTES = 64 * 1024
  }
}
