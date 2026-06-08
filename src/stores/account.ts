import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { getDb } from "@/db";
import type { Account, AccountType } from "@/types";

const BALANCE_QUERY = `
  SELECT
    a.id, a.ledger_id, a.owner_id, a.name, a.type, a.category,
    a.initial_balance, a.credit_limit, a.repayment_day,
    a.color, a.created_at, a.updated_at, a.is_deleted,
    CASE WHEN a.category = 'liability'
      THEN -ABS(
        a.initial_balance
        + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
        - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
      )
      ELSE (
        a.initial_balance
        + COALESCE((SELECT SUM(amount) FROM transactions WHERE to_account_id = a.id AND is_deleted = 0), 0)
        - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_account_id = a.id AND is_deleted = 0), 0)
      )
    END AS current_balance
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

  const assetsTotal = computed(() =>
    accounts.value
      .filter((a) => a.category === "asset")
      .reduce((sum, a) => sum + (a.current_balance ?? 0), 0)
  );

  const liabilitiesTotal = computed(() =>
    accounts.value
      .filter((a) => a.category === "liability")
      .reduce((sum, a) => sum + (a.current_balance ?? 0), 0)
  );

  const netAssets = computed(() => assetsTotal.value + liabilitiesTotal.value);

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
    category: string;
    initial_balance: number;
    credit_limit?: number;
    repayment_day?: number;
    color: string;
  }): Promise<void> {
    const db = await getDb();
    const now = new Date().toISOString();
    const id = generateId();
    await db.execute(
      `INSERT INTO accounts (id, ledger_id, owner_id, name, type, category, initial_balance, credit_limit, repayment_day, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.ledger_id,
        input.owner_id,
        input.name,
        input.type,
        input.category,
        input.initial_balance,
        input.credit_limit ?? null,
        input.repayment_day ?? null,
        input.color,
        now,
        now,
      ]
    );
    await fetchAll(input.ledger_id);
  }

  async function update(
    id: string,
    data: Partial<Pick<Account, "name" | "type" | "category" | "initial_balance" | "credit_limit" | "repayment_day" | "color">>
  ): Promise<void> {
    const db = await getDb();
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.name !== undefined) {
      sets.push("name = ?");
      values.push(data.name);
    }
    if (data.type !== undefined) {
      sets.push("type = ?");
      values.push(data.type);
    }
    if (data.category !== undefined) {
      sets.push("category = ?");
      values.push(data.category);
    }
    if (data.initial_balance !== undefined) {
      sets.push("initial_balance = ?");
      values.push(data.initial_balance);
    }
    if (data.credit_limit !== undefined) {
      sets.push("credit_limit = ?");
      values.push(data.credit_limit);
    }
    if (data.repayment_day !== undefined) {
      sets.push("repayment_day = ?");
      values.push(data.repayment_day);
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

  return { accounts, totalBalance, assetsTotal, liabilitiesTotal, netAssets, fetchAll, add, update, remove };
});
