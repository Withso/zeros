// ──────────────────────────────────────────────────────────
// Agent event types — wire format between engine + renderer
// ──────────────────────────────────────────────────────────
//
// Native event vocabulary owned by Zeros. Defines every shape
// the engine + renderer pass over the bridge — content blocks,
// tool calls, plan/mode/usage updates, permission flow.
// No external protocol dependency.
//
// Lives at the bridge layer because both processes consume them:
//   - engine (src/engine/agents/**) emits SessionNotification
//     payloads from each adapter's translator
//   - renderer (src/zeros/agent/**) folds them into the chat UI
//
// Shapes intentionally mirror what the engine adapters already
// emit — translators (Claude, Codex, Cursor) keep producing the
// same JSON; this module just gives us a type vocabulary we own.
//
// The import sites were migrated off the external SDK and the
// dependency was dropped from package.json — these are now the
// sole source for these types.
// ──────────────────────────────────────────────────────────

// ── Identifiers ─────────────────────────────────────────────

export type SessionId = string;
export type ToolCallId = string;
export type SessionModeId = string;
export type SessionModelId = string;

// ── Content blocks ──────────────────────────────────────────
//
// The basic unit of content inside a message chunk or tool-call
// payload. Mirrors the structure used by every adapter today.

export type ContentBlock =
  | TextContent
  | ImageContent
  | AudioContent
  | ResourceLinkContent
  | EmbeddedResourceContent;

export interface TextContent {
  type: "text";
  text: string;
  annotations?: ContentAnnotations;
}

export interface ImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
  uri?: string;
  annotations?: ContentAnnotations;
}

export interface AudioContent {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: ContentAnnotations;
}

export interface ResourceLinkContent {
  type: "resource_link";
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
  title?: string;
  annotations?: ContentAnnotations;
}

export interface EmbeddedResourceContent {
  type: "resource";
  resource: TextResourceContents | BlobResourceContents;
  annotations?: ContentAnnotations;
}

export interface TextResourceContents {
  uri: string;
  text: string;
  mimeType?: string;
}

export interface BlobResourceContents {
  uri: string;
  blob: string;
  mimeType?: string;
}

export interface ContentAnnotations {
  audience?: Array<"user" | "assistant">;
  lastModified?: string;
  priority?: number;
}

// ── Tool calls ──────────────────────────────────────────────

/** Canonical tool category. Adapters set this so the renderer can
 *  pick the right card without guessing from `title`.
 *
 *  Stage 4 added `web_search`, `mcp`, `subagent`, `question` so the
 *  registry's `toolByKind` dispatch covers Plan / Question / MCP /
 *  Subagent without falling back to the title-based matchers. */
export type ToolKind =
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
  // A Cursor `task` (subagent delegation) rendered as a RAW task card — its
  // Input/Output JSON plus the child's tool calls streamed live — distinct from
  // the Claude-style `subagent` SubagentCard. Cursor and Claude both name the
  // arg `subagent_type`, so the (translator-set) kind is the only reliable
  // discriminator between the two renderings.
  | "task"
  | "mcp"
  | "question"
  // Claude's Skill tool (slash-command execution) and ToolSearch (loading a
  // deferred tool's schema before calling it). Both are routine harness
  // mechanics — without their own kinds they render as "other" with raw
  // JSON, which reads as a failure to users.
  | "skill"
  | "tool_search"
  // Claude's durable task-list tools. These describe planned work and status;
  // they are distinct from provider-native background execution.
  | "task_create"
  | "task_update"
  // A Claude command, watcher, helper, workflow, or wake-up that continued
  // outside the foreground turn. Active instances live in the
  // session-level BackgroundTask snapshot below; this kind is the durable,
  // settled transcript record.
  | "background_task"
  // Context compaction (§3.5) — a first-class two-state row ("Compacting.."
  // → "Context compacted · Done"). Codex streams it from the
  // contextCompaction item lifecycle; Claude emits a settled row from
  // compact_boundary.
  | "compaction"
  // §3.6 R2 — the turn continued on a fallback model (primary overloaded /
  // unavailable / refused). A durable, expandable transcript record — the
  // "Model switched · FALLBACK" card — dropped inline wherever the swap
  // happened, since a fallback can fire mid-turn.
  | "model_switch"
  // §3.6 R3 — the per-turn budget cap ended the turn cleanly. Renders as the
  // "Turn stopped · BUDGET" card right above the footer; it replaces a footer
  // status pill (the card already names the ending).
  | "budget_stop"
  | "other";

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** Optional fields use `T | null | undefined` rather than `T | undefined`
 *  because the wire format carries `null` for cleared values (e.g. a
 *  tool-call update that resets `title` to nothing). Renderers/consumers
 *  treat both as absent. */
