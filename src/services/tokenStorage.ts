// src/services/tokenStorage.ts
import { load, type Store } from "@tauri-apps/plugin-store";

const FILE = "tokens.json";

let storePromise: Promise<Store | null> | null = null;

// 惰性加载；非 Tauri 环境（浏览器 dev / 单元测试）load 会失败，回落 null → localStorage。
async function getStore(): Promise<Store | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        return await load(FILE, { autoSave: true });
      } catch {
        return null;
      }
    })();
  }
  return storePromise;
}

// refresh_token 按服务端用户 id 独立存储，避免同设备多账号互相覆盖：
// 此前单 key 存储，用户2绑定后覆盖用户1的 token，用户1重新登录会错误恢复成
// 用户2的会话，后续同步挂在用户2身份下、把用户1的流水/账户写成用户2的。
function keyFor(userId: string): string {
  return `refresh_token:${userId}`;
}

export async function readRefreshToken(userId: string): Promise<string | null> {
  const store = await getStore();
  if (store) return (await store.get<string>(keyFor(userId))) ?? null;
  return localStorage.getItem(keyFor(userId));
}

export async function writeRefreshToken(userId: string, token: string): Promise<void> {
  const store = await getStore();
  if (store) await store.set(keyFor(userId), token);
  else localStorage.setItem(keyFor(userId), token);
}

export async function deleteRefreshToken(userId: string): Promise<void> {
  const store = await getStore();
  if (store) await store.delete(keyFor(userId));
  else localStorage.removeItem(keyFor(userId));
}
