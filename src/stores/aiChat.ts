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
import { computed, ref, watch } from "vue";
import { getCurrentUserId, getTeamMembers, getUserDb } from "@/db/userDb";
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
import { createTransport, fetchAiStatus, type AiStatus } from "@/services/ai/transport";
import type { LedgerSnapshot } from "@/services/ai/prompt";
// ⚠️ 草稿形状的**唯一真相**在 `tools.ts` 的草稿工具产出里（Ruling 66 R3）：store 侧只 `import type`
// 引入（类型擦除 ⇒ 不会把 `@/db/userDb` 拉进本 store 的运行期模块图），绝不重声明第二份 ——
// 字段改名的漂移后果是**静默**的（`readDrafts` 把草稿当"形状不全"跳过，草稿卡不显示、不报错）。
import type { NormalizedDraft, ResolvedDraftIds } from "@/services/ai/tools";
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

/**
 * 草稿字段。**别名**，不是第二份声明：形状由 `tools.ts` 的 `NormalizedDraft` 定义（R3）。
 * 保留这个名字是因为 UI 侧已经按它取用（`DraftCard` / `draftData`）。
 */
export type AiDraftFields = NormalizedDraft;

/** 草稿里名字解析出的**本地** id（给记账用，绝不上行）—— 同上，别名 `ResolvedDraftIds` */
export type AiDraftIds = ResolvedDraftIds;

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
// 文案
// ---------------------------------------------------------------------------

/**
 * store 兜住"agent 契约被改坏"（`runAgent` 抛）时的文案。
 *
 * ⚠️ **不得复用 `DB_FAILURE_TEXT`**：那一句说的是"本地数据出了点问题"，而 `catch` 到这里的原因
 * 未必是 DB（可能是 agent 里的任何 TypeError）⇒ 让用户看到的成因与真实成因一致；技术细节在
 * `console.warn` 里（复审 Minor：`fail(DB_FAILURE_TEXT)` 被两条不同的路共用，文案误导）。
 */
