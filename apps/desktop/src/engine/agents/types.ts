// ──────────────────────────────────────────────────────────
// Agent runtime — common types
// ──────────────────────────────────────────────────────────
//
// AgentAdapter is the contract every per-CLI adapter implements. The
// gateway multiplexes adapters behind a single surface so the
// WebSocket wire protocol is consistent across every CLI.
//
// Wire shapes are owned in @zeros/protocol/agent-events (the portable wire
// contract) and shared by every process (type-only — erased at compile time).
//
// ──────────────────────────────────────────────────────────

import type {
  AgentConfigurationProvenance,
  AgentGoal,
  AgentGoalStatus,
  AgentMemorySettings,
  AgentProviderQuota,
  AvailableCommand,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
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
} from "@zeros/protocol/agent-events";
import type { ExecutionId, ProviderBinding } from "@zeros/protocol/identities";
import type { AccountDetails } from "@zeros/protocol/messages";
import type {
  ExecutionBoundaryPortsSnapshot,
  ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";
import type { ExecutionBoundary, PreparedBoundary } from "./containment/types";
import type { BoundaryPreviewGatewayFactory } from "./containment/zsr-preview-gateway";

// ── Failure taxonomy ─────────────────────────────────────
//
// Mirrors BridgeAgentFailure in apps/desktop/src/renderer/platform/bridge/messages.ts. Kept name-
// compatible so the UI continues to route on `kind` without changes.

export type AgentFailureKind =
  | "timeout"
  | "auth-required"
  | "subprocess-exited"
  | "protocol-error"
  | "transport-closed"
  /** The caller lost a local conversation-bind race to a newer create/load or
   *  to an explicit close. The provider conversation is still valid; callers
   *  must not discard its durable binding or cold-start a replacement. */
  | "lifecycle-superseded"
  /** Provider/account throttling. Terminal for this send (we do not amplify
   *  a 429 with an immediate automatic replay), but the composer stays usable
   *  and the UI presents calm retry-later copy. */
  | "rate-limited"
  /** The kernel fence was installed, but the exact execution's asynchronous
   * behavioral proof failed. That process tree is stopped; sibling executions
   * and app-core/auth state remain untouched. */
  | "design-protection-failed"
  /** The persisted session
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
  | "forkSession"
  | "prompt"
  | "cancel"
  | "stopBackgroundTask"
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
  /** Engine-authoritative status for the exact live execution. Contains only
   * stable categories and counts, never paths, endpoints, refs, or errors. */
  onBoundaryStatusChanged?: (
    agentId: string,
    executionId: string,
    status: ExecutionBoundaryStatus,
  ) => void;
  /** Engine-authoritative, owner-routed listener snapshot. It contains no host
   * endpoint, policy token, generation, or raw discovery error. */
  onBoundaryPortsChanged?: (
    agentId: string,
    executionId: string,
    snapshot: ExecutionBoundaryPortsSnapshot,
  ) => void;
  /** Local-desktop account diagnostic. The engine never routes this through a
   * session owner or relay because quotas apply to the host provider account. */
  onProviderQuotaUpdated?: (
    agentId: string,
    quota: AgentProviderQuota | null,
  ) => void;
  onPermissionRequest: (
    agentId: string,
    permissionId: string,
    request: RequestPermissionRequest,
  ) => void;
  /** A pending permission no longer has a live engine resolver. This receipt
   * lets the renderer evict/advance its single-card helper approval queue. */
  onPermissionSettled?: (
    agentId: string,
    permissionId: string,
    sessionId: string,
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

/** One MCP server Zeros registers with every agent. A discriminated union over
 *  the two transports the MCP spec defines: `stdio` (a local subprocess) and
 *  `http` (Streamable HTTP / a remote URL). Secrets never live here — `env`
 *  values + header values are non-secret or reference env-var names; real
 *  credentials stay in the keychain. */
export type McpServerRegistration =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      /** Provider startup allowance for heavyweight local MCP runtimes. */
      startupTimeoutSec?: number;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
      /** HTTP header name -> session environment variable name. This keeps
       * short-lived capabilities out of provider argv/config literals while
       * still allowing providers that support env-backed MCP headers to use
       * their native mechanism. Adapters without that mechanism materialize
       * the value only in their in-memory SDK options. */
      headersFromEnv?: Record<string, string>;
    };

// ── Gateway construction shape (drop-in with AgentSessionManager) ──

export interface AgentGatewayOptions {
  projectRoot: string;
  events: AgentGatewayEvents;
  /** Production injects the engine-wide actor router: local Code runs on the
   * native host, local Design runs in ZSR, and cloud may force its qualified
   * worker boundary. Standalone callers receive the same local actor routing. */
  executionBoundary?: ExecutionBoundary;
  /** Browser-preview ingress. Local sessions use loopback; a qualified cloud
   * coordinator injects a root-owned signed-port factory. */
  previewGatewayFactory?: BoundaryPreviewGatewayFactory;
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

export type AgentRole = "code";

/** Semantic write territory for one Code session. Native Code execution keeps
 * its normal host authority; these paths drive Design recognition, lifecycle
 * checks, and the Code-agent instruction rather than an OS write fence. */
export interface AgentWriteCapabilities {
  workspace: "write";
  deniedPaths: readonly string[];
}

/** Filesystem territory attached to one Code session. It is intentionally
 * independent of workspace `viewMode`: switching UI surfaces never changes a
 * running process's role or selects a different execution backend. */
export interface AgentFilesystemTerritory {
  agentRole: AgentRole;
  workspaceRoot: string;
  /** Active Design document used for orientation and Design-surface identity. */
  designDirectory: string;
  /** Every recognized Design document covered by the Code-agent behavioral
   * contract. Kept explicit so lifecycle reconciliation can compare semantic
   * territory without guessing which denied path is Design, Git, or policy. */
  protectedDesignDirectories: readonly string[];
  /** Files that decide whether those folders are recognized as Design: repo
   * `.zeros` settings plus each folder's canvas marker. Host parity leaves the
   * committed settings native so tree-level Git can update them; sticky engine
   * recognition prevents an edit from de-registering an existing Design root,
   * while the marker remains unwritable inside that root. Kept explicit for
   * lifecycle comparison and Design identity checks. */
  designRecognitionPaths: readonly string[];
  /** Complete semantic Design protection set discovered for this Code
   * territory. It also supplies the denied-path input to a Design-agent ZSR
   * policy; canonical Git metadata remains writable to a native Code actor. */
  writeCapabilities: AgentWriteCapabilities;
}

/** Provider-native browser capability for one agent session.
 *
 * Codex uses its official bundled Browser plugin and app-server tool surface;
 * `browserSessionId` binds that plugin's IAB pipe traffic to the durable Zeros
 * browser tab owned by the conversation. Claude uses Claude Code's official
 * Chrome integration through the Agent SDK. Cursor intentionally has no entry
 * until its SDK exposes a native browser contract. This descriptor never
 * contains tool definitions or an execute callback, so adapters cannot turn it
 * into a Zeros MCP/custom-tool namespace. */
export type AgentBrowserUse =
  | {
      readonly kind: "codex-app-server";
      readonly browserSessionId: string;
    }
  | {
      readonly kind: "claude-agent-sdk";
    };

/** Narrow, engine-owned capability ports. The gateway consumes these product
 * domains rather than reaching into a provider's generic protocol surface.
 * Optional direct members on AgentAdapter remain as a compatibility shim while
 * existing adapters migrate; resolveAgentCapabilityPorts is the only engine
 * entry point that may read those legacy members. */
export interface AgentConversationCapabilityPort {
  forkProviderBinding?(opts: {
    providerBinding: ProviderBinding;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<{ providerBinding: ProviderBinding }>;
}

export interface AgentBrowserCapabilityPort {
  /** This harness has an official browser session channel. The marker is
   * needed for session-start-bound providers such as Codex, which require no
   * separate mid-session update operation. */
  readonly nativeSession: true;
  updateUse?(opts: {
    sessionId: string;
    browserUse?: AgentBrowserUse;
  }): Promise<void> | void;
}

export interface AgentBackgroundWorkCapabilityPort {
  stopTask?(opts: { sessionId: string; taskId: string }): Promise<void>;
}

export interface AgentTurnControlCapabilityPort {
  steer?(opts: { sessionId: string; prompt: ContentBlock[] }): Promise<void>;
  setMode?(opts: { sessionId: string; modeId: string }): Promise<void>;
  compactContext?(opts: { sessionId: string }): Promise<void>;
}

export interface AgentRuntimeConfigurationCapabilityPort {
  setModel?(opts: { sessionId: string; model: string }): Promise<void>;
  updateConfig?(opts: {
    sessionId: string;
    env: Record<string, string>;
  }): Promise<void>;
}

export interface AgentInteractionCapabilityPort {
  respondToPermission?(opts: {
    permissionId: string;
    response: RequestPermissionResponse;
  }): void;
  respondToQuestion?(opts: {
    questionId: string;
    response: QuestionResponse;
    nativeRequestId?: string;
  }): boolean;
}

export interface AgentAccountCapabilityPort {
  validateApiKey?(
    apiKey: string,
    opts?: {
      cwd: string;
      env?: Record<string, string>;
      executionBoundary?: PreparedBoundary;
    },
  ): Promise<{ ok: boolean | null; error?: string }>;
  getAccountInfo?(opts?: {
    liveOnly?: boolean;
    env?: Record<string, string>;
    executionBoundary?: PreparedBoundary;
  }): Promise<AccountDetails | null>;
  readQuota?(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
  }): Promise<AgentProviderQuota | null>;
}

export interface AgentConfigurationCapabilityPort {
  readProvenance(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<AgentConfigurationProvenance>;
}

export interface AgentTextGenerationCapabilityPort {
  generateText?(opts: {
    model: string;
    systemPrompt: string;
    prompt: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    executionBoundary?: PreparedBoundary;
  }): Promise<string>;
}

export interface AgentMemoryCapabilityPort {
  readSettings(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
  }): Promise<AgentMemorySettings>;
  updateSettings(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
    settings: Partial<
      Pick<
        AgentMemorySettings,
        "localMemoriesEnabled" | "toolAssistedGenerationEnabled"
      >
    >;
  }): Promise<AgentMemorySettings>;
  reset(opts: {
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    executionBoundary?: PreparedBoundary;
  }): Promise<void>;
}

export interface AgentGoalCapabilityPort {
  get(opts: { sessionId: string }): Promise<AgentGoal | null>;
  set(opts: {
    sessionId: string;
    update: {
      objective?: string;
      status?: AgentGoalStatus;
      tokenBudget?: number | null;
    };
  }): Promise<AgentGoal>;
  clear(opts: { sessionId: string }): Promise<void>;
}

export interface AgentSafetyCapabilityPort {
  retryDeniedAction(opts: {
    sessionId: string;
    retryId: string;
  }): Promise<void>;
}

export interface AgentCapabilityPorts {
  readonly conversation?: AgentConversationCapabilityPort;
  readonly browser?: AgentBrowserCapabilityPort;
  readonly backgroundWork?: AgentBackgroundWorkCapabilityPort;
  readonly turnControl?: AgentTurnControlCapabilityPort;
  readonly runtimeConfiguration?: AgentRuntimeConfigurationCapabilityPort;
  readonly interaction?: AgentInteractionCapabilityPort;
  readonly account?: AgentAccountCapabilityPort;
  readonly configuration?: AgentConfigurationCapabilityPort;
  readonly textGeneration?: AgentTextGenerationCapabilityPort;
  readonly memory?: AgentMemoryCapabilityPort;
  readonly goal?: AgentGoalCapabilityPort;
  readonly safety?: AgentSafetyCapabilityPort;
}

export interface AgentAdapter {
  readonly agentId: string;

  /** Preferred adapter surface for optional product behavior. Explicit ports
   * take precedence over same-named legacy methods during migration. */
  readonly capabilityPorts?: AgentCapabilityPorts;

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
    /** Zeros-owned ephemeral route. Gateway always supplies this; optional only
     * for direct adapter test/back-compat callers. */
    executionId?: ExecutionId;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    browserUse?: AgentBrowserUse;
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    /** Zeros-owned outer process boundary. Adapters must route every process
     * root they create for this execution through it. */
    executionBoundary?: PreparedBoundary;
  }): Promise<{ session: NewSessionResponse; initialize: InitializeResponse }>;

  /** Resume a prior provider binding into a fresh Zeros execution.
   * `systemInstruction` as in newSession —
   *  native-channel adapters attach it on resume too (refreshes the thread's
   *  instructions, and covers the degraded resume-→-fresh-thread fallback,
   *  whose new thread would otherwise have no orientation at all). */
  loadSession(opts: {
    executionId?: ExecutionId;
    providerBinding?: ProviderBinding;
    /** @deprecated Pre-identity-model locator accepted during migration. */
    sessionId?: string;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    browserUse?: AgentBrowserUse;
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<LoadSessionResponse>;

  /** Fork one durable provider conversation reference. This operation creates
   * no Zeros execution and owns no product chat lifecycle; the engine attaches
   * the returned opaque binding to a destination conversation it created
   * separately. Optional because not every provider exposes native fork. */
  forkProviderBinding?(opts: {
    providerBinding: ProviderBinding;
    cwd: string;
    env?: Record<string, string>;
    cliBinary?: string;
    mcpServers?: McpServerRegistration[];
    systemInstruction?: string;
    territory?: AgentFilesystemTerritory;
    executionBoundary?: PreparedBoundary;
  }): Promise<{ providerBinding: ProviderBinding }>;

  /** List resumable sessions the CLI knows about. */
  listSessions(opts: {
    cwd?: string;
    cursor?: string | null;
    /** Provider-backed discovery is a code actor too. The gateway supplies a
     * fresh one-shot boundary; direct adapter tests may omit it. */
    env?: Record<string, string>;
    executionBoundary?: PreparedBoundary;
  }): Promise<ListSessionsResponse>;

  /** Send a turn. Streaming events fan out via emit.onSessionUpdate. */
  prompt(opts: {
    sessionId: string;
    /** Stable Zeros-owned turn identity. Harness adapters may hash/project it
     * into a native idempotency token; they must not treat it as provider
     * session identity. Older/internal callers may omit it. */
    turnId?: string;
    prompt: ContentBlock[];
  }): Promise<{ stopReason: StopReason; response: PromptResponse }>;

  /** Reconcile a provider-owned, process-scoped browser capability before a
   * turn. Claude uses this to stage the current `--chrome`/`--no-chrome`
   * choice on a cold execution whose durable binding does not exist yet.
   * Optional because Codex binds its native Browser plugin at thread start and
   * Cursor exposes no native browser contract. */
  updateBrowserUse?(opts: {
    sessionId: string;
    browserUse?: AgentBrowserUse;
  }): Promise<void> | void;

  /** Abort the current turn. */
  cancel(opts: { sessionId: string }): Promise<void>;

  /** Stop one provider-owned background task without interrupting the parent
   * turn or sibling work. Optional for providers with no background-task API. */
  stopBackgroundTask?(opts: {
    sessionId: string;
    taskId: string;
  }): Promise<void>;

  /** Inject a user message into the RUNNING turn without cancelling it
   *  (mid-turn "steering"). Resolves once the message is delivered to the
   *  agent runtime; the in-flight prompt() keeps streaming and settles the
   *  whole (steered) turn. MUST throw when no turn is in flight. Optional —
   *  only adapters advertising `agentCapabilities.steering` implement it
   *  (claude-sdk pushes into the SDK input queue; codex calls `turn/steer`). */
  steer?(opts: { sessionId: string; prompt: ContentBlock[] }): Promise<void>;

  /** Switch session mode (e.g. plan/default/accept-edits). */
  setMode?(opts: { sessionId: string; modeId: string }): Promise<void>;

  /** Run a real context compaction on the live session.
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
  validateApiKey?(
    apiKey: string,
    opts?: {
      cwd: string;
      env?: Record<string, string>;
      /** Save-time validation must not create a shared/global provider host. */
      executionBoundary?: PreparedBoundary;
    },
  ): Promise<{ ok: boolean | null; error?: string }>;

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
    /** One-shot provider processes are still code actors. The gateway always
     * supplies a freshly admitted boundary and retires it after the call. */
    executionBoundary?: PreparedBoundary;
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

  /** Respond to a permission prompt the adapter previously raised. Optional:
   * adapters without a host-answerable permission channel must omit it rather
   * than provide a no-op. Compatibility member; gateway code uses the
   * interaction capability port. */
  respondToPermission?(opts: {
    permissionId: string;
    response: RequestPermissionResponse;
  }): void;

  /** Answer a blocking user-input question the adapter previously raised.
   *  Optional — only adapters with a blocking question channel implement it
   *  (Claude via onUserDialog/canUseTool, Codex via requestUserInput).
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
   *  the app-server); others (Cursor) omit it. Returns null when unavailable
   *  (not signed in, API-key mode, no live runtime, or fetch failed). */
  getAccountInfo?(opts?: {
    /** Never create provider work merely to decorate registry UI. */
    liveOnly?: boolean;
    /** Complete provider environment prepared at the trusted gateway edge. */
    env?: Record<string, string>;
    /** Fresh boundary for any fallback/throwaway provider runtime. */
    executionBoundary?: PreparedBoundary;
  }): Promise<AccountDetails | null>;

  /** Release resources: kill subprocesses, close sockets. */
  dispose(): Promise<void>;
}

// ── Re-exports — convenience for adapter modules ─────────

export type {
  AvailableCommand,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
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
