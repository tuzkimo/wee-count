// Ruling 48 第 4 条 / 任务 4 修复轮的**源码级模块图断言**。
//
// 为什么需要它：`prompt.ts` 必须是**纯函数**（规格 §5.1：前四个文件零 DB、零 Tauri，可直接
// 单测）。这件事原来只靠"读代码确认"，没有任何测试钉住 —— 有人往 `prompt.ts` 直接加一条
// `import { userDb } from "@/db/userDb"`，跑测试是**看不出来**的（那条路径在单测里不会被走到）。
//
// ⚠️ 范围**必须含 `prompt.ts` 本身**：只钉 `toolNames.ts` 零 import 是漏的 —— 依赖可以从
// `prompt.ts` 直接长出来，不经过 `toolNames.ts`。
//
// ⚠️⚠️ **两个逃逸口**（任务 5 的 step 0 堵住，都有实测）：
//   1. **相对路径 import** `from "./dsl"` / `from "../../db/userDb"` —— 旧实现的"闭包闭性"
//      只约束 `@/` 开头的说明符 ⇒ 相对路径**完全不被检查**。
//   2. **动态 `import("@/db/userDb")`** —— 它没有 `from` 子句，旧正则一条都抓不到。
//   实测旧实现在这两种形态下都是 **8/8 假绿**（把这两条 import 加进 `prompt.ts` 后用例全过）。
//   ⇒ 现在改用 **TypeScript 自己的解析器**（`ts.createSourceFile` + AST 遍历）取说明符：
//      两个形态分别是 `ImportDeclaration` 与 `ImportKeyword` CallExpression，天然在内；
//      注释/字符串里的 `import` 由解析器自己排除，不会像词法扫描那样被本测试的说明文字带红。
//      （自己写词法扫描的版本实测踩了三个坑：多行花括号 import、`export {x} from`、
//      `export interface` 里的 `from` 字段名 —— 都是解析器的免费能力。）
//
// 独立核算的模块闭包（照 import 逐层走，不靠任何人的转述）：
//   prompt.ts   → dsl.ts / toolNames.ts / utils/dateRange.ts
//   dsl.ts      → utils/dateRange.ts / utils/datetime.ts
//   dateRange.ts→ utils/datetime.ts
//   datetime.ts → （无）
//   toolNames.ts→ （无）
// ⇒ 闭包 = {prompt, dsl, toolNames, dateRange, datetime}，**零 `@/db`、零 `@tauri-apps`**。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, it, expect } from "vitest";

/**
 * 用 `import.meta.url` 定位，不猜 cwd。
 *
 * ⚠️ **不要**用 `new URL(rel, import.meta.url)`：本仓的测试环境是 happy-dom，它把全局
 * `URL` 换成了自己的实现（基址是 `http://localhost:3000/`）⇒ `new URL("../../../x", import.meta.url)`
 * 会解析成 `http://localhost:3000/x`，再 `fileURLToPath` 就抛/拿到错路径。
 * 用 `node:url` 的 `fileURLToPath` + `node:path` 手工拼接（实测这条路稳）。
 */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readSource(relativeFromSrc: string): string {
  return readFileSync(resolve(SRC_ROOT, relativeFromSrc), "utf8");
}

/**
 * 用真解析器取**全部**模块说明符（静态两个方向 + 动态）。
 *
 * - `import … from "x"` / `import "x"` ⇒ `ImportDeclaration.moduleSpecifier`
 * - `export … from "x"` ⇒ `ExportDeclaration.moduleSpecifier`（**是真的新依赖**，
 *   而 `export interface X { from: string }` 里那个 `from` 只是字段名，解析器不会混）
 * - `import("x")` ⇒ `ImportKeyword` 的 CallExpression；`import.meta` 不是调用，天然不在内
 *
 * 动态说明符**不是字面量**（`import("./" + name)`、`import(path)`）⇒ **抛**：解析器判不了
 * 它指向哪个模块，静默跳过就等于给守卫开第三个逃逸口。宁可红着要人看一眼。
 */