export interface ToolCall {
  toolCallId: ToolCallId;
  /** The vendor's own id for this call (Claude `toolu_…` tool_use id, Codex
   *  itemId). Translators mint their own `toolCallId` uuids, but blocking
   *  interaction requests (QuestionRequest / permission toolCall) carry the
   *  NATIVE id — this field is how the renderer correlates a request back to
   *  its timeline row (the question card's AWAITING/ANSWERED/SKIPPED states).
   *  Absent when the vendor id IS the toolCallId or none exists. */
  nativeToolCallId?: string | null;
  title: string;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  /** Optional grouping key. Tool calls sharing a mergeKey collapse
   *  in the renderer — the most recent renders normally, predecessors
   *  surface as "+N more changes" history under it. Currently used
   *  for `edit:<path>` so multiple Edit/Write calls to the same file
   *  collapse into one card per file. */
  mergeKey?: string | null;
  /** Roadmap §2.4.7 — set by adapters when this tool was invoked from
   *  inside a subagent context (Claude Task/Agent). The renderer renders
   *  these inside the parent SubagentCard's nested transcript instead of
   *  at the top level. */
  parentToolId?: string | null;
  /** Original event time (epoch ms). Set by transcript REPLAY so the
   *  renderer's durations/relative-times reflect when the turn actually
   *  ran, not when it was replayed. Live turns omit it and the reducer
   *  stamps Date.now(). */
  at?: number | null;
}

export interface ToolCallUpdate {
  toolCallId: ToolCallId;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  mergeKey?: string | null;
  /** Original completion time (epoch ms), set by transcript replay — see
   *  ToolCall.at. Omitted on live turns (reducer stamps Date.now()). */
  at?: number | null;
}

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "terminal"; terminalId: string };

// ── Session-level state ────────────────────────────────────

export interface SessionMode {
  id: SessionModeId;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: SessionModeId;
  availableModes: SessionMode[];
}

export interface ModelInfo {
  modelId: SessionModelId;
  name: string;
  description?: string;
}

export interface SessionModelState {
  currentModelId: SessionModelId;
  availableModels: ModelInfo[];
}

/** A model an adapter advertises to the renderer under `InitializeResponse.
 *  _meta.models`. This does NOT replace the curated `catalogs/models-v1.json`:
 *  the catalog drives WHICH models the picker shows, and these advertised models
 *  only OVERLAY per-model capabilities (effort ladder + fast) onto it — live for
 *  Claude/Codex/Cursor, a small constant for cold-start.
 *  `effortLevels` are plain strings (the renderer's ChatEffort values) so this
 *  core type stays free of renderer types; the renderer validates/coerces them.
 *  Companion `_meta` keys: `modelEnvVar` (env var the chosen model is written
 *  to) and `modelsDynamic: true` (this adapter fills `models` asynchronously
 *  after a runtime boots — the gateway re-polls `initialize` until present). */
export interface AdvertisedModel {
  value: string;
  label: string;
  badge?: string;
  /** Ordered reasoning-effort ladder (low→high). Omit when the model has no
   *  effort knob; the renderer then hides the EffortPill (or, absent any
   *  advertisement, falls back to its family default). */
  effortLevels?: string[];
  /** Whether this model supports Fast mode (drives the FastPill). */
  supportsFast?: boolean;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint: string };
  /** Whether this entry is an agent slash command or a skill (a SKILL.md /
   *  agent skill surfaced via the `/` syntax). Drives the composer picker's
   *  All / Commands / Skills tabs and the "skill" badge. ABSENT ⇒ treated as
   *  a command (the conservative default for any source that predates this
   *  field). */
  kind?: "command" | "skill";
}

