// ──────────────────────────────────────────────────────────
// Agent runtime — common types
// ──────────────────────────────────────────────────────────
//
// AgentAdapter is the contract every per-CLI adapter implements. The
// gateway multiplexes adapters behind a single surface so the
// WebSocket wire protocol is consistent across every CLI.
//
// Wire shapes are owned in @zeros/core/agent-events (the portable wire
// contract) and shared by every process (type-only — erased at compile time).
//
// ──────────────────────────────────────────────────────────

import type {
  AvailableCommand,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse as WireLoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  QuestionAnswer,
  QuestionOption,
  QuestionOutcome,
  QuestionRequest,
  QuestionResponse,
  QuestionSpec,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  SessionNotification,
  StopReason,
  TurnUsage,
} from "@zeros/core/agent-events";
import type { AccountDetails } from "@zeros/core/messages";

/** Adapter/gateway-only load result. A degraded Codex resume can replace a
 * legacy Zeros-local UUID with the canonical thread id. The engine consumes
 * this field to rekey ownership, then sends that id through the wire message's
 * existing top-level `sessionId`; it must not extend the nested wire response. */
export interface LoadSessionResponse extends WireLoadSessionResponse {
  sessionId?: string;
}

// ── Failure taxonomy ─────────────────────────────────────
//
// Mirrors BridgeAgentFailure in src/zeros/bridge/messages.ts. Kept name-
// compatible so the UI continues to route on `kind` without changes.

export type AgentFailureKind =
  | "timeout"
  | "auth-required"
  | "subprocess-exited"
  | "protocol-error"
  | "transport-closed"
  /** Phase 2 chat overhaul (2026-05-07): the persisted session
   *  identifier is gone from disk — most often because the agent's
   *  CLI deleted/cleaned up its rollout/session JSONL between
   *  Zeros sessions. Codex emits "thread/resume failed: no rollout
   *  found"; Claude logs "session not found"; the user can't resume
   *  this chat with this agent. UI shows a "Session expired" pill
   *  above the composer + disables input until the user resets. */
  | "session-expired";

export type AgentFailureStage =
  | "initialize"
  | "newSession"
  | "loadSession"
  | "prompt"
  | "cancel"
  | "setMode";

export interface AgentFailure {
  kind: AgentFailureKind;
  message: string;
  stage?: AgentFailureStage;
  agentId?: string;
  /** User-actionable next step, written for the END USER (not logs). The
   *  renderer suppresses technical `message` detail from toasts; when a
   *  classifier can name the fix (e.g. the cursor host crash-loop guard),
   *  it sets `advice` and the toast shows it as the description. */
  advice?: string;
  exit?: {
    code: number | null;
    signal: string | null;
    stderrTail: string;
  };
}

export class AgentFailureError extends Error {
  readonly failure: AgentFailure;
  constructor(failure: AgentFailure) {
    super(failure.message);
    this.name = "AgentFailureError";
    this.failure = failure;
  }
}

// ── Gateway-facing event channel ─────────────────────────
//
// Every adapter emits into this channel. The gateway translates to
// AGENT_* wire messages and broadcasts over the WebSocket.

export interface AgentGatewayEvents {
  onSessionUpdate: (agentId: string, notification: SessionNotification) => void;
  onPermissionRequest: (
    agentId: string,
    permissionId: string,
    request: RequestPermissionRequest,
  ) => void;
  /** A blocking user-input question (twin of onPermissionRequest). */
  onQuestionRequest: (
    agentId: string,
    questionId: string,
    request: QuestionRequest,
  ) => void;
  /** A pending question settled engine-side (response timeout, turn abort, or
   *  an answer from another client). Lets the renderer evict a parked card
   *  whose resolver is gone and stamp the record "skipped". Optional so test
   *  harness event stubs don't all need it; adapters call it defensively. */
  onQuestionSettled?: (
    agentId: string,
    questionId: string,
    sessionId: string,
    outcome: QuestionOutcome,
  ) => void;
  onAgentStderr: (agentId: string, line: string) => void;
  onAgentExit: (
    agentId: string,
    code: number | null,
    signal: NodeJS.Signals | string | null,
    /** Present when the exit belongs to a single session (Codex: one
     *  app-server child per chat). Lets the renderer scope the
     *  "reconnecting" flip to that chat instead of the whole agent. */
    sessionId?: string | null,
  ) => void;
}

// ── MCP server registration (matches current AgentSessionManager API) ─

export type McpToolApprovalMode = "auto" | "prompt" | "writes" | "approve";

