<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { X, Plus } from "lucide-vue-next";
import { useCategoryStore } from "@/stores/category";
import { useLedgerStore } from "@/stores/ledger";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import type { Category } from "@/types";

const props = defineProps<{ visible: boolean; initialTab?: "expense" | "income" }>();

defineEmits<{ close: [] }>();

const categoryStore = useCategoryStore();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();

const canManage = computed(() => {
  const ledger = ledgerStore.currentLedger;
  if (!ledger || ledger.type !== 'team') return true;
  const currentUserId = auth.currentLocalUser?.server_user_id || getCurrentUserId();
  return ledger.owner_id === currentUserId;
});

// ---- emoji 库 ----
const emojiGroups: Record<string, { keywords: string[]; emojis: string[] }> = {
  food: {
    keywords: ["餐", "食", "饭", "菜", "吃", "喝", "饮", "酒", "茶", "咖啡", "早餐", "午餐", "晚餐", "外卖", "食堂", "小吃", "零食", "水果", "烧烤", "火锅", "烘焙", "甜点"],
    emojis: ["🍔", "🍕", "🍜", "🍱", "🍲", "🍳", "🥘", "🍿", "🍩", "🍪", "🍰", "🧁", "🍉", "🍇", "🍓", "🥝", "🍌", "🍊", "🥤", "☕", "🍵", "🧋", "🍺", "🍷", "🥡", "🍗", "🥩", "🧇", "🥐", "🍞"],
  },
  transport: {
    keywords: ["交通", "出行", "车", "地铁", "公交", "油", "高铁", "火车", "飞机", "打车", "出租", "骑行", "单车", "停车", "过路费", "加油", "充电", "保养", "维修", "保险", "洗车", "通勤"],
    emojis: ["🚌", "🚗", "🚕", "🚲", "🛴", "🏍️", "🚄", "✈️", "🚢", "🚇", "🚉", "🅿️", "⛽", "🚦", "🚙", "🛵", "🚐", "🚁", "⚡", "🔧"],
  },
  shopping: {
    keywords: ["购物", "买", "购", "商场", "超市", "衣服", "鞋", "包", "数码", "日用品", "化妆品", "护肤", "饰品", "玩具", "家具", "家电", "手机", "电脑", "平板"],
    emojis: ["🛒", "👔", "👗", "👟", "👜", "💼", "⌚", "📱", "💻", "🎮", "📦", "💄", "🧴", "🪥", "👓", "🧸", "🛋️", "💡", "🧹", "🪞"],
  },
  housing: {
    keywords: ["房租", "房贷", "水电", "物业", "燃气", "网费", "话费", "维修", "装修", "家居", "暖气", "宽带", "租金", "房", "住"],
    emojis: ["🏠", "🏡", "🏢", "💡", "🔌", "💧", "🔥", "🛏️", "🪑", "🚿", "🪣", "🧹", "🔑", "🪴"],
  },
  entertainment: {
    keywords: ["娱乐", "电影", "游戏", "音乐", "视频", "会员", "旅游", "旅行", "运动", "健身", "游泳", "ktv", "演出", "剧本杀", "棋牌", "密室", "景点", "门票"],
    emojis: ["🎬", "🎮", "🎵", "🎤", "🎯", "🎳", "🎪", "🎭", "🎨", "🎾", "⚽", "🏀", "🏊", "🧘", "🎿", "🏄", "🎸", "🎹", "📺", "🎧"],
  },
  medical: {
    keywords: ["医疗", "药", "医", "医院", "挂号", "体检", "牙科", "眼科", "疫苗", "保健", "中药", "门诊", "住院"],
    emojis: ["💊", "🏥", "🩺", "💉", "🩹", "🧬", "🫁", "🦷", "👁️", "🧑‍⚕️", "🚑", "🌡️"],
  },
  income: {
    keywords: ["工资", "奖金", "兼职", "理财", "利息", "分红", "报销", "红包", "转账", "退款", "二手", "出租", "薪资", "提成", "副业"],
    emojis: ["💰", "💵", "💳", "💎", "📈", "🏦", "💼", "🧧", "🎁", "🪙", "💸", "🏧"],
  },
  education: {
    keywords: ["教育", "学费", "书", "课程", "培训", "考试", "学习", "文具", "辅导", "考证"],
    emojis: ["📚", "✏️", "📝", "🎓", "📖", "🖊️", "📐", "🎒", "🏫", "💻"],
  },
  pet: {
    keywords: ["宠物", "猫", "狗", "鱼", "鸟", "仓鼠", "兔", "龟", "蜥蜴"],
    emojis: ["🐱", "🐶", "🐟", "🐦", "🐹", "🐰", "🐢", "🦴", "🐾", "🐕"],
  },
  other: {
    keywords: [],
    emojis: ["📋", "❤️", "⭐", "🔥", "🎉", "👍", "✅", "📌", "💪", "🌟", "🎀", "🔔", "🎁", "🏆", "💡"],
  },
};

