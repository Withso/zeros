// ──────────────────────────────────────────────────────────
// Zeros Protocol — Message types for browser ↔ engine
// ──────────────────────────────────────────────────────────
//
// These types define the WebSocket protocol between:
//   - The Zeros renderer runtime client (ws-client.ts) — agent
//     streaming and the bridge request/response protocol
//   - Zeros Engine (the bun/node sidecar; loopback base port 24193 prod / 24293 dev)
//
// ──────────────────────────────────────────────────────────

import type {
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  QuestionOutcome,
  QuestionRequest,
  QuestionResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
} from "./agent-events";
import type {
  AgentTextMessageAttachment,
  MessageContentSegment,
} from "./agent-messages";

export type MessageSource = "browser" | "engine";

// ── Agent registry entry (mirror of the engine-side shape) ─
//
// We redeclare the browser-visible fields here rather than import the Node
// module from the browser bundle. Fields track src/engine/agents/registry.ts.

/** Per-provider account / subscription details shown in the Providers
 *  panel's connection block. Populated by the engine's account probe (the
 *  adapters' `getAccountInfo`); every field is optional so the UI degrades
 *  to a muted "—" while a fetch is pending or unsupported. */
export interface AccountDetails {
  /** Display name of the auth provider, e.g. "Anthropic API" / "OpenAI". */
  provider?: string;
  /** Subscription tier, e.g. "Max", "Pro". */
  plan?: string;
  /** Organization name (Claude only). */
  org?: string;
  /** Signed-in account email. */
  email?: string;
}

export interface BridgeRegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<
      string,
      {
        archive: string;
        cmd: string;
        args?: string[];
        env?: Record<string, string>;
      }
    >;
  };
  /** True when the vendor's CLI is on PATH on this machine (user brought their own). */
  installed?: boolean;
  /** Platform-resolved launch strategy; `"unavailable"` means no runnable dist here. */
  launchKind?: "npx" | "uvx" | "binary" | "unavailable";
  /** CLI binary used by the Login-in-Terminal flow and the auth-state probe. */
  authBinary?: string;
  /** Arguments passed to `authBinary` by the Login-in-Terminal flow.
   *  Mirrored from the engine manifest's `loginCommand.args`. Required
   *  for agents whose login subcommand isn't literally `login` — e.g.
   *  a `<binary> auth login` form. Empty / missing = launch the bare
   *  binary (first-run OAuth pattern). */
  loginArgs?: string[];
  /** Install command + docs URL from the engine's manifest. Populated so the
   *  composer can render a "install this CLI" hint without hardcoding
   *  install strings in the UI. */
  installHint?: {
    command: string;
    docsUrl?: string;
  };
  /** Evaluated from the engine manifest's `AuthProbe`, AND-ed with runtime
   *  availability (see `runtimeUnavailableReason`). True = the CLI has
   *  credentials on disk / keychain **and** the runtime this app would actually
   *  spawn exists. Lets the Agents panel stop calling
   *  `ai_cli_is_authenticated` on every mount (which had its own, drifted,
   *  marker table).
   *
   *  The AND is load-bearing. The probe alone only asks whether a credential
   *  ARTIFACT exists (a keychain item, `~/.claude/.credentials.json`) — which
   *  stays true forever after a first sign-in, even after the token is revoked
   *  or the runtime goes missing. A packaged build whose bundled Claude Code
   *  binary wasn't shipped therefore showed a green "Connected" badge while
   *  every send failed with "AGENT RESPONSE FAILURE" (field report: 0.0.14 Beta
   *  + Production). Credentials present ≠ agent usable. */
  authenticated?: boolean;
  /** Set when the agent's RUNTIME cannot be started at all, carrying a
   *  user-actionable reason. Distinguishes "you need to sign in" from "this
   *  build is missing the Claude Code binary" — previously indistinguishable,
   *  because the only signal was one boolean that meant neither. Absent = the
   *  runtime resolved fine. */
  runtimeUnavailableReason?: string;
  /** Raw version string from `<cliBinary> --version` — lets the UI
   *  surface "installed: X.Y.Z" next to the agent name. */
  installedVersion?: string;
  /** Whether `installedVersion` is within the manifest's tested
   *  range. False shows an "update required" warning in the pill. */
  versionCompatible?: boolean;
  /** Min / max versions from the engine manifest. Used for the
   *  "supported versions" hint text. */
  minCliVersion?: string;
  maxCliVersion?: string;
  /** Surfaces a small "Beta" tag in the Agents UI and (combined with
   *  `useEnabledAgents`) keeps the agent off-by-default on first run.
   *  Mirrors the engine manifest's `beta` field. */
  beta?: boolean;
  /** Per-provider account / subscription details (provider, plan, org,
   *  email) for the Providers-panel connection block. Populated by the
   *  engine account probe; may be absent or partial, so the UI renders
   *  "—" for missing fields. */
  account?: AccountDetails;
}

// ── Engine-side registry shapes ───────────────────────────
//
// The engine builds these with `installed`/`launchKind` always
// populated; the renderer reads them via AGENT_AGENTS_LIST.
// Kept here (alongside the optional-field `BridgeRegistryAgent`
// above) so the engine imports them from @zeros/core too —
// EnrichedRegistryAgent is assignable to BridgeRegistryAgent.

