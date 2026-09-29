<script setup lang="ts">
// AI 聊天页（规格 §4.5 / §5.2 / §5.3 / §7.1）。
//
// 页面**不碰 DB、不拼提示词、不把 id 发给模型**：三条边界都在 `aiChat` store 里（见 store 头注释
// 1–3）。这里只做四件事：
//  1. **名表加载**：`buildSnapshot` 只读三个既有 store 的**内存**（`aiChat.ts:476-477` 明写
//     "拉取名表是页面的责任"）⇒ 页面必须自己 `fetchAll` 账户/分类/标签。少了这一步，prompt 会说
//     "账本里还没有分类"，而工具层的 lookup 却走 DB 解析得出来 —— 同一份数据两个加载时机。
//  2. **草稿归位**：`PendingDraft.messageId` 指向产生它的那条 assistant 消息 ⇒ 草稿卡渲染在自己
//     那条消息下面（组件上没有 `messageId`，也不许加回去）。
//  3. **决定归位**（§4.4:160/164）：确认 ⇒ 把决定写进 payload（`aiChat.confirmDraft`）并**留着卡**
//     进「已记账 ✓ + 撤销」；撤销 ⇒ `transactionStore.remove` 走完之后把决定写回 `pending`
//     （`aiChat.undoDraft`）；拒绝 ⇒ 收起。见 `onDraftDismissed` / `onDraftConfirmed` / `onDraftUndone`。
//  4. 首屏探一次能力 + 读一次既有会话。
//
// ⚠️ 消息列表**不**按 `conversationId` 分支：空账本首次发送时它是 `null`（R4 把建会话推迟到
// agent 的 `ensureConversation`）⇒ 拿它当渲染条件的话，第一轮问答直接就看不见了。
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useAiChatStore, type RenderableDraft } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useTransactionStore } from "@/stores/transaction";
import { useAmountMask } from "@/composables/useAmountMask";
import { shouldMaskAmounts } from "@/components/ai/amountMask";
import type { AiMessagePayload } from "@/services/ai/session";
import AppHeader from "@/components/AppHeader.vue";
import AmountMaskToggle from "@/components/AmountMaskToggle.vue";
import ImageLightbox from "@/components/ImageLightbox.vue";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import FilterChips from "@/components/ai/FilterChips.vue";
import DraftCard from "@/components/ai/DraftCard.vue";
import ChatComposer from "@/components/ai/ChatComposer.vue";
import ToolTrace from "@/components/ai/ToolTrace.vue";
import AiPrivacyCard from "@/components/ai/AiPrivacyCard.vue";

const ai = useAiChatStore();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const categoryStore = useCategoryStore();
const tagStore = useTagStore();
const { amountsHidden } = useAmountMask();

/** 滚动容器（消息流自身滚动，输入栏固定在底部） */
const scroller = ref<HTMLElement | null>(null);

/**
 * 草稿按产生它的 assistant 消息分组（`messageId` 只在 store 的草稿条目上）。
 *
 * ⚠️ **三种决定都要收**（§4.4.4 / §4.5:271）：
 * - 待确认、已确认：确认之后卡片要留在原地进「已记账 ✓ + 撤销」（§4.4:164）—— 只渲染
 *   `pendingDrafts` 的话，确认的同一个 flush 里卡片就被卸载（C-P2）。
 * - **已撤回**：渲染成一张静态「已撤回」卡（保留完整摘要、零按钮）。★ 本改动推翻了旧行为
 *   「已拒绝的不渲染、卡从列表里消失」：卡一消失，历史就断了，用户也没法照着摘要重新口述或手记。
 *   决定仍在 store/库里，重进页面照旧是静态卡，**不会**复活成待确认。
 *
 * 类型是 `RenderableDraft`（不是 `PendingDraft`）：卡要拿 `status` 决定初始视图、拿
 * `savedTransactionId` 去撤销 —— 只给 `PendingDraft` 的话这两样在模板里都不存在。
 * 同时它也**排掉了 `superseded`**（§4.4.6：被新草稿取代的旧待确认草稿不渲染），所以这里
 * 三份列表的拼接就是"消息流里该出现的全部草稿"，不许再加第四路。
 */
