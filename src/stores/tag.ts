import { defineStore } from "pinia";
import { ref } from "vue";
import { getUserDb } from "@/db/userDb";
import { enqueueSync } from "@/services/sync";
import type { Tag } from "@/types";


export const useTagStore = defineStore("tag", () => {
  const tags = ref<Tag[]>([]);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const rows = await db.select<(Tag & { is_deleted: number | boolean })[]>(
      `SELECT id, ledger_id, name, updated_at, is_deleted
       FROM tags
       WHERE ledger_id = ? AND is_deleted = 0
       ORDER BY name ASC`,
      [ledgerId]
    );
    tags.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  async function add(ledgerId: string, name: string): Promise<Tag> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.execute(
      "INSERT INTO tags (id, ledger_id, name, updated_at) VALUES (?, ?, ?, ?)",
      [id, ledgerId, name, now]
    );
    const newTag: Tag = {
      id,
      ledger_id: ledgerId,
      name,
      updated_at: now,
      is_deleted: false,
    };
    tags.value.push(newTag);
    enqueueSync({
      accounts: [],
      tags: [newTag],
      categories: [],
      transactions: [],
    });
    return newTag;
  }

  async function remove(id: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    await db.execute(
      "UPDATE tags SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    tags.value = tags.value.filter((t) => t.id !== id);
  }

  return { tags, fetchAll, add, remove };
});
