import { CodexTurnUsage } from "./usage-accounting";
// ──────────────────────────────────────────────────────────
// Codex app-server → SessionNotification translator.
// ──────────────────────────────────────────────────────────
//
// Maps the ~60 app-server `ServerNotification` event types onto our
// canonical `SessionNotification` shape. Replaced the legacy
// `codex exec --json` stream translator; the
// app-server wire is JSON-RPC notifications with method names like
// `item/started`, `item/agentMessage/delta`, etc., rather than flat
// per-line JSON.
//
// The output (canonical SessionNotification) is identical, so the
// renderer doesn't know which transport is underneath.
//
// Event mapping (drawn from `./generated/v2/ServerNotification.ts`,
// regenerated against the codex version pinned in
// `package.json#codexProtocolVersion`):
//
//   thread/started             → captures threadId (no UI event)
//   turn/started               → no-op (turn boundary implicit)
//   turn/completed             → terminal; stopReason=end_turn|cancelled
//   item/started               → tool_call (for commandExecution, fileChange, etc.)
//   item/completed             → tool_call_update {status: completed|failed}
//   item/agentMessage/delta    → agent_message_chunk
//   item/reasoning/textDelta   → agent_thought_chunk
//   item/reasoning/summary*    → agent_thought_chunk (summary subchannel)
//   item/commandExecution/outputDelta → tool_call_update (streaming exec output)
//   item/fileChange/outputDelta       → tool_call_update (streaming edit)
//   item/fileChange/patchUpdated      → tool_call_update (final patch)
//   turn/diff/updated, turn/plan/updated → known aggregate no-ops
//   error                      → terminal unless willRetry; emits notice row
//   warning / deprecationNotice / configWarning → notice row (info-tier)
//   mcpServer/startupStatus/updated → known no-op; connection state lives in Tools
//   account/updated            → captured externally by the adapter (not a UI event here)
//   account/rateLimits/updated → ditto
//
// ──────────────────────────────────────────────────────────

import { normalizeProviderError, type ProviderError } from "../shared/provider-error";
import { randomUUID } from "node:crypto";
import type { ToolArtwork } from "@zeros/protocol/tool-artwork";
import type { CodexToolIdentity } from "./tool-artwork";

import type { ToolCallContent } from "@zeros/protocol/agent-events";

import { isDevRuntime } from "../../../runtime";
import type { ContentBlock, QuestionRequest, SessionNotification, TurnUsage } from "../../types";
import type { AsyncUserInputQuestion } from "./generated/v2/AsyncUserInputQuestion";
import type { WebSearchAction } from "./generated/WebSearchAction";
import type { ImageGenerationItem } from "./generated/ImageGenerationItem";

type Emit = (notification: SessionNotification) => void;
type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "list"
  | "web_search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "subagent"
  | "mcp"
  | "question"
  | "compaction"
  | "model_switch"
  | "other";

// The renderer clips raw tool output at 20k characters. Keep one extra
// character so it can display its truncation marker while bounding the
// translator's live per-item accumulator.
const MAX_STREAMED_TOOL_OUTPUT_CHARS = 20_001;

export interface CodexAppServerTranslatorOptions {
  sessionId: string;
  /** Resumed threads may deliver restored totals before the first new turn. */
  resumed?: boolean;
  emit: Emit;
  onAsyncQuestion?: (request: QuestionRequest) => void;
  /** Called for any notification we don't have a mapping for — useful
   *  for diagnostics when codex ships a new event type. */
  onUnknown?: (method: string, params: unknown) => void;
  resolveArtwork?: (
    item: CodexToolIdentity,
  ) => Promise<ToolArtwork | undefined>;
}

/** Stateful translator — one instance per Zeros session. Holds the
 *  in-progress turn id, the tool-call id map for the current turn, and
 *  the delta-emission state for streaming agent messages. */
export class CodexAppServerTranslator {
  private readonly sessionId: string;
  private readonly emit: Emit;
  private readonly onUnknown?: (method: string, params: unknown) => void;
  private readonly onAsyncQuestion?: CodexAppServerTranslatorOptions["onAsyncQuestion"];
  private readonly asyncQuestionItems = new Set<string>();
  private readonly resolveArtwork?: CodexAppServerTranslatorOptions["resolveArtwork"];
  private readonly artworkRequests = new Map<string, symbol>();

  /** Codex item.id → Zeros tool call id. One tool per item.id so we
   *  can correlate item/completed back to the originating tool_call. */
  private readonly toolCallIds = new Map<string, string>();
  private readonly emittedToolCallIds = new Set<string>();
  private parentToolId: string | undefined;
  private isChild = false;
  private readonly modelFallbacks = new Set<string>();
  private readonly unparentedIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
  private agentActivityStopped = false;
  private readonly agentGroups = new Map<
    string,
    {
      id: string;
      terminal: boolean;
      seen: Set<string>;
      input?: Record<string, unknown>;
    }
  >();
  private readonly safetyReviewToolCalls = new Map<string, string>();
  private readonly completedSafetyReviewIds = new Set<string>();

  /** Monotonic suffix for error_notice ids — each retry attempt / advisory
   *  in a turn gets its OWN timeline row (never appended into one blob). */
  private noticeSeq = 0;

  /** True once the CURRENT retry burst (`error` notifications with
   *  `willRetry:true`) has produced its api_retry notice row — codex retries
   *  the SAME turn itself, so one "Reconnecting agent" row per burst (parity
   *  with the Claude translator's api_retry handling), not one per attempt.
   *  Cleared by any item/turn progress (the retried call got through). */
  private retryBurstNoticed = false;

  /** Zeros-side (minted) tool call id for a native itemId — lets the adapter
   *  address a timeline row it only knows by vendor id (the question-stamp
   *  tool_call_update on requestUserInput settle). Undefined until the item
   *  has streamed through item/started or a requestUserInput row has been
   *  synthesized from the server request. */
  toolCallIdFor(itemId: string): string | undefined {
    return this.toolCallIds.get(itemId);
  }

  /** Codex may ask a blocking question through the JSON-RPC request channel
   *  without first streaming an item/started notification for the same item.
   *  Emit the transcript row from the request itself so the UI has a stable
   *  User input row to show AWAITING / ANSWERED / SKIPPED. */
  emitUserInputToolCall(params: Record<string, unknown>): string | undefined {
    const itemId =
      typeof params.itemId === "string" ? params.itemId : undefined;
    if (!itemId) return undefined;
    const toolCallId = this.ensureToolCallId(itemId);
    this.emitToolCallUpsert(toolCallId, {
      nativeToolCallId: itemId,
      title: "request_user_input",
      kind: "question",
      status: "in_progress",
      rawInput: params,
    });
    return toolCallId;
  }

  /** MCP elicitation is a server request rather than a streamed ThreadItem, so
   * it has no item/started row of its own. Emit the same durable question row
   * from the request so awaiting/answered/skipped remains visible in history. */
  emitBlockingQuestionToolCall(
    nativeToolCallId: string | undefined,
    title: string,
    rawInput: unknown,
  ): string | undefined {
    if (!nativeToolCallId) return undefined;
    const toolCallId = this.ensureToolCallId(nativeToolCallId);
    this.emitToolCallUpsert(toolCallId, {
      nativeToolCallId,
      title,
      kind: "question",
      status: "in_progress",
      rawInput,
    });
    return toolCallId;
  }

  /** Codex item.id → cumulative text we've emitted for that item.
   *  Used to compute the delta from full-text updates. (The delta
   *  events carry only the diff; the lifecycle events sometimes
   *  carry the full accumulated text.) */
  private readonly emittedMessageText = new Map<string, string>();
  private readonly reasoningParts = new Map<string, { summary: Map<number, string>; content: Map<number, string> }>();
  /** Agent-message deltas carry only itemId + text. Retain the phase announced
   * by item/started so streamed chunks keep Codex's commentary/final
   * distinction all the way to the renderer. */
  private readonly messagePhases = new Map<
    string,
    "commentary" | "final_answer"
  >();
  /** Last phase forwarded for each streamed message. Some app-server builds
   * attach phase only to item/completed, after the final text delta. An empty
   * coalescing update can then reclassify the message without duplicating it. */
  private readonly emittedMessagePhases = new Map<
    string,
    "commentary" | "final_answer"
  >();

  /** Codex command output notifications are true deltas. Session updates,
   * however, replace a tool card's rawOutput snapshot. Retain one cumulative
   * value per live item so every replacement grows monotonically. */
  private readonly emittedToolOutput = new Map<string, string>();

  /** Per-turn messageId prefix. Codex's item ids reset across turns,
   *  so prefixing keeps streaming deltas of the same item coalesced
   *  while making cross-turn ids distinct. */
  private turnPrefix: string = randomUUID();

  /** Codex thread id captured from `thread/started`. Used by the
   *  adapter to persist for future resume. */
  private threadId: string | null = null;

  private lastStopReason:
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled" = "end_turn";
  private hasSeenTurnTerminal = false;
  /** Set from a failed turn's / error's `codexErrorInfo` when it's an
   *  auth or usage-limit class — the adapter surfaces it as a real
   *  AgentFailure so the green dot updates instead of the failure living
   *  only as a chat bubble. Null otherwise. */
  private turnFailureLabel: string | null = null;
  private turnErrorMessage: string | null = null;
  private turnNativeFailure: ProviderError | null = null;

  get terminalFailure(): ProviderError | null {
    return this.turnNativeFailure;
  }

  get terminalError(): string | null {
    return this.turnErrorMessage;
  }
  private turnRateLimitLabel: string | null = null;
  /** Per-turn token usage (tokenUsage.last) for analytics. */
  private lastTurnUsage: TurnUsage | undefined;
  private readonly usageAccounting: CodexTurnUsage;

