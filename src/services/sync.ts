// src/services/sync.ts
import { apiFetch } from "./api";
import { getUserDb } from "@/db/userDb";
import type { Account, Transaction, Category, Tag } from "@/types";

interface SyncPayload {
  accounts: Account[];
  tags: Tag[];
  categories: Category[];
  transactions: Transaction[];
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
  accounts: [],
  tags: [],
  categories: [],
  transactions: [],
};

export function getLastSyncedAt(): string | null {
  return localStorage.getItem("last_synced_at");
}

export function setLastSyncedAt(time: string): void {
  localStorage.setItem("last_synced_at", time);
}

/**
 * Enqueue local changes into sync queue, debounced 3 seconds
 */
export function enqueueSync(changes: SyncPayload): void {
  mergeChanges(pendingChanges, changes);

  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    performSync();
  }, 3000);
}

function mergeChanges(target: SyncPayload, source: SyncPayload): void {
  for (const key of ["accounts", "tags", "categories", "transactions"] as const) {
    const targetArr = target[key] as Array<{ id: string; updated_at: string }>;
    const sourceArr = source[key] as Array<{ id: string; updated_at: string }>;
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
  const lastSyncedAt = getLastSyncedAt() || "1970-01-01T00:00:00Z";

  const changes = { ...pendingChanges };
  pendingChanges = { accounts: [], tags: [], categories: [], transactions: [] };

  const res = await apiFetch<SyncResponse>("/sync", {
    method: "POST",
    body: JSON.stringify({
      last_synced_at: lastSyncedAt,
      local_changes: changes,
    } as SyncRequest),
  });

  if (!res.ok || !res.data) {
    mergeChanges(pendingChanges, changes);
    return;
  }

  await applyRemoteChanges(res.data.remote_changes);
  setLastSyncedAt(res.data.server_time);
}

/**
 * Apply remote changes to local SQLite (LWW merge)
 */
async function applyRemoteChanges(remote: SyncPayload): Promise<void> {
  const db = getUserDb();
  if (!db) return;

  for (const account of remote.accounts) {
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

  for (const tag of remote.tags) {
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

  for (const cat of remote.categories) {
    const local = await db.select<{ updated_at: string }[]>(
      "SELECT updated_at FROM categories WHERE id = ?", [cat.id]
    );
    if (local.length === 0) {
      await db.execute(
        "INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [cat.id, cat.ledger_id, cat.name, cat.type, cat.icon, cat.sort_order, cat.updated_at, cat.is_deleted ? 1 : 0]
      );
    } else if (cat.updated_at > local[0].updated_at) {
      await db.execute(
        "UPDATE categories SET name=?, type=?, icon=?, sort_order=?, updated_at=?, is_deleted=? WHERE id=?",
        [cat.name, cat.type, cat.icon, cat.sort_order, cat.updated_at, cat.is_deleted ? 1 : 0, cat.id]
      );
    }
  }

  for (const tx of remote.transactions) {
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
}