export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: {
    npx?: { package: string; args?: string[]; env?: Record<string, string> };
    uvx?: { package: string; args?: string[]; env?: Record<string, string> };
    binary?: Record<
      string,
      {
        archive: string;
        cmd: string;
        args?: string[];
        env?: Record<string, string>;
      }
    >;
  };
}

export interface EnrichedRegistryAgent extends RegistryAgent {
  installed: boolean;
  launchKind: "npx" | "uvx" | "binary" | "unavailable";
  authBinary?: string;
  loginArgs?: string[];
  installHint?: {
    command: string;
    docsUrl?: string;
  };
  authenticated?: boolean;
  /** See BridgeRegistryAgent.runtimeUnavailableReason — set when the agent's own
   *  runtime can't be started, which is a different failure from "not signed
   *  in" and must not render as either "Connected" or "CLI not authenticated". */
  runtimeUnavailableReason?: string;
  installedVersion?: string;
  versionCompatible?: boolean;
  minCliVersion?: string;
  maxCliVersion?: string;
  beta?: boolean;
  account?: AccountDetails;
}

// ── Base envelope ────────────────────────────────────────

export interface BaseMessage {
  id: string;
  source: MessageSource;
  timestamp: number;
}

// ── Engine → Browser ─────────────────────────────────────

export interface EngineReadyMessage extends BaseMessage {
  type: "ENGINE_READY";
  version: string;
  root: string;
  framework: string;
  port: number;
  /** Engine's bridge protocol version + the oldest it accepts. Optional for
   *  back-compat; the engine always sets both so clients can negotiate. */
  protocolVersion?: number;
  minProtocolVersion?: number;
}

/** Engine → clients broadcast: a list-changing write hit the engine DB. Clients
 *  refetch the named lists so a change on one device shows up live on the others
 *  (Phase 3 cross-device sync). `kinds` names which lists changed (e.g. "chats",
 *  "projects"); optional opaque ids scope the pull, but row data is never sent
 *  in the event itself. */
export interface DbChangedMessage extends BaseMessage {
  type: "DB_CHANGED";
  kinds: string[];
  /** For a "workspaces" change: opaque engine workspace ids whose Git/file
   * state changed. Omitted when the producer cannot identify an exact row
   * (for example a rowless primary checkout), which is the deliberate coarse
   * fallback. Host filesystem paths must never be sent here. */
  workspaceIds?: string[];
  /** True when the invalidation came from shared Git ref state (fetch,
   * branch create/delete/advance). Consumers can refresh branch catalogs
   * without doing that extra work for an ordinary source-file save. */
  gitRefsChanged?: boolean;
  /** For a "messages" change: the chat ids whose transcripts changed, so a
   *  client reconciles ONLY those chats (re-windows them) instead of every open
   *  one. Omitted for list-only changes (chats/projects); clients pull those
   *  named lists. */
  chatIds?: string[];
}

/** Host → engine (LOCAL clients only): seed/refresh the in-memory GitHub token
 *  the engine's TokenStore reads for `gh.*` ops. The token stays encrypted at
 *  rest in Electron safeStorage on the host — this is just the working copy the
 *  engine (which can't call safeStorage) needs to talk to the GitHub API. The
 *  engine IGNORES this from a relay client: a remote device must never be able
 *  to set the host's GitHub token. `token: null` clears it. */
export interface GithubTokenSetMessage extends BaseMessage {
  type: "GITHUB_TOKEN_SET";
  token: string | null;
}

/** Engine → host (LOCAL clients only): the engine mutated the token out-of-band
 *  — e.g. a 401 auto-clear inside a PR op invalidated it — so the host should
 *  mirror the change into safeStorage (the durable store). Delivered via
 *  broadcastLocal so a relay device never receives the token value. */
export interface GithubTokenChangedMessage extends BaseMessage {
  type: "GITHUB_TOKEN_CHANGED";
  token: string | null;
}

/** Engine → local host: the selected credential was invalidated. This event is
 *  intentionally secret-free; Electron main clears the addressed durable slot. */
export interface GithubCredentialChangedMessage extends BaseMessage {
  type: "GITHUB_CREDENTIAL_CHANGED";
  method: "gh-cli" | "github-app" | "pat";
  reason: "credential-invalid";
}

/** Engine → browser: a CAUGHT engine-side error, relayed for PostHog error
 *  tracking (gap A — the engine has no PostHog client of its own). All fields
 *  are scrubbed metadata (see @zeros/core/scrub) — error class/name, a redacted
 *  message + stack, and (for a structured GitError) its `code`. NEVER raw
 *  paths, prompts, diffs, or secrets. Fatal engine crashes are reported
 *  separately by the sidecar (electron/sidecar.ts → "engine-crash"); this is
 *  for the non-fatal, handled errors that would otherwise only hit the log. */
export interface EngineErrorMessage extends BaseMessage {
  type: "ENGINE_ERROR";
  /** Where it originated — handler/op name, e.g. "workspace:git.push". */
  origin: string;
  /** Error class/name. */
  name: string;
  /** Scrubbed, truncated message. */
  message: string;
  /** Scrubbed, truncated stack (optional). */
  stack?: string;
  /** Structured GitError code when applicable (a safe enum). */
  code?: string;
  /** Coarse severity for downstream routing (maps onto whatever priority scale
   *  the receiving tracker uses): "critical" | "major" | "minor". Metadata
   *  only — nothing in the engine branches on it. */
  severity?: string;
}

