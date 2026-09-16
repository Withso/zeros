import { ClaudeQueryUsage } from "./usage-accounting";
// ──────────────────────────────────────────────────────────
// Claude stream-json → SessionNotification translator
// ──────────────────────────────────────────────────────────
//
// The live feeder is the Agent SDK's `SDKMessage` stream (this class is
// reused by `claude-sdk/adapter.ts`). Those messages mirror the JSON
// objects Claude Code emits one-per-line under
// `--output-format stream-json --verbose`, so the shapes below still
// describe the input verbatim. Shape roughly:
//
//   {"type":"system","subtype":"init","session_id":"...","model":"...","tools":[...]}
//   {"type":"user","message":{"role":"user","content":[...]}}
//   {"type":"assistant","message":{"role":"assistant","content":[
//     {"type":"thinking","thinking":"..."},
//     {"type":"text","text":"..."},
//     {"type":"tool_use","id":"toolu_01","name":"Read","input":{...}}
//   ]}}
//   {"type":"user","message":{"role":"user","content":[
//     {"type":"tool_result","tool_use_id":"toolu_01","content":"...","is_error":false}
//   ]}}
//   {"type":"result","subtype":"success","result":"...","total_cost_usd":0.01,"usage":{...},"session_id":"..."}
//
// This class converts each Claude event into one or more
// SessionNotification payloads matching the wire shape. The UI
// already knows how to render them (unchanged).
//
// State is per-translator-instance, keyed on the Zeros session id
// passed at construction. Each new session gets a fresh translator.
//
// ──────────────────────────────────────────────────────────

import { createHash, randomUUID } from "node:crypto";

import type {
  BackgroundTask,
  WorkflowPhaseProgress,
  WorkflowProgress,
} from "@zeros/protocol/agent-events";
import { claudeContextWindow } from "@zeros/protocol/model-context";

import { ClaudeTranscriptState } from "./transcript-state";
import type {
  ContentBlock,
  SessionNotification,
  StopReason,
  TurnUsage,
} from "../../types";

// engine ToolKind union — hoisted as a string set for runtime checks.
// Mirrors @zeros/protocol/agent-events ToolKind, including
// web_search / subagent / mcp / question for the new card kinds.
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
  | "skill"
  | "tool_search"
  | "task_create"
  | "task_update"
  | "background_task"
  | "other";

type Emit = (notification: SessionNotification) => void;

export const SCHEDULED_WAKEUP_TASK_PREFIX = "scheduled-wakeup:";

export function isScheduledWakeupTaskId(taskId: string): boolean {
  return taskId.startsWith(SCHEDULED_WAKEUP_TASK_PREFIX);
}

export interface ClaudeScheduledWakeup {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

const MAX_ACTIVE_BACKGROUND_TASKS = 100;
const MAX_BACKGROUND_TASK_LIFECYCLE = 500;
const MAX_RETAINED_TOOL_TEXT = 2_000;
/** Joins a workflow task id to a narrator line in the dedupe fingerprint. A
 * character that cannot occur in either half, so the id stays a safe prefix to
 * match when a finished run's fingerprints are dropped. */
const WORKFLOW_NARRATION_SEPARATOR = "\u0000";

interface RetainedToolInput {
  name: string;
  command?: string;
  description?: string;
  scheduledWakeup?: {
    stop: boolean;
    reason: string | null;
    promptFingerprint: string | null;
  };
}

interface PendingScheduledWakeupReason {
  reason: string;
  promptFingerprint: string | null;
  knownTaskIds: Set<string>;
  scheduledFor?: number;
}

interface SettledTaskRecord {
  status: "completed" | "failed";
  rawOutput: {
    status: string;
    summary?: string;
    error?: string;
    outputFile?: string;
    durationMs?: number;
  };
}

interface ClaudeAssistantContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ClaudeMessageEvent {
  uuid?: string;
  request_id?: string;
  type: "user" | "assistant";
  /** SDK errors are synthetic notices, never evidence of a model fallback. */
  error?: string;
  /** Anthropic stamps `parent_tool_use_id` at the envelope level when
   *  the message originates from inside a Task subagent. The renderer uses
   *  this to route child events into the
   *  parent SubagentCard's nested transcript. */
  parent_tool_use_id?: string | null;
  /** Claude Code's rich result for THIS user event's tool_result (SDK
   *  `tool_use_result`). For Edit/Write/MultiEdit it carries
   *  `structuredPatch` — real hunks with real file line numbers, which the
   *  EditCard renders directly instead of a snippet diff that restarts at
   *  line 1. */
  tool_use_result?: unknown;
  message?: {
    id?: string;
    role?: string;
    /** The model that actually produced this assistant message (the Anthropic
     *  API message's `model` field). When a fallback model answers
     *  (primary overloaded), this is the per-message signal of the swap. */
    model?: string;
    stop_reason?: string | null;
    content?: ClaudeAssistantContentBlock[];
  };
}

interface ClaudeSystemEvent {
  type: "system";
  subtype: string;
  session_id?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: Array<{ name: string; status?: string }>;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  task_type?: string;
  workflow_name?: string;
  prompt?: string;
  skip_transcript?: boolean;
  ambient?: boolean;
  is_backgrounded?: boolean;
  tasks?: Array<{
    task_id?: string;
    task_type?: string;
    description?: string;
    ambient?: boolean;
  }>;
  usage?: { duration_ms?: number };
  last_tool_name?: string;
  workflow_progress?: Array<{
    type?: string;
    index?: number;
    title?: string;
    label?: string;
    phaseIndex?: number;
    phaseTitle?: string;
    state?: string;
    message?: string;
  }>;
  summary?: string;
  patch?: {
    status?: string;
    description?: string;
    end_time?: number;
    total_paused_ms?: number;
    error?: string;
    is_backgrounded?: boolean;
  };
  status?: string;
  state?: "idle" | "running" | "requires_action";
  output_file?: string;
}

interface ClaudeResultEvent {
  type: "result";
  uuid?: string;
  errors?: string[];
  subtype?: "success" | "error_max_turns" | "error_during_execution" | string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  is_error?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** The Anthropic stop reason of the turn's final API call
   *  ("end_turn" | "max_tokens" | …). "max_tokens" = the answer was cut by
   *  the output-token cap and must not render as complete. */
  stop_reason?: string | null;
  /** The SDK's structured terminal reason ("budget_exhausted",
   *  "blocking_limit", "prompt_too_long", …). Richer than subtype. */
  terminal_reason?: string;
  /** Per-model usage breakdown (SDK `result.modelUsage`, keyed by
   *  model id, camelCase fields — unlike the snake_case aggregate `usage`). */
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD?: number;
    }
  >;
  result?: string;
}

/** Claude Agent SDK 0.3.238 terminal reasons, kept explicit so an SDK upgrade
 * cannot silently make a new early-ending condition look like a successful
 * end_turn. Unknown future values return null and retain the conservative
 * is_error/subtype fallback in onResult. */
export type ClaudeTerminalReason =
  | "blocking_limit"
  | "rapid_refill_breaker"
  | "prompt_too_long"
  | "image_error"
  | "model_error"
  | "api_error"
  | "malformed_tool_use_exhausted"
  | "aborted_streaming"
  | "aborted_tools"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "tool_deferred"
  | "max_turns"
  | "background_requested"
  | "completed"
  | "budget_exhausted"
  | "structured_output_retry_exhausted"
  | "tool_deferred_unavailable"
  | "turn_setup_failed";

export function mapClaudeTerminalReason(
  reason: string | null | undefined,
): StopReason | null {
  switch (reason as ClaudeTerminalReason | undefined) {
    case "blocking_limit":
    case "rapid_refill_breaker":
      return "blocking_limit";
    case "prompt_too_long":
      return "prompt_too_long";
    case "max_turns":
      return "max_turn_requests";
    case "budget_exhausted":
      return "budget_exhausted";
    case "tool_deferred":
    case "background_requested":
    case "completed":
      return "end_turn";
    case "image_error":
    case "model_error":
    case "api_error":
    case "malformed_tool_use_exhausted":
    case "aborted_streaming":
    case "aborted_tools":
    case "stop_hook_prevented":
    case "hook_stopped":
    case "structured_output_retry_exhausted":
    case "tool_deferred_unavailable":
    case "turn_setup_failed":
      return "refusal";
    default:
      return null;
  }
}

interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?:
    | string
    | Array<{
        type: string;
        text?: string;
        source?: {
          type?: string;
          media_type?: string;
          data?: string;
          url?: string;
        };
      }>;
  is_error?: boolean;
}

export interface ClaudeTranslatorOptions {
  /** Zeros-side session id — goes into every emitted SessionNotification. */
  sessionId: string;
  /** Called once for each SessionNotification produced. */
  emit: Emit;
  /** Optional hook for diagnostics of unknown Claude event shapes. */
  onUnknown?: (event: unknown) => void;
  /** Render incremental SDK text/thinking and reconcile completed snapshots
   * by native message id, parent and block index. Full messages remain usable
   * when partial streaming is disabled or a transport omits its deltas. */
  streamPartials?: boolean;
}

/** Native message-start and block-index metadata owns partial reconciliation. */
interface ClaudeStreamEvent {
  type: "stream_event";
  parent_tool_use_id?: string | null;
  event?: {
    type?: string;
    index?: number;
    message?: { id?: string };
    content_block?: ClaudeAssistantContentBlock;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      stop_reason?: string | null;
    };
  };
}

export class ClaudeStreamTranslator {
  private readonly sessionId: string;
  private readonly emit: Emit;
  private readonly onUnknown?: (event: unknown) => void;

  /** Zeros-side tool call ids keyed by Claude's tool_use_id so
   *  tool_call_update can cross-reference a prior tool_call. */
  private readonly toolCallIds = new Map<string, string>();

  /** Small, bounded metadata for the two lifecycle joins that reference a
   * native tool_use_id later. Never retain raw Write/Edit payloads here. */
  private readonly toolInputs = new Map<string, RetainedToolInput>();

  /** Active background work is level-triggered by
   * background_tasks_changed and enriched by the task edge stream. */
  private readonly backgroundTasks = new Map<string, BackgroundTask>();
  /** Process ownership includes ambient tasks, even though the visible map
   * above excludes them. A level snapshot replaces this set; subsequent edges
   * enrich/settle it but cannot recreate membership absent from that snapshot. */
  private readonly liveBackgroundTasks = new Map<string, boolean>();
  private hasBackgroundTaskSnapshot = false;
  /** Keep retirement conservative if native membership exceeds our ID budget.
   * The next level replaces this bit, including an authoritative empty set. */
  private backgroundTaskOverflow = false;
  /** Edge metadata can arrive before membership (ordering is explicitly
   * unspecified by the SDK). Cache it separately until the level signal says
   * whether that task is actually background work. */
  private readonly backgroundTaskMetadata = new Map<string, BackgroundTask>();
  /** One-shot self-wakeups are reported by the SDK's Stop hook rather than
   * `background_tasks_changed`. Keep their authoritative level separate so a
   * native task membership frame cannot accidentally clear them. Recurring
   * cron jobs are deliberately excluded (open task 008). */
  private readonly scheduledWakeups = new Map<string, BackgroundTask>();
  private pendingScheduledWakeupReason: PendingScheduledWakeupReason | null =
    null;
  /** Separate edge/level evidence lets a missed task_started still settle
   * after the authoritative level has already removed the task, without
   * misclassifying ordinary foreground Task subagents. */
  private readonly taskStartedIds = new Set<string>();
  private readonly observedBackgroundTaskIds = new Set<string>();
  /** ID and settlement share one eviction boundary. Separate bounded caches
   * could forget completion while retaining its ID and fail that row on Stop. */
  private readonly taskRecords = new Map<string, {
    toolCallId: string;
    settlement?: SettledTaskRecord;
  }>();
  private readonly skippedTaskRecords = new Set<string>();
  private readonly notifiedTaskIds = new Set<string>();
  /** Edge/level ordering is unspecified. Once an edge settles an id, ignore a
   * late membership frame for it until the SDK process restarts. */
  private readonly terminalTaskIds = new Set<string>();
  /** A pause edge can legally beat the first workflow level frame. Preserve
   * that edge separately so the later level cannot briefly reopen the row as
   * running. Like terminal ids, this is process-local and bounded. */
  private readonly pausedTaskIds = new Set<string>();
  private sessionActivityState: "idle" | "running" | "requires_action" | null =
    null;
  private activityStartedAt: number | null = null;
  private activityStopped = false;
  private readonly ambientTaskIds = new Set<string>();
  /** Last wire snapshot, retained only to suppress semantically identical
   * provider observations before they cross the engine/renderer bridge. */
  private lastEmittedBackgroundTasks: {
    tasks: BackgroundTask[];
    waiting: boolean;
    activity?: { state: "idle" | "running" | "requires_action"; startedAt: number } | null;
  } | null = null;
  /** Foreground local-workflow progress is a separate ephemeral level stream;
   * it must never be folded into the background-task dock. */
  private readonly workflows = new Map<string, WorkflowProgress>();
  private lastEmittedWorkflows: WorkflowProgress[] | null = null;
  /** task_progress frames repeat the full log prefix. Keep a bounded set so a
   * narrator line becomes one durable standard tool row, not N duplicates. */
  private readonly workflowNarration = new Set<string>();

  /** Zeros-side (minted) tool call id for a native tool_use id — lets the
   *  adapter address a timeline row it only knows by vendor id (the
   *  question-stamp tool_call_update on AskUserQuestion settle). Undefined
   *  until the tool_use block has streamed through onAssistant. */
  toolCallIdFor(nativeToolUseId: string): string | undefined {
    return this.toolCallIds.get(nativeToolUseId);
  }

