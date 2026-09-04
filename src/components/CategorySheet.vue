<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { X, Plus } from "lucide-vue-next";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import { useCategoryStore } from "@/stores/category";
import { useLedgerStore } from "@/stores/ledger";
import { useAuthStore } from "@/stores/auth";
import { getCurrentUserId } from "@/db/userDb";
import { useKeyboardInset } from "@/composables/useKeyboardInset";
import type { Category } from "@/types";

const props = defineProps<{ visible: boolean; initialTab?: "expense" | "income" }>();

defineEmits<{ close: [] }>();

const categoryStore = useCategoryStore();
const ledgerStore = useLedgerStore();
const auth = useAuthStore();

// 软键盘高度：键盘弹出时让 sheet 底部留出空间，避免确定按钮被遮挡、图标区滚动失效
const keyboardInset = useKeyboardInset();
// sheet 底部内边距，跟随键盘高度动态调整（含原有 32px 安全间距）
const sheetPadBottom = computed(() => `calc(${keyboardInset.value}px + 2rem)`);

const currentUserId = computed(() =>
  auth.currentLocalUser?.server_user_id || getCurrentUserId(),
);

function canEdit(category: Category): boolean {
  const ledger = ledgerStore.currentLedger;
  if (!ledger || ledger.type !== 'team') return true;
  return category.owner_id === currentUserId.value;
}

