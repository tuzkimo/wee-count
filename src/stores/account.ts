import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getDb } from "@/db";
import type { Account, AccountType } from "@/types";

const BALANCE_QUERY = `
  SELECT
    a.id, a.ledger_id, a.owner_id, a.name, a.type,
    a.initial_balance, a.color, a.created_at, a.updated_at, a.is_deleted,
    (a.initial_balance
     + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
     - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
    ) AS current_balance
  FROM accounts a
  WHERE a.ledger_id = ? AND a.is_deleted = 0
  ORDER BY a.created_at DESC
`;

function generateId(): string {
  return crypto.randomUUID();
}

export const useAccountStore = defineStore("account", () => {
  const accounts = ref<Account[]>([]);

  const totalBalance = computed(() =>
    accounts.value.reduce((sum, a) => sum + (a.current_balance ?? 0), 0)
  );

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<(Account & { is_deleted: number | boolean })[]>(
      BALANCE_QUERY,
      [ledgerId]
    );
    accounts.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  async function add(input: {
    ledger_id: string;
    owner_id: string;
    name: string;
    type: AccountType;
    initial_balance: number;
    color: string;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = generateId();
    await db.execute(
      `INSERT INTO accounts (id, ledger_id, owner_id, name, type, initial_balance, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ledger_id,
        input.owner_id,
        input.name,
        input.type,
        input.initial_balance,
        input.color,
        now,
        now,
      ]
    );
    await fetchAll(input.ledger_id);
  }

  async function update(
    id: string,
    data: Partial<Pick<Account, "name" | "type" | "initial_balance" | "color">>
  ): Promise<void> {
    const db = await getDb();
    const sets: string[] = [];
    const values: (string | number)[] = [];

    if (data.name !== undefined) {
      sets.push("name = ?");
      values.push(data.name);
    }
    if (data.type !== undefined) {
      sets.push("type = ?");
      values.push(data.type);
    }
    if (data.initial_balance !== undefined) {
      sets.push("initial_balance = ?");
      values.push(data.initial_balance);
    }
    if (data.color !== undefined) {
      sets.push("color = ?");
      values.push(data.color);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    await db.execute(
      `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`,
      values
    );
    const existing = accounts.value.find((a) => a.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id);
    }
  }

  async function remove(id: string): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    await db.execute(
      "UPDATE accounts SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    const existing = accounts.value.find((a) => a.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id);
    }
  }

  return { accounts, totalBalance, fetchAll, add, update, remove };
});
