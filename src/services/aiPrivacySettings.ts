// src/services/aiPrivacySettings.ts
import { readSetting, writeSetting } from "@/services/settingsFile";

/**
 * AI 意愿层开关（规格 §7.3）的持久化。
 *
 * 两层开关缺一不可：后端 `AI_API_KEY` 空 = **能力层**不可用（`/ai/status` 的 `enabled`），
 * 客户端这个开关 = **意愿层**，**默认关闭**，开启前必须先看说明卡。
 *
 * 与截屏防护（`services/privacySettings.ts`）同一套读写层与同一套承诺：
 * **读永不抛**（启动路径用，reject 会白屏）、**写失败必须 reject**（用户主动动作不许假确认）。
 * 键刻意与 `screenshot_protection` 分开：两件事的默认值相反（那个从严开启，这个从严关闭），
 * 合在一个键里就会出现"关掉 AI 顺手把截屏防护也关了"。
 */
const ENABLED_KEY = "ai_sending_enabled";
const CARD_SEEN_KEY = "ai_privacy_card_seen";
const LOG = { tag: "aiPrivacySettings", label: "AI 助手开关" } as const;
const CARD_LOG = { tag: "aiPrivacySettings", label: "AI 隐私说明卡" } as const;

/**
 * 默认值：**从严关闭**（§7.3 明写「默认关闭」）。
 *
 * 关着的时候 `aiChat.send` 一个请求都不发（`store` 里的门控 + 输入框禁用），
 * 所以"读不到配置"只会退化成"这次用不了 AI"，绝不会退化成"以为关了其实在发"。
 */
export const AI_SENDING_ENABLED_DEFAULT = false;
/** 说明卡是否已经看过（看过就不再自动弹；"开启前必须先看说明卡"靠它成立） */
export const AI_PRIVACY_CARD_SEEN_DEFAULT = false;

function asBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * 读意愿层开关。**永不抛**：读不到回落 `AI_SENDING_ENABLED_DEFAULT`（从严关闭）。
 *
 * `invalid`（键在但读不懂）不覆盖它，只 warn —— 与 `readScreenshotProtection` 同一条理由：
 * 把"读不懂"当"不存在"去写初值，就是在覆盖别人的数据。
 */
export async function readSendingEnabled(): Promise<boolean> {
  const own = await readSetting(ENABLED_KEY, asBoolean);
  if (own.kind === "found") return own.value;
  if (own.kind === "invalid") {
    console.warn("[aiPrivacySettings] AI 助手开关无法解析，本次按默认值（关闭）处理");
  } else if (own.kind === "unavailable") {
    console.warn(
      own.stage === "load"
        ? "[aiPrivacySettings] settings.json 加载失败，AI 助手开关按默认值（关闭）处理"
        : "[aiPrivacySettings] 读取 AI 助手开关失败，按默认值（关闭）处理",
      own.cause,
    );
  }
  return AI_SENDING_ENABLED_DEFAULT;
}

/** 写意愿层开关。失败必须 reject（用户主动动作，静默返回 = 界面说开了、磁盘上没开）。 */
export async function writeSendingEnabled(enabled: boolean): Promise<void> {
  await writeSetting(ENABLED_KEY, enabled, { ...LOG, action: "写入" });
}

/**
 * 说明卡是否看过。**只用于"要不要自动弹"**，不参与任何权限判定 ——
 * 能不能**开启**开关只看 `host`（§7.3 的硬门槛），不看这张卡看过没有。
 */
export async function readPrivacyCardSeen(): Promise<boolean> {
  const own = await readSetting(CARD_SEEN_KEY, asBoolean);
  if (own.kind === "found") return own.value;
  if (own.kind === "invalid" || own.kind === "unavailable") {
    // 读不回来只会让说明卡**再弹一次**（安全的一侧）；但仍要留痕，否则用户会以为开关坏了
    console.warn("[aiPrivacySettings] 说明卡看过状态读不到，本次按未看过处理", own);
  }
  return AI_PRIVACY_CARD_SEEN_DEFAULT;
}

/** 标记说明卡已看过。失败必须 reject（否则用户点「知道了」，下次启动它又弹出来）。 */
export async function writePrivacyCardSeen(): Promise<void> {
  await writeSetting(CARD_SEEN_KEY, true, { ...CARD_LOG, action: "写入" });
}
