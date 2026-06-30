import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getUserDb } from "@/db/userDb";
import { useAccountStore } from "@/stores/account";
import type { Transaction, TransactionType } from "@/types";
import { enqueueSync } from "@/services/sync";
import { useAuthStore } from "@/stores/auth";


interface TransactionRow {
  id: string;
  ledger_id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  is_deleted: number | boolean;
  category_name: string | null;
  category_type: string | null;
  category_icon: string | null;
  category_sort_order: number | null;
  tag_ids: string | null;
  tag_names: string | null;
  from_account_name: string | null;
  from_account_type: string | null;
  from_account_color: string | null;
  to_account_name: string | null;
  to_account_type: string | null;
  to_account_color: string | null;
}

function assembleTransaction(row: TransactionRow): Transaction {
  const tx: Transaction = {
    id: row.id,
    ledger_id: row.ledger_id,
    user_id: row.user_id,
    amount: row.amount,
    type: row.type,
    from_account_id: row.from_account_id,
    to_account_id: row.to_account_id,
    category_id: row.category_id,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    is_deleted: Boolean(row.is_deleted),
  };

  if (row.category_id && row.category_name) {
    tx.category = {
      id: row.category_id,
      ledger_id: null,
      name: row.category_name,
      type: row.category_type as "income" | "expense",
      icon: row.category_icon,
      sort_order: row.category_sort_order ?? 0,
      updated_at: "",
      is_deleted: false,
    };
  }

  if (row.tag_ids && row.tag_names) {
    const ids = row.tag_ids.split(",");
    const names = row.tag_names.split(",");
    tx.tag_ids = ids;
    tx.tags = ids.map((id, i) => ({ id, name: names[i] ?? "", ledger_id: "", updated_at: "", is_deleted: false }));
  } else {
    tx.tags = [];
  }

  if (row.from_account_id && row.from_account_name) {
    tx.from_account = {
      id: row.from_account_id,
      ledger_id: "",
      owner_id: "",
      name: row.from_account_name,
      type: row.from_account_type as never,
      initial_balance: 0,
      color: row.from_account_color ?? "#3b82f6",
      created_at: "",
      updated_at: "",
      is_deleted: false,
    };
  }

  if (row.to_account_id && row.to_account_name) {
    tx.to_account = {
      id: row.to_account_id,
      ledger_id: "",
      owner_id: "",
      name: row.to_account_name,
      type: row.to_account_type as never,
      initial_balance: 0,
      color: row.to_account_color ?? "#3b82f6",
      created_at: "",
      updated_at: "",
      is_deleted: false,
    };
  }

  return tx;
}

const QUERY = `
  SELECT
    t.id, t.ledger_id, t.user_id, t.amount, t.type,
    t.from_account_id, t.to_account_id, t.category_id,
    t.occurred_at, t.created_at, t.updated_at, t.is_deleted,
    c.name AS category_name, c.type AS category_type, c.icon AS category_icon, c.sort_order AS category_sort_order,
    GROUP_CONCAT(DISTINCT tg.tag_id) AS tag_ids,
    GROUP_CONCAT(DISTINCT tags.name) AS tag_names,
    fa.name AS from_account_name, fa.type AS from_account_type, fa.color AS from_account_color,
    ta.name AS to_account_name, ta.type AS to_account_type, ta.color AS to_account_color
  FROM transactions t
  LEFT JOIN categories c ON t.category_id = c.id
  LEFT JOIN transaction_tags tg ON t.id = tg.transaction_id
  LEFT JOIN tags ON tg.tag_id = tags.id AND tags.is_deleted = 0
  LEFT JOIN accounts fa ON t.from_account_id = fa.id
  LEFT JOIN accounts ta ON t.to_account_id = ta.id
  WHERE t.ledger_id = ? AND t.is_deleted = 0
`;

