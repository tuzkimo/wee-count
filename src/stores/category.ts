import { defineStore } from "pinia";
import { ref } from "vue";
import { getDb } from "@/db";
import type { Category } from "@/types";

export const useCategoryStore = defineStore("category", () => {
  const categories = ref<Category[]>([]);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = await getDb();
    const rows = await db.select<(Category & { is_deleted: number | boolean })[]>(
      `SELECT id, ledger_id, name, type, icon, sort_order, updated_at, is_deleted
       FROM categories
       WHERE (ledger_id = ? OR ledger_id IS NULL) AND is_deleted = 0
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