// ── Connection ───────────────────────────────────────────

export interface ConnectedMessage extends BaseMessage {
  type: "CONNECTED";
  capabilities: string[];
  /** Client's bridge protocol version. Absent = legacy, assumed compatible. */
  protocolVersion?: number;
  /** Access token for account-binding (relay clients; engine-verified post-
   *  decryption so the relay stays blind). Unused in V1 (pairing-only auth). */
  authToken?: string;
}

/** Engine refuses the connection — version skew or auth failure. The client
 *  should surface a clear "update" / "re-pair" message rather than retry blindly. */
export interface ConnectionRejectedMessage extends BaseMessage {
  type: "CONNECTION_REJECTED";
  reason:
    | "protocol-too-old"
    | "protocol-too-new"
    | "auth-invalid"
    | "auth-required"
    // The client authenticated as a DIFFERENT account than the one that owns
    // this desktop. Re-login as the owner account (or, in future, be an invited
    // collaborator). Not retryable with the same account.
    | "auth-wrong-account"
    // The DESKTOP has no bound owner yet: it's still starting, or its operator
    // isn't signed in to Zeros on the Mac. The client's OWN token is fine — a
    // token refresh won't help. Retryable: the moment the desktop signs in, the
    // owner seeds and the next reconnect succeeds. The web surfaces a "sign in
    // on your Mac" prompt instead of a futile "sign in again" loop.
    | "desktop-unbound";
  message: string;
  engineProtocolVersion: number;
  minProtocolVersion: number;
}

/** Host → engine (LOCAL clients only): the desktop owner signed out. The engine
 *  forgets the bound owner account (seeded from the local CONNECTED token) and
 *  drops connected relay devices, so a remote client holding a still-valid token
 *  for the now-signed-out account can't keep — or regain — access until a new
 *  owner is seeded by the next sign-in ("my account, my machine"). Fail-closed:
 *  until re-seeded, relay clients fail the owner check (retryable). IGNORED from
 *  a relay client — only the trusted desktop may clear its own owner binding. */
export interface OwnerSignedOutMessage extends BaseMessage {
  type: "OWNER_SIGNED_OUT";
}

export interface HeartbeatMessage extends BaseMessage {
  type: "HEARTBEAT";
}

// ── Agent runtime ────────────────────────────────────────
//
// See docs/AGENT_RUNTIME.md for the architecture. These wire types
// mirror src/engine/types.ts — keep them in sync or the union breaks.

export interface AgentListAgentsMessage extends BaseMessage {
  type: "AGENT_LIST_AGENTS";
  force?: boolean;
}

export interface AgentNewSessionMessage extends BaseMessage {
  type: "AGENT_NEW_SESSION";
  agentId: string;
  /** The renderer chat this session belongs to. Lets the engine persist the
   *  transcript by chatId as it streams (Phase 2b engine-persists-on-emit), so
   *  forks of the same chat aggregate under one transcript. */
  chatId?: string;
  cwd?: string;
  /** Engine workspace id when the chat lives in a Zeros-managed worktree.
   *  Lets the gateway map session → workspace (background branch-rename
   *  hook, lastActiveAt). Omitted for primary-checkout / foreign-worktree
   *  chats — the engine keys off `cwd` alone there. */
  workspaceId?: string;
  /** Env passed to the agent subprocess at spawn time. */
  env?: Record<string, string>;
  /** Optional CLI binary path override (Settings → Providers → Advanced).
   *  Overrides the registry default `cliBinary` for this session only.
   *  Falsy/missing = use the registry value (PATH lookup). */
  cliBinary?: string;
}

export interface AgentInitAgentMessage extends BaseMessage {
  type: "AGENT_INIT_AGENT";
  agentId: string;
}

export interface AgentAuthenticateMessage extends BaseMessage {
  type: "AGENT_AUTHENTICATE";
  agentId: string;
  methodId: string;
}

/** Validate a provider API key BEFORE the renderer persists it (Settings →
 *  Providers → Save). The engine asks the agent's adapter to make a cheap
 *  authenticated call (e.g. Cursor's models.list) with THIS key — not the
 *  stored one — so the user learns "key rejected" at save time instead of on
 *  their next prompt. The key rides the same local bridge that already
 *  carries it at session spawn (AGENT_NEW_SESSION.env); it is never logged
 *  or persisted engine-side. */
export interface AgentValidateKeyMessage extends BaseMessage {
  type: "AGENT_VALIDATE_KEY";
  agentId: string;
  apiKey: string;
}

/** Reply to AGENT_VALIDATE_KEY. `ok` is a tri-state: true = the provider
 *  accepted the key; false = the provider REJECTED it (401/403 — don't save
 *  without warning); null = inconclusive (no validator for this agent, or a
 *  network failure) — treat as "save normally". */
export interface AgentKeyValidatedMessage extends BaseMessage {
  type: "AGENT_KEY_VALIDATED";
  requestId: string;
  agentId: string;
  ok: boolean | null;
  /** Provider error detail when ok === false. */
  error?: string;
}

