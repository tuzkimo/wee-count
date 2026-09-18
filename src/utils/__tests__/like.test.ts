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

  it("空串得到 %%（匹配一切），所以调用方必须自己做 truthiness 判断", () => {
    // 这不是 bug，但语义必须写明：两个调用点（buildWhere 与 fetchAll）都靠
    // `if (f.merchant)` / `if (opts.noteKeyword)` 兜底，绝不会传空串进来。
    // 谁要是去掉那层判断，空关键词会静默变成「匹配全部」。
    expect(likePattern("")).toBe("%%");
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

  it("不引用裸表名，也不残留会被外层遮蔽的短别名", () => {
    // fetchAll 的 QUERY 外层已有 `tg`（transaction_tags）与 `tags` 两个名字。
    // 内层若同名会被 SQLite 静默遮蔽而不报错，一个笔误就变成关联到外层表。
    // 这里做的是**文本层**的自查（片段必须用 sq_ 前缀）；
    // 真正「不与外层冲突」的保证来自任务 8 的 sqlSmoke.test.ts——它在真实 SQLite 里
    // 把片段拼进带 LEFT JOIN 的外层查询执行，冲突会直接变成错误或错数。
    expect(clause).toContain("sq_tt");
    expect(clause).toContain("sq_tg");
    expect(clause).not.toMatch(/\btt\./);
    expect(clause).not.toMatch(/\btg\./);
    expect(clause).not.toMatch(/\btags\./);
    expect(clause).not.toMatch(/\btransaction_tags\./);
  });

  it("子查询取的是 transaction_id（写成 tag_id 会让标签命中恒空）", () => {
    // 这条只钉住这一个**被逐字点名**的变异，别把它当万能的。
    // 字符串断言覆盖不了「片段拼进外层查询之后算得对不对」这一类问题：
    // 别名遮蔽、括号优先级、参数顺序与个数、引用了不存在的列——它们要么只在执行时
    // 才暴露，要么文本上完全看不出。那些由任务 8 的 sqlSmoke.test.ts 在真实 SQLite 上兜住。
    // 实证：t8 的备注不含「盒马」、只靠标签命中，一旦 transaction_id 写成 tag_id，
    // merchant=盒马 的总额会从 350 掉到 300（控制者已在真实 SQLite 上实测）。
    expect(noteOrTagLikeClause()).toContain("sq_tt.transaction_id");
  });
});