export const AGENT_FAILURE_TEXT = "AI 助手出了点问题，这次没能回答。稍后再试试。";

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
  /**
   * **已开始、尚未落定**的轮次（含被后续 `send` 取代的那一轮）。
   *
   * `clear()` 必须 `await` 它：`abort()` 只挡得住**内存投影**（靠 `runSeq`），挡不住已经进
   * `await` 的落库 —— `agent.ts:462` 检查 `signal.aborted` 之后 :476 就调 `persistAssistant`，
   * 而 `session.appendMessage` 不再看 signal。不等的后果见 `clear()`。
   */
  const inFlightRuns = new Set<Promise<void>>();
  /** 轮次令牌：被取代的那一轮 settle 时**不得**再动状态 */
  let runSeq = 0;
  /** 加载令牌：旧账本的响应可能后到，不能覆盖新账本的消息（账本隔离） */
  let loadSeq = 0;

  // -------------------------------------------------------------------------
  // 读既有会话
  // -------------------------------------------------------------------------

  /**
   * **只读**查找当前账本的会话行（R4：打开页面不该建会话）。
   *
   * 只 SELECT、不 `ensureConversation`：后者在没有会话行时会 `INSERT`（复审 P2 实测：空账本首屏
   * 就多一行 `ai_conversations`），而"用户一句话都没说过"与"库不可用"在这里都该是**空列表**。
   * 会话的创建推迟到首次发送（那是 agent 的 `ensureConversation`，它同时负责复活软删行）。
   *
   * ⚠️ 这是本 store 里**唯一**一处直接碰 SQL 的地方，且**只读**（写路径仍全在 `session.ts`：
   * `appendMessage` / `setTitleIfEmpty` / `clearConversation`）；软删的会话行**不在这里复活**
   * —— 复活是下一次发言的事（`loadMessages` 自己按 `is_deleted = 0` 过滤，读到空列表）。
   */
  async function findConversationId(ledgerId: string): Promise<string | null> {
    const db = getUserDb();
    if (db === null) return null;
    try {
      const rows = await db.select<{ id: string }[]>(
        "SELECT id FROM ai_conversations WHERE ledger_id = ? LIMIT 1",
        [ledgerId]
      );
      return rows.length > 0 ? rows[0]!.id : null;
    } catch (e) {
      // 读失败降级成"还没有会话"（Ruling 13：DB 未就绪 / 查询失败都不抛给 UI），但必须留痕
      console.warn("[ai/store] 读会话行失败：", e);
      return null;
    }
  }

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

      const convId = await findConversationId(ledgerId);
      if (seq !== loadSeq) return;
      conversationId.value = convId;
      if (convId === null) {
        // 这个账本还没说过话（或 `getUserDb()` 为 null：冷启动 / 未登录，Ruling 13）。
        // 两种形态都是**预期**降级、都不是错误；共同点是**一条会话行都不许建**（R4）。
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
    const run = runTurn(seq, controller, userText);
    // 登记这一轮（`send` 自己 await 它、`clear()` 也要等它落定）。两个 handler 是为了让这次
    // 登记不产生 unhandled rejection —— `runTurn` 契约上不 reject，这里只是不让记账变成风险。
    inFlightRuns.add(run);
    void run.then(
      () => inFlightRuns.delete(run),
      () => inFlightRuns.delete(run)
    );
    await run;
  }

  /** 一轮对话的**全部**副作用（抽出来是为了让 `send` 把这轮的 promise 登记给 `clear` 等） */
  async function runTurn(
    seq: number,
    controller: AbortController,
    userText: string
  ): Promise<void> {
    sending.value = true;
    error.value = null;

    const ledgerId = ledgerStore.currentLedgerId;
    messages.value.push({
      // ⚠️ 内存消息的 id 与库里 `ai_messages.id` 是**两套独立身份**：这里（以及 `appendAssistant`）
      // 用自己造的 UUID，agent 落库时另造一个。同一条消息"刚发完"与"重开读回来"的 id 因此不同
      // ⇒ 任何 UI 都**不许**把内存 id 当库键用（`pendingDrafts[].messageId` 只在同一会话的
      // 内存投影内自洽）；重开一次换成库里的 id（`load()` 用 `r.id`）。
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
      const members = await memberTable();
      const snapshot = await buildSnapshot(members.map((m) => ({ name: m.name })));
      const turn = await runAgent({
        userText,
        ledgerId,
        snapshot,
        // 成员表（**真 id**）与快照分两路：快照只给名字（§7.1 绝不发 id），而成员解析要用
        // `transactions.user_id` 那个真值 —— 只给名字的形态下模型说得出"小明"、链路却查不了
        // （旧实现拿序号编了个 `member-0`，于是成员筛选恒 0 行、静默回一个"0 元"）。
        members,
        deps: { transport: createTransport(), session: AGENT_SESSION },
        signal: controller.signal,
      });
      if (seq !== runSeq) return; // 已被新的一轮取代：它的账不该记进列表
      if (turn.aborted) return; // 取消：不追加任何消息、不设 error（§5.2/§5.3）
      appendTurn(turn);
    } catch (e) {
      // agent 的契约是"永不抛"，这里只兜住契约被改坏的那一天（照 agent 兜 buildLookupContext 的写法）。
      // **必须打日志**：这是唯一能看到抛出原因的地方。
      // ⚠️ 文案必须是 AGENT_FAILURE_TEXT（这一路未必是 DB 故障）—— 与"没有账本"那条分开。
      console.warn("[ai/store] send 意外抛出：", e);
      if (seq !== runSeq) return;
      fail(AGENT_FAILURE_TEXT);
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
   *
   * ⚠️ 三步的顺序都是必需的：**掐在途 → 等它落定 → 才 clearConversation**。
   */
  async function clear(): Promise<void> {
    const ledgerId = ledgerStore.currentLedgerId;
    // ① 先掐在途：`runSeq` 递增后，被取代的那一轮 settle 时不得再动内存（`appendTurn` 进不来）
    cancelInFlight();
    // 内存投影立刻清（UI 不用等落库）；迟到的写只可能进库，进不了列表
    messages.value = [];
    pendingDrafts.value = [];
    error.value = null;
    // ② 再等这些轮次**真正落定**：`abort()` 拦不住已经进 `await` 的落库 —— `agent.ts:462`
    //    检查 `signal.aborted` 之后，:476 仍会调 `persistAssistant`，而 `session.appendMessage`
    //    自己不看 signal。不等它，迟到的写会落在下面 `clearConversation` **之后**：消息行写进
    //    已被软删的会话行，下一次发言 `ensureConversation` 复活同一行 ⇒ **幽灵消息**重新出现。
    //    ⚠️ 等的是 `inFlightRuns` 全体（不止 `inFlight` 那一个）：被后续 `send` 取代的那一轮
    //    同样可能正卡在这次落库的 await 里。
    await Promise.all([...inFlightRuns].map((run) => run.catch(() => undefined)));
    if (ledgerId === null) return;
    // ③ 最后真删消息 + 软删会话行
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
  // 能力探测（tab 门控；`host` 还是任务 7 隐私卡的硬门槛）
  // -------------------------------------------------------------------------

  /**
   * `/ai/status` 的**一次**探测结果。`null` = 还没探过（**不是**"没启用"）。
   *
   * ⚠️ 存整份 `AiStatus` 而不是三个独立 ref：探测是**一次**原子结果，拆成三个字段就多了
   * "只更新一半"的形态（`enabled: true` 配着上一轮的 `host`）。下面三个 computed 是它的视图
   * —— `enabled` 给 tab 门控（`App.vue`），`host`/`model` 给任务 7 的隐私卡（§7.3：
   * **拿不到 `host` 就不得展示隐私卡、也不得允许开启开关**）。
   */
  const status = ref<AiStatus | null>(null);

  /** tab 门控的**唯一**依据：拿不到能力（含探测失败）= 不显示 AI 入口（安全的那一侧） */
  const enabled = computed(() => status.value?.enabled === true);
  /** 处理数据的服务器；`null` = 不可知（此时不许开开关） */
  const host = computed(() => status.value?.host ?? null);
  /** 回答用的模型名 */
  const model = computed(() => status.value?.model ?? null);

  /**
   * 探一次 AI 能力。**不轮询**（M2 契约第 4 条：`/ai/status` 与 `/ai/chat` 共用一个每分钟桶）。
   * 调用点是**启动**（`App.vue`：tab 存不存在取决于它）与**进入 AI 页**（页面首屏各一次）。
   *
   * **永不抛**（`fetchAiStatus` 的契约）：探测失败一律 `enabled=false` + `host/model=null`。
   */
  async function refreshStatus(): Promise<void> {
    status.value = await fetchAiStatus();
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
   *
   * `members` 只收名字：调用方从 `memberTable()` 里 `map((m) => ({ name: m.name }))` 剥掉 id
   * （同一个成员表还喂给 `runAgent` 的解析表，见 `send`）。
   */
  async function buildSnapshot(members: { name: string }[]): Promise<LedgerSnapshot> {
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
      members,
    };
  }

  /**
   * 成员表：**真 id + 显示名**。快照与解析表都从这里出（一次读取，两份用途）。
   *
   * 名字走 `useMemberInfo`（别名 > 昵称 > username 的**唯一**实现，团队名单来自本地
   * `team_members` 缓存）；id 是 `transactions.user_id` 的真值 —— 自己那笔用
   * `server_user_id || 本地 id`，与 `useTransactionForm` 记账时写入的表达式**同一个**
   * （两处取值不一致，成员筛选就会查不到自己的流水）。
   */
  async function memberTable(): Promise<{ id: string; name: string }[]> {
    const info = useMemberInfo();
    const table: { id: string; name: string }[] = [];
    const add = (id: string, name: string): void => {
      if (id === "" || name === "") return;
      // 同 id / 同名都只留第一份：重名的两个候选会让模型的反问变成"你是指老婆还是老婆"
      if (table.some((m) => m.id === id || m.name === name)) return;
      table.push({ id, name });
    };

    const ledger = ledgerStore.currentLedger;
    if (ledger !== null && ledger.team_id !== null) {
      for (const row of await getTeamMembers(ledger.team_id)) {
        add(row.user_id, (await info.getMember(row.user_id)).displayName);
      }
    }
    const selfId = useAuthStore().currentLocalUser?.server_user_id || getCurrentUserId() || "";
    if (selfId !== "") add(selfId, (await info.getMember(selfId)).displayName);
    return table;
  }

  // 切账本即切会话（Ruling 14：`ai_conversations.ledger_id` UNIQUE，会话必须跟账本绑定）。
  // ⚠️ 必须**一并掐掉在途那一轮**：`runSeq` 只由 `cancelInFlight()` 递增 ⇒ 不掐的话，上一账本
  //    那一轮的终稿/草稿在 settle 时 `seq === runSeq` 仍成立，会直接 append 进**新账本**的列表
  //    （危害不止显示：6b 的草稿卡"确认"按**当前账本**调 `transactionStore.add` ⇒ 拿 A 的数据往 B 记账）。
  watch(() => ledgerStore.currentLedgerId, () => {
    cancelInFlight();
    void load();
  });

  return {
    messages,
    loading,
    sending,
    error,
    conversationId,
    pendingDrafts,
    status,
    enabled,
    host,
    model,
    load,
    send,
    cancel,
    clear,
    dismissDraft,
    refreshStatus,
  };
});