/** Background one-shot text generation for the AI chat-title feature: the
 *  renderer fires this right after a chat's FIRST user prompt, the engine
 *  makes a single no-tools call to the chat-title model (Settings → Models
 *  → "Custom models"), and the reply's text becomes the tab title. Headless
 *  by design — no session, no UI events, best-effort (a failure just leaves
 *  the snippet title in place). */
export interface AgentGenerateTitleMessage extends BaseMessage {
  type: "AGENT_GENERATE_TITLE";
  agentId: string;
  /** Curated-catalog model value (e.g. "claude-haiku-4-5"). */
  model: string;
  /** System instruction — the model's reply is used verbatim as the title. */
  systemPrompt: string;
  /** The user's first chat message (truncated renderer-side). */
  prompt: string;
  /** Provider auth env (deriveProviderEnv) so the one-shot rides the same
   *  auth as a normal chat spawn. Never logged or persisted engine-side. */
  env?: Record<string, string>;
}

/** Reply to AGENT_GENERATE_TITLE. `title` is the model's raw reply text
 *  (renderer sanitizes/clamps), or null when the adapter has no one-shot
 *  support or the call failed — caller keeps the snippet title. */
export interface AgentTitleGeneratedMessage extends BaseMessage {
  type: "AGENT_TITLE_GENERATED";
  requestId: string;
  agentId: string;
  title: string | null;
  error?: string;
}

/** Rich-bubble metadata for the user's turn — the displayText, inline
 *  segments (mention/attachment pills) and attachment chips exactly as the
 *  TipTap composer rendered them. The wire `prompt` (expanded text + content
 *  blocks) is what the agent actually sees; `bubble` is purely so the engine
 *  can persist a user message that re-renders inline pills faithfully when the
 *  chat is reopened (instead of falling back to plain backtick text). */
export interface AgentPromptBubble {
  /** Exactly what the composer showed (mention TOKENS, not their expansion).
   *  Falls back to the joined wire text blocks when omitted. */
  displayText?: string;
  /** Ordered text/mention/attachment pieces — see MessageContentSegment. */
  segments?: MessageContentSegment[];
  /** Attachment chip metadata for pre-segment fallback rendering. */
  attachments?: AgentTextMessageAttachment[];
  /** Set when Zeros auto-sent this prompt on the user's behalf (PR island
   *  buttons) — the action kind, persisted onto the user message so the
   *  bubble keeps its "sent by Zeros" treatment on reopen. See
   *  AgentTextMessage.autoAction. */
  autoAction?: string;
}

export interface AgentPromptMessage extends BaseMessage {
  type: "AGENT_PROMPT";
  agentId: string;
  sessionId: string;
  prompt: ContentBlock[];
  /** Optional faithful-bubble payload (segments/attachments/displayText).
   *  Older clients omit it; the engine then persists the plain wire text. */
  bubble?: AgentPromptBubble;
  /** The renderer's local user-message id for this turn. The engine persists the
   *  user message under THIS id (instead of minting its own) and keys the turn
   *  row on it, so the renderer's `turn.userPrompt.id` matches the engine's
   *  turn id without waiting for a transcript re-window (the turn-owning desktop
   *  ignores its own message-changed nudges, so otherwise the ids never converge
   *  in a live session). Older clients omit it → the engine mints an id as before. */
  userMessageId?: string;
}

export interface AgentCancelMessage extends BaseMessage {
  type: "AGENT_CANCEL";
  agentId: string;
  sessionId: string;
}

/** Stop one active background task without cancelling the parent turn or any
 * sibling task. The task id is provider-native and scoped by sessionId. */
export interface AgentStopBackgroundTaskMessage extends BaseMessage {
  type: "AGENT_STOP_BACKGROUND_TASK";
  agentId: string;
  sessionId: string;
  taskId: string;
}

/** Inject a user message into the RUNNING turn (mid-turn "steering") without
 *  cancelling it. Only valid while an AGENT_PROMPT for the same session is
 *  still in flight, and only for adapters that advertise
 *  `agentCapabilities.steering`. The engine persists the user message (like
 *  AGENT_PROMPT) but does NOT open a new turn — the in-flight turn's
 *  AGENT_PROMPT_COMPLETE covers the steered input. Replied to with
 *  AGENT_STEERED (ack) or an AGENT_ERROR envelope. */
export interface AgentSteerMessage extends BaseMessage {
  type: "AGENT_STEER";
  agentId: string;
  sessionId: string;
  prompt: ContentBlock[];
  /** Faithful-bubble payload — same contract as AGENT_PROMPT.bubble. */
  bubble?: AgentPromptBubble;
  /** Renderer's local user-message id — same contract as
   *  AGENT_PROMPT.userMessageId. */
  userMessageId?: string;
}

/** Ack that a steer was delivered into the running turn. */
export interface AgentSteeredMessage extends BaseMessage {
  type: "AGENT_STEERED";
  requestId: string;
  agentId: string;
  sessionId: string;
}

/** Fire-and-forget: tear down a session's engine-side resources when its
 *  chat tab is closed/archived/deleted. No response is sent. */
