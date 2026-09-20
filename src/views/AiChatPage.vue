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
//  3. **收起时机**：`confirm`（带新交易 id；`saved` 已删，两个都监听会把 `dismissDraft` 调两次）
//     与 `reject` 都只收起**这张卡自己的**草稿 —— 见 `onDraftDismissed`。
//  4. 首屏探一次能力 + 读一次既有会话。
//
// ⚠️ 消息列表**不**按 `conversationId` 分支：空账本首次发送时它是 `null`（R4 把建会话推迟到
// agent 的 `ensureConversation`）⇒ 拿它当渲染条件的话，第一轮问答直接就看不见了。
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useAiChatStore, type PendingDraft } from "@/stores/aiChat";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import type { AiMessagePayload } from "@/services/ai/session";
import AppHeader from "@/components/AppHeader.vue";
import MessageBubble from "@/components/ai/MessageBubble.vue";
import FilterChips from "@/components/ai/FilterChips.vue";
import DraftCard from "@/components/ai/DraftCard.vue";
import ChatComposer from "@/components/ai/ChatComposer.vue";
import ToolTrace from "@/components/ai/ToolTrace.vue";

const ai = useAiChatStore();
const ledgerStore = useLedgerStore();
const accountStore = useAccountStore();
const categoryStore = useCategoryStore();
const tagStore = useTagStore();

/** 滚动容器（消息流自身滚动，输入栏固定在底部） */
const scroller = ref<HTMLElement | null>(null);

/** 草稿按产生它的 assistant 消息分组（`messageId` 只在 store 的 `PendingDraft` 上） */
const draftsByMessage = computed<Record<string, PendingDraft[]>>(() => {
  const grouped: Record<string, PendingDraft[]> = {};
  for (const draft of ai.pendingDrafts) {
    const list = grouped[draft.messageId];
    if (list === undefined) grouped[draft.messageId] = [draft];
    else list.push(draft);
  }
  return grouped;
});

function draftsFor(messageId: string): PendingDraft[] {
  return draftsByMessage.value[messageId] ?? [];
}

/** payload 是 JSON（`unknown[]`）：只把长度当渲染条件，形状由组件自己收窄 */
function chipsOf(payload: AiMessagePayload | null): unknown[] {
  return payload?.chips ?? [];
}

function traceOf(payload: AiMessagePayload | null): unknown[] {
  return payload?.trace ?? [];
}

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const el = scroller.value;
  if (el !== null) el.scrollTop = el.scrollHeight;
}

onMounted(async () => {
  // 探一次能力（**不轮询**，M2 契约第 4 条）。`refreshStatus` 永不抛 ⇒ 不需要守卫；
  // 页面已经打开时探测失败只会让 tab 消失，不影响本页。
  void ai.refreshStatus();

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
 * 确认入账（`confirm`）与拒绝（`reject`）在页面上是**同一个动作**：把这张卡移出待确认。
 *
 * ⚠️ `draftId` 必须是**这张卡自己的**（模板里从 `v-for` 的 item 直接传进来），不能取"当前第一张"
 * 或"列表里最后一张"：`transactionStore.add` 在途期间草稿列表可能被重建（新的一轮、清空、
 * `load()`），而 `confirm` 是**这张卡**发出来的 —— 收错人的后果是另一张草稿被**静默**收起
 * （用户以为它记上了，或它其实没记上却从列表里消失了）。
 * 配套的第一道防线是 `:key="draftId"`（同一个实例绝不换草稿）。
 */
function onDraftDismissed(draftId: string): void {
  ai.dismissDraft(draftId);
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
          <MessageBubble :message="m" />
          <FilterChips v-if="chipsOf(m.payload).length > 0" :chips="chipsOf(m.payload)" />
          <ToolTrace v-if="traceOf(m.payload).length > 0" :trace="traceOf(m.payload)" />
          <DraftCard
            v-for="d in draftsFor(m.id)"
            :key="d.draftId"
            :draft="d.draft"
            :resolved="d.resolved"
            @confirm="onDraftDismissed(d.draftId)"
            @reject="onDraftDismissed(d.draftId)"
          />
        </div>
      </template>
    </div>

    <ChatComposer :sending="ai.sending" @send="onSend" @cancel="onCancel" />
  </div>
</template>
