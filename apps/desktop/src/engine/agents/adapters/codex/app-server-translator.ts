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
import { basename, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { isDevRuntime } from "../../../runtime";
import type { ContentBlock, SessionNotification, TurnUsage } from "../../types";
import type { ToolCallContent } from "@zeros/protocol/agent-events";

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
  | "other";

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

  /** Codex item.id → cumulative text we've emitted for that item.
   *  Used to compute the delta from full-text updates. (The delta
   *  events carry only the diff; the lifecycle events sometimes
   *  carry the full accumulated text.) */
  private readonly emittedMessageText = new Map<string, string>();

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

  /** Reset terminal/streaming state at the start of a new turn. The
   *  thread id is not reset — it persists across turns. */
  startTurn(): void {
    this.turnPrefix = randomUUID();
    this.toolCallIds.clear();
    this.emittedToolCallIds.clear();
    this.emittedMessageText.clear();
    this.hasSeenTurnTerminal = false;
    this.lastStopReason = "end_turn";
    this.turnFailureLabel = null;
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
        // Known aggregate snapshots. FileChange item events already drive the
        // edit timeline + authored-file attribution. Re-emitting the diff
        // would duplicate UI; treating it as unknown creates diagnostic noise.
        break;
      case "turn/plan/updated":
        this.onTurnPlanUpdated(params);
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
      case "item/autoApprovalReview/started":
        this.onAutoApprovalReview(params, false);
        break;
      case "item/autoApprovalReview/completed":
        this.onAutoApprovalReview(params, true);
        break;
      case "thread/environment/connected":
        this.onEnvironmentConnection(params, true);
        break;
      case "thread/environment/disconnected":
        this.onEnvironmentConnection(params, false);
        break;
      case "model/safetyBuffering/updated":
        this.onSafetyBuffering(params);
        break;
      case "model/verification":
        this.onModelVerification(params);
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
      case "remoteControl/status/changed":
        this.onRemoteControlStatus(params);
        break;
      case "app/list/updated":
        this.onSimpleNotice("codex_apps_updated", "Available Codex apps changed.");
        break;
      case "thread/realtime/started":
        this.onRealtimeStarted(params);
        break;
      case "thread/realtime/transcript/delta":
        this.onRealtimeTranscriptDelta(params);
        break;
      case "thread/realtime/transcript/done":
        this.onRealtimeTranscriptDone(params);
        break;
      case "thread/realtime/error":
        this.onRealtimeError(params);
        break;
      case "thread/realtime/closed":
        this.onRealtimeClosed(params);
        break;
      case "thread/realtime/outputAudio/delta":
        this.onRealtimeAudioDelta(params);
        break;
      case "thread/realtime/itemAdded":
      case "thread/realtime/sdp":
        // Transport-level payloads are consumed by the realtime client. They
        // are deliberately not persisted into the transcript: SDP is a
        // session secret and raw backend items can contain large opaque data.
        break;
      case "windowsSandbox/setupCompleted":
        this.onWindowsSandboxSetupCompleted(params);
        break;
      case "windows/worldWritableWarning":
        this.onWindowsWorldWritableWarning(params);
        break;
      case "thread/compacted":
      case "turn/moderationMetadata":
        // ContextCompactedNotification is deprecated in favor of the
        // contextCompaction item already rendered above. Moderation metadata
        // is provider-internal and must not be exposed as chat prose.
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

  private onTurnPlanUpdated(params: unknown): void {
    const p = params as {
      turnId?: string;
      explanation?: string | null;
      plan?: Array<{ step?: string; status?: string }>;
    };
    if (typeof p.turnId !== "string" || !Array.isArray(p.plan)) return;
    const steps = p.plan.filter(
      (step): step is { step: string; status?: string } =>
        typeof step?.step === "string" && step.step.trim().length > 0,
    );
    if (steps.length === 0) return;
    const completed = steps.filter(
      (step) => step.status === "completed",
    ).length;
    const settled = completed === steps.length;
    const markdown = [
      ...(typeof p.explanation === "string" && p.explanation.trim()
        ? [p.explanation.trim(), ""]
        : []),
      ...steps.map(
        (step) =>
          `- [${step.status === "completed" ? "x" : " "}] ${step.step.trim()}`,
      ),
    ].join("\n");
    const toolCallId = this.ensureToolCallId(`plan:${p.turnId}`);
    this.emitToolCallUpsert(toolCallId, {
      nativeToolCallId: `plan:${p.turnId}`,
      title: `Plan · ${completed}/${steps.length} complete`,
      kind: "other",
      status: settled ? "completed" : "in_progress",
      rawInput: { explanation: p.explanation ?? null, plan: steps },
      content: [
        {
          type: "content",
          content: { type: "text", text: markdown } as ContentBlock,
        },
      ],
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

  private onToolOutputDelta(params: unknown, _method: string): void {
    const p = params as { itemId?: string; delta?: string; output?: string };
    if (typeof p?.itemId !== "string") return;
    const toolCallId = this.toolCallIds.get(p.itemId);
    if (!toolCallId) return;
    const text =
      typeof p.delta === "string"
        ? p.delta
        : typeof p.output === "string"
          ? p.output
          : "";
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        rawOutput: text || null,
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
    const toolCallId = this.toolCallIds.get(p.itemId);
    if (!toolCallId) return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
        rawOutput: { progress: p.message },
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

  private onHookLifecycle(params: unknown, completed: boolean): void {
    const p = params as {
      run?: { id?: unknown; eventName?: unknown; status?: unknown; statusMessage?: unknown };
    };
    if (typeof p?.run?.id !== "string") return;
    const toolCallId = this.ensureToolCallId(`hook:${p.run.id}`);
    const eventName =
      typeof p.run.eventName === "string" ? p.run.eventName : "workflow";
    const failed = p.run.status === "failed" || p.run.status === "blocked";
    this.emitToolCallUpsert(toolCallId, {
      title: `Hook · ${eventName}`,
      kind: "other",
      status: completed ? (failed ? "failed" : "completed") : "in_progress",
      rawInput: { eventName, hookId: p.run.id },
      ...(completed
        ? {
            rawOutput: {
              status: p.run.status,
              ...(typeof p.run.statusMessage === "string"
                ? { message: p.run.statusMessage }
                : {}),
            },
          }
        : {}),
    });
  }

  private onModelRerouted(params: unknown): void {
    const p = params as {
      fromModel?: unknown;
      toModel?: unknown;
      reason?: unknown;
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
          ...(typeof p.fromModel === "string" ? { fromModel: p.fromModel } : {}),
          toModel: p.toModel,
          ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
        },
      },
    });
  }

  private onAutoApprovalReview(params: unknown, completed: boolean): void {
    const p = params as {
      reviewId?: unknown;
      targetItemId?: unknown;
      action?: unknown;
      review?: unknown;
      decisionSource?: unknown;
    };
    if (typeof p.reviewId !== "string") return;
    const toolCallId = this.ensureToolCallId(`auto-review:${p.reviewId}`);
    this.emitToolCallUpsert(toolCallId, {
      title: "Approval review",
      kind: "other",
      status: completed ? "completed" : "in_progress",
      rawInput: {
        reviewId: p.reviewId,
        ...(typeof p.targetItemId === "string" ? { targetItemId: p.targetItemId } : {}),
        action: p.action,
      },
      ...(completed
        ? {
            rawOutput: {
              review: p.review,
              decisionSource: p.decisionSource,
              // The explicit retry RPC requires the serialized guardian event.
              // Preserve the complete generated notification payload instead
              // of attempting to reconstruct an unstable protocol shape in UI.
              event: params,
            },
          }
        : {}),
    });
  }

  private onEnvironmentConnection(params: unknown, connected: boolean): void {
    const environmentId = (params as { environmentId?: unknown })?.environmentId;
    if (typeof environmentId !== "string") return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-environment-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code: connected ? "environment_connected" : "environment_disconnected",
        message: connected
          ? `Codex environment ${environmentId} connected.`
          : `Codex environment ${environmentId} disconnected.`,
      },
    });
  }

  private onSafetyBuffering(params: unknown): void {
    const p = params as {
      model?: unknown;
      showBufferingUi?: unknown;
      reasons?: unknown;
    };
    if (p.showBufferingUi !== true) return;
    const reasons = Array.isArray(p.reasons)
      ? p.reasons.filter((reason): reason is string => typeof reason === "string")
      : [];
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-safety-buffer-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code: "model_safety_buffering",
        message: `Codex is verifying this response${typeof p.model === "string" ? ` with ${p.model}` : ""}${reasons.length ? `: ${reasons.join(", ")}` : "."}`,
      },
    });
  }

  private onModelVerification(params: unknown): void {
    const verifications = (params as { verifications?: unknown })?.verifications;
    if (!Array.isArray(verifications) || verifications.length === 0) return;
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

  private onExternalConfigImport(params: unknown, completed: boolean): void {
    const p = params as { importId?: unknown; itemTypeResults?: unknown };
    if (typeof p.importId !== "string") return;
    const toolCallId = this.ensureToolCallId(`external-import:${p.importId}`);
    this.emitToolCallUpsert(toolCallId, {
      title: "Import agent configuration",
      kind: "other",
      status: completed ? "completed" : "in_progress",
      rawInput: { importId: p.importId },
      ...(completed ? { rawOutput: { itemTypeResults: p.itemTypeResults } } : {}),
    });
  }

  private onMcpOauthCompleted(params: unknown): void {
    const p = params as { name?: unknown; success?: unknown; error?: unknown };
    if (typeof p.name !== "string") return;
    const success = p.success === true;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-mcp-oauth-${this.noticeSeq++}`,
        severity: success ? "warning" : "error",
        recoverable: success,
        code: "mcp_oauth_complete",
        message: success
          ? `${p.name} MCP sign-in completed.`
          : `${p.name} MCP sign-in failed${typeof p.error === "string" ? `: ${p.error}` : "."}`,
      },
    });
  }

  private onMcpStartupStatus(params: unknown): void {
    const p = params as { name?: unknown; status?: unknown; error?: unknown };
    if (typeof p.name !== "string" || typeof p.status !== "string") return;
    if (p.status === "ready" || p.status === "starting") return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-mcp-status-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code: "mcp_startup_status",
        message: `${p.name} MCP is ${p.status}${typeof p.error === "string" ? `: ${p.error}` : "."}`,
      },
    });
  }

  private onRemoteControlStatus(params: unknown): void {
    const p = params as { status?: unknown; serverName?: unknown };
    if (typeof p.status !== "string") return;
    this.onSimpleNotice(
      "remote_control_status",
      `Codex remote control ${p.status}${typeof p.serverName === "string" ? ` on ${p.serverName}` : ""}.`,
    );
  }

  private onSimpleNotice(code: string, message: string): void {
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `${this.turnPrefix}-${code}-${this.noticeSeq++}`,
        severity: "warning",
        recoverable: true,
        code,
        message,
      },
    });
  }

  private realtimeToolCallId(threadId: string): string {
    return this.ensureToolCallId(`realtime:${threadId}`);
  }

  private onRealtimeStarted(params: unknown): void {
    const p = params as {
      threadId?: unknown;
      realtimeSessionId?: unknown;
      version?: unknown;
    };
    if (typeof p.threadId !== "string") return;
    this.emitToolCallUpsert(this.realtimeToolCallId(p.threadId), {
      title: "Realtime conversation",
      kind: "other",
      status: "in_progress",
      rawInput: {
        ...(typeof p.realtimeSessionId === "string"
          ? { realtimeSessionId: p.realtimeSessionId }
          : {}),
        version: p.version,
      },
    });
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "realtime_status",
        threadId: p.threadId,
        status: "active",
        ...(typeof p.realtimeSessionId === "string"
          ? { realtimeSessionId: p.realtimeSessionId }
          : {}),
      },
    });
  }

  private onRealtimeTranscriptDelta(params: unknown): void {
    const p = params as { threadId?: unknown; role?: unknown; delta?: unknown };
    if (
      typeof p.threadId !== "string" ||
      typeof p.role !== "string" ||
      typeof p.delta !== "string" ||
      p.delta.length === 0
    ) {
      return;
    }
    const messageId = `${this.turnPrefix}-realtime-${p.threadId}-${p.role}`;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate:
          p.role === "user" ? "user_message_chunk" : "agent_message_chunk",
        content: { type: "text", text: p.delta } as ContentBlock,
        messageId,
      },
    });
  }

  private onRealtimeTranscriptDone(params: unknown): void {
    const p = params as { threadId?: unknown; role?: unknown; text?: unknown };
    if (typeof p.threadId !== "string" || typeof p.text !== "string") return;
    this.emitToolCallUpsert(this.realtimeToolCallId(p.threadId), {
      status: "in_progress",
      rawOutput: { role: p.role, transcript: p.text },
    });
  }

  private onRealtimeAudioDelta(params: unknown): void {
    const p = params as {
      threadId?: unknown;
      audio?: {
        data?: unknown;
        sampleRate?: unknown;
        numChannels?: unknown;
        samplesPerChannel?: unknown;
        itemId?: unknown;
      };
    };
    if (typeof p.threadId !== "string") return;
    if (
      typeof p.audio?.data === "string" &&
      p.audio.data.length <= 2_000_000 &&
      typeof p.audio.sampleRate === "number" &&
      typeof p.audio.numChannels === "number"
    ) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "realtime_audio",
          threadId: p.threadId,
          data: p.audio.data,
          sampleRate: p.audio.sampleRate,
          numChannels: p.audio.numChannels,
          samplesPerChannel:
            typeof p.audio.samplesPerChannel === "number"
              ? p.audio.samplesPerChannel
              : null,
          itemId:
            typeof p.audio.itemId === "string" ? p.audio.itemId : null,
        },
      });
    }
    // Do not copy/persist the base64 audio data into durable chat history.
    // The live realtime consumer receives it directly from app-server; the
    // transcript records only non-sensitive stream metadata.
    this.emitToolCallUpsert(this.realtimeToolCallId(p.threadId), {
      status: "in_progress",
      rawOutput: {
        audio: {
          sampleRate: p.audio?.sampleRate,
          numChannels: p.audio?.numChannels,
          samplesPerChannel: p.audio?.samplesPerChannel,
        },
      },
    });
  }

  private onRealtimeError(params: unknown): void {
    const p = params as { threadId?: unknown; message?: unknown };
    if (typeof p.threadId !== "string") return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "realtime_status",
        threadId: p.threadId,
        status: "error",
        message:
          typeof p.message === "string"
            ? p.message
            : "Realtime conversation failed.",
      },
    });
    this.emitToolCallUpsert(this.realtimeToolCallId(p.threadId), {
      title: "Realtime conversation",
      kind: "other",
      status: "failed",
      rawOutput: {
        error:
          typeof p.message === "string"
            ? p.message
            : "Realtime conversation failed.",
      },
    });
  }

  private onRealtimeClosed(params: unknown): void {
    const p = params as { threadId?: unknown; reason?: unknown };
    if (typeof p.threadId !== "string") return;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "realtime_status",
        threadId: p.threadId,
        status: "closed",
        ...(typeof p.reason === "string" ? { message: p.reason } : {}),
      },
    });
    this.emitToolCallUpsert(this.realtimeToolCallId(p.threadId), {
      status: "completed",
      rawOutput: {
        ...(typeof p.reason === "string" ? { reason: p.reason } : {}),
      },
    });
  }

  private onWindowsSandboxSetupCompleted(params: unknown): void {
    const p = params as { mode?: unknown; success?: unknown; error?: unknown };
    this.emitToolCallUpsert(
      this.ensureToolCallId(`windows-sandbox:${String(p.mode ?? "default")}`),
      {
        title: "Windows sandbox setup",
        kind: "other",
        status: p.success === true ? "completed" : "failed",
        rawInput: { mode: p.mode },
        rawOutput: {
          success: p.success === true,
          ...(typeof p.error === "string" ? { error: p.error } : {}),
        },
      },
    );
  }

  private onWindowsWorldWritableWarning(params: unknown): void {
    const p = params as {
      samplePaths?: unknown;
      extraCount?: unknown;
      failedScan?: unknown;
    };
    const paths = Array.isArray(p.samplePaths)
      ? p.samplePaths.filter((path): path is string => typeof path === "string")
      : [];
    const extraCount = typeof p.extraCount === "number" ? p.extraCount : 0;
    const detail = paths.length > 0 ? ` ${paths.join(", ")}` : "";
    this.onSimpleNotice(
      "windows_world_writable",
      p.failedScan === true
        ? "Windows sandbox could not finish scanning writable paths."
        : `Windows sandbox found broadly writable paths.${detail}${extraCount > 0 ? ` and ${extraCount} more` : ""}`,
    );
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
      const first = Array.isArray(item.changes)
        ? item.changes.find(
            (c): c is { path: string } => typeof c?.path === "string",
          )
        : undefined;
      return first ? `Editing ${first.path}` : "Editing files";
    }
    case "mcpToolCall":
      return `${item.server}:${item.tool}`;
    case "dynamicToolCall":
      return item.tool || "tool";
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
  const first = Array.isArray(item.changes)
    ? item.changes.find(
        (c): c is { path: string } => typeof c?.path === "string",
      )
    : undefined;
  return first ? `edit:${first.path}` : null;
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
    return item.error ? "failed" : "completed";
  }
  if (item.type === "dynamicToolCall") {
    return item.success === false ? "failed" : "completed";
  }
  if (item.type === "collabAgentToolCall") {
    return item.status === "failed" ? "failed" : "completed";
  }
  return "completed";
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
      return { tool: item.tool, arguments: item.arguments };
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

/** Convert Responses-compatible dynamic-tool output into the canonical chat
 * content blocks that the renderer and transcript database already preserve.
 * Browser screenshots therefore survive reloads and render inline instead of
 * being buried as a base64 string inside raw JSON. */
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
      if (item.namespace === "zeros_browser" || item.tool === "screenshot") {
        for (const artifact of browserArtifactsFromText(value.text)) {
          content.push({ type: "content", content: artifact });
        }
      }
      continue;
    }
    if (value.type !== "inputImage" || typeof value.imageUrl !== "string") {
      continue;
    }
    const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(
      value.imageUrl,
    );
    if (!match) continue;
    content.push({
      type: "content",
      content: { type: "image", mimeType: match[1]!, data: match[2]! },
    });
  }
  // Put the durable file link after the inline preview regardless of the tool
  // response's metadata-before-image ordering.
  content.sort((left, right) => contentOrder(left) - contentOrder(right));
  return content.length > 0 ? content : null;
}

function browserArtifactsFromText(text: string): ContentBlock[] {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const content: ContentBlock[] = [];
    const artifact = parsed.artifact as Record<string, unknown> | undefined;
    if (
      artifact?.kind === "browser-screenshot" &&
      typeof artifact.path === "string" &&
      isAbsolute(artifact.path) &&
      artifact.mimeType === "image/jpeg"
    ) {
      content.push({
        type: "resource_link",
        uri: pathToFileURL(artifact.path).href,
        name: basename(artifact.path),
        mimeType: "image/jpeg",
        ...(typeof artifact.size === "number" ? { size: artifact.size } : {}),
        title: "Browser screenshot evidence",
      });
    } else if (
      artifact?.kind === "browser-trace" &&
      typeof artifact.path === "string" &&
      isAbsolute(artifact.path) &&
      artifact.mimeType === "application/json"
    ) {
      content.push({
        type: "resource_link",
        uri: pathToFileURL(artifact.path).href,
        name: basename(artifact.path),
        mimeType: "application/json",
        ...(typeof artifact.size === "number" ? { size: artifact.size } : {}),
        title: "Browser trace evidence",
      });
    }
    if (Array.isArray(parsed.downloads)) {
      for (const candidate of parsed.downloads.slice(-40)) {
        if (!candidate || typeof candidate !== "object") continue;
        const download = candidate as Record<string, unknown>;
        if (
          download.kind !== "browser-download" ||
          typeof download.path !== "string" ||
          !isAbsolute(download.path)
        ) {
          continue;
        }
        content.push({
          type: "resource_link",
          uri: pathToFileURL(download.path).href,
          name: basename(download.path),
          ...(typeof download.mimeType === "string"
            ? { mimeType: download.mimeType.slice(0, 200) }
            : {}),
          ...(typeof download.size === "number" ? { size: download.size } : {}),
          title: "Browser download evidence",
        });
      }
    }
    return content;
  } catch {
    return [];
  }
}

function contentOrder(block: ToolCallContent): number {
  if (block.type !== "content") return 3;
  if (block.content.type === "text") return 0;
  if (block.content.type === "image") return 1;
  if (block.content.type === "resource_link") return 2;
  return 3;
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
  stopReason: "end_turn" | "max_turn_requests" | "refusal" | "cancelled";
  label: string;
} {
  const tag =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? (Object.keys(info as object)[0] ?? "")
        : "";
  switch (tag) {
    case "unauthorized":
      return {
        authQuota: true,
        stopReason: "end_turn",
        label: "Not signed in (unauthorized)",
      };
    case "usageLimitExceeded":
      return {
        authQuota: true,
        stopReason: "end_turn",
        label: "Usage limit exceeded",
      };
    case "contextWindowExceeded":
      return {
        authQuota: false,
        stopReason: "max_turn_requests",
        label: "Context window exceeded",
      };
    case "serverOverloaded":
      return {
        authQuota: false,
        stopReason: "end_turn",
        label: "Server overloaded",
      };
    default:
      return {
        authQuota: false,
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
