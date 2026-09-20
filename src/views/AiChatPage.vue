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
import { useAiChatStore, type DecidedDraft } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useAmountMask } from "@/composables/useAmountMask";
import { shouldMaskAmounts } from "@/components/ai/amountMask";
import type { AiMessagePayload } from "@/services/ai/session";
import AppHeader from "@/components/AppHeader.vue";
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
 * ⚠️ 必须同时收**待确认**与**已确认**两份：确认之后卡片要留在原地进「已记账 ✓ + 撤销」
 * （§4.4:164）—— 只渲染 `pendingDrafts` 的话，确认的同一个 flush 里卡片就被卸载（C-P2）。
 * 已拒绝的那份不在这里：它不该再渲染（但决定仍在 store/库里，重进页面不会复活成待确认）。
 *
 * 类型是 `DecidedDraft`（不是 `PendingDraft`）：卡要拿 `status` 决定初始视图、拿
 * `savedTransactionId` 去撤销 —— 只给 `PendingDraft` 的话这两样在模板里都不存在。
 */
const draftsByMessage = computed<Record<string, DecidedDraft[]>>(() => {
  const grouped: Record<string, DecidedDraft[]> = {};
  for (const draft of [...ai.pendingDrafts, ...ai.confirmedDrafts]) {
    const list = grouped[draft.messageId];
    if (list === undefined) grouped[draft.messageId] = [draft];
    else list.push(draft);
  }
  return grouped;
});

function draftsFor(messageId: string): DecidedDraft[] {
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
 * 这条消息的金额要不要遮（§7.4 乙方案）。**判定只在这一处**：`revealed` 是 store 的内存集合
 * （"本轮主动问出来的"），全局 `amountsHidden` 是遮罩本身的语义（默认不看、需要时点开）。
 *
 * 于是三个金额出口共用同一个判定：
 *  - `MessageBubble` 的正文（回填后的汇总数字）
 *  - `FilterChips` 的金额条件（`≥500`）
 *  - `DraftCard` 的金额（含它的编辑区输入框）
 * 用户消息不带 refs / chips / drafts（`content` 就是原文），因此这条判定对它没有副作用。
 */
function isMasked(messageId: string): boolean {
  return shouldMaskAmounts(amountsHidden.value, ai.revealed.has(messageId));
}

/** 「知道了」：先落盘再改内存（失败即 reject）⇒ 失败时卡片留在原地，这里如实报出来 */
async function onPrivacyDismiss(): Promise<void> {
  try {
    await ai.dismissPrivacyCard();
  } catch (e) {
    console.warn("[ai/page] 记录隐私说明卡已读失败：", e);
  }
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
 * 拒绝（`reject`）与**撤销**（`undo`）在页面上是**同一个动作**：把这张卡移出待确认。
 *
 * ⚠️ 与 `confirm` **不同**（§4.4:164）：确认后卡片要留着显示「已记账 ✓ + 撤销」，所以
 * `onDraftConfirmed` 只把**决定**写进 payload（`confirmDraft`）—— 卡片因为 `status === "confirmed"`
 * 继续被 `draftsFor()` 渲染，只是换了视图。
 *
 * ⚠️ `draftId` 必须是**这张卡自己的**（模板里从 `v-for` 的 item 直接传进来），不能取"当前第一张"
 * 或"列表里最后一张"：`transactionStore.add` 在途期间草稿列表可能被重建（新的一轮、清空、
 * `load()`），而 `confirm` 是**这张卡**发出来的 —— 收错人的后果是另一张草稿被**静默**收起
 * （用户以为它记上了，或它其实没记上却从列表里消失了）。
 * 同一实例换草稿由卡内自清兜住（`DraftCard.vue` 的 props 注释），跨草稿的身份由下面的 `:key` 钉住。
 */
function onDraftDismissed(draftId: string): void {
  void ai.rejectDraft(draftId);
}

/** 确认入账：**保留这张卡**（决定落库 ⇒ 它进「已记账 ✓ + 撤销」，`transactionId` 供撤销用） */
function onDraftConfirmed(draftId: string, transactionId: string): void {
  void ai.confirmDraft(draftId, transactionId);
}

/**
 * 撤销：`transactionStore.remove` 已经由**卡片**走完（id 是 `add` 的返回值），这里只把决定写回
 * `pending` —— 卡片随即回到"可确认"（§4.4「确认后仍可反悔」，与卡内 `resetForNewDraft` 同一语义）。
 */
function onDraftUndone(draftId: string): void {
  void ai.undoDraft(draftId);
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
        <button
          v-if="ai.messages.length > 0"
          type="button"
          class="text-sm text-text-secondary"
          data-test="ai-clear"
          @click="onClear"
        >
          清空
        </button>
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
            @confirm="onDraftConfirmed(d.draftId, $event)"
            @undo="onDraftUndone(d.draftId)"
            @reject="onDraftDismissed(d.draftId)"
          />
        </div>
      </template>
    </div>

    <!--
      意愿层关着时**必须让用户看见为什么发不出去**（§7.3）：两种情形文案不同 ——
      没有 host = 服务端没配（能力层），有 host 但开关关着 = 去隐私设置里打开（意愿层）。
    -->
    <p
      v-if="!ai.sendingEnabled && ai.enabled"
      class="border-t border-gray-100 px-4 py-2 text-xs text-text-secondary"
      data-test="ai-sending-off-hint"
    >
      {{
        ai.host === null
          ? "服务端未配置 AI：这台设备暂时用不了助手。"
          : "AI 助手已关闭，去「我的 → 隐私」打开后才能发送。"
      }}
    </p>

    <ChatComposer :sending="ai.sending" :enabled="ai.sendingEnabled" @send="onSend" @cancel="onCancel" />
  </div>
</template>
