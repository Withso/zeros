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
//   account/updated            → captured externally by the adapter (not a UI event here)
//   account/rateLimits/updated → ditto
//
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";

import type { ToolCallContent } from "@zeros/protocol/agent-events";

import { isDevRuntime } from "../../../runtime";
import type { ContentBlock, SessionNotification, TurnUsage } from "../../types";

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
  emit: Emit;
  /** Called for any notification we don't have a mapping for — useful
   *  for diagnostics when codex ships a new event type. */
  onUnknown?: (method: string, params: unknown) => void;
}

/** Stateful translator — one instance per Zeros session. Holds the
 *  in-progress turn id, the tool-call id map for the current turn, and
 *  the delta-emission state for streaming agent messages. */
export class CodexAppServerTranslator {
  private readonly sessionId: string;
  private readonly emit: Emit;
  private readonly onUnknown?: (method: string, params: unknown) => void;

  /** Codex item.id → Zeros tool call id. One tool per item.id so we
   *  can correlate item/completed back to the originating tool_call. */
  private readonly toolCallIds = new Map<string, string>();
  private readonly emittedToolCallIds = new Set<string>();
  private readonly completedItemIds = new Set<string>();
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
  private turnRateLimitLabel: string | null = null;
  /** Per-turn token usage (tokenUsage.last) for analytics. */
  private lastTurnUsage: TurnUsage | undefined;

