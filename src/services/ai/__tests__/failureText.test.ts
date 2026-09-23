// src/services/ai/__tests__/failureText.test.ts
//
// T3（G3/C3）：`host === null` **至少三类来源**，必须说三句不同的话。
//
// 真机事故里三类来源（地址/登录态未就绪、网络不可达、服务端真没配）全被渲染成
// 「服务端未配置 AI」，把用户引向完全错误的方向。本文件表驱动钉住"分流"这件事本身：
// 四类输入 ⇒ 四句互不相同的话，且**只有"服务端明确没配"那一句含「未配置」**。
//
// 杀手：
//   - 把 `network` 与 `configured === false` 两支的返回值对调 ⇒ 用例①②红；
//   - 让 `host === null` 那支退回旧文案（含「服务端未配置」）⇒ 用例④⑤红；
//   - 去掉 `hasBaseUrl` 这一条分界（地址未就绪也说成"网络不可达"）⇒ 用例④红。
import { describe, it, expect } from "vitest";
import {
  AI_NOT_CONFIGURED_TEXT,
  describeHostState,
  describeOffHint,
  type OffHintParams,
} from "@/services/ai/failureText";

const BASE: OffHintParams = {
  sendingEnabled: true,
  host: null,
  failureKind: null,
  configured: null,
  hasBaseUrl: true,
};

/** 服务端**明确**没配（200 + enabled:false，或 503 ai_disabled） */
const NOT_CONFIGURED: OffHintParams = { ...BASE, configured: false, sendingEnabled: false };
/** 地址 / 登录态未就绪：请求根本没发出去 */
const NOT_READY: OffHintParams = { ...BASE, hasBaseUrl: false };
/** 网络不可达 / 超时 / 429 / 形状坏 / 401 / 5xx */
const NETWORK: OffHintParams = { ...BASE, failureKind: "network" };
/** 意愿层关着（用户自己关的，与服务端无关） */
const OFF: OffHintParams = { ...BASE, sendingEnabled: false, host: "ai.example.com" };

describe("describeOffHint：host === null 的三类来源必须分开（C3/C5）", () => {
  it("① 服务端**明确**没配 ⇒ 唯一允许出现「未配置」的那一句", () => {
    const text = describeOffHint(NOT_CONFIGURED);
    expect(text).toContain("未配置");
    expect(text).toBe(AI_NOT_CONFIGURED_TEXT);
  });

  it("② 意愿层关着 + host 未知 ⇒ 说「去哪打开」，**不许**诬赖服务端没配", () => {
    const text = describeOffHint({ ...OFF, host: null });
    expect(text).toContain("我的 → 隐私");
    // 杀手：这一支退回旧文案（`host === null ⇒ 服务端未配置 AI`）⇒ 红
    expect(text).not.toContain("未配置");
  });

  it("③ 意愿层关着 + host 可知 ⇒ 接管 `AiChatPage.test.ts:747` 的原意图（逐字含「我的 → 隐私」）", () => {
    const text = describeOffHint(OFF);
    expect(text).toContain("我的 → 隐私");
    expect(text).toContain("ai.example.com");
  });

  it("④ 地址 / 登录态未就绪 ⇒ 说「还没连上服务器」，不许说成服务端没配（C3.4）", () => {
    const text = describeOffHint(NOT_READY);
    expect(text).toContain("服务器");
    expect(text).not.toContain("未配置");
  });

  it("⑤ 网络不可达 ⇒ 复用 `describeFailure` 的原文并带「检测失败：」前缀（C3.5）", () => {
    const text = describeOffHint(NETWORK);
    expect(text).toContain("检测失败：");
    expect(text).toContain("网络似乎不太顺");
    expect(text).not.toContain("未配置");
  });

  it("⑥ 四类来源 + 意愿层 ⇒ 五句**互不相同**（分流不是「换个变量拼同一句」）", () => {
    const texts = [
      describeOffHint(NOT_CONFIGURED),
      describeOffHint({ ...OFF, host: null }),
      describeOffHint(NOT_READY),
      describeOffHint(NETWORK),
      describeOffHint(BASE), // 已开启、地址有、这轮还没结论 ⇒ 给重试入口
    ];
    expect(new Set(texts).size).toBe(5);
    expect(describeOffHint(BASE)).toContain("重新检测");
  });
});

describe("describeHostState：隐私区那一行（C3），`host === null` 时绝不插值出 null", () => {
  it("① host 可知 ⇒ 逐字写出数据发往哪个服务器（C3.2）", () => {
    expect(describeHostState({ ...BASE, host: "ai.example.com" })).toBe("数据将发送到 ai.example.com。");
  });

  it("② 服务端明确没配 ⇒ 「未配置」；地址未就绪 / 网络失败 ⇒ 各说各的（C3.1/C3.4/C3.5）", () => {
    expect(describeHostState(NOT_CONFIGURED)).toContain("未配置");
    expect(describeHostState(NOT_READY)).not.toContain("未配置");
    expect(describeHostState(NETWORK)).toContain("检测失败：");
  });

  it("③ 五类输入下文本都不出现 `null`（杀手：改回直接插值 `ai.host` ⇒ 红）", () => {
    for (const params of [NOT_CONFIGURED, NOT_READY, NETWORK, BASE, { ...BASE, host: "h" }]) {
      expect(describeHostState(params)).not.toContain("null");
    }
  });
});
