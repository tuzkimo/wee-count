import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";

// 可切换的 route query：本文件每个案例都把 appliedToQuery 的产出喂给组件
const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }));
// 真库句柄。必须在 mock 工厂之外持有（工厂会被提升到文件顶部执行），
// 所以走 vi.hoisted；工厂里只在**调用时**读 dbRef.current，不读模块级变量。
const dbRef = vi.hoisted(() => ({ current: null as unknown }));

// 只把 userDb 换成「真 node:sqlite 适配器」：真 transactionStore.fetchAll 与真 runQuery
// 都会调 getUserDb()，拿到的是同一个内存库。execute 一调用即抛 —— 这条链路只许读。
vi.mock("@/db/userDb", () => ({
  getUserDb: () => ({
    select: (sql: string, params: (string | number)[]) =>
      Promise.resolve((dbRef.current as DatabaseSync).prepare(sql).all(...params)),
    execute: () => {
      throw new Error("不变式链路不该写库（本测试只做读路径，见文件头注释）");
    },
  }),
  getCurrentUserId: () => "u-me",
  getTeamMembers: async () => [],
  upsertTeamMembers: async () => {},
  getMemberAlias: async () => null,
}));

// 组件挂载用到的邻近依赖：与 TransactionList.filterParams.test.ts 的替身一致。
// 注意**没有** mock `@/stores/transaction` —— 那一层必须是真身（真 QUERY 才是被对照的一方）。
vi.mock("@/stores/ledger", () => ({
  useLedgerStore: () => ({
    init: vi.fn(async () => {}),
    currentLedger: { id: "L1", name: "账本", type: "personal", team_id: null },
    currentLedgerId: "L1",
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
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ currentLocalUser: ref(null), syncVersion: 0 }),
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
import { useTransactionStore } from "@/stores/transaction";
import { runQuery } from "@/services/ai/runQuery";
import { appliedToQuery } from "@/services/ai/filterQuery";
import { buildWhere } from "@/services/ai/querySql";
import { validateQuery, type AiQuery } from "@/services/ai/dsl";
import { resolveFilter, type LookupContext } from "@/services/ai/resolve";
import { round2 } from "@/utils/transaction";
import type { TransactionType } from "@/types";

/**
 * M1 的核心不变式：**「AI 说的数字」必须等于「用户点进去看到的列表」**。
 *
 * 这条不变式的两端是**两套独立写出来的 SQL**（`querySql.buildWhere` vs
 * `stores/transaction.ts` 的 `QUERY`），所以它只能在**组合**上失效：
 * 每一处缝各自都有测试（任务 9 测参数序列、任务 10 测三方参数名、任务 11 测 UI 往返），
 * 但「同一次筛选下两边算出的条数与命中的记录是否相等」此前**没有任何测试承载**。
 * M1 中途那条 Critical 数据错误（tag 分组按软删标签重复计钱）正是这样漏过去的。
 *
 * 本文件把最终审查里那次**一次性审计**（115,642 组合、0 反例）固化成常驻护栏：
 * 用**精选案例**换速度（审查者的穷举是审计，不适合每次全量跑）。
 *
 * 链路（全部是真身，没有一个替身；唯一的替身是 DB 句柄，它指向**真** node:sqlite）：
 *
 * ```
 * runQuery(真 DSL → 真 querySql 真 SQL → 真 node:sqlite)
 *   → appliedToQuery(真写方)
 *   → 真组件 TransactionList（真 buildFetchOpts，读 URL query）
 *   → 真 transactionStore.fetchAll（真 QUERY）
 *   → 同一个真 node:sqlite
 * ```
 *
 * 每个案例断言四件事：
 * 1. `matched` == 列表返回的行数（列表**无分页**，所以就是总数）；
 * 2. **命中 id 集合逐 id 相等**（条数相同而集合不同是可能的，只比条数会放过它）；
 * 3. `summary` 三个桶的 total == 列表行按 `type` 分组求和（桶的可见性也一起钉）；
 * 4. `appliedToQuery` 产出的 URL query **永不含 `uncategorized`**
 *    （它是读方独有参数，混进去会让列表被静默套上当月限制）。
 *
 * 另外每条案例都带一个**手工推导的黄金命中集合**。它不是装饰：只做「AI == 列表」的
 * 对照时，夹具写空、或两边一起被改错，测试都会绿。黄金集合把"这两个数分别都对"
 * 也钉住（推导过程写在各案例的注释里，逐笔来自下面的夹具，不是从运行结果反推）。
 *
 * ⚠️ 已知的口径边界（不要读成"本文件什么都能抓"）：
 * - `amountMin: 0` 那条**抓不住**「某一侧把 0 当成没给」——金额恒存正数，
 *   丢掉 `>= 0` 与留下它结果集相同，详见该案例的注释。两侧各自的 `!== null` 守卫由
 *   `TransactionList.filterParams.test.ts` 与 `querySql.summary.test.ts` 守。
 * - 列表侧 `LEFT JOIN tags … AND tags.is_deleted = 0` 被去掉时本文件**全绿**（实测）：
 *   四件事只看 id / 金额 / 类型，不看渲染出来的标签名。那条由
 *   `stores/__tests__/transaction.test.ts` 的执行级用例守（它断言标签名集合）。
 */

// ─────────────────────────────────────────────────────────────────────────────
// 夹具：一个库同时喂给两侧
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE transactions (
    id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, user_id TEXT NOT NULL,
    amount REAL NOT NULL, type TEXT NOT NULL,
    from_account_id TEXT, to_account_id TEXT, category_id TEXT,
    note TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, type TEXT, icon TEXT, owner_id TEXT, sort_order INTEGER, is_deleted INTEGER DEFAULT 0);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, type TEXT, color TEXT, owner_id TEXT);
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT, is_deleted INTEGER DEFAULT 0);
  CREATE TABLE transaction_tags (transaction_id TEXT, tag_id TEXT);
`;

/** 本地时间 → ISO 串。必须本地构造：区间边界也是按本地日算的，硬编码 Z 会让断言在别的 TZ 下翻转。 */
function at(y: number, mo: number, d: number, h = 10, mi = 0, s = 0, ms = 0): string {
  return new Date(y, mo - 1, d, h, mi, s, ms).toISOString();
}

interface SeedTx {
  id: string;
  ledger: string;
  user: string;
  amount: number;
  type: TransactionType;
  from: string | null;
  to: string | null;
  category: string | null;
  note: string | null;
  occurredAt: string;
  deleted?: boolean;
  tags?: string[];
}

/**
 * 21 行流水，覆盖最容易让两侧分叉的形状：
 * 一笔挂两个活跃标签（扇出）、只挂软删标签、软删流水（含区间外的两笔）、软删分类、跨账本、
 * 月初/月末毫秒级边界、跨月、年初年末、金额 0、`%` 元字符、备注/分类全 NULL、
 * 同名「其他」收支双分类、转账（from/to 都在）。
 */
const SEED: SeedTx[] = [
  // x1：一笔挂 2 个活跃标签 —— QUERY 的 GROUP BY t.id 与 buildWhere 的 IN 子查询在这个形状上语义必须一致
  { id: "x1", ledger: "L1", user: "u-me", amount: 100, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "盒马买菜", occurredAt: at(2026, 3, 2), tags: ["t-hm", "t-fresh"] },
  { id: "x2", ledger: "L1", user: "u-wife", amount: 200.5, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "盒马买肉", occurredAt: at(2026, 3, 20) },
  { id: "x3", ledger: "L1", user: "u-me", amount: 5000, type: "income", from: null, to: "a-cmb", category: "c-salary", note: "工资", occurredAt: at(2026, 3, 5) },
  { id: "x4", ledger: "L1", user: "u-me", amount: 300, type: "transfer", from: "a-cmb", to: "a-cash", category: null, note: null, occurredAt: at(2026, 3, 6) },
  // x5：月初 00:00:00.000 整 + 金额 0（金额边界与时间边界叠在一笔上）
  { id: "x5", ledger: "L1", user: "u-me", amount: 0, type: "expense", from: "a-cash", to: null, category: "c-food", note: "零元", occurredAt: at(2026, 3, 1, 0, 0, 0, 0) },
  // x6：月末最后一毫秒 + 靠**标签名**命中（备注里没有关键词）
  { id: "x6", ledger: "L1", user: "u-me", amount: 50, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "生鲜采购", occurredAt: at(2026, 3, 31, 23, 59, 59, 999), tags: ["t-hm"] },
  { id: "x7", ledger: "L1", user: "u-me", amount: 888, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "已删流水", occurredAt: at(2026, 3, 8), deleted: true },
  { id: "x8", ledger: "L2", user: "u-me", amount: 777, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "别账本", occurredAt: at(2026, 3, 9) },
  { id: "x9", ledger: "L1", user: "u-me", amount: 70, type: "expense", from: "a-cmb", to: null, category: "c-dead", note: "软删分类", occurredAt: at(2026, 3, 13) },
  { id: "x10", ledger: "L1", user: "u-me", amount: 60, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "折扣50%off", occurredAt: at(2026, 3, 12) },
  { id: "x11", ledger: "L1", user: "u-me", amount: 600, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "满50减10", occurredAt: at(2026, 3, 12, 11) },
  // x12：只挂**软删标签**。过滤子查询两侧都不查 is_deleted → 两边都必须算它命中；
  // 而 merchant 关键词那一侧的 sq_tg.is_deleted = 0 必须让它**不**被关键词命中。两个方向都要测。
  { id: "x12", ledger: "L1", user: "u-me", amount: 90, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "只挂软删标签", occurredAt: at(2026, 3, 15), tags: ["t-dead"] },
  { id: "x13", ledger: "L1", user: "u-wife", amount: 1234.56, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "跨月边界", occurredAt: at(2026, 2, 28, 23, 59, 59, 999) },
  { id: "x14", ledger: "L1", user: "u-me", amount: 300, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "四月初", occurredAt: at(2026, 4, 1, 0, 30) },
  // x15 / x16：年末最后一秒与年初第一毫秒，且 note / category 全 NULL
  { id: "x15", ledger: "L1", user: "u-me", amount: 200, type: "expense", from: "a-cmb", to: null, category: null, note: null, occurredAt: at(2025, 12, 31, 23, 59, 59, 0) },
  { id: "x16", ledger: "L1", user: "u-me", amount: 150, type: "income", from: null, to: "a-cmb", category: null, note: "年初", occurredAt: at(2026, 1, 1, 0, 0, 0, 0) },
  { id: "x17", ledger: "L1", user: "u-wife", amount: 100, type: "transfer", from: "a-cash", to: "a-cmb", category: null, note: null, occurredAt: at(2026, 2, 10) },
  { id: "x18", ledger: "L1", user: "u-me", amount: 40, type: "expense", from: "a-citic", to: null, category: "c-other-e", note: "打车", occurredAt: at(2026, 3, 18) },
  { id: "x19", ledger: "L1", user: "u-me", amount: 800, type: "income", from: null, to: "a-cmb", category: "c-other-i", note: "兼职", occurredAt: at(2026, 3, 19) },
  // x20 / x21：软删流水，且刻意落在**活跃数据的区间之外**（比最早的一笔更早、比最晚的一笔更晚）。
  // 它们存在的唯一理由：让 FULL_RANGE_SQL 的 `is_deleted = 0` 可被杀。
  // 少了这两笔，「删掉派生查询的软删过滤」不会改变 MIN/MAX，断言全绿——那条守卫就成了空转。
  { id: "x20", ledger: "L1", user: "u-me", amount: 999, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "已删的更早一笔", occurredAt: at(2025, 6, 1), deleted: true },
  { id: "x21", ledger: "L1", user: "u-me", amount: 999, type: "expense", from: "a-cmb", to: null, category: "c-food", note: "已删的更晚一笔", occurredAt: at(2026, 8, 1), deleted: true },
];

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(`
    INSERT INTO categories VALUES
      ('c-food', '买菜', 'expense', NULL, NULL, 0, 0),
      ('c-salary', '工资', 'income', NULL, NULL, 1, 0),
      ('c-dead', '已删分类', 'expense', NULL, NULL, 2, 1),
      ('c-other-e', '其他', 'expense', NULL, NULL, 3, 0),
      ('c-other-i', '其他', 'income', NULL, NULL, 4, 0);
    INSERT INTO accounts VALUES
      ('a-cmb', '招行', NULL, NULL, NULL),
      ('a-cash', '现金', NULL, NULL, NULL),
      ('a-citic', '中信', NULL, NULL, NULL);
    INSERT INTO tags VALUES
      ('t-hm', '盒马', 0), ('t-fresh', '生鲜', 0), ('t-dead', '盒马已删标签', 1);
  `);
  const insert = db.prepare(
    `INSERT INTO transactions
       (id, ledger_id, user_id, amount, type, from_account_id, to_account_id, category_id, note, occurred_at, created_at, updated_at, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const t of SEED) {
    insert.run(t.id, t.ledger, t.user, t.amount, t.type, t.from, t.to, t.category, t.note, t.occurredAt, t.occurredAt, t.occurredAt, t.deleted ? 1 : 0);
  }
  const link = db.prepare("INSERT INTO transaction_tags VALUES (?, ?)");
  for (const t of SEED) for (const tag of t.tags ?? []) link.run(t.id, tag);
  return db;
}