const draftsByMessage = computed<Record<string, RenderableDraft[]>>(() => {
  const grouped: Record<string, RenderableDraft[]> = {};
  for (const draft of [...ai.pendingDrafts, ...ai.confirmedDrafts, ...ai.rejectedDrafts]) {
    const list = grouped[draft.messageId];
    if (list === undefined) grouped[draft.messageId] = [draft];
    else list.push(draft);
  }
  return grouped;
});

function draftsFor(messageId: string): RenderableDraft[] {
  return draftsByMessage.value[messageId] ?? [];
}

/** payload 是 JSON（`unknown[]`）：只把长度当渲染条件，形状由组件自己收窄 */
function chipsOf(payload: AiMessagePayload | null): unknown[] {
  return payload?.chips ?? [];
}

function traceOf(payload: AiMessagePayload | null): unknown[] {
  return payload?.trace ?? [];
}

/**
 * 这条消息里那张截图的 dataUrl（§4.1 的 `payload.image`），没有就是 null。
 *
 * §4.3 把"带图的历史消息"在**发给模型的上下文**里替换成 `[用户发过一张截图]`，但同一段
 * 规格明写"**不影响**本地存储与页面渲染（页面仍显示缩略图）" ⇒ 历史里那条消息照样要能看见
 * 用户当初发的是哪张图（缩略图的 alt 是"截图"，**不做金额遮罩**：它就是要让用户看清发了什么）。
 */
function thumbOf(payload: AiMessagePayload | null): string | null {
  return payload?.image?.dataUrl ?? null;
}

/**
 * 这条消息的金额要不要遮（§7.4 乙方案）。**判定只在这一处**：`revealed` 是 store 的内存集合
 * （"本轮主动问出来的"），全局 `amountsHidden` 是遮罩本身的语义（默认不看、需要时点开）。
 *
 * 于是四个金额出口共用同一个判定：
 *  - `MessageBubble` 的正文（回填后的汇总数字）
 *  - `FilterChips` 的金额条件（`≥500`）
 *  - `DraftCard` 的金额（含它的编辑区输入框）
 *  - 带图消息的缩略图与大图（截图里可能有余额，见下面的查看器）
 * 用户消息不带 refs / chips / drafts（`content` 就是原文），因此这条判定对它没有副作用。
 */
function isMasked(messageId: string): boolean {
  return shouldMaskAmounts(amountsHidden.value, ai.revealed.has(messageId));
}

/**
 * 全屏查看器（点图片 ⇒ 看大图）。**两处入口**共用这一个实例：
 *  - 历史消息的缩略图（下面 `openMessageImage(m.id)`）；
 *  - 待发附件的缩略图（`openAttachmentImage()`，经 composer 的 `@preview` 上来）。
 *
 * 存的是**消息 id** 而不是拍照式的 `masked` 快照：`revealed` 会变（用户点眼睛揭示的那一刻，
 * 已经打开着的大图必须跟着变清晰）。`null` = 没打开。
 * `messageId === null` 表示待发附件 —— 它没有消息 ⇒ 不可能在 `revealed` 里。
 */
const viewer = ref<{ src: string; messageId: string | null } | null>(null);

function messageImage(messageId: string): string | null {
  const message = ai.messages.find((m) => m.id === messageId);
  return message === undefined ? null : thumbOf(message.payload);
}

function openMessageImage(messageId: string): void {
  const src = messageImage(messageId);
  // 缩略图还在渲染、图却取不到：宁可不打开，也不要弹一个空图
  if (src === null) return;
  viewer.value = { src, messageId };
}

function openAttachmentImage(): void {
  const image = ai.attachedImage;
  if (image === null) return;
  viewer.value = { src: image.dataUrl, messageId: null };
}

/**
 * 大图要不要打码：与缩略图**同一条判定**（`isMasked`）。
 * 待发附件（`messageId === null`）走"一律不打码"，与它的缩略图保持同一条规则。
 */
const viewerMasked = computed(() => {
  const target = viewer.value;
  if (target === null || target.messageId === null) return false;
  return shouldMaskAmounts(amountsHidden.value, ai.revealed.has(target.messageId));
});

