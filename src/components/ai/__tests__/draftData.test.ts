// ⚠️ 2026-09-24：卡片删除内联编辑（§4.4.3）后，`applyDraftEdit` / `parseEditedAmount` /
// `DraftEditForm` 这些**只为编辑服务**的纯函数与它们的用例一并删除（人工已授权删除编辑绑定用例）。
// 这个文件现在只钉"确认那一刻"的两个入口：`buildDraftData`（字段来源）与 `validateDraft`（必填校验）。
import { describe, it, expect } from "vitest";
import {
  buildDraftData,
  normalizeOccurredAt,
  validateDraft,
} from "@/components/ai/draftData";
import type { AiDraftFields, AiDraftIds } from "@/stores/aiChat";

// 真 UUID：这些 id 会进 `transactionStore.add`，用 "c1" 之类的假串会让"id 从哪来"的断言恒真
const CAT = "c1a7b8c9-0e1f-4a2b-9c3d-4e5f6a7b8c9d";
const FROM = "a1111111-2222-4333-8444-555555555555";
const TO = "a9999999-8888-4777-8666-555555555555";
const LEDGER = "L-edge-0001";

function draft(over: Partial<AiDraftFields> = {}): AiDraftFields {
  return {
    type: "expense",
    amount: 128.5,
    category: "买菜",
    fromAccount: "招行",
    toAccount: null,
    occurredAt: "2026-08-15T09:30",
    note: "盒马",
    tags: ["生鲜"],
    ...over,
  };
}

function ids(over: Partial<AiDraftIds> = {}): AiDraftIds {
  return { categoryId: CAT, fromAccountId: FROM, toAccountId: null, tagIds: ["t-1"], ...over };
}

describe("buildDraftData", () => {
  it("支出：转入账户被强制为 null（照 doSave 的三元，不是原样透传）", () => {
    // resolved 里**故意**放一个 toAccountId：支出不该把它写进去
    const data = buildDraftData(draft(), ids({ toAccountId: TO }), LEDGER, "u-me");
    expect(data).toEqual({
      ledger_id: LEDGER,
      user_id: "u-me",
      type: "expense",
      amount: 128.5,
      category_id: CAT,
      from_account_id: FROM,
      to_account_id: null,
      occurred_at: normalizeOccurredAt("2026-08-15T09:30"),
      tag_ids: ["t-1"],
      note: "盒马",
    });
  });

  it("收入：转出账户为 null、转入用 resolved.toAccountId", () => {
    const data = buildDraftData(
      draft({ type: "income", fromAccount: null, toAccount: "招行", category: "工资" }),
      ids({ fromAccountId: FROM, toAccountId: TO }),
      LEDGER,
      "u-me",
    );
    expect(data.from_account_id).toBeNull();
    expect(data.to_account_id).toBe(TO);
  });

  it("转账：分类强制 null，两个账户都带上", () => {
    const data = buildDraftData(
      draft({ type: "transfer", category: null, toAccount: "现金" }),
      ids({ toAccountId: TO }),
      LEDGER,
      "u-me",
    );
    expect(data.category_id).toBeNull();
    expect(data.from_account_id).toBe(FROM);
    expect(data.to_account_id).toBe(TO);
  });

  it("occurred_at 读回来还是同一个本地时刻（不静默偏一个时区）", () => {
    const data = buildDraftData(draft({ occurredAt: "2026-08-15T09:30" }), ids(), LEDGER, "u-me");
    // 与 `useTransactionForm.doSave:164` 同一手法：本地串 → Date → UTC ISO
    expect(data.occurred_at).toBe(new Date("2026-08-15T09:30").toISOString());
    // 用仓内既有的反向函数读回来必须是原值 —— 这条才是"没偏移时区"的判据
    const back = new Date(data.occurred_at);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const local = `${back.getFullYear()}-${pad(back.getMonth() + 1)}-${pad(back.getDate())}T${pad(back.getHours())}:${pad(back.getMinutes())}`;
    expect(local).toBe("2026-08-15T09:30");
  });

  it("已经是 ISO 的串原样返回（不重复解释）", () => {
    expect(normalizeOccurredAt("2026-08-15T01:30:00.000Z")).toBe("2026-08-15T01:30:00.000Z");
  });

  it("裸日期补午夜（「YYYY-MM-DD」也是合法草稿日期）", () => {
    expect(normalizeOccurredAt("2026-08-15")).toBe(new Date("2026-08-15T00:00").toISOString());
  });
});

describe("validateDraft", () => {
  it("支出缺分类 ⇒ 拒（transactionStore.add 不做这条校验，会静默记出无分类支出）", () => {
    expect(validateDraft(draft(), ids({ categoryId: null }))).not.toBe("");
  });

  it("支出缺转出账户 ⇒ 拒", () => {
    expect(validateDraft(draft(), ids({ fromAccountId: null }))).not.toBe("");
  });

  it("收入缺转入账户 ⇒ 拒", () => {
    expect(validateDraft(draft({ type: "income" }), ids({ toAccountId: null }))).not.toBe("");
  });

  it("转账缺分类不算错（转账本来就没有分类）", () => {
    expect(
      validateDraft(draft({ type: "transfer", category: null }), ids({ categoryId: null, toAccountId: TO })),
    ).toBe("");
  });

  it("完整的支出 ⇒ 放行", () => {
    expect(validateDraft(draft(), ids())).toBe("");
  });
});
