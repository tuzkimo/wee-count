<script setup lang="ts">
// 条件芯片：芯片 → 流水页（规格 §4.6，M1 的第 6 条约束）。
//
// ⚠️ **整体替换** route query，绝不 `{...route.query, ...}`：M1 实测把流水页带过来的
// `uncategorized=1` 叠上会让 21 条静默变 4 条。`appliedToQuery` 的产出就是这份 query 的**全部**内容
// —— 它**永远不产出** `uncategorized`（那是读方独有参数，M1 已用常驻护栏钉住）。
//
// chips 来自 `payload.chips`（`unknown[]`：payload 是 JSON），形状与 `AppliedFilter` 同构
// （`tools.ts` 把 `applied` 原样塞进去）。这里逐字段收窄，坏芯片**跳过**而不是抛。
//
// 标签：日期优先用 `buildPresetRange` + `PRESETS` 的中文标签（「本月」），对不上就显式区间；
// 其余字段用解析出的**名字**（不是 id）。全部对不上时退回字段名，绝不显示裸 id。
import { computed } from "vue";
import { useRouter } from "vue-router";
import { appliedToQuery } from "@/services/ai/filterQuery";
import type { AppliedFilter } from "@/services/ai/resolve";
import { PRESETS, buildPresetRange, formatRangeLabel } from "@/utils/dateRange";

const props = defineProps<{ chips: unknown[] }>();

const router = useRouter();

interface ChipRef {
  id: string;
  name: string;
}

const REF_LIST_FIELDS = ["categories", "tags", "members"] as const;
const REF_FIELDS = ["account"] as const;
const NUM_FIELDS = ["amountMin", "amountMax"] as const;
/** 字符串字段（**不含** amountMin/amountMax：它们是数字，混进来会把 `0` 判成形状不对） */
const STRING_FIELDS = ["dateFrom", "dateTo", "type"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isNullableNumber(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

function isRefArray(v: unknown): v is ChipRef[] {
  return (
    Array.isArray(v) &&
    v.every(
      (it) => isRecord(it) && typeof it.id === "string" && typeof it.name === "string",
    )
  );
}

function isRef(v: unknown): v is ChipRef {
  return isRecord(v) && typeof v.id === "string" && typeof v.name === "string";
}

/**
 * 形状完整的芯片才收。`type` 刻意**不**用 `TX_TYPES.includes` 写：TS 收窄不到联合类型，
 * 而 `appliedToQuery` 的入参要求 `AiTxType | null`（照 store 里 `readDrafts` 的写法逐条件判）。
 */
function isAppliedFilter(v: unknown): v is AppliedFilter {
  if (!isRecord(v)) return false;
  // 字符串字段与数值字段**分开判**：`amountMin: 0` 是有效下界，拿 isNullableString 判它会把
  // 一条合法芯片（"金额 0 起"）静默丢掉。日期两端在 `DATE_FIELDS` 里，这里不重复。
  if (!STRING_FIELDS.every((k) => isNullableString(v[k]))) return false;
  if (!NUM_FIELDS.every((k) => isNullableNumber(v[k]))) return false;
  if (!REF_LIST_FIELDS.every((k) => isRefArray(v[k]))) return false;
  if (!REF_FIELDS.every((k) => isRef(v[k]) || v[k] === null)) return false;
  const t = v.type;
  return t === null || t === "expense" || t === "income" || t === "transfer";
}

/** 一屏最多给几条：芯片是下钻入口，不是条件清单（用户要看全部条件去流水页的筛选页） */
const MAX_CHIPS = 6;

const applied = computed<AppliedFilter[]>(() => {
  const out: AppliedFilter[] = [];
  for (const chip of props.chips) {
    if (isAppliedFilter(chip)) out.push(chip);
    // 坏芯片**跳过**：一条形状不对的 chips 元素不该让整排芯片渲染不出来
    if (out.length >= MAX_CHIPS) break;
  }
  return out;
});

interface ChipView {
  applied: AppliedFilter;
  label: string;
}

function dateLabel(a: AppliedFilter): string | null {
  if (a.dateFrom === null && a.dateTo === null) return null;
  if (a.dateFrom !== null && a.dateTo !== null) {
    // 走 `PRESETS` 的**顺序**（它是仓内"高频在前"的唯一排序，`matchPreset` 也是这个顺序）：
    // 预设之间会重叠（"本周" 与 "近7天" 在周一就是同一段、"本月" 与 "近3月" 在月初也是），
    // 命中顺序不同会让同一条芯片在月初显示"上月"、月中显示"近3月"。取第一个命中 =
    // 与仓内既有的 `matchPreset` 完全同一个判据。
    const now = new Date();
    for (const p of PRESETS) {
      const r = buildPresetRange(p.key, now);
      if (r.start === a.dateFrom && r.end === a.dateTo) return p.label;
    }
  }
  return formatRangeLabel(a.dateFrom ?? "", a.dateTo ?? "") || null;
}

function otherLabels(a: AppliedFilter): string[] {
  const out: string[] = [];
  // 类型的中文名：仓内没有共享常量，`RecordPage.vue:198` / `TransactionList.vue:382` 是同一串三元，
  // 这里照抄（**不**新建常量：那会让两处既有代码变成"第三份真相旁边的旧写法"）。
  if (a.type !== null) out.push(a.type === "expense" ? "支出" : a.type === "income" ? "收入" : "转账");
  for (const c of a.categories) out.push(c.name);
  if (a.account !== null) out.push(a.account.name);
  for (const t of a.tags) out.push(t.name);
  for (const m of a.members) out.push(m.name);
  if (a.merchant !== null) out.push(`备注：${a.merchant}`);
  if (a.amountMin !== null && a.amountMax !== null) out.push(`${a.amountMin}-${a.amountMax}`);
  else if (a.amountMin !== null) out.push(`≥${a.amountMin}`);
  else if (a.amountMax !== null) out.push(`≤${a.amountMax}`);
  return out;
}

/** 一条芯片的文案：日期（预设中文标签 / 显式区间）+ 其余条件；全空时退回"与流水页同条件" */
function chipLabel(a: AppliedFilter): string {
  const parts = [dateLabel(a), ...otherLabels(a)].filter((s): s is string => s !== null && s !== "");
  if (parts.length > 0) return parts.join(" · ");
  return "查看明细";
}

const views = computed<ChipView[]>(() =>
  applied.value.map((a) => ({ applied: a, label: chipLabel(a) })),
);

function jump(a: AppliedFilter): void {
  // 整体替换，不是合并（M1 第 6 条约束）
  void router.push({ path: "/", query: appliedToQuery(a) });
}
</script>

<template>
  <div v-if="views.length > 0" class="flex flex-wrap gap-2" data-test="filter-chips">
    <button
      v-for="(v, i) in views"
      :key="i"
      type="button"
      class="rounded-full bg-primary/10 px-3 py-1 text-xs text-primary"
      data-test="filter-chip"
      @click="jump(v.applied)"
    >
      {{ v.label }}
    </button>
  </div>
</template>