  /** Host-side MCP elicitation has no assistant tool_use block, so synthesize
   * the durable question row and register its native id for settle-time stamps. */
  emitBlockingQuestionToolCall(
    nativeToolUseId: string,
    title: string,
    rawInput: unknown,
  ): string {
    const existing = this.toolCallIds.get(nativeToolUseId);
    if (existing) return existing;
    const toolCallId = `tool-${randomUUID()}`;
    this.toolCallIds.set(nativeToolUseId, toolCallId);
    setBoundedMap(this.scopedTools, JSON.stringify(["", nativeToolUseId]), {
      id: toolCallId, announced: true, status: "in_progress",
    }, 4_000);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        nativeToolCallId: nativeToolUseId,
        title,
        kind: "question",
        status: "in_progress",
        rawInput,
      },
    });
    return toolCallId;
  }

  /** Claude tool_use_ids whose corresponding tool_result
   *  should be swallowed instead of emitted as a tool_call_update.
   *
   *  Currently this is the TodoWrite path — the tool_use is intercepted
   *  and routed to a canonical `plan` notification, so emitting the
   *  matching tool_result as a regular update would create an orphan
   *  tool message in the UI. */
  private readonly suppressedToolUseIds = new Set<string>();

  private readonly transcript = new ClaudeTranscriptState((update) => {
    this.emit({ sessionId: this.sessionId, update });
  });
  private readonly scopedTools = new Map<string, { id: string; announced: boolean; inputComplete?: boolean; resultFrameId?: string; status: "pending" | "in_progress" | "completed" | "failed" }>();
  private readonly nativeFrames = new Map<string, { parent: string; startedAt: number; resultKeys: Set<string> }>();
  private readonly retractedFrames = new Set<string>();
  private readonly retractedTools = new Set<string>();
  private readonly requestParents = new Map<string, string | null>();
  private readonly fallbackNotices = new Map<string, string>();
  private readonly inferredFallbacks = new Map<string, string>();
  private fallbackGeneration = 0;
  private readonly requestStarts = new Map<string, number>();
  private modelTurnStartedAt = 0;
  private readonly seenResultIds = new Set<string>();
  private readonly agentTasks = new Map<
    string,
    {
      toolCallId: string;
      status: "in_progress" | "completed" | "failed";
      model?: string;
      error?: string;
    }
  >();

  // A terminal task notification may precede both its start and launch ack,
  // and tool_use_id is optional. Preserve its outcome until the task id binds.
  private readonly agentTaskEnds = new Map<
    string,
    { status: "completed" | "failed"; error?: string }
  >();

  private lastStopReason: string = "end_turn";
  private hasSeenResult = false;
  /** Native result error text and parent assistant error code. The adapter
   * normalizes them together before choosing recovery. Null on clean turns. */
  private terminalErrorMsg: string | null = null;
  private assistantFailure: { code: string; message: string } | null = null;
  private assistantFailureFrame: string | undefined;
  private terminalErrorCode: string | undefined;

  /** Claude's session id from the `system.init` event. Kept for
   *  resume bookkeeping; not emitted to the UI. */
  claudeSessionId: string | null = null;

  /** Model id from `system.init.model`. Drives per-model
   *  context-window sizing on usage updates. Falls back to
   *  CLAUDE_DEFAULT_CONTEXT_WINDOW when undefined or unrecognised. */
  private currentModel: string | null = null;

  /** Per-turn token/cost usage from the result event. */
  private currentTurnUsage: TurnUsage | undefined;
  private readonly queryUsage = new ClaudeQueryUsage();
  private readonly seenUsageResets = new Set<string>();
  private usageConversationId: string | null = null;

  /** True once the CURRENT retry burst has produced its error_notice row.
   *  The CLI emits one `system/api_retry` per attempt (up to ~10 with
   *  exponential backoff); one row per burst tells the user the stall is a
   *  network blip being retried without writing ten rows into the
   *  transcript. Cleared by any non-system event (the call got through). */
  private retryBurstNoticed = false;

  // ── Compaction lifecycle ──
  //
  // The SDK narrates a compaction as: `system/status {status:"compacting"}`
  // (start) → on success a `system/compact_boundary` with metadata; on
  // failure a `system/status {compact_result:"failed", compact_error}`.
  // We open ONE two-state row on the start signal and settle it on
  // whichever end signal arrives.
  /** Open compaction row id, or null. Cleared on boundary/failure (the
   *  definitive settles) and at result (turn end), so a second compaction
   *  in a later run opens a fresh row. */
  private pendingCompactionToolCallId: string | null = null;
  /** True when the row was already settled (success-status may arrive
   *  before the boundary; the boundary then only merges metadata). */
  private pendingCompactionSettled = false;
  /** Armed by the adapter's compactContext() right before it feeds
   *  "/compact" — stamps the row's rawInput.trigger as "manual" so the
   *  renderer places it standalone (user-initiated) instead of inside the
   *  turn's working group (auto). Cleared when the row opens. */
  private manualCompactionExpected = false;

  /** Adapter hook: the next compaction this stream narrates was initiated
   *  by the user (Compact now / typed /compact routed via AGENT_COMPACT). */
  expectManualCompaction(): void {
    this.manualCompactionExpected = true;
  }

  // ── Overload-fallback detection ───────────────────────────
  //
  // The SDK swaps to Options.fallbackModel silently when the primary is
  // overloaded/unavailable; the only per-message trace is the assistant
  // message's `model` field. The adapter arms detection with the primary
  // model it configured; we surface one fallback narration message per turn
  // when a top-level assistant message answers on a different model.
  /** The primary model the adapter configured (verbatim id, may carry the
   *  `[1m]` suffix). Null = no explicit model → detection disabled. */
  private expectedModel: string | null = null;
  /** True when Options.fallbackModel was set — detection is meaningless
   *  (and false-positive-prone) without a configured fallback. */
  private fallbackArmed = false;
  /** One inferred fallback per turn; explicit native notices keep their IDs. */
  private fallbackNoticedThisTurn = false;

  /** Adapter hook: arm overload-fallback detection for this session.
   *  `primaryModel` is the configured model id; `fallbackConfigured` mirrors
   *  whether Options.fallbackModel was actually set. */
  armFallbackDetection(
    primaryModel: string | null,
    fallbackConfigured: boolean,
  ): void {
    this.expectedModel = primaryModel;
    this.fallbackArmed = fallbackConfigured;
  }

  // ── Budget-cap context ────────────────────────────────────
  /** The per-turn USD cap the adapter configured (Options.maxBudgetUsd).
   *  Only used to render the cap amount inside the "Turn stopped" record. */
  budgetCapUsd: number | null = null;

  private readonly streamPartials: boolean;

  constructor(opts: ClaudeTranslatorOptions) {
    this.sessionId = opts.sessionId;
    this.emit = opts.emit;
    this.onUnknown = opts.onUnknown;
    this.streamPartials = opts.streamPartials ?? false;
  }

  /** User-visible work. Ambient watchers never contribute to activity. */
  get hasActiveWork(): boolean {
    if (this.backgroundTasks.size > 0 || this.scheduledWakeups.size > 0) return true;
    for (const workflow of this.workflows.values()) {
      if (!this.ambientTaskIds.has(workflow.taskId) &&
          (workflow.status === "running" || workflow.status === "paused")) return true;
    }
    return false;
  }

  /** Runtime retention is independent of the visible activity projection. */
  get hasProcessWork(): boolean {
    return this.liveBackgroundTasks.size > 0 || this.backgroundTaskOverflow || this.hasActiveWork;
  }

  /** Called only by the adapter when it creates a new query/process. SDK
   * system/init is metadata for every turn, including turns on the SAME query.
   * Preserve transcript identities/history while replacing process ownership. */
  beginProcess(): void {
    this.queryUsage.reset();
    this.currentTurnUsage = undefined;
    this.usageConversationId = null;
    this.endActivity();
    this.hasBackgroundTaskSnapshot = false;
    this.backgroundTaskMetadata.clear();
    this.toolInputs.clear();
    this.taskStartedIds.clear();
    this.observedBackgroundTaskIds.clear();
    this.taskRecords.clear();
    this.skippedTaskRecords.clear();
    this.notifiedTaskIds.clear();
    this.terminalTaskIds.clear();
    this.agentTasks.clear();
    this.agentTaskEnds.clear();
    this.pausedTaskIds.clear();
    this.ambientTaskIds.clear();
    this.workflowNarration.clear();
    this.activityStopped = false;
  }

  /** Replace the session's one-shot wakeups from StopHookInput.session_crons.
   * Recurring jobs belong to the deliberately skipped scheduling feature and
   * must never leak into the background-task card. */
  setScheduledWakeups(crons: readonly ClaudeScheduledWakeup[]): void {
    if (this.activityStopped) return;
    const now = Date.now();
    const next = new Map<string, BackgroundTask>();
    const eligible = crons
      .filter((cron) => !cron.recurring && !!cron.id)
      .slice(0, MAX_ACTIVE_BACKGROUND_TASKS);
    const pending = this.pendingScheduledWakeupReason;
    let pendingTargetId: string | null = null;
    let pendingApplied = false;
    if (pending) {
      const newlyObserved = eligible.filter(
        (cron) =>
          !pending.knownTaskIds.has(
            `${SCHEDULED_WAKEUP_TASK_PREFIX}${cron.id}`,
          ),
      );
      const promptMatches = pending.promptFingerprint
        ? newlyObserved.filter(
            (cron) =>
              fingerprintText(cron.prompt) === pending.promptFingerprint,
          )
        : [];
      const target =
        promptMatches.length === 1
          ? promptMatches[0]
          : newlyObserved.length === 1
            ? newlyObserved[0]
            : null;
      pendingTargetId = target
        ? `${SCHEDULED_WAKEUP_TASK_PREFIX}${target.id}`
        : null;
    }
    for (const cron of eligible) {
      const taskId = `${SCHEDULED_WAKEUP_TASK_PREFIX}${cron.id}`;
      const previous = this.scheduledWakeups.get(taskId);
      // A successful ScheduleWakeup tool result describes the newly-created
      // entry only. Do not repaint every older cron in the next Stop snapshot
      // with that latest reason. An unchanged entry can be reused verbatim,
      // which also keeps hot renderer selectors stable.
      if (
        previous &&
        previous.summary === cron.schedule &&
        taskId !== pendingTargetId
      ) {
        next.set(taskId, previous);
        continue;
      }
      const reason =
        taskId === pendingTargetId && pending
          ? pending.reason
          : scheduledWakeupReason(cron.prompt);
      const scheduledFor =
        taskId === pendingTargetId && pending?.scheduledFor != null
          ? pending.scheduledFor
          : scheduledWakeupTimestamp(cron.schedule, now);
      if (taskId === pendingTargetId) pendingApplied = true;
      const name = scheduledWakeupName(cron.schedule, reason);
      next.set(taskId, {
        taskId,
        name,
        taskType: "scheduled_wakeup",
        startedAt:
          taskId === pendingTargetId ? now : (previous?.startedAt ?? now),
        updatedAt: now,
        summary: cron.schedule,
        ...(scheduledFor != null ? { scheduledFor } : {}),
      });
    }
    this.scheduledWakeups.clear();
    for (const [taskId, task] of next) this.scheduledWakeups.set(taskId, task);
    // An empty Stop-hook snapshot can race the runtime registering the cron.
    // Consume the reason only after the newly-created id is actually present.
    if (pendingApplied) this.pendingScheduledWakeupReason = null;
    this.emitBackgroundTasks();
  }

  /** A fired or explicitly-stopped one-shot is authoritative cleanup, unlike
   * a possibly-transient empty Stop-hook snapshot. */
  clearScheduledWakeups(): void {
    this.pendingScheduledWakeupReason = null;
    this.scheduledWakeups.clear();
    this.emitBackgroundTasks();
  }

  /** The local prompt boundary is authoritative evidence that the parent is
   * running even if this CLI build omits a matching session-state edge. */
  beginTurn(startedAt = Date.now()): void {
    this.currentTurnUsage = undefined;
    this.fallbackGeneration++;
    this.modelTurnStartedAt = startedAt;
    this.transcript.beginTurn();
    this.assistantFailure = null;
    this.activityStopped = false;
    this.activityStartedAt = Date.now();
    this.sessionActivityState = "running";
    this.emitBackgroundTasks();
  }

  /** Native automatic wake-up: the same request continues on its old clock. */
  resumeActivity(): void {
    if (this.activityStopped || this.sessionActivityState === "running") return;
    const wasWaiting = this.sessionActivityState === "idle";
    this.sessionActivityState = "running";
    if (wasWaiting || this.activityStartedAt !== null) this.emitBackgroundTasks();
  }

  /** Stop/EOF releases process-owned activity, independently of the already
   * settled prompt. Buffered frames cannot resurrect it before the next send. */
  endActivity(): void {
    for (const [taskId, agent] of this.agentTasks) {
      if (agent.status === "in_progress")
        this.settleAgentTask(
          taskId,
          "failed",
          "Agent ended before reporting completion.",
        );
    }
    for (const [taskId, record] of [...this.taskRecords]) {
      if (!record.settlement) {
        this.settleTaskRecord(taskId, {
          status: "failed", providerStatus: "stopped",
          error: "Background task ended before reporting completion.",
        });
      }
    }
    for (const taskId of new Set([...this.liveBackgroundTasks.keys(), ...this.backgroundTasks.keys(), ...this.workflows.keys()])) {
      addBoundedSet(this.terminalTaskIds, taskId, MAX_BACKGROUND_TASK_LIFECYCLE);
    }
    this.activityStopped = true;
    this.sessionActivityState = null;
    this.activityStartedAt = null;
    this.backgroundTasks.clear();
    this.liveBackgroundTasks.clear();
    this.backgroundTaskOverflow = false;
    this.scheduledWakeups.clear();
    this.pendingScheduledWakeupReason = null;
    this.workflows.clear();
    this.emitBackgroundTasks();
    this.emitWorkflows();
  }

  /** Feed a parsed JSON event from Claude's stdout. */
  feed(event: unknown): boolean {
    if (!isObj(event) || typeof event.type !== "string") {
      this.onUnknown?.(event);
      return false;
    }
    // Markers can be added to a replayed frame; apply them BEFORE replay
    // suppression. Only identities previously observed by this query qualify.
    if (event.type === "assistant") this.retractMessages(event.supersedes);
    if (typeof event.uuid === "string" && this.retractedFrames.has(event.uuid)) return false;
    if (event.type === "assistant" && isObj(event.message) &&
        typeof event.message.id === "string" &&
        this.transcript.isReplay(event.message.id, typeof event.parent_tool_use_id === "string" ? event.parent_tool_use_id : "", typeof event.uuid === "string" ? event.uuid : undefined)) return false;
    if (event.type === "result" && event.parent_tool_use_id) return false;
    if (event.type === "conversation_reset" && typeof event.new_conversation_id === "string") {
      const key = typeof event.uuid === "string" ? event.uuid : event.new_conversation_id;
      if (!this.seenUsageResets.has(key)) {
        addBoundedSet(this.seenUsageResets, key, 2_000);
        this.queryUsage.reset();
        this.usageConversationId = event.new_conversation_id;
      }
      return true;
    }
    if (event.type === "result" && typeof event.uuid === "string") {
      if (this.seenResultIds.has(event.uuid)) return false;
      addBoundedSet(this.seenResultIds, event.uuid, 2_000);
    }
    const replayedStream = event.type === "stream_event" && isObj(event.event) &&
      this.transcript.isStreamReplay(event.event, typeof event.parent_tool_use_id === "string" ? event.parent_tool_use_id : "");
    const streamActivity = event.type === "stream_event" && isObj(event.event) &&
      ["message_start", "content_block_start", "content_block_delta"].includes(String(event.event.type));
    // Any non-system event means the API call got through (or the turn
    // settled) — the current retry burst, if any, is over. The next
    // api_retry starts a NEW burst and gets its own notice row.
    if (event.type !== "system") this.retryBurstNoticed = false;
    // Internal loop wake-ups can begin without passing through adapter.prompt.
    // Child output and user/tool-result echoes do not prove the parent resumed.
    if (
      !this.activityStopped &&
      !event.parent_tool_use_id &&
      !replayedStream &&
      (event.type === "assistant" || streamActivity)
    ) {
      this.resumeActivity();
    }
    switch (event.type) {
      case "system":
        this.onSystem(event as unknown as ClaudeSystemEvent);
        break;
      case "user":
        this.onUser(event as unknown as ClaudeMessageEvent);
        break;
      case "assistant":
        this.onAssistant(event as unknown as ClaudeMessageEvent);
        break;
      case "stream_event":
        this.onStreamEvent(event as unknown as ClaudeStreamEvent);
        break;
      case "result":
        this.onResult(event as unknown as ClaudeResultEvent);
        break;
      default:
        this.onUnknown?.(event);
    }
    return !replayedStream && (event.type !== "stream_event" || streamActivity);
  }

  private retractMessages(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    const messageIds: string[] = [];
    const toolCallIds: string[] = [];
    for (const uuid of raw.slice(0, 4_000)) {
      if (typeof uuid !== "string" || this.retractedFrames.has(uuid)) continue;
      const frame = this.nativeFrames.get(uuid);
      if (!frame) continue;
      if (this.assistantFailureFrame === uuid) { this.assistantFailure = null; this.assistantFailureFrame = undefined; }
      addBoundedSet(this.retractedFrames, uuid, 8_000);
      const retired = this.transcript.retract(uuid);
      messageIds.push(...retired.messageIds);
      for (const tool of retired.tools) {
        const key = JSON.stringify([tool.parent, tool.id]);
        const state = this.scopedTools.get(key);
        if (state) { messageIds.push(state.id); addBoundedSet(this.retractedTools, key, 8_000); }
      }
      for (const key of frame.resultKeys) {
        const tool = this.scopedTools.get(key);
        if (tool?.resultFrameId !== uuid) continue;
        toolCallIds.push(tool.id);
        this.scopedTools.set(key, { ...tool, status: "pending", resultFrameId: undefined });
      }
    }
    if (messageIds.length) this.emit({ sessionId: this.sessionId, update: { sessionUpdate: "message_retraction", messageIds } });
    if (toolCallIds.length) this.emit({ sessionId: this.sessionId, update: { sessionUpdate: "tool_result_retraction", toolCallIds } });
  }

  private rememberFrame(event: ClaudeMessageEvent): void {
    if (event.uuid && !this.nativeFrames.has(event.uuid))
      setBoundedMap(this.nativeFrames, event.uuid, { parent: event.parent_tool_use_id ?? "", startedAt: this.modelTurnStartedAt, resultKeys: new Set() }, 4_000);
    if (event.request_id) {
      if (!this.requestStarts.has(event.request_id)) setBoundedMap(this.requestStarts, event.request_id, this.modelTurnStartedAt, 4_000);
      const parent = event.parent_tool_use_id ?? "";
      const previous = this.requestParents.get(event.request_id);
      setBoundedMap(this.requestParents, event.request_id, previous === undefined || previous === parent ? parent : null, 4_000);
    }
  }

  // ── Partial stream deltas (token-by-token) ──────────────
  //
  // Only active with `includePartialMessages: true`. Native message ids and
  // block indices keep partials and completed snapshots on the same row.
  // Full assistant blocks reconcile the row, including corrected text.
  private onStreamEvent(event: ClaudeStreamEvent): void {
    if (
      !event.parent_tool_use_id &&
      event.event?.type === "message_delta" &&
      !this.transcript.isStreamReplay(event.event, "")
    )
      this.parkBackgroundReply(event.event.delta?.stop_reason);
    if (!this.streamPartials || !event.event) return;
    const parent = event.parent_tool_use_id ?? "";
    if (!this.transcript.isStreamReplay(event.event, parent) && event.event.type === "content_block_start" && event.event.content_block?.type === "tool_use") {
      this.onAssistantTool(event.event.content_block, parent || undefined, this.toolCallIds.get(parent), true);
    }
    this.transcript.stream(event.event, parent, this.toolCallIds.get(parent));
  }

  /** Retrieve the last terminal reason the translator saw. Defaults
   *  to "end_turn" until a `result` event arrives. */
  get stopReason():
    | "end_turn"
    | "max_tokens"
    | "max_turn_requests"
    | "refusal"
    | "cancelled"
    | "budget_exhausted"
    | "blocking_limit"
    | "prompt_too_long" {
    switch (this.lastStopReason) {
      case "end_turn":
      case "max_tokens":
      case "max_turn_requests":
      case "refusal":
      case "cancelled":
      case "budget_exhausted":
      case "blocking_limit":
      case "prompt_too_long":
        return this.lastStopReason;
      default:
        return "end_turn";
    }
  }

  get sawResult(): boolean {
    return this.hasSeenResult;
  }

  /** Surfaced to the shared adapter so a stale-resume error carried by
   *  the result event (is_error + "No conversation found") becomes a real
   *  session-expired failure instead of a silent clean "refusal". */
  get terminalError(): string | null {
    return this.terminalErrorMsg;
  }

  get terminalFailure(): { message: string; code?: string } | null {
    return this.terminalErrorMsg
      ? { message: this.terminalErrorMsg, code: this.terminalErrorCode }
      : null;
  }

  /** Per-turn token/cost usage for LLM analytics. */
  get turnUsage(): TurnUsage | undefined {
    return this.currentTurnUsage;
  }

  // ── System init ─────────────────────────────────────────
  private onSystem(event: ClaudeSystemEvent): void {
    if (event.subtype === "init" && typeof event.session_id === "string") {
      if (this.usageConversationId && this.usageConversationId !== event.session_id) this.queryUsage.reset();
      this.usageConversationId = event.session_id;
      this.claudeSessionId = event.session_id;
    }
    if (event.subtype === "init" && typeof event.model === "string") {
      this.currentModel = event.model;
    }
    if (event.subtype === "task_started") this.onTaskStarted(event);
    if (event.subtype === "background_tasks_changed") {
      this.onBackgroundTasksChanged(event);
    }
    if (event.subtype === "task_progress") this.onTaskProgress(event);
    if (event.subtype === "task_updated") this.onTaskUpdated(event);
    if (event.subtype === "task_notification") {
      this.onTaskNotification(event);
    }
    if (event.subtype === "session_state_changed" && event.state && !this.activityStopped) {
      this.sessionActivityState = event.state;
      this.emitBackgroundTasks();
    }
    // `api_retry` — the CLI hit a retryable API error (network blip, 5xx,
    // overload) and is retrying the SAME call itself after a backoff delay.
    // The turn is still alive; nothing is lost. Surface ONE compact
    // error_notice row per burst so the user sees why the stream stalled
    // instead of a silent multi-minute shimmer. (SDKAPIRetryMessage shape:
    // attempt / max_retries / retry_delay_ms / error_status|null.)
    if ((event as { subtype?: string }).subtype === "api_retry") {
      this.onApiRetry(
        event as unknown as {
          max_retries?: number;
          error_status?: number | null;
        },
      );
    }
    // `status` — the CLI's live activity signal. `status:"compacting"`
    // opens the two-state compaction row ("Compacting.."); a later
    // `compact_result:"failed"` settles it as a visible failure with the
    // CLI's reason (wire-verified 2026-07-12: a too-small conversation
    // answers /compact with status:compacting → compact_result:"failed",
    // compact_error:"Not enough messages to compact." and NO boundary —
    // before this handler, all of it was dropped and /compact looked like
    // it did nothing). `compact_result:"success"` settles early when it
    // beats the boundary; the boundary then only merges its metadata.
    if ((event as { subtype?: string }).subtype === "status") {
      this.onStatus(
        event as unknown as {
          status?: string | null;
          compact_result?: string;
          compact_error?: string;
        },
      );
    }
    // `compact_boundary` — marks the exact seam where the CLI folded the
    // history (auto near the window limit, or manual /compact). Settles the
    // open row from `status:"compacting"` with trigger/preTokens metadata;
    // older CLIs that never emit status messages still get a directly-
    // settled row.
    if ((event as { subtype?: string }).subtype === "compact_boundary") {
      const meta = (
        event as unknown as {
          compact_metadata?: { trigger?: string; pre_tokens?: number };
        }
      ).compact_metadata;
      const rawInput = {
        ...(typeof meta?.trigger === "string" ? { trigger: meta.trigger } : {}),
        ...(typeof meta?.pre_tokens === "number"
          ? { preTokens: meta.pre_tokens }
          : {}),
      };
      if (this.pendingCompactionToolCallId) {
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: this.pendingCompactionToolCallId,
            title: "Context compacted",
            status: "completed",
            ...(Object.keys(rawInput).length > 0 ? { rawInput } : {}),
          },
        });
        // The boundary is the definitive settle — a second compaction in
        // the same run opens a fresh row.
        this.pendingCompactionToolCallId = null;
        this.pendingCompactionSettled = false;
      } else {
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: `compact-${randomUUID()}`,
            title: "Context compacted",
            kind: "compaction",
            status: "completed",
            rawInput,
          },
        });
      }
    }
    // The explicit native scope outranks model-name differences. Local
    // subagent/side-question fallbacks never change the parent selection.
    if ((event as { subtype?: string }).subtype === "model_refusal_fallback") {
      const ev = event as unknown as {
        original_model?: string;
        fallback_model?: string;
        uuid?: string;
        scope?: string;
        request_id?: string;
        retracted_message_uuids?: string[];
      };
      this.retractMessages(ev.retracted_message_uuids);
      const retractedIds = Array.isArray(ev.retracted_message_uuids) ? ev.retracted_message_uuids.slice(0, 4_000) : [];
      const candidates = new Set(retractedIds.flatMap((id) => {
        const frame = this.nativeFrames.get(id); return frame ? [frame.parent] : [];
      }));
      const nativeParent = ev.scope === "local"
        ? (ev.request_id ? this.requestParents.get(ev.request_id) : undefined) ?? (candidates.size === 1 ? [...candidates][0] : undefined)
        : undefined;
      this.emitModelSwitched({
        fromModel:
          typeof ev.original_model === "string" && ev.original_model.length <= 200 ? ev.original_model : null,
        toModel: typeof ev.fallback_model === "string" ? ev.fallback_model : "",
        reason: "refusal",
        scope: ev.scope === undefined || ev.scope === "session" ? "session" : "local",
        noticeId: (ev.request_id ? this.inferredFallbacks.get(ev.request_id) : undefined) ?? (typeof ev.uuid === "string" ? ev.uuid : undefined),
        nativeParent: nativeParent || undefined,
        turnStartedAt: (ev.request_id ? this.requestStarts.get(ev.request_id) : undefined) ?? this.modelTurnStartedAt,
      });
    }
    // `local_command_output` — a slash command's textual output (e.g.
    // /usage, /cost). The SDK docs say "displayed as assistant-style text";
    // dropping it made those commands look dead.
    if ((event as { subtype?: string }).subtype === "local_command_output") {
      const content = (event as unknown as { content?: unknown }).content;
      if (typeof content === "string" && content.trim().length > 0) {
        this.emit({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: content } as ContentBlock,
            messageId: randomUUID(),
          },
        });
        // Its own bubble — the next streamed text starts fresh.
        this.transcript.boundary();
      }
    }
    // Nothing else to emit to the UI — the init event is just bookkeeping.
  }

  /** Emit the current active set as one bounded, authoritative replacement. */
  private emitBackgroundTasks(): void {
    const scheduled = [...this.scheduledWakeups.values()].slice(
      0,
      MAX_ACTIVE_BACKGROUND_TASKS,
    );
    // Keep native ordering while reserving capacity for every visible
    // one-shot wake-up. Native membership may itself fill the provider cap;
    // appending then slicing would make the only specially-stoppable row
    // disappear exactly in that saturated case.
    const tasks = [
      ...[...this.backgroundTasks.values()].slice(
        0,
        MAX_ACTIVE_BACKGROUND_TASKS - scheduled.length,
      ),
      ...scheduled,
    ];
    const waiting = this.sessionActivityState === "idle" && tasks.length > 0;
    const activity = this.activityStartedAt !== null && this.sessionActivityState
      ? { state: this.sessionActivityState, startedAt: this.activityStartedAt }
      : null;
    if (
      this.lastEmittedBackgroundTasks &&
      this.lastEmittedBackgroundTasks.waiting === waiting &&
      this.lastEmittedBackgroundTasks.activity?.state === activity?.state &&
      this.lastEmittedBackgroundTasks.activity?.startedAt === activity?.startedAt &&
      sameBackgroundTaskList(this.lastEmittedBackgroundTasks.tasks, tasks)
    ) {
      return;
    }
    this.lastEmittedBackgroundTasks = { tasks, waiting, activity };
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "background_tasks_update",
        tasks,
        waiting,
        ...(activity || this.activityStopped ? { activity } : {}),
      },
    });
  }

  /** Emit one authoritative, bounded replacement of foreground workflows. */
  private emitWorkflows(): void {
    const workflows = [...this.workflows.values()].filter(
      (workflow) => !this.ambientTaskIds.has(workflow.taskId),
    ).slice(
      0,
      MAX_ACTIVE_BACKGROUND_TASKS,
    );
    if (
      this.lastEmittedWorkflows &&
      sameWorkflowList(this.lastEmittedWorkflows, workflows)
    ) {
      return;
    }
    this.lastEmittedWorkflows = workflows;
    this.emit({
      sessionId: this.sessionId,
      update: { sessionUpdate: "workflow_progress_update", workflows },
    });
  }

  private onTaskStarted(event: ClaudeSystemEvent): void {
    if (!event.task_id || this.activityStopped) return;
    const agentToolId =
      event.tool_use_id && this.toolCallIds.get(event.tool_use_id);
    if (
      agentToolId &&
      event.task_type === "local_agent" &&
      !this.agentTasks.has(event.task_id)
    ) {
      setBoundedMap(
        this.agentTasks,
        event.task_id,
        { toolCallId: agentToolId, status: "in_progress" },
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    }
    const priorEnd = this.agentTaskEnds.get(event.task_id);
    if (priorEnd)
      this.settleAgentTask(event.task_id, priorEnd.status, priorEnd.error);
    if (this.terminalTaskIds.has(event.task_id)) return;
    addBoundedSet(this.taskStartedIds, event.task_id, MAX_BACKGROUND_TASK_LIFECYCLE);
    if (event.skip_transcript) addBoundedSet(this.skippedTaskRecords, event.task_id, MAX_BACKGROUND_TASK_LIFECYCLE);
    const ambient = this.taskIsAmbient(event);
    if (!this.hasBackgroundTaskSnapshot && (ambient || event.is_backgrounded)) {
      this.trackBackgroundOwnership(event.task_id, ambient);
    }
    if (ambient) {
      addBoundedSet(this.ambientTaskIds, event.task_id, MAX_BACKGROUND_TASK_LIFECYCLE);
      this.backgroundTasks.delete(event.task_id);
      this.emitBackgroundTasks();
      if (this.workflows.has(event.task_id)) this.emitWorkflows();
      return;
    }
    if (event.task_type === "local_workflow") {
      const now = Date.now();
      const previous = this.workflows.get(event.task_id);
      const candidate: WorkflowProgress = {
        taskId: event.task_id,
        name:
          pickFirstString(
            event.workflow_name,
            event.description,
            previous?.name,
          ) ?? `Workflow ${event.task_id}`,
        status: this.pausedTaskIds.has(event.task_id)
          ? "paused"
          : (previous?.status ?? "running"),
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
        phases: previous?.phases ?? [],
      };
      if (!previous || !sameWorkflowContents(previous, candidate)) {
        setBoundedMap(
          this.workflows,
          event.task_id,
          candidate,
          MAX_ACTIVE_BACKGROUND_TASKS,
        );
        this.emitWorkflows();
      }
      return;
    }
    const now = Date.now();
    const tool = event.tool_use_id
      ? this.toolInputs.get(event.tool_use_id)
      : undefined;
    const command = tool?.command;
    const previous = this.backgroundTasks.get(event.task_id);
    const previousMetadata = this.backgroundTaskMetadata.get(event.task_id);
    const name =
      pickFirstString(
        event.description,
        tool?.description,
        previous?.name,
        previousMetadata?.name,
        command,
        event.prompt,
      ) ?? `Task ${event.task_id}`;
    const metadata: BackgroundTask = {
      taskId: event.task_id,
      name,
      taskType:
        event.task_type ?? previous?.taskType ?? previousMetadata?.taskType,
      startedAt: previousMetadata?.startedAt ?? previous?.startedAt ?? now,
      updatedAt: now,
      ...(command
        ? { command }
        : previousMetadata?.command
          ? { command: previousMetadata.command }
          : {}),
      ...(previousMetadata?.summary
        ? { summary: previousMetadata.summary }
        : {}),
      ...(previousMetadata?.lastToolName
        ? { lastToolName: previousMetadata.lastToolName }
        : {}),
    };
    setBoundedMap(
      this.backgroundTaskMetadata,
      event.task_id,
      metadata,
      MAX_BACKGROUND_TASK_LIFECYCLE,
    );
    if (previous || (event.is_backgrounded && this.acceptsBackgroundEdge(event.task_id))) {
      const candidate = {
        ...previous,
        ...metadata,
        startedAt: previous?.startedAt ?? metadata.startedAt,
        updatedAt: now,
      };
      const activeTask = previous && sameBackgroundTaskContents(previous, candidate)
        ? previous
        : candidate;
      setBoundedMap(this.backgroundTasks, event.task_id, activeTask, MAX_ACTIVE_BACKGROUND_TASKS);
      addBoundedSet(this.observedBackgroundTaskIds, event.task_id, MAX_BACKGROUND_TASK_LIFECYCLE);
      this.emitBackgroundTasks();
      if (!event.skip_transcript) {
        this.ensureBackgroundTaskRecord(event.task_id, activeTask);
      }
    }
  }

  /** Open the durable lifecycle row only after an authoritative background
   * membership/transition proves this is background work. `task_started`
   * also covers foreground subagents and workflows. */
  private ensureBackgroundTaskRecord(
    taskId: string,
    task: BackgroundTask,
  ): void {
    if (this.skippedTaskRecords.has(taskId) || this.taskRecords.has(taskId)) {
      return;
    }
    const toolCallId = `background-task-${randomUUID()}`;
    setBoundedMap(
      this.taskRecords,
      taskId,
      { toolCallId },
      MAX_BACKGROUND_TASK_LIFECYCLE,
    );
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Background Task",
        kind: "background_task",
        status: "in_progress",
        rawInput: {
          taskId,
          name: task.name,
          ...(task.taskType ? { taskType: task.taskType } : {}),
          ...(task.command ? { command: task.command } : {}),
        },
      },
    });
  }

  private onBackgroundTasksChanged(event: ClaudeSystemEvent): void {
    if (this.activityStopped || !Array.isArray(event.tasks)) return;
    const now = Date.now();
    const next = new Map<string, BackgroundTask>();
    this.liveBackgroundTasks.clear();
    this.backgroundTaskOverflow = false;
    this.hasBackgroundTaskSnapshot = true;
    for (const incoming of event.tasks) {
      if (!incoming || typeof incoming.task_id !== "string" || !incoming.task_id || this.terminalTaskIds.has(incoming.task_id)) {
        continue;
      }
      const ambient = incoming.ambient === true ||
        (incoming.ambient == null && this.skippedTaskRecords.has(incoming.task_id));
      this.trackBackgroundOwnership(incoming.task_id, ambient);
      if (ambient) {
        addBoundedSet(this.ambientTaskIds, incoming.task_id, MAX_BACKGROUND_TASK_LIFECYCLE);
        continue;
      }
      // Membership is authoritative, including an ambient flag changing back.
      this.ambientTaskIds.delete(incoming.task_id);
      if (next.size >= MAX_ACTIVE_BACKGROUND_TASKS && !next.has(incoming.task_id)) continue;
      const previous = this.backgroundTasks.get(incoming.task_id);
      const metadata = this.backgroundTaskMetadata.get(incoming.task_id);
      const candidate: BackgroundTask = {
        taskId: incoming.task_id,
        name:
          pickFirstString(
            incoming.description,
            previous?.name,
            metadata?.name,
          ) ?? `Task ${incoming.task_id}`,
        taskType:
          incoming.task_type ?? previous?.taskType ?? metadata?.taskType,
        startedAt: previous?.startedAt ?? metadata?.startedAt ?? now,
        updatedAt: now,
        ...((previous?.command ?? metadata?.command)
          ? { command: previous?.command ?? metadata?.command }
          : {}),
        ...((previous?.summary ?? metadata?.summary)
          ? { summary: previous?.summary ?? metadata?.summary }
          : {}),
        ...((previous?.lastToolName ?? metadata?.lastToolName)
          ? { lastToolName: previous?.lastToolName ?? metadata?.lastToolName }
          : {}),
      };
      const task =
        previous && sameBackgroundTaskContents(previous, candidate)
          ? previous
          : candidate;
      next.set(incoming.task_id, task);
      addBoundedSet(
        this.observedBackgroundTaskIds,
        incoming.task_id,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
      setBoundedMap(
        this.backgroundTaskMetadata,
        incoming.task_id,
        task,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
      // If the start edge arrived first, it already told us whether this row
      // should be skipped. If the level arrived first, wait for that edge so
      // an ambient skip_transcript task cannot flash into history.
      if (this.taskStartedIds.has(incoming.task_id)) {
        this.ensureBackgroundTaskRecord(incoming.task_id, task);
      }
    }
    this.backgroundTasks.clear();
    for (const [taskId, task] of next) this.backgroundTasks.set(taskId, task);
    this.emitBackgroundTasks();
    if (this.workflows.size > 0) this.emitWorkflows();
  }

  private trackBackgroundOwnership(taskId: string, ambient: boolean): void {
    if (this.liveBackgroundTasks.size >= MAX_BACKGROUND_TASK_LIFECYCLE && !this.liveBackgroundTasks.has(taskId)) {
      this.backgroundTaskOverflow = true;
      return;
    }
    this.liveBackgroundTasks.set(taskId, ambient);
  }

  private acceptsBackgroundEdge(taskId: string): boolean {
    return !this.hasBackgroundTaskSnapshot || this.liveBackgroundTasks.has(taskId) || this.backgroundTasks.has(taskId);
  }

  private taskIsAmbient(event: ClaudeSystemEvent): boolean {
    if (this.hasBackgroundTaskSnapshot && event.task_id && this.liveBackgroundTasks.has(event.task_id)) {
      return this.liveBackgroundTasks.get(event.task_id)!;
    }
    return event.ambient === true || event.skip_transcript === true ||
      (event.task_id !== undefined && this.ambientTaskIds.has(event.task_id));
  }

  /** Hidden work still has a terminal lifecycle; omitting its row must not
   * omit cleanup or allow a late membership frame to resurrect it. */
  private endAmbientTask(event: ClaudeSystemEvent): void {
    const taskId = event.task_id!;
    this.liveBackgroundTasks.delete(taskId);
    this.backgroundTaskMetadata.delete(taskId);
    this.pausedTaskIds.delete(taskId);
    addBoundedSet(this.terminalTaskIds, taskId, MAX_BACKGROUND_TASK_LIFECYCLE);
    const failed = event.status === "failed" || event.status === "stopped" ||
      event.patch?.status === "failed" || event.patch?.status === "killed";
    this.settleAgentTask(taskId, failed ? "failed" : "completed", event.patch?.error);
    // If this task was visible before becoming ambient, settle its existing
    // row. Never create an inline row for work that was always hidden.
    if (this.taskRecords.has(taskId)) {
      this.settleTaskRecord(taskId, {
        status: failed ? "failed" : "completed",
        providerStatus: event.status ?? event.patch?.status,
        summary: event.summary,
        outputFile: event.output_file,
        durationMs: event.usage?.duration_ms,
        error: event.patch?.error,
      });
    }
    if (this.backgroundTasks.delete(taskId)) this.emitBackgroundTasks();
    if (this.workflows.delete(taskId)) this.emitWorkflows();
  }

  private onTaskProgress(event: ClaudeSystemEvent): void {
    if (!event.task_id || this.activityStopped || this.ambientTaskIds.has(event.task_id)) return;
    if (Array.isArray(event.workflow_progress)) {
      this.onWorkflowProgress(event);
    }
    const previous = this.backgroundTasks.get(event.task_id);
    const previousMetadata = this.backgroundTaskMetadata.get(event.task_id);
    if (!previous && !previousMetadata) return;
    const now = Date.now();
    const durationMs = event.usage?.duration_ms;
    const base = previous ?? previousMetadata!;
    const candidate: BackgroundTask = {
      ...base,
      // A duration lets an out-of-order progress edge recover a more accurate
      // start time than receipt time without ever moving it forwards.
      startedAt:
        typeof durationMs === "number"
          ? Math.min(base.startedAt, now - Math.max(0, durationMs))
          : base.startedAt,
      updatedAt: now,
      ...(event.description ? { summary: event.description } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.last_tool_name ? { lastToolName: event.last_tool_name } : {}),
    };
    const updated = sameBackgroundTaskContents(base, candidate)
      ? base
      : candidate;
    setBoundedMap(
      this.backgroundTaskMetadata,
      event.task_id,
      updated,
      MAX_BACKGROUND_TASK_LIFECYCLE,
    );
    if (previous) {
      this.backgroundTasks.set(event.task_id, updated);
      this.emitBackgroundTasks();
    }
  }

  private onWorkflowProgress(event: ClaudeSystemEvent): void {
    if (!event.task_id || !Array.isArray(event.workflow_progress)) return;
    // A terminal edge is authoritative even when a delayed level snapshot
    // arrives afterwards. Recreating the workflow here would make a finished
    // run visibly jump back to "running" until the next result boundary.
    if (this.terminalTaskIds.has(event.task_id)) return;
    const now = Date.now();
    const previous = this.workflows.get(event.task_id);
    const durationMs = event.usage?.duration_ms;
    const phaseTitles = new Map<number, string>();
    let currentPhaseIndex: number | null = null;
    for (const entry of event.workflow_progress) {
      if (entry.type !== "workflow_phase") continue;
      const index =
        typeof entry.index === "number" ? entry.index : phaseTitles.size;
      const title = pickFirstString(entry.title) ?? `Phase ${index + 1}`;
      phaseTitles.set(index, title);
    }

    // workflow_progress is a cumulative event prefix, not one row per live
    // helper. Keep only the latest transition for each phase-local agent so
    // start → progress → done still contributes exactly one to the total.
    const agents = new Map<
      number,
      Map<string, { state: string; failed: boolean }>
    >();
    let anonymousAgentIndex = 0;
    for (const entry of event.workflow_progress) {
      if (entry.type === "workflow_phase") {
        currentPhaseIndex =
          typeof entry.index === "number" ? entry.index : currentPhaseIndex;
        continue;
      }
      if (entry.type === "workflow_log") {
        if (typeof entry.message === "string" && entry.message.trim()) {
          this.emitWorkflowNarration(event.task_id, entry.message.trim());
        }
        continue;
      }
      if (entry.type !== "workflow_agent") continue;
      const phaseIndex =
        typeof entry.phaseIndex === "number"
          ? entry.phaseIndex
          : (currentPhaseIndex ?? 0);
      if (!phaseTitles.has(phaseIndex)) {
        phaseTitles.set(
          phaseIndex,
          pickFirstString(entry.phaseTitle) ?? `Phase ${phaseIndex + 1}`,
        );
      }
      const list = agents.get(phaseIndex) ?? new Map();
      const agentKey =
        typeof entry.index === "number"
          ? `index:${entry.index}`
          : typeof entry.label === "string" && entry.label.trim()
            ? `label:${entry.label.trim()}`
            : `anonymous:${anonymousAgentIndex++}`;
      list.set(agentKey, {
        state: typeof entry.state === "string" ? entry.state : "start",
        failed: entry.state === "error",
      });
      agents.set(phaseIndex, list);
    }

    const phases: WorkflowPhaseProgress[] = [...phaseTitles.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, title]) => {
        const phaseAgents = [...(agents.get(index)?.values() ?? [])];
        const completed = phaseAgents.filter(
          (agent) => agent.state === "done" || agent.state === "error",
        ).length;
        const failed = phaseAgents.some((agent) => agent.failed);
        const total = phaseAgents.length;
        const status: WorkflowPhaseProgress["status"] =
          total === 0
            ? "queued"
            : failed
              ? "failed"
              : completed === total
                ? "completed"
                : "running";
        return { index, title, completed, total, status };
      });

    const startedAt =
      typeof durationMs === "number"
        ? Math.min(previous?.startedAt ?? now, now - Math.max(0, durationMs))
        : (previous?.startedAt ?? now);
    const candidate: WorkflowProgress = {
      taskId: event.task_id,
      name:
        pickFirstString(
          event.workflow_name,
          event.description,
          previous?.name,
        ) ?? `Workflow ${event.task_id}`,
      status:
        this.pausedTaskIds.has(event.task_id) || previous?.status === "paused"
          ? "paused"
          : (previous?.status ?? "running"),
      startedAt,
      updatedAt: now,
      phases,
    };
    if (previous && sameWorkflowContents(previous, candidate)) return;
    setBoundedMap(
      this.workflows,
      event.task_id,
      candidate,
      MAX_ACTIVE_BACKGROUND_TASKS,
    );
    this.emitWorkflows();
  }

  /** Narrator fingerprints belong to ONE workflow RUN, not to the whole SDK
   * process: "exactly one durable row per line" must not stop a LATER workflow
   * that re-uses the task id (or repeats a line verbatim after this run
   * settled) from narrating at all. Dropped when the run leaves the live set. */
  private forgetWorkflowNarration(taskId: string): void {
    const prefix = `${taskId}${WORKFLOW_NARRATION_SEPARATOR}`;
    for (const fingerprint of this.workflowNarration) {
      if (fingerprint.startsWith(prefix)) {
        this.workflowNarration.delete(fingerprint);
      }
    }
  }

  private emitWorkflowNarration(taskId: string, message: string): void {
    const fingerprint = `${taskId}${WORKFLOW_NARRATION_SEPARATOR}${message}`;
    if (this.workflowNarration.has(fingerprint)) return;
    addBoundedSet(
      this.workflowNarration,
      fingerprint,
      MAX_BACKGROUND_TASK_LIFECYCLE,
    );
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `workflow-narration-${randomUUID()}`,
        title: "Workflow update",
        status: "completed",
        rawOutput: message,
      },
    });
  }

  private onTaskUpdated(event: ClaudeSystemEvent): void {
    if (!event.task_id || this.activityStopped) return;
    // Level and edge ordering is unspecified. Once either terminal bookend has
    // won, no later task_updated edge may mutate or reopen that lifecycle.
    if (this.terminalTaskIds.has(event.task_id)) return;
    const status = event.patch?.status;
    const terminal =
      status === "completed" || status === "failed" || status === "killed";
    if (this.taskIsAmbient(event)) {
      if (terminal) this.endAmbientTask(event);
      return;
    }
    if (status === "paused") {
      addBoundedSet(
        this.pausedTaskIds,
        event.task_id,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    } else if (status === "pending" || status === "running" || terminal) {
      this.pausedTaskIds.delete(event.task_id);
    }
    this.onWorkflowTaskUpdated(event);
    const previous = this.backgroundTasks.get(event.task_id);
    const previousMetadata = this.backgroundTaskMetadata.get(event.task_id);
    const explicitlyBackgrounded = event.patch?.is_backgrounded === true;
    if (explicitlyBackgrounded) {
      addBoundedSet(
        this.observedBackgroundTaskIds,
        event.task_id,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    }
    const transitionTask: BackgroundTask | undefined = explicitlyBackgrounded
      ? {
          taskId: event.task_id,
          name:
            event.patch?.description ||
            event.description ||
            previousMetadata?.name ||
            `Task ${event.task_id}`,
          taskType: event.task_type ?? previousMetadata?.taskType,
          startedAt: previousMetadata?.startedAt ?? Date.now(),
          updatedAt: Date.now(),
          ...(previousMetadata?.command
            ? { command: previousMetadata.command }
            : {}),
        }
      : undefined;
    const wasBackground =
      !!previous ||
      this.taskRecords.has(event.task_id) ||
      this.observedBackgroundTaskIds.has(event.task_id) ||
      explicitlyBackgrounded;
    if (explicitlyBackgrounded && !terminal && !previous && transitionTask && this.acceptsBackgroundEdge(event.task_id)) {
      if (!this.hasBackgroundTaskSnapshot) this.trackBackgroundOwnership(event.task_id, false);
      this.backgroundTasks.set(event.task_id, transitionTask);
      setBoundedMap(
        this.backgroundTaskMetadata,
        event.task_id,
        transitionTask,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
      if (this.taskStartedIds.has(event.task_id)) {
        this.ensureBackgroundTaskRecord(event.task_id, transitionTask);
      }
      this.emitBackgroundTasks();
    } else if (
      previous &&
      event.patch?.description &&
      previous.name !== event.patch.description
    ) {
      this.backgroundTasks.set(event.task_id, {
        ...previous,
        name: event.patch.description,
        updatedAt: Date.now(),
      });
      this.emitBackgroundTasks();
    }
    if (event.patch?.description && previousMetadata) {
      setBoundedMap(
        this.backgroundTaskMetadata,
        event.task_id,
        {
          ...previousMetadata,
          name: event.patch.description,
          updatedAt: Date.now(),
        },
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    }
    if (terminal || event.patch?.is_backgrounded === false) {
      this.liveBackgroundTasks.delete(event.task_id);
      if (this.backgroundTasks.delete(event.task_id))
        this.emitBackgroundTasks();
    }
    if (terminal) {
      this.settleAgentTask(
        event.task_id,
        status === "failed" || status === "killed" ? "failed" : "completed",
        event.patch?.error,
      );
      addBoundedSet(
        this.terminalTaskIds,
        event.task_id,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
      this.backgroundTaskMetadata.delete(event.task_id);
    }
    if (terminal && !this.skippedTaskRecords.has(event.task_id)) {
      const task = previous ?? previousMetadata ?? transitionTask;
      if (wasBackground && task) {
        this.ensureBackgroundTaskRecord(event.task_id, task);
        // Do not suppress a later task_notification: it owns output_file and
        // duration. settleTaskRecord merges that enrichment into this same
        // toolCallId and drops a semantically identical second bookend.
        this.settleTaskRecord(
          event.task_id,
          {
            status: status === "failed" ? "failed" : "completed",
            providerStatus: status === "killed" ? "stopped" : status,
            summary: event.patch?.description,
            error: event.patch?.error,
          },
          task,
        );
      }
    }
  }

  private onWorkflowTaskUpdated(event: ClaudeSystemEvent): void {
    if (!event.task_id) return;
    const previous = this.workflows.get(event.task_id);
    if (!previous && event.task_type !== "local_workflow") return;
    if (event.patch?.is_backgrounded === true) {
      this.forgetWorkflowNarration(event.task_id);
      if (this.workflows.delete(event.task_id)) this.emitWorkflows();
      return;
    }
    const providerStatus = event.patch?.status;
    const status: WorkflowProgress["status"] =
      providerStatus === "paused"
        ? "paused"
        : providerStatus === "completed"
          ? "completed"
          : providerStatus === "failed"
            ? "failed"
            : providerStatus === "killed"
              ? "killed"
              : providerStatus == null
                ? (previous?.status ?? (this.pausedTaskIds.has(event.task_id) ? "paused" : "running"))
                : "running";
    // This run is over: release its narrator fingerprints so a later workflow
    // (including one that re-uses this task id) narrates from scratch. The
    // snapshot itself stays until the turn boundary for its final counts.
    if (status !== "running" && status !== "paused") {
      this.forgetWorkflowNarration(event.task_id);
    }
    const now = Date.now();
    const candidate: WorkflowProgress = {
      taskId: event.task_id,
      name:
        pickFirstString(
          event.workflow_name,
          event.patch?.description,
          event.description,
          previous?.name,
        ) ?? `Workflow ${event.task_id}`,
      status,
      startedAt: previous?.startedAt ?? now,
      updatedAt: now,
      phases: (previous?.phases ?? []).map((phase) =>
        status === "completed"
          ? { ...phase, completed: phase.total, status: "completed" }
          : phase,
      ),
    };
    if (previous && sameWorkflowContents(previous, candidate)) return;
    setBoundedMap(
      this.workflows,
      event.task_id,
      candidate,
      MAX_ACTIVE_BACKGROUND_TASKS,
    );
    this.emitWorkflows();
  }

  private onTaskNotification(event: ClaudeSystemEvent): void {
    if (!event.task_id) return;
    if (this.taskIsAmbient(event)) {
      this.endAmbientTask(event);
      return;
    }
    const agentToolId =
      event.tool_use_id && this.toolCallIds.get(event.tool_use_id);
    const agentTool =
      event.tool_use_id && this.toolInputs.get(event.tool_use_id);
    if (
      agentToolId &&
      agentTool &&
      /^(Agent|Task)$/i.test(agentTool.name) &&
      !this.agentTasks.has(event.task_id)
    ) {
      setBoundedMap(
        this.agentTasks,
        event.task_id,
        { toolCallId: agentToolId, status: "in_progress" },
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    }
    this.settleAgentTask(
      event.task_id,
      event.status === "failed" || event.status === "stopped"
        ? "failed"
        : "completed",
      event.status === "completed" ? undefined : event.summary,
    );
    if (this.workflows.has(event.task_id)) {
      this.onWorkflowTaskUpdated({
        ...event,
        patch: {
          ...event.patch,
          status:
            event.status === "failed"
              ? "failed"
              : event.status === "stopped"
                ? "killed"
                : "completed",
        },
      });
    }
    // Keep the last level/edge metadata long enough to build a useful durable
    // row even if this completion bookend arrives without task_started (for
    // example after a transiently missed edge).
    const activeTask = this.backgroundTasks.get(event.task_id);
    const task = activeTask ?? this.backgroundTaskMetadata.get(event.task_id);
    const wasBackground =
      !!activeTask ||
      this.taskRecords.has(event.task_id) ||
      this.observedBackgroundTaskIds.has(event.task_id);
    addBoundedSet(
      this.terminalTaskIds,
      event.task_id,
      MAX_BACKGROUND_TASK_LIFECYCLE,
    );
    this.pausedTaskIds.delete(event.task_id);
    this.liveBackgroundTasks.delete(event.task_id);
    this.backgroundTaskMetadata.delete(event.task_id);
    if (this.backgroundTasks.delete(event.task_id)) this.emitBackgroundTasks();
    if (event.skip_transcript || this.skippedTaskRecords.has(event.task_id)) {
      return;
    }
    // task_started/task_notification also bookend foreground Task subagents.
    // Only the level signal or an explicit backgrounding edge opts a task into
    // this provider-neutral Background Task transcript.
    if (!wasBackground) return;
    if (this.notifiedTaskIds.has(event.task_id)) return;
    addBoundedSet(
      this.notifiedTaskIds,
      event.task_id,
      MAX_BACKGROUND_TASK_LIFECYCLE,
    );
    this.ensureBackgroundTaskRecord(
      event.task_id,
      task ?? {
        taskId: event.task_id,
        name: `Task ${event.task_id}`,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      },
    );
    this.settleTaskRecord(
      event.task_id,
      {
        status: event.status === "failed" ? "failed" : "completed",
        providerStatus: event.status,
        summary: event.summary,
        outputFile: event.output_file,
        durationMs: event.usage?.duration_ms,
      },
      task,
    );
  }

  private settleAgentTask(
    taskId: string,
    status: "completed" | "failed",
    error?: string,
  ): void {
    if (this.agentTaskEnds.get(taskId)?.status !== "failed") {
      setBoundedMap(
        this.agentTaskEnds,
        taskId,
        { status, error },
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    }
    const agent = this.agentTasks.get(taskId);
    if (!agent || agent.status === "failed" || agent.status === status) return;
    agent.status = status;
    agent.error = error;
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: agent.toolCallId,
        status,
        rawOutput: {
          status,
          ...(agent.model ? { resolvedModel: agent.model } : {}),
          ...(error ? { message: error } : {}),
        },
        ...(error
          ? {
              content: [
                { type: "content", content: { type: "text", text: error } },
              ],
            }
          : {}),
      },
    });
  }

  private settleTaskRecord(
    taskId: string,
    result: {
      status: "completed" | "failed";
      providerStatus?: string;
      summary?: string;
      error?: string;
      outputFile?: string;
      durationMs?: number;
    },
    task?: BackgroundTask,
  ): void {
    const existing = this.taskRecords.get(taskId);
    const previousSettlement = existing?.settlement;
    // Late success may enrich a stopped/failed row's output, never turn it
    // green after the owning activity was explicitly ended.
    const status = previousSettlement?.status === "failed" ? "failed" : result.status;
    const rawOutput = {
      ...previousSettlement?.rawOutput,
      status: previousSettlement?.status === "failed"
        ? previousSettlement.rawOutput.status
        : (result.providerStatus ?? result.status),
      ...(result.summary ? { summary: result.summary } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.outputFile ? { outputFile: result.outputFile } : {}),
      ...(typeof result.durationMs === "number"
        ? { durationMs: result.durationMs }
        : {}),
    };
    const settlement: SettledTaskRecord = {
      status,
      rawOutput,
    };
    if (
      existing &&
      previousSettlement &&
      sameSettledTaskRecord(previousSettlement, settlement)
    ) {
      return;
    }
    const toolCallId = existing?.toolCallId ?? `background-task-${randomUUID()}`;
    setBoundedMap(this.taskRecords, taskId, { toolCallId, settlement }, MAX_BACKGROUND_TASK_LIFECYCLE);
    if (existing) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: "Background Task",
          kind: "background_task",
          status,
          rawOutput,
        },
      });
      return;
    }
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Background Task",
        kind: "background_task",
        status,
        rawInput: {
          taskId,
          name: task?.name ?? `Task ${taskId}`,
          ...(task?.taskType ? { taskType: task.taskType } : {}),
          ...(task?.command ? { command: task.command } : {}),
        },
        rawOutput,
      },
    });
  }

  /** `system/status` — open/settle the compaction row (see onSystem). */
  private onStatus(event: {
    status?: string | null;
    compact_result?: string;
    compact_error?: string;
  }): void {
    if (event.status === "compacting") {
      if (this.pendingCompactionToolCallId) return; // already narrating one
      const toolCallId = `compact-${randomUUID()}`;
      this.pendingCompactionToolCallId = toolCallId;
      this.pendingCompactionSettled = false;
      const trigger = this.manualCompactionExpected ? "manual" : "auto";
      this.manualCompactionExpected = false;
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: "Compacting context",
          kind: "compaction",
          status: "in_progress",
          rawInput: { trigger },
        },
      });
      return;
    }
    if (!this.pendingCompactionToolCallId) return;
    if (event.compact_result === "failed") {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: this.pendingCompactionToolCallId,
          title: "Compaction failed",
          status: "failed",
          ...(typeof event.compact_error === "string" && event.compact_error
            ? { rawOutput: { error: event.compact_error } }
            : {}),
        },
      });
      this.pendingCompactionToolCallId = null;
      this.pendingCompactionSettled = false;
    } else if (
      event.compact_result === "success" &&
      !this.pendingCompactionSettled
    ) {
      // Early success signal — settle now; keep the id so the boundary
      // (usually right behind) can merge trigger/preTokens onto this row.
      this.pendingCompactionSettled = true;
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: this.pendingCompactionToolCallId,
          title: "Context compacted",
          status: "completed",
        },
      });
    }
  }

  /** Plain provider narration, keyed by native notice/request identity. A
   * later explicit notice can refine an inferred fallback in the same row. */
  private emitModelSwitched(info: {
    fromModel: string | null;
    toModel: string;
    reason: "overloaded" | "refusal";
    scope?: "local" | "session";
    noticeId?: string;
    nativeParent?: string;
    turnStartedAt?: number;
  }): void {
    if (!info.toModel.trim() || info.toModel.length > 200 || (/\s/.test(info.toModel) || [...info.toModel].some((char) => char.charCodeAt(0) < 32))) return;
    const signature = JSON.stringify([info.fromModel, info.toModel, info.scope ?? "local", info.reason, info.nativeParent]);
    const noticeId = info.noticeId ?? `legacy-${this.sessionId}-${this.fallbackGeneration}-${signature}`;
    if (this.fallbackNotices.get(noticeId) === signature) return;
    setBoundedMap(this.fallbackNotices, noticeId, signature, 4_000);
    if (!info.nativeParent && (info.scope !== "local" || info.reason === "overloaded")) this.fallbackNoticedThisTurn = true;
    const parentToolId = info.nativeParent ? this.toolCallIds.get(info.nativeParent) : undefined;
    if (info.nativeParent && !parentToolId) this.transcript.trackParent(info.nativeParent, `model-fallback-${noticeId}`);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "model_fallback", noticeId, provider: "claude",
        fromModel: info.fromModel, toModel: info.toModel, reason: info.reason,
        scope: info.scope ?? "local", ...(parentToolId ? { parentToolId } : {}),
        turnStartedAt: info.turnStartedAt ?? this.modelTurnStartedAt,
      },
    });
  }

  /** The silent overload swap: the only per-message trace is the
   *  assistant message's `model` field differing from the configured primary.
   *  Top-level messages only (subagents legitimately run other models), and
   *  only when a fallback was actually configured. */
  private maybeNoticeFallback(
    event: ClaudeMessageEvent,
    parentToolId: string | undefined,
  ): void {
    if (!this.fallbackArmed || this.fallbackNoticedThisTurn || parentToolId)
      return;
    const actual = event.message?.model;
    const expected = this.expectedModel;
    if (!actual || !expected || event.error || actual === "<synthetic>") return;
    // The configured id may carry the `[1m]` long-context suffix or lack the
    // dated-snapshot tail the wire reports — prefix-match the normalized id
    // so "claude-opus-4-8[1m]" matches "claude-opus-4-8-20260115".
    const prefix = expected.replace(/\[1m\]$/i, "");
    if (actual === expected || actual.startsWith(prefix)) return;
    const noticeId = event.request_id ? `request-${event.request_id}` : undefined;
    if (event.request_id && noticeId) setBoundedMap(this.inferredFallbacks, event.request_id, noticeId, 4_000);
    this.emitModelSwitched({
      fromModel: expected,
      toModel: actual,
      reason: "overloaded",
      scope: "local",
      noticeId,
    });
  }

  private onApiRetry(event: {
    max_retries?: number;
    error_status?: number | null;
  }): void {
    if (this.retryBurstNoticed) return;
    this.retryBurstNoticed = true;
    const status =
      typeof event.error_status === "number"
        ? `HTTP ${event.error_status}`
        : "connection error";
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "error_notice",
        noticeId: `claude-api-retry-${randomUUID()}`,
        severity: "warning",
        recoverable: true,
        // `code` drives the renderer's live treatment: while this row is the
        // streaming tail it renders as a shimmer + "Reconnecting agent"
        // instead of a warning row. The message is
        // the settled row's expandable record — kept SIMPLE by design (the
        // user can't act on retry mechanics; only the status hints why).
        code: "api_retry",
        message: `Temporary connection problem (${status}) — retrying automatically…`,
      },
    });
  }

  // ── User turn (tool results only) ───────────────────────
  //
  // In `claude -p --output-format stream-json`, a `{"type":"user"}`
  // event is NEVER a new user turn we should render. It is one of:
  //   1. Claude echoing back the prompt we just sent (the real user
  //      bubble is already shown optimistically by the renderer AND
  //      seeded into the transcript by the engine's persistUserPrompt,
  //      so re-emitting it produces a DUPLICATE user bubble).
  //   2. A tool_result wrapper (the result of a tool the assistant ran).
  //   3. A SUBAGENT's internal user turn — stamped with
  //      `parent_tool_use_id`. Emitting these as top-level
  //      user_message_chunks incorrectly presents a subagent's internal
  //      message as the user's message.
  //
  // So we NEVER emit a user_message_chunk from the live stream. We only
  // forward tool_result blocks (correlated by tool_use_id to the
  // tool_call we already emitted). For `type:"user"` stream events we
  // extract only tool_result blocks and never re-emit a user message. History
  // replay (history.ts) still renders prior user prompts for a cold
  // import; the LIVE stream must not.
  private onUser(event: ClaudeMessageEvent): void {
    this.rememberFrame(event);
    // A user event ends the previous assistant message logically — the
    // next assistant chunk should start a fresh bubble even if it's
    // text-only (e.g. tool result → assistant continues with more text).
    this.transcript.boundary(event.parent_tool_use_id ?? "");

    // `message.content` can be a plain STRING, not a block array — the SDK
    // emits string-content user messages (e.g. the continuation summary it
    // replays after a /compact). There's nothing to forward from those
    // (only tool_result blocks matter here), but `.filter` on a string
    // crashed the whole translate call ("blocks.filter is not a function",
    // observed 2026-07-12 running /compact on Claude).
    const content = event.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    // The envelope's `tool_use_result` (Claude Code's rich result) carries
    // `structuredPatch` for edit tools — real hunks with REAL file line
    // numbers. Surface just that field as rawOutput so the EditCard renders
    // the true patch (line numbers, correct collapse regions) instead of
    // re-diffing the input snippets from line 1. Only when this event holds
    // exactly ONE tool_result — the envelope field can't be attributed
    // across a batched result message. The rest of the rich result (e.g.
    // `originalFile`, the whole pre-edit file) is deliberately dropped:
    // rawOutput persists to SQLite per tool call.
    const resultCount = blocks.filter((b) => b.type === "tool_result").length;
    const structuredPatch =
      resultCount === 1 ? readStructuredPatch(event.tool_use_result) : null;

    // Tool results — emit as tool_call_update with completed status.
    // Suppressed tool_use_ids (currently TodoWrite — its tool_use was
    // already routed to a canonical `plan` notification) get skipped so
    // we don't leave an orphan tool message in the UI.
    for (const b of blocks) {
      if (b.type !== "tool_result") continue;
      const tool = b as unknown as ClaudeToolResultBlock;
      if (typeof tool.tool_use_id !== "string" || !tool.tool_use_id) continue;
      const nativeTool = this.toolInputs.get(tool.tool_use_id);
      const structuredTaskOutput =
        resultCount === 1 &&
        nativeTool &&
        /^(TaskCreate|TaskUpdate)$/i.test(nativeTool.name) &&
        isObj(event.tool_use_result)
          ? event.tool_use_result
          : null;
      if (nativeTool?.name === "ScheduleWakeup") {
        if (!tool.is_error && nativeTool.scheduledWakeup) {
          if (nativeTool.scheduledWakeup.stop) {
            this.clearScheduledWakeups();
          } else if (nativeTool.scheduledWakeup.reason) {
            this.pendingScheduledWakeupReason = {
              reason: nativeTool.scheduledWakeup.reason,
              promptFingerprint: nativeTool.scheduledWakeup.promptFingerprint,
              knownTaskIds: new Set(this.scheduledWakeups.keys()),
              scheduledFor: readScheduledWakeupResultTimestamp(
                event.tool_use_result,
              ),
            };
          }
        }
        this.toolInputs.delete(tool.tool_use_id);
      }
      if (this.suppressedToolUseIds.has(tool.tool_use_id)) {
        this.suppressedToolUseIds.delete(tool.tool_use_id);
        continue;
      }
      const key = JSON.stringify([event.parent_tool_use_id ?? "", tool.tool_use_id]);
      if (this.retractedTools.has(key)) continue;
      const previous = this.scopedTools.get(key);
      const agentResult =
        resultCount === 1 &&
        /^(Agent|Task)$/i.test(nativeTool?.name ?? "") &&
        isObj(event.tool_use_result)
          ? event.tool_use_result
          : null;
      const asyncAgent =
        !tool.is_error &&
        agentResult?.status === "async_launched" &&
        typeof agentResult.agentId === "string";
      if (
        previous?.status === "failed" ||
        (previous?.status === "completed" && !tool.is_error && !agentResult)
      )
        continue;
      const toolCallId = previous?.id ?? randomUUID();
      const knownAgent = asyncAgent
        ? this.agentTasks.get(agentResult.agentId as string)
        : undefined;
      const endedAgent = asyncAgent
        ? this.agentTaskEnds.get(agentResult.agentId as string)
        : undefined;
      const agent = endedAgent
        ? { ...knownAgent, ...endedAgent, toolCallId }
        : knownAgent;
      const status = tool.is_error
        ? "failed"
        : asyncAgent
          ? (agent?.status ?? "in_progress")
          : "completed";
      if (asyncAgent)
        setBoundedMap(
          this.agentTasks,
          agentResult.agentId as string,
          {
            ...agent,
            toolCallId,
            status,
            ...(typeof agentResult.resolvedModel === "string"
              ? { model: agentResult.resolvedModel }
              : {}),
          },
          MAX_BACKGROUND_TASK_LIFECYCLE,
        );
      setBoundedMap(
        this.scopedTools,
        key,
        {
          id: toolCallId,
          announced: previous?.announced ?? false,
          inputComplete: previous?.inputComplete,
          resultFrameId: event.uuid,
          status,
        },
        4_000,
      );
      if (event.uuid) this.nativeFrames.get(event.uuid)?.resultKeys.add(key);
      if (!event.parent_tool_use_id || !this.toolCallIds.has(tool.tool_use_id))
        this.toolCallIds.set(tool.tool_use_id, toolCallId);
      const content =
        !tool.is_error &&
        agentResult?.status === "completed" &&
        Array.isArray(agentResult.content)
          ? agentResult.content.flatMap((block) =>
              isObj(block) &&
              block.type === "text" &&
              typeof block.text === "string"
                ? [
                    {
                      type: "content" as const,
                      content: { type: "text" as const, text: block.text },
                    },
                  ]
                : [],
            )
          : toolResultContent(tool);
      if (
        event.parent_tool_use_id &&
        !this.toolCallIds.has(event.parent_tool_use_id)
      )
        this.transcript.trackParent(event.parent_tool_use_id, toolCallId);
      this.emit({
        sessionId: this.sessionId,
        update: {
          ...(previous ? { sessionUpdate: "tool_call_update" as const } : { sessionUpdate: "tool_call" as const, title: "Tool", kind: "other" as const, nativeToolCallId: tool.tool_use_id, ...(event.parent_tool_use_id && this.toolCallIds.get(event.parent_tool_use_id) ? { parentToolId: this.toolCallIds.get(event.parent_tool_use_id) } : {}) }),
          toolCallId,
          status,
          rawOutput: structuredPatch
            ? { structuredPatch }
            : agentResult
              ? {
                  ...agentResult,
                  status:
                    asyncAgent && status !== "in_progress"
                      ? status
                      : agentResult.status,
                  ...(typeof agentResult.resolvedModel === "string"
                    ? { resolvedModel: agentResult.resolvedModel }
                    : {}),
                  ...(agent?.error ? { message: agent.error } : {}),
                }
              : (structuredTaskOutput ?? tool.content),
          content: agent?.error
            ? [
                {
                  type: "content",
                  content: { type: "text", text: agent.error },
                },
              ]
            : !asyncAgent && content.length > 0
              ? content
              : null,
        },
      });
    }
  }

  // ── Assistant turn (thinking, text, tool_use) ───────────
  private onAssistant(event: ClaudeMessageEvent): void {
    this.rememberFrame(event);
    // Same string-content guard as onUser — never trust `content` to be an
    // array (a string would crash `.every`/iteration below).
    const rawContent = event.message?.content;
    const blocks = Array.isArray(rawContent) ? rawContent : [];
    // Only the parent's synthetic SDK error can classify its final result.
    // Child tool errors and an earlier recovered attempt must not poison it.
    if (!event.parent_tool_use_id) {
      this.assistantFailureFrame = event.error ? event.uuid : undefined;
      this.assistantFailure = event.error
        ? { code: event.error, message: blocks.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n") }
        : null;
    }
    // When Claude routes a Task subagent's emissions
    // through the parent stream, every event in this assistant chunk
    // is stamped with `parent_tool_use_id` pointing at the Task tool's
    // tool_use_id. We translate that to the parent's Zeros-side tool
    // id (so the renderer can match it against the SubagentCard's
    // toolCallId) and propagate it onto every emitted update.
    const claudeParentId = event.parent_tool_use_id ?? undefined;
    const parentToolId = claudeParentId
      ? this.toolCallIds.get(claudeParentId)
      : undefined;

    // Did a fallback model answer this message? Checked before the
    // blocks render so the "Model switched" record lands where the swap
    // happened, ahead of the fallback model's own output.
    this.maybeNoticeFallback(event, claudeParentId ?? parentToolId);

    this.transcript.complete(
      event.message?.id,
      blocks,
      claudeParentId ?? "",
      parentToolId,
      (index) =>
        this.onAssistantTool(blocks[index], claudeParentId, parentToolId),
      event.uuid,
    );
    if (!event.error)
      this.transcript.endMessage(
        event.message?.stop_reason,
        claudeParentId ?? "",
        parentToolId,
        event.message?.id,
      );
    if (!claudeParentId) this.parkBackgroundReply(event.message?.stop_reason);
  }

  private parkBackgroundReply(stopReason?: string | null): void {
    // The SDK may hold Result until its background-agent loop exits. An
    // end_turn message parks the parent's reply while remaining tasks run;
    // it does not settle the outstanding send or invent a successful result.
    if (
      stopReason !== "end_turn" ||
      this.activityStopped ||
      !this.backgroundTasks.size
    )
      return;
    this.sessionActivityState = "idle";
    this.emitBackgroundTasks();
  }

  private onAssistantTool(block: ClaudeAssistantContentBlock, claudeParentId?: string, parentToolId?: string, partial = false): void {
    if (typeof block.id !== "string" || typeof block.name !== "string") return;
    const key = JSON.stringify([claudeParentId ?? "", block.id]);
    if (this.retractedTools.has(key)) return;
    const previous = this.scopedTools.get(key);
    if (previous?.announced && (partial || previous.inputComplete !== false)) return;
    const toolCallId = previous?.id ?? randomUUID();
    setBoundedMap(this.scopedTools, key, { id: toolCallId, announced: true, inputComplete: !partial, resultFrameId: previous?.resultFrameId, status: previous?.status ?? "in_progress" }, 4_000);
    if (!claudeParentId || !this.toolCallIds.has(block.id)) this.toolCallIds.set(block.id, toolCallId);
    if (claudeParentId && !parentToolId) this.transcript.trackParent(claudeParentId, toolCallId);
    const retainedInput = retainToolInput(block.name, block.input);
    if (retainedInput) {
      setBoundedMap(
        this.toolInputs,
        block.id,
        retainedInput,
        MAX_BACKGROUND_TASK_LIFECYCLE,
      );
    }
    // mergeKey collapses consecutive Edit/Write calls
    // against the same file into one card with "+N more changes"
    // history. Path is the only stable group key the renderer needs.
    const mergeKey = computeMergeKey(block.name, block.input);
    this.emit({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: previous ? "tool_call_update" : "tool_call",
        toolCallId,
        // Claude's own tool_use id. Blocking-interaction requests
        // (AskUserQuestion → QuestionRequest.toolCallId, canUseTool
        // permissions) reference THIS id, not our minted uuid — the
        // renderer correlates them to this row through it.
        nativeToolCallId: block.id,
        title: describeTool(block.name, block.input),
        kind: mapToolKind(block.name),
        status: previous?.status ?? "in_progress",
        rawInput: block.input,
        ...(mergeKey ? { mergeKey } : {}),
        ...(parentToolId ? { parentToolId } : {}),
      },
    });
    this.transcript.attachParent(block.id, toolCallId);
  }

  // ── Result (final) ──────────────────────────────────────
  private onResult(event: ClaudeResultEvent): void {
    if (event.subtype === "success" && event.is_error !== true && !event.errors?.length) this.transcript.final(event.result, event.uuid);
    this.hasSeenResult = true;
    if (!this.activityStopped) {
      this.sessionActivityState = "idle";
      if (this.activityStartedAt !== null || this.lastEmittedBackgroundTasks) this.emitBackgroundTasks();
    }
    // Turn boundary — any text after this should bubble separately.
    this.transcript.boundary();
    let removedWorkflow = false;
    for (const [taskId, workflow] of this.workflows) {
      if (workflow.status === "running" || workflow.status === "paused") continue;
      this.workflows.delete(taskId);
      this.forgetWorkflowNarration(taskId);
      this.pausedTaskIds.delete(taskId);
      removedWorkflow = true;
    }
    if (removedWorkflow) {
      this.emitWorkflows();
    }
    // A result settles the parent turn, not every process-owned workflow.
    // Preserve pause state and narrator dedupe until native task termination.
    // A compaction row that never got its definitive settle (success-status
    // with no boundary, or a run cut short) must not leak into the next
    // run — a later compaction opens its own row. If it settled we just
    // drop the reference; if it's still in_progress, close it out so the
    // spinner can't shimmer forever.
    if (this.pendingCompactionToolCallId && !this.pendingCompactionSettled) {
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: this.pendingCompactionToolCallId,
          title: "Context compacted",
          status: "completed",
        },
      });
    }
    this.pendingCompactionToolCallId = null;
    this.pendingCompactionSettled = false;
    // A manual-compact expectation that never materialised must not
    // mislabel a later AUTO compaction as user-initiated.
    this.manualCompactionExpected = false;
    // Reset the terminal-error capture at the START of every result so it
    // reflects ONLY this turn. The SDK adapter reuses ONE translator for the
    // whole session (persistent query()), and the adapter reads
    // `terminalError` after each result to classify auth-required /
    // session-expired. If we left a prior turn's error string in place, a
    // later SUCCESSFUL turn would re-match AUTH_RX/SESSION_EXPIRED and be
    // wrongly rejected — permanently poisoning the session. (The legacy
    // per-prompt adapter got a fresh translator each turn, so this never
    // surfaced there.)
    this.terminalErrorMsg = null;
    this.terminalErrorCode = undefined;
    const assistantFailure = this.assistantFailure;
    this.assistantFailure = null;
    // A new turn retries the primary model; a fresh fallback gets
    // its own "Model switched" record.
    this.fallbackNoticedThisTurn = false;
    this.fallbackGeneration++;
    // Named endings first: the SDK's subtype/terminal_reason carry
    // structured stop causes that must NOT degrade into a generic "refusal"
    // (they'd render as an error toast) or a clean "end_turn" (a truncated
    // answer masquerading as finished). Checked BEFORE is_error because the
    // budget/blocking results arrive as SDKResultError with is_error set.
    const terminalReason =
      typeof event.terminal_reason === "string" ? event.terminal_reason : null;
    const mappedTerminalReason = mapClaudeTerminalReason(terminalReason);
    const captureTerminalError = () => {
      const raw =
        Array.isArray(event.errors) &&
        event.errors.some((error) => typeof error === "string" && error.trim())
          ? event.errors
              .filter((error) => typeof error === "string" && error.trim())
              .join("\n")
          : typeof event.result === "string" && event.result.trim()
            ? event.result
            : assistantFailure?.message || (typeof event.subtype === "string"
              ? event.subtype
              : "");
      this.terminalErrorMsg = raw || "claude turn ended with an error";
      this.terminalErrorCode = assistantFailure?.code;
    };
    if (
      event.subtype === "error_max_budget_usd" ||
      mappedTerminalReason === "budget_exhausted"
    ) {
      // The user's own spend cap ended the turn cleanly. Record it
      // as the "Turn stopped · BUDGET" tool call right above the footer (the
      // card replaces a footer pill — it already names the ending).
      this.lastStopReason = "budget_exhausted";
      this.emit({
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `budget-stop-${randomUUID()}`,
          title: "Turn stopped",
          kind: "budget_stop",
          status: "completed",
          rawInput: {
            ...(typeof this.budgetCapUsd === "number" && this.budgetCapUsd > 0
              ? { capUsd: this.budgetCapUsd }
              : {}),
            scope: "claude",
          },
        },
      });
    } else if (
      event.subtype === "error_max_turns" ||
      mappedTerminalReason === "max_turn_requests"
    ) {
      this.lastStopReason = "max_turn_requests";
    } else if (
      mappedTerminalReason !== null &&
      mappedTerminalReason !== "end_turn"
    ) {
      this.lastStopReason = mappedTerminalReason;
      if (mappedTerminalReason === "refusal") captureTerminalError();
    } else if (event.is_error) {
      this.lastStopReason = "refusal";
      // Standard SDK failures use errors[]. Older results used result, and
      // synthetic assistant errors can supply the missing code/explanation.
      captureTerminalError();
    } else if (event.stop_reason === "max_tokens") {
      // The output-token cap cut the answer mid-thought. Was dead
      // code before: the result settled as a clean end_turn and the truncated
      // answer rendered as complete.
      this.lastStopReason = "max_tokens";
    } else if (mappedTerminalReason === "end_turn") {
      this.lastStopReason = "end_turn";
    } else {
      this.lastStopReason = "end_turn";
    }

    this.currentTurnUsage = this.queryUsage.record(event);
    if ((this.currentTurnUsage?.inputTokens ?? 0) > 0 || (event.usage?.input_tokens ?? 0) > 0) this.emit({ sessionId: this.sessionId, update: {
      sessionUpdate: "usage_update", size: contextWindowForClaudeModel(this.currentModel),
    } });
    // Context fill is refreshed independently by the adapter. Do not send
    // billed turn tokens as a context-window measurement.

  }
}

