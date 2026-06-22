// src/db/userDb.ts
import Database from '@tauri-apps/plugin-sql'
import { DEFAULT_CATEGORIES } from './defaults'

// 当前活跃用户的 db 连接
let userDb: Database | null = null
let currentUserId: string | null = null

export function getCurrentUserId(): string | null {
  return currentUserId
}

export function getUserDb(): Database | null {
  return userDb
}

export async function openUserDb(userId: string): Promise<Database> {
  if (userDb && currentUserId === userId) {
    return userDb
  }
  // 关闭旧连接
  userDb = null

  const db = await Database.load(`sqlite:${userId}.db`)
  await initUserTables(db)

  // 确保默认数据存在
  await ensureUserDefaults(db, userId)

  userDb = db
  currentUserId = userId
  return db
}

async function initUserTables(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'personal',
      owner_id TEXT,
      team_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'cash',
      category TEXT NOT NULL DEFAULT 'asset',
      initial_balance REAL NOT NULL DEFAULT 0,
      credit_limit REAL,
      repayment_day INTEGER,
      color TEXT DEFAULT '#3b82f6',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0,
      UNIQUE(ledger_id, name)
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL REFERENCES ledgers(id),
      user_id TEXT NOT NULL,
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      from_account_id TEXT REFERENCES accounts(id),
      to_account_id TEXT REFERENCES accounts(id),
      category_id TEXT REFERENCES categories(id),
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      is_deleted INTEGER DEFAULT 0
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (transaction_id, tag_id)
    )
  `)

  // 迁移：确保旧表有新增的列
  await migrateUserTables(db)
}

async function migrateUserTables(db: Database): Promise<void> {
  // accounts 表迁移
  const accInfo = await db.select<{ name: string }[]>(
    "PRAGMA table_info(accounts)"
  )
  const accCols = new Set(accInfo.map((col) => col.name))
  if (!accCols.has("category")) {
    await db.execute("ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT 'asset'")
  }
  if (!accCols.has("credit_limit")) {
    await db.execute("ALTER TABLE accounts ADD COLUMN credit_limit REAL")
  }
  if (!accCols.has("repayment_day")) {
    await db.execute("ALTER TABLE accounts ADD COLUMN repayment_day INTEGER")
  }

  // transactions 表迁移
  const txInfo = await db.select<{ name: string }[]>(
    "PRAGMA table_info(transactions)"
  )
  const txCols = new Set(txInfo.map((col) => col.name))
  if (!txCols.has("category_id")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(id)")
  }
  if (!txCols.has("user_id")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-user' REFERENCES ledgers(owner_id)")
  }
  if (!txCols.has("occurred_at")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''")
    await db.execute("UPDATE transactions SET occurred_at = transacted_at WHERE occurred_at = ''")
  }
}

async function ensureUserDefaults(db: Database, userId: string): Promise<void> {
  // 检查是否已有账本
  const ledgers = await db.select<{ count: number }[]>(
    'SELECT COUNT(*) as count FROM ledgers'
  )
  const count = ledgers[0]?.count ?? 0
  if (count > 0) return

  const ledgerId = crypto.randomUUID()
  const now = new Date().toISOString()

  // 创建默认个人账本
  await db.execute(
    `INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
     VALUES ($1, $2, 'personal', $3, $4, $5)`,
    [ledgerId, '个人账本', userId, now, now]
  )

  // 拷贝默认分类
  for (const c of DEFAULT_CATEGORIES) {
    await db.execute(
      `INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), ledgerId, c.name, c.type, c.icon, c.sortOrder, now]
    )
  }
}

export function closeUserDb(): void {
  userDb = null
  currentUserId = null
}
