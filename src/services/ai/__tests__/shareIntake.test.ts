// `shareIntake` 的完整契约（规格 §9 的 1–14 条）。
//
// ⚠️ 本模块有**模块级内存状态**（`consumedRaw` 去重、`inFlight` 单飞），所以：
//  - 每个用例造**唯一**的 `pending.json` 原文（文件名带自增序号）—— 复用同一份原文会被
//    去重规则合法地跳过，用例会假红；
//  - 用例之间**串行**（默认就是串行），不要用 `it.concurrent`。
//
// 本文件**不需要 mock 任何插件**：`shareIntake.ts` 只有类型级 import（`import type`），
// 运行期零依赖 —— 这正是把依赖做成注入缝的收益。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MSG_MULTIPLE_TAKEN,
  MSG_NO_STREAM,
  MSG_READ_FAILED,
  MSG_TOO_LARGE,
  MSG_UNSUPPORTED,
} from "../attachText";
import { intakeShare, parsePending, type ShareIntakeDeps } from "../shareIntake";
import type { ImageAttachment } from "../imageInput";

const IMAGE: ImageAttachment = {
  mime: "image/jpeg",
  dataUrl: "data:image/jpeg;base64,QUFB",
  width: 10,
  height: 10,
  bytes: 3,
};

/** 每次调用生成**唯一**的原文（见文件头：模块级去重按原文比）。 */
let seq = 0;
function imageRaw(count = 1): string {
  seq += 1;
  return JSON.stringify({ v: 1, kind: "image", file: `f-${seq}.bin`, count });
}

function harness(overrides: Partial<ShareIntakeDeps> = {}) {
  const calls = {
    readPending: 0,
    readBytes: [] as string[],
    consume: [] as unknown[],
    /** 每次消费带上来的原文：实现方靠它做 compare-and-delete（"盘上还是这一份吗"） */
    consumeRaws: [] as string[],
    attached: [] as ImageAttachment[],
    notices: [] as string[],
    pushAi: 0,
  };
  const deps: ShareIntakeDeps = {
    isLocked: () => false,
    readPending: async () => {
      calls.readPending += 1;
      return null;
    },
    readBytes: async (file) => {
      calls.readBytes.push(file);
      return new Uint8Array([1, 2, 3]);
    },
    consume: async (payload, raw) => {
      calls.consume.push(payload);
      calls.consumeRaws.push(raw);
    },
    toAttachment: async () => ({ ok: true, image: IMAGE }),
    setAttachedImage: (image) => {
      calls.attached.push(image);
    },
    setNotice: (text) => {
      calls.notices.push(text);
    },
    pushAi: () => {
      calls.pushAi += 1;
    },
    ...overrides,
  };
  return { deps, calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("parsePending：形状与版本", () => {
  it("认 image（count 缺省/非法都当 1）", () => {
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin","count":2}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 2,
    });
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin"}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 1,
    });
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin","count":"2"}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 1,
    });
  });

  it("认三个 error code", () => {
    expect(parsePending('{"v":1,"kind":"error","code":"no_stream"}')).toEqual({
      v: 1,
      kind: "error",
      code: "no_stream",
    });
  });

  it("坏 JSON / 非对象 / 版本不是 1 / 未知 kind / 未知 code / 原型链键 / file 空 ⇒ null", () => {
    expect(parsePending("not json")).toBeNull();
    expect(parsePending("null")).toBeNull();
    expect(parsePending('"x"')).toBeNull();
    expect(parsePending('{"v":2,"kind":"image","file":"a.bin","count":1}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"video","file":"a.bin"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"error","code":"boom"}')).toBeNull();
    // 原型链上的键**不是**合法 code：`code in ERROR_CODES` 会把它们判成合法
    // （`"constructor" in ERROR_CODES === true`）⇒ 查表拿到 Object 构造函数
    expect(parsePending('{"v":1,"kind":"error","code":"constructor"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"error","code":"toString"}')).toBeNull();
    expect(parsePending('{"v":1,"kind":"image","file":""}')).toBeNull();
  });

  it("契约哨兵：payload 里带 `mime` 也不会进解析结果（禁止「第二道否决权」复活）", () => {
    expect(parsePending('{"v":1,"kind":"image","file":"a.bin","count":1,"mime":"image/gif"}')).toEqual({
      v: 1,
      kind: "image",
      file: "a.bin",
      count: 1,
    });
  });
});

