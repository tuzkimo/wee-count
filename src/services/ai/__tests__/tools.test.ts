import { describe, it, expect, vi, beforeEach } from "vitest";

// 只 mock 唯一碰 DB 的那一层（照 runQuery.test.ts 的写法）。
// 本文件跑的是**真的** runQuery（不是 mock 掉它）：任务 3 的交付物是"把 M1 的结果压成
// 给模型的形状"，用 mock 掉 runQuery 的方式测，就变成"测自己的 mock"。
// 真正不可替代的两条断言（⑦ 不额外过滤转账、② truncated 原样带上）都必须落在
// runQuery 真正产出的对象上，所以这里用 mockDb 喂行、让 M1 自己算。
const mockDb = { select: vi.fn(), execute: vi.fn() };

vi.mock("@/db/userDb", () => ({
  getUserDb: vi.fn(() => mockDb),
}));

import {
  MAX_PROMPT_ITEMS,
  TOOLS,
  buildLookupContext,
  executeTool,
  type ToolContext,
  type ToolOutcome,
} from "@/services/ai/tools";
import { AI_QUERY_MAX_ITEMS } from "@/services/ai/dsl";
import type { LookupContext } from "@/services/ai/resolve";

// ---------------------------------------------------------------------------
// fixture：所有 id 都是**真 UUID**。
//
// 刻意不用 "c-food" 这种短串：§7.3 的隐私断言是"发给模型的内容里不许出现 id"，
// 若 fixture 里的 id 不是 UUID 形状，那条断言对任何实现都恒真（空转）。
// 这份 fixture 同时喂 lookup（→ applied/chips 里带 id）与 DB 行，让"顺手把
// applied 或账本 id 塞进 content"的实现一定红。见「隐私边界」一节。
// ---------------------------------------------------------------------------
const LEDGER_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const CAT_FOOD = "3f4a1b2c-9d8e-4f5a-b6c7-8d9e0f1a2b3c";
const CAT_SALARY = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const ACC_CMB = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
const ACC_WECHAT = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";
const TAG_FRESH = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
const MEMBER_WIFE = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

const LOOKUP: LookupContext = {
  categories: [
    { id: CAT_FOOD, name: "买菜", type: "expense" },
    { id: CAT_SALARY, name: "工资", type: "income" },
  ],
  accounts: [
    { id: ACC_CMB, name: "招行储蓄卡" },
    { id: ACC_WECHAT, name: "微信零钱" },
  ],
  tags: [{ id: TAG_FRESH, name: "生鲜" }],
  members: [{ id: MEMBER_WIFE, name: "老婆" }],
};

const NOW = new Date(2026, 2, 2, 12, 30);

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { ledgerId: LEDGER_ID, lookup: LOOKUP, now: NOW, refIndex: 1, ...over };
}

const emptyRow = {
  expense_total: 0,
  expense_count: 0,
  income_total: 0,
  income_count: 0,
  transfer_total: 0,
  transfer_count: 0,
  matched: 0,
};

function itemRow(i: number) {
  return {
    day: `2026-03-${String((i % 28) + 1).padStart(2, "0")}`,
    amount: 10 + i,
    type: "expense" as const,
    category_name: "买菜",
    from_account_name: "招行储蓄卡",
    to_account_name: null,
    note: `第${i}笔`,
  };
}

interface Bucket {
  total: number;
  count: number;
  avg: number;
}
interface ParsedContent {
  summary: {
    expense: Bucket | null;
    income: Bucket | null;
    transfer: Bucket | null;
    net: number | null;
    matched: number;
  };
  groups: { label: string; expense: number; income: number; transfer: number; count: number }[] | null;
  items:
    | {
        date: string;
        amount: number;
        type: string;
        category: string | null;
        fromAccount: string | null;
        toAccount: string | null;
        note: string | null;
      }[]
    | null;
  truncated: boolean;
  refs: Record<string, string | number>;
  /** 工具自己写给模型的"这份 refs 有哪些键、各是什么"的说明（F1/F3/F7 的主战场） */
  refsNote: string;
}

/** 只有成功分支有 content；失败分支给模型的是 error。两者都是"模型读到的文本" */
function modelText(out: ToolOutcome): string {
  return out.ok ? out.content : out.error;
}

/**
 * 从 `refsNote` 里抽出它提到的每一个 `refs` 键。
 *
 * 注意 note 里写的是**裸键**（`q1.total`）而不是 `{{q1.total}}`：带花括号的写法会让
 * 将来任何对 note 做 `fillRefs` 的实现在用户面前漏出占位符。取值类文本（分组的
 * `label` 回填后是"买菜"）不会被这个正则抽到，所以断言仍然只落在**键**上。
 */