/** Per-model context window, delegated to the shared
 *  `claudeContextWindow` in @zeros/protocol so the engine's gauge fallback and the
 *  renderer's attachment budget can't drift apart again. The local copy this
 *  replaced granted 1M only to `/opus-4-[78].*\[1m\]/`, so Fable 5, Sonnet 5,
 *  and Opus 5 — all natively 1M — reported 200k here while the picker showed
 *  them as 1M models. See packages/protocol/src/model-context.ts for the
 *  registry-verified table and why Haiku is special-cased. */
function contextWindowForClaudeModel(model: string | null): number {
  return claudeContextWindow(model);
}

// ── helpers ──────────────────────────────────────────────

function retainToolInput(
  name: string,
  input: unknown,
): RetainedToolInput | null {
  const record = isObj(input) ? input : {};
  if (name === "ScheduleWakeup") {
    return {
      name,
      scheduledWakeup: {
        stop: record.stop === true,
        reason:
          typeof record.reason === "string"
            ? scheduledWakeupReason(record.reason)
            : null,
        promptFingerprint:
          typeof record.prompt === "string"
            ? fingerprintText(record.prompt)
            : null,
      },
    };
  }
  const command = pickFirstString(record.command, record.cmd, record.script);
  const description = pickFirstString(record.description);
  if (/^(TaskCreate|TaskUpdate)$/i.test(name)) {
    return {
      name,
      ...(description
        ? { description: description.slice(0, MAX_RETAINED_TOOL_TEXT) }
        : {}),
    };
  }
  if (!command && !description && !/^(Agent|Task)$/i.test(name)) return null;
  return {
    name,
    ...(command ? { command: command.slice(0, MAX_RETAINED_TOOL_TEXT) } : {}),
    ...(description
      ? { description: description.slice(0, MAX_RETAINED_TOOL_TEXT) }
      : {}),
  };
}