export interface McpApprovalConfig {
  /** Server-wide Codex approval policy. `writes` trusts annotated reads and
   *  asks for mutating/unknown tools. */
  defaultMode?: McpToolApprovalMode;
  /** Optional exact tool overrides. Keys are validated again by each adapter
   *  before they are embedded in provider configuration. */
  tools?: Record<string, McpToolApprovalMode>;
}

/** One MCP server Zeros registers with every agent. A discriminated union over
 *  the two transports the MCP spec defines: `stdio` (a local subprocess) and
 *  `http` (Streamable HTTP / a remote URL). Secrets never live here — `env`
 *  values + header values are non-secret or reference env-var names; real
 *  credentials stay in the keychain (Phase 1 persistence).
 *
 *  `trusted` and `approval` are runtime-only hints minted by Zeros for managed
 *  first-party endpoints. Settings parsing never grants them to user-provided
 *  servers, so a repository cannot promote itself into an auto-approved
 *  trust boundary. */
export type McpServerRegistration = (
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    }
) & {
  trusted?: boolean;
  approval?: McpApprovalConfig;
};

// ── Gateway construction shape (drop-in with AgentSessionManager) ──

export interface AgentGatewayOptions {
  projectRoot: string;
  events: AgentGatewayEvents;
}

// ── AgentAdapter — the per-CLI contract ──────────────────
//
// One instance per agent id, lives for the engine's lifetime. Each
// adapter owns any number of concurrent sessions; session state is
// internal to the adapter.

export interface AgentAdapterContext {
  projectRoot: string;
  /** MCP servers to register with the agent (passed via agent-specific config). */
  mcpServers: McpServerRegistration[];
  /** Per-session state directory root. Adapter-owned subdirs inside. */
  sessionDirRoot: string;
  /** Emit events up to the gateway. */
  emit: AgentGatewayEvents;
}

export interface AgentAdapter {
  readonly agentId: string;

  /** Declares that this adapter delivers Zeros' first-turn system instruction
   *  over the agent's NATIVE instruction channel (e.g. Codex
   *  `thread/start.developerInstructions`) when the gateway passes
   *  `systemInstruction` to newSession/loadSession. The gateway then skips the
   *  in-band <system_instruction> block it would otherwise prepend to the
   *  first user prompt — the native channel survives compaction and never
   *  masquerades as user speech. Absent/false → mechanism A (in-band). */
  readonly nativeSystemInstruction?: boolean;

  /** One-time prep (probe version, boot the SDK/app-server runtime, etc.). */
  initialize(): Promise<InitializeResponse>;

  /** Start a new session. Returns the session metadata the UI needs.
   *  `cliBinary` overrides the registry-declared command for this
   *  session only (Settings → Providers → Advanced); omit to use the
   *  default from PATH. `mcpServers` is the per-session MCP registry the
   *  gateway resolved for this cwd (user + repo + workspace layers, RCE-gated);
   *  omit to fall back to the adapter's global `ctx.mcpServers`.
   *  `systemInstruction` is the assembled first-turn instruction body — passed
   *  ONLY to adapters declaring `nativeSystemInstruction` (see above). */
  newSession(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }>;

  /** Resume a prior session by id. `systemInstruction` as in newSession —
   *  native-channel adapters attach it on resume too (refreshes the thread's
   *  instructions, and covers the degraded resume-→-fresh-thread fallback,
   *  whose new thread would otherwise have no orientation at all). */
  loadSession(opts: {
    sessionId: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
  }): Promise<LoadSessionResponse>;

  /** List resumable sessions the CLI knows about. */
  listSessions(opts: {
    cwd?: string;
    cursor?: string | null;
  }): Promise<ListSessionsResponse>;

  /** Send a turn. Streaming events fan out via emit.onSessionUpdate. */
  prompt(opts: {
    sessionId: string;
    prompt: ContentBlock[];
  }): Promise<{ stopReason: StopReason; response: PromptResponse }>;

  /** Abort the current turn. */
  cancel(opts: { sessionId: string }): Promise<void>;

  /** Inject a user message into the RUNNING turn without cancelling it
   *  (mid-turn "steering"). Resolves once the message is delivered to the
   *  agent runtime; the in-flight prompt() keeps streaming and settles the
   *  whole (steered) turn. MUST throw when no turn is in flight. Optional —
   *  only adapters advertising `agentCapabilities.steering` implement it
   *  (claude-sdk pushes into the SDK input queue; codex calls `turn/steer`). */
  steer?(opts: { sessionId: string; prompt: ContentBlock[] }): Promise<void>;

  /** Switch session mode (e.g. plan/default/accept-edits). */
  setMode?(opts: { sessionId: string; modeId: string }): Promise<void>;

