export interface Account {
  id: string;
  ledger_id: string;
  owner_id: string;
  name: string;
  type: AccountType;
  initial_balance: number;
  color: string;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  current_balance?: number;
}

export type AccountType = "bank" | "credit_card" | "digital" | "debt";

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  bank: "银行卡",
  credit_card: "信用卡",
  digital: "电子钱包",
  debt: "借贷",
};

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
  nickname: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}
