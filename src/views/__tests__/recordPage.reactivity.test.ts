import { describe, it, expect } from "vitest";
import { ref, watch, nextTick } from "vue";

/**
 * 复现 RecordPage 编辑 income 流水时分类被覆盖的 reactivity 时序问题。
 *
 * 根因：watch(txType) 默认 flush:'pre'（异步）。在同步块里用 isInitializing
 * flag 包住 txType 赋值无效——watch 回调排到 microtask，执行时 flag 已被
 * 设回 false，于是 categoryId 被默认分类覆盖。
 */

// 模拟分类数据
const incomeCats = [
  { id: "inc-default", sort_order: 0 },
  { id: "inc-real", sort_order: 1 },
];
const expenseCats = [
  { id: "exp-default", sort_order: 0 },
];

function defaultCatId(type: string): string | null {
  const cats = type === "income" ? incomeCats : expenseCats;
  const sorted = [...cats].sort((a, b) => a.sort_order - b.sort_order);
  return sorted[0]?.id ?? null;
}

describe("RecordPage bug2: 编辑 income 分类被默认覆盖", () => {
  it("watch(txType) + flag 方案无效——watch 异步执行时 flag 已复位，分类被覆盖", async () => {
    const txType = ref("expense");
    const categoryId = ref<string | null>(null);
    const isInitializing = ref(false);

    watch(txType, () => {
      if (isInitializing.value) return;
      categoryId.value = defaultCatId(txType.value);
    });

    // 模拟 onMounted 编辑预填：income 类型，原分类是 inc-real（非默认）
    isInitializing.value = true;
    txType.value = "income";
    categoryId.value = "inc-real";
    isInitializing.value = false;

    await nextTick(); // watch 回调在此执行

    // 期望保留原分类 inc-real，但 flag 方案下被覆盖成 inc-default
    // 此测试证明 flag 方案不可行，记录根因。
    expect(categoryId.value).toBe("inc-default");
  });

  it("修复方案：用 switchType handler 显式切换，编辑预填直接赋值不触发重置", async () => {
    const txType = ref("expense");
    const categoryId = ref<string | null>(null);

    // 用户点击类型按钮时显式重置
    function switchType(t: string) {
      txType.value = t;
      categoryId.value = defaultCatId(t);
    }

    // 编辑预填：直接赋值，不走 switchType，不触发重置
    txType.value = "income";
    categoryId.value = "inc-real";

    await nextTick();
    expect(categoryId.value).toBe("inc-real"); // ← 保留原分类

    // 用户主动切换到 expense：才重置为默认
    switchType("expense");
    expect(categoryId.value).toBe("exp-default");
    expect(txType.value).toBe("expense");
  });
});
