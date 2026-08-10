// ──────────────────────────────────────────────────────────
// Agent session — type definitions + pure utilities
// ──────────────────────────────────────────────────────────
//
// This module used to export a `useAgentSession()` React hook that
// owned the whole session lifecycle. The lifecycle is now split into:
//   - `sessions-store.ts` — Zustand store + pure mutators
//   - `sessions-provider.tsx` — bridge wiring + side effects
//   - `sessions-hooks.ts` — `useChatSession(chatId)` / `useAgentSessions()`
// The hook was kept around for back-compat but never re-wired anywhere.
// 2026-05-28: confirmed dead by grep (only the definition matched
// `useAgentSession(`) and removed. This module now ONLY exports:
//   - type definitions (AgentSessionState / AgentMessage / etc.)
//   - `applyUpdate()` — pure SessionNotification → message-list folder
//   - `BLANK_USAGE` — initial token-usage struct
// All consumers import these via `import type {…}` or directly.
// ──────────────────────────────────────────────────────────

import type {
  AvailableCommand,
  BackgroundTask,
  ContentBlock,
  InitializeResponse,
  NewSessionResponse,
  QuestionRequest,
  QuestionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  StopReason,
  WorkflowProgress,
} from "../../platform/bridge/agent-events";
import type { BridgeRegistryAgent } from "../../platform/bridge/messages";
import type {
  ProviderBinding,
  ProviderMetadata,
} from "@zeros/protocol/identities";

