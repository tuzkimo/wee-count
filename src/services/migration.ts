// src/services/migration.ts
import { getUserDb } from '@/db/userDb'
import { apiFetch } from '@/services/api'

// 将本地数据迁移到新的 server_ledger_id
export async function migrateLocalDataToServer(
  serverLedgerId: string,
  serverUserId: string
): Promise<void> {
  const db = getUserDb()
  if (!db) throw new Error('User DB not opened')

  // 更新本地 ledger id 为服务端 id
  const ledgers = await db.select<{ id: string }[]>(
    'SELECT id FROM ledgers WHERE is_deleted = 0 LIMIT 1'
  )
  if (ledgers.length === 0) return

  const oldLedgerId = ledgers[0].id

  // 更新各表的 ledger_id
  const tables = ['accounts', 'categories', 'tags', 'transactions']
  for (const table of tables) {
    await db.execute(
      `UPDATE ${table} SET ledger_id = $1 WHERE ledger_id = $2`,
      [serverLedgerId, oldLedgerId]
    )
  }

  // 更新 ledgers 表
  await db.execute(
    `UPDATE ledgers SET id = $1 WHERE id = $2`,
    [serverLedgerId, oldLedgerId]
  )

  // 更新 transactions 的 user_id
  await db.execute(
    `UPDATE transactions SET user_id = $1 WHERE user_id = (
      SELECT owner_id FROM ledgers WHERE id = $2 LIMIT 1
    )`,
    [serverUserId, serverLedgerId]
  )
}

// 首次全量上传
export async function firstFullSync(): Promise<void> {
  const db = getUserDb()
  if (!db) throw new Error('User DB not opened')

  // 拉取所有本地数据
  const accounts = await db.select('SELECT * FROM accounts WHERE is_deleted = 0')
  const categories = await db.select('SELECT * FROM categories WHERE is_deleted = 0')
  const tags = await db.select('SELECT * FROM tags WHERE is_deleted = 0')
  const transactions = await db.select('SELECT * FROM transactions WHERE is_deleted = 0')

  // 以本地数据为准，全量推送到服务端
  await apiFetch('/sync', {
    method: 'POST',
    body: JSON.stringify({
      last_synced_at: '1970-01-01T00:00:00Z',
      local_changes: {
        accounts,
        categories,
        tags,
        transactions,
      },
    }),
  })
}
