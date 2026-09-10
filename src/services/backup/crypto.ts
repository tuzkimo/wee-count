// src/services/backup/crypto.ts
import { BackupError } from "./types";

/** OWASP 当前建议：PBKDF2-SHA256 ≥ 600,000 次 */
export const PBKDF2_ITERATIONS = 600_000;

const CHUNK = 0x8000; // 分块转 b64，避免 String.fromCharCode 展开溢出（大 payload）

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/** 加密任意可序列化值，返回 b64 编码的 salt/iv/密文（GCM tag 附在密文尾部） */
export async function encryptJson(
  value: unknown,
  password: string
): Promise<{ salt: string; iv: string; data: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
  return { salt: bytesToB64(salt), iv: bytesToB64(iv), data: bytesToB64(cipher) };
}

/** 解密并 JSON.parse。密码错误与文件篡改统一映射为 BackupError('decrypt')（GCM 认证无法区分） */
export async function decryptJson<T>(
  boxed: { salt: string; iv: string; data: string },
  password: string
): Promise<T> {
  try {
    const key = await deriveKey(password, b64ToBytes(boxed.salt));
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(boxed.iv) },
      key,
      b64ToBytes(boxed.data)
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    throw new BackupError("decrypt", "密码错误或文件已损坏");
  }
}
