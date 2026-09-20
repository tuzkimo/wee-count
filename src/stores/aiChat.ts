// src/stores/aiChat.ts
// AI 会话状态（规格 §4.5 / §5.2 / §5.3 / §7.1）。
//
// 本 store 只做**编排**，四条边界各有一条能红的用例：
//  1. **不写库**：落库全在 `agent → session` 里；草稿的"确认/撤销"是 UI 走 `transactionStore`
//     的既有流程，本 store 只把它从"待确认"列表里拿掉（多一个写入口就是多一条绕开校验的路）。
//  2. **不拼提示词**：system prompt 由 `prompt.ts` 组装；这里只提供**白名单**的账本快照。
//  3. **不发 id 给模型**：快照逐字段取 name/type —— store 里的实体带 `id`/`ledger_id`/`owner_id`，
//     直接展开就等于把 id 放进一个"会被渲染进 prompt"的对象里（§7.3 绝不发 id）。
//  4. **取消不是错误**（§5.2/§5.3）：取消由 agent 判决（`AgentTurn.aborted`），本 store 只负责
//     不把它渲染成消息、也不设 `error`；靠 `text === ""` 猜是错的（agent 的判决才是唯一真相）。
//
// ⚠️ 取消有两条入口，都归 `cancelInFlight()`：① 用户点「取消」；② 生成中又发一条（§5.2）。
//   被取代的那一轮**可能在被 abort 之前就拿到终稿**（abort 落在 `persistAssistant` 的 await 里），
//   所以除了 `abort()` 还需要轮次令牌 `runSeq`，否则旧轮的答案会插到新轮后面。
import { defineStore } from "pinia";
import { ref, watch } from "vue";
import { getCurrentUserId, getTeamMembers } from "@/db/userDb";
import { useAuthStore } from "@/stores/auth";
import { useLedgerStore } from "@/stores/ledger";
import { useAccountStore } from "@/stores/account";
import { useCategoryStore } from "@/stores/category";
import { useTagStore } from "@/stores/tag";
import { useMemberInfo } from "@/composables/useMemberInfo";
import {
  appendMessage,
  clearConversation,
  ensureConversation,
  loadMessages,
  recentTurns,
  setTitleIfEmpty,
  type AiMessagePayload,
} from "@/services/ai/session";
import {
  DB_FAILURE_TEXT,
  runAgent,
  type AgentSession,
  type AgentTurn,
} from "@/services/ai/agent";
import { createTransport } from "@/services/ai/transport";
import type { LedgerSnapshot } from "@/services/ai/prompt";
import { ACCOUNT_TYPE_LABELS } from "@/types";

/** `agent.ts` 的 `AgentSession` 结构上就是 session.ts 这四项 —— 显式列出来，别让它悄悄少一项 */
const AGENT_SESSION: AgentSession = {
  ensureConversation,
  recentTurns,
  appendMessage,
  setTitleIfEmpty,
};

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 消息流里的一条（`content` 是**占位符原文**，渲染时才用 `payload.refs` 回填 —— §4.5） */
export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  payload: AiMessagePayload | null;
  createdAt: string;
}

/** 草稿字段（形状由 `tools.ts` 的草稿工具产出；那里是私有的，故此处重声明一份） */
export interface AiDraftFields {
  type: "expense" | "income" | "transfer";
  amount: number;
  category: string | null;
  fromAccount: string | null;
  toAccount: string | null;
  occurredAt: string;
  note: string | null;
  tags: string[];
}

/** 草稿里名字解析出的**本地** id（给记账用，绝不上行） */
export interface AiDraftIds {
  categoryId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  tagIds: string[];
}

/** 一条"待确认"的草稿。`messageId` 指向产生它的 assistant 消息（UI 用来定位草稿卡） */
export interface PendingDraft {
  draftId: string;
  draft: AiDraftFields;
  resolved: AiDraftIds;
  messageId: string;
}

// ---------------------------------------------------------------------------
// payload / 草稿的运行期收窄
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((it) => typeof it === "string");
}

/**
 * `payload` 在库里是 JSON 文本。坏行**不该让整条消息消失**（content 是用户唯一能看的东西），
 * 所以解析失败/形状不是对象时降级成 null，绝不抛。
 */