function noteRefs(note: string): string[] {
  return [...note.matchAll(/(?<![A-Za-z0-9_])q\d+(?:\.[A-Za-z0-9_]+)*/g)].map((m) => m[0]);
}

/** 分组键 `q1.g0.total` 的取值也要能被 `fillRefs` 找到（F7） */
function noteGroupRefs(note: string): string[] {
  return noteRefs(note).filter((k) => /\.g\d+\./.test(k));
}

function noteAggRefs(note: string): string[] {
  return noteRefs(note).filter((k) => !/\.g\d+\./.test(k));
}

function contentOf(out: ToolOutcome): ParsedContent {
  if (!out.ok) throw new Error(`预期成功，实际失败：${out.error}`);
  return JSON.parse(out.content) as ParsedContent;
}

/** payload 是**本地**用的结构化结果（带 id）；content 是给模型的。两者一起断才有意义 */
function payloadOf(out: ToolOutcome): unknown {
  if (!out.ok) throw new Error(`预期成功，实际失败：${out.error}`);
  return out.payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 与 runQuery.test.ts 同一条纪律：execute 一旦被调用就当场抛，红要红在
  // "AI 越权写库"这个原因上，而不是崩在下游某个 undefined 上。
  mockDb.execute.mockImplementation(() => {
    throw new Error("tools 越权调用了 db.execute：AI 只能读 + 生成草稿，绝不写库");
  });
});

describe("① query_transactions 的 refs 编号来自注入的 refIndex", () => {
  it("键形如 q<refIndex>.total / .count（不是写死的 q1）", async () => {
    mockDb.select.mockResolvedValueOnce([
      { ...emptyRow, expense_total: 128, expense_count: 3, matched: 3 },
    ]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", type: "expense", date: { preset: "thisMonth" } },
      ctx({ refIndex: 7 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.refs["q7.total"]).toBe(128);
    expect(out.refs["q7.count"]).toBe(3);
    expect(out.refs["q7.avg"]).toBe(42.67);
    // 编号必须完全来自注入：q1.total 不该存在（编排循环第二次调用时它会把
    // 第二次的数字覆盖掉第一次的引用，是**静默错数字**）
    expect(Object.keys(out.refs).some((k) => k.startsWith("q1."))).toBe(false);
    // 键要出现在给模型的内容里，否则模型无从知道能用哪些引用
    expect(out.content).toContain("q7.total");
  });

  it("ctx.now 是相对日期的锚点（不是跑测试那天）", async () => {
    mockDb.select.mockResolvedValueOnce([emptyRow]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "today" } },
      ctx({ now: new Date(2026, 2, 2, 12, 30) }),
    );
    expect(out.ok).toBe(true);
    // 芯片（payload.chips）里的日期是解析后的结果，它只能由注入的 now 推出来
    expect(JSON.stringify(payloadOf(out))).toContain("2026-03-02");
  });
});

