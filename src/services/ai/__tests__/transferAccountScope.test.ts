// 转账两侧的账户口径（人类确认：**转出必须本人账户，转入可以用所有人的账户**，
// 依据 `RecordPage.vue:58-66`：转账的 from 侧 `scope="own"`、to 侧 `scope="all"`）。
//
// 上一轮把账户池整体收窄成 own-only（修同名「现金」解析歧义），那对**转出**是对的，
// 对**转入**是收紧过度的：转入别人的账户（还钱给同事、转给家人的卡）是手动记账本来就允许的。
// 本文件钉三件事：
//   ① 转出别人的账户 ⇒ 解析不到、工具失败（本人账户才行）；
//   ② 转入别人的账户 ⇒ 成功，且落到**那个人**的账户（不是被包含匹配吞到我的同名账户上）；
//   ③ 转入写了一个"我名下也有的裸名字"、而别人名下同名 ⇒ 反问（不许猜），
//      写成带归属的全名（快照里那一组印的名字）或"我的现金"则能唯一匹配。
//
// ⚠️ 真 `node:sqlite`：本缺陷死在"用哪个池"（SQL + 归属标注）上，mock 掉 select 证明不了过滤真的生效。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";

const state = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/db/userDb", () => ({
  getUserDb: () => state.db as never,
}));

import { buildLookupContext, executeTool, type ToolContext } from "@/services/ai/tools";

const LEDGER_ID = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const CAT_FOOD = "3f4a1b2c-9d8e-4f5a-b6c7-8d9e0f1a2b3c";
const CAT_SALARY = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const ACC_MINE = "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f";
/** 本人的第二个账户：转账的转出侧用它，才不会撞上"转出=转入"那条规则 */
const ACC_MINE_BANK = "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const ACC_MING = "3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a";
const ACC_MING_SAFE = "4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b";
/** 当前用户（团队账本里的"我"） */
const ME = "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
/** 另一位成员（小明） */
const MING = "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c";

/** 成员表（store 的 `memberTable()` 形态：真 id + 显示名）——别人的账户名靠它加归属 */
const MEMBERS = [
  { userId: ME, name: "我" },
  { userId: MING, name: "小明" },
];

const NOW = new Date(2026, 2, 15, 12, 0, 0);

const SCHEMA = `
  CREATE TABLE categories (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE accounts (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, owner_id TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE tags (id TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, name TEXT NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
`;

function useRealDb(accounts: { id: string; name: string; ownerId: string }[]): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  sqlite.exec(
    `INSERT INTO categories VALUES ('${CAT_FOOD}', '${LEDGER_ID}', '买菜', 'expense', 0);` +
      `INSERT INTO categories VALUES ('${CAT_SALARY}', '${LEDGER_ID}', '工资', 'income', 0);`,
  );
  const insert = sqlite.prepare(
    "INSERT INTO accounts (id, ledger_id, name, owner_id, is_deleted) VALUES (?, ?, ?, ?, 0)",
  );
  for (const a of accounts) insert.run(a.id, LEDGER_ID, a.name, a.ownerId);
  state.db = {
    select: (sql: string, params: unknown[] = []): Promise<unknown[]> =>
      Promise.resolve(sqlite.prepare(sql).all(...(params as never[])) as unknown[]),
    execute: (): never => {
      throw new Error("不变式链路不该写库（本文件只走读路径）");
    },
  };
  return sqlite;
}

function ctx(lookup: Awaited<ReturnType<typeof buildLookupContext>>): ToolContext {
  return { ledgerId: LEDGER_ID, lookup, now: NOW, refIndex: 1 };
}

/** 团队账本下当前用户视角的解析表（生产路径 = store 注入 currentUserId 后由 agent 组装） */
function teamLookup(): Promise<Awaited<ReturnType<typeof buildLookupContext>>> {
  return buildLookupContext(LEDGER_ID, MEMBERS, { kind: "team", viewerUserId: ME });
}

function transfer(fromAccount: string, toAccount: string): Record<string, unknown> {
  return { type: "transfer", amount: 100, fromAccount, toAccount };
}

function errorOf(out: Awaited<ReturnType<typeof executeTool>>): string {
  if (out.ok) throw new Error(`本该失败，却成功了：${out.content}`);
  return out.error;
}

let opened: DatabaseSync[] = [];

