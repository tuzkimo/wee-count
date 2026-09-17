// src/services/privacySettings.ts
import { readSetting, writeSetting } from "@/services/settingsFile";

/**
 * 截屏防护（Android 侧即 `FLAG_SECURE`）的持久化。
 *
 * 它**不属于应用锁**：这个开关拦的是「截屏」与「最近任务缩略图」，
 * 有没有应用锁都成立。1.1.x 把它存在 `app_lock` 里，而那份结构的 hash 是必填的，
 * 于是「没有应用锁」就等于「这个设置既读不出也写不进」，界面只能把开关藏起来；
 * 默认值又是开启，用户想关就必须先建一把应用锁 —— 被迫做了两件不相干的事。
 */
const KEY = "screenshot_protection";
/** 1.1.x 存放该值的旧位置（`app_lock.screenshot_protection`），只读，用于一次性迁移。 */
const LEGACY_KEY = "app_lock";
const LOG = { tag: "privacySettings", label: "截屏防护设置" } as const;

/**
 * 默认值：**从严开启**。
 *
 * 界面上的开关与它无关地恒可写，所以「默认开启」不再等于「用户被卡住」：
 * 不想被拦的人一步就能关掉，而默认姿态仍是保护账目数据。
 */
export const SCREENSHOT_PROTECTION_DEFAULT = true;

function asBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/**
 * 从旧结构里取截屏防护值。刻意**只看这一个字段**，不要求锁配置本身合法：
 * 那是用户表达过的真实选择，锁的哈希坏掉不该让这个选择被当成没表达过。
 */
function legacyScreenshotProtection(raw: unknown): boolean | null {
  if (typeof raw !== "object" || raw === null) return null;
  return asBoolean((raw as Record<string, unknown>).screenshot_protection);
}

/**
 * 读截屏防护设置，**永不抛错**（启动路径要用它，reject 会白屏）。
 *
 * 三种「读不到」分别处理，顺序不能颠倒：
 * 1. 独立键有值 → 用它，这是唯一真相源；
 * 2. 独立键**确实不存在** → 采纳旧位置的值并尽力迁移落盘。只认 `absent` 不认 `invalid`：
 *    键在但读不懂时写初值就是在覆盖别人的数据；
 * 3. 其余情况（读不懂 / 读不到）→ 回落从严默认值。
 *
 * 迁移那一步不能省：不写回的话，用户下次关闭应用锁会删掉 `app_lock`，
 * 于是「他特意关掉的截屏防护」会自己打开 —— 正是这次要修的同一类毛病。
 * 迁移写失败只 warn：本次仍按旧值生效，下次启动再试一遍。
 */
export async function readScreenshotProtection(): Promise<boolean> {
  const own = await readSetting(KEY, asBoolean);
  if (own.kind === "found") return own.value;

  if (own.kind === "invalid") {
    // 键在但读不懂：不覆盖它（可能是别的版本写的），本次按默认值处理。
    console.warn("[privacySettings] 截屏防护设置无法解析，本次按默认值处理");
  }

  if (own.kind === "absent") {
    const legacy = await readSetting(LEGACY_KEY, legacyScreenshotProtection);
    if (legacy.kind === "found") {
      try {
        await writeSetting(KEY, legacy.value, { ...LOG, action: "写回" });
      } catch (cause) {
        console.warn("[privacySettings] 截屏防护设置迁移落盘失败，本次仍按旧值生效", cause);
      }
      return legacy.value;
    }
  } else if (own.kind === "unavailable") {
    // 读不到就回落默认值，但必须留下痕迹：用户上次关掉的状态这次没生效，
    // 全靠下次启动再读一遍纠正。
    console.warn(
      own.stage === "load"
        ? "[privacySettings] settings.json 加载失败，本次按默认值处理"
        : "[privacySettings] 读取截屏防护设置失败，本次按默认值处理",
      own.cause,
    );
  }

  return SCREENSHOT_PROTECTION_DEFAULT;
}

/**
 * 写截屏防护设置。**失败必须 reject**：这是用户主动发起的动作，
 * 静默返回等于对用户动作做假确认（界面显示已关闭，磁盘上仍是开启）。
 */
export async function writeScreenshotProtection(enabled: boolean): Promise<void> {
  await writeSetting(KEY, enabled, { ...LOG, action: "写入" });
}
