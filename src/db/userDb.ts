// src/db/userDb.ts
import Database from '@tauri-apps/plugin-sql'

// 当前活跃用户的 db 连接
let userDb: Database | null = null
let currentUserId: string | null = null

export function getCurrentUserId(): string | null {
  return currentUserId
}

export function getUserDb(): Database | null {
  return userDb
}

export async function openUserDb(userId: string, nickname?: string): Promise<Database> {
  if (userDb && currentUserId === userId) {
    return userDb
  }
  // 关闭旧连接
  userDb = null

  const db = await Database.load(`sqlite:${userId}.db`)
  await initUserTables(db)

  // 确保默认数据存在
  await ensureUserDefaults(db, userId, nickname)

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
      owner_id TEXT NOT NULL,
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
      note TEXT,
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

  await db.execute(`
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      nickname TEXT,
      avatar_url TEXT,
      role TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (team_id, user_id)
    )
  `)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_aliases (
      target_user_id TEXT PRIMARY KEY,
      alias_name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  if (!txCols.has("note")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN note TEXT")
  }
}

async function ensureUserDefaults(db: Database, userId: string, nickname?: string): Promise<void> {
  // 检查是否已有账本
  const ledgers = await db.select<{ count: number }[]>(
    'SELECT COUNT(*) as count FROM ledgers'
  )
  const count = ledgers[0]?.count ?? 0
  if (count > 0) return

  const ledgerId = crypto.randomUUID()
  const now = new Date().toISOString()
  const ledgerName = nickname ? `${nickname}的账本` : '我的账本'

  await db.execute(
    `INSERT INTO ledgers (id, name, type, owner_id, created_at, updated_at)
     VALUES ($1, $2, 'personal', $3, $4, $5)`,
    [ledgerId, ledgerName, userId, now, now]
  )
}

// --- team members 缓存（从 GET /teams/{id}/members 拉取，按本地用户隔离在 userDb） ---
export interface TeamMemberRow {
  team_id: string
  user_id: string
  username: string | null
  nickname: string | null
  avatar_url: string | null
  role: string | null
  updated_at: string
}

export async function upsertTeamMembers(teamId: string, members: { user_id: string; username: string; nickname: string; avatar_url: string | null; role: string }[]): Promise<void> {
  const db = getUserDb()
  if (!db) return
  const now = new Date().toISOString()
  for (const m of members) {
    await db.execute(
      `INSERT OR REPLACE INTO team_members (team_id, user_id, username, nickname, avatar_url, role, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [teamId, m.user_id, m.username, m.nickname, m.avatar_url, m.role, now]
    )
  }
}

export async function getTeamMembers(teamId: string): Promise<TeamMemberRow[]> {
  const db = getUserDb()
  if (!db) return []
  return db.select<TeamMemberRow[]>(
    'SELECT team_id, user_id, username, nickname, avatar_url, role, updated_at FROM team_members WHERE team_id = $1',
    [teamId]
  )
}

// --- member aliases（userDb，去 setter 列；userDb 主人即唯一 setter） ---
export interface MemberAliasRow {
  target_user_id: string
  alias_name: string
  updated_at: string
}

export async function getMemberAliases(): Promise<MemberAliasRow[]> {
  const db = getUserDb()
  if (!db) return []
  return db.select<MemberAliasRow[]>(
    'SELECT target_user_id, alias_name, updated_at FROM member_aliases'
  )
}

export async function getMemberAlias(targetUserId: string): Promise<MemberAliasRow | null> {
  const db = getUserDb()
  if (!db) return null
  const rows = await db.select<MemberAliasRow[]>(
    'SELECT target_user_id, alias_name, updated_at FROM member_aliases WHERE target_user_id = $1',
    [targetUserId]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function setMemberAlias(targetUserId: string, aliasName: string): Promise<void> {
  const db = getUserDb()
  if (!db) return
  await db.execute(
    `INSERT OR REPLACE INTO member_aliases (target_user_id, alias_name, updated_at)
     VALUES ($1, $2, datetime('now'))`,
    [targetUserId, aliasName]
  )
}

export function closeUserDb(): void {
  userDb = null
  currentUserId = null
}
