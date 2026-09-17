// src/stores/onboarding.ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { readAppLockAsked, markAppLockAsked } from "@/services/onboarding";
import { useLockStore } from "@/stores/lock";

/**
 * 新用户的引导：账户建好/登录成功之后，问一次「要不要开应用锁」。
 *
 * 为什么是**问一次**而不是每次：应用锁是设备级设置，已经配了锁的设备直接跳过；
 * 没配锁的设备只问一遍（拒绝也算问过）。反复弹窗在「我的 → 安全」有常驻入口的前提下
 * 只会变成打扰，而提示一次已经足够让不知道这个功能的人知道它存在。
 *
 * 状态放 store 而不是各页面自己 `ref`：对话框是全局单例（挂在 `App.vue`），
 * 三个登录/注册入口共用同一条流程，UI 不该有三个副本。
 */
export const useOnboardingStore = defineStore("onboarding", () => {
  /** 询问对话框是否可见。 */
  const promptVisible = ref(false);

  /** 等待用户选择的那次 resolve；用户作出选择时调用。 */
  let settle: (() => void) | null = null;

  /**
   * 正在进行的那次询问。并发/重复调用直接跟着**同一次**走，不新开一个。
   *
   * 只靠 `promptVisible` 挡不住重入：两次调用可以都在它还是 false 的时候进入，
   * 各自 await 读标记，后者会把 `settle` 覆盖掉，先来的那次就永远没人放行了
   * （表现在界面上是登录之后卡住不动）。所以这里缓存的是 promise 本身。
   */
  let asking: Promise<void> | null = null;

  /**
   * 需要时弹出询问，并 await 到用户作出选择为止。
   *
   * 调用方是「创建账户/登录成功、即将跳首页」那三个页面：await 之后照常跳转，
   * 用户的选择不改变跳转目标。
   *
   * 两个前置判断：
   * - 已经配置了应用锁（不必问，问了也只能是重复设置）；
   * - 标记不是 `no`（`yes` 是问过，`unknown` 是读不出来 —— 两者都不弹）。
   *
   * **本 action 永不 reject**：它是锦上添花，出任何意外都不许被调用方那一层的
   * 「创建失败，请重试 / 登录失败」兜住 —— 那时账户其实已经建好、也已经登录成功了，
   * 报「失败」是彻头彻尾的谎话，用户会以为要重来一遍。
   */
  function promptAppLockIfNeeded(): Promise<void> {
    if (asking) return asking;
    asking = runPrompt().finally(() => {
      asking = null;
    });
    return asking;
  }

  async function runPrompt(): Promise<void> {
    try {
      if (useLockStore().isLockConfigured) return;

      if ((await readAppLockAsked()) !== "no") return;

      promptVisible.value = true;
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
    } catch (cause) {
      console.warn("[onboarding] 应用锁引导未能进行，跳过本次询问", cause);
    } finally {
      // 无论走到哪条路径都收尾。出了意外绝不能留一个点不动的遮罩，
      // 那才是真的把用户卡在登录页。
      promptVisible.value = false;
      settle = null;
    }
  }

  /**
   * 用户已作出选择（设置好了 / 暂不开启 / 中途取消），结束这次询问。
   *
   * **先把界面交还给调用方，再落盘**：写标记是一次 settings.json 写入，不该让它
   * 挡在「进入首页」前面。写失败也只是下次再问一次（见 services/onboarding），
   * 不存在对用户的假承诺，所以只留一条日志。
   */
  async function finishAppLockPrompt(): Promise<void> {
    const resolve = settle;
    settle = null;
    promptVisible.value = false;
    resolve?.();

    try {
      await markAppLockAsked();
    } catch (cause) {
      console.warn("[onboarding] 应用锁引导标记未写入，下次登录可能再问一次", cause);
    }
  }

  return { promptVisible, promptAppLockIfNeeded, finishAppLockPrompt };
});
