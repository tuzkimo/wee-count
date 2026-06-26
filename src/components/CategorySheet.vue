<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { X, Plus } from "lucide-vue-next";
import { useCategoryStore } from "@/stores/category";
import { useLedgerStore } from "@/stores/ledger";
import type { Category } from "@/types";

const props = defineProps<{ visible: boolean }>();

defineEmits<{ close: [] }>();

const categoryStore = useCategoryStore();
const ledgerStore = useLedgerStore();

const presetIcons = ["🍔", "🍕", "☕", "🎬", "🚌", "💊", "📱", "👔", "🏠", "🎁", "💰", "💼"];

// 列表模式状态
const showForm = ref(false);
const editingCategory = ref<Category | null>(null);

// 表单模式状态
const formType = ref<"expense" | "income">("expense");
const formName = ref("");
const formIcon = ref("");
const formError = ref("");

// 按类型分组
const expenseCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === "expense" && !c.is_deleted)
);
const incomeCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === "income" && !c.is_deleted)
);

// 打开 sheet 时重置
watch(() => showForm.value, (v) => {
  if (!v) {
    formName.value = "";
    formIcon.value = "";
    formError.value = "";
    editingCategory.value = null;
  }
});

// 关闭 sheet 时重置
watch(() => props.visible, (v) => {
  if (!v) {
    showForm.value = false;
    editingCategory.value = null;
    formName.value = "";
    formIcon.value = "";
    formType.value = "expense";
    formError.value = "";
  }
});

// ---- 列表模式操作 ----

function openNew(type: "expense" | "income") {
  editingCategory.value = null;
  formType.value = type;
  formName.value = "";
  formIcon.value = "";
  formError.value = "";
  showForm.value = true;
}

function openEdit(category: Category) {
  editingCategory.value = category;
  formType.value = category.type;
  formName.value = category.name;
  formIcon.value = category.icon ?? "";
  formError.value = "";
  showForm.value = true;
}

async function handleDelete(category: Category) {
  const ok = window.confirm(`确定要删除分类「${category.name}」吗？`);
  if (!ok) return;
  try {
    await categoryStore.remove(category.id);
  } catch (e: unknown) {
    alert(e instanceof Error ? e.message : "删除失败");
  }
}

// ---- 表单模式操作 ----

function selectIcon(icon: string) {
  formIcon.value = formIcon.value === icon ? "" : icon;
}

function backToList() {
  showForm.value = false;
}

