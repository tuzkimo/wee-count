# 分类管理 CRUD 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补充分类增删改查功能：categoryStore 增加 add/update/remove、分类管理 UI（BottomSheet）、记账页未选分类错误提示。

**Architecture:** 遵循 accountStore 的 CRUD 模式（Pinia store + SQLite + enqueueSync），UI 复用 AccountPickerSheet 的 BottomSheet 过渡动画模式。CategorySheet 作为独立组件，RecordPage 引入。

**Tech Stack:** Vue 3 + Pinia + SQLite (@tauri-apps/plugin-sql) + TypeScript

---

### Task 1: categoryStore — add / update / remove

**Files:**
- Modify: `src/stores/category.ts`

- [ ] **Step 1: 实现 add 方法**

```typescript
import { v4 as uuidv4 } from "uuid"; // 检查项目是否已有 uuid 依赖，如果没有用 crypto.randomUUID()
```

在 `fetchAll` 之后、`return` 之前添加：

```typescript
  async function add(ledgerId: string, name: string, type: CategoryType, icon: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error("User DB not opened");

    // 查同 type 下是否已有同名分类
    const existing = await db.select<{ id: string }[]>(
      "SELECT id FROM categories WHERE ledger_id = ? AND type = ? AND name = ? AND is_deleted = 0 LIMIT 1",
      [ledgerId, type, name]
    );
    if (existing.length > 0) {
      throw new Error("同名分类已存在");
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    // sort_order 取同 type 最大值 + 1
    const maxSort = await db.select<{ m: number }[]>(
      "SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE ledger_id = ? AND type = ? AND is_deleted = 0",
      [ledgerId, type]
    );
    const sortOrder = (maxSort[0]?.m ?? 0) + 1;

    await db.execute(
      "INSERT INTO categories (id, ledger_id, name, type, icon, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [id, ledgerId, name, type, icon, sortOrder, now]
    );

    await fetchAll(ledgerId);

    enqueueSync({
      accounts: [],
      tags: [],
      categories: [{ id, ledger_id: ledgerId, name, type, icon, sort_order: sortOrder, updated_at: now, is_deleted: false }],
      transactions: [],
    });
  }

  async function update(id: string, name: string, icon: string): Promise<void> {
    const db = getUserDb();
    if (!db) throw new Error("User DB not opened");

    const now = new Date().toISOString();
    await db.execute(
      "UPDATE categories SET name = ?, icon = ?, updated_at = ? WHERE id = ?",
      [name, icon, now, id]
    );

    const existing = categories.value.find((c) => c.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id!);
    }

    if (existing) {
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

    // 检查是否有关联交易
    const refs = await db.select<{ cnt: number }[]>(
      "SELECT COUNT(*) AS cnt FROM transactions WHERE category_id = ? AND is_deleted = 0",
      [id]
    );
    if (refs[0]?.cnt > 0) {
      throw new Error(`该分类下有 ${refs[0].cnt} 笔交易，无法删除`);
    }

    const now = new Date().toISOString();
    await db.execute(
      "UPDATE categories SET is_deleted = 1, updated_at = ? WHERE id = ?",
      [now, id]
    );

    const existing = categories.value.find((c) => c.id === id);
    if (existing) {
      await fetchAll(existing.ledger_id!);
    }

    if (existing) {
      enqueueSync({
        accounts: [],
        tags: [],
        categories: [{ ...existing, is_deleted: true, updated_at: now }],
        transactions: [],
      });
    }
  }
```

- [ ] **Step 2: 在 return 中导出新方法**

```typescript
  return { categories, fetchAll, add, update, remove };
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
npx vue-tsc --noEmit src/stores/category.ts
```
Expected: 无类型错误

---

### Task 2: categoryStore 单元测试

**Files:**
- Create: `src/stores/__tests__/category.test.ts`

- [ ] **Step 1: 写测试文件**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";

const mockDb = {
  select: vi.fn(),
  execute: vi.fn(),
};

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
  getCurrentUserId: vi.fn(() => "local-user-1"),
  openUserDb: vi.fn(),
  closeUserDb: vi.fn(),
}));

vi.mock("@/services/sync", () => ({
  enqueueSync: vi.fn(),
}));

import { useCategoryStore } from "@/stores/category";
import type { Category } from "@/types";

function makeCategory(overrides: Partial<Category> = {}): Category {
  return {
    id: "cat-1",
    ledger_id: "ledger-1",
    name: "餐饮",
    type: "expense",
    icon: "🍔",
    sort_order: 1,
    updated_at: "2026-06-01T00:00:00Z",
    is_deleted: false,
    ...overrides,
  };
}