// ---- emoji 库 ----
// 按类型分组展示：始终渲染全部分组，输入名称命中关键词时仅自动滚动定位到对应分组，
// 用户仍可上下滚动浏览其他分组，避免"匹配后看不到全部"的问题。
const emojiGroups: Record<string, { label: string; keywords: string[]; emojis: string[] }> = {
  food: {
    label: "餐饮",
    keywords: ["餐", "食", "饭", "菜", "吃", "喝", "饮", "酒", "茶", "咖啡", "早餐", "午餐", "晚餐", "外卖", "食堂", "小吃", "零食", "水果", "烧烤", "火锅", "烘焙", "甜点", "面", "粉", "饺", "粥", "汤", "菜"],
    emojis: ["🍔", "🍕", "🍜", "🍱", "🍲", "🍳", "🥘", "🍿", "🍩", "🍪", "🍰", "🧁", "🍉", "🍇", "🍓", "🥝", "🍌", "🍊", "🥤", "☕", "🍵", "🧋", "🍺", "🍷", "🥡", "🍗", "🥩", "🧇", "🥐", "🍞", "🍝", "🥟", "🍚", "🍘", "🍙", "🌮", "🥗", "🍦", "🥧", "🍫", "🍬"],
  },
  transport: {
    label: "交通",
    keywords: ["交通", "出行", "车", "地铁", "公交", "油", "高铁", "火车", "飞机", "打车", "出租", "骑行", "单车", "停车", "过路费", "加油", "充电", "保养", "维修", "保险", "洗车", "通勤", "船", "票"],
    emojis: ["🚌", "🚗", "🚕", "🚲", "🛴", "🏍️", "🚄", "✈️", "🚢", "🚇", "🚉", "🅿️", "⛽", "🚦", "🚙", "🛵", "🚐", "🚁", "⚡", "🔧", "🚓", "🚑", "🚒", "🚂", "🚊", "🛶", "⛵", "🚤", "🛸", "🚀"],
  },
  shopping: {
    label: "购物",
    keywords: ["购物", "买", "购", "商场", "超市", "衣服", "鞋", "包", "日用品", "化妆品", "护肤", "饰品", "玩具", "家具", "家电", "手机", "电脑", "平板", "服饰", "裙", "裤", "帽"],
    emojis: ["🛒", "👔", "👗", "👟", "👜", "💼", "⌚", "📱", "💻", "🎮", "📦", "💄", "🧴", "🪥", "👓", "🧸", "🛋️", "💡", "🧹", "🪞", "🛍️", "👕", "👖", "👒", "🧢", "🥾", "🧦", "🧣", "👛", "🎒", "🩰", "👗", "🧥"],
  },
  housing: {
    label: "居家",
    keywords: ["房租", "房贷", "水电", "物业", "燃气", "网费", "话费", "维修", "装修", "家居", "暖气", "宽带", "租金", "房", "住", "床", "桌", "椅", "灯"],
    emojis: ["🏠", "🏡", "🏢", "💡", "🔌", "💧", "🔥", "🛏️", "🪑", "🚿", "🪣", "🧹", "🔑", "🪴", "🧯", "🛁", "🚽", "🧻", "🧼", "🪟", "🚪", "🛖", "🏬", "🏠", "🏡"],
  },
  entertainment: {
    label: "娱乐",
    keywords: ["娱乐", "电影", "游戏", "音乐", "视频", "会员", "演出", "剧本杀", "棋牌", "密室", "景点", "门票", "聚会", "派对", "酒吧", "夜店"],
    emojis: ["🎬", "🎮", "🎵", "🎤", "🎯", "🎳", "🎪", "🎭", "🎨", "🎸", "🎹", "📺", "🎧", "🎟️", "🎫", "🎡", "🎢", "🎠", "♟️", "🎲", "🧩", "🎰", "🎸", "🥁", "🎷", "🎺", "📻", "📹", "🎤", "🎧"],
  },
  sports: {
    label: "运动户外",
    keywords: ["运动", "健身", "游泳", "跑步", "瑜伽", "球", "篮球", "足球", "羽毛球", "乒乓", "网球", "登山", "徒步", "露营", "钓鱼", "骑行", "滑雪", "冲浪", "潜水", "健身房"],
    emojis: ["⚽", "🏀", "🎾", "🏈", "⚾", "🥎", "🏐", "🏉", "🥏", "🎱", "🏓", "🏸", "🥅", "🏒", "🏑", "🥍", "🏏", "🏊", "🧘", "🏃", "🚴", "🎿", "🏄", "🤽", "🏋️", "🤸", "🧗", "🚣", "🎣", "⛺", "🏕️", "🧊"],
  },
  travel: {
    label: "旅行",
    keywords: ["旅游", "旅行", "出差", "酒店", "民宿", "机票", "签证", "行李", "度假", "景点", "海滩", "山", "温泉"],
    emojis: ["✈️", "🧳", "🗺️", "🧭", "📍", "🌍", "🌎", "🌏", "🏖️", "🏝️", "⛰️", "🏔️", "🌋", "🏕️", "🗺️", "🗽", "🗼", "🏰", "🏯", "🎡", "🎢", "🎠", "⛱️", "🛂", "🛅", "🛃", "🛬", "🛫"],
  },
  medical: {
    label: "医疗健康",
    keywords: ["医疗", "药", "医", "医院", "挂号", "体检", "牙科", "眼科", "疫苗", "保健", "中药", "门诊", "住院", "健康", "锻炼"],
    emojis: ["💊", "🏥", "🩺", "💉", "🩹", "🧬", "🫁", "🦷", "👁️", "🧑‍⚕️", "🚑", "🌡️", "🩻", "🧪", "🩸", "💊", "🧴", "🧼", "🪒", "🪥", "🧖", "💪", "🦴", "🦽", "🦼"],
  },
  income: {
    label: "收入理财",
    keywords: ["工资", "奖金", "兼职", "理财", "利息", "分红", "报销", "红包", "转账", "退款", "二手", "出租", "薪资", "提成", "副业", "收入", "投资", "基金", "股票", "存款", "还款", "贷款", "税费"],
    emojis: ["💰", "💵", "💳", "💎", "📈", "🏦", "💼", "🧧", "🎁", "🪙", "💸", "🏧", "📉", "💹", "💱", "💲", "🧾", "🏷️", "🪙", "🏦"],
  },
  education: {
    label: "教育学习",
    keywords: ["教育", "学费", "书", "课程", "培训", "考试", "学习", "文具", "辅导", "考证", "学校", "上课", "笔记", "阅读"],
    emojis: ["📚", "✏️", "📝", "🎓", "📖", "🖊️", "📐", "🎒", "🏫", "💻", "🔬", "🔭", "🧪", "📊", "📋", "📌", "📎", "📐", "📏", "🧮", "🖍️", "🖌️", "🗂️", "📁", "📆", "💡"],
  },
  digital: {
    label: "数码电子",
    keywords: ["数码", "电子", "手机", "电脑", "平板", "耳机", "相机", "充电", "数据线", "配件", "游戏机", "智能", "网络"],
    emojis: ["📱", "💻", "🖥️", "⌨️", "🖱️", "🖨️", "📷", "📸", "📹", "🎥", "📺", "🎙️", "🎧", "🔊", "📡", "💡", "🔋", "🔌", "💾", "💿", "📀", "🎮", "🕹️", "⌚", "📱", "📟", "☎️", "📞", "📵"],
  },
  social: {
    label: "社交通讯",
    keywords: ["社交", "通讯", "电话", "短信", "聊天", "礼物", "红包", "聚会", "请客", "人情", "份子", "礼金"],
    emojis: ["💬", "📨", "📩", "📤", "📥", "📦", "💌", "📧", "📞", "☎️", "📱", "📲", "🤝", "👋", "👍", "🤙", "✌️", "🫂", "🙌", "👏", "💭", "🗯️", "🗣️", "👥", "👪", "👨‍👩‍👧", "🫶", "🤜", "🤛"],
  },
  pet: {
    label: "宠物",
    keywords: ["宠物", "猫", "狗", "鱼", "鸟", "仓鼠", "兔", "龟", "蜥蜴", "宠物用品", "猫粮", "狗粮"],
    emojis: ["🐱", "🐶", "🐟", "🐦", "🐹", "🐰", "🐢", "🦴", "🐾", "🐕", "🐈", "🦜", "🐠", "🦎", "🐍", "🐭", "🦔", "🐝", "🦋", "🐛", "🐌", "🐞"],
  },
  baby: {
    label: "亲子",
    keywords: ["孩子", "宝宝", "婴儿", "亲子", "玩具", "奶粉", "尿布", "母婴", "育儿", "儿童"],
    emojis: ["👶", "🧒", "👧", "👦", "🧑‍🍼", "🍼", "🚼", "🧸", "🪆", "🛴", "🚸", "🎒", "🥛", "🧷", "🚼", "👶", "👶", "🚼"],
  },
  festival: {
    label: "节日礼物",
    keywords: ["节日", "礼物", "生日", "圣诞", "新年", "春节", "中秋", "纪念", "庆祝", "蛋糕", "派对"],
    emojis: ["🎉", "🎊", "🎈", "🎁", "🎂", "🍰", "🎀", "🎄", "🎃", "🧧", "🎇", "🎆", "🪅", "🪄", "✨", "⭐", "🌟", "💫", "🔔", "🎵", "🎶", "🏮", "🎏", "🎑", "🧨", "🎁"],
  },
  office: {
    label: "办公",
    keywords: ["办公", "工作", "会议", "打印", "文具", "电脑", "软件", "订阅", "会员", "云盘", "邮箱"],
    emojis: ["💼", "📎", "📌", "📋", "📁", "📂", "🗂️", "📅", "📆", "🗒️", "📓", "📔", "📒", "📕", "📗", "📘", "📙", "📚", "🖊️", "🖌️", "🖍️", "📝", "✏️", "🔍", "🔎", "💡", "📊", "📈", "📉", "📞", "☎️", "🖥️", "⌨️", "🖱️", "🖨️", "🗄️"],
  },
  beauty: {
    label: "美容个护",
    keywords: ["美容", "美发", "护肤", "化妆", "口红", "香水", "指甲", "spa", "按摩", "理发", "洗发", "造型"],
    emojis: ["💄", "💅", "💆", "💇", "🧖", "🛁", "🚿", "🧴", "🧼", "🪥", "🪒", "🧖‍♀️", "🧖‍♂️", "💧", "✨", "💆", "💅", "💋", "💄", "🪞", "👗", "👙", "🩱"],
  },
  other: {
    label: "其他",
    keywords: [],
    emojis: ["📋", "❤️", "⭐", "🔥", "🎉", "👍", "✅", "📌", "💪", "🌟", "🎀", "🔔", "🎁", "🏆", "💡", "✨", "💫", "⚡", "🌈", "☀️", "🌙", "☁️", "❄️", "🍃", "🌸", "🌺", "🍀", "🌹", "🌻", "🌼", "🌷", "💐", "🍁", "🌾", "🪴"],
  },
};