  constructor(opts: CodexAppServerTranslatorOptions) {
    this.sessionId = opts.sessionId;
    this.emit = opts.emit;
    this.onUnknown = opts.onUnknown;
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
    this.turnPrefix = randomUUID();
    this.toolCallIds.clear();
    this.emittedToolCallIds.clear();
    this.completedItemIds.clear();
    this.emittedMessageText.clear();
    this.emittedToolOutput.clear();
    this.hasSeenTurnTerminal = false;
    this.lastStopReason = "end_turn";
    this.turnFailureLabel = null;
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
      case "turn/started":
        // No event — turn boundary is implicit.
        break;
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
        this.onReasoningDelta(params);
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
        this.onMcpStartupStatus(params);
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
        error?: { codexErrorInfo?: unknown; message?: string };
      };
    };
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
      if (cls.authQuota) this.turnFailureLabel = cls.label;
      if (cls.rateLimited) this.turnRateLimitLabel = cls.label;
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
      tokenUsage?: {
        total?: { totalTokens?: number };
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
    // Capture this turn's usage (tokenUsage.last) for
    // PromptResponse.usage / $ai_generation. `total` is cumulative across
    // the thread, so `last` is the right per-turn figure.
    const last = p?.tokenUsage?.last;
    if (last) {
      this.lastTurnUsage = {
        inputTokens: last.inputTokens,
        outputTokens: last.outputTokens,
        cacheReadTokens: last.cachedInputTokens,
        reasoningTokens: last.reasoningOutputTokens,
      };
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

  private onItemStarted(params: unknown): void {
    const p = params as { item?: ThreadItemUnion };
    const item = p?.item;
    if (!item || typeof item.type !== "string") return;

    switch (item.type) {
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "userMessage":
        // Message-shaped items — we wait for delta events to stream
        // text. Just remember the id for later delta correlation.
        if (typeof (item as { text?: string }).text === "string") {
          this.emitMessageDelta(
            item.id,
            item.type === "reasoning",
            (item as { text: string }).text,
          );
        }
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
        return;
      }

      case "collabAgentToolCall": {
        // Codex multi-agent collaboration — the model coordinating subagent
        // threads (spawnAgent / sendInput / wait / resumeAgent / closeAgent).
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
    const item = p?.item;
    if (!item || typeof item.type !== "string") return;
    this.completedItemIds.add(item.id);
    this.emittedToolOutput.delete(item.id);

    switch (item.type) {
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "userMessage":
        if (typeof (item as { text?: string }).text === "string") {
          this.emitMessageDelta(
            item.id,
            item.type === "reasoning",
            (item as { text: string }).text,
          );
        }
        this.emittedMessageText.delete(item.id);
        return;

      case "enteredReviewMode":
      case "exitedReviewMode":
        return;

      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "dynamicToolCall":
      case "collabAgentToolCall":
      case "webSearch": {
        const toolCallId = this.toolCallIds.get(item.id);
        if (!toolCallId) return;
        const status = computeStatus(item);
        const output = toolOutput(item);
        // Surface the command's plain text output as a content block (not just
        // the `{exitCode, output}` rawOutput object). This lets the renderer
        // show clean output in the detail body AND derive the "N lines" count
        // for Read cards / the match grep heuristic from real text.
        const contentText =
          item.type === "commandExecution" &&
          typeof item.aggregatedOutput === "string"
            ? item.aggregatedOutput
            : typeof output === "string"
              ? output
              : "";
        const dynamicContent =
          item.type === "dynamicToolCall" ? dynamicToolContent(item) : null;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status,
            rawOutput: output,
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
        this.toolCallIds.delete(item.id);
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
        this.toolCallIds.delete(item.id);
        return;
      }

      default: {
        const toolCallId = this.toolCallIds.get(item.id);
        if (!toolCallId) return;
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "completed",
          },
        });
        this.toolCallIds.delete(item.id);
      }
    }
  }

  private onAgentMessageDelta(params: unknown): void {
    const p = params as { itemId?: string; delta?: string };
    if (typeof p?.itemId !== "string" || typeof p?.delta !== "string") return;
    this.emitMessageDelta(p.itemId, false, this.appendDelta(p.itemId, p.delta));
  }

  private onReasoningDelta(params: unknown): void {
    const p = params as { itemId?: string; delta?: string };
    if (typeof p?.itemId !== "string" || typeof p?.delta !== "string") return;
    this.emitMessageDelta(p.itemId, true, this.appendDelta(p.itemId, p.delta));
  }

  private onToolOutputDelta(params: unknown, method: string): void {
    const p = params as { itemId?: string; delta?: string; output?: string };
    if (typeof p?.itemId !== "string") return;
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
    const p = params as { itemId?: string };
    if (typeof p?.itemId !== "string") return;
    const toolCallId = this.toolCallIds.get(p.itemId);
    if (!toolCallId) return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        rawOutput: params ?? null,
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
      fromModel?: string;
      toModel?: string;
      reason?: string;
    };
    if (typeof p.toModel !== "string") return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `model-switch-${randomUUID()}`,
        title: "Model switched",
        kind: "model_switch",
        status: "completed",
        rawInput: {
          ...(typeof p.fromModel === "string"
            ? { fromModel: truncate(p.fromModel, 160) }
            : {}),
          toModel: truncate(p.toModel, 160),
          ...(typeof p.reason === "string"
            ? { reason: truncate(p.reason, 240) }
            : {}),
        },
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

  private onMcpStartupStatus(params: unknown): void {
    const p = params as { name?: string; status?: string };
    if (
      typeof p.name !== "string" ||
      typeof p.status !== "string" ||
      p.status === "ready" ||
      p.status === "starting"
    ) {
      return;
    }
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-mcp-status-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code: "mcp_startup_status",
        message: `${truncate(p.name, 120)} MCP is ${truncate(p.status, 80)}.`,
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
    if (cls.authQuota) this.turnFailureLabel = cls.label;
    if (cls.rateLimited) this.turnRateLimitLabel = cls.label;
    this.lastStopReason = cls.stopReason;

    const message = extractErrorMessage(p?.error?.message) || cls.label;
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
  ): void {
    const already = this.emittedMessageText.get(itemId) ?? "";
    if (fullText.length <= already.length) return;
    const delta = fullText.slice(already.length);
    if (!delta) return;
    this.emittedMessageText.set(itemId, fullText);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: isThought
          ? "agent_thought_chunk"
          : "agent_message_chunk",
        content: { type: "text", text: delta } as ContentBlock,
        messageId: `${this.turnPrefix}-${itemId}`,
      },
    });
  }

  /** For delta events, accumulate the running total before re-emitting
   *  through emitMessageDelta (which dedups by length). */
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
  | { type: "userMessage"; id: string; content?: unknown[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; text?: string }
  | { type: "plan"; id: string; text: string }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd?: string;
      status?: string;
      exitCode?: number | null;
      aggregatedOutput?: string | null;
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
  | { type: "webSearch"; id: string; query?: string }
  | { type: "imageView"; id: string; path?: string }
  | { type: "imageGeneration"; id: string; status?: string; result?: string }
  | { type: "enteredReviewMode"; id: string; review: string }
  | { type: "exitedReviewMode"; id: string; review: string }
  | { type: "contextCompaction"; id: string };

/** Generated `collabAgentToolCall` ThreadItem — one row per collab-tool
 *  invocation (CollabAgentTool = spawnAgent | sendInput | resumeAgent |
 *  wait | closeAgent). `receiverThreadIds` are the target subagent
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
      return `Searching ${truncate(item.query ?? "web", 40)}`;
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
  if (item.server !== "node_repl" || item.tool !== "js") return null;
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

  const cmd = item.command ?? "";
  const first = actions[0];
  switch (first.type) {
    case "read": {
      // codex's `name` is the display basename ("README.md"); `path` is the
      // absolute fallback (the renderer shortens it).
      const name = pickStr(first.name, first.path);
      return {
        kind: "read",
        title: name ? `Read ${name}` : "Read",
        rawInput: { file_path: name ?? "", command: cmd },
      };
    }
    case "search": {
      // Multiple piped greps collapse to the first query; carry the dir hint.
      const query = pickStr(first.query);
      const path = pickStr(first.path);
      return {
        kind: "search",
        title: query ? `Grep ${query}` : "Grep",
        rawInput: { query: query ?? "", path: path ?? "", command: cmd },
      };
    }
    case "listFiles": {
      const path = pickStr(first.path);
      return {
        kind: "list",
        title: path ? `List ${path}` : "List files",
        rawInput: { path: path ?? "", command: cmd },
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

function computeStatus(item: ThreadItemUnion): "completed" | "failed" {
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
    return item.error || item.status === "failed" || nodeReplTimedOut(item)
      ? "failed"
      : "completed";
  }
  if (item.type === "dynamicToolCall") {
    return item.success === false ? "failed" : "completed";
  }
  if (item.type === "collabAgentToolCall") {
    return item.status === "failed" ? "failed" : "completed";
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
  if (item.server !== "node_repl" || item.tool !== "js") return false;
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
      return { command: item.command, cwd: item.cwd };
    case "fileChange":
      return { changes: item.changes };
    case "mcpToolCall":
      return {
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
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
      return { query: item.query };
    case "imageView":
      return { path: item.path };
    case "imageGeneration":
      return { status: item.status };
    default:
      return item;
  }
}

function toolOutput(item: ThreadItemUnion): unknown {
  if (item.type === "commandExecution") {
    return { exitCode: item.exitCode, output: item.aggregatedOutput };
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
  if (item.type === "imageGeneration" && typeof item.result === "string") {
    return item.result;
  }
  return null;
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
 *  Returns the stop reason + whether it's an auth/quota class the adapter
 *  should surface as an AgentFailure, plus a human label. */
function classifyCodexErrorInfo(info: unknown): {
  authQuota: boolean;
  rateLimited: boolean;
  stopReason: "end_turn" | "max_turn_requests" | "refusal" | "cancelled";
  label: string;
} {
  const tagged =
    info && typeof info === "object" ? (info as Record<string, unknown>) : null;
  const tag =
    typeof info === "string"
      ? info
      : tagged
        ? (Object.keys(tagged)[0] ?? "")
        : "";
  const detail = tagged?.[tag];
  const httpStatusCode =
    detail && typeof detail === "object"
      ? (detail as Record<string, unknown>).httpStatusCode
      : undefined;
  if (httpStatusCode === 429) {
    return {
      authQuota: false,
      rateLimited: true,
      stopReason: "end_turn",
      label: `${tag || "Request"} (HTTP 429)`,
    };
  }
  if (httpStatusCode === 401 || httpStatusCode === 403) {
    return {
      authQuota: true,
      rateLimited: false,
      stopReason: "end_turn",
      label: `${tag || "Request"} (HTTP ${httpStatusCode})`,
    };
  }
  switch (tag) {
    case "unauthorized":
      return {
        authQuota: true,
        rateLimited: false,
        stopReason: "end_turn",
        label: "Not signed in (unauthorized)",
      };
    case "usageLimitExceeded":
      return {
        authQuota: false,
        rateLimited: true,
        stopReason: "end_turn",
        label: "Usage limit exceeded",
      };
    case "contextWindowExceeded":
      return {
        authQuota: false,
        rateLimited: false,
        stopReason: "max_turn_requests",
        label: "Context window exceeded",
      };
    case "serverOverloaded":
      return {
        authQuota: false,
        rateLimited: true,
        stopReason: "end_turn",
        label: "Server overloaded",
      };
    default:
      return {
        authQuota: false,
        rateLimited: false,
        stopReason: "end_turn",
        label: tag || "error",
      };
  }
}

function extractErrorMessage(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  try {
    const parsed = JSON.parse(raw) as {
      error?: { message?: string };
      message?: string;
    };
    if (parsed?.error?.message) return parsed.error.message;
    if (parsed?.message) return parsed.message;
  } catch {
    /* not JSON */
  }
  return raw;
}