describe("② 明细上限 20 条，且两层截断都如实上报", () => {
  it("前提守卫：M1 取数上限 ≤ 我们发给模型的上限（否则 slice 会静默丢条）", () => {
    expect(MAX_PROMPT_ITEMS).toBe(20);
    // 隐私边界的一半：§7.3「最多 20 条明细」是**发出去**的上限。
    // 它今天与 M1 的取数上限同值，但不是同一件事：M1 那个是"SQL 取多少行"，
    // 这个常量是"最多发给模型几条"。
    //
    // ⚠️ 方向必须是这一侧（审查 F2：旧版写成 `MAX_PROMPT_ITEMS <= AI_QUERY_MAX_ITEMS`
    // 是**反的**，它在"M1 取数多于我们发的"这个唯一危险状态下为真 ⇒ 永远红不了 ⇒
    // 是一条"空的保护"）。要保护的不变式是：M1 取到的行数 ≤ 我们发的上限
    // （`items.length <= AI_QUERY_MAX_ITEMS` + `AI_QUERY_MAX_ITEMS <= MAX_PROMPT_ITEMS`
    // ⇒ `slice(0, MAX_PROMPT_ITEMS)` 不丢东西）。M1 若把 `AI_QUERY_MAX_ITEMS` 放宽到
    // 超过本常量，这一条必须红 —— 实测：dsl.ts:63 20→30 时红在这里（见交付报告）。
    expect(AI_QUERY_MAX_ITEMS).toBeLessThanOrEqual(MAX_PROMPT_ITEMS);
    // 「这条守卫本身能被触发」由上面的不等式直接给出：把 dsl.ts 的上限改到 21 以上即红。
    // 不写 `expect(true).toBe(true)` 之类的空转来"证明"它在场。
  });

  it("喂 30 条明细 → content 里只有 20 条（slice 真的按上限截断）", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 300, expense_count: 30, matched: 30 }])
      .mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => itemRow(i)));
    const out = await executeTool(
      "query_transactions",
      { aggregate: "list", type: "expense", date: { preset: "thisMonth" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(c.items).toHaveLength(20);
    // 前 20 条按原顺序，不是重排/随机
    expect(c.items?.[0].note).toBe("第0笔");
    expect(c.items?.[19].note).toBe("第19笔");
  });

  it("本层砍掉了明细时 truncated 必须为 true（不许对模型说'这份明细是完整的'）", async () => {
    // ⚠️ 这条是**产品语义**，不是"透传"：M1 的判据 `matched > items.length` 对
    // "我们砍掉的 10 条"一无所知 ⇒ 旧实现报 `false`，模型于是相信手里是全部明细。
    // 喂 30 条行、matched=30 ⇒ 本层 slice 丢掉 10 条 ⇒ 必须 true。
    // （生产链路上 M1 自带 LIMIT 20，不会出现 >20 条；这条 fixture 刻意越过上限，
    //   同时由上面那条前提守卫保证"M1 放宽后这条推理仍然成立"。）
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 300, expense_count: 30, matched: 30 }])
      .mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => itemRow(i)));
    const out = await executeTool(
      "query_transactions",
      { aggregate: "list", type: "expense", date: { preset: "thisMonth" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(c.items).toHaveLength(20);
    expect(c.truncated).toBe(true);
  });

  it("M1 自己说 true 时必须仍是 true（防止实现把 truncated 写死成 false）", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 300, expense_count: 30, matched: 30 }])
      .mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => itemRow(i)));
    const out = await executeTool(
      "query_transactions",
      { aggregate: "list", type: "expense", date: { preset: "thisMonth" } },
      ctx(),
    );
    expect(contentOf(out).truncated).toBe(true);
  });

  it("没有明细时 truncated 不因本层的判空而变成 true（items=null 不是'丢光了'）", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, expense_total: 10, expense_count: 1, matched: 1 }]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "thisYear" } },
      ctx(),
    );
    expect(contentOf(out).truncated).toBe(false);
  });
});

/**
 * REF_PROMISES 的键：note 里每个 `{{qN.xxx}}` 都必须能在 `refs` 里查到。
 * 这份清单独立写在这里（不 import 实现里的常量）：它一旦与实现漂移，
 * 「refs 的每个键都被解释了」那条断言就会红。
 */
const PROMISE_KINDS = ["total", "count", "avg", "matched", "net"] as const;

describe("F1 refsNote 只承诺 refs 里真有的键（不许教模型写漏占位符）", () => {
  it("type 省略：note 不得提到没有给键的 transfer 桶", async () => {
    // type 省略时 shapeSummary 把 transfer 置 null（querySql.ts:197）⇒ runQueryTool 不给
    // `qN.transfer.*` 发键；`net` 有值所以有键。旧 note 无条件说"q1.expense / income /
    // transfer.* 是各桶"，模型照它写 `{{q1.transfer.total}}` 就会被 fillRefs 原样漏给用户。
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, matched: 0 }]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(Object.keys(c.refs)).not.toContain("q1.transfer.total");
    expect(c.refsNote).not.toMatch(/q1\.transfer/);
    expect(c.refsNote).toContain("q1.net");
    expect(c.refsNote).toContain("q1.expense.total");
    expect(c.refsNote).toContain("q1.income.total");
  });

  it("type 指定：note 不得提到没有给键的 net；空桶的键也不得被承诺", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 1, matched: 1 }]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", type: "expense", date: { preset: "thisMonth" } },
      ctx({ refIndex: 2 }),
    );
    const c = contentOf(out);
    expect(Object.keys(c.refs)).not.toContain("q2.net");
    expect(c.refsNote).not.toMatch(/q2\.(net|transfer)/);
    expect(c.refsNote).toContain("q2.total");
  });

  it("note 里出现的每个键都在 refs 里（不许承诺任何别的东西）", async () => {
    mockDb.select.mockResolvedValueOnce([
      { ...emptyRow, expense_total: 100, expense_count: 1, income_total: 50, income_count: 1, matched: 2 },
    ]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    // 分组键与聚合键分开看：分组键在 note 里以 `q1.g0` 前缀出现，按完整键比会假红。
    const promised = noteAggRefs(c.refsNote);
    // 防空转：抽不到任何键时下面的循环一条断言都不跑
    expect(promised.length).toBeGreaterThan(0);
    for (const key of promised) {
      expect(Object.keys(c.refs), `note 承诺了 ${key}，但 refs 里没有它`).toContain(key);
    }
    for (const key of noteGroupRefs(c.refsNote)) {
      expect(Object.keys(c.refs), `note 承诺了分组键 ${key}，但 refs 里没有它`).toContain(key);
    }
  });

  it("方向反过来也成立：refs 里每个键都被 note 解释过（新键不许静默出现）", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 10, expense_count: 1, matched: 1 }])
      .mockResolvedValueOnce([itemRow(0)]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "list", type: "expense", date: { preset: "thisMonth" } },
      ctx(),
    );
    const c = contentOf(out);
    const explained = new Set<string>();
    for (const key of Object.keys(c.refs)) {
      // 聚合键（`q1.total`、`q1.expense.count`）在 note 里以完整键出现。
      if (c.refsNote.includes(key)) {
        explained.add(key);
        continue;
      }
      // 分组键（`q1.g0.total`）在 note 里以 `q1.g0` 这个前缀出现（下标逐个写会让
      // 断言与实现的下标规则耦合），所以按前缀匹配。
      const prefix = /\.g\d+\./.test(key) ? key.slice(0, key.lastIndexOf(".")) : "";
      if (prefix !== "" && c.refsNote.includes(prefix)) explained.add(key);
    }
    expect([...explained].sort()).toEqual(Object.keys(c.refs).sort());
    // 非分组键的"说法"必须都在 PROMISE_KINDS 里（新键没有被解释时上面那条已经红，
    // 这条是给"解释文案换了措辞"留的可读失败原因）
    for (const key of Object.keys(c.refs)) {
      if (/\.g\d+\./.test(key)) continue;
      const segments = key.split(".");
      const leaf = segments[segments.length - 1] ?? "";
      expect(PROMISE_KINDS as readonly string[], `${key} 的说法不在 PROMISE_KINDS 里`).toContain(leaf);
    }
  });
});

