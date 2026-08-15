// src/services/sync.ts
import { apiFetch, hasBaseUrl } from "./api";
import { getUserDb, getCurrentUserId } from "@/db/userDb";
import type Database from "@tauri-apps/plugin-sql";
import type { Account, Transaction, Category, Tag, Ledger } from "@/types";

export interface MemberAliasPayload {
  setter_user_id: string;
  target_user_id: string;
  alias_name: string;
  updated_at: string;
}

export interface SyncPayload {
  ledgers: Ledger[];
  accounts: Account[];
  tags: Tag[];
  categories: Category[];
  transactions: Transaction[];
  member_aliases: MemberAliasPayload[];
}

interface SyncRequest {
  last_server_seq: number;
  local_changes: SyncPayload;
}

interface SyncResponse {
  server_seq: number;
  remote_changes: SyncPayload;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;
let pendingChanges: SyncPayload = {
  ledgers: [],
  accounts: [],
  tags: [],
  categories: [],
  transactions: [],
  member_aliases: [],
};
let isSyncing = false;
let syncQueued = false;

// 游标按本地用户隔离：每个用户有独立 SQLite（{userId}.db），各自数据进度不同，
// 不能共享一个 last_server_seq，否则 A 同步推进游标后，B 切回来按新游标增量同步，
// 会跳过 B 本地从未拉取过的数据（团队账本里别人加的数据就是典型场景）。
function cursorKeyFor(uid: string | null): string {
  return uid ? `last_server_seq:${uid}` : "last_server_seq";
}

function cursorKey(): string {
  return cursorKeyFor(getCurrentUserId());
}

export function getLastSyncedAt(): string | null {
  return localStorage.getItem(cursorKey());
}

function getLastSyncedAtFor(uid: string | null): string | null {
  return localStorage.getItem(cursorKeyFor(uid));
}

export function setLastSyncedAt(time: string): void {
  localStorage.setItem(cursorKey(), time);
}

function setLastSyncedAtFor(uid: string | null, time: string): void {
  localStorage.setItem(cursorKeyFor(uid), time);
}

// 「上次同步时间」与 seq 游标解耦：getLastSyncedAt 存的是 server_seq 整数串（如 "5"），
// 直接 new Date("5") 会被解析成 1970 年 1 月，不能拿来展示「上次同步时间」。
// 这里用独立 key 存 wall-clock 时间，供 UI 展示。
function lastSyncedTimeKeyFor(uid: string | null): string {
  return uid ? `last_synced_time:${uid}` : "last_synced_time";
}

export function getLastSyncedTime(): string | null {
  return localStorage.getItem(lastSyncedTimeKeyFor(getCurrentUserId()));
}

function setLastSyncedTimeFor(uid: string | null, time: string): void {
  localStorage.setItem(lastSyncedTimeKeyFor(uid), time);
}

// 供 migration.ts 的 firstFullSync 复用：直接用当前 uid 写当前 wall-clock 时间，
// 避免 migration.ts 反向静态 import 造成循环依赖。
export function setLastSyncedTimeNow(): void {
  setLastSyncedTimeFor(getCurrentUserId(), new Date().toISOString());
}

/**
 * 清空待推送队列与定时器。登出/切用户时必须调用，否则模块级 pendingChanges
 * 会把用户 A 积压的本地变更当作 B 的 local_changes 推到 B 账号（跨账号串数据）。
 */
export function clearPendingSync(): void {
  pendingChanges = { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] };
  retryAttempt = 0;
  syncQueued = false;
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
}

/**
 * Enqueue local changes into sync queue, debounced 3 seconds
 */
export function enqueueSync(changes: Partial<SyncPayload>): void {
  // ponytail: skip sync in local mode, no server configured
  if (!hasBaseUrl()) return;

  mergeChanges(pendingChanges, changes);

  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    void performSyncIfOnline();
  }, 3000);
}

// 降级模式（绑定在线但会话未恢复，mode!=='online'）下不推送：
// token 缺失会让每次 /sync 走 401→refresh 失败→重新入队的风暴。
// 变更留在 pendingChanges，等 restoreOnlineSession 成功后的 triggerOnlineSync 统一推。
async function performSyncIfOnline(): Promise<void> {
  try {
    const { useAuthStore } = await import("@/stores/auth");
    if (!useAuthStore().isOnline) return;
  } catch {
    return; // auth store 尚未初始化
  }
  void performSync().catch(() => {});
}