describe("intakeShare：没有待消费的分享", () => {
  it("无 pending ⇒ none，且**一个副作用都没有**", async () => {
    const { deps, calls } = harness();
    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.readBytes).toEqual([]);
    expect(calls.consume).toEqual([]);
    expect(calls.attached).toEqual([]);
    expect(calls.notices).toEqual([]);
    expect(calls.pushAi).toBe(0);
  });

  it("锁定时 ⇒ skipped，且**连 pending.json 都不读**（锁屏期间不做任何 IO）", async () => {
    const { deps, calls } = harness({ isLocked: () => true });
    await expect(intakeShare(deps)).resolves.toBe("skipped");
    expect(calls.readPending).toBe(0);
  });

  it("读 pending.json 抛 ⇒ none（下次拉取重试），不弹文案、**不消费**", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, calls } = harness({
      readPending: async () => {
        throw new Error("fs down");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.notices).toEqual([]);
    // 这条路径的**唯一**设计要点：读失败 ≠ 没有分享 ⇒ 一份都不许消费，pending 留待重试
    expect(calls.consume).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("intakeShare：成功路径", () => {
  it("image ⇒ 附加 + 进 AI 页 + 消费掉（consume 收到解析后的 payload）", async () => {
    const raw = imageRaw();
    const { deps, calls } = harness({ readPending: async () => raw });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toEqual([IMAGE]);
    expect(calls.pushAi).toBe(1);
    expect(calls.consume).toEqual([JSON.parse(raw)]);
    // 成功路径**一律**写通知：单图写空串（= 清掉上一次的提示），不是"什么都不写"
    expect(calls.notices).toEqual([""]);
    // 字节是拿 payload 里的文件名去读的（不是别处猜的）
    expect(calls.readBytes).toEqual([JSON.parse(raw).file]);
  });

  it("多图（count>1）⇒ 照样附加第一张 + 一行提示", async () => {
    const { deps, calls } = harness({ readPending: async () => imageRaw(3) });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toEqual([IMAGE]);
    expect(calls.notices).toEqual([MSG_MULTIPLE_TAKEN]);
  });

  it("上次的多图提示会被下一次**单图成功**清掉（钉住「成功一律写 notice」）", async () => {
    let raw = imageRaw(3);
    const { deps, calls } = harness({ readPending: async () => raw });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.notices).toEqual([MSG_MULTIPLE_TAKEN]);

    // 第二份原文 = 一次干净的单图分享：只写"多图那一支"的实现在这里会漏掉第二次写入
    raw = imageRaw(1);
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.notices).toEqual([MSG_MULTIPLE_TAKEN, ""]);
  });

  it("路由失败**不回滚**附件，也不把异常冒给调用方", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, calls } = harness({
      readPending: async () => imageRaw(),
      pushAi: () => {
        throw new Error("navigation aborted");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toEqual([IMAGE]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("intakeShare：失败路径（都要消费掉，否则每次回前台弹一次）", () => {
  it("读字节抛 ⇒ 读不到那张图 + 消费 + **跳 AI 页**", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = imageRaw();
    const { deps, calls } = harness({
      readPending: async () => raw,
      readBytes: async () => {
        throw new Error("gone");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("failed");
    expect(calls.notices).toEqual([MSG_READ_FAILED]);
    expect(calls.consume).toEqual([JSON.parse(raw)]);
    expect(calls.attached).toEqual([]);
    // 失败也要把用户送到那双眼睛前面：他站在原页面看不到这句话
    expect(calls.pushAi).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("魔数拒 / 体积超限 ⇒ 用 toAttachment 给的那句话", async () => {
    for (const message of [MSG_UNSUPPORTED, MSG_TOO_LARGE]) {
      const { deps, calls } = harness({
        readPending: async () => imageRaw(),
        toAttachment: async () => ({ ok: false, message }),
      });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      expect(calls.notices).toEqual([message]);
      expect(calls.consume).toHaveLength(1);
      expect(calls.pushAi).toBe(1);
    }
  });

  it("三个 error code ⇒ 各自文案 + 消费（且 consume 收到的是 error payload）", async () => {
    const cases = [
      ["no_stream", MSG_NO_STREAM],
      ["read_failed", MSG_READ_FAILED],
      ["source_too_large", MSG_TOO_LARGE],
    ] as const;
    for (const [code, message] of cases) {
      seq += 1;
      const raw = JSON.stringify({ v: 1, kind: "error", code, seq });
      const { deps, calls } = harness({ readPending: async () => raw });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      expect(calls.notices).toEqual([message]);
      // consume 收到的是**解析后**的 payload：`seq` 只用来让原文唯一，parsePending 只挑已知键
      expect(calls.consume).toEqual([{ v: 1, kind: "error", code }]);
      expect(calls.pushAi).toBe(1);
    }
  });

  it("原型链上的键（constructor / toString）不是合法 code ⇒ 按坏形状处理：消费 + 读失败文案", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const code of ["constructor", "toString"]) {
      seq += 1;
      const raw = JSON.stringify({ v: 1, kind: "error", code, seq });
      const { deps, calls } = harness({ readPending: async () => raw });
      await expect(intakeShare(deps)).resolves.toBe("failed");
      // 关键：notice 必须是**那句文案**。用 `code in ERROR_CODES` 时这里会变成
      // `Object` 构造函数（AI 页渲染出 `function Object() { [native code] }`）
      expect(calls.notices).toEqual([MSG_READ_FAILED]);
      expect(calls.consume).toEqual([null]);
      expect(calls.pushAi).toBe(1);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("坏形状 ⇒ 按读失败处理 + 消费 + console.warn；紧接着第二次 ⇒ none，不重复弹", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { deps, calls } = harness({ readPending: async () => "not json" });
    await expect(intakeShare(deps)).resolves.toBe("failed");
    expect(calls.notices).toEqual([MSG_READ_FAILED]);
    expect(calls.consume).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.notices).toEqual([MSG_READ_FAILED]);
    expect(calls.consume).toHaveLength(1);
  });
});

describe("intakeShare：去重与单飞", () => {
  it("消费抛错 ⇒ 仍按成功返回；同一份原文再来一次 ⇒ none（不重复附加、不重复弹文案）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const raw = imageRaw();
    const { deps, calls } = harness({
      readPending: async () => raw,
      consume: async () => {
        throw new Error("delete failed");
      },
    });
    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.attached).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);

    await expect(intakeShare(deps)).resolves.toBe("none");
    expect(calls.attached).toHaveLength(1);
  });

  it("并发两次调用 ⇒ 只跑一条（readPending 只走一次）", async () => {
    const raw = imageRaw();
    // 覆写掉 `harness` 的默认 `readPending` 就会绕过它的计数器，所以这里自带一个
    let reads = 0;
    const { deps, calls } = harness({
      readPending: async () => {
        reads += 1;
        return raw;
      },
    });
    const [a, b] = await Promise.all([intakeShare(deps), intakeShare(deps)]);
    expect([a, b]).toEqual(["attached", "attached"]);
    expect(reads).toBe(1);
    expect(calls.attached).toHaveLength(1);
  });

  it("error payload 带唯一 id（原生侧 F4）：id 不同的两次失败都必须出文案与消费，不被按原文去重吞掉", async () => {
    // 原生侧给 error payload 加 id 就是为了这一条：同一个 code 两次写出的 JSON 若逐字节相同，
    // `consumedRaw` 会把第二次判成"这次没有分享" —— 用户看到的是"分享进来没反应，重启才好"。
    seq += 1;
    const first = JSON.stringify({ v: 1, kind: "error", code: "read_failed", id: `e${seq}` });
    seq += 1;
    const second = JSON.stringify({ v: 1, kind: "error", code: "read_failed", id: `e${seq}` });
    const raws = [first, second];
    const { deps, calls } = harness({ readPending: async () => raws.shift() ?? null });

    await expect(intakeShare(deps)).resolves.toBe("failed");
    await expect(intakeShare(deps)).resolves.toBe("failed");

    // 两次都要弹（第二次被吞掉的话这里只有一条）
    expect(calls.notices).toEqual([MSG_READ_FAILED, MSG_READ_FAILED]);
    expect(calls.consume).toHaveLength(2);
    // id 不进 payload：解析只挑已知键
    expect(calls.consume).toEqual([
      { v: 1, kind: "error", code: "read_failed" },
      { v: 1, kind: "error", code: "read_failed" },
    ]);
  });

  it("消费时把「读到的那份原文」一并交出去（实现方据此做 compare-and-delete）", async () => {
    // 只有拿到原文，实现方才能判断"盘上现在还是不是我处理的那一份"：
    // 原生写新分享时会顺带删掉旧 payload 引用的图（latest wins），无条件删 pending.json
    // 会把用户刚分享的那一次吞掉。契约断了 ⇒ 这条红。
    const first = imageRaw();
    const second = imageRaw();
    const raws = [first, second];
    const { deps, calls } = harness({ readPending: async () => raws.shift() ?? null });

    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.consumeRaws).toEqual([first]);

    await expect(intakeShare(deps)).resolves.toBe("attached");
    expect(calls.consumeRaws).toEqual([first, second]);
  });
});