function parsePayload(raw: string | null): AiMessagePayload | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as AiMessagePayload) : null;
  } catch {
    return null;
  }
}

/**
 * 从 payload 里挑出**形状完整**的草稿（`payload.drafts` 的类型是 `unknown[]`：payload 是 JSON）。
 * 形状不全的条目直接跳过 —— 一条坏草稿不该让整张列表渲染不出来。
 *
 * ⚠️ 这是**唯一**的草稿读法：刚生成的一轮和从库里读回来的一轮都走它，
 * 于是"落库 → 重开 → 草稿卡还在"不需要第二份解析。
 */
function readDrafts(payload: AiMessagePayload | null, messageId: string): PendingDraft[] {
  if (payload === null || !Array.isArray(payload.drafts)) return [];
  const out: PendingDraft[] = [];
  for (const item of payload.drafts) {
    if (!isRecord(item)) continue;
    const { draftId, draft, resolved } = item;
    if (typeof draftId !== "string" || draftId === "") continue;
    if (!isRecord(draft) || !isRecord(resolved)) continue;

    const type = draft.type;
    const amount = draft.amount;
    const occurredAt = draft.occurredAt;
    // 逐条件写而不是 `DRAFT_TYPES.includes(type)`：TS 才能把 type 收窄成联合类型（不用 as）
    if (type !== "expense" && type !== "income" && type !== "transfer") continue;
    if (typeof amount !== "number" || !Number.isFinite(amount)) continue;
    if (typeof occurredAt !== "string") continue;
    if (!isStringArray(draft.tags)) continue;
    if (!isStringOrNull(draft.category) || !isStringOrNull(draft.fromAccount)) continue;
    if (!isStringOrNull(draft.toAccount) || !isStringOrNull(draft.note)) continue;
    if (!isStringOrNull(resolved.categoryId) || !isStringOrNull(resolved.fromAccountId)) continue;
    if (!isStringOrNull(resolved.toAccountId) || !isStringArray(resolved.tagIds)) continue;

    out.push({
      draftId,
      messageId,
      draft: {
        type,
        amount,
        category: draft.category,
        fromAccount: draft.fromAccount,
        toAccount: draft.toAccount,
        occurredAt,
        note: draft.note,
        tags: draft.tags,
      },
      resolved: {
        categoryId: resolved.categoryId,
        fromAccountId: resolved.fromAccountId,
        toAccountId: resolved.toAccountId,
        tagIds: resolved.tagIds,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export const useAiChatStore = defineStore("aiChat", () => {
  const ledgerStore = useLedgerStore();

  const messages = ref<UiMessage[]>([]);
  /** 读既有消息中（`load`） */
  const loading = ref(false);
  /** 一轮对话中（`send`）：UI 用它禁用输入框 / 显取消按钮 */
  const sending = ref(false);
  /**
   * **store 层**开不了口的失败（没有账本 / agent 契约被改坏）。
   *
   * §5.3 的业务失败（超时、DSL 纠错用尽、轮数用尽…）**不**走这里 —— 它们是 agent 返回的一段
   * 文本，直接落成消息流里的一条，避免"错误"有第二份真相。第一轮里没有账本可绑（Ruling 14）
   * 和"agent 抛了"这两种连消息都拿不到的情况才用它 + 一条 `DB_FAILURE_TEXT` 消息兜底。
   */
  const error = ref<string | null>(null);
  /** 当前账本的会话 id（切账本即切会话，Ruling 14） */
  const conversationId = ref<string | null>(null);
  /** 待确认的草稿（确认/撤销后由 `dismissDraft` 移出；落库是 UI 的事） */
  const pendingDrafts = ref<PendingDraft[]>([]);

  /** 在途那一轮的取消句柄（同时只允许一轮） */
  let inFlight: AbortController | null = null;
  /** 轮次令牌：被取代的那一轮 settle 时**不得**再动状态 */
  let runSeq = 0;
  /** 加载令牌：旧账本的响应可能后到，不能覆盖新账本的消息（账本隔离） */
  let loadSeq = 0;

  // -------------------------------------------------------------------------
  // 读既有会话
  // -------------------------------------------------------------------------

  /** 读当前账本的既有消息。DB 未就绪时降级成空列表（Ruling 13），不抛。 */
  async function load(): Promise<void> {
    const seq = ++loadSeq;
    loading.value = true;
    error.value = null;
    try {
      const ledgerId = ledgerStore.currentLedgerId;
      if (ledgerId === null) {
        // 没有账本就没有会话可谈：绝不能拿空串去 ensureConversation（那会建出绑空账本的会话行）
        if (seq !== loadSeq) return;
        conversationId.value = null;
        messages.value = [];
        pendingDrafts.value = [];
        return;
      }

      const convId = await ensureConversation(ledgerId, new Date());
      if (seq !== loadSeq) return;
      conversationId.value = convId;
      if (convId === null) {
        // `getUserDb()` 为 null（冷启动 / 未登录，Ruling 13）是**预期**降级，不是错误
        messages.value = [];
        pendingDrafts.value = [];
        return;
      }

      const rows = await loadMessages(convId);
      if (seq !== loadSeq) return;
      // payload 整份留着：refs 是回填的唯一真源，chips/drafts 是 UI 的输入（§4.5）
      messages.value = rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        payload: parsePayload(r.payload),
        createdAt: r.created_at,
      }));
      pendingDrafts.value = messages.value.flatMap((m) => readDrafts(m.payload, m.id));
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  // -------------------------------------------------------------------------
  // 发送 / 取消
  // -------------------------------------------------------------------------

  /**
   * 发一条消息。**永不抛**（与 agent 同一契约）：说话这件事的失败也要变成消息流里的一条（§5.3）。
   */
  async function send(text: string): Promise<void> {
    const userText = text.trim();
    if (userText === "") return;

    // 生成中又发一条 ⇒ 掐掉在途那一轮（§5.2）。丢弃的是**结果**，不是用户已经说出口的话
    cancelInFlight();
    const seq = ++runSeq;
    const controller = new AbortController();
    inFlight = controller;
    sending.value = true;
    error.value = null;

    const ledgerId = ledgerStore.currentLedgerId;
    messages.value.push({
      id: crypto.randomUUID(),
      role: "user",
      content: userText,
      payload: null,
      createdAt: new Date().toISOString(),
    });

    try {
      if (ledgerId === null) {
        fail(DB_FAILURE_TEXT);
        return;
      }
      const snapshot = await buildSnapshot();
      const turn = await runAgent({
        userText,
        ledgerId,
        snapshot,
        deps: { transport: createTransport(), session: AGENT_SESSION },
        signal: controller.signal,
      });
      if (seq !== runSeq) return; // 已被新的一轮取代：它的账不该记进列表
      if (turn.aborted) return; // 取消：不追加任何消息、不设 error（§5.2/§5.3）
      appendTurn(turn);
    } catch (e) {
      // agent 的契约是"永不抛"，这里只兜住契约被改坏的那一天（照 agent 兜 buildLookupContext 的写法）。
      // **必须打日志**：这是唯一能看到抛出原因的地方。
      console.warn("[ai/store] send 意外抛出：", e);
      if (seq !== runSeq) return;
      fail(DB_FAILURE_TEXT);
    } finally {
      if (seq === runSeq) sending.value = false;
      if (inFlight === controller) inFlight = null;
    }
  }

  /** 用户点「取消」：掐掉在途请求，**不产生任何消息**（§5.2 的"丢弃结果"） */
  function cancel(): void {
    cancelInFlight();
  }

  /** 在途那一轮的收尾：abort + 作废它的令牌 + 立刻让输入框可用（不等它 settle） */
  function cancelInFlight(): void {
    const controller = inFlight;
    if (controller === null) return;
    inFlight = null;
    runSeq++;
    controller.abort();
    sending.value = false;
  }

  /** store 层开不了口时的兜底：一句人话（复用 agent 的常量，不新增第二份文案）+ error 态 */
  function fail(text: string): void {
    error.value = text;
    appendAssistant(text, null);
  }

  function appendTurn(turn: AgentTurn): void {
    const message = appendAssistant(turn.text, {
      chips: turn.chips,
      drafts: turn.drafts,
      refs: turn.refs,
      trace: turn.trace,
    });
    pendingDrafts.value.push(...readDrafts(message.payload, message.id));
  }

  function appendAssistant(content: string, payload: AiMessagePayload | null): UiMessage {
    const message: UiMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content,
      payload,
      createdAt: new Date().toISOString(),
    };
    messages.value.push(message);
    return message;
  }

  // -------------------------------------------------------------------------
  // 清空 / 草稿
  // -------------------------------------------------------------------------

  /**
   * 清空当前账本的会话。**真删消息 + 软删会话行**由 `clearConversation(ledgerId, now)` 负责
   * （Ruling 7：只清内存的话，重开 App 消息又回来了）；会话行 id 不变，`ensureConversation`
   * 复活的是同一行。
   */
  async function clear(): Promise<void> {
    const ledgerId = ledgerStore.currentLedgerId;
    // 先掐在途：它的结果不能落进刚清空的会话
    cancelInFlight();
    messages.value = [];
    pendingDrafts.value = [];
    error.value = null;
    if (ledgerId === null) return;
    await clearConversation(ledgerId, new Date());
  }

  /**
   * 把一条草稿移出"待确认"。**确认与撤销都调它**。
   *
   * 本 store 不落库：真记账是 UI 走 `transactionStore.add`（既有流程，含 `round2` 与必填校验），
   * 撤销走 `remove`。在这里写库会让"AI 只能只读 + 新增草稿（经用户确认）"这条权限边界多出一个
   * 绕开校验的写入口。
   */
  function dismissDraft(draftId: string): void {
    pendingDrafts.value = pendingDrafts.value.filter((d) => d.draftId !== draftId);
  }

  // -------------------------------------------------------------------------
  // 快照
  // -------------------------------------------------------------------------

  /**
   * 账本快照（§7.1）：**只有名字与类型**，逐字段白名单。
   *
   * ⚠️ 别写成 `categories: categoryStore.categories` —— 那些实体带 `id`/`ledger_id`/`owner_id`，
   * 展开就是把 id 塞进"会被渲染进 prompt"的对象里（§7.3）。白名单也是唯一防线的形态：
   * `prompt.ts` 渲染时虽然只取 name/type，但快照一旦带上 id，将来任何一处改成
   * `JSON.stringify(snapshot)` 就是一次泄漏。
   *
   * 只读既有 store 的**内存**：拉取名表是页面的责任（照 `FilterPage`/`RecordPage` 的做法，
   * 那些页面自己 `fetchAll`）—— 本 store 不在这里补读，免得同一份数据有两处加载时机。
   */
  async function buildSnapshot(): Promise<LedgerSnapshot> {
    const ledger = ledgerStore.currentLedger;
    return {
      kind: ledger !== null && ledger.type === "team" ? "team" : "personal",
      categories: useCategoryStore().categories.map((c) => ({ name: c.name, type: c.type })),
      accounts: useAccountStore().accounts.map((a) => ({
        name: a.name,
        // 中文类型名（招行(银行卡)）：快照给的是**人话**，模型照着它跟用户对话（§7.1 的示例）
        type: ACCOUNT_TYPE_LABELS[a.type],
      })),
      tags: useTagStore().tags.map((t) => t.name),
      members: await memberNames(),
    };
  }

  /**
   * 成员**名字**（快照里不给 id）。名字走 `useMemberInfo`（别名 > 昵称 > username 的唯一实现），
   * 团队账本的名单来自 `team_members` 缓存；缓存还没拉到时只剩"我" —— 不编名字。
   */
  async function memberNames(): Promise<{ name: string }[]> {
    const info = useMemberInfo();
    const names: string[] = [];
    const add = (name: string): void => {
      if (name !== "" && !names.includes(name)) names.push(name);
    };

    const ledger = ledgerStore.currentLedger;
    if (ledger !== null && ledger.team_id !== null) {
      for (const row of await getTeamMembers(ledger.team_id)) {
        add((await info.getMember(row.user_id)).displayName);
      }
    }
    const selfId = useAuthStore().currentLocalUser?.server_user_id || getCurrentUserId() || "";
    if (selfId !== "") add((await info.getMember(selfId)).displayName);
    return names.map((name) => ({ name }));
  }

  // 切账本即切会话（Ruling 14：`ai_conversations.ledger_id` UNIQUE，会话必须跟账本绑定）
  watch(() => ledgerStore.currentLedgerId, () => { void load(); });

  return {
    messages,
    loading,
    sending,
    error,
    conversationId,
    pendingDrafts,
    load,
    send,
    cancel,
    clear,
    dismissDraft,
  };
});
