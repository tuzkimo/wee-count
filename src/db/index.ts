import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;
let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:wee-count.db").then(async (database) => {
      await initTables(database);
      db = database;
      return database;
    });
  }
  return dbPromise;
}

async function initTables(db: Database): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      nickname TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledgers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'personal',
      team_id TEXT,
      owner_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      ledger_id TEXT REFERENCES ledgers(id) NOT NULL,
      owner_id TEXT REFERENCES users(id) NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'bank',
      initial_balance REAL NOT NULL DEFAULT 0.00,
      color TEXT DEFAULT '#3b82f6',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      ledger_id TEXT REFERENCES ledgers(id) NOT NULL,
      from_account_id TEXT REFERENCES accounts(id),
      to_account_id TEXT REFERENCES accounts(id),
      amount REAL NOT NULL DEFAULT 0.00,
      type TEXT NOT NULL DEFAULT 'expense',
      category TEXT,
      note TEXT,
      transacted_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );
  `);
}

export async function ensureDefaultData(): Promise<void> {
  const database = await getDb();

  const existingUsers = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM users"
  );
  if (existingUsers[0].count === 0) {
    const now = new Date().toISOString();
    await database.execute(
      "INSERT INTO users (id, nickname, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["local-user-1", "我", "local@wee-count.app", now, now]
    );
  }

  const existingLedgers = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM ledgers"
  );
  if (existingLedgers[0].count === 0) {
    const now = new Date().toISOString();
    await database.execute(
      "INSERT INTO ledgers (id, name, type, team_id, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["personal-ledger-1", "个人账本", "personal", null, "local-user-1", now, now]
    );
  }
}