// Curated built-in command tables + merge helpers. Re-exported here so the
// existing `@zeros/core/agent-events` + `../bridge/agent-events` import
// sites (engine and renderer) reach them with no new path wiring.
export {
  getBuiltinCommands,
  mergeCommands,
  composerCommandsFor,
  slashCommandKind,
} from "./builtin-commands";
export type { SlashCommandKind } from "./builtin-commands";

/** Audit doc 2026-05-23 §P1.3 — subagent (custom-agent) picker.
 *  Agents use markdown-frontmatter formats for custom agents
 *  (e.g. Claude `.claude/agents/*.md`). Discovery happens on
 *  first prompt; the renderer surfaces these as a composer pill so
 *  the user can delegate the turn to a specific subagent. */
export interface AvailableSubagent {
  /** Human / CLI-facing name (frontmatter `name` or basename). */
  name: string;
  /** One-line description (frontmatter `description` or first body
   *  line). Surfaces in the picker. */
  description: string;
  /** Optional restricted tool list. */
  tools?: string[];
  /** Optional preferred model id (per-subagent override). */
  model?: string;
}

export interface UsageCost {
  inputCostUsd?: number;
  outputCostUsd?: number;
  totalCostUsd?: number;
}

export interface UsageStats {
  size: number;
  used: number;
  cost?: UsageCost;
}

// ── Background work ──────────────────────────────────────

/** One task in the engine-authoritative set of background work owned by a
 * session. The set contains active tasks only. Providers can enrich fields as
 * lifecycle events arrive, but `taskId`, `name`, and `startedAt` are always
 * present so the renderer can key rows and tick elapsed time immediately. */
export interface BackgroundTask {
  /** Provider-native task/process id, scoped by the owning agent session. */
  taskId: string;
  /** Human-readable row label (description, command, condition, or reason). */
  name: string;
  /** Provider-native task category, intentionally open for forward compat. */
  taskType?: string;
  /** Epoch milliseconds. Preserved across metadata refreshes. */
  startedAt: number;
  /** Epoch milliseconds of the latest provider observation. */
  updatedAt: number;
  /** Raw command when the provider exposes it. Shown only in expanded history. */
  command?: string;
  /** Latest progress summary. Not rendered in the compact live card. */
  summary?: string;
  /** Latest tool name (Claude progress heartbeat), retained for inspection. */
  lastToolName?: string;
}

// ── Session updates (the streaming notification payload) ────
//
// Engine adapters emit these over the bridge as the chat unfolds.
// Each variant carries enough fields to drive its renderer.

export type SessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallStartUpdate
  | ToolCallChangeUpdate
  | AvailableCommandsUpdate
  | AvailableSubagentsUpdate
  | BackgroundTasksUpdate
  | CurrentModeUpdate
  | ModeSwitchUpdate
  | ErrorNoticeUpdate
  | UsageUpdateNotification
  | SessionInfoUpdateNotification
  | TurnStateUpdateNotification;

/** Engine-authored lifecycle notification for a provider turn. Unlike the
 * AGENT_PROMPT RPC response, this survives renderer reload/re-adoption because
 * it is routed as a session-scoped push to the current client. */
export interface TurnStateUpdateNotification {
  sessionUpdate: "turn_state";
  /** Opening user-message id; identical to the durable turn-row key. */
  turnId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  /** Epoch ms for restoring the live elapsed clock after renderer reload. */
  startedAt: number;
  /** Present on terminal states when the adapter supplied one. */
  stopReason?: StopReason | null;
}

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
  messageId?: string | null;
  /** Roadmap §2.4.7 — when a subagent emits text through this stream,
   *  the parent Task's toolCallId. Renderer hides the message from
   *  the top-level timeline and routes it into the SubagentCard. */
  parentToolId?: string | null;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
  messageId?: string | null;
  /** Roadmap §2.4.8 — Anthropic's `redacted_thinking` content blocks
   *  carry encrypted reasoning the model produced but won't surface
   *  in plaintext. The renderer shows a distinct "redacted" stub
   *  with no expandable body. Defaults to false / undefined for
   *  ordinary thinking chunks. */
  redacted?: boolean | null;
  /** Roadmap §2.4.7 — see same field on AgentMessageChunkUpdate. */
  parentToolId?: string | null;
}

