import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "@/utils/passwordHash";

describe("passwordHash", () => {
  it("哈希后能用原密码验证通过", async () => {
    const hash = await hashPassword("123456");
    expect(hash).not.toBe("123456");
    expect(await verifyPassword("123456", hash)).toBe(true);
  });

  it("错误密码验证失败", async () => {
    const hash = await hashPassword("123456");
    expect(await verifyPassword("654321", hash)).toBe(false);
  });

  it("同一密码两次哈希结果不同（含随机 salt）", async () => {
    expect(await hashPassword("123456")).not.toBe(await hashPassword("123456"));
  });

  it("哈希格式为 bcrypt（$2 前缀）", async () => {
    expect(await hashPassword("123456")).toMatch(/^\$2[aby]\$/);
  });

  it("cost factor 固定为 10", async () => {
    // 行为中性约束：抽取共用工具不得改变落库哈希的 cost（bcryptjs 输出 $2b$<cost>$...）。
    // 上面那条只断言 $2 前缀、不含 cost 段，把 passwordHash.ts 的 10 改成 4 或 12 也全绿。
    const hash = await hashPassword("123456");
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(hash.split("$")[2]).toBe("10");
  });
});