const emojiGroupList = Object.entries(emojiGroups).map(([key, g]) => ({ key, ...g }));

// 名称命中的分组 key（用于自动滚动定位，但不隐藏其他分组）
const matchedGroupKey = computed<string | null>(() => {
  const name = formName.value.trim();
  if (!name) return null;
  for (const [key, group] of Object.entries(emojiGroups)) {
    if (group.keywords.some((k) => name.includes(k))) return key;
  }
  return null;
});

// 图标区分组容器引用，用于滚动定位
const iconScrollerRef = ref<HTMLElement | null>(null);
const groupHeaderRefs = ref<Record<string, HTMLElement | null>>({});

// 模板 ref 回调类型守卫：仅记录 HTMLElement
function setGroupHeaderRef(key: string) {
  return (el: Element | { $el?: HTMLElement } | null) => {
    const node = el && "$el" in (el as object) ? (el as { $el?: HTMLElement }).$el : (el as HTMLElement | null);
    groupHeaderRefs.value[key] = node ?? null;
  };
}

// ---- 列表模式状态 ----
const showForm = ref(false);
const editingCategory = ref<Category | null>(null);
const listTab = ref<"expense" | "income">("expense");

// ---- 表单模式状态 ----
const formType = ref<"expense" | "income">("expense");
const formName = ref("");
const formIcon = ref("");
const formError = ref("");