// 同步失败后按指数退避重新武装定时器：5s → 10s → 20s → 60s（上限）。
// performSyncIfOnline 内部已按 isOnline 守卫，非 online 时静默跳过，等会话恢复再推。
function scheduleRetry(): void {
  if (syncTimer) clearTimeout(syncTimer);
  const delay = Math.min(5000 * Math.pow(2, retryAttempt), 60000);
  retryAttempt++;
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void performSyncIfOnline();
  }, delay);
}

export function mergeChanges(target: SyncPayload, source: Partial<SyncPayload>): void {
  for (const key of ["ledgers", "accounts", "tags", "categories", "transactions", "member_aliases"] as const) {
    const targetArr = target[key] as Array<{ id: string; updated_at: string }>;
    const sourceArr = source[key] as Array<{ id: string; updated_at: string }> | undefined;
    if (!sourceArr) continue;
    for (const item of sourceArr) {
      const idx = targetArr.findIndex((t) => t.id === item.id);
      if (idx >= 0) {
        if (compareTimestamp(item.updated_at, targetArr[idx].updated_at) > 0) {
          targetArr[idx] = item;
        }
      } else {
        targetArr.push(item);
      }
    }
  }
}

/**
 * 同步入口（带互斥）：并发调用时，在途的同步不会被重复执行；若在途期间又有同步请求，
 * 标记 syncQueued，待本次结束后补跑一次，避免变更卡在 pendingChanges 里。
 */
export async function performSync(): Promise<boolean> {
  if (isSyncing) {
    syncQueued = true;
    return false;
  }
  isSyncing = true;
  try {
    return await doSync();
  } finally {
    isSyncing = false;
    if (syncQueued) {
      syncQueued = false;
      void performSync();
    }
  }
}

/**
 * 执行一次同步：发送本地变更、接收并合并远程变更。
 * 返回是否同步成功（含首次全量同步）；失败时本地变更已重新入队待重试。
 */
async function doSync(): Promise<boolean> {
  const uid = getCurrentUserId();
  const db = getUserDb();
  const lastSyncedAt = getLastSyncedAtFor(uid);

  // 从未同步成功过，做全量上传
  if (!lastSyncedAt) {
    const { firstFullSync } = await import('./migration')
    try {
      await firstFullSync()
    } catch (e) {
      console.warn('[sync] firstFullSync failed:', e)
      await markSyncResult(false)
      scheduleRetry()
      return false
    }
    retryAttempt = 0;
    await markSyncResult(true)
    return true
  }

  const lastServerSeq = parseInt(lastSyncedAt, 10);

  const changes = { ...pendingChanges };
  pendingChanges = { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] };

  // 推送前补充本地 member_aliases（别名变更不经过 pendingChanges 入队，这里全量带）
  try {
    changes.member_aliases = await collectMemberAliasesForSync();
  } catch (e) {
    console.warn("[sync] collectMemberAliasesForSync failed:", e);
  }

  let res: { ok: boolean; status: number; data?: SyncResponse; error?: string };
  try {
    res = await apiFetch<SyncResponse>("/sync", {
      method: "POST",
      body: JSON.stringify({
        last_server_seq: lastServerSeq,
        local_changes: changes,
      } as SyncRequest),
    });
  } catch (e) {
    // 网络异常/超时：apiFetch 会 throw（而非返回 {ok:false}）。此时 pendingChanges 已在上面清空，
    // 必须回队变更并标记失败，否则变更从队列丢失且 UI 误报「已同步」。
    console.warn("[sync] performSync network error:", e);
    mergeChanges(pendingChanges, changes);
    await markSyncResult(false);
    scheduleRetry();
    return false;
  }

  if (!res.ok || !res.data) {
    console.warn("[sync] performSync failed:", res.status, res.error);
    mergeChanges(pendingChanges, changes);
    await markSyncResult(false)
    scheduleRetry();
    return false;
  }

  try {
    await applyRemoteChanges(res.data.remote_changes, db, uid);
  } catch (e) {
    console.warn("[sync] applyRemoteChanges failed:", e);
    await markSyncResult(false);
    scheduleRetry();
    return false;
  }
  setLastSyncedAtFor(uid, String(res.data.server_seq));
  setLastSyncedTimeFor(uid, new Date().toISOString());

  // 通知 TransactionList 刷新
  const { useAuthStore } = await import("@/stores/auth");
  useAuthStore().notifySyncComplete();
  retryAttempt = 0;
  await markSyncResult(true)
  return true;
}

// 把同步结果同步到 auth store，供 UI 显示「同步失败」而非误报「已同步」。
// 动态 import 避免与 auth.ts 顶层循环依赖。
async function markSyncResult(ok: boolean): Promise<void> {
  try {
    const { useAuthStore } = await import("@/stores/auth");
    useAuthStore().lastSyncFailed = !ok;
  } catch {
    // auth store 尚未初始化，忽略
  }
}

