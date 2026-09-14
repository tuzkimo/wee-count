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
});
