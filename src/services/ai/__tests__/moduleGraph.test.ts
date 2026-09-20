// Ruling 48 第 4 条 / 任务 4 修复轮的**源码级模块图断言**。
//
// 为什么需要它：`prompt.ts` 必须是**纯函数**（规格 §5.1：前四个文件零 DB、零 Tauri，可直接
// 单测）。这件事原来只靠"读代码确认"，没有任何测试钉住 —— 有人往 `prompt.ts` 直接加一条
// `import { userDb } from "@/db/userDb"`，跑测试是**看不出来**的（那条路径在单测里不会被走到）。
//
// ⚠️ 范围**必须含 `prompt.ts` 本身**：只钉 `toolNames.ts` 零 import 是漏的 —— 依赖可以从
// `prompt.ts` 直接长出来，不经过 `toolNames.ts`。
//
// 独立核算的模块闭包（照 import 逐层走，不靠任何人的转述）：
//   prompt.ts   → dsl.ts / toolNames.ts / utils/dateRange.ts
//   dsl.ts      → utils/dateRange.ts / utils/datetime.ts
//   dateRange.ts→ utils/datetime.ts
//   datetime.ts → （无）
//   toolNames.ts→ （无）
// ⇒ 闭包 = {prompt, dsl, toolNames, dateRange, datetime}，**零 `@/db`、零 `@tauri-apps`**。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

/**
 * 用 `import.meta.url` 定位，不猜 cwd。
 *
 * ⚠️ **不要**用 `new URL(rel, import.meta.url)`：本仓的测试环境是 happy-dom，它把全局
 * `URL` 换成了自己的实现（基址是 `http://localhost:3000/`）⇒ `new URL("../../../x", import.meta.url)`
 * 会解析成 `http://localhost:3000/x`，再 `fileURLToPath` 就抛/拿到错路径。
 * 用 `node:url` 的 `fileURLToPath` + `node:path` 手工拼接（实测这条路稳）。
 */
function readSource(relativeFromSrc: string): string {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(testDir, "../../..", relativeFromSrc), "utf8");
}

/** 抓出所有 import/export-from 的模块说明符（含 `import type`、`export … from`） */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    out.push(m[1]!);
    m = re.exec(source);
  }
  return out;
}

const CLOSURE = [
  "services/ai/prompt.ts",
  "services/ai/dsl.ts",
  "services/ai/toolNames.ts",
  "utils/dateRange.ts",
  "utils/datetime.ts",
] as const;

describe("模块图：prompt 闭包必须可独立单测（Ruling 48#4）", () => {
  // 用 `[[rel]]` 而不是裸字符串数组：`it.each` 对裸数组是否展开成参数随版本不同，
  // 实测裸形式下回调收到的是 `undefined`（用例会以 ENOENT 假红）。
  it.each(CLOSURE.map((rel) => [rel]))("%s 不 import @/db 或 @tauri-apps", (rel) => {
    const src = readSource(rel);
    const specs = importSpecifiers(src);
    const forbidden = specs.filter(
      (s) => s.includes("@/db") || s.includes("@tauri-apps"),
    );
    expect(forbidden, `${rel} 的 import：${JSON.stringify(specs)}`).toEqual([]);
  });

  it("闭包是**闭的**：五个文件互相只 import 闭包内的成员（没有偷偷引第五个以外的）", () => {
    const allowed = new Set([
      "@/services/ai/dsl",
      "@/services/ai/toolNames",
      "@/utils/dateRange",
      "@/utils/datetime",
    ]);
    for (const rel of CLOSURE) {
      for (const spec of importSpecifiers(readSource(rel))) {
        // 只约束"仓内用 @/ 别名写的"那些：裸包名（vue 之类）不在这里管
        if (!spec.startsWith("@/")) continue;
        expect(allowed.has(spec), `${rel} 引入了闭包外的 ${spec}`).toBe(true);
      }
    }
  });

  it("`toolNames.ts` 的**零 import** 被钉住（它曾经是两份手写真相的根因）", () => {
    const specs = importSpecifiers(readSource("services/ai/toolNames.ts"));
    expect(specs).toEqual([]);
  });

  it("反向：`prompt.ts` 确实 import 了闭包里的那几个（断言不是空转 —— 正则真的抓到了）", () => {
    const specs = importSpecifiers(readSource("services/ai/prompt.ts"));
    expect(specs).toContain("@/services/ai/dsl");
    expect(specs).toContain("@/services/ai/toolNames");
    expect(specs).toContain("@/utils/dateRange");
  });
});
