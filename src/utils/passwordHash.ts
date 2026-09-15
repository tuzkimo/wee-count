// src/utils/passwordHash.ts
// 账户密码与应用锁 PIN 共用的 bcrypt 封装。不要在本文件之外再写一份 bcrypt 调用。

export async function hashPassword(password: string): Promise<string> {
  const bcrypt = await import("bcryptjs");
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const bcrypt = await import("bcryptjs");
  return bcrypt.compare(password, hash);
}
