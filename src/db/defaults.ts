// src/db/defaults.ts

export interface DefaultCategory {
  name: string
  type: 'expense' | 'income'
  icon: string
  sortOrder: number
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { name: '餐饮', type: 'expense', icon: '🍜', sortOrder: 1 },
  { name: '交通', type: 'expense', icon: '🚌', sortOrder: 2 },
  { name: '购物', type: 'expense', icon: '🛒', sortOrder: 3 },
  { name: '娱乐', type: 'expense', icon: '🎮', sortOrder: 4 },
  { name: '居家', type: 'expense', icon: '🏠', sortOrder: 5 },
  { name: '通讯', type: 'expense', icon: '📱', sortOrder: 6 },
  { name: '医疗', type: 'expense', icon: '💊', sortOrder: 7 },
  { name: '其他支出', type: 'expense', icon: '💸', sortOrder: 99 },
  { name: '工资', type: 'income', icon: '💰', sortOrder: 1 },
  { name: '奖金', type: 'income', icon: '🎁', sortOrder: 2 },
  { name: '理财', type: 'income', icon: '📈', sortOrder: 3 },
  { name: '退款', type: 'income', icon: '↩️', sortOrder: 4 },
  { name: '报销', type: 'income', icon: '🧾', sortOrder: 5 },
  { name: '其他收入', type: 'income', icon: '📥', sortOrder: 99 },
]
