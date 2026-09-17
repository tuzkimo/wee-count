// src/services/onboarding.ts
import { readSetting, writeSetting } from "@/services/settingsFile";

/**
 * 「是否已就『开不开应用锁』询问过用户」的设备级标记。
 *
 * 设备级而非账户级，因为应用锁本身就是设备级的（配置在 settings.json 里，不随账户走）：
 * 同一台设备上换账户登录不该被反复问，而换一台新手机登录老账户**应该**被问一次 ——
 * 那正是最需要它的场景（新设备上默认没有锁）。
 */
const KEY = "app_lock_asked";
const LOG = { tag: "onboarding", label: "应用锁引导标记" } as const;

/**
 * 三态而不是布尔：`unknown`（读不懂 / 读不到）必须与 `no` 分开。
 *
 * 两者的处置相反：`no` 要弹窗，`unknown` 不弹。引导不是关键路径（「我的 → 安全」里
 * 有常驻入口），所以读不出来时宁可少打扰一次，也不要把「每次登录都弹」变成
 * 存储故障的表现形式。
 */
export type AppLockAsked = "yes" | "no" | "unknown";

function asBoolean(raw: unknown): boolean | null {
  return typeof raw === "boolean" ? raw : null;
}

/** 读标记，**永不抛错**（读路径的契约，见 settingsFile）。 */
export async function readAppLockAsked(): Promise<AppLockAsked> {
  const read = await readSetting(KEY, asBoolean);
  if (read.kind === "found") return read.value ? "yes" : "no";
  if (read.kind === "absent") return "no";

  console.warn(
    read.kind === "invalid"
      ? "[onboarding] 应用锁引导标记无法解析，本次不询问"
      : "[onboarding] 读取应用锁引导标记失败，本次不询问",
    read.kind === "invalid" ? undefined : read.cause,
  );
  return "unknown";
}

/**
 * 记下「问过了」。**失败必须 reject**，但调用方按尽力而为处理：
 * 写不进去最坏是下次登录再问一次，不存在对用户的假承诺，所以不必弹错误提示。
 */
export async function markAppLockAsked(): Promise<void> {
  await writeSetting(KEY, true, { ...LOG, action: "写入" });
}
