import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

// 可切换的 route query：本文件要逐个验证 buildFetchOpts 对筛选参数的解读
const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }));
// 形参名带下划线前缀以满足 noUnusedParameters；同时给 mock 定出参数类型，
// 否则 mock.calls 会被推断成 [][]，取 [1] 直接类型报错
const fetchAll = vi.hoisted(() =>
  vi.fn(async (_ledgerId: string, _opts?: Record<string, unknown>) => {}),
);

// 注意：**不能**在这里用 ref 包一层。Pinia 的 setup store 会把 ref 自动解包，
// 而这个替身是个普通对象，`ledgerStore.currentLedger?.id` 拿到的是 ref 对象本身
// （`.id === undefined`）→ 组件的 `if (!ledgerId) return` 直接短路，fetchAll 永远不会被调用。
// 所以替身要给出解包后的普通值，才与真实 store 的读法一致。
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    init: vi.fn(async () => {}),
    currentLedger: { id: "l1", name: "账本", type: "personal", team_id: null },
    currentLedgerId: "l1",
    ledgers: [],
    setCurrentLedger: vi.fn(),
  }),
}));
vi.mock("@/stores/account", () => ({
  useAccountStore: () => ({ accounts: [], fetchAll: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/tag", () => ({
  useTagStore: () => ({ tags: [], fetchAll: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/category", () => ({
  useCategoryStore: () => ({ categories: [], fetchAll: vi.fn(async () => {}) }),
}));
vi.mock("@/stores/transaction", () => ({
  useTransactionStore: () => ({
    transactions: [],
    totalIncome: 0,
    totalExpense: 0,
    fetchAll,
    batchRemove: vi.fn(async () => {}),
  }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: ref(null) }),
}));
vi.mock("@/db/userDb", () => ({
  getCurrentUserId: () => "u1",
  getTeamMembers: vi.fn(async () => []),
  upsertTeamMembers: vi.fn(async () => {}),
}));
vi.mock("@/composables/useMemberInfo", () => ({
  useMemberInfo: () => ({ getMember: vi.fn(async () => ({ displayName: "" })) }),
}));
vi.mock("@/services/api", () => ({ fetchTeamMembers: vi.fn(async () => []) }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: {}, query: routeQuery.value }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

import TransactionList from "@/views/TransactionList.vue";

async function mountWith(query: Record<string, string>) {
  routeQuery.value = query;
  // FAB 用 <router-link>，而 vue-router 被 mock 了；stub 掉避免 Vue warn
  const wrapper = mount(TransactionList, { global: { stubs: { RouterLink: true } } });
  await flushPromises();
  return wrapper;
}

/** 取最近一次 fetchAll 的第二个参数；没调用过就直接失败，而不是让断言在 undefined 上空转 */
function lastOpts(): Record<string, unknown> {
  // 不用 Array.prototype.at：项目 lib 是 ES2020，.at() 会让 vue-tsc 报 TS2550
  const calls = fetchAll.mock.calls;
  if (calls.length === 0) throw new Error("fetchAll 未被调用");
  return calls[calls.length - 1][1] ?? {};
}

beforeEach(() => {
  setActivePinia(createPinia());
  routeQuery.value = {};
  fetchAll.mockClear();
});

describe("TransactionList 读取筛选 query", () => {
  it("note 映射为 noteKeyword", async () => {
    await mountWith({ note: "盒马", dateFrom: "2026-01-01", dateTo: "2026-12-31" });
    expect(lastOpts().noteKeyword).toBe("盒马");
  });

  it("amountMin / amountMax 转成数字", async () => {
    await mountWith({ amountMin: "10", amountMax: "500", dateFrom: "2026-01-01" });
    expect(lastOpts().amountMin).toBe(10);
    expect(lastOpts().amountMax).toBe(500);
  });

  it("amountMin=0 传成 0 而不是 undefined", async () => {
    await mountWith({ amountMin: "0", dateFrom: "2026-01-01" });
    expect(lastOpts().amountMin).toBe(0);
  });

  it("合法 type 透传", async () => {
    await mountWith({ type: "income", dateFrom: "2026-01-01" });
    expect(lastOpts().type).toBe("income");
  });

  it("非法 type 被忽略而不是让整页崩掉", async () => {
    await mountWith({ type: "乱七八糟", dateFrom: "2026-01-01" });
    expect(lastOpts().type).toBeUndefined();
  });

  it("带 note 但不带日期时，不被「默认当月」覆盖成当月范围", async () => {
    // 这是 AI 芯片跳转最常走的一条路径：不限时间、只带一个关键词。
    // 首页对「有其它筛选条件」的既有行为就是不限时间。
    await mountWith({ note: "盒马" });
    const opts = lastOpts();
    expect(opts.noteKeyword).toBe("盒马");
    expect(opts.dateFrom).toBeUndefined();
    expect(opts.dateTo).toBeUndefined();
  });

  it("完全无参数时仍然默认查当月（不改既有行为）", async () => {
    await mountWith({});
    const opts = lastOpts();
    expect(opts.dateFrom).toBeDefined();
    expect(opts.dateTo).toBeDefined();
  });
});

describe("TransactionList 筛选摘要反映新增筛选参数", () => {
  it("关键词 / 金额区间 / 收支类型都出现在摘要里", async () => {
    const w = await mountWith({ note: "盒马", amountMin: "10", amountMax: "500", type: "income" });
    // 全串相等：既钉住「有这三项」，也钉住金额区间与类型标签的确切文案与顺序
    expect(w.text()).toContain(
      "📅 全部时间 · 📋 全部账户 · 📂 全部分类 · 🔀 收入 · 🔍 盒马 · 💰 ¥10 ~ ¥500 · 🏷️ 全部标签",
    );
  });

  it("只给一边金额时摘要用「以上 / 以下」而不是把缺的一边当 0", async () => {
    const minOnly = await mountWith({ amountMin: "10" });
    expect(minOnly.text()).toContain("💰 ¥10 以上");

    const maxOnly = await mountWith({ amountMax: "500" });
    expect(maxOnly.text()).toContain("💰 ¥500 以下");
  });
});