export interface ToolCallStartUpdate extends ToolCall {
  sessionUpdate: "tool_call";
}

export interface ToolCallChangeUpdate extends ToolCallUpdate {
  sessionUpdate: "tool_call_update";
}

export interface AvailableCommandsUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AvailableCommand[];
}

export interface AvailableSubagentsUpdate {
  sessionUpdate: "available_subagents_update";
  availableSubagents: AvailableSubagent[];
}

/** Full REPLACE snapshot of active background work for one exact session.
 * Empty is authoritative and removes the live card. This deliberately is not
 * a message event: only settled task records belong in persisted history. */
export interface BackgroundTasksUpdate {
  sessionUpdate: "background_tasks_update";
  tasks: BackgroundTask[];
  /** True only when the parent session reports idle while work remains. */
  waiting: boolean;
}

export interface CurrentModeUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: SessionModeId;
}

/** Stage 4.4 — timeline-visible record of a mode change. Distinct from
 *  CurrentModeUpdate (which patches session state). The banner emitted
 *  for this event is what the user actually sees in their transcript:
 *  "─── Switched to Plan mode ──── 14:32 ───".
 *
 *  Sources we expect to fire this:
 *    - User toggles the PermissionsPill → source: "user"
 *    - Agent autonomously switches (Claude ExitPlanMode after user
 *      approval) → source: "agent"
 *
 *  axis discriminates phase (plan / execute / explore) from permission
 *  (manual / accept-edits / auto / bypass) from tier (reserved for
 *  future agents that expose a capability tier). Renderer uses it to
 *  pick the right verb. */
export interface ModeSwitchUpdate {
  sessionUpdate: "mode_switch";
  source: "user" | "agent";
  axis: "phase" | "permission" | "tier";
  /** Mode id you switched FROM. Optional because some agents only know
   *  the new state, not the previous one. */
  from?: string;
  /** Mode id you switched TO. Required. */
  to: string;
  /** Optional rationale (e.g. Claude ExitPlanMode plan summary).
   *  Rendered as a secondary line under the banner. */
  reason?: string;
  /** Wallclock ms — adapter sets this so the banner shows when the
   *  switch actually happened, not when our store ingested it. Defaults
   *  to Date.now() in the reducer if absent. */
  at?: number;
}

/** Free-standing adapter-level notice (transient retry, transport warning,
 *  API rejection) — folds into AgentErrorNoticeMessage so it renders as ONE
 *  compact timeline row per event (like Claude's per-attempt retry rows),
 *  never as prose glued into the agent's answer. `noticeId` keys the message
 *  so replay/persist stays deterministic; adapters mint one per event. */
export interface ErrorNoticeUpdate {
  sessionUpdate: "error_notice";
  noticeId: string;
  severity: "warning" | "error";
  message: string;
  /** True for transient/retryable notices where the active turn is expected
   *  to continue. These should never be treated as terminal failures. */
  recoverable?: boolean;
  /** Adapter-side error code for click-through/docs, when known. */
  code?: string;
  /** Wallclock ms — replay carries the original time; live omits and the
   *  reducer stamps Date.now(). */
  at?: number;
}

export interface UsageUpdateNotification {
  sessionUpdate: "usage_update";
  size: number;
  used: number;
  cost?: UsageCost;
  /** Per-category context-window breakdown for the composer gauge's
   *  popover (§3.5 Task C) — Claude fills it from the SDK's
   *  getContextUsage() (Messages, MCP tools, System prompt, …); agents
   *  whose protocol has no breakdown (Codex) omit it and the popover
   *  shows Used/Free only. Ordered as received; tokens are absolute. */
  categories?: Array<{ name: string; tokens: number }>;
}

export interface SessionInfoUpdateNotification {
  sessionUpdate: "session_info_update";
  title?: string;
  updatedAt?: string;
}