  /** Run a REAL context compaction on the live session (§3.5 Task A).
   *  Codex → `thread/compact/start`; progress streams back as the
   *  contextCompaction item (the two-state transcript row). Optional —
   *  Claude compacts via its CLI-native `/compact` prompt instead, and
   *  Cursor's SDK has no compaction call. */
  compactContext?(opts: { sessionId: string }): Promise<void>;

  /** Check a provider API key against the vendor's backend with a cheap
   *  authenticated call (Settings → Providers → Save-time validation).
   *  Tri-state result: ok=true accepted, ok=false REJECTED (401/403),
   *  ok=null inconclusive (network error — caller saves normally).
   *  Optional — only API-key-only adapters (Cursor) implement it. The key
   *  must never be logged or stored by the implementation. */
  validateApiKey?(apiKey: string): Promise<{ ok: boolean | null; error?: string }>;

  /** Background one-shot text generation (the AI chat-title call): send ONE
   *  user prompt + a plain system instruction to `model` and return the
   *  assistant's final text. Headless by contract — no persistent session,
   *  no tools, no emit.* events, and it must ride the same auth a normal
   *  chat spawn would (env carries the provider key when the user is in
   *  API-key mode). Optional — the gateway returns title=null for adapters
   *  without it and the caller keeps its fallback title. */
  generateText?(opts: {
    model: string;
    systemPrompt: string;
    prompt: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  }): Promise<string>;

  /** Change the model of a LIVE session without rebuilding it. Optional —
   *  only the Claude SDK adapter implements it today (`query.setModel`).
   *  Adapters that bake the model into session-creation env simply omit
   *  this; the model choice then applies on the next session instead. */
  setModel?(opts: { sessionId: string; model: string }): Promise<void>;

  /** Apply a mid-session config change (effort / fast / ultracode /
   *  additionalDirectories / allow-deny / maxTurns) to a LIVE session
   *  without rebuilding it. The new values arrive as the full composer
   *  env map (the same `ZEROS_*` encoding session-creation uses), so the
   *  adapter decodes whichever knobs it honours. Optional — only the
   *  Claude SDK adapter implements it today; adapters that bake config
   *  into session-creation env simply omit this and the change applies on
   *  the next session instead. */
  updateConfig?(opts: {
    sessionId: string;
    env: Record<string, string>;
  }): Promise<void>;

  /** Respond to a permission prompt the adapter previously raised. */
  respondToPermission(opts: {
    permissionId: string;
    response: RequestPermissionResponse;
  }): void;

  /** Answer a blocking user-input question the adapter previously raised.
   *  Optional — only adapters with a blocking question channel implement it
   *  (Claude via onUserDialog/canUseTool, Codex via requestUserInput). A no-op
   *  for adapters whose questions are inference-only (Cursor).
   *
   *  `nativeRequestId` is the vendor correlation id off the original
   *  QuestionRequest — the FALLBACK resolver key when `questionId` misses
   *  (an SDK replay/session rebuild minted a fresh questionId while the
   *  renderer deduped and kept the original). Returns true when a pending
   *  question was found and settled — the gateway logs an unhandled answer
   *  so a dropped one is never silent. */
  respondToQuestion?(opts: {
    questionId: string;
    response: QuestionResponse;
    nativeRequestId?: string;
  }): boolean;

  /** Tear down a SINGLE session's resources (subprocess / server child /
   *  SDK agent + session dir) without disposing the whole
   *  adapter. Called by the gateway when a chat tab is closed. Optional —
   *  adapters that hold no per-session resources can omit it; the gateway
   *  still clears its routing maps. Must be idempotent (a no-op for an
   *  unknown id). */
  disposeSession?(sessionId: string): Promise<void>;

  /** Read the signed-in account's details (provider / plan / org / email)
   *  for the Providers panel's connection block. Optional — only providers
   *  with a queryable account implement it (Claude via the SDK, Codex via
   *  the app-server); others (Cursor) omit it. May spawn a short-lived
   *  runtime, so the gateway caches the result behind a long TTL. Returns
   *  null when unavailable (not signed in, API-key mode, or fetch failed). */
  getAccountInfo?(): Promise<AccountDetails | null>;

  /** Release resources: kill subprocesses, close sockets. */
  dispose(): Promise<void>;
}

// ── Re-exports — convenience for adapter modules ─────────

export type {
  AvailableCommand,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  NewSessionResponse,
  PromptResponse,
  QuestionAnswer,
  QuestionOption,
  QuestionOutcome,
  QuestionRequest,
  QuestionResponse,
  QuestionSpec,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionMode,
  SessionNotification,
  StopReason,
  TurnUsage,
};