/**
 * 待发附件（预览窗格）的缩略图与它的大图：**一律不打码**。
 *
 * 为什么它和历史消息不同：历史消息是"已经发出去的账目截图"，遮蔽防的是之后被人翻屏幕；
 * 而待发附件是用户**刚刚**分享进来、正要发出去的那一张 —— 遮它等于每次截图记账都要先点一次
 * 全局眼睛，而眼睛是全局开关（点开会把历史一起揭掉），于是"防偷看"变成"给自己添一步"。
 * 实机反馈原话：「预览窗格的图片不用模糊的，历史对话的再模糊，否则每次截图记账，都要先点一下
 * 眼睛，有点本末倒置」。历史消息那条路径（`isMasked` / `viewerMasked`）不受影响。
 */
const attachmentMasked = computed(() => false);

/** 「知道了」：先落盘再改内存（失败即 reject）⇒ 失败时卡片留在原地，这里如实报出来 */
async function onPrivacyDismiss(): Promise<void> {
  try {
    await ai.dismissPrivacyCard();
  } catch (e) {
    console.warn("[ai/page] 记录隐私说明卡已读失败：", e);
  }
}

/**
 * 提示条里的「重新检测」：**用户显式**触发一次能力探测（G6/C5.3/C6.3）。
 *
 * 本页只有这一处探测入口，且必须由用户点击产生 —— 自动探测仍然只有 `App.vue` 那一次
 * （第 47 条：`/ai/status` 与 `/ai/chat` 共用一个每分钟桶，页面自动重探会平白吃掉额度）。
 * `refreshStatus` 永不抛，成功与否由提示条文案如实呈现。
 */
async function onRecheck(): Promise<void> {
  await ai.refreshStatus();
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scroller.value;
  if (el !== null) el.scrollTop = el.scrollHeight;
}

onMounted(async () => {
  // ⚠️ 这里**不许**再探一次能力（第 47 条）：自动探针只有 `App.vue` 启动那一处。
  // `/ai/status` 与 `/ai/chat` 共用一个每分钟桶 ⇒ 用户刚问完一句再进本页，第二次探测会吃
  // `ai_rate_limited`，而一个不可判定的探测结果**不该**把已经确认可用的 AI tab 关掉
  // （`refreshStatus` 对这类失败保留上一次已知状态；要刷新只能由用户显式触发）。
  await ledgerStore.init();
  const ledgerId = ledgerStore.currentLedger?.id;
  if (ledgerId !== undefined) {
    try {
      // ⚠️ 三张名表由**页面**拉：快照读的是这三个 store 的内存（见文件头 1）
      await Promise.all([
        accountStore.fetchAll(ledgerId),
        categoryStore.fetchAll(ledgerId),
        tagStore.fetchAll(ledgerId),
      ]);
    } catch (e) {
      // 冷启动 / 未登录时 `getUserDb()` 为 null（Ruling 13），三个 fetchAll 都会抛。
      // 名表拉不到不该让整页打不开：快照退回空表（模型会说"账本里还没有分类"），聊天仍可用；
      // 读会话那条路自己会降级（`load()` 里 DB 为 null 就是空列表）。
      console.warn("[ai/page] 名表加载失败：", e);
    }
  }
  await ai.load();
  await scrollToBottom();
});

/**
 * 决定**没落库**时的回退（收口 R86-4）：卡片本地已经因为 `add` 成功进了「已记账 ✓」视图，而
 * `confirmDraft` / `rejectDraft` / `undoDraft` 返回 `false` 说明库里那份决定没写成 —— 两边不一致
 * 必须让用户看见，且**确认**那条路还要把账上那笔撤回来，否则：
 * 账上多一笔、库里仍是待确认 ⇒ 重进页面草稿复活 ⇒ 用户再确认一次 = **第二笔真账**。
 *
 * 文案由**页面**给（只有它知道账上那笔撤没撤成功），卡只负责显示。
 */
const rollback = ref<Record<string, { seq: number; text: string }>>({});
function markRollback(draftId: string, text: string): void {
  const seq = (rollback.value[draftId]?.seq ?? 0) + 1;
  rollback.value = { ...rollback.value, [draftId]: { seq, text } };
}
function rollbackOf(draftId: string): { seq: number; text: string } {
  return rollback.value[draftId] ?? { seq: 0, text: "" };
}