export const useTransactionStore = defineStore("transaction", () => {
  const transactions = ref<Transaction[]>([]);
  let _ledgerId = "";

  const totalIncome = computed(() =>
    transactions.value
      .filter((t) => t.type === "income")
      .reduce((sum, t) => sum + t.amount, 0)
  );

  const totalExpense = computed(() =>
    transactions.value
      .filter((t) => t.type === "expense")
      .reduce((sum, t) => sum + t.amount, 0)
  );

  async function fetchAll(
    ledgerId: string,
    opts?: {
      accountId?: string;
      dateFrom?: string;
      dateTo?: string;
      tagIds?: string[];
      categoryIds?: string[];
      memberIds?: string[];
    }
  ): Promise<void> {
    _ledgerId = ledgerId;
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    let sql = QUERY;
    const params: string[] = [ledgerId];

    if (opts?.accountId) {
      sql += " AND (t.from_account_id = ? OR t.to_account_id = ?)";
      params.push(opts.accountId, opts.accountId);
    }

    if (opts?.dateFrom) {
      // 将用户输入的本地时间转为 UTC，与 DB 中 UTC 存储值比较
      const localStr = opts.dateFrom.includes("T") ? opts.dateFrom : opts.dateFrom + "T00:00:00";
      sql += " AND t.occurred_at >= ?";
      params.push(new Date(localStr).toISOString());
    }

    if (opts?.dateTo) {
      const localStr = opts.dateTo.includes("T") ? opts.dateTo : opts.dateTo + "T00:00:00";
      sql += " AND t.occurred_at < ?";
      params.push(new Date(localStr).toISOString());
    }

    if (opts?.tagIds && opts.tagIds.length > 0) {
      // AND 关系：同时拥有所有选中标签，用多个 IN 子查询取交集
      for (const tagId of opts.tagIds) {
        sql += " AND t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id = ?)";
        params.push(tagId);
      }
    }

    if (opts?.categoryIds && opts.categoryIds.length > 0) {
      const placeholders = opts.categoryIds.map(() => "?").join(",");
      sql += ` AND t.category_id IN (${placeholders})`;
      params.push(...opts.categoryIds);
    }

    if (opts?.memberIds && opts.memberIds.length > 0) {
      const placeholders = opts.memberIds.map(() => "?").join(",");
      sql += ` AND t.user_id IN (${placeholders})`;
      params.push(...opts.memberIds);
    }

    sql += " GROUP BY t.id ORDER BY t.occurred_at DESC, t.created_at DESC";

    const rows = await db.select<TransactionRow[]>(sql, params);
    transactions.value = rows.map(assembleTransaction);
  }

  async function add(data: {
    ledger_id: string;
    user_id: string;
    type: TransactionType;
    amount: number;
    category_id: string | null;
    from_account_id: string | null;
    to_account_id: string | null;
    occurred_at: string;
    tag_ids: string[];
  }): Promise<string> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await db.execute(
      `INSERT INTO transactions (id, ledger_id, user_id, type, amount, category_id, from_account_id, to_account_id, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, data.ledger_id, data.user_id, data.type, data.amount, data.category_id,
        data.from_account_id, data.to_account_id, data.occurred_at, now, now,
      ]
    );

    if (data.tag_ids.length > 0) {
      for (const tagId of data.tag_ids) {
        await db.execute(
          "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [id, tagId]
        );
      }
    }

    await fetchAll(data.ledger_id);
    // 刷新账户余额
    const accountStore = useAccountStore();
    await accountStore.fetchAll(data.ledger_id);

    // Trigger sync if authenticated
    const authStore = useAuthStore();
    if (authStore.isAuthenticated) {
      const tx = transactions.value.find(t => t.id === id);
      if (tx) {
        enqueueSync({ accounts: [], tags: [], categories: [], transactions: [tx] });
      }
    }

    return id;
  }

  async function update(
    id: string,
    data: Partial<{
      type: TransactionType;
      amount: number;
      category_id: string | null;
      from_account_id: string | null;
      to_account_id: string | null;
      occurred_at: string;
      tag_ids: string[];
    }>
  ): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.type !== undefined) { sets.push("type = ?"); values.push(data.type); }
    if (data.amount !== undefined) { sets.push("amount = ?"); values.push(data.amount); }
    if (data.category_id !== undefined) { sets.push("category_id = ?"); values.push(data.category_id); }
    if (data.from_account_id !== undefined) { sets.push("from_account_id = ?"); values.push(data.from_account_id); }
    if (data.to_account_id !== undefined) { sets.push("to_account_id = ?"); values.push(data.to_account_id); }
    if (data.occurred_at !== undefined) { sets.push("occurred_at = ?"); values.push(data.occurred_at); }

    if (sets.length > 0) {
      sets.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      await db.execute(
        `UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`,
        values
      );
    }

    if (data.tag_ids !== undefined) {
      await db.execute("DELETE FROM transaction_tags WHERE transaction_id = ?", [id]);
      for (const tagId of data.tag_ids) {
        await db.execute(
          "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES (?, ?)",
          [id, tagId]
        );
      }
    }

    if (_ledgerId) {
      await fetchAll(_ledgerId);
      const accountStore = useAccountStore();
      await accountStore.fetchAll(_ledgerId);
    }

    // Trigger sync
    const authStore = useAuthStore();
    if (authStore.isAuthenticated && id) {
      const tx = transactions.value.find(t => t.id === id);
      if (tx) {
        enqueueSync({ accounts: [], tags: [], categories: [], transactions: [tx] });
      }
    }
  }

  async function remove(id: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    await db.execute(
      "UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    if (_ledgerId) {
      await fetchAll(_ledgerId);
      const accountStore = useAccountStore();
      await accountStore.fetchAll(_ledgerId);
    }

    // Trigger sync with tombstone
    const authStore = useAuthStore();
    if (authStore.isAuthenticated) {
      enqueueSync({
        accounts: [],
        tags: [],
        categories: [],
        transactions: [{ id, is_deleted: true, updated_at: now } as Transaction],
      });
    }
  }

  async function batchRemove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    const placeholders = ids.map(() => "?").join(",");
    await db.execute(
      `UPDATE transactions SET is_deleted = 1, updated_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids]
    );
    if (_ledgerId) {
      await fetchAll(_ledgerId);
      const accountStore = useAccountStore();
      await accountStore.fetchAll(_ledgerId);
    }

    // Trigger sync with tombstones
    const authStore = useAuthStore();
    if (authStore.isAuthenticated) {
      const now = new Date().toISOString();
      enqueueSync({
        accounts: [],
        tags: [],
        categories: [],
        transactions: ids.map(id => ({ id, is_deleted: true, updated_at: now } as Transaction)),
      });
    }
  }

  return { transactions, totalIncome, totalExpense, fetchAll, add, update, remove, batchRemove };
});