function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameSettledTaskRecord(
  a: SettledTaskRecord,
  b: SettledTaskRecord,
): boolean {
  return (
    a.status === b.status &&
    a.rawOutput.status === b.rawOutput.status &&
    a.rawOutput.summary === b.rawOutput.summary &&
    a.rawOutput.error === b.rawOutput.error &&
    a.rawOutput.outputFile === b.rawOutput.outputFile &&
    a.rawOutput.durationMs === b.rawOutput.durationMs
  );
}

function sameBackgroundTaskContents(
  a: BackgroundTask,
  b: BackgroundTask,
): boolean {
  return (
    a.taskId === b.taskId &&
    a.name === b.name &&
    a.taskType === b.taskType &&
    a.startedAt === b.startedAt &&
    a.command === b.command &&
    a.summary === b.summary &&
    a.lastToolName === b.lastToolName &&
    a.scheduledFor === b.scheduledFor
  );
}

function sameBackgroundTaskList(
  a: readonly BackgroundTask[],
  b: readonly BackgroundTask[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (task, index) =>
        sameBackgroundTaskContents(task, b[index]) &&
        task.updatedAt === b[index].updatedAt,
    )
  );
}

function sameWorkflowPhase(
  a: WorkflowPhaseProgress,
  b: WorkflowPhaseProgress,
): boolean {
  return (
    a.index === b.index &&
    a.title === b.title &&
    a.completed === b.completed &&
    a.total === b.total &&
    a.status === b.status
  );
}