const allEmojis = Object.values(emojiGroups).flatMap((g) => g.emojis);

// 根据分类名称匹配候选项
const candidateEmojis = computed(() => {
  const name = formName.value.trim();
  if (!name) return allEmojis;
  for (const group of Object.values(emojiGroups)) {
    if (group.keywords.some((k) => name.includes(k))) {
      return group.emojis;
    }
  }
  return allEmojis;
});

// ---- 列表模式状态 ----
const showForm = ref(false);
const editingCategory = ref<Category | null>(null);
const listTab = ref<"expense" | "income">("expense");

// ---- 表单模式状态 ----
const formType = ref<"expense" | "income">("expense");
const formName = ref("");
const formIcon = ref("");
const formError = ref("");

// 按类型分组
const expenseCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === "expense" && !c.is_deleted),
);
const incomeCategories = computed(() =>
  categoryStore.categories.filter((c) => c.type === "income" && !c.is_deleted),
);

const currentListCategories = computed(() =>
  listTab.value === "expense" ? expenseCategories.value : incomeCategories.value,
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
    listTab.value = props.initialTab ?? "expense";
  } else {
    listTab.value = props.initialTab ?? "expense";
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

          <!-- Tab 切换 -->
          <div class="mb-3 flex rounded-lg bg-gray-100 p-0.5">
            <button
              class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
              :class="
                listTab === 'expense'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-text-secondary'
              "
              @click="listTab = 'expense'"
            >
              支出
            </button>
            <button
              class="flex-1 rounded-md py-1.5 text-sm font-medium transition-colors"
              :class="
                listTab === 'income'
                  ? 'bg-surface text-text shadow-sm'
                  : 'text-text-secondary'
              "
              @click="listTab = 'income'"
            >
              收入
            </button>
          </div>

          <!-- 分类列表 -->
          <div class="flex-1 overflow-auto">
            <div
              v-if="currentListCategories.length === 0"
              class="py-8 text-center text-sm text-text-secondary"
            >
              暂无{{ listTab === 'expense' ? '支出' : '收入' }}分类
            </div>
            <div
              v-for="cat in currentListCategories"
              :key="cat.id"
              class="flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-gray-50"
            >
              <span class="text-lg">{{ cat.icon || "📁" }}</span>
              <span class="flex-1 text-sm text-text">{{ cat.name }}</span>
              <button
                v-if="canManage"
                class="rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-gray-200"
                @click="openEdit(cat)"
              >
                编辑
              </button>
              <button
                v-if="canManage"
                class="rounded px-2 py-1 text-xs text-expense transition-colors hover:bg-expense/10"
                @click="handleDelete(cat)"
              >
                删除
              </button>
            </div>
          </div>

          <!-- 底部新建按钮 -->
          <button
            v-if="canManage"
            class="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-semibold text-white transition-colors"
            :class="listTab === 'expense' ? 'bg-expense hover:bg-expense/90' : 'bg-income hover:bg-income/90'"
            @click="openNew(listTab)"
          >
            <Plus :size="18" />
            <span>新建{{ listTab === 'expense' ? '支出' : '收入' }}分类</span>
          </button>
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

            <!-- 图标候选（根据名称动态过滤） -->
            <label class="mb-2 block text-sm font-medium text-text">图标</label>
            <div class="mb-4 max-h-[200px] overflow-auto rounded-lg bg-gray-50 p-2">
              <div class="grid grid-cols-8 gap-1.5">
                <button
                  v-for="icon in candidateEmojis"
                  :key="icon"
                  class="flex aspect-square items-center justify-center rounded-lg text-xl transition-colors"
                  :class="
                    formIcon === icon
                      ? 'bg-primary/10 ring-2 ring-primary ring-offset-1'
                      : 'hover:bg-gray-200'
                  "
                  @click="selectIcon(icon)"
                >
                  {{ icon }}
                </button>
              </div>
            </div>

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
