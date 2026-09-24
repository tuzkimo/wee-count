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
// 只借类型：`import type` 不会把 imageInput（它 import 两个 Tauri 插件）拉进 store 的运行时
import type { ImageAttachment } from "@/services/ai/imageInput";
// ⚠️ 这里取的是**常量**（`PROMPT_VERSION`），不是把 prompt.ts 的模块图拖进来当依赖：
// `agent.ts`（本文件上面那行就 import 了它）运行期本来就要 `buildSystemPrompt`，模块图早就在了。
// `otherAccountLabel` 是**同一个格式**的唯一来源：解析表里别人的账户名与快照里那一组必须逐字相同。
import { otherAccountLabel, PROMPT_VERSION } from "@/services/ai/prompt";
import {
  readEntryEnabled,
  readPrivacyCardSeen,
  readSendingEnabled,
  writeEntryEnabled,
  writePrivacyCardSeen,
  writeSendingEnabled,
  AI_ENTRY_ENABLED_DEFAULT,
  AI_PRIVACY_CARD_SEEN_DEFAULT,
  AI_SENDING_ENABLED_DEFAULT,
} from "@/services/aiPrivacySettings";
import { AI_NOT_CONFIGURED_TEXT, describeHostState, describeOffHint } from "@/services/ai/failureText";
import { hasBaseUrl } from "@/services/api";
import type { LedgerSnapshot } from "@/services/ai/prompt";
// ⚠️ 草稿形状的**唯一真相**在 `tools.ts` 的草稿工具产出里（Ruling 66 R3）：store 侧只 `import type`
// 引入，绝不重声明第二份 —— 字段改名的漂移后果是**静默**的（`readDrafts` 把草稿当"形状不全"跳过，
// 草稿卡不显示、不报错）。
// ⚠️ 这条 `import type` 的真实收益**只是类型**（Ruling 86 修正）：`@/db/userDb` 本来就由上面那行
// **运行期** import 进来了，所以"省掉模块图里的 `userDb`"不是它的理由；理由是 `tools.ts` 那条
// 模块图（DSL 校验 + 名字解析 + 草稿工具）与本 store 的运行期无关，不该因为一个**注释里的锚点**
// 被拖进来。别再把这条写成"不会把 userDb 拉进运行期模块图"—— 那是错的。
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

/**
 * 草稿的**决定**（§4.4:160 的状态机 `pending → confirmed | discarded`）。
 *
 * 它**落库**：写在 `payload.drafts[i].status` 上（同层的 `transactionId` 是撤销要用的交易 id）。
 * 只存内存的后果已经实测过（收口 C-P1）：任何一次 `load()` 都把草稿复活成待确认，
 * 用户再点一次「确认记账」就写**第二笔**真账。
 */
export type DraftStatus = "pending" | "confirmed" | "rejected";

