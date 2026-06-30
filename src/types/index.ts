export type AccountCategory = "asset" | "liability";
export type AssetType = "cash" | "bank" | "digital";
export type LiabilityType = "credit_card" | "huabei" | "meituan_monthly" | "other_loan";
export type AccountType = AssetType | LiabilityType;

export type CategoryType = "income" | "expense";
export type TransactionType = "income" | "expense" | "transfer";

export interface Category {
  id: string;
  ledger_id: string | null;
  name: string;
  type: CategoryType;
  icon: string | null;
  sort_order: number;
  updated_at: string;
  is_deleted: boolean;
}

export interface Tag {
  id: string;
  ledger_id: string;
  name: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface Transaction {
  id: string;
  ledger_id: string;
  user_id: string;
  amount: number;
  type: TransactionType;
  from_account_id: string | null;
  to_account_id: string | null;
  category_id: string | null;
  occurred_at: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  tag_ids?: string[];
  // 查询时 JOIN 填充
  category?: Category;
  tags?: Tag[];
  from_account?: Account;
  to_account?: Account;
}

export const ACCOUNT_CATEGORY: Record<AccountType, AccountCategory> = {
  cash: "asset",
  bank: "asset",
  digital: "asset",
  credit_card: "liability",
  huabei: "liability",
  meituan_monthly: "liability",
  other_loan: "liability",
};

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: "现金",
  bank: "银行卡",
  digital: "电子钱包",
  credit_card: "信用卡",
  huabei: "花呗",
  meituan_monthly: "美团月付",
  other_loan: "其他借贷",
};

export interface Account {
  id: string;
  ledger_id: string;
  owner_id: string;
  name: string;
  type: AccountType;
  category?: AccountCategory;
  initial_balance: number;
  credit_limit?: number;
  repayment_day?: number;
  color: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  current_balance?: number;
}

export interface Ledger {
  id: string;
  name: string;
  type: "personal" | "team";
  team_id: string | null;
  owner_id: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
}

export interface User {
  id: string;
  username: string;
  nickname: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}