// 名称变化时滚动到匹配分组：必须放在 formName 声明之后，
// watch 注册时会同步读取 source 收集依赖，否则触发 formName 的 TDZ ReferenceError。
watch(matchedGroupKey, (key) => {
  if (!key) return;
  nextTick(() => {
    const header = groupHeaderRefs.value[key];
    const scroller = iconScrollerRef.value;
    if (!header || !scroller) return;
    // 滚动到分组标题顶部：用相对视口的 rect 差值，避免 offsetParent 假设
    const delta = header.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "smooth" });
  });
});

// ---- 删除确认状态 ----
const deleteTarget = ref<Category | null>(null);
const showDeleteConfirm = computed(() => deleteTarget.value !== null);

// ---- 删除失败提示状态 ----
const deleteError = ref("");

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
  deleteTarget.value = category;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  try {
    await categoryStore.remove(target.id);
    deleteTarget.value = null;
  } catch (e: unknown) {
    deleteTarget.value = null;
    deleteError.value = e instanceof Error ? e.message : "删除失败";
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
        class="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col rounded-t-2xl bg-surface px-4 pt-4 shadow-xl"
        :style="{ paddingBottom: sheetPadBottom }"
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
                v-if="canEdit(cat)"
                class="rounded px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-gray-200"
                @click="openEdit(cat)"
              >
                编辑
              </button>
              <button
                v-if="canEdit(cat)"
                class="rounded px-2 py-1 text-xs text-expense transition-colors hover:bg-expense/10"
                @click="handleDelete(cat)"
              >
                删除
              </button>
            </div>
          </div>

          <!-- 底部新建按钮 -->
          <button
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

            <!-- 图标候选（按类型分组，始终展示全部；名称命中关键词时自动滚动定位） -->
            <label class="mb-2 block text-sm font-medium text-text">图标</label>
            <div
              ref="iconScrollerRef"
              class="mb-4 max-h-[200px] overflow-auto rounded-lg bg-gray-50"
            >
              <!-- padding 下沉到内部包裹层：scroll 容器不能带 padding-top，
                   否则 sticky top-0 会吸附到 padding box 内沿，顶部留缝、滚动内容从缝里露出 -->
              <div class="px-2 pt-2 pb-2">
              <div
                v-for="group in emojiGroupList"
                :key="group.key"
              >
                <div
                  :ref="setGroupHeaderRef(group.key)"
                  class="sticky top-0 z-10 flex items-center gap-1 bg-gray-50 px-2 -mx-2 py-1 text-[11px] font-medium text-text-secondary"
                >
                  <span>{{ group.label }}</span>
                  <span
                    v-if="matchedGroupKey === group.key"
                    class="rounded bg-primary/15 px-1 text-[10px] text-primary"
                  >匹配</span>
                </div>
                <!-- mt-1 给选中态 ring（含 offset 向外溢出 3px）留出空间，
                     否则 ring 顶部画进 sticky 标题栏的盒子内被其背景盖住 -->
                <div class="mt-1 grid grid-cols-8 gap-1.5">
                  <button
                    v-for="icon in group.emojis"
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

    <!-- 删除确认 -->
    <ConfirmDialog
      :visible="showDeleteConfirm"
      title="删除分类"
      :description="`确定要删除分类「${deleteTarget?.name ?? ''}」吗？`"
      confirm-text="删除"
      danger
      @confirm="confirmDelete"
      @cancel="deleteTarget = null"
    />

    <!-- 删除失败提示 -->
    <ConfirmDialog
      :visible="deleteError !== ''"
      title="删除失败"
      :description="deleteError"
      confirm-text="知道了"
      hide-cancel
      @confirm="deleteError = ''"
      @cancel="deleteError = ''"
    />
  </Teleport>
</template>