/** Semantic comparison excludes updatedAt so repeated full provider frames do
 * not manufacture a new snapshot merely because they were received later. */
function sameWorkflowContents(
  a: WorkflowProgress,
  b: WorkflowProgress,
): boolean {
  return (
    a.taskId === b.taskId &&
    a.name === b.name &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.phases.length === b.phases.length &&
    a.phases.every((phase, index) => sameWorkflowPhase(phase, b.phases[index]))
  );
}

function sameWorkflowList(
  a: readonly WorkflowProgress[],
  b: readonly WorkflowProgress[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (workflow, index) =>
        sameWorkflowContents(workflow, b[index]) &&
        workflow.updatedAt === b[index].updatedAt,
    )
  );
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function pickFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function setBoundedMap<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  // Refresh insertion order when an existing lifecycle entry is observed so
  // eviction always removes the oldest task, not an active/recent one.
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function addBoundedSet<T>(set: Set<T>, value: T, limit: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value as T | undefined;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

/** The `structuredPatch` array from a Claude Code `tool_use_result` — jsdiff
 *  hunks (`{oldStart, oldLines, newStart, newLines, lines}`) with REAL file
 *  line numbers, present on Edit/Write/MultiEdit results. Null for any other
 *  shape so non-edit results keep their content-array rawOutput. */
function readStructuredPatch(result: unknown): unknown[] | null {
  if (!isObj(result)) return null;
  const sp = result.structuredPatch;
  if (!Array.isArray(sp) || sp.length === 0) return null;
  const valid = sp.every(
    (h) =>
      isObj(h) &&
      typeof h.oldStart === "number" &&
      typeof h.newStart === "number" &&
      Array.isArray(h.lines),
  );
  return valid ? sp : null;
}

function toolResultContent(
  result: ClaudeToolResultBlock,
): Array<{ type: "content"; content: ContentBlock }> {
  if (typeof result.content === "string") {
    const text = stripToolUseError(result.content);
    return text ? [{ type: "content", content: { type: "text", text } }] : [];
  }
  if (!Array.isArray(result.content)) return [];

  return result.content.flatMap<{
    type: "content";
    content: ContentBlock;
  }>((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      const text = stripToolUseError(block.text);
      return text
        ? [
            {
              type: "content" as const,
              content: { type: "text" as const, text },
            },
          ]
        : [];
    }
    const source = block.source;
    if (
      block.type === "image" &&
      source?.type === "base64" &&
      typeof source.data === "string" &&
      source.data.length > 0 &&
      typeof source.media_type === "string" &&
      source.media_type.startsWith("image/")
    ) {
      return [
        {
          type: "content" as const,
          content: {
            type: "image" as const,
            data: source.data,
            mimeType: source.media_type,
          },
        },
      ];
    }
    // Lenient tail, matching the pre-image behavior: an MCP server that emits
    // text under a wrapper type (or no type at all) still renders instead of
    // vanishing from the tool output.
    if (typeof block.text === "string") {
      const text = stripToolUseError(block.text);
      return text
        ? [
            {
              type: "content" as const,
              content: { type: "text" as const, text },
            },
          ]
        : [];
    }
    return [];
  });
}