/**
 * 撤回：把这条草稿的决定写成 `rejected`（§4.4.4：卡**留在消息流里**变成静态「已撤回」，
 * 摘要完整、零按钮 —— 它对应的那笔钱从未入账）。
 *
 * ⚠️ 与 `confirm` **不同**（§4.4:164）：确认后卡片要留着显示「已记账 ✓ + 撤销」，所以
 * `onDraftConfirmed` 只把**决定**写进 payload（`confirmDraft`）—— 卡片因为 `status === "confirmed"`
 * 继续被 `draftsFor()` 渲染，只是换了视图；撤回这条路同样只写决定，卡片的视图由 `status` 播种。
 *
 * ⚠️ `draftId` 必须是**这张卡自己的**（模板里从 `v-for` 的 item 直接传进来），不能取"当前第一张"
 * 或"列表里最后一张"：`transactionStore.add` 在途期间草稿列表可能被重建（新的一轮、清空、
 * `load()`），而 `confirm` 是**这张卡**发出来的 —— 收错人的后果是另一张草稿被**静默**收起
 * （用户以为它记上了，或它其实没记上却从列表里消失了）。
 * 同一实例换草稿由卡内自清兜住（`DraftCard.vue` 的 props 注释），跨草稿的身份由下面的 `:key` 钉住。
 */
async function onDraftDismissed(draftId: string): Promise<void> {
  if (await ai.rejectDraft(draftId)) return;
  markRollback(draftId, "这条决定没存下，草稿仍是待确认，请重试");
}

/** 确认入账：**保留这张卡**（决定落库 ⇒ 它进「已记账 ✓ + 撤销」，`transactionId` 供撤销用） */
async function onDraftConfirmed(draftId: string, transactionId: string): Promise<void> {
  if (await ai.confirmDraft(draftId, transactionId)) return;
  // 决定没写进去 ⇒ 把卡片刚记的那笔**撤回**（记账的唯一入口就是它，页面这层做补偿）
  try {
    await useTransactionStore().remove(transactionId);
    markRollback(draftId, "决定没存下，已把那笔撤回，请重试");
  } catch {
    // 撤回也失败：不装作没事 —— 这种形态只能让人去核对
    markRollback(draftId, "决定没存下，那笔也没能撤回，请到流水页核对");
  }
}

/**
 * 撤销：`transactionStore.remove` 已经由**卡片**走完（id 是 `add` 的返回值），这里只把决定写回
 * `pending`（扩展，依据见 `aiChat.undoDraft` 的注释）。落库失败时同样不许静默：那笔交易已经
 * 真删了，而库里还写着"已确认" ⇒ 重进页面会显示「已记账 ✓」配一个已经不存在的交易。
 */
async function onDraftUndone(draftId: string): Promise<void> {
  if (await ai.undoDraft(draftId)) return;
  markRollback(draftId, "撤销的决定没存下，请到流水页核对");
}

/** 清空会话：413 的文案就是"清空会话记录后再试"（§5.3），所以必须有这个入口 */
function onClear(): void {
  void ai.clear();
}

function onSend(text: string): void {
  void ai.send(text);
}

function onCancel(): void {
  ai.cancel();
}

// 消息数一变就滚到底（新问答与迟到的回答都算）
watch(
  () => ai.messages.length,
  () => void scrollToBottom(),
);
</script>

