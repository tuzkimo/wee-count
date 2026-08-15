import { describe, it, expect, vi, beforeEach } from "vitest";
import { ref } from "vue";

const currentLedger = { id: "l1", type: "personal" };
const accounts = ref([] as { id: string; name: string; is_deleted: boolean; owner_id: string }[]);
const categories = ref([] as { id: string; name: string; type: string; sort_order: number }[]);
const transactionAdd = vi.fn().mockResolvedValue(undefined);

vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({ init: vi.fn(), currentLedger }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({ accounts: accounts.value, fetchAll: vi.fn() }),
}));
vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({ categories: categories.value, fetchAll: vi.fn() }),
}));
vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({ tags: [], fetchAll: vi.fn() }),
}));
vi.mock("@/stores/transaction", () => ({
  useTransactionStore: () => ({ transactions: [], add: transactionAdd, update: vi.fn(), remove: vi.fn(), fetchAll: vi.fn() }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: { server_user_id: "u1" } }),
}));
vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "u1",
}));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {}, query: {} }),
}));

import { useTransactionForm } from "@/composables/useTransactionForm";

describe("useTransactionForm.doSave 校验", () => {
  beforeEach(() => {
    accounts.value = [];
    categories.value = [];
    transactionAdd.mockClear();
  });

  it("缺分类：expense 无分类返回 false 且 saveError=请选择分类", async () => {
    const f = useTransactionForm();
    f.expression.value = "10";
    f.fromAccountId.value = "a1";
    const ok = await f.doSave();
    expect(ok).toBe(false);
    expect(f.saveError.value).toBe("请选择分类");
    expect(transactionAdd).not.toHaveBeenCalled();
  });

  it("缺账户：expense 无 from 账户返回 false", async () => {
    const f = useTransactionForm();
    f.expression.value = "10";
    f.categoryId.value = "c1";
    const ok = await f.doSave();
    expect(ok).toBe(false);
    expect(transactionAdd).not.toHaveBeenCalled();
  });

  it("转账 from===to：返回 false 且 saveError=转出和转入账户不能相同", async () => {
    const f = useTransactionForm();
    f.txType.value = "transfer";
    f.expression.value = "10";
    f.fromAccountId.value = "a1";
    f.toAccountId.value = "a1";
    const ok = await f.doSave();
    expect(ok).toBe(false);
    expect(f.saveError.value).toBe("转出和转入账户不能相同");
    expect(transactionAdd).not.toHaveBeenCalled();
  });

  it("合法 expense：调 add 且返回 true", async () => {
    const f = useTransactionForm();
    f.expression.value = "10";
    f.categoryId.value = "c1";
    f.fromAccountId.value = "a1";
    f.occurredAt.value = "2026-08-15T10:00";
    const ok = await f.doSave();
    expect(ok).toBe(true);
    expect(transactionAdd).toHaveBeenCalledTimes(1);
    const data = transactionAdd.mock.calls[0][0];
    expect(data.type).toBe("expense");
    expect(data.amount).toBe(10);
    expect(data.category_id).toBe("c1");
    expect(data.from_account_id).toBe("a1");
    expect(data.to_account_id).toBeNull();
  });
});
