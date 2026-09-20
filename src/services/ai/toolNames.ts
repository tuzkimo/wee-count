// 工具名的**唯一来源**（Ruling 43 第 2 条）。
//
// ⚠️ 本文件**零依赖**：连 `dsl.ts` 都不 import，更不 import `@/db/userDb`。
// 原因是它要被 `prompt.ts` 引用，而 `prompt.ts` 必须保持**纯函数**（规格 §5.1：前四个文件
// 零 DB、零 Tauri 依赖，可直接单测）。若这里引了 `tools.ts`，`@/db/userDb` 会顺着模块图
// 进 prompt 的依赖，破坏那条可测性 —— 所以这里只有两个字符串常量与一个数组。
//
// 为什么非要有这个文件：工具名曾经写在两处（`prompt.ts` 的正文/示例 + `tools.ts` 的 schema），
// 两份手写真相的漂移表现是"模型按 prompt 学会了一个 `executeTool` 不认识的工具名"。
// `toolSchemaContract.test.ts` 的契约断言只能当**兜底** —— 实测它漏过两种形态
// （`DELETE_TRANSACTION` 全大写、字母被拆开的 `q u e r y _ t r a n s a c t i o n s` 改过字母的
// 拆开写法至今仍漏 ✗）。根因是两份真相，所以从根上消掉：两边都从这里取值。

/** `query_transactions` —— 查当前账本的流水（汇总 + 最多 20 条精简明细） */
export const QUERY_TOOL = "query_transactions";

/** `create_transaction_draft` —— 生成待确认的草稿（**不写库**） */
export const DRAFT_TOOL = "create_transaction_draft";

/**
 * 两个工具的次序即规格 §4.2 的次序（`TOOLS[0]` 是查询、`TOOLS[1]` 是草稿）。
 * 声明成 readonly 元组：调用方只能读，不能 push 出第三个工具名。
 */
export const TOOL_NAMES = [QUERY_TOOL, DRAFT_TOOL] as const;