describe("F3 报「共几笔」用 matched，不用支出桶的 count", () => {
  it("refsNote 明确两者不同，并指向 matched", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, matched: 0 }]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "thisYear" } },
      ctx(),
    );
    const note = contentOf(out).refsNote;
    // ⚠️ 判别力来自**引用的键**而不只是"这句话在"：把实现里的 `.matched` 换成 `.count`
    // 时下面第一条必须红（实测：只断言 `note.toContain(".count")` 会漏掉这个变异）。
    expect(note).toContain("用 .matched");
    expect(note).toContain("含转账");
    expect(note).toContain(".count");
    // 反向：不许把"共几笔"指向 count（那正是 F3 要消灭的用法）
    expect(note).not.toMatch(/几笔」请用 \.count/);
  });
});

// ---------------------------------------------------------------------------
// 分组：F6（隐私）与 F7（旗舰问题能不能写出合法引用）
// ---------------------------------------------------------------------------

/** 前 8 位恰好是 `deadbeef`（runQuery 的兜底长度），完整是 UUID 形状 */
const MEMBER_STRANGER = "deadbeef-0000-4000-8000-000000000000";

function groupRow(key: string): {
  key: string;
  expense_total: number;
  income_total: number;
  transfer_total: number;
  cnt: number;
} {
  return { key, expense_total: 100, income_total: 0, transfer_total: 0, cnt: 1 };
}

describe("F6 groups 逐字段白名单：未解析的成员 id 片段绝不进 content", () => {
  it("label 兜底成 id.slice(0,8) 的成员 → 换成中性标签，片段一个字都不出现", async () => {
    // runQuery.ts:53 的 memberLabel 在 lookup.members 里找不到该 user_id 时兜底
    // `userId.slice(0, 8)` —— **8 位十六进制片段也是 id 片段**（§7.3：绝不发 id）。
    // 今天漏出去的形态恰好躲过所有断言：UUID_RE 看不见 8 位短串、账本 id 也不出现。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 200, expense_count: 2, matched: 2 }])
      .mockResolvedValueOnce([groupRow("老婆"), groupRow(MEMBER_STRANGER)]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", groupBy: "member", limit: 12, date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(c.groups?.map((g) => g.label)).toEqual(["老婆", "未知成员"]);
    // 片段（前 8 位）与完整 UUID 都不得出现
    // ⚠️ 用 `modelText(out)` 而不是 `out.content`：`contentOf` 只在**函数内部**收窄了
    // 类型，这里 `out` 仍是联合类型（类型门会报 TS2339 —— 上一轮就是这样被抓到的）。
    expect(modelText(out)).not.toContain(MEMBER_STRANGER.slice(0, 8));
    expect(modelText(out)).not.toContain("deadbeef");
    expect(modelText(out)).not.toMatch(UUID_RE);
    // 反空转：确认被替换的是这一项的 label（refs 里的分组名也必须是中性标签）
    expect(c.refs["q1.g1.label"]).toBe("未知成员");
    expect(c.refs["q1.g0.label"]).toBe("老婆");
  });

  it("group 对象只带白名单字段（content 里就是这五个键）", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 100, expense_count: 1, matched: 1 }])
      .mockResolvedValueOnce([groupRow("买菜")]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", groupBy: "category", date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(c.groups?.[0]).toEqual({ label: "买菜", expense: 100, income: 0, transfer: 0, count: 1 });
    // ⚠️ 判别力说明（不装样子）：`toPromptGroups` 的 `pick` 与 M1 的 `shapeGroups`
    // 逐字段清单目前完全相同，所以把它换成 `{...g}` 时本用例**仍然绿**（已实测）。
    // 它真正挡住的形态是"M1 给 AiGroup 加了字段"，那时 `{...g}` 才会漏；这里只能证明
    // "发出去的就是这五个字段"。**F6 第一条用例（中性标签）才是真杀手**。
    expect(Object.keys(c.groups?.[0] ?? {}).sort()).toEqual([
      "count",
      "expense",
      "income",
      "label",
      "transfer",
    ]);
  });
});