  constructor(opts: CodexAppServerTranslatorOptions) {
    this.usageAccounting = new CodexTurnUsage(opts.resumed);
    this.onAsyncQuestion = opts.onAsyncQuestion;
    this.sessionId = opts.sessionId;
    this.emit = (event) => {
      const update = event.update;
      const key =
        "toolCallId" in update
          ? update.toolCallId
          : "messageId" in update
            ? update.messageId
            : update.sessionUpdate === "error_notice"
              ? `notice-${update.noticeId}`
              : undefined;
      if (key && !this.parentToolId) this.unparentedIds.add(key);
      if (this.unparentedIds.size > 10_000)
        this.unparentedIds.delete(this.unparentedIds.values().next().value!);
      const parentable =
        update.sessionUpdate === "agent_message_chunk" ||
        update.sessionUpdate === "agent_thought_chunk" ||
        update.sessionUpdate === "model_fallback" ||
        update.sessionUpdate === "tool_call" ||
        update.sessionUpdate === "error_notice";
      opts.emit(
        this.parentToolId && parentable && !("parentToolId" in update && update.parentToolId)
          ? { ...event, update: { ...update, parentToolId: this.parentToolId } }
          : event,
      );
    };
    this.onUnknown = opts.onUnknown;
    this.resolveArtwork = opts.resolveArtwork;
  }

  /** Independent native-thread state sharing only the canonical event sink. */
  childTranslator(): CodexAppServerTranslator {
    const child = new CodexAppServerTranslator({
      sessionId: this.sessionId,
      resolveArtwork: this.resolveArtwork,
      onUnknown: this.onUnknown,
      onAsyncQuestion: this.onAsyncQuestion,
      emit: (event) => {
        if (event.update.sessionUpdate !== "usage_update") this.emit(event);
      },
    });
    child.isChild = true;
    return child;
  }

