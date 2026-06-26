# 分类管理 CRUD

## 1. 背景

之前为了解决默认分类在同步时的重复问题（`43ffeb5`），取消了默认分类设计。现在需要让用户可以手动创建、编辑、删除分类。同时修复记账页未选分类时无错误提示的问题。

## 2. 入口

记账页（RecordPage）分类选择网格上方加"管理"按钮，点击弹出底部抽屉（BottomSheet）。

## 3. 底部抽屉 — 分类管理

### 分类列表

- 按 type 分组：收入 / 支出，各一组
- 每行显示：emoji 图标 + 分类名称
- 右侧：编辑按钮 + 删除按钮
- 底部固定："新建分类"按钮

### 新建分类

- 表单：选 type（income/expense）、选 icon、填 name
- **icon 选择**：预设 emoji 网格（常用 12 个）+ 底部自由输入框
- 校验：name 非空、同 type 下 name 不重复

### 编辑分类

- 表单：只能改 icon + name，type 灰显锁定
- 校验同上

### 删除分类

- 先查 `transactions` 表：`SELECT COUNT(*) FROM transactions WHERE category_id = ? AND is_deleted = 0`
- 有交易 → 提示"该分类下有 N 笔交易，无法删除"
- 无交易 → 确认弹窗，确认后软删除（`is_deleted = 1`）

## 4. Pinia Store — categoryStore

`src/stores/category.ts` 新增三个方法：

```typescript
async function add(ledgerId: string, name: string, type: CategoryType, icon: string): Promise<void>
async function update(id: string, name: string, icon: string): Promise<void>
async function remove(id: string): Promise<void>
```

- `add` → `INSERT INTO categories` + `enqueueSync`
- `update` → `UPDATE categories` + `enqueueSync`
- `remove` → 查交易引用计数，有则抛错，无则 `UPDATE SET is_deleted = 1` + `enqueueSync`

同步方法（`enqueueSync`）已存在，格式调整为 `{ categories: [category], accounts: [], tags: [], transactions: [] }`。

## 5. 修复 — 记账页未选分类无提示

当前 `RecordPage` 保存验证中，`if (txType.value !== "transfer" && !categoryId.value) return false` 静默返回，无用户提示。

改为使用 toast/提示："请选择分类"。

## 6. 同步

无需改动。现有 `applyRemoteChanges`（`src/services/sync.ts`）已处理 Category 的 LWW 合并和 `(ledger_id, name, type)` 去重。

## 7. 拖拽排序

后续再做。当前保持 `sort_order` 按创建顺序自增。

## 8. 任务拆分

| # | 任务 | 产出 | 验证方式 |
|---|---|---|---|
| 1 | categoryStore 补全 add/update/remove | `src/stores/category.ts` | 单元测试 |
| 2 | 分类管理 BottomSheet 组件 | 新建/编辑/删除 UI | 手动测试 |
| 3 | 记账页集成"管理"入口 + 未选分类提示 | RecordPage 改动 | 手动测试 |