async function handleSubmit() {
  const name = formName.value.trim();
  if (!name) {
    formError.value = "请输入分类名称";
    return;
  }

  formError.value = "";
  const ledgerId = ledgerStore.currentLedger?.id;
  if (!ledgerId) return;

  try {
    if (editingCategory.value) {
      await categoryStore.update(editingCategory.value.id, name, formIcon.value || null);
    } else {
      await categoryStore.add(ledgerId, name, formType.value, formIcon.value || null);
    }
    showForm.value = false;
  } catch (e: unknown) {
    formError.value = e instanceof Error ? e.message : "操作失败";
  }
}
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩 -->
    <Transition name="sheet-fade">
      <div
        v-if="visible"
        class="fixed inset-0 z-40 bg-black/40"
        @click="$emit('close')"
      />
    </Transition>

    <!-- 面板 -->
    <Transition name="sheet-slide-up">
      <div
        v-if="visible"
        class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl bg-surface px-4 pb-8 pt-4 shadow-xl"
      >
        <!-- ========== 列表模式 ========== -->
        <template v-if="!showForm">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-text">管理分类</h2>
            <button
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
              @click="$emit('close')"
            >
              <X :size="20" class="text-text-secondary" />
            </button>
          </div>

          <div class="flex-1 overflow-auto">
            <!-- 支出分类 -->
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-sm font-medium text-text-secondary">支出</h3>
                <button
                  class="flex items-center gap-1 text-xs text-primary"
                  @click="openNew('expense')"
                >
                  <Plus :size="14" />
                  <span>新建</span>
                </button>
              </div>
              <div v-if="expenseCategories.length === 0" class="py-4 text-center text-sm text-text-secondary">
                暂无支出分类
              </div>
              <div
                v-for="cat in expenseCategories"
                :key="cat.id"
                class="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-gray-50"
              >
                <span class="text-lg">{{ cat.icon || "📁" }}</span>
                <span class="flex-1 text-sm text-text">{{ cat.name }}</span>
                <button
                  class="rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-gray-200"
                  @click="openEdit(cat)"
                >
                  编辑
                </button>
                <button
                  class="rounded px-2 py-1 text-xs text-expense transition-colors hover:bg-expense/10"
                  @click="handleDelete(cat)"
                >
                  删除
                </button>
              </div>
            </div>

            <!-- 收入分类 -->
            <div class="mb-4">
              <div class="mb-2 flex items-center justify-between">
                <h3 class="text-sm font-medium text-text-secondary">收入</h3>
                <button
                  class="flex items-center gap-1 text-xs text-primary"
                  @click="openNew('income')"
                >
                  <Plus :size="14" />
                  <span>新建</span>
                </button>
              </div>
              <div v-if="incomeCategories.length === 0" class="py-4 text-center text-sm text-text-secondary">
                暂无收入分类
              </div>
              <div
                v-for="cat in incomeCategories"
                :key="cat.id"
                class="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-gray-50"
              >
                <span class="text-lg">{{ cat.icon || "📁" }}</span>
                <span class="flex-1 text-sm text-text">{{ cat.name }}</span>
                <button
                  class="rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-gray-200"
                  @click="openEdit(cat)"
                >
                  编辑
                </button>
                <button
                  class="rounded px-2 py-1 text-xs text-expense transition-colors hover:bg-expense/10"
                  @click="handleDelete(cat)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>

          <!-- 底部大新建按钮 -->
          <div class="mt-4 flex gap-3">
            <button
              class="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-expense/10 py-3 text-sm font-semibold text-expense transition-colors hover:bg-expense/20"
              @click="openNew('expense')"
            >
              <Plus :size="18" />
              <span>新建支出分类</span>
            </button>
            <button
              class="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-income/10 py-3 text-sm font-semibold text-income transition-colors hover:bg-income/20"
              @click="openNew('income')"
            >
              <Plus :size="18" />
              <span>新建收入分类</span>
            </button>
          </div>
        </template>

        <!-- ========== 表单模式 ========== -->
        <template v-else>
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-text">
              {{ editingCategory ? "编辑分类" : "新建分类" }}
            </h2>
            <button
              class="flex h-8 w-8 items-center justify-center rounded-full hover:bg-gray-100"
              @click="backToList"
            >
              <X :size="20" class="text-text-secondary" />
            </button>
          </div>

          <div class="flex-1 overflow-auto">
            <!-- 类型选择（仅新建时可切换） -->
            <label class="mb-1 block text-sm font-medium text-text">类型</label>
            <div class="mb-4 flex rounded-lg bg-gray-100 p-0.5">
              <button
                class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
                :class="
                  formType === 'expense'
                    ? 'bg-surface text-text shadow-sm'
                    : 'text-text-secondary'
                "
                :disabled="!!editingCategory"
                @click="formType = 'expense'"
              >
                支出
              </button>
              <button
                class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
                :class="
                  formType === 'income'
                    ? 'bg-surface text-text shadow-sm'
                    : 'text-text-secondary'
                "
                :disabled="!!editingCategory"
                @click="formType = 'income'"
              >
                收入
              </button>
            </div>

            <!-- 名称 -->
            <label class="mb-1 block text-sm font-medium text-text">名称</label>
            <input
              v-model="formName"
              type="text"
              maxlength="10"
              placeholder="分类名称"
              class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm text-text outline-none focus:border-primary"
            />

            <!-- 图标选择 -->
            <label class="mb-2 block text-sm font-medium text-text">图标</label>
            <div class="mb-3 grid grid-cols-6 gap-2">
              <button
                v-for="icon in presetIcons"
                :key="icon"
                class="flex aspect-square items-center justify-center rounded-lg text-xl transition-colors"
                :class="
                  formIcon === icon
                    ? 'bg-primary/10 ring-2 ring-primary'
                    : 'bg-gray-100 hover:bg-gray-200'
                "
                @click="selectIcon(icon)"
              >
                {{ icon }}
              </button>
            </div>

            <!-- 自定义图标输入 -->
            <label class="mb-1 block text-xs text-text-secondary">或自定义输入</label>
            <input
              v-model="formIcon"
              type="text"
              maxlength="4"
              placeholder="输入 emoji"
              class="mb-4 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-text outline-none focus:border-primary"
            />

            <!-- 错误提示 -->
            <p
              v-if="formError"
              class="mb-3 text-sm text-expense"
            >
              {{ formError }}
            </p>
          </div>

          <!-- 提交按钮 -->
          <button
            class="mt-4 w-full rounded-xl bg-primary py-3 text-center text-base font-semibold text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
            :disabled="!formName.trim()"
            @click="handleSubmit"
          >
            {{ editingCategory ? "保存" : "创建" }}
          </button>
        </template>
      </div>
    </Transition>
  </Teleport>
</template>
