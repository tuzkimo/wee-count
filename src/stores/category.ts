import { defineStore } from "pinia";
import { ref } from "vue";
import { getUserDb } from "@/db/userDb";
import { enqueueSync } from "@/services/sync";
import type { Category } from "@/types";

export const useCategoryStore = defineStore("category", () => {
  const categories = ref<Category[]>([]);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const rows = await db.select<(Category & { is_deleted: number | boolean })[]>(
      `SELECT id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted
       FROM categories
       WHERE ledger_id = $1 AND is_deleted = 0
       ORDER BY sort_order ASC, name ASC`,
      [ledgerId]
    );
    categories.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  async function add(
    ledgerId: string,
    name: string,
    type: "income" | "expense",
    icon: string | null,
  ): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error("User DB not opened");

    const existing = await db.select<{ id: string }[]>(
      "SELECT id FROM categories WHERE ledger_id = $1 AND name = $2 AND type = $3 AND is_deleted = 0",
      [ledgerId, name, type],
    );
    if (existing.length > 0) {
      throw new Error("同名分类已存在");
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const result = await db.select<{ max_sort: number | null }[]>(
      "SELECT MAX(sort_order) AS max_sort FROM categories WHERE ledger_id = $1 AND type = $2 AND is_deleted = 0",
      [ledgerId, type],
    );
    const sortOrder = (result[0]?.max_sort ?? -1) + 1;

    await db.execute(
      `INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [id, ledgerId, name, type, icon, sortOrder, now],
    );

    await fetchAll(ledgerId);
    enqueueSync({
      accounts: [],
      tags: [],
      categories: [
        { id, ledger_id: ledgerId, name, type, icon, sort_order: sortOrder, updated_at: now, is_deleted: false },
      ],
      transactions: [],
    });
  }

  async function update(id: string, name: string, icon: string | null): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error("User DB not opened");

    const now = new Date().toISOString();
    await db.execute(
      "UPDATE categories SET name = $1, icon = $2, updated_at = $3 WHERE id = $4",
      [name, icon, now, id],
    );

    const existing = categories.value.find((c) => c.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id!);
      enqueueSync({
        accounts: [],
        tags: [],
        categories: [{ ...existing, name, icon, updated_at: now }],
        transactions: [],
      });
    }
  }

  async function remove(id: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error("User DB not opened");

    const txs = await db.select<{ count: number }[]>(
      "SELECT COUNT(*) AS count FROM transactions WHERE category_id = $1 AND is_deleted = 0",
      [id],
    );
    if (txs[0].count > 0) {
      throw new Error(`该分类下有 ${txs[0].count} 笔交易，无法删除`);
    }

    const now = new Date().toISOString();
    await db.execute(
      "UPDATE categories SET is_deleted = 1, updated_at = $1 WHERE id = $2",
      [now, id],
    );

    const existing = categories.value.find((c) => c.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id!);
      enqueueSync({
        accounts: [],
        tags: [],
        categories: [{ ...existing, is_deleted: true, updated_at: now }],
        transactions: [],
      });
    }
  }

  return { categories, fetchAll, add, update, remove };
});
