import type { Transaction } from "@/types";
import { utcToLocalDateKey, formatDateLabel } from "@/utils/datetime";

export interface DayGroup {
  date: string;
  label: string;
  transactions: Transaction[];
}

export function getTxIcon(tx: Transaction): string {
  if (tx.type === "transfer") return "🔄";
  return tx.category?.icon ?? (tx.type === "income" ? "📥" : "💸");
}

export function getTxDescription(tx: Transaction): string {
  if (tx.type === "transfer") {
    return `${tx.from_account?.name ?? "?"} → ${tx.to_account?.name ?? "?"}`;
  }
  if (tx.type === "income") {
    return tx.to_account?.name ?? "";
  }
  return tx.from_account?.name ?? "";
}

export function getTxCategoryName(tx: Transaction): string {
  if (tx.type === "transfer") return "转账";
  return tx.category?.name ?? (tx.type === "income" ? "收入" : "支出");
}

export function formatAmount(tx: Transaction): string {
  const sign = tx.type === "income" ? "+" : tx.type === "expense" ? "-" : "";
  return `${sign}¥${tx.amount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function transferFromUid(tx: Transaction): string | null {
  if (tx.type !== "transfer") return null;
  return tx.from_account?.owner_id ?? null;
}

export function transferToUid(tx: Transaction): string | null {
  if (tx.type !== "transfer") return null;
  return tx.to_account?.owner_id ?? null;
}

export function isCrossMemberTransfer(tx: Transaction): boolean {
  const from = transferFromUid(tx);
  const to = transferToUid(tx);
  return !!from && !!to && from !== to;
}

export function transferMemberIds(tx: Transaction): string[] {
  if (!isCrossMemberTransfer(tx)) return [];
  return [transferFromUid(tx)!, transferToUid(tx)!];
}

export function groupTransactionsByDate(txs: Transaction[]): DayGroup[] {
  const groups: Record<string, Transaction[]> = {};
  for (const tx of txs) {
    const dateKey = utcToLocalDateKey(tx.occurred_at);
    if (!groups[dateKey]) groups[dateKey] = [];
    groups[dateKey].push(tx);
  }
  return Object.entries(groups)
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([date, txs]) => ({ date, label: formatDateLabel(date), transactions: txs }));
}
