import { describe, it, expect } from "vitest";
import { getTxIcon, getTxDescription, getTxCategoryName, formatAmount, isCrossMemberTransfer, transferMemberIds, groupTransactionsByDate } from "@/utils/transaction";
import type { Transaction } from "@/types";

function tx(partial: Partial<Transaction>): Transaction {
  return { id: "t1", ledger_id: "l1", user_id: "u1", amount: 0, type: "expense", from_account_id: null, to_account_id: null, category_id: null, note: null, occurred_at: "", created_at: "", updated_at: "", is_deleted: false, ...partial };
}

describe("getTxIcon", () => {
  it("转账返回 🔄", () => expect(getTxIcon(tx({ type: "transfer" }))).toBe("🔄"));
  it("有分类图标用图标，无则按类型回退", () => {
    expect(getTxIcon(tx({ type: "expense", category: { id: "c", ledger_id: "l", owner_id: "u", name: "餐饮", type: "expense", icon: "🍜", sort_order: 0, updated_at: "", is_deleted: false } }))).toBe("🍜");
    expect(getTxIcon(tx({ type: "income" }))).toBe("📥");
    expect(getTxIcon(tx({ type: "expense" }))).toBe("💸");
  });
});

describe("getTxDescription", () => {
  it("转账显示 from → to", () => {
    expect(getTxDescription(tx({ type: "transfer", from_account: { id: "a", ledger_id: "l", owner_id: "u", name: "现金", type: "cash", initial_balance: 0, color: "#3b82f6", created_at: "", updated_at: "", is_deleted: false }, to_account: { id: "b", ledger_id: "l", owner_id: "u", name: "银行卡", type: "bank", initial_balance: 0, color: "#3b82f6", created_at: "", updated_at: "", is_deleted: false } }))).toBe("现金 → 银行卡");
  });
  it("收入取 to 账户，支出取 from 账户", () => {
    expect(getTxDescription(tx({ type: "income", to_account: { id: "b", ledger_id: "l", owner_id: "u", name: "银行卡", type: "bank", initial_balance: 0, color: "#3b82f6", created_at: "", updated_at: "", is_deleted: false } }))).toBe("银行卡");
    expect(getTxDescription(tx({ type: "expense", from_account: { id: "a", ledger_id: "l", owner_id: "u", name: "现金", type: "cash", initial_balance: 0, color: "#3b82f6", created_at: "", updated_at: "", is_deleted: false } }))).toBe("现金");
  });
});

describe("getTxCategoryName", () => {
  it("转账返回「转账」，有分类取分类名，无则按类型回退", () => {
    expect(getTxCategoryName(tx({ type: "transfer" }))).toBe("转账");
    expect(getTxCategoryName(tx({ type: "expense", category: { id: "c", ledger_id: "l", owner_id: "u", name: "餐饮", type: "expense", icon: "🍜", sort_order: 0, updated_at: "", is_deleted: false } }))).toBe("餐饮");
    expect(getTxCategoryName(tx({ type: "income" }))).toBe("收入");
    expect(getTxCategoryName(tx({ type: "expense" }))).toBe("支出");
  });
});

describe("formatAmount", () => {
  it("income + / expense - / transfer 无符号，千分位两位小数", () => {
    expect(formatAmount(tx({ type: "income", amount: 1234.5 }))).toBe("+¥1,234.50");
    expect(formatAmount(tx({ type: "expense", amount: 1234.5 }))).toBe("-¥1,234.50");
    expect(formatAmount(tx({ type: "transfer", amount: 100 }))).toBe("¥100.00");
  });
});

describe("transfer* helpers", () => {
  const acc = (owner_id: string) => ({ id: "a", ledger_id: "l", owner_id, name: "x", type: "cash" as const, initial_balance: 0, color: "#3b82f6", created_at: "", updated_at: "", is_deleted: false });
  it("跨成员转账判定", () => {
    expect(isCrossMemberTransfer(tx({ type: "transfer", from_account: acc("u1"), to_account: acc("u2") }))).toBe(true);
    expect(isCrossMemberTransfer(tx({ type: "transfer", from_account: acc("u1"), to_account: acc("u1") }))).toBe(false);
    expect(transferMemberIds(tx({ type: "transfer", from_account: acc("u1"), to_account: acc("u2") }))).toEqual(["u1", "u2"]);
  });
});

describe("groupTransactionsByDate", () => {
  it("按 UTC 本地日期 key 分组并倒序", () => {
    const txs = [
      tx({ id: "a", occurred_at: "2026-08-15T10:00:00Z" }),
      tx({ id: "b", occurred_at: "2026-08-14T10:00:00Z" }),
      tx({ id: "c", occurred_at: "2026-08-15T11:00:00Z" }),
    ];
    const groups = groupTransactionsByDate(txs);
    expect(groups.map((g) => g.transactions.map((t) => t.id))).toEqual([["a", "c"], ["b"]]);
  });
});