describe("categoryStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  describe("fetchAll", () => {
    it("should load categories filtered by ledger_id and not deleted", async () => {
      const rows = [
        { ...makeCategory(), is_deleted: 0 },
      ];
      mockDb.select.mockResolvedValueOnce(rows);

      const store = useCategoryStore();
      await store.fetchAll("ledger-1");

      expect(store.categories).toHaveLength(1);
      expect(store.categories[0].name).toBe("餐饮");
      expect(mockDb.select).toHaveBeenCalledWith(
        expect.stringContaining("FROM categories"),
        ["ledger-1"]
      );
    });

    it("should return empty array when no categories", async () => {
      mockDb.select.mockResolvedValueOnce([]);
      const store = useCategoryStore();
      await store.fetchAll("ledger-1");
      expect(store.categories).toHaveLength(0);
    });
  });

  describe("add", () => {
    it("should insert category and sync", async () => {
      mockDb.select.mockResolvedValueOnce([]); // 同名检查
      mockDb.select.mockResolvedValueOnce([{ m: 3 }]); // max sort_order
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([{ ...makeCategory({ name: "交通", type: "expense", icon: "🚌", sort_order: 4 }), is_deleted: 0 }]);

      const store = useCategoryStore();
      await store.add("ledger-1", "交通", "expense", "🚌");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO categories"),
        expect.arrayContaining(["交通", "expense", "🚌", 4])
      );
    });

    it("should throw on duplicate name in same type", async () => {
      mockDb.select.mockResolvedValueOnce([{ id: "existing" }]);

      const store = useCategoryStore();
      await expect(store.add("ledger-1", "餐饮", "expense", "🍕"))
        .rejects.toThrow("同名分类已存在");
    });
  });

  describe("update", () => {
    it("should update name and icon", async () => {
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([{ ...makeCategory({ name: "零食", icon: "🍿" }), is_deleted: 0 }]);

      const store = useCategoryStore();
      store.categories = [makeCategory()]; // 让 update 能找到 existing
      await store.update("cat-1", "零食", "🍿");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE categories SET name"),
        ["零食", "🍿", expect.any(String), "cat-1"]
      );
    });
  });

  describe("remove", () => {
    it("should soft-delete category with no transactions", async () => {
      mockDb.select.mockResolvedValueOnce([{ cnt: 0 }]); // 无关联交易
      mockDb.execute.mockResolvedValueOnce(undefined);
      mockDb.select.mockResolvedValueOnce([]); // fetchAll

      const store = useCategoryStore();
      store.categories = [makeCategory()];
      await store.remove("cat-1");

      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining("is_deleted = 1"),
        expect.arrayContaining(["cat-1"])
      );
    });

    it("should throw when category has linked transactions", async () => {
      mockDb.select.mockResolvedValueOnce([{ cnt: 5 }]);

      const store = useCategoryStore();
      await expect(store.remove("cat-1"))
        .rejects.toThrow("该分类下有 5 笔交易，无法删除");
    });
  });
});
```

- [ ] **Step 2: 跑测试确保失败（新方法还未 export）**

```bash
npx vitest run src/stores/__tests__/category.test.ts
```
Expected: 至少 add/update/remove 不存在的测试失败

- [ ] **Step 3: 确认 Task 1 代码已写好后跑测试通过**

```bash
npx vitest run src/stores/__tests__/category.test.ts
```
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/stores/category.ts src/stores/__tests__/category.test.ts
git commit -m "feat: add category CRUD (add/update/remove) with unit tests"
```

---

### Task 3: CategorySheet 组件 — 分类管理 UI

**Files:**
- Create: `src/components/CategorySheet.vue`

- [ ] **Step 1: 创建 CategorySheet.vue**

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import { X, Pencil, Trash2, Plus } from "lucide-vue-next";
import { useCategoryStore } from "@/stores/category";
import { useLedgerStore } from "@/stores/ledger";
import type { Category, CategoryType } from "@/types";

defineProps<{ visible: boolean }>();
const emit = defineEmits<{ close: [] }>();

const categoryStore = useCategoryStore();
const ledgerStore = useLedgerStore();

// 编辑/新建表单状态
const showForm = ref(false);
const editingId = ref<string | null>(null);
const formType = ref<CategoryType>("expense");
const formName = ref("");
const formIcon = ref("🍔");
const formError = ref("");

// 预设 emoji
const presetIcons = ["🍔", "🍕", "☕", "🎬", "🚌", "💊", "📱", "👔", "🏠", "🎁", "💰", "💼"];

const incomeCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === "income")
);
const expenseCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === "expense")
);

function openNew(type: CategoryType) {
  editingId.value = null;
  formType.value = type;
  formName.value = "";
  formIcon.value = type === "expense" ? "🍔" : "💰";
  formError.value = "";
  showForm.value = true;
}