/** Top-level notification carried by AGENT_SESSION_UPDATE bridge
 *  messages. Maps `sessionId` to the session state it mutates. */
export interface SessionNotification {
  sessionId: SessionId;
  update: SessionUpdate;
}

// ── Permission flow ────────────────────────────────────────

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  // Persist the always-allow to the PROJECT (Claude → `.claude/settings.local.json`
  // via the SDK's `updatedPermissions`), as opposed to `allow_always` which is a
  // Zeros chat-scoped rule. Claude-only today; other adapters never emit it.
  | "allow_always_project"
  | "reject_once"
  | "reject_always";

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  sessionId: SessionId;
  toolCall: ToolCall;
  options: PermissionOption[];
  /** Vendor correlation id (SDK control request_id / Codex RequestId).
   *  Used by the renderer to dedupe a replayed request on reconnect — the
   *  SDK re-arms in-flight requests on initialize and the adapter mints a
   *  NEW permissionId for the SAME underlying request. Optional for
   *  back-compat; falls back to permissionId when absent. */
  nativeRequestId?: string;
}

/** Outcome of a permission prompt. Discriminator is the inner
 *  `outcome` string — read as `response.outcome.outcome`. The
 *  shape is awkward but matches the existing wire format the
 *  engine adapters already produce. */
export type RequestPermissionOutcome =
  | { outcome: "cancelled" }
  | { outcome: "selected"; optionId: string };

export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome;
}

// ── Question / user-input flow ─────────────────────────────
// A first-class BLOCKING interaction, twin of the permission flow. ONE card
// handles single-select, multi-select, free-text ("Type something…"), and
// MULTIPLE questions (carousel). The card always emits QuestionAnswer[]; each
// adapter reshapes it into the vendor's answer format. See
// docs/unified-question-card-plan-2026-07-02.md.

export interface QuestionOption {
  /** Stable id. Claude: synth `o${i}`. Codex: MUST equal `label` (the vendor
   *  answer is a label array, so labels ARE the ids). */
  id: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface QuestionSpec {
  /** Per-question id (Codex has real ids; Claude synth = `q${i}`). */
  id: string;
  prompt: string;
  header?: string;
  /** Per-vendor-derived. Claude: from the SDK boolean. Codex: no such flag →
   *  undefined (the card applies its per-vendor default). */
  multiSelect?: boolean;
  /** May be empty ONLY for a pure free-text ask (Codex options:null); never
   *  empty for Claude (schema guarantees ≥2). */
  options: QuestionOption[];
  /** Render the "0  Type something…" free-text last row. */
  allowOther: boolean;
  /** Codex isSecret → masked input; value never logged. */
  secret?: boolean;
}

export interface QuestionRequest {
  sessionId: SessionId;
  /** Adapter-minted uuid — the UI resolver key. */
  questionId: string;
  /** Vendor correlation id for replay dedup: Claude → SDK control request_id /
   *  toolUseID; Codex → JSON-RPC RequestId; else the questionId. */
  nativeRequestId: string;
  /** Native tool_use id / Codex itemId — co-locate/dedupe with the timeline. */
  toolCallId?: string;
  source: "native_dialog" | "native_rpc" | "inferred_from_text";
  /** true = a resolver is parked on the engine (block-and-resume); false =
   *  non-blocking fallback (answer delivered as the next prompt). */
  blocking: boolean;
  /** Epoch ms when the engine's response timeout fires and the question is
   *  auto-skipped (the agent proceeds with its default). Stamped by the
   *  adapter when it arms the timer; the card shows a countdown near expiry.
   *  Absent on adapters/versions that don't time out. */
  expiresAt?: number;
  /** 1..N — drives the carousel. */
  questions: QuestionSpec[];
}

export interface QuestionAnswer {
  /** Matches QuestionSpec.id. */
  questionId: string;
  /** Chosen option ids (multi → many; single → one; may be empty when only
   *  free-text was given). */
  selectedOptionIds: string[];
  /** "Other" / free-text value, if any. */
  freeText?: string;
}

export type QuestionOutcome =
  | { outcome: "answered"; answers: QuestionAnswer[] }
  | { outcome: "dismissed" };

export interface QuestionResponse {
  outcome: QuestionOutcome;
}

// ── Session lifecycle responses ────────────────────────────

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  // §3.6 R5/R3 — distinct terminal endings, mapped from the Claude SDK's
  // result subtype + terminal_reason so a truncated/limited answer never
  // masquerades as a finished one. budget_exhausted = the user's own spend
  // cap (R3, recoverable via Continue); blocking_limit = the provider's
  // usage limit blocked the turn; prompt_too_long = the conversation no
  // longer fits the model's window.
  | "budget_exhausted"
  | "blocking_limit"
  | "prompt_too_long";

/** §3.6 R6 — one model's share of a turn's bill (SDK `result.modelUsage`).
 *  A single Claude turn can span models (subagents on Haiku, an overload
 *  fallback) — this is the itemized row behind the footer's usage popover.
 *  No reasoning-token field by design (2026-07-13 decision): Anthropic folds
 *  thinking into outputTokens, so surfacing it for one agent only would be an
 *  inconsistent readout. */
export interface TurnModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
  /** Per-model breakdown when the agent reports one (Claude `modelUsage`).
   *  Absent for agents that bill as a single lump. */
  perModel?: TurnModelUsage[];
}

