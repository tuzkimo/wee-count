import { describe, it, expect, vi, beforeEach } from "vitest";

// `settingsFile` 是本模块唯一的外部依赖：这一层只钉"读永不抛 / 写失败必须 reject / 键与默认值"。
// 键名要**逐字**断言：改错键名（例如与截屏防护共用 `screenshot_protection`）会让两个开关互相覆盖，
// 而那种错误在只读一遍代码时几乎看不出来。
const readSetting = vi.hoisted(() => vi.fn());
const writeSetting = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/services/settingsFile", () => ({ readSetting, writeSetting }));

import {
  AI_PRIVACY_CARD_SEEN_DEFAULT,
  AI_SENDING_ENABLED_DEFAULT,
  readPrivacyCardSeen,
  readSendingEnabled,
  writePrivacyCardSeen,
  writeSendingEnabled,
} from "@/services/aiPrivacySettings";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AI 意愿层开关与说明卡状态（§7.3）", () => {
  it("默认值：发送开关**从严关闭**、说明卡未看过", () => {
    // 杀手：把 `AI_SENDING_ENABLED_DEFAULT` 改成 true ⇒ 这条红（而 store 的默认值就是从它来的）
    expect(AI_SENDING_ENABLED_DEFAULT).toBe(false);
    expect(AI_PRIVACY_CARD_SEEN_DEFAULT).toBe(false);
  });

  it("读开关用独立的键，且**读不到不抛**、回落关闭", async () => {
    for (const kind of ["absent", "invalid", "unavailable"] as const) {
      readSetting.mockResolvedValueOnce(
        kind === "absent" ? { kind: "absent" } : { kind, cause: new Error("boom"), stage: "load" },
      );
      await expect(readSendingEnabled()).resolves.toBe(false);
      // 杀手：把键名换成 `screenshot_protection`（与截屏防护共用）⇒ 这两条红
      expect(readSetting).toHaveBeenCalledWith("ai_sending_enabled", expect.any(Function));
    }
  });

  it("读到 true 就返回 true，且解析函数只认 boolean（字符串 true 不算）", async () => {
    readSetting.mockImplementationOnce(async (_key: string, parse: unknown) => {
      // 用真实调用点传来的解析函数跑一遍：钉住"只认 boolean"（存成字符串时不能算已开启）
      const asBoolean = parse as (v: unknown) => boolean | null;
      expect(asBoolean(true)).toBe(true);
      expect(asBoolean(false)).toBe(false);
      expect(asBoolean("true")).toBeNull();
      return { kind: "found", value: true };
    });
    await expect(readSendingEnabled()).resolves.toBe(true);
  });

  it("写开关：写到 `ai_sending_enabled`，失败必须 reject（不许静默假确认）", async () => {
    await writeSendingEnabled(true);
    expect(writeSetting).toHaveBeenCalledWith("ai_sending_enabled", true, expect.anything());

    writeSetting.mockRejectedValueOnce(new Error("disk full"));
    // 杀手：把 `await writeSetting(...)` 换成 `void writeSetting(...)` 或吞掉异常 ⇒ 这条红
    await expect(writeSendingEnabled(false)).rejects.toThrow("disk full");
  });

  it("说明卡状态：独立键、读不到按未看过、写入固定 true", async () => {
    readSetting.mockResolvedValueOnce({ kind: "absent" });
    await expect(readPrivacyCardSeen()).resolves.toBe(false);
    expect(readSetting).toHaveBeenCalledWith("ai_privacy_card_seen", expect.any(Function));

    readSetting.mockResolvedValueOnce({ kind: "found", value: true });
    await expect(readPrivacyCardSeen()).resolves.toBe(true);

    await writePrivacyCardSeen();
    expect(writeSetting).toHaveBeenCalledWith("ai_privacy_card_seen", true, expect.anything());
  });
});