  setParentToolId(toolCallId: string): void {
    if (this.parentToolId === toolCallId) return;
    this.parentToolId = toolCallId;
    if (this.unparentedIds.size)
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "message_parent_update",
          messageIds: [...this.unparentedIds],
          parentToolId: toolCallId,
        },
      });
    this.unparentedIds.clear();
  }

  // ── Public accessors ────────────────────────────────────

  get codexThreadId(): string | null {
    return this.threadId;
  }

  get stopReason(): typeof this.lastStopReason {
    return this.lastStopReason;
  }

  get sawTurnTerminal(): boolean {
    return this.hasSeenTurnTerminal;
  }

  /** Auth/usage-limit label captured from a failed turn's codexErrorInfo
   *  (e.g. "Not signed in (unauthorized)"), else null. The adapter throws
   *  a classified AgentFailure when set so mid-turn auth/quota failures
   *  flip the green dot instead of living only as a chat bubble. */
  get authQuotaFailure(): string | null {
    return this.turnFailureLabel;
  }

  /** Provider throttling/overload captured from structured CodexErrorInfo. */
  get rateLimitFailure(): string | null {
    return this.turnRateLimitLabel;
  }

  /** Per-turn token usage for LLM analytics (no cost over
   *  the app-server protocol). */
  get turnUsage(): TurnUsage | undefined {
    return this.lastTurnUsage;
  }

  /** True when the NEXT contextCompaction item was initiated by the user
   *  (Compact now / typed /compact → adapter.compactContext armed this
   *  right before the thread/compact/start RPC). Stamps the row's
   *  rawInput.trigger "manual" so the renderer places it standalone;
   *  codex's own auto-compactions stay "auto" (grouped). */
  private manualCompactionExpected = false;

  /** Adapter hook — see manualCompactionExpected. */
  expectManualCompaction(): void {
    this.manualCompactionExpected = true;
  }

  /** Undo expectManualCompaction after a rejected compact RPC (no item is
   *  coming — a stale flag would mislabel a later AUTO compaction). */
  disarmManualCompaction(): void {
    this.manualCompactionExpected = false;
  }

  /** Settle a successful opaque denied-action retry without retaining the
   * renderer-facing retry token in durable transcript output. */
  markSafetyReviewRetried(retryId: string): void {
    const toolCallId = this.safetyReviewToolCalls.get(retryId);
    if (!toolCallId) return;
    this.safetyReviewToolCalls.delete(retryId);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "safety_review_retry_available",
        toolCallId,
        retryId: null,
      },
    });
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: {
          zerosSafetyReview: { status: "approved", retried: true },
        },
      },
    });
  }

  /** Revoke a bounded engine action that can no longer be resolved. The
   * renderer removes only its ephemeral button; the durable audit row stays. */
  revokeSafetyReviewRetry(retryId: string): void {
    const toolCallId = this.safetyReviewToolCalls.get(retryId);
    if (!toolCallId) return;
    this.safetyReviewToolCalls.delete(retryId);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "safety_review_retry_available",
        toolCallId,
        retryId: null,
      },
    });
  }

  /** Reset terminal/streaming state at the start of a new turn. The
   *  thread id is not reset — it persists across turns. */
  startTurn(): void {
    this.usageAccounting.start();
    this.agentActivityStopped = false;
    this.turnPrefix = randomUUID();
    this.artworkRequests.clear();
    this.toolCallIds.clear();
    this.emittedToolCallIds.clear();
    this.completedItemIds.clear();
    this.asyncQuestionItems.clear();
    this.emittedMessageText.clear();
    this.reasoningParts.clear();
    this.messagePhases.clear();
    this.emittedMessagePhases.clear();
    this.emittedToolOutput.clear();
    this.hasSeenTurnTerminal = false;
    this.lastStopReason = "end_turn";
    this.turnFailureLabel = null;
    this.turnErrorMessage = null;
    this.turnNativeFailure = null;
    this.turnRateLimitLabel = null;
    this.lastTurnUsage = undefined;
    this.retryBurstNoticed = false;
  }

  // ── Notification entry point ────────────────────────────

  /** Dispatch a server notification by method name + params. The
   *  runtime registered this as the handler in `onNotification`. */
  handle(method: string, params: unknown): void {
    // Any item/turn progress means the retried call got through — the current
    // retry burst is over; the next willRetry error starts a NEW burst (and
    // gets its own "Reconnecting agent" row).
    if (method.startsWith("item/") || method === "turn/completed") {
      this.retryBurstNoticed = false;
    }
    switch (method) {
      case "thread/started":
        this.onThreadStarted(params);
        break;
      case "turn/started": {
        const id = (params as { turn?: { id?: string } })?.turn?.id;
        if (id) this.usageAccounting.bind(id);
        break;
      }
      case "turn/completed":
        this.onTurnCompleted(params);
        break;
      case "thread/tokenUsage/updated":
        this.onTokenUsage(params);
        break;
      case "thread/status/changed":
        // Known no-op — fans out for every (sub)thread state flip during a
        // collab run; the collabAgentToolCall items carry the user-facing
        // story, so there is nothing to render here.
        break;
      case "turn/diff/updated":
      case "turn/plan/updated":
        // Known aggregate snapshots. FileChange item events already drive the
        // edit timeline + authored-file attribution, and Zeros deliberately
        // has no plan card. Re-emitting either would duplicate UI; treating
        // them as unknown only creates high-volume diagnostic noise.
        break;
      case "item/started":
        this.onItemStarted(params);
        break;
      case "item/completed":
        this.onItemCompleted(params);
        break;
      case "item/agentMessage/delta":
        this.onAgentMessageDelta(params);
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/summaryPartAdded":
        this.onReasoningDelta(params, method);
        break;
      case "item/plan/delta":
        this.onAgentMessageDelta(params, "commentary");
        break;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "process/outputDelta":
      case "command/exec/outputDelta":
      case "item/commandExecution/terminalInteraction":
        this.onToolOutputDelta(params, method);
        break;
      case "item/fileChange/patchUpdated":
        this.onFilePatchUpdated(params);
        break;
      case "item/mcpToolCall/progress":
        this.onMcpToolCallProgress(params);
        break;
      case "hook/started":
        this.onHookLifecycle(params, false);
        break;
      case "hook/completed":
        this.onHookLifecycle(params, true);
        break;
      case "model/rerouted":
        this.onModelRerouted(params);
        break;
      case "model/verification":
        this.onModelVerification(params);
        break;
      case "model/safetyBuffering/updated":
        this.onSafetyBuffering(params);
        break;
      case "thread/environment/connected":
        this.onEnvironmentConnection(params, true);
        break;
      case "thread/environment/disconnected":
        this.onEnvironmentConnection(params, false);
        break;
      case "externalAgentConfig/import/progress":
        this.onExternalConfigImport(params, false);
        break;
      case "externalAgentConfig/import/completed":
        this.onExternalConfigImport(params, true);
        break;
      case "mcpServer/oauthLogin/completed":
        this.onMcpOauthCompleted(params);
        break;
      case "mcpServer/startupStatus/updated":
        // Startup/reconnect notifications are background connection state,
        // including during a turn. Tools reads the same thread's status via
        // mcpServerStatus/list. Only item events describe an agent tool call
        // and carry its failure into the transcript.
        break;
      case "item/autoApprovalReview/started":
        this.onSafetyReview(params, false);
        break;
      case "item/autoApprovalReview/completed":
        this.onSafetyReview(params, true);
        break;
      case "autoApprovalReview/strictReviewRequired":
        this.onStrictReviewRequired(params);
        break;
      case "error":
        this.onError(params);
        break;
      case "warning":
      case "deprecationNotice":
      case "configWarning":
      case "guardianWarning":
        this.onAdvisory(params, method);
        break;
      case "account/updated":
      case "account/rateLimits/updated":
      case "account/login/completed":
        // Captured by the adapter directly (it owns auth/usage UI). The
        // translator deliberately doesn't surface these as message
        // bubbles.
        break;
      default:
        this.onUnknown?.(method, params);
    }
  }

  // ── Handlers ────────────────────────────────────────────

  private onThreadStarted(params: unknown): void {
    const p = params as { thread?: { id?: string } };
    if (typeof p?.thread?.id === "string") {
      this.threadId = p.thread.id;
    }
  }

  private onTurnCompleted(params: unknown): void {
    const p = params as {
      turn?: {
        status?: string;
        itemsView?: string;
        items?: ThreadItemUnion[];
        error?: { codexErrorInfo?: unknown; message?: string };
      };
    };
    // A full native snapshot can recover item notifications lost during a
    // reconnect. Summary/notLoaded payloads are not transcript authority.
    // A terminal turn does not prove that every child tool finished.
    if (p?.turn?.itemsView === "full" && Array.isArray(p.turn.items) &&
        ["completed", "failed", "interrupted"].includes(p.turn.status ?? "")) {
      for (const item of p.turn.items) {
        if (!item || typeof item.id !== "string" || typeof item.type !== "string") continue;
        const status = (item as { status?: string }).status;
        const requiresStatus = ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "imageGeneration"].includes(item.type);
        if ((requiresStatus && !status) || (status && !["completed", "failed", "declined"].includes(status))) {
          this.onItemStarted({ item });
        } else {
          this.onItemCompleted({ item });
        }
      }
    }
    this.hasSeenTurnTerminal = true;
    const status = p?.turn?.status;
    // Generated TurnStatus = completed | interrupted | failed | inProgress.
    // A user abort is "interrupted" — the old `=== "cancelled"` compare was
    // a dead branch (so Cancel resolved as a clean end_turn).
    if (status === "interrupted") {
      this.lastStopReason = "cancelled";
    } else if (status === "failed") {
      // Generated TurnError = { message, codexErrorInfo, additionalDetails }
      // — there is no `.code`. The error identity is in codexErrorInfo.
      const cls = classifyCodexErrorInfo(p?.turn?.error?.codexErrorInfo);
      this.turnNativeFailure = p?.turn?.error
        ? normalizeProviderError("codex", p.turn.error)
        : this.turnNativeFailure ?? normalizeProviderError("codex", { message: this.turnErrorMessage || cls.label });
      this.turnErrorMessage = this.turnNativeFailure.message;
      this.turnFailureLabel = this.turnNativeFailure.category === "auth-required" ? cls.label : null;
      this.turnRateLimitLabel = this.turnNativeFailure.category === "rate-limited" ? cls.label : null;
      this.lastStopReason = cls.stopReason;
    } else {
      this.lastStopReason = "end_turn";
    }
  }

  /** Codex fans out token usage per turn via `thread/tokenUsage/updated`
   *  (ThreadTokenUsageUpdatedNotification). Mirror Claude's `usage_update`
   *  so the context gauge lights up for Codex too.
   *
   *  `used` = CURRENT WINDOW FILL, not the cumulative thread total:
   *  `last.totalTokens` is the latest inference call's full prompt + its
   *  output — the context as the model just saw it. Unlike
   *  `total.totalTokens` (a lifetime odometer that only climbs), this
   *  reading DROPS after a compaction, which is what makes the gauge
   *  honest. Wire-verified 2026-07-12 (Codex 0.144.1): on a
   *  normal turn last.totalTokens ≡ inputTokens+outputTokens, but the
   *  POST-COMPACTION re-report carries the new fill ONLY in totalTokens
   *  (input/output are 0 — no inference ran), so summing the parts made
   *  the gauge read a false ZERO right after compacting. Falls back to
   *  input+output (older shapes), then the cumulative total. `size` = the
   *  model's context window (0 when the server reports null). No `cost` —
   *  the app-server protocol carries token counts but not pricing. */
  private onTokenUsage(params: unknown): void {
    const p = params as {
      turnId?: string;
      tokenUsage?: {
        total?: { totalTokens?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningOutputTokens?: number };
        last?: {
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          reasoningOutputTokens?: number;
        };
        modelContextWindow?: number | null;
      };
    };
    const lastUsage = p?.tokenUsage?.last;
    const lastIn = lastUsage?.inputTokens;
    const lastOut = lastUsage?.outputTokens;
    const used =
      typeof lastUsage?.totalTokens === "number" && lastUsage.totalTokens > 0
        ? lastUsage.totalTokens
        : typeof lastIn === "number"
          ? lastIn + (typeof lastOut === "number" ? lastOut : 0)
          : p?.tokenUsage?.total?.totalTokens;
    const size = p?.tokenUsage?.modelContextWindow;
    this.lastTurnUsage = this.usageAccounting.record(p?.turnId, p?.tokenUsage?.total, p?.tokenUsage?.last);
    const last = p?.tokenUsage?.last;
    if (last) {
      // Dev-only cache-health signal: the fraction of this turn's input
      // tokens OpenAI served from its prompt cache. Codex reports inputTokens
      // as the TOTAL prompt (cachedInputTokens is the cached subset), so the
      // ratio should stay ≤100% and climb across a warm multi-turn thread.
      const inputTotal = last.inputTokens ?? 0;
      if (isDevRuntime() && inputTotal > 0) {
        const read = last.cachedInputTokens ?? 0;
        console.info(
          `[codex] cache-read ratio: ${((read / inputTotal) * 100).toFixed(0)}% ` +
            `(read=${read} / input-total=${inputTotal})`,
        );
      }
    }
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "usage_update",
        size: typeof size === "number" ? size : 0,
        used: typeof used === "number" ? used : 0,
      },
    });
  }

  private onSubagentActivity(item: SubagentActivityItem): void {
    if (!item.agentThreadId || !item.id || this.agentActivityStopped) return;
    const previous = this.agentGroups.get(item.agentThreadId);
    const id = previous?.id ?? this.ensureToolCallId(item.id);
    this.toolCallIds.set(item.id, id);
    if (previous) this.emittedToolCallIds.add(id);
    // Completing the activity ITEM only confirms delivery of its event. The
    // event kind owns the child's lifetime, independent of the parent's turn.
    const seen = previous?.seen ?? new Set<string>();
    const activityKey = JSON.stringify([item.id, item.kind]);
    if (seen.has(activityKey)) return;
    seen.add(activityKey);
    if (seen.size > 512) seen.delete(seen.values().next().value!);
    // A new interaction is positive evidence of a resumed child. Replaying
    // its old spawn or terminal event must not change that newer lifetime.
    if (previous?.terminal && item.kind === "started") return;
    const terminal = item.kind === "completed" || item.kind === "interrupted";
    const input = {
      ...previous?.input,
      agentThreadId: item.agentThreadId,
      agentPath: item.agentPath,
    };
    this.agentGroups.set(item.agentThreadId, { id, terminal, seen, input });
    if (this.agentGroups.size > 512)
      this.agentGroups.delete(this.agentGroups.keys().next().value!);
    const name =
      item.agentPath
        ?.split("/")
        .filter(Boolean)
        .at(-1)
        ?.replace(/[_-]+/g, " ") ?? "";
    this.emitToolCallUpsert(id, {
      nativeToolCallId: item.id,
      title: "Agent",
      kind: "subagent",
      status:
        item.kind === "interrupted"
          ? "failed"
          : terminal
            ? "completed"
            : "in_progress",
      rawInput: {
        ...input,
        description:
          previous?.input?.description ??
          (name ? name[0].toUpperCase() + name.slice(1) : undefined),
      },
      rawOutput:
        item.kind === "interrupted"
          ? {
              status: "interrupted",
              report: null,
              message: "Agent interrupted.",
            }
          : {
              status: terminal ? "completed" : "running",
              ...(terminal ? {} : { report: null, message: null }),
            },
      content: [],
    });
  }

  completeAgentThread(threadId: string, status: string): void {
    const group = this.agentGroups.get(threadId);
    if (!group || group.terminal || this.agentActivityStopped) return;
    if (!["completed", "interrupted", "failed"].includes(status)) return;
    group.terminal = true;
    this.emittedToolCallIds.add(group.id);
    this.emitToolCallUpsert(group.id, {
      status: status === "completed" ? "completed" : "failed",
      rawOutput: {
        status,
        ...(status === "completed"
          ? {}
          : { message: "Agent ended before reporting completion." }),
      },
    });
  }

  /** The transport or local Stop ended observation of these children. Never
   * leave a loader active just because their final activity event was lost. */
  endAgentActivity(): void {
    this.agentActivityStopped = true;
    for (const group of this.agentGroups.values()) {
      if (group.terminal) continue;
      group.terminal = true;
      this.emittedToolCallIds.add(group.id);
      this.emitToolCallUpsert(group.id, {
        status: "failed",
        rawOutput: {
          status: "interrupted",
          message: "Agent ended before reporting completion.",
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Agent ended before reporting completion.",
            },
          },
        ],
      });
    }
  }

  /** Legacy collaboration snapshots describe child state separately from the
   * successful delivery of a spawn/wait operation. Both native shapes share
   * the child-thread group, including its model and delegated prompt. */
  private syncCollabAgents(item: CollabItem, toolCallId: string): void {
    if (this.agentActivityStopped) return;
    for (const receiver of item.receiverThreadIds ?? []) {
      const previous = this.agentGroups.get(receiver);
      if (!previous && item.tool !== "spawnAgent") continue;
      const id = previous?.id ?? toolCallId;
      const input = previous?.input ?? recordValue(toolInput(item));
      const state = item.agentsStates?.[receiver];
      if (previous && !state) continue;
      const status =
        item.tool === "spawnAgent" && computeStatus(item) === "failed"
          ? "failed"
          : collabChildStatus(state?.status);
      const terminal = status !== "in_progress";
      if (
        previous?.terminal &&
        !terminal &&
        !["resumeAgent", "sendInput", "followupTask"].includes(item.tool)
      )
        continue;
      if (previous?.seen.has(item.id)) continue;
      const seen = previous?.seen ?? new Set<string>();
      seen.add(item.id);
      if (seen.size > 512) seen.delete(seen.values().next().value!);
      this.agentGroups.set(receiver, { id, terminal, seen, input });
      if (this.agentGroups.size > 512)
        this.agentGroups.delete(this.agentGroups.keys().next().value!);
      if (item.tool !== "spawnAgent" && state) {
        this.emittedToolCallIds.add(id);
        this.emitToolCallUpsert(id, {
          status,
          rawOutput: { status, report: state.message ?? null },
          ...(state.message
            ? {
                content: [
                  {
                    type: "content",
                    content: { type: "text", text: state.message },
                  },
                ],
              }
            : {}),
        });
      }
    }
  }

  private onItemStarted(params: unknown): void {
    const p = params as { item?: ThreadItemUnion };
    const item = p?.item;
    if (!item || typeof item.type !== "string") return;
    if (this.completedItemIds.has(item.id)) return;

    switch (item.type) {
      case "subAgentActivity":
        this.onSubagentActivity(item);
        return;
      case "agentMessage":
      case "plan":
      case "userMessage":
        // Message-shaped items — we wait for delta events to stream
        // text. Just remember the id for later delta correlation.
        if (item.type === "agentMessage" && asyncQuestions(item).length) {
          this.asyncQuestionItems.add(item.id);
          return;
        }
        if (item.type === "agentMessage" && item.phase) {
          this.messagePhases.set(item.id, item.delivery === "async" ? "commentary" : item.phase);
        }
        if (typeof (item as { text?: string }).text === "string") {
          this.emitMessageDelta(
            item.id,
            false,
            (item as { text: string }).text,
            item.type === "agentMessage"
              ? (item.delivery === "async" ? "commentary" : item.phase ?? undefined)
              : item.type === "plan" ? "commentary" : undefined,
          );
        }
        return;

      case "reasoning":
        this.onReasoningSnapshot(item);
        return;

      case "enteredReviewMode":
      case "exitedReviewMode":
        // Native bookkeeping only. Inline review also emits its findings as a
        // final agentMessage; projecting `exitedReviewMode.review` would print
        // the same review twice. The user's `/review` bubble already names the
        // action, so neither marker needs separate provider chrome.
        return;

      case "contextCompaction": {
        // The two-state compaction row. rawInput.trigger
        // records WHO initiated it: "manual" (the user's Compact now /
        // /compact routed through compactContext — the adapter armed the
        // flag right before the RPC) renders STANDALONE in the transcript;
        // "auto" (codex compacting on its own mid-turn) stays inside the
        // turn's working group.
        const toolCallId = this.ensureToolCallId(item.id);
        const trigger = this.manualCompactionExpected ? "manual" : "auto";
        this.manualCompactionExpected = false;
        this.emitToolCallUpsert(toolCallId, {
          nativeToolCallId: item.id,
          title: describeItem(item),
          kind: "compaction",
          status: "in_progress",
          rawInput: { trigger },
        });
        return;
      }

      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "webSearch":
      case "imageView":
      case "imageGeneration": {
        const toolCallId = this.ensureToolCallId(item.id);
        const mergeKey = computeMergeKey(item);
        // For shell executions, prefer codex's own command parse
        // (`commandActions`) so a plain `cat`/`rg`/`ls` renders as a Read /
        // Grep / List card instead of a generic Bash row.
        // Falls back to the raw-command "execute" shape when the command is
        // compound or unparsed.
        const parsed =
          item.type === "commandExecution"
            ? summarizeCommandActions(item)
            : null;
        this.emitToolCallUpsert(toolCallId, {
          // Codex's own itemId — blocking user-input requests
          // (requestUserInput → QuestionRequest.toolCallId) reference it,
          // not our minted uuid; the renderer correlates through it.
          nativeToolCallId: item.id,
          title: parsed?.title ?? describeItem(item),
          kind: parsed?.kind ?? mapItemKind(item.type),
          status: "in_progress",
          rawInput: parsed?.rawInput ?? toolInput(item),
          ...(mergeKey ? { mergeKey } : {}),
        });
        if (item.type === "mcpToolCall") this.enrichArtwork(item, toolCallId);
        return;
      }

      case "collabAgentToolCall": {
        // Codex multi-agent collaboration — the model coordinating subagent
        // threads (spawnAgent / messaging / wait / resume / interrupt / close).
        // spawnAgent routes to the Agent card (kind "subagent", like Claude's
        // Task); the coordination verbs render as plain rows with a human
        // title instead of the raw JSON blob they'd get from the unknown-item
        // fallback.
        const toolCallId = this.ensureToolCallId(item.id);
        const collab = describeCollabTool(item);
        this.emitToolCallUpsert(toolCallId, {
          nativeToolCallId: item.id,
          title: collab.title,
          kind: collab.kind,
          status: "in_progress",
          rawInput: toolInput(item),
        });
        return;
      }

      default: {
        // Unknown item kind — emit a generic tool card rather than
        // silently dropping. `item` is narrowed to `never` here by the
        // exhaustive switch; cast back to read id/type defensively for
        // forward-compat with new item types from future codex versions.
        const unknownItem = item as { id: string; type?: string };
        const toolCallId = this.ensureToolCallId(unknownItem.id);
        this.emitToolCallUpsert(toolCallId, {
          nativeToolCallId: unknownItem.id,
          title: unknownItem.type || "tool",
          kind: "other",
          status: "in_progress",
          rawInput: unknownItem,
        });
      }
    }
  }

  private onItemCompleted(params: unknown): void {
    const p = params as { item?: ThreadItemUnion };
    let item = p?.item;
    if (!item || typeof item.type !== "string") return;
    if (this.completedItemIds.has(item.id)) return;
    // Reconnect/replay may deliver only the authoritative completed item.
    // Materialize its row before settling it, using the same native identity.
    if (!this.toolCallIds.has(item.id)) this.onItemStarted(params);
    const streamedOutput = this.emittedToolOutput.get(item.id);
    if (item.type === "commandExecution" && item.aggregatedOutput == null) {
      item = {
        ...item,
        aggregatedOutput: streamedOutput ?? item.aggregatedOutput,
      };
    }
    this.completedItemIds.add(item.id);
    this.emittedToolOutput.delete(item.id);
    if (item.type === "agentMessage" && this.emitAsyncQuestion(item)) return;

    switch (item.type) {
      case "subAgentActivity":
        this.onSubagentActivity(item);
        return;
      case "agentMessage":
      case "plan":
      case "userMessage":
        if (item.type === "agentMessage" && item.phase) {
          this.messagePhases.set(item.id, item.phase);
        }
        if (typeof (item as { text?: string }).text === "string") {
          this.emitMessageDelta(
            item.id,
            false,
            (item as { text: string }).text,
            item.type === "agentMessage"
              ? item.delivery === "async"
                ? "commentary"
                : (item.phase ?? this.messagePhases.get(item.id))
              : item.type === "plan"
                ? "commentary"
                : undefined,
          );
        }
        return;

      case "reasoning":
        this.onReasoningSnapshot(item);
        this.reasoningParts.delete(item.id);
        return;

      case "enteredReviewMode":
      case "exitedReviewMode":
        return;

      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "collabAgentToolCall":
      case "imageView":
      case "imageGeneration":
      case "webSearch": {
        const toolCallId = this.toolCallIds.get(item.id);
        if (!toolCallId) return;
        const spawn =
          item.type === "collabAgentToolCall" && item.tool === "spawnAgent";
        const childState =
          item.type === "collabAgentToolCall" &&
          item.receiverThreadIds?.length === 1
            ? item.agentsStates?.[item.receiverThreadIds[0]]
            : undefined;
        const status =
          spawn && computeStatus(item) !== "failed"
            ? collabChildStatus(childState?.status)
            : computeStatus(item);
        const output = spawn
          ? {
              status,
              report: childState?.message ?? null,
              agentsStates:
                item.type === "collabAgentToolCall"
                  ? item.agentsStates
                  : undefined,
            }
          : toolOutput(item, streamedOutput);
        // Surface the command's plain text output as a content block (not just
        // the `{exitCode, output}` rawOutput object). This lets the renderer
        // show clean output in the detail body AND derive the "N lines" count
        // for Read cards / the match grep heuristic from real text.
        const contentText =
          item.type === "commandExecution" &&
          typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : item.type === "fileChange"
              ? streamedOutput ?? ""
              : typeof output === "string"
                ? output
                : "";
        const dynamicContent =
          item.type === "dynamicToolCall"
            ? dynamicToolContent(item)
            : item.type === "mcpToolCall"
              ? mcpToolContent(item)
              : item.type === "imageGeneration"
                ? imageGenerationContent(item)
                : null;
        const parsed =
          item.type === "commandExecution"
            ? summarizeCommandActions(item)
            : null;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status,
            rawOutput: output,
            title:
              parsed?.title ??
              (item.type === "collabAgentToolCall"
                ? describeCollabTool(item).title
                : describeItem(item)),
            rawInput: parsed?.rawInput ?? toolInput(item),
            content: dynamicContent
              ? dynamicContent
              : contentText.length > 0
                ? [
                    {
                      type: "content",
                      content: {
                        type: "text",
                        text: contentText,
                      } as ContentBlock,
                    },
                  ]
                : null,
          },
        });
        if (item.type === "mcpToolCall") this.enrichArtwork(item, toolCallId);
        if (item.type === "collabAgentToolCall")
          this.syncCollabAgents(item, toolCallId);
        return;
      }

      case "contextCompaction": {
        // Settle the two-state compaction row: "Compacting.." →
        // "Context compacted" + Done chip.
        const toolCallId = this.toolCallIds.get(item.id);
        if (!toolCallId) return;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            title: "Context compacted",
            status: "completed",
          },
        });
        return;
      }

      default: {
        const toolCallId = this.toolCallIds.get((item as { id: string }).id);
        if (!toolCallId) return;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: computeStatus(item),
            rawOutput: item,
          },
        });
      }
    }
  }

  private onAgentMessageDelta(params: unknown, phase?: "commentary"): void {
    const p = params as { itemId?: string; delta?: string };
    if (typeof p?.itemId !== "string" || typeof p?.delta !== "string") return;
    if (this.completedItemIds.has(p.itemId)) return;
    if (this.asyncQuestionItems.has(p.itemId)) return;
    this.emitMessageDelta(
      p.itemId,
      false,
      this.appendDelta(p.itemId, p.delta),
      phase ?? this.messagePhases.get(p.itemId),
    );
  }

  private onReasoningDelta(params: unknown, method: string): void {
    const p = params as {
      itemId?: string;
      delta?: string;
      summaryIndex?: number;
      contentIndex?: number;
    };
    if (typeof p?.itemId !== "string" || this.completedItemIds.has(p.itemId))
      return;
    const parts = this.reasoningParts.get(p.itemId) ?? {
      summary: new Map<number, string>(),
      content: new Map<number, string>(),
    };
    const summary = method !== "item/reasoning/textDelta";
    const index = (summary ? p.summaryIndex : p.contentIndex) ?? 0;
    if (!Number.isInteger(index) || index < 0 || index > 1024) return;
    const target = summary ? parts.summary : parts.content;
    if (typeof p.delta === "string")
      target.set(index, (target.get(index) ?? "") + p.delta);
    this.reasoningParts.set(p.itemId, parts);
    const readable = [...parts.summary.values()].some((value) => value.length > 0)
      ? parts.summary
      : parts.content;
    const text = [...readable]
      .sort(([a], [b]) => a - b)
      .map(([, value]) => value)
      .join("\n\n");
    this.emitMessageDelta(p.itemId, true, text);
  }

  private emitAsyncQuestion(
    item: Extract<ThreadItemUnion, { type: "agentMessage" }>,
  ): boolean {
    const questions = asyncQuestions(item);
    if (!questions.length) return false;
    const toolCallId = this.ensureToolCallId(item.id);
    this.emitToolCallUpsert(toolCallId, {
      nativeToolCallId: item.id,
      title: "request_user_input",
      kind: "question",
      status: "completed",
      rawInput: {
        delivery: "async",
        text: item.text,
        questions: questions.map((q) => ({
          question: q.title,
          options: q.options,
        })),
      },
    });
    // Some builds disclose delivery/questions only in the final snapshot.
    // Retire any provisional duplicate prose while keeping its durable id.
    if (this.emittedMessageText.has(item.id))
      this.emitMessageDelta(item.id, false, "", "commentary");
    this.onAsyncQuestion?.({
      sessionId: this.sessionId,
      questionId: toolCallId,
      nativeRequestId: `async:${this.turnPrefix}:${item.id}`,
      toolCallId,
      source: "native_dialog",
      blocking: false,
      questions: questions.map((question, index) => ({
        id: `q${index}`,
        prompt: question.title,
        multiSelect: false,
        allowOther: true,
        options: (question.options ?? []).map((label, option) => ({
          id: `option-${option}`,
          label,
        })),
        ...(question.options?.length ? { defaultOptionIds: ["option-0"] } : {}),
      })),
    });
    return true;
  }

  private onReasoningSnapshot(
    item: Extract<ThreadItemUnion, { type: "reasoning" }>,
  ): void {
    const summary = item.summary?.filter((part) => typeof part === "string");
    const content = item.content
      ?.filter((part) => typeof part === "string")
      .join("\n\n");
    const text =
      (summary?.some((part) => part.length > 0) ? summary.join("\n\n") : "") ||
      content ||
      item.text;
    if (!text) return;
    // A replay can start with a populated snapshot. Subsequent deltas extend
    // those same indexed parts rather than replacing them with only the tail.
    this.reasoningParts.set(item.id, {
      summary: new Map(
        Array.from((item.summary ?? []).entries()).filter(
          ([, value]) => typeof value === "string",
        ),
      ),
      content: new Map(
        Array.from(
          (item.content ?? (item.text ? [item.text] : [])).entries(),
        ).filter(([, value]) => typeof value === "string"),
      ),
    });
    this.emitMessageDelta(item.id, true, text);
  }

  private onToolOutputDelta(params: unknown, method: string): void {
    const p = params as { itemId?: string; delta?: string; output?: string };
    if (typeof p?.itemId !== "string") return;
    if (this.completedItemIds.has(p.itemId)) return;
    const toolCallId = this.toolCallIds.get(p.itemId);
    if (!toolCallId) return;
    // terminalInteraction reports what Codex wrote to stdin, not command
    // output. It is a lifecycle beat and must not pollute the visible log.
    if (method === "item/commandExecution/terminalInteraction") return;
    // The two payload shapes are NOT interchangeable, and the field name is
    // the only thing that distinguishes them. `delta` is an increment and must
    // be appended; `output` names a whole-log snapshot and must REPLACE, or
    // each notification re-glues everything already shown ("abc" →
    // "abcabcdef"). Every method wired above carries `delta` in the pinned
    // 0.146 schema, so the snapshot arm is a guard against a future/legacy
    // shape rather than a live path — which is exactly why it must not
    // silently inherit append semantics.
    const previous = this.emittedToolOutput.get(p.itemId) ?? "";
    let text: string;
    if (typeof p.delta === "string" && p.delta) {
      if (previous.length >= MAX_STREAMED_TOOL_OUTPUT_CHARS) return;
      text = (previous + p.delta).slice(0, MAX_STREAMED_TOOL_OUTPUT_CHARS);
    } else if (typeof p.output === "string" && p.output) {
      text = p.output.slice(0, MAX_STREAMED_TOOL_OUTPUT_CHARS);
      // A capped snapshot repeats its first N chars forever; re-emitting an
      // identical rawOutput would churn the timeline for no visible change.
      if (text === previous) return;
    } else {
      return;
    }
    this.emittedToolOutput.set(p.itemId, text);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        rawOutput: text,
      },
    });
  }

  private onFilePatchUpdated(params: unknown): void {
    const p = params as {
      itemId?: string;
      changes?: Extract<ThreadItemUnion, { type: "fileChange" }>["changes"];
    };
    if (typeof p?.itemId !== "string") return;
    if (this.completedItemIds.has(p.itemId)) return;
    if (!Array.isArray(p.changes)) return;
    const toolCallId = this.toolCallIds.get(p.itemId);
    if (!toolCallId) return;
    const item = { type: "fileChange" as const, id: p.itemId, changes: p.changes };
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        title: describeItem(item),
        rawInput: toolInput(item),
      },
    });
  }

  private onMcpToolCallProgress(params: unknown): void {
    const p = params as { itemId?: string; message?: string };
    if (typeof p.itemId !== "string" || typeof p.message !== "string") return;
    if (this.completedItemIds.has(p.itemId)) return;
    const progress = { progress: truncate(p.message, 2_000) };
    const existingToolCallId = this.toolCallIds.get(p.itemId);
    if (existingToolCallId && this.emittedToolCallIds.has(existingToolCallId)) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: existingToolCallId,
          status: "in_progress",
          rawOutput: progress,
        },
      });
      return;
    }

    const toolCallId = existingToolCallId ?? this.ensureToolCallId(p.itemId);
    this.emitToolCallUpsert(toolCallId, {
      nativeToolCallId: p.itemId,
      title: "MCP tool",
      kind: "mcp",
      status: "in_progress",
      rawOutput: progress,
    });
  }

  private onHookLifecycle(params: unknown, completed: boolean): void {
    const p = params as {
      run?: {
        id?: string;
        eventName?: string;
        status?: string;
        statusMessage?: string | null;
      };
    };
    if (typeof p.run?.id !== "string") return;
    const toolCallId = this.ensureToolCallId(`hook:${p.run.id}`);
    const eventName =
      typeof p.run.eventName === "string"
        ? truncate(p.run.eventName, 120)
        : "workflow";
    const failed = p.run.status === "failed" || p.run.status === "blocked";
    this.emitToolCallUpsert(toolCallId, {
      title: `Hook · ${eventName}`,
      kind: "other",
      status: completed ? (failed ? "failed" : "completed") : "in_progress",
      rawInput: { eventName },
      ...(completed
        ? {
            rawOutput: {
              status:
                typeof p.run.status === "string"
                  ? truncate(p.run.status, 80)
                  : "completed",
              ...(typeof p.run.statusMessage === "string"
                ? { message: truncate(p.run.statusMessage, 2_000) }
                : {}),
            },
          }
        : {}),
    });
  }

  private onModelRerouted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      fromModel?: string;
      toModel?: string;
      reason?: string;
    };
    if (typeof p.toModel !== "string" || !p.toModel.trim() || p.toModel.length > 200 || (/\s/.test(p.toModel) || [...p.toModel].some((char) => char.charCodeAt(0) < 32))) return;
    const key = JSON.stringify([p.threadId, p.turnId, p.fromModel, p.toModel, p.reason]);
    if (this.modelFallbacks.has(key)) return;
    this.modelFallbacks.add(key);
    if (this.modelFallbacks.size > 2_000) this.modelFallbacks.delete(this.modelFallbacks.values().next().value!);
    const noticeId = randomUUID();
    if (!this.parentToolId) this.unparentedIds.add(`model-fallback-${noticeId}`);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "model_fallback", noticeId, provider: "codex",
        fromModel: typeof p.fromModel === "string" ? truncate(p.fromModel, 160) : null,
        toModel: p.toModel,
        scope: this.isChild ? "local" : "session",
        reason: p.reason === "highRiskCyberActivity" ? "cybersecurity" : "unknown",
      },
    });
  }

  private onModelVerification(params: unknown): void {
    const raw = (params as { verifications?: unknown }).verifications;
    if (!Array.isArray(raw)) return;
    const verifications = raw
      .filter((value): value is string => typeof value === "string")
      .slice(0, 20)
      .map((value) => truncate(value, 160));
    if (verifications.length === 0) return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `model-verification-${randomUUID()}`,
        title: "Model verification",
        kind: "other",
        status: "completed",
        rawOutput: { verifications },
      },
    });
  }

  private onSafetyBuffering(params: unknown): void {
    const p = params as {
      model?: string;
      showBufferingUi?: boolean;
      reasons?: unknown;
    };
    if (p.showBufferingUi !== true) return;
    const reasons = Array.isArray(p.reasons)
      ? p.reasons
          .filter((value): value is string => typeof value === "string")
          .slice(0, 8)
          .map((value) => truncate(value, 240))
      : [];
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-safety-buffer-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code: "model_safety_buffering",
        message: `Codex is verifying this response${
          typeof p.model === "string" ? ` with ${truncate(p.model, 160)}` : ""
        }${reasons.length > 0 ? `: ${reasons.join(", ")}` : "."}`,
      },
    });
  }

  private onEnvironmentConnection(params: unknown, connected: boolean): void {
    const environmentId = (params as { environmentId?: unknown }).environmentId;
    if (typeof environmentId !== "string") return;
    const toolCallId = this.ensureToolCallId(`environment:${environmentId}`);
    this.emitToolCallUpsert(toolCallId, {
      title: connected ? "Environment connected" : "Environment disconnected",
      kind: "other",
      status: "completed",
      rawOutput: {
        environment: truncate(environmentId, 160),
        state: connected ? "connected" : "disconnected",
      },
    });
  }

  private onExternalConfigImport(params: unknown, completed: boolean): void {
    const p = params as { importId?: string; itemTypeResults?: unknown };
    if (typeof p.importId !== "string") return;
    const results = Array.isArray(p.itemTypeResults)
      ? p.itemTypeResults.slice(0, 32).map((value) => {
          const result =
            value && typeof value === "object"
              ? (value as Record<string, unknown>)
              : {};
          return {
            itemType:
              typeof result.itemType === "string"
                ? truncate(result.itemType, 120)
                : "item",
            successes: Array.isArray(result.successes)
              ? result.successes.length
              : 0,
            failures: Array.isArray(result.failures)
              ? result.failures.length
              : 0,
          };
        })
      : [];
    const toolCallId = this.ensureToolCallId(`external-import:${p.importId}`);
    this.emitToolCallUpsert(toolCallId, {
      title: "Import agent configuration",
      kind: "other",
      status: completed ? "completed" : "in_progress",
      rawInput: { importId: truncate(p.importId, 160) },
      rawOutput: { results },
    });
  }

  private onMcpOauthCompleted(params: unknown): void {
    const p = params as { name?: string; success?: boolean };
    if (typeof p.name !== "string" || p.success === true) return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-mcp-oauth-${this.noticeSeq++}`,
        severity: "error",
        recoverable: true,
        code: "mcp_oauth_failed",
        // Provider error strings may contain callback URLs, local paths, or
        // credential-shaped values. The app-server log retains diagnostics;
        // the product row carries only bounded status.
        message: `${truncate(p.name, 120)} MCP sign-in failed.`,
      },
    });
  }

  private onSafetyReview(params: unknown, completed: boolean): void {
    const p = params as {
      reviewId?: string;
      review?: {
        status?: string;
        rationale?: string | null;
        riskLevel?: string | null;
      };
      action?: { type?: string };
      zerosRetryId?: string;
    };
    if (typeof p.reviewId !== "string") return;
    if (!completed && this.completedSafetyReviewIds.has(p.reviewId)) return;
    if (completed) {
      if (this.completedSafetyReviewIds.has(p.reviewId)) return;
      this.completedSafetyReviewIds.add(p.reviewId);
      while (this.completedSafetyReviewIds.size > 100) {
        const oldest = this.completedSafetyReviewIds.values().next().value;
        if (typeof oldest !== "string") break;
        this.completedSafetyReviewIds.delete(oldest);
      }
    }
    const toolCallId = this.ensureToolCallId(`safety:${p.reviewId}`);
    const status =
      typeof p.review?.status === "string" ? p.review.status : "inProgress";
    const retryId =
      typeof p.zerosRetryId === "string" ? p.zerosRetryId : undefined;
    if (retryId) this.safetyReviewToolCalls.set(retryId, toolCallId);
    this.emitToolCallUpsert(toolCallId, {
      title: completed ? "Safety review" : "Reviewing action safety",
      kind: "other",
      status: completed ? "completed" : "in_progress",
      rawInput: {
        actionType:
          typeof p.action?.type === "string" ? p.action.type : "action",
      },
      rawOutput: {
        zerosSafetyReview: {
          status,
          actionType:
            typeof p.action?.type === "string" ? p.action.type : "action",
          ...(typeof p.review?.riskLevel === "string"
            ? { riskLevel: truncate(p.review.riskLevel, 80) }
            : {}),
          ...(typeof p.review?.rationale === "string"
            ? { rationale: truncate(p.review.rationale, 2_000) }
            : {}),
        },
      },
    });
    if (retryId) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "safety_review_retry_available",
          toolCallId,
          retryId,
        },
      });
    }
  }

  private onStrictReviewRequired(params: unknown): void {
    const p = params as { turnId?: string };
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-strict-review-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code: "strict_safety_review",
        message: p.turnId
          ? "Codex requires an explicit safety review before continuing."
          : "A safety review is required before continuing.",
      },
    });
  }

  private onError(params: unknown): void {
    const p = params as {
      error?: { codexErrorInfo?: unknown; message?: string };
      willRetry?: boolean;
    };
    const willRetry = p?.willRetry === true;
    const cls = classifyCodexErrorInfo(p?.error?.codexErrorInfo);
    if (willRetry) {
      // Codex will retry the SAME turn itself — the turn is alive, nothing is
      // lost. Surface ONE api_retry notice per burst (parity with Claude's
      // system/api_retry): while it's the streaming tail the renderer shows
      // the shimmering "Reconnecting agent" row; the technical detail stays
      // inspectable via expand once it settles.
      if (this.retryBurstNoticed) return;
      this.retryBurstNoticed = true;
      // Simple copy by design (UI-indication consolidation 2026-07-10) —
      // codex's own retry detail ("Reconnecting… 2/5") is noise to the user.
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "error_notice",
          noticeId: `${this.turnPrefix}-retry-${this.noticeSeq++}`,
          severity: "warning",
          recoverable: true,
          code: "api_retry",
          message: "Temporary connection problem — retrying automatically…",
        } as never,
      });
      return;
    }
    this.hasSeenTurnTerminal = true;
    this.turnNativeFailure = normalizeProviderError("codex", p?.error ?? { message: cls.label });
    this.turnFailureLabel = this.turnNativeFailure.category === "auth-required" ? cls.label : null;
    this.turnRateLimitLabel = this.turnNativeFailure.category === "rate-limited" ? cls.label : null;
    this.lastStopReason = cls.stopReason;

    const message = this.turnNativeFailure.message;
    this.turnErrorMessage = message || null;
    if (!message) return;
    // One compact error_notice row per real terminal error. Retry attempts
    // (`willRetry:true`) are internal recovery noise and are filtered above.
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-error-${this.noticeSeq++}`,
        severity: "error",
        message: `Codex: ${message}`,
      } as never,
    });
  }

  private onAdvisory(params: unknown, method: string): void {
    const p = params as { message?: string; reason?: string };
    const text = p?.message ?? p?.reason;
    if (!text || typeof text !== "string") return;
    if (isRecoveringTransportAdvisory(text)) return;
    const tag =
      method === "deprecationNotice"
        ? "Deprecation"
        : method === "configWarning"
          ? "Config"
          : "Warning";
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-${method}-${this.noticeSeq++}`,
        severity: "warning",
        message: `${tag}: ${text}`,
      } as never,
    });
  }

  // ── Helpers ─────────────────────────────────────────────

  private enrichArtwork(
    item: Extract<ThreadItemUnion, { type: "mcpToolCall" }>,
    toolCallId: string,
  ): void {
    if (!this.resolveArtwork) return;
    const request = Symbol();
    this.artworkRequests.set(toolCallId, request);
    while (this.artworkRequests.size > 1024)
      this.artworkRequests.delete(this.artworkRequests.keys().next().value!);
    void this.resolveArtwork(item)
      .then((artwork) => {
        if (this.artworkRequests.get(toolCallId) !== request) return;
        this.artworkRequests.delete(toolCallId);
        if (!artwork) return;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            rawInput: {
              ...recordValue(toolInput(item)),
              _zerosToolArtwork: artwork,
            },
          },
        });
      })
      .catch(() => {
        if (this.artworkRequests.get(toolCallId) === request)
          this.artworkRequests.delete(toolCallId);
      });
  }

  private ensureToolCallId(itemId: string): string {
    const cached = this.toolCallIds.get(itemId);
    if (cached) return cached;
    const id = randomUUID();
    this.toolCallIds.set(itemId, id);
    return id;
  }

  private emitToolCallUpsert(
    toolCallId: string,
    fields: Record<string, unknown>,
  ): void {
    const firstEmit = !this.emittedToolCallIds.has(toolCallId);
    if (firstEmit) this.emittedToolCallIds.add(toolCallId);
    this.emit({
      sessionId: this.sessionId,
      update: {
        ...fields,
        sessionUpdate: firstEmit ? "tool_call" : "tool_call_update",
        toolCallId,
      } as never,
    });
  }

  private emitMessageDelta(
    itemId: string,
    isThought: boolean,
    fullText: string,
    phase?: "commentary" | "final_answer",
  ): void {
    const already = this.emittedMessageText.get(itemId) ?? "";
    if (fullText === already) {
      if (
        !isThought &&
        already.length > 0 &&
        phase &&
        this.emittedMessagePhases.get(itemId) !== phase
      ) {
        this.emittedMessagePhases.set(itemId, phase);
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "" } as ContentBlock,
            messageId: `${this.turnPrefix}-${itemId}`,
            phase,
          },
        });
      }
      return;
    }
    const replace = !fullText.startsWith(already);
    const delta = replace ? fullText : fullText.slice(already.length);
    if (!delta && !replace) return;
    this.emittedMessageText.set(itemId, fullText);
    if (!isThought && phase) this.emittedMessagePhases.set(itemId, phase);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: isThought
          ? "agent_thought_chunk"
          : "agent_message_chunk",
        content: { type: "text", text: delta } as ContentBlock,
        messageId: `${this.turnPrefix}-${itemId}`,
        ...(!isThought && phase ? { phase } : {}),
        ...(replace ? { textMode: "replace" as const } : {}),
      },
    });
  }

  /** For delta events, accumulate the running total before re-emitting
   *  through emitMessageDelta (which reconciles the full text snapshot). */
  private appendDelta(itemId: string, delta: string): string {
    const prev = this.emittedMessageText.get(itemId) ?? "";
    return prev + delta;
  }
}

// ── Item-shape unions + helpers ──────────────────────────────

/** Codex's best-effort parse of a shell command into the action(s) it
 *  performs (generated `CommandAction`). The app-server attaches this to every
 *  `commandExecution` item "for friendly display" — it's the SAME parse
 *  the UI renders as Read / Grep / List cards. A single command can
 *  yield several actions when piped together. */
type CommandActionLite =
  | { type: "read"; command?: string; name?: string; path?: string }
  | { type: "listFiles"; command?: string; path?: string | null }
  | {
      type: "search";
      command?: string;
      query?: string | null;
      path?: string | null;
    }
  | { type: "unknown"; command?: string };

type ThreadItemUnion =
  | SubagentActivityItem
  | { type: "userMessage"; id: string; content?: unknown[] }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase?: "commentary" | "final_answer" | null;
      delivery?: "async" | null;
      questions?: AsyncUserInputQuestion[] | null;
    }
  | { type: "reasoning"; id: string; text?: string; summary?: string[]; content?: string[] }
  | { type: "plan"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: string;
      status?: string;
      exitCode?: number | null;
      aggregatedOutput?: string | null;
      durationMs?: number | null;
      commandActions?: CommandActionLite[];
    }
  | {
      type: "fileChange";
      id: string;
      changes?: Array<{ path?: string }>;
      status?: string;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      arguments?: unknown;
      pluginId?: string | null;
      appContext?: {
        connectorId?: string;
        appName?: string | null;
        actionName?: string | null;
      } | null;
      result?: unknown;
      error?: unknown;
      status?: string;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      namespace?: string | null;
      tool: string;
      arguments?: unknown;
      contentItems?: unknown;
      success?: boolean | null;
      status?: string;
    }
  | CollabItem
  | { type: "webSearch"; id: string; query?: string; action?: WebSearchAction | null; results?: unknown[] | null }
  | { type: "imageView"; id: string; path?: string }
  | ({ type: "imageGeneration"; id: string } & Partial<ImageGenerationItem>)
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

type SubagentActivityItem = Extract<
  import("./generated/v2/ThreadItem").ThreadItem,
  { type: "subAgentActivity" }
>;

function asyncQuestions(item: Extract<ThreadItemUnion, { type: "agentMessage" }>): AsyncUserInputQuestion[] {
  if (item.delivery !== "async" || !Array.isArray(item.questions)) return [];
  return item.questions.filter((question) => typeof question?.title === "string" && question.title.trim()).map((question) => ({
    title: question.title,
    options: Array.isArray(question.options) ? question.options.filter((option) => typeof option === "string" && option.trim()) : null,
  }));
}

/** Generated `collabAgentToolCall` ThreadItem — one row per collab-tool
 *  invocation (including spawn, messaging, wait, resume, interrupt, and
 *  close). `receiverThreadIds` are the target subagent
 *  thread(s); `agentsStates` is their last known status at completion. */
type CollabItem = {
  type: "collabAgentToolCall";
  id: string;
  tool: string;
  status?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentsStates?: Record<
    string,
    { status?: string; message?: string | null } | undefined
  >;
};

/** Human title + tool kind for a collab item. spawnAgent's title stays
 *  "spawnAgent" on purpose — the SubagentCard's matcher recognizes that
 *  vocabulary and swaps the visible header for the prompt excerpt, so the
 *  row reads "Agent <task…>" like Claude's Task does. */
function describeCollabTool(item: CollabItem): {
  kind: ToolKind;
  title: string;
} {
  const receivers = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((r): r is string => typeof r === "string")
    : [];
  const target =
    receivers.length > 1
      ? `${receivers.length} agents`
      : receivers[0]
        ? `agent ${receivers[0].slice(0, 8)}`
        : "agent";
  switch (item.tool) {
    case "spawnAgent":
      return { kind: "subagent", title: "spawnAgent" };
    case "wait":
      return { kind: "other", title: `Waiting for ${target}` };
    case "sendInput":
      return { kind: "other", title: `Sending input to ${target}` };
    case "sendMessage":
      return { kind: "other", title: `Messaging ${target}` };
    case "followupTask":
      return { kind: "other", title: `Following up with ${target}` };
    case "interruptAgent":
      return { kind: "other", title: `Interrupting ${target}` };
    case "listAgents":
      return { kind: "other", title: "Listing agents" };
    case "resumeAgent":
      return { kind: "other", title: `Resuming ${target}` };
    case "closeAgent":
      return { kind: "other", title: `Closing ${target}` };
    default:
      return { kind: "other", title: item.tool || "collab" };
  }
}

function describeItem(item: ThreadItemUnion): string {
  switch (item.type) {
    case "commandExecution":
      return `Running ${truncate(item.command ?? "", 60) || "shell command"}`;
    case "fileChange": {
      const paths = fileChangePaths(item);
      if (paths.length === 1) return `Editing ${paths[0]}`;
      return paths.length > 1
        ? `Editing ${paths.length} files`
        : "Editing files";
    }
    case "mcpToolCall":
      return nativeNodeReplTitle(item) ?? `${item.server}:${item.tool}`;
    case "dynamicToolCall":
      return item.namespace
        ? `${item.namespace}/${item.tool || "tool"}`
        : item.tool || "tool";
    case "webSearch":
      return item.action?.type === "open_page"
        ? "Open web page"
        : item.action?.type === "find_in_page"
          ? "Find in web page"
          : `Searching ${truncate(item.query || "web", 40)}`;
    case "imageView":
      return "Read image";
    case "imageGeneration":
      return `Generating image`;
    case "contextCompaction":
      // The running label. onItemCompleted relabels the
      // row to "Context compacted" when the item settles.
      return `Compacting..`;
    default:
      return (item as { type: string }).type || "tool";
  }
}

function nativeNodeReplTitle(
  item: Extract<ThreadItemUnion, { type: "mcpToolCall" }>,
): string | null {
  if (!["node_repl", "cua_repl"].includes(item.server) || item.tool !== "js")
    return null;
  const args =
    item.arguments &&
    typeof item.arguments === "object" &&
    !Array.isArray(item.arguments)
      ? (item.arguments as Record<string, unknown>)
      : {};
  const title = typeof args.title === "string" ? args.title.trim() : "";
  return title ? truncate(title.replace(/\s+/g, " "), 160) : null;
}

/** Map codex's `commandActions` parse onto a friendlier tool kind + display
 *  shape, so a shell `cat`/`rg`/`ls` renders as a Read / Grep / List card the
 *  same way the Claude adapter does. Returns null — meaning "render as a generic
 *  Bash execution" — unless the WHOLE command maps cleanly to a single
 *  recognized action type. A compound/mixed command (e.g. `pwd && rg --files`,
 *  where `pwd` parses as `unknown`) deliberately stays a Bash row rather than
 *  guessing. The chosen `rawInput` field names match what `event-meta.ts`
 *  reads per kind (read→file_path, search→query, list→path). */
function summarizeCommandActions(
  item: Extract<ThreadItemUnion, { type: "commandExecution" }>,
): { kind: ToolKind; title: string; rawInput: unknown } | null {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (actions.length === 0) return null;
  // Any unrecognized fragment (or mixed action types) → keep it a Bash card.
  if (actions.some((a) => !a || a.type === "unknown")) return null;
  const types = new Set(actions.map((a) => a.type));
  if (types.size !== 1) return null;
  if (actions.length > 1 && actions.every((action) => action.type === "read") &&
      new Set(actions.map((action) => action.path ?? action.name)).size > 1) return null;

  const cmd = item.command ?? "";
  const first = actions[0];
  switch (first.type) {
    case "read": {
      // codex's `name` is the display basename ("README.md"); `path` is the
      // absolute fallback (the renderer shortens it).
      const name = pickStr(first.path, first.name);
      return {
        kind: "read",
        title: name ? `Read ${name}` : "Read",
        rawInput: { ...recordValue(toolInput(item)), file_path: name ?? "", command: cmd },
      };
    }
    case "search": {
      // Multiple piped greps collapse to the first query; carry the dir hint.
      const query = pickStr(first.query);
      const path = pickStr(first.path);
      return {
        kind: "search",
        title: query ? `Grep ${query}` : "Grep",
        rawInput: { ...recordValue(toolInput(item)), query: query ?? "", path: path ?? "", command: cmd },
      };
    }
    case "listFiles": {
      const path = pickStr(first.path);
      return {
        kind: "list",
        title: path ? `List ${path}` : "List files",
        rawInput: { ...recordValue(toolInput(item)), path: path ?? "", command: cmd },
      };
    }
    default:
      return null;
  }
}

function pickStr(...values: Array<string | null | undefined>): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function mapItemKind(type: ThreadItemUnion["type"]): ToolKind {
  switch (type) {
    case "commandExecution":
      return "execute";
    case "fileChange":
      return "edit";
    case "mcpToolCall":
      return "mcp";
    case "dynamicToolCall":
      return "other";
    case "webSearch":
      return "web_search";
    case "imageView":
      return "read";
    case "imageGeneration":
      return "other";
    case "contextCompaction":
      return "compaction";
    default:
      return "other";
  }
}

function isRecoveringTransportAdvisory(text: string): boolean {
  return /falling back from websockets to https transport/i.test(text);
}

function computeMergeKey(item: ThreadItemUnion): string | null {
  if (item.type !== "fileChange") return null;
  const paths = fileChangePaths(item);
  // A batch is one atomic provider tool call spanning several independent
  // files. Giving it the first file's merge key makes the whole batch look
  // like (and historically collapse with) a single-file edit.
  return paths.length === 1 ? `edit:${paths[0]}` : null;
}

function fileChangePaths(
  item: Extract<ThreadItemUnion, { type: "fileChange" }>,
): string[] {
  if (!Array.isArray(item.changes)) return [];
  return item.changes.flatMap((change) =>
    typeof change?.path === "string" ? [change.path] : [],
  );
}

function collabChildStatus(
  status?: string,
): "in_progress" | "completed" | "failed" {
  if (status === "completed") return "completed";
  if (["interrupted", "errored", "shutdown", "notFound"].includes(status ?? ""))
    return "failed";
  return "in_progress";
}

function computeStatus(item: ThreadItemUnion): "completed" | "failed" {
  if (["failed", "declined", "cancelled", "interrupted"].includes(String(recordValue(item).status))) return "failed";
  if (item.type === "imageGeneration" && item.failure) return "failed";
  if (item.type === "commandExecution") {
    if (typeof item.exitCode === "number" && item.exitCode !== 0)
      return "failed";
    if (item.status === "failed" || item.status === "cancelled")
      return "failed";
    return "completed";
  }
  if (item.type === "fileChange") {
    return item.status === "failed" ? "failed" : "completed";
  }
  if (item.type === "mcpToolCall") {
    return item.error ||
      item.status === "failed" ||
      recordValue(item.result).isError === true ||
      recordValue(recordValue(item.result).raw).isError === true ||
      nodeReplTimedOut(item)
      ? "failed"
      : "completed";
  }
  if (item.type === "dynamicToolCall") {
    return item.success === false ? "failed" : "completed";
  }
  if (item.type === "collabAgentToolCall") {
    return item.status === "failed" || item.status === "interrupted"
      ? "failed"
      : "completed";
  }
  return "completed";
}

/** OpenAI's node_repl reports a kernel-reset timeout as a successful MCP
 * transport response containing this canonical text. Treat the native
 * execution failure as failed for the chat row so it receives the red Browser
 * glyph instead of a misleading completed state. Other successful text remains
 * provider-owned and is never guessed from arbitrary prose. */
function nodeReplTimedOut(
  item: Extract<ThreadItemUnion, { type: "mcpToolCall" }>,
): boolean {
  if (!["node_repl", "cua_repl"].includes(item.server) || item.tool !== "js")
    return false;
  const result = recordValue(item.result);
  const raw = recordValue(result.raw);
  for (const envelope of [result, raw]) {
    if (!Array.isArray(envelope.content)) continue;
    for (const candidate of envelope.content) {
      const value = recordValue(candidate);
      if (
        typeof value.text === "string" &&
        /^js execution timed out; kernel reset(?:[,;.]|$)/i.test(
          value.text.trim(),
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toolInput(item: ThreadItemUnion): unknown {
  switch (item.type) {
    case "commandExecution":
      return {
        command: item.command,
        cwd: item.cwd,
        commandActions: item.commandActions,
      };
    case "fileChange":
      return { changes: item.changes };
    case "mcpToolCall":
      return {
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        ...(typeof item.pluginId === "string"
          ? { pluginId: item.pluginId.slice(0, 512) }
          : {}),
        ...(item.appContext
          ? {
              appContext: Object.fromEntries(
                ["connectorId", "appName", "actionName"].flatMap((key) => {
                  const value = recordValue(item.appContext)[key];
                  return typeof value === "string"
                    ? [[key, value.slice(0, 512)]]
                    : [];
                }),
              ),
            }
          : {}),
      };
    case "dynamicToolCall":
      return {
        namespace: item.namespace ?? null,
        tool: item.tool,
        arguments: item.arguments,
      };
    case "collabAgentToolCall":
      // `prompt` first — the SubagentCard reads it for both the header
      // excerpt and the expandable Prompt block.
      return {
        prompt: item.prompt ?? undefined,
        tool: item.tool,
        receiverThreadIds: item.receiverThreadIds,
        senderThreadId: item.senderThreadId,
        model: item.model ?? undefined,
        reasoningEffort: item.reasoningEffort ?? undefined,
      };
    case "webSearch":
      return { query: item.query, action: item.action };
    case "imageView":
      return { path: item.path };
    case "imageGeneration":
      return {
        revisedPrompt: item.revisedPrompt,
        transparentBackground: item.transparentBackground,
      };
    default:
      return item;
  }
}

function toolOutput(item: ThreadItemUnion, streamedOutput?: string): unknown {
  if (item.type === "commandExecution") {
    return {
      exitCode: item.exitCode,
      output: item.aggregatedOutput,
      status: item.status,
      durationMs: item.durationMs,
    };
  }
  if (item.type === "mcpToolCall") {
    return item.result ?? item.error ?? null;
  }
  if (item.type === "dynamicToolCall") {
    return item.contentItems ?? null;
  }
  if (item.type === "collabAgentToolCall") {
    // Last known state of the target agent(s) — status + final message.
    return item.agentsStates ?? null;
  }
  if (item.type === "imageGeneration")
    return {
      status: item.status,
      failure: item.failure,
      savedPath: item.savedPath,
    };
  if (item.type === "webSearch") return { results: item.results ?? null };
  if (item.type === "fileChange")
    return {
      status: item.status,
      ...(streamedOutput !== undefined ? { output: streamedOutput } : {}),
    };
  return null;
}

function imageGenerationContent(
  item: Extract<ThreadItemUnion, { type: "imageGeneration" }>,
): ToolCallContent[] | null {
  const result = item.result;
  if (!result || result.length > 16 * 1024 * 1024) return null;
  // Native image generation supplies PNG base64; data URLs and links use the
  // same validated media conversion as dynamic tools. Never dump binary JSON.
  const content = /^[A-Za-z0-9+/]+={0,2}$/.test(result)
    ? { type: "image" as const, mimeType: "image/png", data: result }
    : dynamicMediaContent(result, "image");
  return content ? [{ type: "content", content }] : null;
}

/** Preserve MCP's readable and media content in the shared transcript contract. */
function mcpToolContent(
  item: Extract<ThreadItemUnion, { type: "mcpToolCall" }>,
): ToolCallContent[] | null {
  const result = recordValue(item.result);
  const content = result.content ?? recordValue(result.raw).content;
  if (!Array.isArray(content)) return null;
  const blocks: ToolCallContent[] = [];
  for (const candidate of content.slice(0, 128)) {
    const value = recordValue(candidate);
    if (value.type === "text" && typeof value.text === "string") {
      blocks.push({
        type: "content",
        content: { type: "text", text: value.text },
      });
    } else if (
      (value.type === "image" || value.type === "audio") &&
      typeof value.data === "string" &&
      typeof value.mimeType === "string" &&
      value.mimeType.startsWith(`${value.type}/`) &&
      value.data.length <= 16 * 1024 * 1024 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
    ) {
      blocks.push({
        type: "content",
        content: {
          type: value.type,
          mimeType: value.mimeType,
          data: value.data,
        },
      });
    } else if (
      value.type === "resource_link" &&
      typeof value.uri === "string"
    ) {
      blocks.push({
        type: "content",
        content: {
          type: "resource_link",
          uri: value.uri,
          name: typeof value.name === "string" ? value.name : value.uri,
          ...(typeof value.description === "string"
            ? { description: value.description }
            : {}),
          ...(typeof value.title === "string" ? { title: value.title } : {}),
          ...(typeof value.mimeType === "string"
            ? { mimeType: value.mimeType }
            : {}),
          ...(typeof value.size === "number" ? { size: value.size } : {}),
        },
      });
    } else if (value.type === "resource") {
      const resource = recordValue(value.resource);
      if (typeof resource.uri !== "string") continue;
      if (typeof resource.text === "string") {
        blocks.push({
          type: "content",
          content: {
            type: "resource",
            resource: {
              uri: resource.uri,
              text: resource.text,
              ...(typeof resource.mimeType === "string"
                ? { mimeType: resource.mimeType }
                : {}),
            },
          },
        });
      } else {
        // Binary resources remain inspectable by identity without copying their
        // bytes into another durable presentation field.
        blocks.push({
          type: "content",
          content: {
            type: "resource_link",
            uri: resource.uri,
            name: resource.uri,
            ...(typeof resource.mimeType === "string"
              ? { mimeType: resource.mimeType }
              : {}),
          },
        });
      }
    }
  }
  return blocks.length ? blocks : null;
}

/** Convert Responses-compatible dynamic-tool output into Zeros-owned content
 * blocks. The mapping is provider-neutral: browser, workspace, or future tools
 * all persist through the same canonical transcript contract. */
function dynamicToolContent(
  item: Extract<ThreadItemUnion, { type: "dynamicToolCall" }>,
): ToolCallContent[] | null {
  if (!Array.isArray(item.contentItems)) return null;
  const content: ToolCallContent[] = [];
  for (const candidate of item.contentItems) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Record<string, unknown>;
    if (value.type === "inputText" && typeof value.text === "string") {
      content.push({
        type: "content",
        content: { type: "text", text: value.text },
      });
      continue;
    }
    if (value.type === "inputImage") {
      const block =
        typeof value.imageUrl === "string"
          ? dynamicMediaContent(value.imageUrl, "image")
          : null;
      content.push({
        type: "content",
        content: block ?? unrenderableDynamicMedia("image"),
      });
      continue;
    }
    if (value.type === "inputAudio") {
      const block =
        typeof value.audioUrl === "string"
          ? dynamicMediaContent(value.audioUrl, "audio")
          : null;
      content.push({
        type: "content",
        content: block ?? unrenderableDynamicMedia("audio"),
      });
    }
  }
  return content.length > 0 ? content : null;
}

function unrenderableDynamicMedia(kind: "image" | "audio"): ContentBlock {
  return {
    type: "text",
    text: `Dynamic tool ${kind} output could not be rendered.`,
  };
}

function dynamicMediaContent(
  uri: string,
  kind: "image" | "audio",
): ContentBlock | null {
  const data = /^data:([^;,]+)(?:;[^,]*)?;base64,([a-z0-9+/=]+)$/i.exec(uri);
  if (data) {
    const mimeType = data[1]!;
    if (!mimeType.toLowerCase().startsWith(`${kind}/`)) return null;
    return kind === "image"
      ? { type: "image", mimeType, data: data[2]! }
      : { type: "audio", mimeType, data: data[2]! };
  }
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return {
      type: "resource_link",
      uri: parsed.href,
      name: `Dynamic tool ${kind}`,
    };
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Classify a generated `CodexErrorInfo` (string literal OR tagged object,
 *  e.g. "unauthorized" / "usageLimitExceeded" / { httpConnectionFailed }).
 * Returns only the legacy stop reason/label. Native failure classification
 * belongs to the shared provider-error normalizer. */
function classifyCodexErrorInfo(info: unknown): {
  stopReason: "end_turn" | "max_turn_requests";
  label: string;
} {
  const tagged = info && typeof info === "object"
    ? info as Record<string, unknown>
    : null;
  const tag = typeof info === "string"
    ? info
    : tagged ? Object.keys(tagged)[0] ?? "" : "";
  const detail = tagged?.[tag];
  const status = detail && typeof detail === "object"
    ? (detail as Record<string, unknown>).httpStatusCode
    : undefined;
  const labels: Record<string, string> = {
    unauthorized: "Not signed in (unauthorized)",
    usageLimitExceeded: "Usage limit exceeded",
    rateLimitExceeded: "Rate limit exceeded",
    contextWindowExceeded: "Context window exceeded",
    serverOverloaded: "Server overloaded",
  };
  return {
    stopReason: tag === "contextWindowExceeded" ? "max_turn_requests" : "end_turn",
    label: typeof status === "number"
      ? `${tag || "Request"} (HTTP ${status})`
      : labels[tag] ?? (tag || "error"),
  };
}