export interface AgentCloseSessionMessage extends BaseMessage {
  type: "AGENT_CLOSE_SESSION";
  agentId: string;
  sessionId: string;
}

export interface AgentPermissionResponseMessage extends BaseMessage {
  type: "AGENT_PERMISSION_RESPONSE";
  permissionId: string;
  response: RequestPermissionResponse;
}

/** Answer to a blocking user-input question (twin of AGENT_PERMISSION_RESPONSE).
 *  Routes back to the engine resolver keyed by questionId. */
export interface AgentQuestionResponseMessage extends BaseMessage {
  type: "AGENT_QUESTION_RESPONSE";
  questionId: string;
  response: QuestionResponse;
  /** Vendor correlation id off the original QuestionRequest — the adapters'
   *  FALLBACK resolver key when questionId went stale (an SDK replay /
   *  session rebuild re-raised the same ask under a fresh questionId while
   *  the renderer deduped on nativeRequestId and kept the original). */
  nativeRequestId?: string;
}

/** Change the agent's session mode (protocol-level `session/set_mode`).
 *  Used by the composer permissions pill. Fire-and-forget —
 *  engine replies with AGENT_MODE_CHANGED (ack) or AGENT_ERROR. */
export interface AgentSetModeMessage extends BaseMessage {
  type: "AGENT_SET_MODE";
  agentId: string;
  sessionId: string;
  modeId: string;
}

export interface AgentModeChangedMessage extends BaseMessage {
  type: "AGENT_MODE_CHANGED";
  requestId: string;
  agentId: string;
  sessionId: string;
  modeId: string;
}

/** Run a REAL context compaction on the live session (§3.5 Task A) —
 *  Codex `thread/compact/start`. Triggered by `/compact` in a Codex chat
 *  and by the context gauge's "Compact now". Fire-and-forget: progress
 *  surfaces in the transcript as the two-state compaction row streamed by
 *  the agent (contextCompaction item); errors surface via AGENT_ERROR.
 *  (Claude never sends this — its CLI intercepts the literal `/compact`
 *  prompt natively.) */
export interface AgentCompactMessage extends BaseMessage {
  type: "AGENT_COMPACT";
  agentId: string;
  sessionId: string;
}

/** Change the model of a LIVE session without rebuilding it. Used by the
 *  composer model picker. Fire-and-forget: the adapter applies it to the
 *  next turn (Claude SDK: query.setModel). Adapters that don't support live
 *  model changes ignore it (the choice still applies on the next session). */
export interface AgentSetModelMessage extends BaseMessage {
  type: "AGENT_SET_MODEL";
  agentId: string;
  sessionId: string;
  model: string;
}

/** Apply a mid-session config change (effort / fast / ultracode /
 *  additionalDirectories / allow-deny / maxTurns) to a LIVE session without
 *  rebuilding it. Used by the composer pills + slash commands. Fire-and-forget:
 *  the adapter applies it to the next turn (Claude SDK). Adapters that don't
 *  support live config changes ignore it (the choice still applies on the next
 *  session). `env` is the full composer env map (the same `ZEROS_*` encoding
 *  session-creation uses). */
export interface AgentUpdateConfigMessage extends BaseMessage {
  type: "AGENT_UPDATE_CONFIG";
  agentId: string;
  sessionId: string;
  env: Record<string, string>;
}

export interface AgentListSessionsMessage extends BaseMessage {
  type: "AGENT_LIST_SESSIONS";
  agentId: string;
  cwd?: string;
  cursor?: string | null;
}

export interface AgentLoadSessionMessage extends BaseMessage {
  type: "AGENT_LOAD_SESSION";
  agentId: string;
  sessionId: string;
  /** See AgentNewSessionMessage.chatId — the engine persists this resumed
   *  session's transcript under the chat. */
  chatId?: string;
  cwd?: string;
  /** Engine workspace id — see AgentNewSessionMessage.workspaceId. */
  workspaceId?: string;
  env?: Record<string, string>;
  /** Optional CLI binary path override (Settings → Providers →
   *  Advanced). Mirrors AgentNewSessionMessage.cliBinary. */
  cliBinary?: string;
}

export interface AgentSessionsListMessage extends BaseMessage {
  type: "AGENT_SESSIONS_LIST";
  requestId: string;
  agentId: string;
  sessions: ListSessionsResponse["sessions"];
  nextCursor?: string | null;
}

export interface AgentSessionLoadedMessage extends BaseMessage {
  type: "AGENT_SESSION_LOADED";
  requestId: string;
  agentId: string;
  sessionId: string;
  response: LoadSessionResponse;
}

export interface AgentAgentsListMessage extends BaseMessage {
  type: "AGENT_AGENTS_LIST";
  requestId: string;
  agents: BridgeRegistryAgent[];
}

export interface AgentSessionCreatedMessage extends BaseMessage {
  type: "AGENT_SESSION_CREATED";
  requestId: string;
  agentId: string;
  session: NewSessionResponse;
  initialize: InitializeResponse;
}

export interface AgentAuthCompletedMessage extends BaseMessage {
  type: "AGENT_AUTH_COMPLETED";
  requestId: string;
  agentId: string;
  methodId: string;
}

