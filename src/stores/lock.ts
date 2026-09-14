// src/stores/lock.ts
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import {
  clearAppLock,
  readAppLock,
  writeAppLock,
  type AppLockConfig,
  type LockType,
} from "@/services/lockStorage";
import { usePrefsStore } from "@/stores/prefs";
import { hashPassword, verifyPassword } from "@/utils/passwordHash";
import { PIN_LENGTH, isWeakPin } from "@/utils/pin";
import { encodePattern, isValidPattern } from "@/utils/pattern";

/** 连续错误达到此值后，只接受账户密码。 */
export const MAX_UNLOCK_ATTEMPTS = 5;

/**
 * 锁的非口令设置默认值。
 *
 * ref 的初始值与 `applyConfig(null)` 的复位**共用这一份**：只此一套默认值，
 * 才不会出现「未配置态」与「默认值态」两个各自漂移的状态。
 */
const LOCK_SETTINGS_DEFAULTS: {
  type: LockType;
  autoLockSeconds: number;
  screenshotProtection: boolean;
} = {
  type: "pin",
  autoLockSeconds: 60,
  screenshotProtection: true,
};

/**
 * 应用锁状态机。
 *
 * 这层锁是 **UI 门禁**：挡住拿到设备的人随手翻账目，不做任何数据保密处理。
 * 口令只存 bcrypt 哈希（单向哈希，不可逆），配置落在 lockStorage。
 * 冷启动一律要求解锁：内存里没有「已解锁」的持久化，进程重启即回到锁定。
 */