/** 一条草稿 + 它的决定。UI 侧只按 `status` 分支（`confirmed` 渲染「已记账 ✓ + 撤销」） */
export interface DecidedDraft extends PendingDraft {
  status: DraftStatus;
  /** 已记账那笔的交易 id（`transactionStore.add` 的返回值）；只有 `confirmed` 时非空 */
  savedTransactionId: string | null;
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
 * 收窄一条草稿的**决定**（§4.4:160 的状态机）：
 * - 没有 `status`（旧 payload）⇒ `pending`（要求 6：坏/旧 payload 一律当"待确认"）；
 * - `status` 不是三个已知字面量之一（被改坏）⇒ 同样当 `pending`，**绝不**跳过整张卡；
 * - `confirmed` 但交易 id 不是非空字符串 ⇒ 也当 `pending`：撤销要用它，没有它就没有安全网。
 */
function readDecision(raw: unknown): { status: DraftStatus; transactionId: string | null } {
  if (!isRecord(raw)) return { status: "pending", transactionId: null };
  const { status, transactionId } = raw;
  if (status === "rejected") return { status: "rejected", transactionId: null };
  if (status === "confirmed") {
    if (typeof transactionId !== "string" || transactionId === "") {
      return { status: "pending", transactionId: null };
    }
    return { status: "confirmed", transactionId };
  }
  return { status: "pending", transactionId: null };
}

/**
 * 从 payload 里挑出**形状完整**的草稿（`payload.drafts` 的类型是 `unknown[]`：payload 是 JSON）。
 * 形状不全的条目直接跳过 —— 一条坏草稿不该让整张列表渲染不出来。
 *
 * ⚠️ 这是**唯一**的草稿读法：刚生成的一轮和从库里读回来的一轮都走它，
 * 于是"落库 → 重开 → 草稿卡还在"不需要第二份解析。
 */
function readDrafts(payload: AiMessagePayload | null, messageId: string): DecidedDraft[] {
  if (payload === null || !Array.isArray(payload.drafts)) return [];
  const out: DecidedDraft[] = [];
  for (const item of payload.drafts) {
    if (!isRecord(item)) continue;
    const { draftId, draft, resolved } = item;
    if (typeof draftId !== "string" || draftId === "") continue;
    if (!isRecord(draft) || !isRecord(resolved)) continue;

    const decision = readDecision(item);
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
      status: decision.status,
      savedTransactionId: decision.transactionId,
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
  /**
   * **待发送**的截图（M4 §4.2 / E12.1）。**唯一真相在 store**，不在组件里。
   *
   * 为什么必须放这里（而不是 composer 的局部 `ref`）：附件要在**切页/重挂载**后仍然在 ——
   * 用户选了一张截图、切去别处看一眼再回来，那张图不能凭空消失（选图是本地动作，
   * 重新选一次要重走系统选择器）。M4 之前的实现把附件留在 composer 局部状态里，
   * 页面一重挂载就丢，且 `emit("attach")` 当时**没有任何监听者**。
   *
   * 生命周期（三句话）：
   *  - **谁写**：页面接线 `@attach` ⇒ `setAttachedImage`（成功选图后）；`✕` ⇒ `clearAttachedImage`。
   *  - **谁清**：`send()` **取走即清**（一次性消费 —— 图只进当轮，§4.2「只有在当轮才带块」）。
   *  - **闸关着时不清**（§7）：`sendingEnabled` 为假时 `send` 提前返回，附件**留在输入区**，
   *    因为"关掉开关"不该静默丢掉用户的选择（页面同时禁用两枚按钮）。
   */
  const attachedImage = ref<ImageAttachment | null>(null);
  /** 选图成功 ⇒ 页面把它交给 store（组件自身不碰 store，见 `ChatComposer` 文件头） */
  function setAttachedImage(image: ImageAttachment): void {
    attachedImage.value = image;
  }
  /** 用户点 ✕ 撤掉**待发**附件：已落库的历史图不动（§7「不追溯删除」） */
  function clearAttachedImage(): void {
    attachedImage.value = null;
  }
  /**
   * 会话里**全部**草稿（含已确认 / 已拒绝）——**唯一**的草稿真相。
   *
   * 每次 `load()` 都从 payload 重建（`readDrafts`），所以"决定"跨页面存活这件事只有一份实现：
   * 写进 payload（`resolveDraft`）↔ 从 payload 读回（`readDrafts`）。内存里的 `messageId` 与
   * 库里 `ai_messages.id` 是两套身份（见 `runTurn` 的注释），但**同一份会话内**自洽 ——
   * `load()` 之后两者都会换成库里那份。
   */
  const allDrafts = ref<DecidedDraft[]>([]);
  /** **待确认**的草稿：只由 `allDrafts` 派生（UI 用它渲染"待确认"的卡） */
  const pendingDrafts = computed(() => allDrafts.value.filter((d) => d.status === "pending"));
  /** 已确认的草稿：渲染「已记账 ✓ + 撤销」（§4.4:164），撤销入口在这里存活 */
  const confirmedDrafts = computed(() =>
    allDrafts.value.filter((d) => d.status === "confirmed"),
  );
  /** 已拒绝的草稿：不再渲染（页面不显示它），但**不许**从状态里消失（下次 `load` 才不会复活） */
  const rejectedDrafts = computed(() => allDrafts.value.filter((d) => d.status === "rejected"));

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
        allDrafts.value = [];
        return;
      }

      const convId = await findConversationId(ledgerId);
      if (seq !== loadSeq) return;
      conversationId.value = convId;
      if (convId === null) {
        // 这个账本还没说过话（或 `getUserDb()` 为 null：冷启动 / 未登录，Ruling 13）。
        // 两种形态都是**预期**降级、都不是错误；共同点是**一条会话行都不许建**（R4）。
        messages.value = [];
        allDrafts.value = [];
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
      allDrafts.value = messages.value.flatMap((m) => readDrafts(m.payload, m.id));
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

    // "没内容可发" = 没有文字**且**没有图。M4 起带图可以不写字（§4.2：「文字可省略」），
    // 所以这里判的是两者都空 —— 只判 `userText === ""` 会把"只发一张图"当场吞掉。
    if (userText === "" && attachedImage.value === null) return;

    // §7.3 的**意愿层**：开关关着一个请求都不发。UI 那边同时禁用输入框（`ChatComposer` 的
    // `enabled`），但执行点在这里 —— 页面忘了禁用、或将来多一个调用方，都漏不出去。
    // 默认是关的（`AI_SENDING_ENABLED_DEFAULT=false`），所以"还没读过配置"也走这条 return。
    //
    // ⚠️ 这一条必须在"取走附件"**之前**：闸关着时那个 return 不能顺手把附件清掉，
    // 否则用户关一次开关就静默丢了他刚选的图（§7「开关关闭后已附的图保留可见」）。
    if (!sendingEnabled.value) return;

    // 取走即清（一次性消费）：下面这一轮是这张图唯一的去处，发出去之后输入区就该空了。
    const image = attachedImage.value;
    attachedImage.value = null;

    // 生成中又发一条 ⇒ 掐掉在途那一轮（§5.2）。丢弃的是**结果**，不是用户已经说出口的话
    cancelInFlight();
    const seq = ++runSeq;
    const controller = new AbortController();
    inFlight = controller;
    const run = runTurn(seq, controller, userText, image);
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
    userText: string,
    image: ImageAttachment | null,
  ): Promise<void> {
    sending.value = true;
    error.value = null;

    const ledgerId = ledgerStore.currentLedgerId;
    const userMessage: UiMessage = {
      // ⚠️ 内存消息的 id 与库里 `ai_messages.id` 是**两套独立身份**：这里（以及 `appendAssistant`）
      // 用自己造的 UUID，agent 落库时另造一个。同一条消息"刚发完"与"重开读回来"的 id 因此不同
      // ⇒ 任何 UI 都**不许**把内存 id 当库键用（`pendingDrafts[].messageId` 只在同一会话的
      // 内存投影内自洽）；重开一次换成库里的 id（`load()` 用 `r.id`）。
      id: crypto.randomUUID(),
      role: "user",
      content: userText,
      // §4.1/§4.3：图只进 payload（content 是纯文本），且**内存这一份也要带** ——
      // 否则刚发完那条消息的缩略图要等一次 `load()` 才出现（页面渲染读的就是这个字段）。
      payload: image === null ? null : { image },
      createdAt: new Date().toISOString(),
    };
    messages.value.push(userMessage);
    // §7.4 乙方案：**本轮主动问出来的**消息显示真值 ⇒ 这条用户消息也算（它就是用户刚说的话）
    revealed.value.add(userMessage.id);

    try {
      if (ledgerId === null) {
        fail(DB_FAILURE_TEXT);
        return;
      }
      const members = await memberTable();
      // 整张成员表（带 id）进快照：别人的账户要按归属成员的**显示名**加标注，而快照本身只出名字
      const snapshot = await buildSnapshot(members);
      const turn = await runAgent({
        userText,
        // 有图 ⇒ agent 层把本轮 content 组装成内容块数组（§4.2）并把图写进 payload（§4.1）
        ...(image === null ? {} : { image }),
        ledgerId,
        snapshot,
        // 成员表（**真 id**）与快照分两路：快照只给名字（§7.1 绝不发 id），而成员解析要用
        // `transactions.user_id` 那个真值 —— 只给名字的形态下模型说得出"小明"、链路却查不了
        // （旧实现拿序号编了个 `member-0`，于是成员筛选恒 0 行、静默回一个"0 元"）。
        members,
        // 当前用户 id：团队账本里解析表的账户候选要按它收窄（`LookupScope`）。agent 那层
        // 拿不到这个身份（快照刻意只有名字），只能由这里给 —— 与 `buildSnapshot` 里
        // 过滤账户用的是**同一个** `currentUserId()`。
        currentUserId: currentUserId(),
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

  /**
   * payload 的契约本来就是 JSON（`AiMessagePayload` 里 chips/drafts 都是 `unknown[]`，落库也是
   * `JSON.stringify`）⇒ 过一次 JSON 就是最省事的**深拷贝**，不用手写递归、也不用 `structuredClone`
   * （后者在旧 WebView 上不一定有）。
   */
  function ownJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  /**
   * ⚠️ payload 必须是**自己**的数据，不能直接存 agent 这一轮的数组 / 对象引用。
   *
   * `markDraft` 是**原地**改 payload 里的决定（`entry.status = ...`，见它自己的注释：换新对象会
   * 触发草稿卡的自清）⇒ 一旦别名共享，`confirmDraft` / `rejectDraft` 就会顺手把**调用方手里的
   * `turn`** 也改了。真 agent 的 `turn` 是这一轮的一次性产物（所以生产上看不出来），但 store 没有
   * 理由依赖这一点：测试里共享的夹具会因此被污染 —— 一张卡被拒绝之后，**后面每一条**用同一份
   * 夹具种进库的 payload 都带着 `status: "rejected"`，`readDrafts` 读回就不再是"待确认"，
   * 卡片凭空消失（实测：`AiChatPage.test.ts` 的两条遮罩用例因此红，且只在全量跑时红）。
   */
  function appendTurn(turn: AgentTurn): void {
    const message = appendAssistant(turn.text, {
      chips: ownJson(turn.chips),
      drafts: ownJson(turn.drafts),
      refs: ownJson(turn.refs),
      trace: ownJson(turn.trace),
      // 与 `agent.persistAssistant` 落库那份**同一个常量**（§7.1:449）：内存这份也必须带，否则
      // `load()` 之后"库里那份有、内存那份没有"，同一条消息的 payload 往返不再整份相等
      // （`aiChat.persist.test.ts:227` 钉着这条）。
      promptVersion: PROMPT_VERSION,
    });
    allDrafts.value.push(...readDrafts(message.payload, message.id));
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
    // §7.4 乙方案：本次会话新产生的回答显示真值（重开 App 后 `revealed` 清空 ⇒ 全部回到遮蔽态）。
    // 失败消息（`fail`）也走这里：它没有金额，标记与否都不影响隐私，但省一条分叉。
    revealed.value.add(message.id);
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
    allDrafts.value = [];
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
   * 把一条草稿移出"待确认"。**纯内存**，不落库。
   *
   * ⚠️ **生产已无调用者**（R86-6，实测：`grep dismissDraft src/` 只剩它自己、它的用例、以及几条
   * 提到它的注释）。UI 的"确认 / 拒绝 / 撤销"走 `confirmDraft` / `rejectDraft` / `undoDraft`：
   * 它们把决定写进 `payload.drafts[i].status` —— 只改内存的话，任何一次 `load()` 都会让草稿
   * 复活成待确认，用户再点一次「确认记账」就写第二笔真账（收口 C-P1 实测过）。
   *
   * 为什么**没有**按 Ruling 35 删掉：删它就要连带删掉 `aiChat.test.ts` 那条只钉它的用例
   * （「全程 `db.execute` 一次都不调」，钉的是"草稿投影这一层零写入"这条边界），而 AGENTS.md 明令
   * 不可删改既有测试。代价是它留在这里像一个可用原语 —— 所以把话说死：
   * **不要再从 UI 接回它**，那正是 C-P1 的复活路径；要"让卡消失"就用 `rejectDraft`。
   *
   * 本 store 不落**交易**：真记账是 UI 走 `transactionStore.add`，撤销走 `remove`。在这里写交易表
   * 会让"AI 只能只读 + 新增草稿（经用户确认）"这条权限边界多出一个绕开校验的写入口；这里写的
   * 只是 **AI 会话表自己的 payload**（§4.5 的 `drafts`，本来就落库）。
   *
   * ⚠️ 那句"既有流程，含 `round2` 与必填校验"**是错的**（Ruling 41）：`transactionStore.add`
   * （`transaction.ts:261-311`）**既不做金额变换、也不做任何必填校验**，缺 id 会**静默**写进去。
   * 两条规则的真实归属：`round2` 由 `tools.ts:787` 生成草稿时做（内联编辑那条路改由
   * `draftData.parseEditedAmount` 做），必填校验由 `draftData.validateDraft` 在**确认前**做。
   */
  function dismissDraft(draftId: string): void {
    allDrafts.value = allDrafts.value.filter((d) => d.draftId !== draftId);
  }

  // -------------------------------------------------------------------------
  // 草稿的"决定"：确认 / 拒绝 / 撤销（§4.4:160 的状态机，跨 load() 存活）
  // -------------------------------------------------------------------------

  /**
   * 把一条草稿的决定**写进库里那条消息的 payload**（`payload.drafts[i].status`）。
   *
   * 为什么是这一层：草稿随 assistant 消息落库（`agent.persistAssistant` → `session.appendMessage`），
   * 而 `load()` 又从 payload 重建 —— 决定必须落在**同一份** payload 上，否则"重进页面"这条路上
   * 就只有一半真相（收口 C-P1）。
   *
   * ⚠️ 四处限定（要求 5）：
   *  - `conversation_id = ?`：**那个账本**的会话（`ledger_id` UNIQUE ⇒ 一会话一账本）；不限定就是
   *    "另一个账本里同 draftId 的草稿被一起改掉"；
   *  - `role = 'assistant'`：草稿只产生在 assistant 消息上；
   *  - `json_each … draftId = ?`：**那一张**草稿（一个 payload 里可以有多张，只 patch 命中的那张）。
   *    它同时就是"哪一条消息"的判据 —— 见下面那段关于两套 id 的警告；
   *  - 状态守卫：`pending` 只接受"当前是 confirmed"（撤销），其余只接受"还没决定过"。
   *    重复点击 / 双确认因此改不动第二笔，`rowsAffected = 0` ⇒ 调用方不动内存。
   *
   * 硬删过的消息（`clearConversation`）⇒ 这里必然 0 行 ⇒ 返回 false，调用方保持"待确认"。
   *
   * 🔴 **不许再拿 `messageId` 当库键**（Bug 3 的根因，实测：首次确认/拒绝/撤销**必然**返回 false，
   * 切页回来才正常）。同一轮 assistant 消息有**两套身份**：
   *  - store 内存那份的 id 是 `appendAssistant` 里 `crypto.randomUUID()` 造的（`:556`）；
   *  - 库里那行的 id 是 `agent.ts:404` **另外**造的一个 UUID。
   * 两者永不相等 ⇒ `... AND id = ?` 恒不命中 ⇒ 0 行。而 `load()` 用 `r.id` 重建草稿
   * （`messages.value` 那条路），`messageId` 于是换成库 id ⇒ **切页回来就"好了"**。
   * `allDrafts[].messageId` 只在**同一份会话的内存投影内**自洽（它服务于 UI 分组，见 `runTurn` 里
   * 那段"两套独立身份"的注释），拿它去 `WHERE id = ?` 正是被明令禁止的那件事。
   * 真正的稳定身份是 `draftId`（`tools.ts:821` 造的 UUID），它随 payload 一起落库 —— 因此
   * "哪一条消息"由 `conversation_id + role + draftId` 唯一确定，不需要第二个键。
   */
  async function updateDraftPayload(
    draftId: string,
    status: DraftStatus,
    transactionId: string | null
  ): Promise<boolean> {
    const db = getUserDb();
    const conversationId = await findConversationId(ledgerStore.currentLedgerId ?? "");
    // 草稿不在内存投影里 ⇒ 这条决定无从谈起（`applyDraftDecision` 已经拦过一道，这里是本函数
    // 自己的守卫：真链路里 `draftId` 只可能来自一张渲染中的草稿卡）
    if (!allDrafts.value.some((d) => d.draftId === draftId)) return false;
    if (db === null || conversationId === null) return false;

    try {
      // 为什么要这么写：SQLite 的 `json_set` **只能**按路径精确落值，而"数组里哪个元素"是运行期
      // 才知道的（`payload.drafts` 里可以有多张草稿）⇒ 逐元素重建整个 drafts 数组，只有目标那张
      // 被 `json_patch` 打上决定。别的草稿、别的 payload 一个字节都不动（同一行仍然只改一次）。
      // `hash` 是 sqlite 的内置函数（3.45+，与 `json_*` 同族）。
      //
      // ⚠️ 成败判据**只认 `execute` 返回的 `rowsAffected`**（R86-2 修正，照**安装包产物**核过：
      // `node_modules/@tauri-apps/plugin-sql/dist-js/index.js:88-98` 恒返回
      // `{ lastInsertId, rowsAffected }`；`index.d.ts` 的类型也是 `Promise<QueryResult>`，
      // `QueryResult.rowsAffected: number`，2.4.0）——**没有** `null` 那一支。
      // 曾经这里写的是"0 行时 resolve `null`，再问 `SELECT changes()`"，那**两条都是错的**：
      //   ① `null` 在生产里不可达（删掉那个分支所有用例照样绿 = 等价变异）；
      //   ② `SELECT changes()` 是**连接作用域**的，而插件走 sqlx 默认连接池
      //      （`max_connections = 10`）⇒ UPDATE 与这条 SELECT 可能落在**两条不同连接**上，
      //      读到别的连接留下的**陈旧非零** ⇒ "库里 0 行、内存却进已记账"的**假成功**，
      //      重进页面草稿复活、再点确认就是第二笔真账（正是 C-P1 要防的那件事）。
      const applied = await db.execute(
        `UPDATE ai_messages
            SET payload = json_patch(payload, json_object('drafts', (
                  SELECT json_group_array(
                           CASE WHEN json_extract(item.value, '$.draftId') = ?
                                THEN json_patch(item.value, json_object('status', ?, 'transactionId', ?))
                                ELSE item.value END
                         )
                  FROM json_each(json_extract(payload, '$.drafts')) AS item
                )))
          WHERE conversation_id = ?
            AND role = 'assistant'
            AND EXISTS (
                  SELECT 1 FROM json_each(json_extract(payload, '$.drafts'))
                  WHERE json_extract(value, '$.draftId') = ?
                    AND (
                      (? = 'pending' AND json_extract(value, '$.status') = 'confirmed')
                      OR (? <> 'pending'
                          AND json_extract(value, '$.status') IS NOT 'confirmed'
                          AND json_extract(value, '$.status') IS NOT 'rejected')
                    )
                )`,
        [draftId, status, transactionId, conversationId, draftId, status, status],
      );
      // 没改到行 ⇒ 这条决定不成立（重复点击 / 消息已被清掉 / 草稿已被别人决定）
      return applied.rowsAffected > 0;
    } catch (e) {
      // 不抛：这是"用户点确认"的下游，异常冒到 UI 只会变成一个没人接的 rejection。
      // 返回 false ⇒ 调用方**不**动内存，草稿留在待确认（用户还能重试）。
      console.warn("[ai/store] 写草稿决定失败：", e);
      return false;
    }
  }

  /**
   * 把一条决定同时写进**库里**与**内存投影**。写不进去就一个都不改（返回 false）——
   * 只有"两边都成"才算这条决定成立，"内存先改、库慢慢写"会让重进页面时状态与账目对不上。
   */
  function markDraft(
    draftId: string,
    status: DraftStatus,
    transactionId: string | null
  ): DecidedDraft | null {
    const target = allDrafts.value.find((d) => d.draftId === draftId);
    if (target === undefined) return null;
    target.status = status;
    target.savedTransactionId = transactionId;

    // payload 是**引用**（`messages` 里同一条消息的 payload 也在被渲染用）：原地改一处即可，
    // 不许换新对象 —— 换了 `props.draft` 的引用会触发草稿卡的自清（那是"换草稿"的信号）。
    if (target.messageId !== null) {
      const message = messages.value.find((m) => m.id === target.messageId);
      const entry = message?.payload?.drafts?.find(
        (it) => isRecord(it) && it.draftId === draftId
      );
      // 用 `isRecord` 再收一次窄：`find` 的谓词是 `&&` 组合 ⇒ 它不是类型守卫，返回 `unknown`
      if (isRecord(entry)) {
        entry.status = status;
        entry.transactionId = transactionId;
      }
    }
    return target;
  }

  /** 用户点了「确认记账」（`transactionId` 是 `transactionStore.add` 的返回值，撤销要用它） */
  async function confirmDraft(draftId: string, transactionId: string): Promise<boolean> {
    return applyDraftDecision(draftId, "confirmed", transactionId);
  }

  /** 用户点了「不要」 */
  async function rejectDraft(draftId: string): Promise<boolean> {
    return applyDraftDecision(draftId, "rejected", null);
  }

  /**
   * 用户点了「撤销」（§4.4:164 的"手滑确认的廉价安全网"）：那笔交易由**卡片**调
   * `transactionStore.remove` 真删，这里只把**决定**改回"待确认"。
   *
   * ⚠️ `confirmed → pending` 是**扩展**，不是规格字面（R86-3 修正）：`§4.4:160` 的状态机只有
   * `pending → confirmed | discarded`；spec 全文也**没有**「确认后仍可反悔」这句话（0 命中，上一轮
   * 把它当原文引用是错的）。选 `pending` 的实际依据有两条，都在**仓内**：
   *   ① `§4.4:164` 要求已记账的卡上挂「撤销」（`remove()`）⇒ 撤销后那笔交易已经不存在了，
   *      卡片**必须**离开"已记账"视图（留在 saved 就是谎报）；
   *   ② 卡内既有的 commit/rollback 语义：`DraftCard.onUndo` 成功后 `resetForNewDraft()` ⇒ 卡回到
   *      可确认态，即"撤销 = 回到还没记"。
   * 所以这里持久化的也是 `pending`（而不是新增 `undone` 状态 —— 那要动状态机与读写两侧的归一化，
   * 且 `readDecision` 会把未知字面量当 `pending`，加了也读不回来）。撤销完那张卡**可再确认一次**，
   * 与卡内视图一致。
   */
  async function undoDraft(draftId: string): Promise<boolean> {
    const target = allDrafts.value.find((d) => d.draftId === draftId);
    if (target === undefined || target.status !== "confirmed") return false;
    return applyDraftDecision(draftId, "pending", null);
  }

  /** 三个入口共用的收口：**先**写库、**后**改内存（照 `setSendingEnabled` 的 R57 规则） */
  async function applyDraftDecision(
    draftId: string,
    status: DraftStatus,
    transactionId: string | null
  ): Promise<boolean> {
    const target = allDrafts.value.find((d) => d.draftId === draftId);
    // 已是同一个决定 ⇒ 幂等返回（同一张卡不会走两次，这条挡的是重复调用）
    if (target === undefined || target.status === status) return target !== undefined;

    const ok = await updateDraftPayload(draftId, status, transactionId);
    if (!ok) {
      // 决定没落库 ⇒ 内存也不改：用户看到"待确认"是**真的**（重进页面它还会在）
      console.warn("[ai/store] 草稿决定没落库，保持待确认：", draftId);
      return false;
    }
    return markDraft(draftId, status, transactionId) !== null;
  }

  // -------------------------------------------------------------------------
  // 能力探测（只影响 AI 页内的文案与"能不能发出去"，**不再参与入口显隐**）
  // -------------------------------------------------------------------------

  /**
   * 最近一次**可判定**的探测结果。`null` = 还没有过可判定的结果（**不是**"没启用"）。
   *
   * ⚠️ 存整份 `AiStatus` 而不是三个独立 ref：探测是**一次**原子结果，拆成三个字段就多了
   * "只更新一半"的形态（`enabled: true` 配着上一轮的 `host`）。下面几个 computed 是它的视图
   * —— `enabled`/`configured` 说服务端配没配，`host`/`model` 给隐私卡与入口文案用。
   */
  const status = ref<AiStatus | null>(null);

  /**
   * 探过，但这次探测**给不出结论**（网络 / 超时 / 429 / 形状坏 / 401 / 5xx）。
   *
   * 第 47 条：未知**不关** tab。与 `status === null`（还没探过）分开，是因为两者必须可区分：
   * - 还没探（启动那一瞬间）⇒ `enabled=false`，不闪一个可能点进去就报错的入口；
   * - 探了但没结论 ⇒ `enabled=true`，否则断网冷启动的用户**再也进不去** AI 页
   *   （自动探针只有 `App.vue` 启动那一处，没有第二次机会）。
   */
  const statusUnknown = ref(false);

  /**
   * **能力层**视图（服务端说的事实）：已知 ⇒ 服务端说什么是什么；未知 ⇒ 保持可用；还没探 ⇒ 不显示。
   *
   * ⚠️ 从本轮起它**不再参与入口显隐**（那是意愿层 `entryEnabled` 的事，G1/C1）。留着它是为了让
   * "服务端配没配"这件事仍然可读（`configured` 是同一份事实的三值版本，`enabled` 是它的二值降级：
   * 把"没表态"归到安全的一侧 `false`）。
   */
  const enabled = computed(() =>
    status.value === null ? statusUnknown.value : status.value.enabled
  );

  /**
   * 服务端是否**明确表态**配了 AI（C1/C3 的判据）：
   * - `true`：200 且 `enabled:true`；
   * - `false`：200 且 `enabled:false`，或 503 `ai_disabled`（两条都是"服务端自己说的"）；
   * - `null`：**没表态**（没探过 / 网络 / 超时 / 429 / 形状坏 / 401 / 5xx）。
   *
   * 与 `enabled` 的分工是刻意的：`enabled` 把"没表态"降级成 `false`（安全的一侧，能力层
   * 不能因为坏响应就说"配了"），而 `configured` 保留"没表态"这一档 —— 只有它才能把
   * 「已知没配」与「这次探测不可判定」分开（C3.1 vs C3.4/C3.5）。
   */
  const configured = ref<boolean | null>(null);

  /**
   * 最近一次**不可判定**探测的失败类型；`null` = 没有（没探过 / 就没发请求 / 探测给了结论）。
   * 只给文案分流用（C3.5），**不参与任何门控**。
   */
  const statusFailureKind = ref<NonNullable<AiStatus["failure"]>["kind"] | null>(null);

  /** 处理数据的服务器；`null` = 不可知（**纯视图**：不再参与任何门控，未知照样能开入口） */
  const host = computed(() => status.value?.host ?? null);
  /** 回答用的模型名 */
  const model = computed(() => status.value?.model ?? null);

  // -------------------------------------------------------------------------
  // 意愿层：入口开关 + 发送开关（本地说法，与能力层完全解耦）
  // -------------------------------------------------------------------------

  /**
   * **入口**开关（G1/C1）：AI tab 显不显示只看它。默认关闭，持久化在 `ai_entry_enabled`。
   *
   * 为什么必须是**本地说法**：真机事故的根因是"客户端试图渲染一个它并不掌握的状态"
   * （服务端配没配 AI）。本地说法在任何时刻都是已知的 ⇒ "未知态"根本不需要渲染，
   * 入口也不会因为一次探测失败而消失。
   *
   * ⚠️ 刻意**不**把能力层掺进来（不写成 `entryEnabled && !knownNotConfigured`，也不写成
   * `host !== null`）：那会让"服务端明确没配"或"这轮探测不可判定"把入口收回去，用户刚开的
   * 入口自己消失 —— 与"开启入口永远可达"（规则 2）冲突，是同一个死锁换了个位置。
   * "服务端没配"该怎么说话由 AI 页的提示条与发送开关承担（C3.1/C4.3/C5.4），不由入口承担。
   * `App.vue` 只用这一条判据。
   */
  const entryEnabled = ref(AI_ENTRY_ENABLED_DEFAULT);

  /**
   * **意愿层**开关（§7.3）：默认关闭。`true` 才允许发请求（`send` 的第一道门控）。
   *
   * 与能力层（`enabled`，来自 `/ai/status`）是**两件事**：能力层说"服务端配没配"，
   * 这一层说"用户愿不愿意把数据发到 `host`"。两层都成立才发得出去。
   */
  const sendingEnabled = ref(AI_SENDING_ENABLED_DEFAULT);

  /**
   * AI 页提示条文案（C5）：按 `host` 的三类来源分流（G3）。
   *
   * 纯函数在 `services/ai/failureText.ts`（那边有自己的表驱动用例）；这里只负责把 store
   * 的四个状态喂进去 —— store 里**不许**再有一份 `host === null ? "服务端未配置…"` 式的三元。
   */
  const sendingHint = computed(() =>
    describeOffHint({
      sendingEnabled: sendingEnabled.value,
      host: host.value,
      failureKind: statusFailureKind.value,
      configured: configured.value,
      hasBaseUrl: hasBaseUrl(),
    }),
  );

  /** 隐私区那一行状态说明（C3）：`host === null` 时也**绝不**插值出 `null` */
  const hostStateText = computed(() =>
    describeHostState({
      host: host.value,
      failureKind: statusFailureKind.value,
      configured: configured.value,
      hasBaseUrl: hasBaseUrl(),
    }),
  );

  // -------------------------------------------------------------------------
  // 隐私：一次性说明卡 + §7.4 的 revealed
  // -------------------------------------------------------------------------

  /** 说明卡看过没有（`true` ⇒ 不再自动弹）。**不参与**任何权限判定，只决定弹不弹。 */
  const privacyCardSeen = ref(AI_PRIVACY_CARD_SEEN_DEFAULT);

  /**
   * §7.4 乙方案：**本轮主动问出来的**消息（内存 Set，**不落库、不持久化**）。
   *
   * - 不在这里的（= 从库里读回来的历史消息）⇒ 遮罩，渲染 `••••`
   * - 在这里的 ⇒ 显示真值
   *
   * ⚠️ 键是**内存消息 id**（与本文件里那两处 `crypto.randomUUID()` 同一套身份，见 `runTurn` 的
   * 注释）⇒ 它与库里 `ai_messages.id` 不是一回事，**任何持久化都不该拿它当键**。
   * 冷启动后 store 重建 ⇒ 空集 ⇒ 全部回到遮蔽态（`§7.4`：重开 App 后清空）。
   */
  const revealed = ref<Set<string>>(new Set());

  /**
   * 读一次意愿层（入口开关 / 发送开关）与说明卡状态（**永不抛**：三个 reader 的契约都是
   * "读不到回落从严默认值"）。
   *
   * 调用点**只有冷启动那一处**（`main.ts` 的引导）。页面**不许**再读一遍：R71 的教训是
   * "读失败会回落默认值，于是把本会话里已经生效的状态静默覆盖掉"——`sendingEnabled` 的
   * 默认值是"关"、`entryEnabled` 的默认值是"不显示"，覆盖就等于用户明明开了却看不到，
   * 且没有任何提示。
   */
  async function loadPrivacySettings(): Promise<void> {
    entryEnabled.value = await readEntryEnabled();
    sendingEnabled.value = await readSendingEnabled();
    privacyCardSeen.value = await readPrivacyCardSeen();
  }

  /**
   * 翻转**入口**开关（G1/G2）。**先落盘、后改内存**（R57）：写失败即 reject，绝不让界面
   * 显示一个没写进去的入口。
   *
   * 三件事刻意如此：
   * - **不看 `host`**：不知道数据发往哪里、断网、服务端没配，都不阻止用户把入口打开
   *   （规则 2：开启入口永远可达。老实现正是在这里"拒绝开启"，与"开关不渲染"合成死锁）。
   * - **先探一次**：开入口的同时刷新能力层文案，用户点进去就不会看到一句过期的话。
   *   这次探测是**用户显式触发**的（第 47 条允许），而 `refreshStatus` 本身不设"地址就绪"
   *   守卫（守卫在**触发点**：`App.vue` 的就绪 `watch`）⇒ 地址没配时点它也不会被拦下，
   *   用户能拿到 C3.4 那条说明。
   * - `refreshStatus` 永不抛 ⇒ 探测失败不影响下面的落盘。
   */
  async function setEntryEnabled(enabled: boolean): Promise<void> {
    await refreshStatus();
    await writeEntryEnabled(enabled);
    entryEnabled.value = enabled;
  }

  /**
   * 翻转意愿层**发送**开关（§7.3）。**先落盘、后改内存**（R57）。
   *
   * ⚠️ 唯一一道拒绝是「服务端**明确**说没配」（C4.3 的防呆）：那种状态下开启也发不出去，
   * 提前告诉用户比让他点进去等一次失败好。**拒绝前不写盘**（`writeSetting` 零调用）。
   * 老实现拒绝的是 `host === null`（地址/登录态还没就绪也算进去）⇒ 与"开关不渲染"
   * 合成死锁（`host` 永远拿不到、开关永远点不开），本轮删掉。关闭方向不受限。
   */
  async function setSendingEnabled(enabled: boolean): Promise<void> {
    if (enabled && configured.value === false) {
      console.warn("[ai/store] 服务端明确未配置 AI，不允许开启发送（C4.3）");
      throw new Error(AI_NOT_CONFIGURED_TEXT);
    }
    await writeSendingEnabled(enabled);
    sendingEnabled.value = enabled;
  }

  /** 用户点「知道了」：先落盘再改内存（失败即 reject ⇒ 卡片留着，调用方如实提示） */
  async function dismissPrivacyCard(): Promise<void> {
    await writePrivacyCardSeen();
    privacyCardSeen.value = true;
  }

  /**
   * 探一次 AI 能力。**不轮询**（M2 契约第 4 条：`/ai/status` 与 `/ai/chat` 共用一个每分钟桶）。
   *
   * **本函数不设"地址就绪"守卫**：守卫放在**触发点**（`App.vue` 那个 `watch(auth.baseUrlReady)`，
   * 只有 `hasBaseUrl()` 为真时才调它）。理由是可测的 —— 把守卫塞进这里会让所有直接调
   * `refreshStatus()` 的既有用例（`aiChat.status.test.ts`、`AiChatPage.test.ts:770`、
   * `SecurityPage.aiSwitch.test.ts:51` 等，它们的 fixture 从不配 base URL）全部红，
   * 而那些用例钉的是"探测结果怎么写进 store"，与"什么时候允许自动探"是两件事。
   * 用户显式路径（隐私区「重新检测」、`setEntryEnabled`）也必须永远可达（C6.3）。
   *
   * ⚠️ 页面**不许**自动探一次：用户刚问完一句再进 AI 页，第二次探测会吃 `ai_rate_limited`
   * （同一个每分钟桶），而一个给不出结论的探测**不该**把已经确认可用的入口关掉（第 47 条）。
   *
   * **永不抛**（`fetchAiStatus` 的契约），但**只有服务端明确表态才改已知状态**：
   * - 请求成功（无 `failure`）⇒ 服务端说的 `enabled` 就是答案（没配 AI 是 200 + `enabled:false`）；
   * - `failure.kind === "disabled"`（503 `ai_disabled`）⇒ 明确关闭；
   * - 其它失败（网络 / 超时 / 429 / 形状坏 / 401 / 5xx）⇒ 这次探测**不可判定** ⇒ 保留上一次已知状态。
   */
  async function refreshStatus(): Promise<void> {
    const next = await fetchAiStatus();
    if (next.failure === undefined) {
      status.value = next;
      statusUnknown.value = false;
      configured.value = next.enabled;
      statusFailureKind.value = null;
      return;
    }
    if (next.failure.kind === "disabled") {
      // 503 `ai_disabled`：服务端**明确**表态没配（与 200 + enabled:false 同类）
      status.value = next;
      statusUnknown.value = false;
      configured.value = false;
      statusFailureKind.value = null;
      return;
    }
    // 不可判定：上一次已知的 `status`（含 host/model）与 `configured` 原样留着；
    // 从没有过已知状态 ⇒ 记成"未知"。失败类型**只**用于文案分流（C3.5），不用来改门控。
    statusFailureKind.value = next.failure.kind;
    if (status.value === null) statusUnknown.value = true;
  }

  // -------------------------------------------------------------------------
  // 快照
  // -------------------------------------------------------------------------

  /**
   * 当前用户 id（**唯一**取值口径，与手动记账 `useTransactionForm.currentUserId:47`、
   * `AccountPickerSheet:33`、`DraftCard:175-177` 逐字一致）。
   *
   * 团队账本里它就是账户 `owner_id` 的比对对象：AI 名下的账户必须与记账页能选的账户
   * 是**同一批**（两处口径一分叉，就变成"记账页能选、AI 说没有"这类只在一端复现的缺陷）。
   * 这里显式收成一个函数，正是因为快照与解析表两处都要它，且都不该各写一份表达式。
   */
  function currentUserId(): string {
    return useAuthStore().currentLocalUser?.server_user_id || getCurrentUserId() || "";
  }

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
   * `members` 只收名字（**整张成员表**传进来，见下）：同一个成员表还喂给 `runAgent` 的解析表。
   * 这里要的是它的 `id → 显示名` 映射 —— 其他成员的账户在快照里必须**带归属**，而归属写的是
   * 显示名（别名 > 昵称 > username，`useMemberInfo` 那套），不是 id（§7.3）。
   */
  async function buildSnapshot(members: { id: string; name: string }[]): Promise<LedgerSnapshot> {
    const ledger = ledgerStore.currentLedger;
    const isTeam = ledger !== null && ledger.type === "team";
    const me = currentUserId();
    const all = useAccountStore().accounts;
    // ⚠️ 只有"团队账本 **且** 知道当前用户是谁"时才分组 —— 与 `buildLookupContext` 里那条
    // owner 过滤**同一个判据**。身份未知时两边都退回"不过滤（全当自己的）"：一边分组标注、
    // 另一边不分组，会让模型抄一个解析表里根本不存在的名字。
    const scoped = isTeam && me !== "";
    const mine = scoped ? all.filter((a) => a.owner_id === me) : all;
    const others = scoped ? all.filter((a) => a.owner_id !== me) : [];
    const ownerNames = new Map(members.map((m) => [m.id, m.name]));
    const item = (a: (typeof all)[number]): { name: string; type: string } => ({
      name: a.name,
      // 中文类型名（招行(银行卡)）：快照给的是**人话**，模型照着它跟用户对话（§7.1 的示例）
      type: ACCOUNT_TYPE_LABELS[a.type],
    });
    return {
      kind: isTeam ? "team" : "personal",
      categories: useCategoryStore().categories.map((c) => ({ name: c.name, type: c.type })),
      // ⚠️ 账户只列**当前用户自己的**（团队账本口径，判据照 `useTransactionForm.availableAccounts:48-54`
      //    与 `DraftCard.accountOptions:178-184`；解析表那侧的同一规则落在 `buildLookupContext`
      //    的 SQL 上，由 `send` 传下去的 `currentUserId` 驱动）。
      //    少了这一条，两个成员各有一个「现金」时模型收到的是**无法区分**的清单，
      //    用户说"用我的"也没用（实机缺陷）。
      accounts: mine.map(item),
      // 其他成员的账户**另起一组**：它们合法，但**只能当转账的转入方**（与手动记账一致，
      // `RecordPage.vue:61` 的 `scope="all"`）。名字带归属，且与解析表里那一条逐字相同
      // （`otherAccountLabel`）—— 模型照着快照写，链路才唯一命中。
      // 没有别的成员的账户时**不带这个键**（个人账本的快照逐字不变，§7.1 老会话不漂移）。
      ...(others.length === 0
        ? {}
        : {
            otherAccounts: others.map((a) => ({
              ...item(a),
              name: otherAccountLabel(ownerNames.get(a.owner_id), a.name),
            })),
          }),
      tags: useTagStore().tags.map((t) => t.name),
      members: members.map((m) => ({ name: m.name })),
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
    const selfId = currentUserId();
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
    confirmedDrafts,
    rejectedDrafts,
    status,
    enabled,
    configured,
    statusFailureKind,
    host,
    model,
    entryEnabled,
    setEntryEnabled,
    sendingEnabled,
    sendingHint,
    hostStateText,
    privacyCardSeen,
    revealed,
    attachedImage,
    setAttachedImage,
    clearAttachedImage,
    load,
    send,
    cancel,
    clear,
    // 已无生产调用者（R86-6）：**不要**从 UI 接回它（那是 C-P1 的复活路径），UI 用 rejectDraft
    dismissDraft,
    confirmDraft,
    rejectDraft,
    undoDraft,
    refreshStatus,
    loadPrivacySettings,
    setSendingEnabled,
    dismissPrivacyCard,
  };
});