/**
 * Apply remote changes to local SQLite (LWW merge)
 */
export async function applyRemoteChanges(remote: SyncPayload, db: Database | null = getUserDb(), uid: string | null = getCurrentUserId()): Promise<void> {
  if (!db) return;

  for (const ledger of (remote.ledgers || [])) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM ledgers WHERE id = ?",
      [ledger.id]
    );
    if (local.length === 0) {
      await db.execute(
        `INSERT INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ledger.id, ledger.name, ledger.type, ledger.owner_id ?? null, ledger.team_id ?? null,
         ledger.created_at, ledger.updated_at, ledger.is_deleted ? 1 : 0]
      );
    } else if (compareTimestamp(ledger.updated_at, local[0].updated_at) > 0) {
      await db.execute(
        `UPDATE ledgers SET name=?, type=?, owner_id=?, team_id=?, updated_at=?, is_deleted=? WHERE id=?`,
        [ledger.name, ledger.type, ledger.owner_id ?? null, ledger.team_id ?? null,
         ledger.updated_at, ledger.is_deleted ? 1 : 0, ledger.id]
      );
    }
  }

  for (const account of (remote.accounts || [])) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM accounts WHERE id = ?",
      [account.id]
    );
    if (local.length === 0) {
      await db.execute(
        `INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [account.id, account.ledger_id, account.owner_id, account.name, account.type,
         account.category, account.initial_balance, account.credit_limit, account.repayment_day,
         account.color, account.created_at, account.updated_at, account.is_deleted ? 1 : 0]
      );
    } else if (compareTimestamp(account.updated_at, local[0].updated_at) > 0) {
      await db.execute(
        `UPDATE accounts SET name=?, type=?, category=?, initial_balance=?, credit_limit=?, repayment_day=?, color=?, updated_at=?, is_deleted=? WHERE id=?`,
        [account.name, account.type, account.category, account.initial_balance, account.credit_limit,
         account.repayment_day, account.color, account.updated_at, account.is_deleted ? 1 : 0, account.id]
      );
    }
  }

  for (const tag of (remote.tags || [])) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM tags WHERE id = ?", [tag.id]
    );
    if (local.length === 0) {
      // 检查本地是否已有同名同账本标签（清数据重绑会产生不同 UUID）
      const dup = await db.select<{ id: string }[]>(
        "SELECT id FROM tags WHERE ledger_id = ? AND name = ? AND is_deleted = 0 LIMIT 1",
        [tag.ledger_id, tag.name]
      );
      if (dup.length > 0) {
        // 替换本地重复标签：把关联改指新 id，删除旧标签
        await db.execute("UPDATE transaction_tags SET tag_id = ? WHERE tag_id = ?", [tag.id, dup[0].id]);
        await db.execute("DELETE FROM tags WHERE id = ?", [dup[0].id]);
      }
      await db.execute(
        "INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?)",
        [tag.id, tag.ledger_id, tag.name, tag.updated_at, tag.is_deleted ? 1 : 0]
      );
    } else if (compareTimestamp(tag.updated_at, local[0].updated_at) > 0) {
      await db.execute(
        "UPDATE tags SET name=?, updated_at=?, is_deleted=? WHERE id=?",
        [tag.name, tag.updated_at, tag.is_deleted ? 1 : 0, tag.id]
      );
    }
  }

  for (const cat of (remote.categories || [])) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM categories WHERE id = ?", [cat.id]
    );
    if (local.length === 0) {
      // 检查本地是否已有同名同类型分类（清数据重绑会产生不同 UUID）
      const dup = await db.select<{ id: string }[]>(
        "SELECT id FROM categories WHERE ledger_id = ? AND name = ? AND type = ? AND is_deleted = 0 LIMIT 1",
        [cat.ledger_id, cat.name, cat.type]
      );
      if (dup.length > 0) {
        // 替换本地重复分类，更新关联交易的 category_id
        await db.execute("UPDATE transactions SET category_id = ? WHERE category_id = ?", [cat.id, dup[0].id]);
        await db.execute("DELETE FROM categories WHERE id = ?", [dup[0].id]);
      }
      await db.execute(
        "INSERT INTO categories (id, ledger_id, owner_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [cat.id, cat.ledger_id, cat.owner_id, cat.name, cat.type, cat.icon, cat.sort_order, cat.updated_at, cat.is_deleted ? 1 : 0]
      );
    } else if (compareTimestamp(cat.updated_at, local[0].updated_at) > 0) {
      await db.execute(
        "UPDATE categories SET name=?, type=?, icon=?, sort_order=?, updated_at=?, is_deleted=? WHERE id=?",
        [cat.name, cat.type, cat.icon, cat.sort_order, cat.updated_at, cat.is_deleted ? 1 : 0, cat.id]
      );
    }
  }

  for (const tx of (remote.transactions || [])) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM transactions WHERE id = ?", [tx.id]
    );
    const shouldInsert = local.length === 0;
    const shouldUpdate = !shouldInsert && compareTimestamp(tx.updated_at, local[0].updated_at) > 0;

    if (shouldInsert) {
      await db.execute(
        `INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tx.id, tx.ledger_id, tx.user_id, tx.amount, tx.type, tx.from_account_id, tx.to_account_id,
         tx.category_id, tx.note ?? null, tx.occurred_at, tx.created_at, tx.updated_at, tx.is_deleted ? 1 : 0]
      );
    } else if (shouldUpdate) {
      await db.execute(
        `UPDATE transactions SET amount=?, type=?, from_account_id=?, to_account_id=?, category_id=?, note=?, occurred_at=?, updated_at=?, is_deleted=? WHERE id=?`,
        [tx.amount, tx.type, tx.from_account_id, tx.to_account_id, tx.category_id, tx.note ?? null,
         tx.occurred_at, tx.updated_at, tx.is_deleted ? 1 : 0, tx.id]
      );
    }

    // 标签重建仅在「插入」或「本地更旧被覆盖」时进行（遵循 LWW）；远端更旧时跳过，
    // 避免旧标签回滚本地较新的标签改动。tag_ids 缺失（后端 omitempty 空数组）视作空，用于清空。
    if (shouldInsert || shouldUpdate) {
      await db.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [tx.id]);
      for (const tagID of tx.tag_ids ?? []) {
        await db.execute(
          "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [tx.id, tagID]
        );
      }
    }
  }

  // member_aliases：本地 userDb 只存"我设的"别名（去 setter 列），
  // 服务端 payload 带 setter_user_id 标识，apply 时过滤 setter=me 再写本地。
  // 必须与 collectMemberAliasesForSync 的 setter 取值一致（优先 server_user_id），
  // 否则上传用 server_user_id、下载用本地 user.id，两者不等会把别名全跳过。
  const myUserId = (await authServerUserId()) || uid || "";
  for (const alias of (remote.member_aliases || [])) {
    if (alias.setter_user_id !== myUserId) continue;
    const { getMemberAlias, setMemberAlias } = await import("@/db/userDb");
    const local = await getMemberAlias(alias.target_user_id);
    if (!local || alias.updated_at > local.updated_at) {
      await setMemberAlias(alias.target_user_id, alias.alias_name);
      // ponytail: setMemberAlias 内部用 datetime('now')，与服务端 updated_at 对齐误差可接受
    }
  }
}

// 获取在线模式下的服务端 user id（别名 setter 以服务端 id 为准）。
// 动态 import 避免与 auth.ts 顶层循环依赖（auth.ts import sync.ts）。
async function authServerUserId(): Promise<string | null> {
  const { useAuthStore } = await import("@/stores/auth");
  try {
    return useAuthStore().currentLocalUser?.server_user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * 收集本地 userDb 的所有别名，补上 setter_user_id，供 sync 推送。
 * 调用方在 enqueueSync 前调用，把结果放进 member_aliases。
 */
export async function collectMemberAliasesForSync(): Promise<MemberAliasPayload[]> {
  const { getMemberAliases } = await import("@/db/userDb");
  const aliases = await getMemberAliases();
  const setter = (await authServerUserId()) || getCurrentUserId() || "";
  return aliases.map((a) => ({
    setter_user_id: setter,
    target_user_id: a.target_user_id,
    alias_name: a.alias_name,
    updated_at: toIsoTimestamp(a.updated_at),
  }));
}

// SQLite 的 datetime('now') 产出 "YYYY-MM-DD HH:MM:SS"（UTC），非 RFC3339，
// Go time.Time 无法解析会让整个 /sync 请求体被拒（400 invalid request body）。
// 统一归一化为 ISO（带 Z）；已经是 ISO 的原样返回。
export function toIsoTimestamp(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(v);
  if (m) return `${m[1]}T${m[2]}${m[3] ?? ""}Z`;
  return v;
}

// 归一化后按 epoch 毫秒比较，消除 " " vs "T" 字典序误判与毫秒位差异。
export function compareTimestamp(a: string, b: string): number {
  return new Date(toIsoTimestamp(a)).getTime() - new Date(toIsoTimestamp(b)).getTime();
}