function importSpecifiers(source: string, label: string): string[] {
  const file = ts.createSourceFile(
    label,
    source,
    ts.ScriptTarget.ES2020,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      if (spec !== undefined && ts.isStringLiteral(spec)) out.push(spec.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isStringLiteral(arg)) {
        throw new Error(
          `${label}: 动态 import 的说明符不是字符串字面量（偏移 ${node.getStart(file)} 附近）` +
            ` —— 解析器判不了它指向哪个模块，请写成字面量`,
        );
      }
      out.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/**
 * 归一成"仓内路径"，让 `./dsl` / `@/services/ai/dsl` / `@/services/ai/dsl.ts` 三者可比。
 * 裸包名（`vue`、`node:fs`…）保持原样 —— 它们不参与闭包判定。
 */
function normalize(fromFile: string, spec: string): string {
  if (spec.startsWith("@/")) return spec.replace(/^@\//, "");
  if (spec.startsWith(".")) {
    return join(dirname(fromFile), spec)
      .replace(/\\/g, "/")
      .replace(/\.(ts|js|vue)$/, "");
  }
  return spec;
}

const CLOSURE = [
  "services/ai/prompt.ts",
  "services/ai/dsl.ts",
  "services/ai/toolNames.ts",
  "utils/dateRange.ts",
  "utils/datetime.ts",
] as const;

/** 闭包允许出现的仓内说明符（归一后）。裸包名由"闭包闭性"那条用例按形态放行。 */
const ALLOWED_IN_CLOSURE = new Set([
  "services/ai/dsl",
  "services/ai/toolNames",
  "utils/dateRange",
  "utils/datetime",
]);

describe("模块图：prompt 闭包必须可独立单测（Ruling 48#4）", () => {
  // 用 `[[rel]]` 而不是裸字符串数组：`it.each` 对裸数组是否展开成参数随版本不同，
  // 实测裸形式下回调收到的是 `undefined`（用例会以 ENOENT 假红）。
  it.each(CLOSURE.map((rel) => [rel]))("%s 不 import @/db 或 @tauri-apps", (rel) => {
    const forbidden = importSpecifiers(readSource(rel), rel).filter(
      (s) => s.includes("@/db") || s.includes("@tauri-apps"),
    );
    expect(forbidden, `${rel} 的禁用 import`).toEqual([]);
  });

  it("闭包是**闭的**：五个文件的说明符（静态与动态、别名与相对路径**都算**）只落在闭包内", () => {
    for (const rel of CLOSURE) {
      for (const spec of importSpecifiers(readSource(rel), rel)) {
        const norm = normalize(rel, spec);
        // 裸包名（vue / vitest…）与 node: 内建不在这里管；其余一律必须在闭包白名单里
        if (norm.startsWith("node:")) continue;
        if (!norm.includes("/")) continue;
        expect(
          ALLOWED_IN_CLOSURE.has(norm),
          `${rel} 的说明符 ${spec}（归一为 ${norm}）落在闭包外`,
        ).toBe(true);
      }
    }
  });

  it("`toolNames.ts` 的**零 import** 被钉住（它曾经是两份手写真相的根因）", () => {
    expect(importSpecifiers(readSource("services/ai/toolNames.ts"), "toolNames.ts")).toEqual([]);
  });

  it("反向：`prompt.ts` 确实 import 了闭包里的那几个（断言不是空转 —— 解析真的抓到了）", () => {
    const specs = importSpecifiers(readSource("services/ai/prompt.ts"), "prompt.ts");
    expect(specs).toContain("@/services/ai/dsl");
    expect(specs).toContain("@/services/ai/toolNames");
    expect(specs).toContain("@/utils/dateRange");
  });
});

/**
 * 逃逸口 1/2 的**正向守卫**。
 *
 * 旧版本的判别力全部来自"过滤结果为空"这种反向断言 —— 只要抓取器**漏抓**，空断言就恒真。
 * 这一组把两种形态分别喂进解析器，断言它**必须抓到**、并且归一后落在闭包外：
 * 于是"漏抓"这种失效模式本身变红，而不是悄悄放行。
 */
describe("取说明符这一步本身：两个逃逸口（相对路径 / 动态 import）必须真的被抓到", () => {
  it("相对路径 import 被抓到，且归一后落在闭包外（⇒ 闭包闭性会拦它）", () => {
    const src = [
      `import { AGGREGATES } from "../../services/ai/dsl";`,
      `import { getUserDb } from "../../db/userDb";`,
    ].join("\n");
    const specs = importSpecifiers(src, "synthetic.ts");
    expect(specs).toEqual(["../../services/ai/dsl", "../../db/userDb"]);
    // 归一：相对 → 仓内路径，`@/` → 仓内路径，两者必须落到**同一条**判定上
    expect(normalize("services/ai/prompt.ts", specs[0]!)).toBe("services/ai/dsl");
    expect(normalize("services/ai/prompt.ts", specs[1]!)).toBe("db/userDb");
    expect(ALLOWED_IN_CLOSURE.has(normalize("services/ai/prompt.ts", specs[1]!))).toBe(false);
    expect(specs[1]!.includes("@/db")).toBe(false); // 旧守卫的过滤条件看不见它
  });

  it("动态 `import(\"@/db/userDb\")` 被抓到（旧实现的盲区：它没有 `from`）", () => {
    const src = ["export async function f() {", `  return await import("@/db/userDb");`, "}"].join("\n");
    expect(importSpecifiers(src, "synthetic.ts")).toEqual(["@/db/userDb"]);
  });

  it("多行花括号 / 单引号 / 副作用形态 / `export … from` / `import type` 都被抓到", () => {
    const src = [
      "import {",
      "  A,",
      "  B,",
      `} from "@/services/ai/dsl";`,
      `import 'vue';`,
      `import "@/db/userDb";`,
      `export { x } from "@/utils/dateRange";`,
      `import type { Y } from "@/utils/datetime";`,
    ].join("\n");
    expect(importSpecifiers(src, "synthetic.ts")).toEqual([
      "@/services/ai/dsl",
      "vue",
      "@/db/userDb",
      "@/utils/dateRange",
      "@/utils/datetime",
    ]);
  });

  it("注释与字符串里的 import **不算**依赖（否则本测试自己的说明文字会把守卫弄成恒红）", () => {
    const src = [
      `// import { getUserDb } from "@/db/userDb";`,
      `/* import "@/db/userDb"; */`,
      `const doc = "import('@/db/userDb')";`,
      `export interface X { from: string; to: string }`,
      `import.meta;`,
      "export const ok = 1;",
    ].join("\n");
    expect(importSpecifiers(src, "synthetic.ts")).toEqual([]);
  });

  it("动态说明符不是字面量 ⇒ 显式抛（判不了就红，绝不静默放行成第三个逃逸口）", () => {
    expect(() => importSpecifiers(`const m = await import("./" + name);`, "synthetic.ts")).toThrow(
      /不是字符串字面量/,
    );
  });
});
