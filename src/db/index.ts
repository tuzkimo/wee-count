import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;
let dbPromise: Promise<Database> | null = null;

export async function getDb(): Promise<Database> {
  if (db) return db;
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:wee-count.db").then(async (database) => {
      await initTables(database);
      await migrateAccounts(database);
      await migrateTransactions(database);
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
      category TEXT NOT NULL DEFAULT 'asset',
      initial_balance REAL NOT NULL DEFAULT 0.00,
      credit_limit REAL,
      repayment_day INTEGER,
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

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      ledger_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      ledger_id TEXT NOT NULL,
      name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_deleted INTEGER DEFAULT 0,
      UNIQUE(ledger_id, name)
    );

    CREATE TABLE IF NOT EXISTS transaction_tags (
      transaction_id TEXT REFERENCES transactions(id) ON DELETE CASCADE,
      tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (transaction_id, tag_id)
    );
  `);
}

async function migrateAccounts(db: Database): Promise<void> {
  const tableInfo = await db.select<{ name: string }[]>(
    "PRAGMA table_info(accounts)"
  );
  const columns = new Set(tableInfo.map((col) => col.name));

  if (!columns.has("category")) {
    await db.execute("ALTER TABLE accounts ADD COLUMN category TEXT NOT NULL DEFAULT 'asset'");
  }
  if (!columns.has("credit_limit")) {
    await db.execute("ALTER TABLE accounts ADD COLUMN credit_limit REAL");
  }
  if (!columns.has("repayment_day")) {
    await db.execute("ALTER TABLE accounts ADD COLUMN repayment_day INTEGER");
  }
}

async function migrateTransactions(db: Database): Promise<void> {
  const tableInfo = await db.select<{ name: string }[]>(
    "PRAGMA table_info(transactions)"
  );
  const columns = new Set(tableInfo.map((col) => col.name));

  if (!columns.has("category_id")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(id)");
  }
  if (!columns.has("user_id")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local-user-1' REFERENCES users(id)");
  }
  if (!columns.has("occurred_at")) {
    await db.execute("ALTER TABLE transactions ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''");
    // 将原有 transacted_at 数据复制到 occurred_at
    await db.execute("UPDATE transactions SET occurred_at = transacted_at WHERE occurred_at = ''");
  }
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

  const existingCategories = await database.select<{ count: number }[]>(
    "SELECT COUNT(*) as count FROM categories"
  );
  if (existingCategories[0].count === 0) {
    const now = new Date().toISOString();
    const categories = [
      ["餐饮", "expense", "🍜", 1],
      ["交通", "expense", "🚌", 2],
      ["购物", "expense", "🛒", 3],
      ["娱乐", "expense", "🎮", 4],
      ["居家", "expense", "🏠", 5],
      ["通讯", "expense", "📱", 6],
      ["医疗", "expense", "💊", 7],
      ["其他支出", "expense", "💸", 99],
      ["工资", "income", "💰", 1],
      ["奖金", "income", "🎁", 2],
      ["理财", "income", "📈", 3],
      ["退款", "income", "↩️", 4],
      ["报销", "income", "🧾", 5],
      ["其他收入", "income", "📥", 99],
    ];
    for (const [name, type, icon, sortOrder] of categories) {
      await database.execute(
        "INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [crypto.randomUUID(), null, name, type, icon, sortOrder, now]
      );
    }
  }
}
