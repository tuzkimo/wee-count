// src/services/migration.ts
import { getUserDb } from '@/db/userDb'
import { apiFetch } from '@/services/api'
import { toIsoTimestamp } from '@/services/sync'

// 将本地数据迁移到新的 server_ledger_id
export async function migrateLocalDataToServer(
  serverLedgerId: string,
  serverUserId: string
): Promise<void> {
  const db = getUserDb()
  if (!db) return // ponytail: no local session, nothing to migrate
  // 外键约束要求先有父行再改子行，因此用"插入新行 → 更新子表 → 删除旧行"三步走
  const oldRows = await db.select<{ id: string; name: string; type: string; owner_id: string; team_id: string | null; created_at: string; updated_at: string; is_deleted: number }[]>(
    'SELECT * FROM ledgers WHERE is_deleted = 0 LIMIT 1'
  )
  if (oldRows.length === 0) return

  const oldLedgerId = oldRows[0].id
  const oldOwnerId = oldRows[0].owner_id

  // 重新绑定同一账号时，本地账本 ID 已是服务端 ID，跳过迁移
  if (oldLedgerId === serverLedgerId) {
    await db.execute('UPDATE accounts SET owner_id = $1 WHERE ledger_id = $2', [serverUserId, serverLedgerId])
    await db.execute(
      'UPDATE transactions SET user_id = $1 WHERE user_id = $2',
      [serverUserId, oldOwnerId]
    )
    return
  }

  // 1. 插入服务端 ID 的新行，owner_id 用服务端用户 ID
  await db.execute(
    `INSERT INTO ledgers (id, name, type, owner_id, team_id, created_at, updated_at, is_deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [serverLedgerId, oldRows[0].name, oldRows[0].type, serverUserId, oldRows[0].team_id, oldRows[0].created_at, oldRows[0].updated_at, oldRows[0].is_deleted]
  )

  // 2. 更新所有子表的 ledger_id
  const tables = ['accounts', 'categories', 'tags', 'transactions']
  for (const table of tables) {
    await db.execute(
      `UPDATE ${table} SET ledger_id = $1 WHERE ledger_id = $2`,
      [serverLedgerId, oldLedgerId]
    )
  }

  // 3. 删除旧账本行（已经没有子行引用它）
  await db.execute('DELETE FROM ledgers WHERE id = $1', [oldLedgerId])

  // 4. 更新所有 owner_id / user_id 为服务端用户 ID
  await db.execute('UPDATE accounts SET owner_id = $1 WHERE ledger_id = $2', [serverUserId, serverLedgerId])
  await db.execute('UPDATE categories SET owner_id = $1 WHERE ledger_id = $2', [serverUserId, serverLedgerId])
  await db.execute(
    'UPDATE transactions SET user_id = $1 WHERE user_id = $2',
    [serverUserId, oldOwnerId]
  )
}

// 首次全量上传
function normalizeTimestamps(r: Record<string, unknown>): Record<string, unknown> {
  const out = { ...r };
  for (const k of ["created_at", "updated_at", "occurred_at"] as const) {
    const v = out[k];
    if (typeof v === "string") out[k] = toIsoTimestamp(v);
  }
  return out;
}

export async function firstFullSync(): Promise<void> {
  const db = getUserDb()
  if (!db) return // ponytail: no local session, nothing to sync
  const rawLedgers = await db.select<Record<string, unknown>[]>('SELECT * FROM ledgers WHERE is_deleted = 0')
  const rawAccounts = await db.select<Record<string, unknown>[]>('SELECT * FROM accounts WHERE is_deleted = 0')
  const rawCategories = await db.select<Record<string, unknown>[]>('SELECT * FROM categories WHERE is_deleted = 0')
  const rawTags = await db.select<Record<string, unknown>[]>('SELECT * FROM tags WHERE is_deleted = 0')
  const rawTransactions = await db.select<Record<string, unknown>[]>('SELECT * FROM transactions WHERE is_deleted = 0')

  // 查询 transaction_tags，按 transaction_id 分组
  const tagRows = await db.select<{ transaction_id: string; tag_id: string }[]>(
    `SELECT tg.transaction_id, tg.tag_id
     FROM transaction_tags tg
     JOIN transactions t ON t.id = tg.transaction_id
     WHERE t.is_deleted = 0`
  )
  const tagMap: Record<string, string[]> = {}
  for (const row of tagRows) {
    if (!tagMap[row.transaction_id]) tagMap[row.transaction_id] = []
    tagMap[row.transaction_id].push(row.tag_id)
  }

  // SQLite 中 is_deleted 存的是 INTEGER 0/1，后端期望 bool
  const toBool = (v: unknown): boolean => v === 1 || v === true
  const ledgers = rawLedgers.map(r => ({ ...normalizeTimestamps(r), is_deleted: toBool(r.is_deleted) }))
  const accounts = rawAccounts.map(r => ({ ...normalizeTimestamps(r), is_deleted: toBool(r.is_deleted) }))
  const categories = rawCategories.map(r => ({ ...normalizeTimestamps(r), is_deleted: toBool(r.is_deleted) }))
  const tags = rawTags.map(r => ({ ...normalizeTimestamps(r), is_deleted: toBool(r.is_deleted) }))
  const transactions = rawTransactions.map(r => ({
    ...normalizeTimestamps(r),
    is_deleted: toBool(r.is_deleted),
    tag_ids: tagMap[r.id as string] ?? [],
  }))

  const resp = await apiFetch<{ server_seq: number; remote_changes: { ledgers: unknown[]; accounts: unknown[]; tags: unknown[]; categories: unknown[]; transactions: unknown[] } }>('/sync', {
    method: 'POST',
    body: JSON.stringify({
      last_server_seq: 0,
      local_changes: {
        ledgers,
        accounts,
        categories,
        tags,
        transactions,
      },
    }),
  })

  if (!resp.ok) {
    throw new Error(resp.error || '首次同步失败')
  }

  // 应用服务端返回的远程变更
  if (resp.data?.remote_changes) {
    const { applyRemoteChanges } = await import('@/services/sync')
    await applyRemoteChanges(resp.data.remote_changes as import('@/services/sync').SyncPayload)
    const { setLastSyncedAt, setLastSyncedTimeNow } = await import('@/services/sync')
    setLastSyncedAt(String(resp.data.server_seq))
    setLastSyncedTimeNow()
  }

  // 通知 TransactionList 刷新
  const { useAuthStore } = await import("@/stores/auth");
  useAuthStore().notifySyncComplete();
}