// ─────────────────────────────────────────────────────────────────────────────
// 查找表与固定的 now
// ─────────────────────────────────────────────────────────────────────────────

/** 名字池。注意 c-other-e / c-other-i 同名 —— 只有 `type` 能消歧，这正是 C14 要测的。 */
const CTX: LookupContext = {
  categories: [
    { id: "c-food", name: "买菜", type: "expense" },
    { id: "c-salary", name: "工资", type: "income" },
    { id: "c-dead", name: "已删分类", type: "expense" },
    { id: "c-other-e", name: "其他", type: "expense" },
    { id: "c-other-i", name: "其他", type: "income" },
  ],
  accounts: [
    { id: "a-cmb", name: "招行" },
    { id: "a-cash", name: "现金" },
    { id: "a-citic", name: "中信" },
  ],
  tags: [
    { id: "t-hm", name: "盒马" },
    { id: "t-fresh", name: "生鲜" },
    // 软删标签也进池：M3 的查找表若只给活跃标签，这条案例会退化成 not_found；
    // 放进来才能测「两侧的标签过滤子查询都不查 is_deleted」这条对称性。
    { id: "t-dead", name: "盒马已删标签" },
  ],
  members: [
    { id: "u-me", name: "我" },
    { id: "u-wife", name: "老婆" },
  ],
};