function readScheduledWakeupResultTimestamp(
  result: unknown,
): number | undefined {
  if (!isObj(result)) return undefined;
  const scheduledFor = result.scheduledFor;
  return typeof scheduledFor === "number" && Number.isFinite(scheduledFor)
    ? scheduledFor
    : undefined;
}

/** Resolve the fixed five-field cron emitted for a one-shot wake-up. The
 * runtime uses local time. Wildcards/ranges are intentionally rejected: only
 * a pinned minute/hour/day/month plus wildcard weekday is exact enough for a
 * renderer warning. */
function scheduledWakeupTimestamp(
  schedule: string,
  now: number,
): number | undefined {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5 || fields[4] !== "*") return undefined;
  const [minuteText, hourText, dayText, monthText] = fields;
  if (
    !/^\d+$/.test(minuteText) ||
    !/^\d+$/.test(hourText) ||
    !/^\d+$/.test(dayText) ||
    !/^\d+$/.test(monthText)
  )
    return undefined;
  const minute = Number(minuteText);
  const hour = Number(hourText);
  const day = Number(dayText);
  const month = Number(monthText);
  if (
    minute < 0 ||
    minute > 59 ||
    hour < 0 ||
    hour > 23 ||
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12
  )
    return undefined;

  const currentYear = new Date(now).getFullYear();
  for (let year = currentYear; year <= currentYear + 1; year += 1) {
    const candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
    // Reject impossible dates and DST-normalized hours rather than warning on
    // a timestamp the provider did not actually describe.
    if (
      candidate.getFullYear() !== year ||
      candidate.getMonth() !== month - 1 ||
      candidate.getDate() !== day ||
      candidate.getHours() !== hour ||
      candidate.getMinutes() !== minute
    )
      continue;
    const timestamp = candidate.getTime();
    if (timestamp > now) return timestamp;
  }
  return undefined;
}