// The agent message model + the pure SessionNotification→message folder moved to
// @zeros/protocol so the engine can run the same coalescer it does. Re-
// exported here so every existing `use-agent-session` import site is unchanged;
// imported below for this module's own session-state types.
export * from "@zeros/protocol/agent-messages";
import type {
  AgentMessage,
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "@zeros/protocol/agent-messages";

export interface PendingPermission {
  permissionId: string;
  agentId: string;
  request: RequestPermissionRequest;
}

export interface PendingQuestion {
  questionId: string;
  agentId: string;
  request: QuestionRequest;
}

export type SessionStatus =
  | "idle" // no agent bound yet
  | "warming" // agent initialize / newSession in flight, within budget
  | "ready" // session created, no prompt running
  | "streaming" // prompt turn in progress
  | "reconnecting" // transient loss; engine's respawn pool is reviving
  | "auth-required" // agent needs sign-in before we can connect
  | "failed"; // terminal error; user action needed

/** Token accounting accumulated from agent session notifications + turn
 *  completion. `size`/`used` come from `usage_update` notifications
 *  (context window view); `inputTokens`/`outputTokens` come from the
 *  PromptResponse.usage at turn end. */
export interface AgentUsage {
  /** Model's prompt context window in tokens. Informational only —
   *  This is not used in the headline ratio because
   *  `used` (tokens billed across the turn's tool-use loop) is *not*
   *  the same metric as "current window fill"; comparing the two
   *  produced 100%+ alarms on perfectly normal turns. */
  size: number;
  /** Tokens billed for the most recent turn (cumulative across the
   *  agent's internal tool-use loop). The headline pill renders
   *  this verbatim, no ratio. */
  used: number;
  /** Lifetime input tokens sent to the agent this session. */
  inputTokens: number;
  /** Lifetime output tokens emitted by the agent this session. */
  outputTokens: number;
  /** Cached token counts reported by the agent, when available. */
  cachedReadTokens: number;
  cachedWriteTokens: number;
  /** Tokens spent on reasoning / thought traces, when reported. */
  thoughtTokens: number;
  /** Cost in USD for the most recent turn, when the adapter reports
   *  it (Claude `result.total_cost_usd`). The UI surfaces this
   *  alongside the token count so users on metered plans see the
   *  per-turn dollar impact directly. */
  costUsd?: number;
  /** Per-category context breakdown for the gauge popover.
   *  Claude only (getContextUsage); absent for Codex → Used/Free rows. */
  categories?: Array<{ name: string; tokens: number }>;
}

export interface AgentSessionState {
  agentId: string | null;
  agentName: string | null;
  /** Canonical Zeros-owned ephemeral route. */
  executionId: string | null;
  /** @deprecated Compatibility alias for executionId. */
  sessionId: string | null;
  /** Durable provider resume identity; persisted on ChatThread, never used as
   * the live routing/cache key. */
  providerBinding: ProviderBinding | null;
  providerMetadata: ProviderMetadata | null;
  /** The chat's folder, captured
   *  on first ensureSession + restored on rebuilds. Without this, the
   *  silent-retry path called ensureSession({ force:true })
   *  with no cwd, the strict gateway threw "chat has no project folder
   *  bound", and the user saw the error pill on the third or fourth
   *  prompt of a working chat. Persisting the cwd on the slot ensures
   *  every rebuild lands in the same folder the chat started in. */
  cwd: string | null;
  initialize: InitializeResponse | null;
  session: NewSessionResponse | null;
  status: SessionStatus;
  /** Whether this chat's heavyweight transcript window is currently held in
   *  renderer memory. The bounded retained-view deck keeps recent chats
   *  `resident`; older chats become `cold` while their lightweight live
   *  session shell (routing, turn state, gates and background work) remains.
   *  `loading` is an explicit cold-read state so an empty array can never be
   *  mistaken for a genuinely new chat while SQLite is being rehydrated. */
  transcriptState: "resident" | "cold" | "loading";
  /** A durable transcript update arrived while the payload was cold/loading.
   *  Raw streaming deltas are deliberately not folded into an empty array;
   *  reopening performs an exact SQLite window read instead. */
  transcriptDirty: boolean;
  /** Durable-history hint retained after the message array is evicted. Used by
   *  close/discard and empty-state UI without keeping message objects alive. */
  hasTranscript: boolean;
  messages: AgentMessage[];
  /** True while the user has paged older history into memory (scroll-up
   *  auto-load). Suspends the live-append MAX_MESSAGES_PER_CHAT trim so a
   *  streaming event can't yank loaded history out from under the reader;
   *  cleared (and the trim re-applied) when they return to the bottom. */
  historyExpanded?: boolean;
  pendingPermission: PendingPermission | null;
  /** Concurrent provider/helper gates in arrival order. The UI deliberately
   * still renders ONE existing PermissionCard: `pendingPermission` is the head
   * mirror, and settling it advances to the next queue item. */
  pendingPermissions: PendingPermission[];
  /** Blocking user-input questions awaiting an answer, in arrival order. Only
   *  the head ([0]) renders; the rest surface one-by-one as it's answered. A
   *  queue (not a single slot) so a second question can't clobber the first. */
  pendingQuestions: PendingQuestion[];
  stderrLog: string[];
  /** Legacy free-form error message. Populated for `failed` state only —
   *  kept for backwards-compat with log viewers. Structured classification
   *  lives in `failure` and is the source of truth for UI routing. */
  error: string | null;
  /** Structured classification of the last failure. Drives the composer
   *  state chip, banner, and Sign-in button deterministically. Null
   *  whenever the session is warming/ready/streaming. */
  failure: import("../../platform/bridge/failure").AgentFailure | null;
  lastStopReason: StopReason | null;
  /** Engine-owned active-turn start. Restored by loadSession after a renderer
   * reload so an empty live tail does not restart its elapsed clock at 0s. */
  activeTurnStartedAt: number | null;
  /** Modes advertised by the agent at session creation, if any. */
  availableModes: SessionMode[];
  /** Currently active mode id (echoed back by session/set_mode and
   *  current_mode_update notifications). */
  currentModeId: string | null;
  /** Token accounting for the context pill + usage popover. */
  usage: AgentUsage;
  /** Slash-command palette advertised by the agent via
   *  `available_commands_update`. Used by the composer "/" picker. */
  availableCommands: AvailableCommand[];
  /** Subagent (custom-agent) catalog discovered on first prompt.
   *  Used by the composer subagent pill so users can delegate the
   *  turn to a specific child agent (e.g. Claude Task). */
  availableSubagents: import("../../platform/bridge/agent-events").AvailableSubagent[];
  /** Active background work owned by this exact session. Engine snapshots
   * replace the set; completed tasks move into persisted tool-call history. */
  backgroundTasks: BackgroundTask[];
  /** Foreground multi-agent workflows owned by this exact session. Full
   * engine snapshots replace this ephemeral list; narrator lines live in the
   * ordinary tool-call transcript instead. */
  workflows: WorkflowProgress[];
  /** Parent session is parked and waiting for the active task set to wake it. */
  waitingForBackgroundTasks: boolean;
  /** Start of the current continuous parked interval. Session-owned so a
   * retained-view eviction/remount cannot restart the visible timer. */
  backgroundTasksWaitingSince: number | null;
  /** Settings-drift guard (2026-07-13): JSON of the CHAT-derived env
   *  (envForChat — model/effort/fast/dirs) this session was actually created
   *  with (or last live-applied via updateConfig). sendPrompt compares it
   *  against the chat's CURRENT env before every prompt and force-respawns
   *  on mismatch, so a model picked while the session was warming — where
   *  the live setModel/updateConfig calls silently no-op — can never run a
   *  turn on the stale model (the "pill says Haiku, turn ran Opus" bug).
   *  Undefined = unknown (legacy slot) → the reconcile skips it. */
  appliedChatEnvKey?: string;
}

export interface StartSessionOptions {
  /** Display name to show in the chat header while the session is live. */
  agentName?: string;
  /** Env passed to the agent subprocess at spawn time (e.g. ANTHROPIC_API_KEY).
   *  When provided (e.g. from the AuthModal first-time setup), these wins
   *  over the Settings → Providers preset; otherwise the hook derives env
   *  from `provider-prefs.ts` for this agent. */
  env?: Record<string, string>;
  /** Optional CLI binary path override (Settings → Providers → Advanced).
   *  When omitted, the hook reads the saved preference for `agentId`. */
  cliBinary?: string;
}

export interface AgentSessionControls {
  /** Fetch the registry. Force=true refetches from CDN. */
  listAgents(force?: boolean): Promise<BridgeRegistryAgent[]>;
  /** Spawn the agent (if needed) and return its initialize response so the
   *  auth screen can render the advertised auth methods. Lets the UI honour
   *  whatever the agent tells us without hardcoding per-vendor methods. */
  initAgent(agentId: string): Promise<InitializeResponse>;
  /** Create a new session with the given agent id. */
  startSession(agentId: string, options?: StartSessionOptions): Promise<void>;
  /** Send a user prompt. Enqueues a user message immediately.
   *  `displayText` is what the UI shows (may contain @tokens); `text` is
   *  what goes over the wire (with mentions expanded). When omitted,
   *  `text` is used for both. Optional `attachments` are protocol ContentBlocks
   *  (e.g. images) appended to the prompt after the text block.
   *  Optional `bubbleAttachments` carry the chip-row metadata that
   *  the user-bubble renderer paints above the message text. */
  sendPrompt(
    text: string,
    displayText?: string,
    attachments?: ContentBlock[],
    bubbleAttachments?: AgentTextMessageAttachment[],
    /** Ordered composer content (text + inline pills) for the sent bubble. */
    segments?: MessageContentSegment[],
  ): Promise<void>;
  /** Cancel the in-flight prompt (if any). */
  cancel(): Promise<void>;
  /** Stop one background task without cancelling the foreground turn. */
  stopBackgroundTask(taskId: string): void;
  /** Resolve a pending permission request. */
  respondToPermission(response: RequestPermissionResponse): void;
  /** Answer the head pending question (queue front). */
  respondToQuestion(response: QuestionResponse): void;
  /** Change the agent session mode (calls `session/set_mode`). */
  setMode?(modeId: string): Promise<void>;
  /** Change the model of the live session without rebuilding it
   *  (fire-and-forget; Claude SDK → query.setModel). */
  setModel?(model: string): void;
  /** Run a real context compaction on the live session through
   *  Codex thread/compact/start; fire-and-forget, progress streams back
   *  as the two-state compaction row). */
  compactContext?(): void;
  /** Apply a config change (effort / fast / ultracode / additionalDirectories /
   *  allow-deny / maxTurns) to the live session without rebuilding it
   *  (fire-and-forget; carries the full composer env). */
  updateConfig?(): void;
  /** Remove a still-pending QUEUED send (by its placeholder message id)
   *  before it flushes — the user changed their mind. */
  removeQueued?(messageId: string): void;
  /** Replace a still-pending QUEUED send's full payload in place (by its
   *  placeholder message id) before it flushes. The payload rides the same
   *  send pipeline as a fresh prompt (wire text, display text, attachments,
   *  bubble segments). */
  editQueued?(
    messageId: string,
    payload: import("./sessions-context").QueuedEditPayload,
  ): void;
  /** "Send now" for a queued message: steers it into the RUNNING turn
   *  (adapters advertising `agentCapabilities.steering`) or flushes it
   *  immediately when the chat is idle. Resolves false when refused —
   *  the message stays queued. */
  steerQueued?(messageId: string): Promise<boolean>;
  /** Park the send queue while a queued message is being edited, so a turn
   *  settling mid-edit can't flush the edit target out from under the user. */
  holdQueue?(): void;
  /** Release a holdQueue park; drains the queue if the chat is idle+ready. */
  releaseQueue?(): void;
  /** Clear the session and return to idle. Does not kill the agent subprocess. */
  reset(): void;
}

export const BLANK_USAGE: AgentUsage = {
  size: 0,
  used: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  thoughtTokens: 0,
};