export interface PromptResponse {
  stopReason: StopReason;
  usage?: TurnUsage;
  userMessageId?: string;
}

export interface SessionInfo {
  sessionId: SessionId;
  cwd: string;
  title?: string;
  updatedAt?: string;
  additionalDirectories?: string[];
}

export interface NewSessionResponse {
  sessionId: SessionId;
  modes?: SessionModeState;
  models?: SessionModelState;
}

export interface LoadSessionResponse {
  modes?: SessionModeState;
  models?: SessionModelState;
  /** The adapter could NOT resume a prior transcript and started a FRESH
   *  thread/agent instead (Codex stale rollout → `startThread`; Cursor "agent
   *  not found" → `Agent.create`; Claude with no persisted session id). The
   *  gateway reads this to RE-arm the one-shot first-turn `<system_instruction>`
   *  (a true resume already carries it in history; a fresh thread does not, so
   *  it must be re-injected on the next prompt). Engine-internal; the renderer
   *  ignores it. */
  resumedFresh?: boolean;
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string | null;
}

// ── Auth methods + capabilities ────────────────────────────

export interface AuthEnvVar {
  name: string;
  label?: string;
  optional?: boolean;
  secret?: boolean;
}

export type AuthMethod =
  | {
      type: "env_var";
      id: string;
      name: string;
      description?: string;
      link?: string;
      vars: AuthEnvVar[];
    }
  | {
      type: "terminal";
      id: string;
      name: string;
      description?: string;
    }
  | {
      type: "agent";
      id: string;
      name: string;
      description?: string;
    };

export interface PromptCapabilities {
  audio?: boolean;
  embeddedContext?: boolean;
  image?: boolean;
}

export interface AgentAuthCapabilities {
  terminal?: boolean;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  auth?: AgentAuthCapabilities;
  /** The adapter can inject a user message into a RUNNING turn (mid-turn
   *  "steering") without cancelling it — claude-sdk pushes into the SDK's
   *  streaming input queue; codex calls `turn/steer`. Absent/false → the
   *  queued-messages card disables its "Send now" action for this agent. */
  steering?: boolean;
}

export interface AgentInfo {
  name?: string;
  version?: string;
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  authMethods?: AuthMethod[];
  agentInfo?: AgentInfo;
  /** Extensibility hatch — agents attach their model catalog + capability
   *  metadata here. Read by `model-catalog.ts` to drive the picker per-agent
   *  without a static catalog. Recognised keys:
   *    - `models?: AdvertisedModel[]`  — the agent's model list (+ per-model
   *      effort ladder + fast support).
   *    - `modelEnvVar?: string`        — env var the chosen model is written to
   *      (e.g. "ANTHROPIC_MODEL"); replaces the catalog's `modelEnvVars` map.
   *    - `modelsDynamic?: boolean`     — `models` is filled asynchronously after
   *      a runtime boots; the gateway re-polls `initialize` until it lands. */
  _meta?: { [key: string]: unknown } | null;
}