describe("F7 分组也有 refs 键（旗舰问题「哪个分类花得最多」必须能写合法引用）", () => {
  it("每个分组给出 q1.g{i}.total / label / count，且与 content.groups 逐项对应", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 300, expense_count: 3, matched: 3 }])
      .mockResolvedValueOnce([
        { key: "买菜", expense_total: 200, income_total: 0, transfer_total: 0, cnt: 2 },
        { key: "未分类", expense_total: 100, income_total: 0, transfer_total: 0, cnt: 1 },
      ]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", groupBy: "category", date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(c.refs["q1.g0.total"]).toBe(200);
    expect(c.refs["q1.g0.label"]).toBe("买菜");
    expect(c.refs["q1.g0.count"]).toBe(2);
    expect(c.refs["q1.g1.total"]).toBe(100);
    // COALESCE 兜底标签（未分类 / 未打标签 / 未知账户）是**真名字**、必须保留：
    // 抹掉它们会让"哪个分类最多"答不出兜底桶，而再查一次 `categories:["未分类"]` 必然 not_found。
    expect(c.refs["q1.g1.label"]).toBe("未分类");
    // 下标耦合：模型按 content.groups 的顺序找 g{i}，所以 refs 的 label 必须与
    // content.groups[i].label 逐项一致（顺序错了就是把 A 分组的总额说成 B 分组的）
    expect(c.groups?.map((g) => g.label)).toEqual(
      c.groups?.map((_g, i) => c.refs[`q1.g${i}.label`]),
    );
  });

  it("refsNote 教模型怎么写分组引用，且提到的每个键都真在 refs 里", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 300, expense_count: 3, matched: 3 }])
      .mockResolvedValueOnce([groupRow("买菜"), groupRow("未分类")]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", groupBy: "category", date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    const groupRefs = noteGroupRefs(c.refsNote);
    // 防空转：抽不到任何分组键时下面的循环一条断言都不跑
    expect(groupRefs.length).toBeGreaterThan(0);
    for (const key of groupRefs) {
      expect(Object.keys(c.refs), `note 教了 ${key}，但 refs 里没有它`).toContain(key);
    }
    expect(groupRefs).toContain("q1.g0.total");
    expect(groupRefs).toContain("q1.g0.label");
    expect(groupRefs).toContain("q1.g0.count");
  });

  it("没有 groupBy 时一个分组键都不给（不给模型空桶去猜）", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, expense_total: 10, expense_count: 1, matched: 1 }]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "thisYear" } },
      ctx(),
    );
    const c = contentOf(out);
    expect(c.groups).toBeNull();
    expect(Object.keys(c.refs).some((k) => /\.g\d+\./.test(k))).toBe(false);
    expect(c.refsNote).not.toMatch(/g\d+\.total/);
  });
});

