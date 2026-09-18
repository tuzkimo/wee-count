import { defineStore } from "pinia";
import { ref } from "vue";
import { getUserDb } from "@/db/userDb";
import { enqueueSync } from "@/services/sync";
import type { Tag, TagWithUsage } from "@/types";

/** 同步载荷只带 Tag 实体字段：usage_count 是本地派生值，不外发 */
function toSyncTag(tag: TagWithUsage, overrides: Partial<Tag> = {}): Tag {
  const { id, ledger_id, name, updated_at, is_deleted } = tag;
  return { id, ledger_id, name, updated_at, is_deleted, ...overrides };
}


export const useTagStore = defineStore("tag", () => {
  const tags = ref<TagWithUsage[]>([]);

  async function fetchAll(ledgerId: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const rows = await db.select<(TagWithUsage & { is_deleted: number | boolean })[]>(
      // 计数先聚合成「标签 → 关联的非删除交易数」再 LEFT JOIN 回 tags。
      // 不要图省事写成 JOIN transaction_tags + GROUP BY：那会退化成 O(标签数 × 关联数)
      // 的嵌套循环（实测 5 万笔 1.39s、20 万笔 8.2s），聚合子查询只顺序扫一遍关联表
      // （同规模 32ms / 152ms）。也正因如此，给 transaction_tags(tag_id) 加索引是负收益：
      // 全表聚合本就是顺序扫描，走索引反而更慢。
      `SELECT t.id, t.ledger_id, t.name, t.updated_at, t.is_deleted,
              COALESCE(u.cnt, 0) AS usage_count
       FROM tags t
       LEFT JOIN (
         SELECT tt.tag_id AS tag_id, COUNT(*) AS cnt
         FROM transaction_tags tt
         JOIN transactions tx ON tx.id = tt.transaction_id AND tx.is_deleted = 0
         WHERE tx.ledger_id = ?
         GROUP BY tt.tag_id
       ) u ON u.tag_id = t.id
       WHERE t.ledger_id = ? AND t.is_deleted = 0
       ORDER BY usage_count DESC, t.name ASC`,
      [ledgerId, ledgerId]
    );
    tags.value = rows.map((row) => ({
      ...row,
      is_deleted: Boolean(row.is_deleted),
    }));
  }

  async function add(ledgerId: string, name: string): Promise<TagWithUsage> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await db.execute(
      "INSERT INTO tags (id, ledger_id, name, updated_at) VALUES (?, ?, ?, ?)",
      [id, ledgerId, name, now]
    );
    // 新建标签尚无交易引用，使用次数为 0
    const newTag: TagWithUsage = {
      id,
      ledger_id: ledgerId,
      name,
      updated_at: now,
      is_deleted: false,
      usage_count: 0,
    };
    tags.value.push(newTag);
    enqueueSync({
      accounts: [],
      tags: [toSyncTag(newTag)],
      categories: [],
      transactions: [],
    });
    return newTag;
  }

  async function update(id: string, name: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const trimmed = name.trim();
    if (!trimmed) throw new Error("请输入标签名称");

    const existing = tags.value.find((t) => t.id === id);
    if (!existing) throw new Error("标签不存在");

    // 重名判定忽略大小写（与创建入口一致），排除自身以支持仅改大小写
    const dup = await db.select<{ id: string }[]>(
      `SELECT id FROM tags
       WHERE ledger_id = ? AND name = ? COLLATE NOCASE AND is_deleted = 0 AND id != ?`,
      [existing.ledger_id, trimmed, id]
    );
    if (dup.length > 0) throw new Error("同名标签已存在");

    const now = new Date().toISOString();
    await db.execute(
      "UPDATE tags SET name = ?, updated_at = ? WHERE id = ?",
      [trimmed, now, id]
    );

    const updated: TagWithUsage = { ...existing, name: trimmed, updated_at: now };
    tags.value = tags.value.map((t) => (t.id === id ? updated : t));
    enqueueSync({
      accounts: [],
      tags: [toSyncTag(updated)],
      categories: [],
      transactions: [],
    });
  }

  async function remove(id: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error('User DB not opened');
    const now = new Date().toISOString();
    const existing = tags.value.find((t) => t.id === id);
    await db.execute(
      "UPDATE tags SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );
    tags.value = tags.value.filter((t) => t.id !== id);
    if (existing) {
      enqueueSync({
        accounts: [],
        tags: [toSyncTag(existing, { is_deleted: true, updated_at: now })],
        categories: [],
        transactions: [],
      });
    }
  }

  return { tags, fetchAll, add, update, remove };
});