export interface AgentAgentInitializedMessage extends BaseMessage {
  type: "AGENT_AGENT_INITIALIZED";
  requestId: string;
  agentId: string;
  initialize: InitializeResponse;
}

export interface AgentSessionUpdateMessage extends BaseMessage {
  type: "AGENT_SESSION_UPDATE";
  agentId: string;
  notification: SessionNotification;
  /** Engine-authoritative chat binding for this update (the engine's own
   *  sessionId→chatId map). The renderer routes by THIS when present, falling
   *  back to its sessionToChatId index only when absent — so an update can
   *  never be dropped because the renderer's index is momentarily stale (mid
   *  force-respawn, during session create/load, or for an adapter that
   *  emits before the renderer has stored the sessionId). Optional so older
   *  engines / clients still interoperate. */
  chatId?: string;
}

export interface AgentPermissionRequestMessage extends BaseMessage {
  type: "AGENT_PERMISSION_REQUEST";
  agentId: string;
  permissionId: string;
  request: RequestPermissionRequest;
}

/** A blocking user-input question from the agent (twin of
 *  AGENT_PERMISSION_REQUEST). The renderer parks it in the interaction queue
 *  and answers via AGENT_QUESTION_RESPONSE. */
export interface AgentQuestionRequestMessage extends BaseMessage {
  type: "AGENT_QUESTION_REQUEST";
  agentId: string;
  questionId: string;
  request: QuestionRequest;
  /** Same role as on SessionNotification — lets the renderer route by chatId
   *  when its sessionId→chatId index is momentarily stale. */
  chatId?: string;
}

/** A pending question settled ENGINE-SIDE — the adapter's response timeout
 *  fired, the turn was aborted, or another client answered it. The renderer
 *  must evict the parked composer card (its resolver is gone; an answer sent
 *  into it would be dropped) and stamp the transcript record with the outcome
 *  ("skipped" on dismissal/timeout). No-op for questions the local client
 *  already dequeued by answering. */
export interface AgentQuestionSettledMessage extends BaseMessage {
  type: "AGENT_QUESTION_SETTLED";
  agentId: string;
  questionId: string;
  outcome: QuestionOutcome;
}

export interface AgentPromptCompleteMessage extends BaseMessage {
  type: "AGENT_PROMPT_COMPLETE";
  requestId: string;
  agentId: string;
  sessionId: string;
  stopReason: StopReason;
  response: PromptResponse;
}

export interface AgentPromptFailedMessage extends BaseMessage {
  type: "AGENT_PROMPT_FAILED";
  requestId: string;
  agentId: string;
  sessionId: string;
  error: string;
  /** Mirror of the engine-side AgentPromptFailedMessage.failure.
   *  Populated when the adapter threw AgentFailureError so the
   *  renderer can route on `kind` instead of regex-matching the
   *  message string. Optional for back-compat with the AGENT_ERROR
   *  envelope, which has carried this field since Phase 2. */
  failure?: BridgeAgentFailure;
}

export interface AgentAgentStderrMessage extends BaseMessage {
  type: "AGENT_AGENT_STDERR";
  agentId: string;
  line: string;
}

export interface AgentAgentExitedMessage extends BaseMessage {
  type: "AGENT_AGENT_EXITED";
  agentId: string;
  /** When set, the exit is scoped to a single session — Codex runs one
   *  `codex app-server` child per chat, so one child dying must flip only
   *  THAT chat to reconnecting, not every open chat on the agent. Absent
   *  (undefined/null) means an agent-wide exit (a shared subprocess). */
  sessionId?: string | null;
  code: number | null;
  signal: string | null;
}

/** Discriminated-union payload mirroring the engine's AgentFailure.
 *  Lets the UI route deterministically instead of regex-matching
 *  `message`. The string `message` field stays populated as a
 *  fallback / log-friendly description. */
export interface BridgeAgentFailure {
  kind:
    | "timeout"
    | "auth-required"
    | "subprocess-exited"
    | "protocol-error"
    | "transport-closed"
    /** Phase 2 chat overhaul (2026-05-07): mirrors AgentFailureKind in
     *  src/engine/agents/types.ts. Persisted session is gone — most
     *  often Codex "no rollout found", Claude "session not found". */
    | "session-expired";
  message: string;
  stage?:
    | "initialize"
    | "newSession"
    | "loadSession"
    | "prompt"
    | "cancel"
    | "stopBackgroundTask"
    | "setMode";
  agentId?: string;
  /** User-actionable next step, written for the END USER (not logs). The UI
   *  suppresses technical `message` detail from toasts (UI-indication
   *  consolidation 2026-07-10); `advice` is the explicit opt-back-in — when
   *  set, the toast shows it as the description even for prompt-stage
   *  failures that would otherwise rely on the turn-footer pill alone. */
  advice?: string;
  exit?: {
    code: number | null;
    signal: string | null;
    stderrTail: string;
  };
}

export interface AgentErrorMessage extends BaseMessage {
  type: "AGENT_ERROR";
  requestId?: string;
  agentId?: string;
  code: string;
  message: string;
  /** New: structured classification. Populated by the engine since the
   *  `AgentFailure` refactor. Older engine builds won't send this — the UI
   *  falls back to `message` + `code` in that case. */
  failure?: BridgeAgentFailure;
}

