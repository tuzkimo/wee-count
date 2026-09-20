<script setup lang="ts">
// 工具调用轨迹（规格 §4.5 的 `payload.trace`，可折叠）。
//
// **只展示聚合**：轮次 + 工具名 + 成败（+ 失败的一句原因）。
// 绝不展示工具**原始参数**或任何 id —— 参数里带着账户/分类/成员的真 id，
// 那是 §7.3 明令不上行、也不该出现在屏幕上的东西。
//
// 这里不靠"只挑我要的字段"这一条约定，而是**白名单构造**：`readTrace` 逐字段取值后
// **新建**对象，所以 payload 里多出来的任何键（`args` / `params` / `id`…）连对象都进不了模板。
import { computed, ref } from "vue";
import { ChevronDown, Wrench } from "lucide-vue-next";

const props = defineProps<{ trace: unknown[] }>();

interface TraceEntry {
  round: number;
  name: string;
  ok: boolean;
  note: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 坏条目（形状不对）直接丢掉：一条坏 trace 不该让整张轨迹渲染不出来 */
function readTrace(raw: unknown[]): TraceEntry[] {
  const out: TraceEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { round, name, ok, note } = item;
    if (typeof round !== "number" || typeof name !== "string" || typeof ok !== "boolean") continue;
    out.push({ round, name, ok, note: typeof note === "string" && note !== "" ? note : null });
  }
  return out;
}

const expanded = ref(false);
const entries = computed(() => readTrace(props.trace));
/** 全部成功时收起标题只说条数；有失败时把失败数摆出来（用户需要知道答案可能不完整） */
const failed = computed(() => entries.value.filter((e) => !e.ok).length);
</script>

<template>
  <div v-if="entries.length > 0" class="text-xs text-text-secondary" data-test="tool-trace">
    <button
      type="button"
      class="flex items-center gap-1"
      data-test="tool-trace-toggle"
      @click="expanded = !expanded"
    >
      <Wrench :size="12" />
      <span data-test="tool-trace-summary">
        查了 {{ entries.length }} 次{{ failed > 0 ? `，${failed} 次没成功` : "" }}
      </span>
      <ChevronDown :size="12" :class="expanded ? 'rotate-180' : ''" />
    </button>
    <ul v-if="expanded" class="mt-1 space-y-0.5 pl-4" data-test="tool-trace-list">
      <li v-for="(e, i) in entries" :key="i" data-test="tool-trace-entry">
        <span data-test="tool-trace-round">{{ e.round }}</span>
        <span data-test="tool-trace-name">{{ e.name }}</span>
        <span data-test="tool-trace-status">{{ e.ok ? "成功" : "失败" }}</span>
        <span v-if="e.note" data-test="tool-trace-note">{{ e.note }}</span>
      </li>
    </ul>
  </div>
</template>