/** 固定 now：跨零点跑测试不会偶发失败；本文件的案例都显式给 from/to，不依赖它 */
const NOW = new Date(2026, 5, 15, 12, 0, 0);

interface ParityCase {
  name: string;
  dsl: AiQuery;
  /** 手工推导的黄金命中集合（升序）。推导见各案例注释，逐笔来自 SEED。 */
  ids: string[];
  /** 只给「不带日期」的案例：deriveFullRange 派生出的区间两端（本地日） */
  appliedDates?: [string, string];
}

const MARCH = { from: "2026-03-01", to: "2026-03-31" } as const;

/** 三月、L1、未软删的全部命中（C2 与 C21 共用） */
const MARCH_ALL = ["x1", "x10", "x11", "x12", "x18", "x19", "x2", "x3", "x4", "x5", "x6", "x9"];

const CASES: ParityCase[] = [
  {
    name: "C1 不限时间（runQuery 走 deriveFullRange 派生区间）",
    dsl: { aggregate: "sum" },
    // L1 未删 17 笔全部命中；区间两端 = x15（本地 2025-12-31 23:59:59）与 x14（本地 2026-04-01 00:30）
    ids: ["x1", "x10", "x11", "x12", "x13", "x14", "x15", "x16", "x17", "x18", "x19", "x2", "x3", "x4", "x5", "x6", "x9"],
    appliedDates: ["2025-12-31", "2026-04-01"],
  },
  {
    name: "C2 三月整月（含 3/1 00:00:00.000 与 3/31 23:59:59.999 两个边界时刻）",
    dsl: { aggregate: "sum", date: MARCH },
    // 三月内 L1 未删；x13 在 2/28、x14 在 4/1、x15/x16/x17 在区间外，都被排除
    ids: MARCH_ALL,
  },
  {
    name: "C3 单日 3/1（月初，且该笔金额为 0）",
    dsl: { aggregate: "sum", date: { from: "2026-03-01", to: "2026-03-01" } },
    ids: ["x5"],
  },
  {
    name: "C4 单日 3/31（月末最后一毫秒）",
    dsl: { aggregate: "sum", date: { from: "2026-03-31", to: "2026-03-31" } },
    ids: ["x6"],
  },
  {
    name: "C5 跨月 2/25 ~ 3/5（含 2/28 23:59:59.999）",
    dsl: { aggregate: "sum", date: { from: "2026-02-25", to: "2026-03-05" } },
    // x13 落在 2/28 23:59:59.999、x5 在 3/1、x1 在 3/2、x3 在 3/5；x17 在 2/10 出区间
    ids: ["x1", "x13", "x3", "x5"],
  },
  {
    name: "C6 年初年末 2025-12-31 ~ 2026-01-01",
    dsl: { aggregate: "sum", date: { from: "2025-12-31", to: "2026-01-01" } },
    ids: ["x15", "x16"],
  },
  {
    name: "C7 不带日期 + type=transfer（派生区间 + 转账桶可见）",
    dsl: { aggregate: "sum", type: "transfer" },
    // x4 / x17 两笔转账；转账必须进 matched 但不进收支（这一点由断言 3 的可见性钉住）
    ids: ["x17", "x4"],
    appliedDates: ["2025-12-31", "2026-04-01"],
  },
  {
    name: "C8 type=income，三月",
    dsl: { aggregate: "sum", date: MARCH, type: "income" },
    ids: ["x19", "x3"],
  },
  {
    name: "C9 type=expense，三月（转账被排除在命中之外）",
    dsl: { aggregate: "sum", date: MARCH, type: "expense" },
    ids: ["x1", "x10", "x11", "x12", "x18", "x2", "x5", "x6", "x9"],
  },
  {
    name: "C10 标签「盒马」：x1 挂 2 个活跃标签（扇出/GROUP BY 语义）",
    dsl: { aggregate: "sum", date: MARCH, tags: ["盒马"] },
    ids: ["x1", "x6"],
  },
  {
    name: "C11 标签交集「盒马 + 生鲜」：必须同时拥有（AND 而非 OR）",
    dsl: { aggregate: "sum", date: MARCH, tags: ["盒马", "生鲜"] },
    ids: ["x1"],
  },
  {
    name: "C12 按软删标签 id 过滤：两侧的过滤子查询都不查 is_deleted（对称）",
    dsl: { aggregate: "sum", date: MARCH, tags: ["盒马已删标签"] },
    ids: ["x12"],
  },
  {
    name: "C13 按软删分类 id 过滤：两侧都不查 is_deleted（对称）",
    dsl: { aggregate: "sum", date: MARCH, categories: ["已删分类"] },
    ids: ["x9"],
  },
  {
    name: "C14 两个同名「其他」分类：type=income 消歧到收入那个",
    dsl: { aggregate: "sum", date: MARCH, type: "income", categories: ["其他"] },
    ids: ["x19"],
  },
  {
    name: "C15 merchant=盒马：备注命中 + 活跃标签名命中，软删标签名不算",
    dsl: { aggregate: "sum", date: MARCH, merchant: "盒马" },
    // x1（备注+标签）、x2（备注）、x6（标签 t-hm，备注「生鲜采购」不含关键词）；
    // x12 只挂软删标签 t-dead，名字含关键词但必须被 sq_tg.is_deleted = 0 挡住
    ids: ["x1", "x2", "x6"],
  },
  {
    name: "C16 merchant=50%：% 是字面量而不是通配符",
    dsl: { aggregate: "sum", date: MARCH, merchant: "50%" },
    // 转义失效时模式 `%50%%` 仍要求含 "50"，会把 x11（满50减10）也吞进来 → 这条能分辨
    ids: ["x10"],
  },
  {
    name: "C17 merchant=50：普通子串（对照 C16）",
    dsl: { aggregate: "sum", date: MARCH, merchant: "50" },
    ids: ["x10", "x11"],
  },
  {
    name: "C18 account=招行：from 或 to 命中任一侧即可",
    dsl: { aggregate: "sum", date: MARCH, account: "招行" },
    // 三月内 from/to 命中 a-cmb 的：x19(to) 也算；x18 走 a-citic、x5 走 a-cash，不算
    ids: ["x1", "x10", "x11", "x12", "x19", "x2", "x3", "x4", "x6", "x9"],
  },
  {
    name: "C19 members=[老婆]",
    dsl: { aggregate: "sum", date: MARCH, members: ["老婆"] },
    ids: ["x2"],
  },
  {
    name: "C20 金额区间 [50, 100]：两端恰好等于 x6(50) 与 x1(100)",
    dsl: { aggregate: "sum", date: MARCH, amount: { min: 50, max: 100 } },
    // 三月内金额落在闭区间 [50,100] 的：x6 50、x10 60、x9 70、x12 90、x1 100
    ids: ["x1", "x10", "x12", "x6", "x9"],
  },
  {
    name: "C21 amountMin=0（0 是有效下界，两侧都必须把它当条件而不是「没给」）",
    dsl: { aggregate: "sum", date: MARCH, amount: { min: 0 } },
    // ⚠️ 口径边界：金额恒存正数，所以「丢掉 >= 0」与「留下它」结果集**相同**。
    // 本条**抓不住**「某一侧把 0 当没给」这个变异（它由 TransactionList.filterParams.test.ts
    // 的 amountMin=0 与 querySql.summary.test.ts:164 的 buildWhere 守卫分别守）。
    // 留在这里的价值是：证明 0 这个值走完整条链路**不会让两侧分叉**（例如被 stringify 成 ""）。
    ids: MARCH_ALL,
  },
  {
    name: "C22 七条件叠加：日期+类型+账户+分类+标签+成员+商户+金额",
    dsl: {
      aggregate: "sum",
      date: MARCH,
      type: "expense",
      account: "招行",
      categories: ["买菜"],
      tags: ["盒马"],
      members: ["我"],
      merchant: "盒马",
      amount: { min: 50, max: 100 },
    },
    // x1 100 元全中；x6 50 元全中（标签名命中）；x2 无标签、x10 无标签、x12 挂的是软删标签
    ids: ["x1", "x6"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 两侧的取数
// ─────────────────────────────────────────────────────────────────────────────

function realDb(): DatabaseSync {
  return dbRef.current as DatabaseSync;
}

/**
 * AI 侧的**命中 id 集合**。
 *
 * 走的全是真身：`validateQuery` → `resolveFilter` → `buildWhere`（与 `buildSummarySql`
 * 内部调的是同一个函数、同一份 `ResolvedFilter`），然后把真 SQL 交给真库执行。
 * 为什么不从 `runQuery` 拿：它只返回 `applied`（回显引用）与整形后的数字，
 * **不返回 `resolved`**，所以命中的 id 只能这样取；这也是"同一份 WHERE"的最直接证据。
 */
function aiHitIds(dsl: AiQuery): string[] {
  const v = validateQuery(dsl);
  if (!v.ok) throw new Error(`夹具 DSL 不合法：${JSON.stringify(v.errors)}`);
  const r = resolveFilter(v.query, CTX, NOW);
  if (!r.ok) throw new Error(`夹具里的名字未解析：${JSON.stringify(r.errors)}`);
  const where = buildWhere("L1", r.resolved);
  const rows = realDb()
    .prepare(`SELECT t.id FROM transactions t${where.sql}`)
    .all(...where.params) as unknown as { id: string }[];
  return rows.map((row) => row.id);
}

/** 列表侧真实返回的行（只取断言要用的三列） */
interface ListRow {
  id: string;
  type: TransactionType;
  amount: number;
}

/** 列表侧：真组件 → 真 buildFetchOpts → 真 fetchAll → 真 QUERY → 同一个真库 */
async function listRowsForCase(query: Record<string, string>): Promise<ListRow[]> {
  setActivePinia(createPinia());
  routeQuery.value = query;
  const store = useTransactionStore();
  const wrapper = mount(TransactionList, { global: { stubs: { RouterLink: true } } });
  // flushPromises 是宏任务，onMounted 里那条 await 链（含真实 db.select）会跑完
  await flushPromises();
  const rows = store.transactions.map((t) => ({ id: t.id, type: t.type, amount: t.amount }));
  wrapper.unmount();
  return rows;
}

function sorted(xs: string[]): string[] {
  return [...xs].sort();
}

beforeAll(() => {
  dbRef.current = seedDb();
});
afterAll(() => {
  realDb().close();
});

describe("AI 汇总数字 == 流水列表（真实链路常驻护栏）", () => {
  it.each(CASES)("$name", async (c) => {
    // ── AI 侧：真 runQuery
    const out = await runQuery("L1", c.dsl, CTX, NOW);
    if (!out.ok) {
      expect.fail(`${c.name}: runQuery 失败 ${JSON.stringify(out.failure)}（夹具的 DSL / 查找表不对）`);
    }

    const query = appliedToQuery(out.applied);

    // ── 断言 4：写方永不产出 uncategorized（读方独有参数，混进去会让列表被静默套上当月限制）。
    // 放在最前面是**刻意的**：这条键一旦出现，列表会被额外过滤，后面三条断言会一起红，
    // 于是「变异红在了别的断言上」，看不出是这条守卫在起作用。先判它，归因才正确。
    expect(Object.keys(query), `${c.name}: appliedToQuery 产出了 uncategorized`).not.toContain("uncategorized");

    const listRows = await listRowsForCase(query);
    const aiIds = aiHitIds(c.dsl);
    const listIds = listRows.map((r) => r.id);

    // ── 断言 1：matched == 列表行数（列表无分页，所以就是总数）
    expect(out.result.matched, `${c.name}: matched 与列表行数不等`).toBe(listRows.length);

    // ── 断言 2：命中 id 集合逐 id 相等
    // （不另立一条 `aiIds.length === matched`：它由下面两条**逻辑蕴含**
    //   ——`|列表| == matched` 且 `列表集合 == AI 集合` ⇒ `|AI 集合| == matched`，
    //   而实测任何单侧变异都会先打红上面那条，它永远不会是第一个说话的人。）
    expect(sorted(listIds), `${c.name}: 列表命中的 id 集合与 AI 不符`).toEqual(sorted(aiIds));
    // …并且与手工推导的黄金集合一致（防「两边一起被改错」与「夹具写空」两种假绿）
    expect(sorted(listIds), `${c.name}: 与手工推导的黄金命中集合不符`).toEqual(sorted(c.ids));

    // ── 断言 3：三个桶的 total == 列表行按 type 分组求和；且桶的可见性由 type 决定
    const txType = c.dsl.type ?? null;
    const visible = (bucket: TransactionType): boolean =>
      txType === null ? bucket !== "transfer" : txType === bucket;
    const sumOf = (bucket: TransactionType): number =>
      round2(listRows.filter((r) => r.type === bucket).reduce((acc, r) => acc + r.amount, 0));
    expect(
      {
        expense: out.result.expense?.total ?? null,
        income: out.result.income?.total ?? null,
        transfer: out.result.transfer?.total ?? null,
      },
      `${c.name}: summary 桶与列表行按 type 求和不等`,
    ).toEqual({
      expense: visible("expense") ? sumOf("expense") : null,
      income: visible("income") ? sumOf("income") : null,
      transfer: visible("transfer") ? sumOf("transfer") : null,
    });

    // ── 附加：不定时间时派生区间必须显式带上（否则跳转后被首页「默认当月」悄悄改写）
    if (c.appliedDates) {
      expect([query.dateFrom, query.dateTo], `${c.name}: 派生区间不对`).toEqual(c.appliedDates);
    }
  });
});