// ── Remote Workspace API (files, git read+write, approvals) ──
//
// A single RPC pair carries the whole workspace surface, keyed by an `op`
// string (e.g. "file.read", "git.status", "git.commit"). The engine
// dispatches to the existing git/files modules. Writes from a remote
// client require host approval (the two APPROVAL messages).

export interface WorkspaceRequestMessage extends BaseMessage {
  type: "WORKSPACE_REQUEST";
  op: string;
  params?: Record<string, unknown>;
}
export interface WorkspaceResponseMessage extends BaseMessage {
  type: "WORKSPACE_RESPONSE";
  requestId: string;
  op: string;
  result: unknown;
}
export interface WorkspaceErrorMessage extends BaseMessage {
  type: "WORKSPACE_ERROR";
  requestId: string;
  op: string;
  /** GitErrorCode when available (e.g. WORKSPACE_NOT_FOUND), else a generic code. */
  code: string;
  message: string;
  remediation?: string;
}
// (Removed) WORKSPACE_APPROVAL_REQUEST / WORKSPACE_APPROVAL_RESPONSE — the
// per-op host-approval broker was removed engine-side (it was never wired to a
// desktop prompt, so it always timed out; see src/engine/index.ts). The real
// remote-write gate is the per-workspace remote-restriction list.

// ── Terminal (PTY) — engine-owned shells over the bridge ──
//
// The engine owns node-pty sessions; clients drive them over the bridge.
// Output streams as PTY_DATA, exit as PTY_EXIT — both routed to the owning
// client. Remote (relay) PTY_CREATE is host-approved (a shell is powerful).

/** Local-only cwd token for hidden agent-auth PTYs. The engine resolves this
 *  to an app-owned directory outside every project so a CLI trust prompt can
 *  never approve repository-controlled configuration. Remote clients are
 *  denied before cwd resolution. */
export const PTY_AGENT_AUTH_CWD = "__zeros_agent_auth__";

export interface PtyCreateMessage extends BaseMessage {
  type: "PTY_CREATE";
  sessionId: string;
  cwd?: string;
  /** The managed workspace this terminal belongs to. Lets the engine scope the
   *  shared terminal LIST + apply the per-workspace remote-restriction gate. A
   *  relay client's `cwd` IS the workspace id (resolved server-side), so this is
   *  primarily for LOCAL callers that send a raw path cwd. */
  workspaceId?: string;
  cols?: number;
  rows?: number;
  /** Ephemeral one-shot terminal (e.g. the composer's inline `claude /mcp`
   *  runner): spawned like any other PTY but NOT added to the shared
   *  multiplayer registry, so it never appears in another device's PTY_LIST and
   *  leaves no "(exited)" tab behind. The owning client disposes it explicitly
   *  (PTY_KILL) or it auto-disposes when its shell exits. */
  ephemeral?: boolean;
}
export interface PtyCreatedMessage extends BaseMessage {
  type: "PTY_CREATED";
  requestId: string;
  sessionId: string;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  /** True when the engine handed back an EXISTING pty (page refresh / panel
   *  reopen / a second device attaching) instead of spawning a fresh shell. */
  reattached?: boolean;
  /** Serialized resolved-grid snapshot (visible screen + bounded scrollback) to
   *  write verbatim into a fresh same-size xterm so a reattach restores what was
   *  on screen. Empty/omitted on a fresh spawn. */
  replay?: string;
  /** True when scrollback was trimmed to fit the snapshot byte budget — the
   *  visible screen is always intact. */
  replayTruncated?: boolean;
  /** UTF-8 byte length of `replay` (diagnostics). */
  replayBytes?: number;
}
export interface PtyWriteMessage extends BaseMessage {
  type: "PTY_WRITE";
  sessionId: string;
  data: string;
}
export interface PtyResizeMessage extends BaseMessage {
  type: "PTY_RESIZE";
  sessionId: string;
  cols: number;
  rows: number;
}
export interface PtyKillMessage extends BaseMessage {
  type: "PTY_KILL";
  sessionId: string;
}
export interface PtyDataMessage extends BaseMessage {
  type: "PTY_DATA";
  sessionId: string;
  data: string;
}
/** Infrastructure failures are distinct from a shell that ran and exited.
 *  Optional for backward compatibility with older engines/clients, where an
 *  absent reason means an ordinary process exit. */
export type PtyExitReason = "spawn-failed" | "host-unavailable" | "host-lost";
export interface PtyExitMessage extends BaseMessage {
  type: "PTY_EXIT";
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
  reason?: PtyExitReason;
}

/** One shared terminal in the engine registry. */
export interface PtyTerminalInfo {
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
  createdAt: number;
  /** True when the shell exited in place (kept as "(exited)", restartable) vs a
   *  live shell. An explicitly-closed terminal is removed from the registry, so
   *  it never appears here. */
  exited?: boolean;
}
/** Client → engine: list the shared terminals this client may see (optionally
 *  scoped to one workspace). The engine answers PTY_LIST_RESULT, filtered for a
 *  relay client to non-restricted workspaces. */