function scheduledWakeupReason(prompt: string): string | null {
  const reason = prompt.trim();
  if (!reason || /^<<[^>]+>>$/.test(reason)) return null;
  return reason.length > 120 ? `${reason.slice(0, 119).trimEnd()}…` : reason;
}

function scheduledWakeupName(schedule: string, reason: string | null): string {
  const fields = schedule.trim().split(/\s+/);
  const minute = Number.parseInt(fields[0] ?? "", 10);
  const hour = Number.parseInt(fields[1] ?? "", 10);
  const clock =
    Number.isInteger(minute) &&
    minute >= 0 &&
    minute <= 59 &&
    Number.isInteger(hour) &&
    hour >= 0 &&
    hour <= 23
      ? `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
      : schedule.trim();
  const base = clock ? `Next check at ${clock}` : "Next check";
  return reason ? `${base} · ${reason}` : base;
}

/** Claude wraps failed tool results in `<tool_use_error>…</tool_use_error>` —
 *  protocol plumbing meant for the model, not the user. Unwrap it so error
 *  rows show the plain message ("Unknown skill: foo") instead of raw XML.
 *  The failed status already carries the error semantics (is_error → the
 *  red status tone), so nothing is lost. */
function stripToolUseError(s: string): string {
  const m = s.match(/^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/);
  return m ? m[1].trim() : s;
}

/**
 * Short human-readable title for the tool-call pill. Matches the
 * phrasing the UI uses for ToolCall titles — "Reading file",
 * "Running shell command", etc.
 */
export function describeTool(name: string, input: unknown): string {
  const inp = isObj(input) ? input : {};
  switch (name) {
    case "Read":
    case "ReadFile":
      return `Reading ${inp.file_path ?? inp.path ?? "file"}`;
    case "Edit":
    case "Write":
    case "MultiEdit":
      return `Editing ${inp.file_path ?? inp.path ?? "file"}`;
    case "Bash":
      return `Running ${
        typeof inp.command === "string"
          ? truncate(inp.command, 60)
          : "shell command"
      }`;
    case "Glob":
      return `Searching for ${inp.pattern ?? "files"}`;
    case "Grep":
      return `Grep ${truncate(String(inp.pattern ?? ""), 40)}`;
    case "WebFetch":
      return `Fetching ${inp.url ?? "URL"}`;
    case "TodoWrite":
      return "Updating plan";
    case "Skill":
      return typeof inp.skill === "string" && inp.skill
        ? `Skill /${inp.skill}`
        : "Skill";
    case "ToolSearch": {
      const q = typeof inp.query === "string" ? inp.query : "";
      return q.startsWith("select:")
        ? `Loading ${q.slice("select:".length)}`
        : q
          ? `Finding tools: ${truncate(q, 40)}`
          : "Finding tools";
    }
    case "TaskCreate":
      return "Task Created";
    case "TaskUpdate": {
      const status = typeof inp.status === "string" ? inp.status : "";
      if (status === "in_progress") return "Task Started";
      if (status === "completed") return "Task Completed";
      if (status === "deleted") return "Task Deleted";
      return "Task Updated";
    }
    default:
      return name;
  }
}

/** mergeKey for collapsing repeated edits to one file
 *  into a single card with "+N more changes" history. Returns null
 *  for tools that shouldn't merge. */
function computeMergeKey(name: string, input: unknown): string | null {
  if (!/^(Edit|Write|MultiEdit)$/i.test(name)) return null;
  const path = isObj(input)
    ? typeof input.file_path === "string"
      ? input.file_path
      : typeof input.path === "string"
        ? input.path
        : null
    : null;
  if (!path) return null;
  return `edit:${path}`;
}

/** Coarse ToolKind categorization. */
export function mapToolKind(name: string): ToolKind {
  if (/^Read$/i.test(name)) return "read";
  if (/^LS$/i.test(name)) return "list";
  if (/^(Glob|Grep)$/i.test(name)) return "search";
  if (/^WebSearch$/i.test(name)) return "web_search";
  // MultiEdit applies several old→new replacements to one file; route it to
  // the same EditCard as Edit/Write (the renderer stacks the edits into a diff).
  if (/^(Edit|Write|MultiEdit)$/i.test(name)) return "edit";
  if (/^Bash$/i.test(name)) return "execute";
  if (/^WebFetch$/i.test(name)) return "fetch";
  // Claude Code 2.1.63 renamed `Task` → `Agent` for subagent dispatch
  // (https://github.com/anthropics/claude-code/releases). Match both so
  // the SubagentCard still fires on the rename — code that hard-coded
  // "Task" alone silently misses subagent invocations on newer Claude.
  if (/^(Task|Agent)$/i.test(name)) return "subagent";
  if (/^AskUserQuestion$/i.test(name)) return "question";
  // ExitPlanMode is Claude's "I'm done planning, please
  // approve and pick the next mode" tool. Routes to the dedicated
  // ExitPlanModeCard via canonical kind=switch_mode. Future agents
  // with similar plan-mode tools land here too.
  if (/^ExitPlanMode$/i.test(name)) return "switch_mode";
  // Skill = slash-command execution; ToolSearch = loading a deferred tool's
  // schema before calling it (the SDK defers rarely-used built-ins like
  // ExitPlanMode behind ToolSearch to save prompt tokens). Both get their own
  // kinds so event-meta can render a quiet labelled row instead of the
  // "other" fallback with raw JSON.
  if (/^Skill$/i.test(name)) return "skill";
  if (/^ToolSearch$/i.test(name)) return "tool_search";
  if (/^TaskCreate$/i.test(name)) return "task_create";
  if (/^TaskUpdate$/i.test(name)) return "task_update";
  // MCP-prefixed tool names: `mcp__<server>__<tool>`. Anthropic's
  // convention. Surface as `mcp` so the dedicated card renders.
  if (/^mcp__/i.test(name)) return "mcp";
  return "other";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