<template>
  <div class="flex h-full flex-col bg-bg">
    <AppHeader title="AI 助手">
      <template #action>
        <!--
          Bug 2：金额遮蔽的就地开关。本页确实按 `shouldMaskAmounts` 遮金额（三个出口都走
          `isMasked()`），却没有眼睛图标 ⇒ 用户只能切去别的页面开完再切回来。

          ⚠️ 它就是别的页面上那个 `AmountMaskToggle`，控的是**同一个全局** `amountsHidden`。
          本页特有的 §7.4 乙方案（`revealed`：本轮问出来的显示真值）**不归它管**，
          也不许为了它去改 `revealed` —— 两者是"用户现在想不想看"与"这条是不是我刚问的"。
          它**恒渲染**（不像「清空」要看有没有消息）：全局开关跟本页有没有对话无关，
          与 AccountList / ReportsPage / TransactionList 三处的形态一致。
        -->
        <div class="flex items-center gap-1">
          <AmountMaskToggle />
          <button
            v-if="ai.messages.length > 0"
            type="button"
            class="text-sm text-text-secondary"
            data-test="ai-clear"
            @click="onClear"
          >
            清空
          </button>
        </div>
      </template>
    </AppHeader>

    <!--
      §7.3 的一次性说明卡：`host === null` 时组件自己整个不渲染（拿不到 host 就不问用户同不同意）。
      `seen` 是持久化标记（冷启动读一次），「知道了」由页面转给 store。
    -->
    <AiPrivacyCard :host="ai.host" :seen="ai.privacyCardSeen" @dismiss="onPrivacyDismiss" />

    <div ref="scroller" class="flex-1 overflow-auto px-4 py-4" data-test="ai-scroller">
      <p v-if="ai.loading" class="text-sm text-text-secondary" data-test="ai-loading">
        正在读取会话…
      </p>
      <template v-else>
        <p
          v-if="ai.messages.length === 0"
          class="text-sm text-text-secondary"
          data-test="ai-empty"
        >
          问点什么吧，比如「上月买菜花了多少」
        </p>
        <div v-for="m in ai.messages" :key="m.id" class="mb-3 space-y-2" data-test="ai-message">
          <MessageBubble :message="m" :masked="isMasked(m.id)" />
          <!--
            缩略图：§4.3 只换了**发给模型的上下文**，本地这条消息照样要能看见当初发的是哪张图。
            ⚠️ 两件事都在这一个 `<img>` 上：
             1. **点开看大图**（`openMessageImage`）：图是 base64 data URL ⇒ 直接给查看器的 `<img>`，
                不碰文件系统、不用 `convertFileSrc`、也不指望 asset 协议（CSP 没开 asset:）。
             2. **打码**：与气泡/条件/草稿卡同一条判定（`isMasked`）—— 图里可能有余额，
                遮蔽开着且这条没被揭示时，缩略图与大图一起模糊（眼睛揭示后两处一起转清晰）。
          -->
          <!--
            缩略图外面那层框：**描边落在这里**，不画在 `<img>` 上 —— `<img>` 上的 `blur-lg`
            是 `filter: blur()`，会把同一元素的边框一起糊掉；`overflow-hidden` 顺便夹住外溢的模糊
            （外溢正是"列表里的小图与背景糊成一片、看起来像没图"的来源）。清晰时也留框。
          -->
          <div
            v-if="thumbOf(m.payload) !== null"
            class="h-16 w-16 shrink-0 overflow-hidden rounded ring-1 ring-gray-300"
            data-test="ai-message-thumb-frame"
          >
            <img
              :src="thumbOf(m.payload) ?? ''"
              alt="截图"
              class="h-full w-full cursor-pointer object-cover"
              :class="isMasked(m.id) ? 'blur-lg' : ''"
              data-test="ai-message-thumb"
              @click="openMessageImage(m.id)"
            />
          </div>
          <FilterChips
            v-if="chipsOf(m.payload).length > 0"
            :chips="chipsOf(m.payload)"
            :masked="isMasked(m.id)"
          />
          <ToolTrace v-if="traceOf(m.payload).length > 0" :trace="traceOf(m.payload)" />
          <DraftCard
            v-for="d in draftsFor(m.id)"
            :key="d.draftId"
            :draft="d.draft"
            :resolved="d.resolved"
            :masked="isMasked(m.id)"
            :status="d.status"
            :transaction-id="d.savedTransactionId"
            :rollback="rollbackOf(d.draftId).seq"
            :rollback-message="rollbackOf(d.draftId).text"
            @confirm="onDraftConfirmed(d.draftId, $event)"
            @undo="onDraftUndone(d.draftId)"
            @reject="onDraftDismissed(d.draftId)"
          />
        </div>
        <!--
          Bug 1：一轮对话**在途中**的可见反馈。

          ⚠️ 判据是 `ai.sending`（`runTurn` 置位 / 三条结束路径都收：成功、失败走 `finally`，
          取消走 `cancelInFlight()`），**不是** `ai.loading` —— 后者只服务首次读历史，
          发送期间恒为 false，拿它当条件等于什么都没有（实机形态：发问后页面毫无反应、
          过一会结果一次性弹出）。
          ⚠️ 别再往 composer 那一侧加：它在 `sending` 时已经把发送键换成「取消」键了，
          这里补的是**消息流**这一侧的"在等回答"（用户眼睛盯着的就是那里）。
        -->
        <p v-if="ai.sending" class="text-sm text-text-secondary" data-test="ai-thinking">
          正在思考…
        </p>
      </template>
    </div>

    <!--
      发不出去时必须让用户看见**为什么**（§7.3 + G3/C5）。三类情形分开说，一律由 store 的
      纯函数出文案（`services/ai/failureText.ts`），页面里**不许**再出现
      `host === null ? "服务端未配置 AI…"` 式的三元 —— 真机事故正是那句话把
      "地址/登录态未就绪"说成了"服务端没配"，把用户引向完全错误的方向。

      三种状态（互斥，顺序即优先级）：
      1. 意愿层关着 ⇒ 说"去哪打开"（`我的 → 隐私`，`AiChatPage.test.ts:747` 逐字钉住）；
      2. 服务端**明确**没配 ⇒ 唯一允许出现「未配置」的情形（C5.4）；
      3. 已开启但拿不到结论 ⇒ 说清这轮是哪一类失败，并给一个**用户显式**的重试入口（C5.3）。
    -->
    <p
      v-if="!ai.sendingEnabled"
      class="border-t border-gray-100 px-4 py-2 text-xs text-text-secondary"
      data-test="ai-sending-off-hint"
    >
      {{ ai.sendingHint }}
    </p>
    <p
      v-else-if="ai.configured === false"
      class="border-t border-gray-100 px-4 py-2 text-xs text-text-secondary"
      data-test="ai-not-configured"
    >
      {{ ai.sendingHint }}
    </p>
    <p
      v-else-if="ai.host === null"
      class="flex items-center gap-2 border-t border-gray-100 px-4 py-2 text-xs text-text-secondary"
      data-test="ai-sending-unknown"
    >
      <span>{{ ai.sendingHint }}</span>
      <button
        type="button"
        data-test="ai-recheck"
        class="rounded-lg border border-gray-200 bg-surface px-2 py-1 text-xs text-text-secondary"
        @click="onRecheck"
      >
        重新检测
      </button>
    </p>

    <!--
      分享入口的一行提示（本设计 §5.5）：多图"只取了第一张"、或分享失败的那句话。
      位置刻意贴着输入区（与 `ChatComposer` 内部那条选图错误同一个视觉位置），
      来源不同所以是两条独立的 <p>：那条说"你刚选的图怎么了"，这条说"你刚分享的图怎么了"。
    -->
    <p
      v-if="ai.imageNotice !== ''"
      class="border-t border-gray-100 px-4 py-2 text-xs text-red-500"
      data-test="ai-share-notice"
    >
      {{ ai.imageNotice }}
    </p>

    <!--
      E12.1：附件**归 store**（`ai.attachedImage`），composer 只渲染 + 发事件 ⇒ 接线在这里。
      `@attach` / `@remove-attachment` 两个方向都必须接：漏掉前者选完图不出预览，
      漏掉后者点 ✕ 没反应 —— 两者都是"页面以为组件自己在管"这类断线的典型形态。
      `@preview` 是第三个方向：点待发附件的缩略图看大图，与历史缩略图同一个查看器；
      `:image-masked` 把"要不要打码"的判定从组件里收回到页面 —— 待发附件恒 `false`（实机
      反馈：预览窗格不模糊，只有历史对话模糊，见 `attachmentMasked`）。
    -->
    <ChatComposer
      :sending="ai.sending"
      :enabled="ai.sendingEnabled"
      :image="ai.attachedImage"
      :image-masked="attachmentMasked"
      @send="onSend"
      @cancel="onCancel"
      @attach="ai.setAttachedImage"
      @remove-attachment="ai.clearAttachedImage()"
      @preview="openAttachmentImage"
    />

    <!--
      全屏查看器：**只挂这一个实例**（两处入口共用）。`z-[60]` 高于锁屏弹层的 z-50；
      返回键由它自己用哨兵历史条目实现（Tauri 没有 `onBackButton` 监听，见组件头注释）。
    -->
    <ImageLightbox
      :visible="viewer !== null"
      :src="viewer?.src ?? ''"
      :masked="viewerMasked"
      @close="viewer = null"
    />
  </div>
</template>
