// src/db/meta.ts
import Database from '@tauri-apps/plugin-sql'

let metaDb: Database | null = null

export async function getMetaDb(): Promise<Database> {
  if (!metaDb) {
    metaDb = await Database.load('sqlite:_meta.db')
    await initMetaTables()
  }
  return metaDb
}

async function initMetaTables(): Promise<void> {
  const db = metaDb!
  await db.execute(`
    CREATE TABLE IF NOT EXISTS local_users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      api_url TEXT,
      server_user_id TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)
  // 迁移：旧表补充 avatar_url 列
  const info = await db.select<{ name: string }[]>("PRAGMA table_info(local_users)")
  if (!info.some(col => col.name === 'avatar_url')) {
    await db.execute("ALTER TABLE local_users ADD COLUMN avatar_url TEXT")
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS member_aliases (
      setter_user_id TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      alias_name TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (setter_user_id, target_user_id)
    )
  `)
}

export interface LocalUser {
  id: string
  nickname: string
  password_hash: string
  api_url: string | null
  server_user_id: string | null
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export async function updateLocalUserProfile(
  id: string,
  nickname: string,
  avatarUrl: string | null
): Promise<void> {
  const db = await getMetaDb()
  await db.execute(
    `UPDATE local_users SET nickname = $1, avatar_url = $2, updated_at = datetime('now') WHERE id = $3`,
    [nickname, avatarUrl, id]
  )
}

export async function getLocalUsers(): Promise<LocalUser[]> {
  const db = await getMetaDb()
  return db.select<LocalUser[]>(
    'SELECT id, nickname, password_hash, api_url, server_user_id, avatar_url, created_at, updated_at FROM local_users ORDER BY created_at ASC'
  )
}

export async function getLocalUser(id: string): Promise<LocalUser | null> {
  const db = await getMetaDb()
  const rows = await db.select<LocalUser[]>(
    'SELECT id, nickname, password_hash, api_url, server_user_id, avatar_url, created_at, updated_at FROM local_users WHERE id = $1',
    [id]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function getLocalUserByNickname(nickname: string): Promise<LocalUser | null> {
  const db = await getMetaDb()
  const rows = await db.select<LocalUser[]>(
    'SELECT id, nickname, password_hash, api_url, server_user_id, avatar_url, created_at, updated_at FROM local_users WHERE nickname = $1',
    [nickname]
  )
  return rows.length > 0 ? rows[0] : null
}

export async function createLocalUser(
  id: string,
  nickname: string,
  passwordHash: string
): Promise<void> {
  const db = await getMetaDb()
  await db.execute(
    `INSERT INTO local_users (id, nickname, password_hash) VALUES ($1, $2, $3)`,
    [id, nickname, passwordHash]
  )
}

export async function updateLocalUserBinding(
  id: string,
  apiUrl: string,
  serverUserId: string
): Promise<void> {
  const db = await getMetaDb()
  await db.execute(
    `UPDATE local_users SET api_url = $1, server_user_id = $2, updated_at = datetime('now') WHERE id = $3`,
    [apiUrl, serverUserId, id]
  )
}

export interface MemberAlias {
  setter_user_id: string;
  target_user_id: string;
  alias_name: string;
  updated_at: string;
}

export async function getMemberAliases(): Promise<MemberAlias[]> {
  const db = await getMetaDb();
  return db.select<MemberAlias[]>(
    'SELECT setter_user_id, target_user_id, alias_name, updated_at FROM member_aliases'
  );
}

export async function setMemberAlias(
  setterUserId: string,
  targetUserId: string,
  aliasName: string
): Promise<void> {
  const db = await getMetaDb();
  await db.execute(
    `INSERT OR REPLACE INTO member_aliases (setter_user_id, target_user_id, alias_name, updated_at)
     VALUES ($1, $2, $3, datetime('now'))`,
    [setterUserId, targetUserId, aliasName]
  );
}

export function closeMetaDb(): void {
  metaDb = null
}