function openEdit(cat: Category) {
  editingId.value = cat.id;
  formType.value = cat.type;
  formName.value = cat.name;
  formIcon.value = cat.icon ?? "";
  formError.value = "";
  showForm.value = true;
}

function closeForm() {
  showForm.value = false;
}

async function submitForm() {
  formError.value = "";
  if (!formName.value.trim()) {
    formError.value = "请输入分类名称";
    return;
  }

  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  try {
    if (editingId.value) {
      await categoryStore.update(editingId.value, formName.value.trim(), formIcon.value || "📋");
    } else {
      await categoryStore.add(ledgerId, formName.value.trim(), formType.value, formIcon.value || "📋");
    }
    closeForm();
  } catch (e: any) {
    formError.value = e.message || "操作失败";
  }
}

async function deleteCategory(cat: Category) {
  if (!confirm(`确定要删除"${cat.name}"分类吗？`)) return;
  try {
    await categoryStore.remove(cat.id);
  } catch (e: any) {
    alert(e.message);
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
    <Transition name="sheet-fade">
      <div v-if="visible" class="fixed inset-0 z-40 bg-black/40" @click="$emit('close')" />
    </Transition>

    <!-- 抽屉 -->
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[70vh] flex flex-col"
      >
        <!-- 表单模式 -->
        <template v-if="showForm">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-text">
              {{ editingId ? "编辑分类" : "新建分类" }}
            </h2>
            <button
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
              @click="closeForm"
            >
              <X :size="20" class="text-text-secondary" />
            </button>
          </div>

          <!-- 类型选择（新建时可改） -->
          <div class="mb-3">
            <label class="mb-1 block text-xs text-text-secondary">类型</label>
            <div class="flex gap-2">
              <button
                class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors"
                :class="formType === 'expense' ? 'bg-expense/10 text-expense ring-1 ring-expense' : 'bg-gray-100 text-text-secondary'"
                :disabled="!!editingId"
                @click="formType = 'expense'"
              >支出</button>
              <button
                class="flex-1 rounded-lg py-2 text-sm font-medium transition-colors"
                :class="formType === 'income' ? 'bg-income/10 text-income ring-1 ring-income' : 'bg-gray-100 text-text-secondary'"
                :disabled="!!editingId"
                @click="formType = 'income'"
              >收入</button>
            </div>
          </div>

          <!-- 名称 -->
          <div class="mb-3">
            <label class="mb-1 block text-xs text-text-secondary">名称</label>
            <input
              v-model="formName"
              class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
              placeholder="分类名称"
              maxlength="10"
            />
          </div>

          <!-- 图标 -->
          <div class="mb-3">
            <label class="mb-1 block text-xs text-text-secondary">图标</label>
            <div class="grid grid-cols-6 gap-2 mb-2">
              <button
                v-for="icon in presetIcons"
                :key="icon"
                class="flex items-center justify-center rounded-lg py-2 text-xl transition-colors"
                :class="formIcon === icon ? 'bg-primary/20 ring-1 ring-primary' : 'bg-gray-100'"
                @click="formIcon = icon"
              >{{ icon }}</button>
            </div>
            <input
              v-model="formIcon"
              class="w-full rounded-lg border border-gray-200 bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
              placeholder="自定义 emoji"
              maxlength="2"
            />
          </div>

          <!-- 错误提示 -->
          <p v-if="formError" class="mb-3 text-sm text-expense">{{ formError }}</p>

          <!-- 提交 -->
          <button
            class="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
            @click="submitForm"
          >{{ editingId ? "保存" : "创建" }}</button>
        </template>

        <!-- 列表模式 -->
        <template v-else>
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-text">管理分类</h2>
            <button
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
              @click="$emit('close')"
            >
              <X :size="20" class="text-text-secondary" />
            </button>
          </div>

          <div class="flex-1 overflow-auto">
            <!-- 支出分类 -->
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium text-text">支出</span>
                <button
                  class="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/5"
                  @click="openNew('expense')"
                ><Plus :size="14" /> 新建</button>
              </div>
              <div v-if="expenseCategories.length === 0" class="py-4 text-center text-sm text-text-secondary">
                暂无分类
              </div>
              <div
                v-for="cat in expenseCategories"
                :key="cat.id"
                class="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-gray-50"
              >
                <div class="flex items-center gap-2">
                  <span class="text-lg">{{ cat.icon }}</span>
                  <span class="text-sm text-text">{{ cat.name }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <button class="flex h-7 w-7 items-center justify-center rounded hover:bg-gray-200" @click="openEdit(cat)">
                    <Pencil :size="14" class="text-text-secondary" />
                  </button>
                  <button class="flex h-7 w-7 items-center justify-center rounded hover:bg-red-50" @click="deleteCategory(cat)">
                    <Trash2 :size="14" class="text-expense" />
                  </button>
                </div>
              </div>
            </div>

            <!-- 收入分类 -->
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <span class="text-sm font-medium text-text">收入</span>
                <button
                  class="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs text-primary hover:bg-primary/5"
                  @click="openNew('income')"
                ><Plus :size="14" /> 新建</button>
              </div>
              <div v-if="incomeCategories.length === 0" class="py-4 text-center text-sm text-text-secondary">
                暂无分类
              </div>
              <div
                v-for="cat in incomeCategories"
                :key="cat.id"
                class="flex items-center justify-between rounded-lg px-3 py-2.5 hover:bg-gray-50"
              >
                <div class="flex items-center gap-2">
                  <span class="text-lg">{{ cat.icon }}</span>
                  <span class="text-sm text-text">{{ cat.name }}</span>
                </div>
                <div class="flex items-center gap-1">
                  <button class="flex h-7 w-7 items-center justify-center rounded hover:bg-gray-200" @click="openEdit(cat)">
                    <Pencil :size="14" class="text-text-secondary" />
                  </button>
                  <button class="flex h-7 w-7 items-center justify-center rounded hover:bg-red-50" @click="deleteCategory(cat)">
                    <Trash2 :size="14" class="text-expense" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 底部新建按钮 -->
          <div class="mt-2 flex gap-2">
            <button
              class="flex-1 rounded-lg bg-gray-100 py-2.5 text-sm font-medium text-text-secondary hover:bg-gray-200"
              @click="openNew('expense')"
            >+ 新建支出分类</button>
            <button
              class="flex-1 rounded-lg bg-gray-100 py-2.5 text-sm font-medium text-text-secondary hover:bg-gray-200"
              @click="openNew('income')"
            >+ 新建收入分类</button>
          </div>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
```

- [ ] **Step 2: 验证组件编译**

```bash
npx vue-tsc --noEmit src/components/CategorySheet.vue
```
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/components/CategorySheet.vue
git commit -m "feat: add CategorySheet component for category management"
```

---

### Task 4: RecordPage — 集成管理入口 + 错误提示

**Files:**
- Modify: `src/views/RecordPage.vue:343-357`（分类网格区域）

- [ ] **Step 1: 引入 CategorySheet，在分类网格上方加"管理"按钮**

在 `<script setup>` 中添加 import：

```typescript
import CategorySheet from "@/components/CategorySheet.vue";
```

在变量声明区添加：

```typescript
const categorySheetVisible = ref(false);
```

在 `doSave` 中，将静默 `return false` 改为设置错误信息：

```typescript
const saveError = ref("");

async function doSave(): Promise<boolean> {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId || isSaving.value || !isValid.value) return false;

  const amt = calcResult.value!;

  if (txType.value !== "transfer" && !categoryId.value) {
    saveError.value = "请选择分类";
    return false;
  }
  if (!fromAccountId.value) return false;
  if (txType.value !== "expense" && !toAccountId.value) return false;

  saveError.value = "";
  // ... 后续逻辑不变
```

- [ ] **Step 2: 在模板中添加按钮和错误提示**

在分类网格 `<div v-if="txType !== 'transfer'" class="mb-4">` 内部，网格上方添加：

```html
      <div class="mb-2 flex items-center justify-between">
        <label class="text-xs text-text-secondary">分类</label>
        <button
          class="text-xs text-primary hover:underline"
          @click="categorySheetVisible = true"
        >管理</button>
      </div>
```

在分类网格下方（`</div>` 之前）、网格 `<div>` 之后添加错误提示：

```html
      <p v-if="saveError && txType !== 'transfer'" class="mb-2 text-sm text-expense">{{ saveError }}</p>
```

- [ ] **Step 3: 在模板底部添加 CategorySheet（与其他 Sheet 并列）**

```html
    <!-- 分类管理 Sheet -->
    <CategorySheet
      :visible="categorySheetVisible"
      @close="categorySheetVisible = false"
    />
```

- [ ] **Step 4: 验证**

```bash
npx vue-tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/views/RecordPage.vue
git commit -m "feat: add category management entry and missing category error message on record page"
```

---

### Task 5: 最终验证

- [ ] **Step 1: 跑全部测试**

```bash
npx vitest run
```
Expected: 全部通过（包括新增的 category test）

- [ ] **Step 2: 跑类型检查**

```bash
npx vue-tsc --noEmit
```
Expected: 无错误

- [ ] **Step 3: 验证构建**

```bash
npm run build
```
Expected: 构建成功
