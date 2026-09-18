<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { X, Pencil, Trash2 } from "lucide-vue-next";
import { useTagStore } from "@/stores/tag";
import { useLedgerStore } from "@/stores/ledger";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import type { TagWithUsage } from "@/types";

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

// 软键盘高度：键盘弹出时让 sheet 底部留出空间，避免搜索框聚焦后确定按钮/标签列表被遮挡
const keyboardInset = useKeyboardInset();
const sheetPadBottom = computed(() => `calc(${keyboardInset.value}px + 2rem)`);

const search = ref("");
const localSelected = ref<string[]>([]);

// select：勾选标签；manage：重命名/删除标签
const mode = ref<"select" | "manage">("select");
const editingTag = ref<TagWithUsage | null>(null);
const formName = ref("");
const formError = ref("");
const deleteTarget = ref<TagWithUsage | null>(null);
const deleteError = ref("");

// 打开时同步选中状态并回到选择模式；关闭时清掉管理模式的所有中间态
watch(() => props.visible, (v) => {
  if (v) {
    localSelected.value = [...props.selectedIds];
    search.value = "";
    mode.value = "select";
  }
  editingTag.value = null;
  formName.value = "";
  formError.value = "";
  deleteTarget.value = null;
  deleteError.value = "";
});

// 过滤标签
const filteredTags = computed(() => {
  const kw = search.value.trim().toLowerCase();
  if (!kw) return tagStore.tags;
  return tagStore.tags.filter((t) => t.name.toLowerCase().includes(kw));
});

// 输入非空且不存在完全同名（忽略大小写）标签时展示新建入口；
// 前缀命中已有标签（如已有 xxxyy 时输入 xxx）不影响创建
const showCreate = computed(() => {
  const name = search.value.trim().toLowerCase();
  return name.length > 0 && !tagStore.tags.some((t) => t.name.toLowerCase() === name);
});

const deleteDescription = computed(() => {
  const target = deleteTarget.value;
  if (!target) return "";
  return target.usage_count > 0
    ? `该标签被 ${target.usage_count} 笔记录使用，删除后这些记录不再显示该标签。此操作不可撤销。`
    : "确定要删除这个标签吗？此操作不可撤销。";
});

function toggle(tag: TagWithUsage) {
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

function toggleMode() {
  mode.value = mode.value === "manage" ? "select" : "manage";
  search.value = "";
  formError.value = "";
  deleteError.value = "";
}

function openEdit(tag: TagWithUsage) {
  editingTag.value = tag;
  formName.value = tag.name;
  formError.value = "";
}

function cancelEdit() {
  editingTag.value = null;
  formName.value = "";
  formError.value = "";
}

async function submitRename() {
  const target = editingTag.value;
  if (!target) return;
  formError.value = "";
  try {
    await tagStore.update(target.id, formName.value);
    cancelEdit();
  } catch (e: unknown) {
    formError.value = e instanceof Error ? e.message : "改名失败";
  }
}

function askDelete(tag: TagWithUsage) {
  deleteError.value = "";
  deleteTarget.value = tag;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  try {
    await tagStore.remove(target.id);
  } catch (e: unknown) {
    deleteError.value = e instanceof Error ? e.message : "删除失败";
  } finally {
    deleteTarget.value = null;
  }
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
        class="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-surface px-4 pt-4 shadow-xl max-h-[70vh] flex flex-col"
        :style="{ paddingBottom: sheetPadBottom }"
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-lg font-semibold text-text">
            {{ editingTag ? '重命名标签' : mode === 'manage' ? '管理标签' : '添加标签' }}
          </h2>
          <div class="flex items-center gap-1">
            <button
              v-if="!editingTag"
              class="px-2 py-1 text-sm text-primary"
              @click="toggleMode"
            >
              {{ mode === 'manage' ? '完成' : '管理' }}
            </button>
            <button
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
              @click="$emit('close')"
            >
              <X :size="20" class="text-text-secondary" />
            </button>
          </div>
        </div>

        <!-- 重命名表单 -->
        <template v-if="editingTag">
          <input
            v-model="formName"
            data-test="tag-name-input"
            type="text"
            placeholder="标签名称"
            class="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />
          <p v-if="formError" class="mt-2 text-sm text-expense">{{ formError }}</p>
          <div class="mt-4 flex gap-3">
            <button
              class="flex-1 rounded-xl bg-gray-100 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-gray-200"
              @click="cancelEdit"
            >
              取消
            </button>
            <button
              class="flex-1 rounded-xl bg-primary py-2.5 text-sm font-medium text-white transition-colors hover:bg-primary-dark"
              @click="submitRename"
            >
              保存
            </button>
          </div>
        </template>

        <template v-else>
          <!-- 搜索框 -->
          <input
            v-model="search"
            type="text"
            placeholder="搜索已有标签"
            class="mb-3 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
          />

          <p v-if="deleteError" class="mb-2 text-sm text-expense">{{ deleteError }}</p>

          <!-- 标签列表 -->
          <div class="flex-1 overflow-auto">
            <!-- 管理模式：不响应点击，避免与勾选手势混淆 -->
            <template v-if="mode === 'manage'">
              <div
                v-for="tag in filteredTags"
                :key="tag.id"
                data-test="manage-tag-row"
                class="flex items-center gap-2 px-2 py-2.5 text-sm"
              >
                <span class="flex-1 truncate text-text">{{ tag.name }}</span>
                <span class="shrink-0 text-xs text-text-secondary">{{ tag.usage_count }} 次</span>
                <button
                  data-test="tag-edit"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
                  @click="openEdit(tag)"
                >
                  <Pencil :size="15" class="text-text-secondary" />
                </button>
                <button
                  data-test="tag-delete"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:bg-gray-100"
                  @click="askDelete(tag)"
                >
                  <Trash2 :size="15" class="text-expense" />
                </button>
              </div>
            </template>

            <!-- 选择模式：点击切换勾选 -->
            <template v-else>
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
            </template>

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

          <!-- 确定按钮（仅选择模式） -->
          <button
            v-if="mode === 'select'"
            class="mt-4 w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark"
            @click="confirm"
          >
            确定
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>

  <ConfirmDialog
    :visible="deleteTarget !== null"
    title="删除标签"
    :description="deleteDescription"
    confirm-text="删除"
    :danger="true"
    @confirm="confirmDelete"
    @cancel="deleteTarget = null"
  />
</template>
