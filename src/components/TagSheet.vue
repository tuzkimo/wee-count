<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { X } from "lucide-vue-next";
import { useTagStore } from "@/stores/tag";
import { useLedgerStore } from "@/stores/ledger";
import type { Tag } from "@/types";

const props = defineProps<{
  visible: boolean;
  selectedIds: string[];
}>();

const emit = defineEmits<{
  close: [];
  confirm: [tagIds: string[]];
}>();

const tagStore = useTagStore();
const ledgerStore = useLedgerStore();

const search = ref("");
const localSelected = ref<string[]>([]);

// 打开时同步选中状态
watch(() => props.visible, (v) => {
  if (v) {
    localSelected.value = [...props.selectedIds];
    search.value = "";
  }
});

// 过滤标签
const filteredTags = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw) return tagStore.tags;
  return tagStore.tags.filter((t) => t.name.toLowerCase().includes(kw));
});

// 搜索无结果且输入非空
const showCreate = computed(() =>
  search.value.trim().length > 0 && filteredTags.value.length === 0
);

function toggle(tag: Tag) {
  const idx = localSelected.value.indexOf(tag.id);
  if (idx >= 0) {
    localSelected.value.splice(idx, 1);
  } else {
    localSelected.value.push(tag.id);
  }
}

async function createAndSelect() {
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;
  const name = search.value.trim();
  if (!name) return;
  try {
    const newTag = await tagStore.add(ledgerId, name);
    localSelected.value.push(newTag.id);
    search.value = "";
  } catch {
    // UNIQUE 约束冲突 — 忽略，可能是并发创建
  }
}

function confirm() {
  emit("confirm", localSelected.value);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl max-h-[70vh] flex flex-col"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">添加标签</h2>
          <button
            class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
            @click="$emit('close')"
          >
            <X :size="20" class="text-text-secondary" />
          </button>
        </div>

        <!-- 搜索框 -->
        <input
          v-model="search"
          type="text"
          placeholder="搜索已有标签"
          class="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
        />

        <!-- 标签列表 -->
        <div class="flex-1 overflow-auto">
          <button
            v-for="tag in filteredTags"
            :key="tag.id"
            class="flex w-full items-center gap-3 px-2 py-2.5 text-sm transition-colors hover:bg-gray-50"
            @click="toggle(tag)"
          >
            <span
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
              :class="localSelected.includes(tag.id) ? 'border-primary bg-primary text-white' : 'border-gray-300'"
            >
              {{ localSelected.includes(tag.id) ? '✓' : '' }}
            </span>
            <span class="text-text">{{ tag.name }}</span>
          </button>

          <!-- 创建新标签 -->
          <button
            v-if="showCreate"
            class="flex w-full items-center gap-3 px-2 py-2.5 text-sm text-primary transition-colors hover:bg-gray-50"
            @click="createAndSelect"
          >
            <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-dashed border-primary text-xs">+</span>
            <span>创建标签 "{{ search.trim() }}"</span>
          </button>

          <div v-if="filteredTags.length === 0 && !showCreate" class="py-8 text-center text-sm text-text-secondary">
            暂无标签，输入名称创建
          </div>
        </div>

        <!-- 确定按钮 -->
        <button
          class="mt-4 w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
          @click="confirm"
        >
          确定
        </button>
      </div>
    </Transition>
  </Teleport>
</template>