export interface PtyListMessage extends BaseMessage {
  type: "PTY_LIST";
  workspaceId?: string;
}
export interface PtyListResultMessage extends BaseMessage {
  type: "PTY_LIST_RESULT";
  requestId: string;
  terminals: PtyTerminalInfo[];
  /** OS roots for every live PtyService session, including Run, Setup, and
   * ephemeral command terminals. Local-only; names, session IDs, cwd, and argv
   * are deliberately omitted. Purely additive and therefore wire-compatible in
   * both directions — an old client ignores the field, and a new client treats
   * its absence as "census unavailable" rather than zero PTYs — so this
   * deliberately does NOT bump PROTOCOL_VERSION, which would strand an updated
   * phone/web peer against a desktop engine that has not shipped yet. */
  processPids?: number[];
}
/** Engine → all clients: the shared terminal set changed (one was created or
 *  exited). Clients re-fetch PTY_LIST so every device's tab strip stays in
 *  sync — multiplayer, like agent sessions. */
export interface PtyTerminalsChangedMessage extends BaseMessage {
  type: "PTY_TERMINALS_CHANGED";
}

// ── Agent binary resolution ───────────────────────────────
//
// The renderer's inline embedded-terminal commands (`claude /mcp`, …) need the
// SAME on-disk CLI the user runs — resolved host-side because the renderer
// can't stat the filesystem. The engine resolves a clean absolute path (or the
// bare binary name as a login-shell-PATH fallback) and the client writes
// `<path> /<cmd>` into the ephemeral PTY. LOCAL-only: a relay client never
// needs (or is told) a host binary path.

/** Client → engine: resolve the on-disk CLI binary path for an agent. */
export interface ResolveAgentBinaryMessage extends BaseMessage {
  type: "RESOLVE_AGENT_BINARY";
  agentId: string;
}
/** Engine → client: the resolved binary. `path` is an absolute path when one
 *  was found, else the bare binary name (the login-shell PATH resolves it at
 *  exec — the always-works fallback). */
export interface AgentBinaryResolvedMessage extends BaseMessage {
  type: "AGENT_BINARY_RESOLVED";
  requestId: string;
  agentId: string;
  path: string;
  /** Where the path came from (diagnostics). NB: named `resolvedVia`, not
   *  `source`, to avoid clashing with `BaseMessage.source` (browser|engine). */
  resolvedVia: "override" | "well-known" | "path" | "fallback";
}

// ── Union ────────────────────────────────────────────────

export type BridgeMessage =
  | ConnectedMessage
  | ConnectionRejectedMessage
  | OwnerSignedOutMessage
  | HeartbeatMessage
  | EngineReadyMessage
  | DbChangedMessage
  | GithubTokenSetMessage
  | GithubTokenChangedMessage
  | GithubCredentialChangedMessage
  | EngineErrorMessage
  // Agent (browser → engine)
  | AgentListAgentsMessage
  | AgentNewSessionMessage
  | AgentInitAgentMessage
  | AgentAuthenticateMessage
  | AgentPromptMessage
  | AgentCancelMessage
  | AgentStopBackgroundTaskMessage
  | AgentSteerMessage
  | AgentCloseSessionMessage
  | AgentPermissionResponseMessage
  | AgentQuestionResponseMessage
  | AgentSetModeMessage
  | AgentSetModelMessage
  | AgentCompactMessage
  | AgentUpdateConfigMessage
  | AgentListSessionsMessage
  | AgentLoadSessionMessage
  | AgentValidateKeyMessage
  | AgentGenerateTitleMessage
  // Agent (engine → browser)
  | AgentAgentsListMessage
  | AgentKeyValidatedMessage
  | AgentTitleGeneratedMessage
  | AgentSessionCreatedMessage
  | AgentAgentInitializedMessage
  | AgentAuthCompletedMessage
  | AgentSessionUpdateMessage
  | AgentPermissionRequestMessage
  | AgentQuestionRequestMessage
  | AgentQuestionSettledMessage
  | AgentModeChangedMessage
  | AgentSteeredMessage
  | AgentSessionsListMessage
  | AgentSessionLoadedMessage
  | AgentPromptCompleteMessage
  | AgentPromptFailedMessage
  | AgentAgentStderrMessage
  | AgentAgentExitedMessage
  | AgentErrorMessage
  // Remote workspace
  | WorkspaceRequestMessage
  | WorkspaceResponseMessage
  | WorkspaceErrorMessage
  // Terminal (PTY)
  | PtyCreateMessage
  | PtyCreatedMessage
  | PtyWriteMessage
  | PtyResizeMessage
  | PtyKillMessage
  | PtyDataMessage
  | PtyExitMessage
  | PtyListMessage
  | PtyListResultMessage
  | PtyTerminalsChangedMessage
  // Agent binary resolution
  | ResolveAgentBinaryMessage
  | AgentBinaryResolvedMessage;

// ── Helpers ──────────────────────────────────────────────

export function createMessageId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createMessage<M extends BridgeMessage["type"]>(
  msg: { type: M } & Omit<
    Extract<BridgeMessage, { type: M }>,
    "id" | "timestamp" | "type"
  >,
): Extract<BridgeMessage, { type: M }> {
  return {
    ...msg,
    id: createMessageId(),
    timestamp: Date.now(),
  } as Extract<BridgeMessage, { type: M }>;
}
