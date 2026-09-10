// src/services/backup/__tests__/crypto.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encryptJson, decryptJson, PBKDF2_ITERATIONS } from "../crypto";
import { BackupError } from "../types";
import { stubWebCrypto } from "./webcrypto";

beforeEach(() => stubWebCrypto());
afterEach(() => vi.unstubAllGlobals());

describe("encryptJson/decryptJson", () => {
  it("往返一致", async () => {
    const payload = { hello: "世界", n: 42, nested: { ok: true } };
    const boxed = await encryptJson(payload, "password123");
    await expect(decryptJson(boxed, "password123")).resolves.toEqual(payload);
  });

  it("salt 与 iv 每次随机（16B/12B）", async () => {
    const a = await encryptJson({ x: 1 }, "password123");
    const b = await encryptJson({ x: 1 }, "password123");
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(atob(a.iv).length).toBe(12);
    expect(atob(a.salt).length).toBe(16);
  });

  it("密码错误 → decrypt 错误", async () => {
    const boxed = await encryptJson({ x: 1 }, "password123");
    await expect(decryptJson(boxed, "wrong-pass")).rejects.toMatchObject({
      name: "BackupError",
      code: "decrypt",
    });
  });

  it("密文被篡改 → decrypt 错误", async () => {
    const boxed = await encryptJson({ x: 1 }, "password123");
    // 解码为字节并翻转首字节最高位，保证必然改变密文（直接替换 b64 前缀有 ~1.6% 概率不变）
    const bytes = Uint8Array.from(atob(boxed.data), (c) => c.charCodeAt(0));
    bytes[0] ^= 0x80;
    const tampered = { ...boxed, data: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptJson(tampered, "password123")).rejects.toBeInstanceOf(
      BackupError
    );
  });

  it("大 payload（1 万行）往返一致", async () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ id: `t${i}`, amount: i }));
    const boxed = await encryptJson({ rows }, "password123");
    await expect(decryptJson<{ rows: unknown[] }>(boxed, "password123")).resolves.toHaveProperty(
      "rows.length",
      10000
    );
  });

  it("迭代次数为 600000", () => {
    expect(PBKDF2_ITERATIONS).toBe(600_000);
  });
});