describe("③ create_transaction_draft 零写入（权限边界的唯一技术保证）", () => {
  const DRAFT_ARGS = {
    type: "expense",
    amount: 128.5,
    category: "买菜",
    fromAccount: "招行储蓄卡",
    occurredAt: "2026-03-02T12:30",
    note: "盒马",
    tags: ["生鲜"],
  };

  it("一次 db.execute 都没有，而且连 db.select 都没有（纯构造）", async () => {
    const out = await executeTool("create_transaction_draft", DRAFT_ARGS, ctx());
    expect(out.ok).toBe(true);
    expect(mockDb.execute).not.toHaveBeenCalled();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("草稿进 payload（本地用，带解析出的 id），名字在 content（给模型，绝不含 id）", async () => {
    const out = await executeTool("create_transaction_draft", DRAFT_ARGS, ctx());
    const payload = payloadOf(out) as {
      drafts: {
        draftId: string;
        draft: {
          type: string;
          amount: number;
          category: string | null;
          fromAccount: string | null;
          toAccount: string | null;
          occurredAt: string;
          note: string | null;
          tags: string[];
        };
        resolved: {
          categoryId: string | null;
          fromAccountId: string | null;
          toAccountId: string | null;
          tagIds: string[];
        };
      }[];
    };
    expect(payload.drafts).toHaveLength(1);
    const { draftId, draft, resolved } = payload.drafts[0];
    expect(draftId).toMatch(UUID_RE);
    expect(draft).toEqual({
      type: "expense",
      amount: 128.5,
      category: "买菜",
      fromAccount: "招行储蓄卡",
      toAccount: null,
      occurredAt: "2026-03-02T12:30",
      note: "盒马",
      tags: ["生鲜"],
    });
    // 名字 → id 的解析复用 resolveFilter（唯一那份匹配器），不在这里重写一份
    expect(resolved).toEqual({
      categoryId: CAT_FOOD,
      fromAccountId: ACC_CMB,
      toAccountId: null,
      tagIds: [TAG_FRESH],
    });
    expect(modelText(out)).toContain("等待用户确认");
    expect(modelText(out)).toContain("不得声称已经记账");
  });

  it("refs 里带上草稿的金额，模型才能写 {{q1.amount}} 而不是自己编数字", async () => {
    const out = await executeTool("create_transaction_draft", DRAFT_ARGS, ctx({ refIndex: 2 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.refs["q2.amount"]).toBe(128.5);
  });

  it("金额 round2（与 RecordPage 同一条规则）", async () => {
    const out = await executeTool(
      "create_transaction_draft",
      { ...DRAFT_ARGS, amount: 128.505 },
      ctx(),
    );
    const payload = payloadOf(out) as { drafts: { draft: { amount: number } }[] };
    expect(payload.drafts[0].draft.amount).toBe(128.51);
  });

  it("occurredAt 省略时用注入的 now 的本地时刻", async () => {
    const { occurredAt: _omitted, ...rest } = DRAFT_ARGS;
    void _omitted;
    const out = await executeTool("create_transaction_draft", rest, ctx());
    const payload = payloadOf(out) as { drafts: { draft: { occurredAt: string } }[] };
    expect(payload.drafts[0].draft.occurredAt).toBe("2026-03-02T12:30");
  });

  it("缺账户时给 missing_account 并让模型反问（不猜账户）", async () => {
    const { fromAccount: _drop, ...rest } = DRAFT_ARGS;
    void _drop;
    const out = await executeTool("create_transaction_draft", rest, ctx());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("missing_account");
    // 候选来自 lookup：模型据此反问用户，而不是自己编一个
    expect(out.error).toContain("微信零钱");
  });

  it("转出与转入相同 → 拒绝（照抄 RecordPage 的措辞）", async () => {
    const out = await executeTool(
      "create_transaction_draft",
      {
        type: "transfer",
        amount: 100,
        fromAccount: "招行储蓄卡",
        toAccount: "招行储蓄卡",
      },
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("转出和转入账户不能相同");
  });

  it("金额为 0 / 负数 / 非数字 → 拒绝（照抄 evaluateExpression 的 >0 规则）", async () => {
    for (const amount of [0, -5, "128"]) {
      const out = await executeTool(
        "create_transaction_draft",
        { ...DRAFT_ARGS, amount },
        ctx(),
      );
      expect(out.ok, `amount=${String(amount)} 必须被拒`).toBe(false);
    }
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("不认识的字段 → 拒绝并列出可用字段（不静默丢掉用户的备注）", async () => {
    // 已知漂移：prompt.ts 的 few-shot 示例 1 教模型用
    //   create_transaction_draft（date={preset:"yesterday"}，category="买菜"，merchant="盒马"，amount=128）
    // 而 §4.2 的草稿字段里既没有 `date` 也没有 `merchant`（是 occurredAt / note）。
    // 这里选择**显式报错**而不是静默忽略：忽略等于把"盒马"这条备注悄悄丢掉。
    // prompt.ts 的修法不归本任务（本任务只允许改它的测试），已上报。
    const out = await executeTool(
      "create_transaction_draft",
      { ...DRAFT_ARGS, merchant: "盒马" },
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("merchant");
    expect(out.error).toContain("note");
  });

  it("名字在账本里不存在 → 复用 resolve 的候选与事实（不猜名字）", async () => {
    const out = await executeTool(
      "create_transaction_draft",
      { ...DRAFT_ARGS, fromAccount: "工行" },
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("招行储蓄卡");
    expect(out.error).toContain("微信零钱");
  });
});

describe("④ not_found 且候选为空时给出明确事实，而不是空候选列表", () => {
  it("账本里一个标签都没有 → 明说「这个账本还没有标签」", async () => {
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", tags: ["生鲜"] },
      ctx({ lookup: { ...LOOKUP, tags: [] } }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("这个账本还没有标签");
    // 解析失败就不查库（M1 的同一条纪律）
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("反向：有标签但名字对不上 → 给的是候选清单，不是「还没有标签」", async () => {
    // 防止实现把"空候选"这句话写成对任何 not_found 都适用的固定文案（那样上一条恒绿）
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", tags: ["不存在"] },
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("生鲜");
    expect(out.error).not.toContain("这个账本还没有标签");
  });

  it("歧义（多个同名候选）→ 让模型反问，不替用户猜", async () => {
    const lookup: LookupContext = {
      ...LOOKUP,
      accounts: [
        { id: ACC_CMB, name: "招行储蓄卡" },
        { id: ACC_WECHAT, name: "招行信用卡" },
      ],
    };
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", account: "招行" },
      ctx({ lookup }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("招行储蓄卡");
    expect(out.error).toContain("招行信用卡");
  });

  it("query 校验失败 → 回错误码与路径（§4.3 的格式错，让模型改一次）", async () => {
    const out = await executeTool("query_transactions", { aggregate: "总数" }, ctx());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("bad_aggregate");
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe("⑤⑥ 未知工具名与坏 JSON 都不抛", () => {
  it("未知工具名 → ok:false，且列出真实存在的工具名", async () => {
    const out = await executeTool("query_transaction", { aggregate: "sum" }, ctx());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("未知工具");
    for (const tool of TOOLS) expect(out.error).toContain(tool.function.name);
  });

  it("arguments 是坏 JSON 字符串 → ok:false，不抛", async () => {
    const out = await executeTool("query_transactions", '{"aggregate":', ctx());
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("JSON");
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("arguments 是 JSON 字符串但内容合法 → 照常执行（模型可能把对象写成字符串）", async () => {
    mockDb.select.mockResolvedValueOnce([{ ...emptyRow, matched: 0 }]);
    const out = await executeTool(
      "query_transactions",
      '{"aggregate":"count","date":{"preset":"thisMonth"}}',
      ctx(),
    );
    expect(out.ok).toBe(true);
  });

  it("arguments 是数组/数字 → 也是可读的错误，不抛", async () => {
    for (const args of [[], 42, null] as unknown[]) {
      const out = await executeTool("query_transactions", args, ctx());
      expect(out.ok, `args=${JSON.stringify(args)}`).toBe(false);
    }
  });

  it("查询内部抛异常（真库错误）时也不冒到编排循环", async () => {
    mockDb.select.mockRejectedValueOnce(new Error("database is locked"));
    const out = await executeTool(
      "query_transactions",
      { aggregate: "sum", date: { preset: "thisMonth" } },
      ctx(),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("database is locked");
  });
});

describe("⑦ type 省略时不得额外过滤转账", () => {
  it("不追加 type 条件，matched（含转账）原样进 content", async () => {
    // 真实 SQLite 在同一份数据上会返回这一行：1 支出 + 1 收入 + 1 转账，matched=3。
    // M3 若自作主张补一个 type="expense"（或 WHERE 里排掉转账），用户会看到
    // "AI 说 5 笔、点进流水页 6 条"（M1 约束 8）。
    mockDb.select
      .mockResolvedValueOnce([
        {
          expense_total: 100,
          expense_count: 1,
          income_total: 50,
          income_count: 1,
          transfer_total: 30,
          transfer_count: 1,
          matched: 3,
        },
      ])
      .mockResolvedValueOnce([
        { min_at: new Date(2026, 0, 1).toISOString(), max_at: new Date(2026, 2, 15).toISOString() },
      ]);
    const out = await executeTool("query_transactions", { aggregate: "sum" }, ctx());
    const c = contentOf(out);
    expect(c.summary.matched).toBe(3);
    expect(c.summary.expense).toEqual({ total: 100, count: 1, avg: 100 });
    expect(c.summary.income).toEqual({ total: 50, count: 1, avg: 50 });
    // type 省略时转账桶按 §4.2 是 null（"没查"不等于"没有"）
    expect(c.summary.transfer).toBeNull();
    expect(c.summary.net).toBe(-50);
    // 语句级：WHERE 里只有账本一个参数 ⇒ 没有额外加 type 条件
    const [summarySql, summaryParams] = mockDb.select.mock.calls[0];
    expect(summaryParams).toEqual([LEDGER_ID]);
    expect(summarySql).not.toContain("t.type =");
  });
});

describe("⑧ buildLookupContext", () => {
  it("DB 为 null ⇒ 四张表全空，不抛", async () => {
    const { getUserDb } = await import("@/db/userDb");
    vi.mocked(getUserDb).mockReturnValueOnce(null);
    const lookup = await buildLookupContext(LEDGER_ID, [{ userId: MEMBER_WIFE, name: "老婆" }]);
    expect(lookup).toEqual({ categories: [], accounts: [], tags: [], members: [] });
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("分类 / 账户 / 标签来自本地表（带账本隔离与软删过滤），成员来自传入参数", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ id: CAT_FOOD, name: "买菜", type: "expense" }])
      .mockResolvedValueOnce([{ id: ACC_CMB, name: "招行储蓄卡" }])
      .mockResolvedValueOnce([{ id: TAG_FRESH, name: "生鲜" }]);
    const lookup = await buildLookupContext(LEDGER_ID, [
      { userId: MEMBER_WIFE, name: "老婆" },
    ]);
    expect(lookup.categories).toEqual([{ id: CAT_FOOD, name: "买菜", type: "expense" }]);
    expect(lookup.accounts).toEqual([{ id: ACC_CMB, name: "招行储蓄卡" }]);
    expect(lookup.tags).toEqual([{ id: TAG_FRESH, name: "生鲜" }]);
    expect(lookup.members).toEqual([{ id: MEMBER_WIFE, name: "老婆" }]);
    expect(mockDb.select).toHaveBeenCalledTimes(3);
    // 三条都必须是"本账本 + 没删"：少任一条件都会把别的账本（或已删）的名字当候选
    for (const [sql, params] of mockDb.select.mock.calls) {
      expect(sql).toContain("ledger_id = ?");
      expect(sql).toContain("is_deleted = 0");
      expect(params).toEqual([LEDGER_ID]);
    }
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it("成员名只来自传入参数（别名规则在调用方，工具层不自己查 team_members）", async () => {
    mockDb.select
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const lookup = await buildLookupContext(LEDGER_ID, []);
    expect(lookup.members).toEqual([]);
    // 三次查询全是"本账本的名字表"，没有第四次（没有偷偷查成员表）
    expect(mockDb.select).toHaveBeenCalledTimes(3);
  });
});

describe("隐私边界：进模型的内容里不许有任何 id（§7.3）", () => {
  it("content 不含 UUID，且账本 id 也不出现——而同样的 id 确实在 payload 里", async () => {
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 10, expense_count: 1, matched: 1 }])
      // 明细行也放一个真 UUID：M1 今天会剥掉它（shapeItems 是白名单），这条 fixture
      // 覆盖的是"上游哪天不剥了 + 我们整行转发"这条路径（见本段第三条用例）。
      .mockResolvedValueOnce([{ ...itemRow(0), id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }]);
    const out = await executeTool(
      "query_transactions",
      {
        aggregate: "list",
        type: "expense",
        categories: ["买菜"],
        account: "招行储蓄卡",
        date: { preset: "thisMonth" },
      },
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const payload = JSON.stringify(out.payload);
    // 非空转的前提：这些 id 真的在本次调用里出现过（applied / chips / lookup），
    // 所以"content 里没有 id"这条断言是**实现主动剥离**的结果，不是 fixture 恰好没有 id。
    expect(payload).toContain(ACC_CMB);
    expect(payload).toContain(CAT_FOOD);
    expect(payload).not.toBe("{}");
    expect(out.content).not.toMatch(UUID_RE);
    expect(out.content).not.toContain(LEDGER_ID);
  });

  it("草稿的 content 同样不含 id（解析出的 id 只在 payload）", async () => {
    const out = await executeTool(
      "create_transaction_draft",
      {
        type: "expense",
        amount: 128.5,
        category: "买菜",
        fromAccount: "招行储蓄卡",
        tags: ["生鲜"],
      },
      ctx(),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(JSON.stringify(out.payload)).toContain(ACC_CMB);
    expect(out.content).not.toMatch(UUID_RE);
    expect(out.content).not.toContain(LEDGER_ID);
  });

  it("明细项是逐字段白名单：M1 行里的额外字段不进 content", async () => {
    // M1 的 shapeItems 已经会剥掉未知列；这里再钉一次"我们这一层也不整行转发"，
    // 因为将来 M1 若给 AiQueryItem 加上 id（芯片跳转要用），展开运算符会把它送给模型。
    mockDb.select
      .mockResolvedValueOnce([{ ...emptyRow, expense_total: 10, expense_count: 1, matched: 1 }])
      .mockResolvedValueOnce([{ ...itemRow(0), id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }]);
    const out = await executeTool(
      "query_transactions",
      { aggregate: "list", type: "expense", date: { preset: "thisMonth" } },
      ctx(),
    );
    const item = contentOf(out).items?.[0] as Record<string, unknown> | undefined;
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "amount",
      "category",
      "date",
      "fromAccount",
      "note",
      "toAccount",
      "type",
    ]);
  });
});
