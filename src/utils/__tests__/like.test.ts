import { describe, it, expect } from "vitest";
import { escapeLike, likePattern, noteOrTagLikeClause, LIKE_ESCAPE_CHAR } from "@/utils/like";

describe("escapeLike", () => {
  it("普通中文原样返回", () => {
    expect(escapeLike("盒马")).toBe("盒马");
  });

  it("转义百分号", () => {
    expect(escapeLike("50%")).toBe("50\\%");
  });

  it("转义下划线", () => {
    expect(escapeLike("a_b")).toBe("a\\_b");
  });

  it("转义反斜杠自身", () => {
    expect(escapeLike("back\\slash")).toBe("back\\\\slash");
  });

  it("单个反斜杠只被转义一次，不二次转义", () => {
    // 若实现是「先替换 % 再替换 _ 再替换 \\」这类多趟写法，反斜杠会被转义多次
    expect(escapeLike("\\")).toBe("\\\\");
  });

  it("三种元字符混在一起", () => {
    expect(escapeLike("\\%_")).toBe("\\\\\\%\\_");
  });

  it("空串", () => {
    expect(escapeLike("")).toBe("");
  });

  it("转义字符常量是单个反斜杠", () => {
    expect(LIKE_ESCAPE_CHAR).toBe("\\");
  });
});

describe("likePattern", () => {
  it("包成包含模式并转义", () => {
    expect(likePattern("盒马")).toBe("%盒马%");
    expect(likePattern("50%")).toBe("%50\\%%");
    expect(likePattern("a_b")).toBe("%a\\_b%");
  });
});

describe("noteOrTagLikeClause", () => {
  const clause = noteOrTagLikeClause();

  it("同时匹配备注与标签名，两处都带 ESCAPE", () => {
    expect(clause).toContain("t.note LIKE ? ESCAPE '\\'");
    expect(clause).toContain("sq_tg.name LIKE ? ESCAPE '\\'");
    expect(clause).toContain("sq_tg.is_deleted = 0");
  });

  it("恰好两个占位符（调用方按顺序 push 两次同一个模式）", () => {
    expect(clause.match(/\?/g)).toHaveLength(2);
  });

  it("子查询别名不与 fetchAll 的 QUERY 外层别名冲突", () => {
    // QUERY 外层已经有 `tg`（transaction_tags），内层若也叫 tg 会被遮蔽而不报错，
    // 一个笔误就静默关联到外层表。取独立名字让笔误变成硬错误。
    expect(clause).toContain("sq_tt");
    expect(clause).toContain("sq_tg");
    expect(clause).not.toMatch(/\btt\./);
    expect(clause).not.toMatch(/\btg\./);
  });
});
