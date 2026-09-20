import { describe, it, expect } from "vitest";
import {
  applyDraftEdit,
  buildDraftData,
  normalizeOccurredAt,
  parseEditedAmount,
  validateDraft,
  type DraftEditForm,
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

// ---------------------------------------------------------------------------
// §4.4 卡片内联可改
// ---------------------------------------------------------------------------

describe("parseEditedAmount（金额：> 0 且 round2，都是 §4.4/§10.7 点名复用的既有规则）", () => {
  it("round2 到分：用户输入的 128.567 不会原样落库", () => {
    // 杀 K1：删掉 `round2(n)`（直接 return n）⇒ 这条红（128.567 ≠ 128.57）
    expect(parseEditedAmount("128.567")).toBe(128.57);
    expect(parseEditedAmount("0.005")).toBe(0.01);
  });

  it("0 与负数都不是合法金额（删掉 `n <= 0` ⇒ 这条红）", () => {
    expect(parseEditedAmount("0")).toBeNull();
    expect(parseEditedAmount("0.00")).toBeNull();
    expect(parseEditedAmount("-5")).toBeNull();
  });

  it("空串（含只有空白）不是 0 而是「没填」", () => {
    expect(parseEditedAmount("")).toBeNull();
    expect(parseEditedAmount("   ")).toBeNull();
  });

  it("不可解析的串 ⇒ null（删掉 `Number.isFinite` ⇒ 这条红：NaN 会漏出去）", () => {
    expect(parseEditedAmount("abc")).toBeNull();
    expect(parseEditedAmount("1e999")).toBeNull(); // Infinity
  });

  it("正常数字原样通过（去掉「用户输入」这层也还是同一口径）", () => {
    expect(parseEditedAmount("128.5")).toBe(128.5);
    expect(parseEditedAmount(" 42 ")).toBe(42);
  });
});

describe("applyDraftEdit（编辑区 → 新草稿 + 新 id）", () => {
  function form(over: Partial<DraftEditForm> = {}): DraftEditForm {
    return {
      amount: "200.555",
      categoryId: CAT,
      fromAccountId: FROM,
      toAccountId: null,
      occurredAt: "2026-09-01T08:15",
      note: " 改了备注 ",
      ...over,
    };
  }

  it("五个字段都改到：金额走 round2、名字与 id 分别落到 draft 与 resolved", () => {
    const r = applyDraftEdit(draft(), ids(), form(), {
      category: "打车",
      fromAccount: "现金",
      toAccount: null,
    });
    if (!r.ok) throw new Error(`不该被拒：${r.error}`);
    expect(r.draft).toEqual({
      type: "expense", // type 不在规格点名的五个字段里 ⇒ 保持不变
      amount: 200.56, // round2
      category: "打车", // 名字来自名表（不是 id）
      fromAccount: "现金",
      toAccount: null,
      occurredAt: "2026-09-01T08:15",
      note: "改了备注", // trim
      tags: ["生鲜"], // 标签不在点名范围内 ⇒ 原样保留
    });
    expect(r.resolved).toEqual({
      categoryId: CAT,
      fromAccountId: FROM,
      toAccountId: null,
      tagIds: ["t-1"], // 同上
    });
  });

  it("金额非法 ⇒ 拒，且**不返回**任何半成品（调用方无从误用）", () => {
    const r = applyDraftEdit(draft(), ids(), form({ amount: "0" }), {
      category: "打车",
      fromAccount: "现金",
      toAccount: null,
    });
    expect(r).toEqual({ ok: false, error: "金额要大于 0" });
  });

  it("时间空 ⇒ 拒（`add` 不校验 occurred_at，会静默写出空串）", () => {
    const r = applyDraftEdit(draft(), ids(), form({ occurredAt: "  " }), {
      category: "打车",
      fromAccount: "现金",
      toAccount: null,
    });
    expect(r).toEqual({ ok: false, error: "请选择时间" });
  });

  it("必填缺失复用 validateDraft：支出没选分类 ⇒ 拒", () => {
    const r = applyDraftEdit(draft(), ids(), form({ categoryId: null }), {
      category: null,
      fromAccount: "现金",
      toAccount: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("这张草稿缺分类，不能记账");
  });

  it("备注空白 ⇒ null（照 doSave 的 `note.trim() || null`）", () => {
    const r = applyDraftEdit(draft(), ids(), form({ note: "   " }), {
      category: "打车",
      fromAccount: "现金",
      toAccount: null,
    });
    if (!r.ok) throw new Error(`不该被拒：${r.error}`);
    expect(r.draft.note).toBeNull();
  });

  it("转账：分类强制 null，且**用户挑的两个相同账户**被拦（这条规则以前不可达）", () => {
    const base = draft({ type: "transfer", category: null, toAccount: "现金" });
    const names = { category: "不该出现", fromAccount: "招行", toAccount: "招行" };

    // 同一个账户 ⇒ 拒（`doSave:149` 的规则；草稿生成链路上 tools.ts:801 拦过，内联编辑让它第一次可达）
    const same = applyDraftEdit(base, ids({ toAccountId: TO }), form({ toAccountId: FROM }), names);
    expect(same).toEqual({ ok: false, error: "转出和转入账户不能相同" });

    // 两个不同账户 ⇒ 放行，且分类仍是 null（names.category 非空也不许写进去）
    const ok = applyDraftEdit(
      base,
      ids({ toAccountId: TO }),
      form({ toAccountId: TO }),
      { category: "不该出现", fromAccount: "招行", toAccount: "现金" },
    );
    if (!ok.ok) throw new Error(`不该被拒：${ok.error}`);
    expect(ok.draft.category).toBeNull();
    expect(ok.resolved.categoryId).toBeNull();
    expect(ok.draft.fromAccount).toBe("招行");
    expect(ok.draft.toAccount).toBe("现金");
  });

  it("收入：转出账户被强制 null（照 buildDraftData 的三元，不在这一层分叉）", () => {
    const r = applyDraftEdit(
      draft({ type: "income", category: "工资", fromAccount: null, toAccount: "招行" }),
      ids({ fromAccountId: FROM, toAccountId: TO }),
      form({ toAccountId: TO }),
      { category: "工资", fromAccount: "不该出现", toAccount: "招行" },
    );
    if (!r.ok) throw new Error(`不该被拒：${r.error}`);
    expect(r.draft.fromAccount).toBeNull();
    expect(r.resolved.fromAccountId).toBeNull();
    expect(r.draft.toAccount).toBe("招行");
  });
});