beforeEach(() => {
  state.db = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const db of opened) db.close();
  opened = [];
  state.db = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ① 转出：只能本人账户（回归护栏）
// ---------------------------------------------------------------------------

describe("转出（fromAccount）只认本人账户", () => {
  it("① 转出别人名下的账户 ⇒ 解析不到、工具失败", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_MING_SAFE, name: "小金库", ownerId: MING },
      ]),
    );
    const lookup = await teamLookup();

    const out = await executeTool(
      "create_transaction_draft",
      transfer("小金库", "现金"),
      ctx(lookup),
    );

    // 改哪一行能让它红：把 `resolveDraftNames` 的 **from** 侧也换成合并池
    // （`accountsForTransferIn(lookup)`）⇒ 小明的「小金库」当场解析成功、本用例红。
    const error = errorOf(out);
    expect(error).toContain("没能对上账本");
    expect(error).toContain("小金库");
    expect(out.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ② 转入：可以用所有人的账户
// ---------------------------------------------------------------------------

describe("转入（toAccount）允许非本人账户", () => {
  it("② 转入别人名下的账户 ⇒ 成功，且落到**那个人**的账户（不被同名包含匹配吞掉）", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_MINE_BANK, name: "招行", ownerId: ME },
        { id: ACC_MING, name: "现金", ownerId: MING },
      ]),
    );
    const lookup = await teamLookup();
    // 别人的账户在解析表里的名字带归属（与提示词快照那一组逐字相同）
    expect(lookup.otherAccounts).toEqual([{ id: ACC_MING, name: "小明的现金", baseName: "现金" }]);

    const out = await executeTool(
      "create_transaction_draft",
      transfer("招行", "小明的现金"),
      ctx(lookup),
    );

    // 改哪一行能让它红：`resolveDraftNames` 的 to 侧只用 `ctx.lookup.accounts`（本人池）
    // ⇒ 修复前「小明的现金」会被包含匹配吞到我的「现金」上（toAccountId = ACC_MINE），
    // 或者干脆解析失败 —— 两条路都让下面第一条断言红。
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const draft = (out.payload as { drafts: { resolved: { fromAccountId: string; toAccountId: string } }[] })
      .drafts[0]!;
    expect(draft.resolved.fromAccountId).toBe(ACC_MINE_BANK);
    expect(draft.resolved.toAccountId).toBe(ACC_MING);
  });
});

// ---------------------------------------------------------------------------
// ③ 转入同名且没说清归属：反问，不猜
// ---------------------------------------------------------------------------

describe("转入同名账户：没说清归属就反问", () => {
  it("③ 只写裸名字「现金」而小明名下也有「现金」⇒ 失败，候选里两条都带上归属", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_MINE_BANK, name: "招行", ownerId: ME },
        { id: ACC_MING, name: "现金", ownerId: MING },
      ]),
    );
    const lookup = await teamLookup();

    const out = await executeTool("create_transaction_draft", transfer("招行", "现金"), ctx(lookup));

    // 改哪一行能让它红：把 `transferInAmbiguity`（同名保护）删掉 ⇒ 裸名字会安静地落到
    // **我的**现金上（修复前就是"被包含匹配吞掉"的另一副面孔），out.ok 变 true。
    const error = errorOf(out);
    expect(error).toContain("现金");
    expect(error).toContain("小明的现金"); // 候选里带归属 ⇒ 模型能反问出"你的还是小明的"
    expect(out.ok).toBe(false);
  });

  it("guard：写成「我的现金」（说了归属）⇒ 落到本人账户，不判歧义", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_MINE_BANK, name: "招行", ownerId: ME },
        { id: ACC_MING, name: "现金", ownerId: MING },
      ]),
    );
    const lookup = await teamLookup();

    const out = await executeTool("create_transaction_draft", transfer("招行", "我的现金"), ctx(lookup));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const draft = (out.payload as { drafts: { resolved: { toAccountId: string } }[] }).drafts[0]!;
    expect(draft.resolved.toAccountId).toBe(ACC_MINE);
  });

  it("guard：小明名下没有同名账户时，裸名字「现金」照旧落到本人账户", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_MINE_BANK, name: "招行", ownerId: ME },
        { id: ACC_MING_SAFE, name: "小金库", ownerId: MING },
      ]),
    );
    const lookup = await teamLookup();

    const out = await executeTool("create_transaction_draft", transfer("招行", "现金"), ctx(lookup));

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const draft = (out.payload as { drafts: { resolved: { toAccountId: string } }[] }).drafts[0]!;
    expect(draft.resolved.toAccountId).toBe(ACC_MINE);
  });

  it("guard：**收入**的入账方只能是自己名下的（`RecordPage:61` 的 all 只给转账 to 侧）", async () => {
    opened.push(
      useRealDb([
        { id: ACC_MINE, name: "现金", ownerId: ME },
        { id: ACC_MING, name: "现金", ownerId: MING },
      ]),
    );
    const lookup = await teamLookup();

    const out = await executeTool(
      "create_transaction_draft",
      { type: "income", amount: 100, category: "工资", toAccount: "小明的现金" },
      ctx(lookup),
    );

    // 改哪一行能让它红：把 `toAccountLookup` 的类型判断去掉（转账/收入共用一个合并池）
    // ⇒ 小明的账户会进收入的候选池，包含匹配不再落到本人那条。
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const draft = (out.payload as { drafts: { resolved: { toAccountId: string } }[] }).drafts[0]!;
    expect(draft.resolved.toAccountId).toBe(ACC_MINE);
  });
});
