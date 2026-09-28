package cn.tuzkimo.wee_count

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

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
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 冷启动：**先写盘、后 super.onCreate** —— WebView 起来时 inbox 已经就绪，
    // 从构造上消除「JS 拉取得比写盘快」的竞态（cacheDir / contentResolver 在 onCreate 前已可用）。
    // `savedInstanceState != null` = Activity 重建（不是真的冷启动）：那时 intent 还是老的那份，
    // 重复投递会让用户看到一张已经处理过的图。
    if (savedInstanceState == null) {
      captureSharedImage(intent)
    }
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    // 签名与生成代码逐字一致（generated/TauriActivity.kt:46）；super 负责转发给 PluginManager
    super.onNewIntent(intent)
    setIntent(intent)
    captureSharedImage(intent)
  }

  /** 把分享进来的图片拷进 inbox。非分享 intent 直接忽略。 */
  private fun captureSharedImage(intent: Intent?) {
    if (intent == null) return
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return

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
      false
    }

    if (!copied) {
      target.delete()
      writeErrorPayload(if (tooLarge) "source_too_large" else "read_failed")
      return
    }

    // 多图只取第一张（设计 §1 裁决），把总数带上让前端出一行提示
    writeAtomicJson("""{"v":1,"kind":"image","file":"${target.name}","count":${uris.size}}""")
  }

  private fun writeErrorPayload(code: String) {
    writeAtomicJson("""{"v":1,"kind":"error","code":"$code"}""")
  }

  /** 原子写 `pending.json`，并先让旧 payload 引用的图片让位（latest wins）。 */
  private fun writeAtomicJson(json: String) {
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

  private companion object {
    /** inbox 子目录（契约见设计 §4.1） */
    const val INBOX_DIR = "share-inbox"
    const val PENDING_NAME = "pending.json"

    /**
     * 源字节上限：**必须大于**压缩后上限 1 MiB（设计 §4.4）。
     * ⚠️ 这是本链路上唯一没有单测的常量（Kotlin 无测试基建）⇒ 真机验收项 20 覆盖它。
     * ⚠️ 前端**不复制**这个数值（复制就是两份真相）。
     */
    const val SHARE_SOURCE_MAX_BYTES = 8L * 1024 * 1024
    const val COPY_BUFFER_BYTES = 64 * 1024
  }
}