export const useLockStore = defineStore("lock", () => {
  const isLocked = ref(false);
  const isLockConfigured = ref(false);
  const lockType = ref<LockType>(LOCK_SETTINGS_DEFAULTS.type);
  /** 生物识别本轮不做，恒为 false，且不提供任何写入入口。 */
  const biometricEnabled = ref(false);
  const autoLockSeconds = ref(LOCK_SETTINGS_DEFAULTS.autoLockSeconds);
  const screenshotProtection = ref(LOCK_SETTINGS_DEFAULTS.screenshotProtection);
  const failedAttempts = ref(0);

  /** 当前锁的 bcrypt 哈希，仅内存持有；未配置锁时为 null。 */
  const hash = ref<string | null>(null);

  const requireAccountPassword = computed(() => failedAttempts.value >= MAX_UNLOCK_ATTEMPTS);

  /**
   * 把非口令设置复位为默认值（`LOCK_SETTINGS_DEFAULTS`）。
   *
   * 未配置态**必须等于**默认值态：否则「在设置里关掉截屏防护 → 关闭应用锁 → 再开启」
   * 会让新锁带出上一会话遗留的 `screenshot_protection: false`，
   * 与「默认从严」的定义直接矛盾。
   */
  function applyDefaults(): void {
    lockType.value = LOCK_SETTINGS_DEFAULTS.type;
    autoLockSeconds.value = LOCK_SETTINGS_DEFAULTS.autoLockSeconds;
    screenshotProtection.value = LOCK_SETTINGS_DEFAULTS.screenshotProtection;
    // 生物识别不在本轮范围，默认值恒为 false，这里只可能写到 false。
    biometricEnabled.value = false;
  }

  function applyConfig(config: AppLockConfig | null): void {
    if (!config) {
      isLockConfigured.value = false;
      hash.value = null;
      applyDefaults();
      return;
    }
    isLockConfigured.value = true;
    lockType.value = config.type;
    hash.value = config.hash;
    biometricEnabled.value = config.biometric_enabled;
    autoLockSeconds.value = config.auto_lock_seconds;
    screenshotProtection.value = config.screenshot_protection;
  }

  async function load(): Promise<void> {
    applyConfig(await readAppLock());
  }

  function lock(): void {
    if (!isLockConfigured.value) return;
    isLocked.value = true;
    failedAttempts.value = 0;
    // 自动锁定后金额必须回到隐藏：用户点开眼睛看完、切后台被锁，
    // 解锁回来若仍是显示态，「默认隐藏」就在锁定路径上被绕过了。
    // 静态 import prefs：prefs 只依赖 pinia/vue，不存在 lock ↔ prefs 循环依赖，
    // 因此不必用动态 import + void，也就没有任何 unhandled rejection 的可能；
    // 顺带让遮蔽同步生效，消掉「已锁定但金额仍可见」的那一个微任务窗口。
    usePrefsStore().hideAmounts();
  }

  function unlock(): void {
    isLocked.value = false;
    failedAttempts.value = 0;
  }

  async function verifySecret(secret: string): Promise<boolean> {
    if (!hash.value) return false;
    // 降级态下即使输入正确也不再放行，否则「连错 5 次」形同虚设。
    if (requireAccountPassword.value) {
      failedAttempts.value++;
      return false;
    }
    const ok = await verifyPassword(secret, hash.value);
    if (ok) {
      unlock();
    } else {
      failedAttempts.value++;
    }
    return ok;
  }

  async function verifyPin(pin: string): Promise<boolean> {
    if (lockType.value !== "pin") return false;
    return verifySecret(pin);
  }

  async function verifyPattern(dots: readonly number[]): Promise<boolean> {
    if (lockType.value !== "pattern") return false;
    if (!isValidPattern(dots)) {
      failedAttempts.value++;
      return false;
    }
    return verifySecret(encodePattern(dots));
  }

  /**
   * 用账户密码证明身份。两条入口共用这一条路径：
   * - 降级态：连错达阈值后 PIN/图案一律不再放行，只接受账户密码；
   * - 「忘记密码？」：该按钮在**非降级态也渲染**（忘了 PIN 的用户唯一的出路），
   *   所以本 action 在**任何状态**下都可调用——不校验 `requireAccountPassword`
   *   是刻意为之的契约，否则忘记密码就成了死路、用户被永久锁在门外。
   *
   * **成功后不放行**：本 action 不改变 `isLocked`，只清零错误计数；
   * 调用方必须就地重设一个新锁才谈得上放行（锁屏页只在
   * `SetLockDialog` 发出 `saved` 之后才调用 `leave()`）。因此它**不构成解锁后门**。
   */
  async function unlockWithAccountPassword(username: string, password: string): Promise<boolean> {
    const { useAuthStore } = await import("@/stores/auth");
    const ok = await useAuthStore().localLogin(username, password);
    if (!ok) {
      failedAttempts.value++;
      return false;
    }
    failedAttempts.value = 0;
    return true;
  }

  /**
   * 设置或重设锁。传入不合规口令直接抛错，不落盘、不改内存态——
   * 否则 UI 会以为锁已设好。
   */
  async function setLock(type: LockType, secret: string | readonly number[]): Promise<void> {
    if (type === "pin") {
      if (typeof secret !== "string" || isWeakPin(secret)) {
        throw new Error(`PIN 需为 ${PIN_LENGTH} 位数字，且不能是全同或连续数字`);
      }
    } else {
      if (typeof secret === "string" || !isValidPattern(secret)) {
        throw new Error("图案至少连接 4 个点");
      }
    }

    const plain = typeof secret === "string" ? secret : encodePattern(secret);
    const nextHash = await hashPassword(plain);

    const config: AppLockConfig = {
      type,
      hash: nextHash,
      biometric_enabled: biometricEnabled.value,
      auto_lock_seconds: autoLockSeconds.value,
      screenshot_protection: screenshotProtection.value,
    };
    await writeAppLock(config);
    applyConfig(config);
    failedAttempts.value = 0;
  }

  /**
   * 改锁的非口令设置。未配置锁时是空操作。
   * patch 里的 biometric_enabled 会被忽略：生物识别不在本轮范围内，不开放写入。
   */
  async function updateSettings(patch: Partial<Omit<AppLockConfig, "type" | "hash">>): Promise<void> {
    if (!hash.value) return;
    const config: AppLockConfig = {
      type: lockType.value,
      hash: hash.value,
      biometric_enabled: biometricEnabled.value,
      auto_lock_seconds: patch.auto_lock_seconds ?? autoLockSeconds.value,
      screenshot_protection: patch.screenshot_protection ?? screenshotProtection.value,
    };
    await writeAppLock(config);
    applyConfig(config);
  }

  async function clearLock(): Promise<void> {
    await clearAppLock();
    applyConfig(null);
    isLocked.value = false;
    failedAttempts.value = 0;
  }

  return {
    isLocked,
    isLockConfigured,
    lockType,
    biometricEnabled,
    autoLockSeconds,
    screenshotProtection,
    failedAttempts,
    requireAccountPassword,
    load,
    lock,
    unlock,
    verifyPin,
    verifyPattern,
    unlockWithAccountPassword,
    setLock,
    updateSettings,
    clearLock,
  };
});
