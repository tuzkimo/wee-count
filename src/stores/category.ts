import { defineStore } from "pinia";
import { ref } from "vue";
import { getUserDb } from "@/db/userDb";
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

  return { categories, fetchAll };
});
