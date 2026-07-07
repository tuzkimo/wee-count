// src/services/sync.ts
import { apiFetch, hasBaseUrl } from "./api";
import { getUserDb, getCurrentUserId } from "@/db/userDb";
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
  last_synced_at: string;
  local_changes: SyncPayload;
}

interface SyncResponse {
  server_time: string;
  remote_changes: SyncPayload;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let pendingChanges: SyncPayload = {
  ledgers: [],
  accounts: [],
  tags: [],
  categories: [],
  transactions: [],
  member_aliases: [],
};

// 游标按本地用户隔离：每个用户有独立 SQLite（{userId}.db），各自数据进度不同，
// 不能共享一个 last_synced_at，否则 A 同步推进游标后，B 切回来按新游标增量同步，
// 会跳过 B 本地从未拉取过的数据（团队账本里别人加的数据就是典型场景）。
function cursorKey(): string {
  const uid = getCurrentUserId();
  return uid ? `last_synced_at:${uid}` : "last_synced_at";
}

export function getLastSyncedAt(): string | null {
  return localStorage.getItem(cursorKey());
}

export function setLastSyncedAt(time: string): void {
  localStorage.setItem(cursorKey(), time);
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
    performSync();
  }, 3000);
}

function mergeChanges(target: SyncPayload, source: Partial<SyncPayload>): void {
  for (const key of ["ledgers", "accounts", "tags", "categories", "transactions", "member_aliases"] as const) {
    const targetArr = target[key] as Array<{ id: string; updated_at: string }>;
    const sourceArr = source[key] as Array<{ id: string; updated_at: string }> | undefined;
    if (!sourceArr) continue;
    for (const item of sourceArr) {
      const idx = targetArr.findIndex((t) => t.id === item.id);
      if (idx >= 0) {
        if (item.updated_at > targetArr[idx].updated_at) {
          targetArr[idx] = item;
        }
      } else {
        targetArr.push(item);
      }
    }
  }
}

/**
 * Execute sync: send local changes to server, receive and merge remote changes
 */
export async function performSync(): Promise<void> {
  const lastSyncedAt = getLastSyncedAt();

  // 从未同步成功过，做全量上传
  if (!lastSyncedAt) {
    const { firstFullSync } = await import('./migration')
    try { await firstFullSync() } catch (e) { console.warn('[sync] firstFullSync failed:', e) }
    return
  }

  const changes = { ...pendingChanges };
  pendingChanges = { ledgers: [], accounts: [], tags: [], categories: [], transactions: [], member_aliases: [] };

  // 推送前补充本地 member_aliases（别名变更不经过 pendingChanges 入队，这里全量带）
  try {
    changes.member_aliases = await collectMemberAliasesForSync();
  } catch (e) {
    console.warn("[sync] collectMemberAliasesForSync failed:", e);
  }

  const res = await apiFetch<SyncResponse>("/sync", {
    method: "POST",
    body: JSON.stringify({
      last_synced_at: lastSyncedAt,
      local_changes: changes,
    } as SyncRequest),
  });

  if (!res.ok || !res.data) {
    console.warn("[sync] performSync failed:", res.status, res.error);
    mergeChanges(pendingChanges, changes);
    return;
  }

  await applyRemoteChanges(res.data.remote_changes);
  setLastSyncedAt(res.data.server_time);

  // 通知 TransactionList 刷新
  const { useAuthStore } = await import("@/stores/auth");
  useAuthStore().notifySyncComplete();
}

/**
 * Apply remote changes to local SQLite (LWW merge)
 */
export async function applyRemoteChanges(remote: SyncPayload): Promise<void> {
  const db = getUserDb();
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
    } else if (ledger.updated_at > local[0].updated_at) {
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
    } else if (account.updated_at > local[0].updated_at) {
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
      await db.execute(
        "INSERT INTO tags (id, ledger_id, name, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?)",
        [tag.id, tag.ledger_id, tag.name, tag.updated_at, tag.is_deleted ? 1 : 0]
      );
    } else if (tag.updated_at > local[0].updated_at) {
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
    } else if (cat.updated_at > local[0].updated_at) {
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
    if (local.length === 0) {
      await db.execute(
        `INSERT INTO transactions (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, occurred_at, created_at, updated_at, is_deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [tx.id, tx.ledger_id, tx.user_id, tx.amount, tx.type, tx.from_account_id, tx.to_account_id,
         tx.category_id, tx.occurred_at, tx.created_at, tx.updated_at, tx.is_deleted ? 1 : 0]
      );
    } else if (tx.updated_at > local[0].updated_at) {
      await db.execute(
        `UPDATE transactions SET amount=?, type=?, from_account_id=?, to_account_id=?, category_id=?, occurred_at=?, updated_at=?, is_deleted=? WHERE id=?`,
        [tx.amount, tx.type, tx.from_account_id, tx.to_account_id, tx.category_id, tx.occurred_at,
         tx.updated_at, tx.is_deleted ? 1 : 0, tx.id]
      );
    }

    if (tx.tag_ids) {
      await db.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [tx.id]);
      for (const tagID of tx.tag_ids) {
        await db.execute(
          "INSERT OR IGNORE INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [tx.id, tagID]
        );
      }
    }
  }

  // member_aliases：本地 userDb 只存"我设的"别名（去 setter 列），
  // 服务端 payload 带 setter_user_id 标识，apply 时过滤 setter=me 再写本地
  const myUserId = getCurrentUserId() || (await authServerUserId()) || "";
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
    updated_at: a.updated_at,
  }));
}
