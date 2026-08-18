// ──────────────────────────────────────────────────────────
// ZerosEngine — The heart of Zeros V2
// ──────────────────────────────────────────────────────────
//
// Standalone Node.js process that:
//   - Reads and writes CSS/source files directly
//   - Serves the design workspace via WebSocket
//   - Exposes MCP endpoint for AI tools
//
// Usage:
//   const engine = new ZerosEngine({ port: 24193 });
//   await engine.start();
//
// ──────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { EngineCache } from "./cache";
import { CSSResolver } from "./css-resolver";
import { CSSFileWriter } from "./css-writer";
import { FileWatcher } from "./watcher";
import { seedUserSettingsFromLegacyRoot } from "./settings/files";
import { startSettingsWatcher, type SettingsWatcher } from "./settings/watch";
import { startGitWatcher, type GitWatcher } from "./git/watch";
import { LocalTransport } from "./transport/local";
import { CloudTransport, parseCloudTransportPort } from "./transport/cloud";
import { CloudPreviewGatewayFactory } from "./agents/containment/cloud-preview-links";
import type { Transport, TransportClient } from "./transport/types";
import {
  channel,
  engineBasePort,
  ENGINE_PORT_SPAN,
  isDevRuntime,
} from "./runtime";
import { engineRuntimeDir, zerosDataDir } from "./db/paths";
import {
  buildAccountAuthFromEnv,
  assertQualifiedCloudAccountBinding,
  cloudOwnerSubjectFromEnv,
  verifyAccountJwt,
  verifyAccountJwtViaJwks,
  remoteMustBindFirst,
  remoteAccountVerdict,
  nextOwnerAccount,
  type AccountAuth,
  type VerifiedClaims,
} from "./auth/verify-jwt";
import { appendSecurityAudit } from "./auth/audit-log";
import { MessageRouter } from "./transport/router";
import { WorkspaceService } from "./workspace/service";
import { readDesignProtocolResource } from "./design/protocol-resource";
import { designDirectoryNameFor } from "./design/directory-registry";
import { designFenceStartBlock } from "./design/fence-health";
import { withDesignDirectoryWritable } from "./design/workspace-lock";
import { withDesignWorkspaceMutation } from "./design/document-write-lock";
import {
  fenceWorkspaceDesignDirectoryIfPresent,
  reconcileDesignDirAfterExternalGit,
} from "./git/design-mode";
import {
  dbChangedIncludesOriginator,
  dbChangedKinds,
} from "./workspace/change-events";
import { PtyService } from "./pty/service";
import {
  createNodePtyShell,
  createTerminalMirror,
  disposePtyHost,
} from "./pty/node-pty-spawn";
import { disposeCursorHost } from "./agents/adapters/cursor-sdk/host/host-client";
import {
  configureLoginShellPathRunner,
  getLoginShellPath,
} from "./agents/adapters/shared/login-shell-path";
import { TerminalRegistry } from "./pty/registry";
import {
  GitError,
  getWorkspaceLifecycleStatus,
  isGitError,
  listRemoteRestrictedWorkspaceIds,
  SetupManager,
  whenSeedingSettled,
  type CreatedWorkspace,
} from "./git";
import { RunManager } from "./run/run-manager";
import { getWorkspaceById, listWorkspaces } from "./git/state";
import { resolveRunActions } from "./settings/repo-scripts";
import {
  filterRunActionsForPlatform,
  normalizeRunPlatform,
  runActionOneShot,
  runSessionId,
} from "@zeros/protocol/run-actions";
import { getAuthStatus, setTokenStore } from "./git/github";
import {
  closeGitCredentialBroker,
  prepareGitCredentialShellEnvironment,
} from "./git/credential-broker";
import {
  engineGithubTokenStore,
  seedGithubCredential,
  seedGithubToken,
  setGithubCredentialChangeNotifier,
  type GithubCredentialChange,
} from "./git/engine-token-store";
import {
  watchCloudGithubCredentialProjection,
  type CloudGithubCredentialProjectionWatcher,
} from "./git/cloud-credential-projection";
import { requestCloudGithubCredentialRefresh } from "./git/cloud-credential-refresh-request";
import {
  AgentGateway,
  previewCodeAgentTerritory,
  resolveCodeAgentTerritory,
} from "./agents/gateway";
import { ZsrExecutionBoundary } from "./agents/containment/zsr-boundary";
import {
  loadCloudWorkerConfiguration,
  type CloudWorkerConfiguration,
} from "./agents/containment/cloud-worker-config";
import { createRepoTaskBoundaryFactory } from "./agents/containment/repo-task-boundary";
import type { ExecutionBoundary } from "./agents/containment/types";
import { buildPtyEnv } from "./pty/shell-setup";
import { resolveMcpServers } from "./agents/mcp-registry";
import {
  CONFIG_ROOT_ENV_VARS,
  stripEngineAuthorityEnv,
} from "./agents/adapters/shared/config-isolation";
import { isRuntimeInjectionEnvName } from "./settings/env-names";
import { McpGateway } from "./agents/gateway/server";
import {
  createDesignProtocolCapability,
  parseDesignProtocolResourcePath,
} from "./design/protocol-capability";
import { OAuthVault } from "./agents/gateway/oauth-provider";
import {
  engineLocalAuthorityControlLine,
  MCP_VAULT_SEED_TYPE,
  vaultControlLine,
  type VaultSnapshot,
} from "./agents/gateway/vault-persist";
import { canonicalResourceUri } from "./agents/gateway/oauth-url";
import { resolveClaudeBinary } from "./agents/claude-binary";
import { AgentFailureError, type AgentGatewayOptions } from "./agents/types";
import {
  detectFramework,
  findProjectRoot,
  type Framework,
} from "./framework-detector";
import { createMessage, type EngineMessage } from "./types";
import { scrubError } from "@zeros/protocol/scrub";
import {
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL,
  isCompatible,
} from "@zeros/protocol/version";
import type {
  SessionNotification,
  RequestPermissionRequest,
  QuestionOutcome,
  QuestionRequest,
  ContentBlock,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  StopReason,
  TurnUsage,
} from "@zeros/protocol/agent-events";
import {
  applyUpdate,
  type AgentMessage,
  type AgentTextMessage,
} from "@zeros/protocol/agent-messages";
import {
  PTY_AGENT_AUTH_CWD,
  type AgentPromptBubble,
} from "@zeros/protocol/messages";
import {
  coerceProviderBinding,
  legacyProviderBinding,
  sameProviderBinding,
  type ProviderBinding,
  type ProviderMetadata,
} from "@zeros/protocol/identities";
import { upsertChatMessagesBulk } from "./db/messages";
import {
  startTurn as startTurnRow,
  finishTurn as finishTurnRow,
  turnsWithSnapshotsBeyond,
  clearTurnSnapshots,
  type TurnFile,
} from "./db/turns";
import {
  attachChatProviderIdentityIfUnbound,
  clearChatProviderIdentity,
  getChat,
  getChatLocation,
  updateChatProviderIdentity,
} from "./db/chats";
import {
  authoredPathsFromMessages,
  deleteSnapshotRefs,
  isGitWorkTree,
  repoToplevel,
  snapshotRef,
  snapshotWorkingTree,
  treesIdentical,
  turnFileDiffs,
} from "./git/turns-git";

/** Per-chat cap on retained turn snapshots. Beyond this, the oldest turns'
 *  hidden refs are pruned on each new turn (the rows stay for the dropdown). */
const TURN_SNAPSHOT_RETENTION = 100;

/** In-flight state for a turn being recorded (a `prompt()` round-trip). Captured
 *  by beginTurn() before the agent runs, consumed by finishTurn() after. */
interface TurnSnapshotContext {
  sessionId: string;
  chatId: string;
  /** Opening user message id — the turn id + the transcript-truncation key. */
  turnId: string;
  /** Agent cwd — where the agent's tool paths resolve (may be a SUBDIR of the
   *  worktree). Used only to resolve attribution paths; git ops use `root`. */
  folder: string;
  /** Worktree top-level — what snapshots/diffs/reset anchor on (== `folder` when
   *  the chat folder is the worktree root, or non-git). All turn `files` paths
   *  are relative to this, and the turn row's `folder` column stores it. */
  root: string;
  workspaceId: string | null;
  /** Index into the session's coalesced message list at turn start; messages
   *  after it are this turn's events (for authored-file attribution). */
  startIndex: number;
  /** Pre-turn whole-tree snapshot OID, or null (non-git / snapshot skipped). */
  pre: string | null;
  isGit: boolean;
}

/** Renderer-independent ownership for an accepted prompt. Local renderer
 * reloads deliberately do not cancel agent work, so this record is the source
 * of truth used to re-adopt the still-running turn. */
interface ActivePromptContext {
  sessionId: string;
  agentId: string;
  chatId: string | null;
  turnId: string;
  /** Privacy-safe renderer correlation id for prompt telemetry across reload. */
  promptId: string;
  startedAt: number;
  /** Last sign of life from the adapter (stream chunk, gate opened/settled) or
   *  from the user answering a gate. Read only by the staleness bound below. */
  lastActivityAt: number;
  /** A Stop landed for THIS accepted turn (any cancel site — the user's button,
   *  chat reset, workspace lifecycle, remote-client drop).
   *
   *  Turn-scoped on purpose. The session-wide `cancelRequested` set cannot tell
   *  "stop the turn I just accepted" from "a stale intent left by a previous
   *  turn", so AGENT_PROMPT clears that set before dispatching — which silently
   *  swallowed every Stop clicked during the pre-dispatch window (persist user
   *  message → pre-snapshot → workspace barrier, seconds on a large repo). The
   *  adapters cannot cover it either: each clears its own cancel flag as it
   *  enters prompt(). This flag is minted with the turn, so it is unambiguous. */
  cancelledByUser?: boolean;
  /** The adapter's prompt promise has settled (either way). Disarms the
   *  post-cancel settle watchdog — finishTurn's post-snapshot can outlast the
   *  deadline, and a force-settle racing it would double-write the turn row. */
  adapterSettled?: boolean;
  /** This turn's recorded snapshot, once beginTurn has produced one (null when
   *  there is nothing to record — no chat binding, no folder). Held by
   *  REFERENCE, because `turnId` above is NOT a reliable name for it: this
   *  record falls back to `turn-${msg.id}` while beginTurn falls back to the
   *  persisted user message's id, so the two disagree for any client that omits
   *  userMessageId. The settle watchdog matched on that id and silently skipped
   *  the durable write whenever they diverged. */
  turnSnapshot?: TurnSnapshotContext | null;
  /** The post-cancel watchdog has written this turn's ENDING to its durable row.
   *  Only this suppresses the prompt handler's own finishTurn — never
   *  `terminalPublished`, which is about the wire event and can be set in
   *  windows where no row was (or could yet be) closed. Keeping the two apart is
   *  what stops a suppression outrunning the write it stands for and leaving the
   *  row recorded as running forever. */
  turnRowSettled?: boolean;
  /** This turn's terminal `turn_state` has already been emitted by the
   *  post-cancel watchdog. The prompt handler must not publish a second,
   *  contradictory ending, and the turn no longer counts as live for
   *  re-adoption or the concurrency guard. */
  terminalPublished?: boolean;
  /** Pending post-cancel settle deadline (see CANCEL_SETTLE_DEADLINE_MS). */
  cancelSettleTimer?: ReturnType<typeof setTimeout>;
}

/** Accept only catalog-shaped correlation ids. Reject paths, emails, spaces,
 * and free text so a remote client cannot park PII on the active-turn record. */
function durablePromptId(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^[a-z0-9][a-z0-9.:+-]{0,79}$/i.test(trimmed)) return fallback;
  return trimmed;
}

const VERSION = "0.0.5";

/** Once an execution exists, its engine-owned route selects the adapter. The
 * wire's agentId remains for v8 compatibility and diagnostics, but a stale
 * renderer label must not rebind an execution to another provider. */
const EXECUTION_ROUTED_AGENT_MESSAGES = new Set([
  "AGENT_PROMPT",
  "AGENT_CANCEL",
  "AGENT_STOP_BACKGROUND_TASK",
  "AGENT_STEER",
  "AGENT_CLOSE_SESSION",
  "AGENT_SET_MODE",
  "AGENT_SET_MODEL",
  "AGENT_COMPACT",
  "AGENT_UPDATE_CONFIG",
  "AGENT_OPEN_BOUNDARY_PORT",
]);

/** Master switch for the Zeros design surface (CSS selector index, design MCP,
 *  canvas element-picker, apply-change). Currently OFF — the surface is being
 *  rebuilt in the Zeros CLI (see the disabled MCP block in `start()`). While it
 *  is off we skip the per-boot `cache.buildIndex()` walk, which globs + PostCSS-
 *  parses every CSS file in the repo for a feature nothing consumes — pure
 *  startup tax that scales with repo size and is paid on every (re)spawn. Flip
 *  to true alongside re-enabling the MCP to restore the index. */
const LEGACY_DESIGN_SELECTOR_INDEX_ENABLED = false;

/** A workspace op slower than this gets one log line naming it and its
 *  duration. Set above every ordinary read (a `git.status` fan-out on a large
 *  repo lands in the low hundreds of ms) so the log stays readable, and well
 *  below the host watchdog's ~15s kill window so anything that could plausibly
 *  cost the engine its life is on the record before it does. */
const SLOW_WORKSPACE_OP_MS = 2_000;

/** How long after engine construction the login-shell PATH probe waits before
 *  admitting its boundary. Long enough for boot rehydration and the focused
 *  chat's own admission to clear the gate, short enough that the first Setup/Run
 *  of a session still finds the PATH cached. Nothing awaits this. */
const BOOT_LOGIN_SHELL_PATH_WARM_DELAY_MS = 20_000;

/** Renderer-authored Zeros controls with a documented session-scoped meaning.
 * Every other `ZEROS_*` name is engine authority or an implementation detail
 * and therefore remains engine-derived for cloud clients. */
const REMOTE_AGENT_SAFE_ZEROS_ENV = new Set([
  "ZEROS_ADDITIONAL_DIRS",
  "ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES",
  "ZEROS_FAST_MODE",
  "ZEROS_PERMISSION_MODE",
  "ZEROS_THINKING_EFFORT",
]);

/** Environment names that the gateway turns into host capabilities before the
 * child is contained. A cloud client may supply ordinary child environment,
 * including API/MCP/application secrets, but these coordinates must come from
 * the cloud worker itself so they cannot widen filesystem, socket, toolchain,
 * or container authority. */
const REMOTE_AGENT_ENGINE_DERIVED_ENV = new Set<string>([
  ...CONFIG_ROOT_ENV_VARS,
  "PATH",
  "PATHEXT",
  "SSH_AUTH_SOCK",
  "GPG_AGENT_INFO",
  "GNUPGHOME",
  "NIX_REMOTE",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "NVM_DIR",
  "VOLTA_HOME",
  "ASDF_DATA_DIR",
  "MISE_DATA_DIR",
  "BUN_INSTALL",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "PNPM_HOME",
  "GOPATH",
]);

const PORTABLE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** AGENT_GENERATE_TITLE is intentionally not a full code session. Its renderer
 * caller sends only provider authentication/routing, so keep this a positive
 * list: a forged bridge frame cannot turn a cosmetic one-shot into a process
 * launcher via SHELL/NODE/Claude/Codex controls. */
const TITLE_GENERATION_ENV = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_URL",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "CHATGPT_BASE_URL",
  "CURSOR_API_KEY",
]);

/** Canonicalize the one renderer-carried env value that can widen code
 * territory. The injected predicate resolves real paths and fails closed for
 * missing paths/symlink escapes. */
function clampRemoteAdditionalDirectories(
  value: string,
  isWithinAllowed: (candidate: string) => boolean,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const clamped = [
    ...new Set(
      parsed.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && isWithinAllowed(candidate),
      ),
    ),
  ];
  return clamped.length > 0 ? JSON.stringify(clamped) : undefined;
}

/** Ops that rewrite worktree files and can therefore change semantic Design
 *  territory. The engine freezes process admission and retires code sandboxes
 *  before each one. Index-only and ref-only operations don't belong here. */
const DESIGN_DIR_REWRITE_OPS = new Set<string>([
  "git.pull",
  "git.rebase",
  "git.checkoutBranch",
  "git.merge",
  "git.reset",
  "git.restore",
  "git.cherryPick",
  "git.revert",
  "git.continue",
  "git.abort",
  "git.stashSave",
  "git.stashPop",
  "git.stashApply",
  "turns.reset",
  "turns.undoReset",
  "workspace.continueOnNewBranch",
]);

/** How long a session whose LOCAL owner just disconnected stays reserved for
 *  the desktop. A relay client may not ADOPT it during this window — it covers
 *  a renderer reload, where the agent keeps running but ownership is briefly
 *  cleared, so the reconnecting desktop wins the re-adopt over a connected
 *  relay. */
const LOCAL_REOWN_GRACE_MS = 30_000;

/** How long an accepted prompt may show NO sign of life — no adapter output and
 *  no blocking gate parked on the user — before the engine stops treating it as
 *  the session's live turn.
 *
 *  Only reachable when an adapter's prompt promise neither resolves nor rejects,
 *  because that promise settling is what normally retires the record. The
 *  renderer's own watchdogs abort its request at that point, but an abort is
 *  client-side only — the engine is never told — so without this bound the ghost
 *  record outlives the process and the concurrency guard refuses EVERY later send
 *  for the chat as "already responding", recoverable only by closing the chat.
 *
 *  Deliberately longer than the renderer's PROMPT_INACTIVITY_TIMEOUT_MS (30 min)
 *  so the renderer always gives up first: the engine is the backstop, never the
 *  one to declare a turn dead while a client still waits on it. */
const PROMPT_STALE_AFTER_MS = 45 * 60_000;

/** How long after a cancel the engine waits for the adapter's prompt promise to
 *  settle before it publishes the turn's ending itself.
 *
 *  A Stop is a promise to the user, and every adapter settles its turn within a
 *  second or two of one (abort the run, interrupt the turn, drain the stream).
 *  When one does NOT — a run whose stream never closes, an interrupt the
 *  provider never acknowledges — the engine used to keep the accepted prompt as
 *  the session's live turn for the full PROMPT_STALE_AFTER_MS window. The user
 *  saw STOPPED BY USER, then reloaded (or switched tabs, which re-loads the
 *  session) and got the running shimmer back with a timer counting from the
 *  original prompt. This bound makes the stop durable: bookkeeping only — the
 *  adapter's own cancel has already been dispatched and its late settle is
 *  still attributed correctly. */
const CANCEL_SETTLE_DEADLINE_MS = 15_000;

/** Return only durable, opaque workspace-row ids for DB_CHANGED scoping.
 * Local-main requests use a host path as their workspaceId; rejecting anything
 * without a row prevents that path from crossing the relay boundary. */
function dbChangedWorkspaceIds(
  params: Record<string, unknown>,
  result: unknown,
): string[] | undefined {
  const candidates = new Set<string>();
  if (typeof params.workspaceId === "string") {
    candidates.add(params.workspaceId);
  }
  if (result && typeof result === "object") {
    const workspaceId = (result as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId === "string") candidates.add(workspaceId);
  }
  const ids = Array.from(candidates).filter((id) => !!getWorkspaceById(id));
  return ids.length > 0 ? ids : undefined;
}

export interface EngineOptions {
  root?: string;
  /** Base of this runtime's full engine + MCP gateway port footprint. */
  port?: number;
  /** First bridge candidate to bind, while gateway ports stay at `port + 8/9`. */
  portStart?: number;
  portSpan?: number;
  /** Test/platform injection. Production always constructs the qualified ZSR
   * backend and shares it across agents and repository-controlled tasks. */
  executionBoundary?: ExecutionBoundary;
}

/** Expected, user-correctable git/workspace outcomes — control flow, not bugs.
 *  Kept OUT of error tracking (they'd be noise); they still surface in the
 *  renderer's `git_op` analytics funnel as error outcomes. See reportEngineError. */
const EXPECTED_ENGINE_ERROR_CODES = new Set<string>([
  "VALIDATION_FAILED",
  "BRANCH_IN_USE",
  "NOT_AUTHENTICATED",
  "GITHUB_RATE_LIMITED",
  "GITHUB_SSO_REQUIRED",
  "GITHUB_FORBIDDEN_SCOPE",
  "GITHUB_REPO_NOT_INSTALLED",
  "GITHUB_INSTALLATION_SUSPENDED",
  "NOT_A_REPO",
  "WORKTREE_NOT_FOUND",
  // The worktree FOLDER is gone from disk — an expected, user-correctable
  // outcome (the renderer offers "Delete permanently"), not a bug to track.
  "WORKTREE_MISSING",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_ALREADY_EXISTS",
  "MERGE_IN_PROGRESS",
  "REBASE_IN_PROGRESS",
  "DETACH_LOCKED",
  "DETACH_NOT_ACTIVE",
  "REMOTE_RESTRICTED",
  "REMOTE_PATH_DENIED",
  "REMOTE_OP_NOT_ALLOWED",
  "APPROVAL_DENIED",
]);

/** Coarse severity for an engine error reaching error tracking (drives the
 *  triage priority). A non-GitError throw is an unexpected fault (likely a bug) =
 *  critical; a transient network failure = minor; other hard git/workspace
 *  faults = major. Expected control-flow codes never get here (skipped). */
function engineErrorSeverity(
  code: string | undefined,
): "critical" | "major" | "minor" {
  if (!code) return "critical";
  if (code === "NETWORK_ERROR") return "minor";
  return "major";
}

export class ZerosEngine {
  private cache: EngineCache;
  private resolver: CSSResolver;
  private writer: CSSFileWriter;
  private watcher: FileWatcher;
  private settingsWatcher: SettingsWatcher | null = null;
  private gitWatcher: GitWatcher | null = null;
  /** Coalesce filesystem invalidations behind one authority-reconciliation
   * lane. Settings and Git watchers can fire together for one checkout; this
   * prevents overlapping session retirement/territory publication. */
  private designTerritoryReconcileChain: Promise<void> = Promise.resolve();
  /** The local MCP gateway (auth:"oauth" backends fronted on localhost). Lazily
   *  started when the user-level settings declare a gateway-managed server. */
  private mcpGateway: McpGateway | null = null;
  /** Why the gateway isn't running when it should be (start/reload failure, e.g.
   *  the port is taken) — surfaced via mcp.gateway.status so the UI shows
   *  "Gateway unavailable" instead of an OAuth server silently vanishing.
   *  null = healthy or not expected (no oauth backends). */
  private gatewayError: string | null = null;
  /** Serializes gateway start/reload, so two near-simultaneous settings saves
   *  can't both construct a McpGateway on the fixed base+8 port (EADDRINUSE)
   *  or race reload() into orphaned backend clients. */
  private gatewayReloadChain: Promise<void> = Promise.resolve();
  /** The OAuth token vault — engine-level (NOT per-gateway) so tokens survive a
   *  gateway stop/restart within one process. Created + restored once; persisted
   *  to the host's safeStorage on change via the control fd. */
  private mcpVault: OAuthVault | null = null;
  /** A boot-restore snapshot the host pushed on stdin before the vault existed,
   *  applied when the vault is first created (handles the spawn race). */
  private mcpVaultSeed: VaultSnapshot | null = null;
  /** Debounce for the persist control-fd write (token refresh can fire often). */
  private vaultPersistTimer: ReturnType<typeof setTimeout> | null = null;
  private local: LocalTransport;
  /** Per-launch secret the local renderer presents on the /ws upgrade. */
  private readonly localToken: string;
  /** The in-sandbox 0.0.0.0 bridge. Null in the local build —
   *  only constructed when ZEROS_CLOUD_PORT is set. */
  private cloud: CloudTransport | null = null;
  private transports: Transport[] = [];
  private readonly router = new MessageRouter();
  private workspace!: WorkspaceService;
  private pty!: PtyService;
  private setup!: SetupManager;
  private runs!: RunManager;
  private readonly executionBoundary: ExecutionBoundary;
  /** Immutable cloud-image admission. This describes the engine deployment,
   * unlike `TransportClient.kind`, which describes only the caller. */
  private readonly cloudWorker: CloudWorkerConfiguration | null;
  /** Shared multiplayer terminals: a PTY is an engine-owned shared
   *  resource, NOT owned by one client. Every paired device may attach to, watch,
   *  and drive the SAME terminal; the only gate is the per-workspace remote
   *  restriction. Terminals persist across client disconnects; one relay
   *  dropping must not kill a shell another client still uses. */
  private readonly terminals = new TerminalRegistry();
  /** PTY sessionIds currently being EXPLICITLY closed (a client sent PTY_KILL).
   *  Lets onExit tell an explicit close (remove the terminal everywhere) apart
   *  from a natural shell exit (keep it as "(exited)", restartable). */
  private readonly explicitlyClosing = new Set<string>();
  /** Agent sessionId → agentId, so a disconnecting client's owned sessions can
   *  be cancelled (a remote client must not leave an agent running). */
  private readonly sessionAgent = new Map<string, string>();
  /** Agent sessionId → renderer chatId. Lets the persist hook write
   *  the transcript by chatId as the engine streams. Kept while the session
   *  LIVES (survives a client reload so persistence continues); cleared on
   *  explicit AGENT_CLOSE_SESSION. */
  private readonly sessionChat = new Map<string, string>();
  /** Durable Zeros conversation → current live execution. Renderer reloads
   * re-adopt through this map without persisting an ephemeral execution id. */
  private readonly conversationExecution = new Map<string, string>();
  /** Session-scoped provider exits that arrived while a prompt was still
   * settling. Keep their owner/chat/workspace tags until the terminal event is
   * routed and persisted, but never expose them as live executions. */
  private readonly exitedAgentExecutions = new Set<string>();
  /** Latest provider-bind intent per Zeros conversation. A tab close removes
   * the token, and a newer create/load replaces it, so an older adapter result
   * can be disposed instead of publishing an orphan execution after the user's
   * lifecycle intent has already changed. Tokens are process-monotonic. */
  private conversationBindSerial = 0;
  private readonly conversationBindTokens = new Map<string, number>();
  /** One admission-cancellation controller per live bind. Aborted when the
   * conversation is closed or its bind superseded, so a session admission
   * still queued in the gate is cancelled instead of built for nobody. */
  private readonly conversationBindAborts = new Map<
    string,
    { token: number; controller: AbortController }
  >();
  /** Source conversations currently being snapshotted by a native provider
   * fork. Prompt dispatch checks this synchronously so a new turn cannot race
   * a "latest completed state" fork after its initial idle check. */
  private readonly conversationForkSources = new Set<string>();
  /** Conversation closes are cancellation+dispose transactions. A rapid
   * History restore waits for the exact close already in progress before it
   * asks any provider to resume the durable binding. */
  private readonly conversationCloseFlights = new Map<string, Promise<void>>();
  /** Agent sessionId → its workspaceId. Lets the engine withhold a session in a
   *  remote-restricted workspace from relay devices: its stream +
   *  permission prompts go to LOCAL clients only, and a relay client may not act
   *  on it. Empty for sessions with no managed workspace (never restricted). */
  private readonly sessionWorkspace = new Map<string, string>();
  /** Agent sessionIds with a `prompt()` currently in flight. Lets turns.reset
   *  cancel a live turn ENGINE-side before truncating the timeline it streams
   *  into (the renderer's footer does the same, but a reset arriving from any
   *  other device/caller must not race a live stream into zombie rows). */
  private readonly promptSessions = new Set<string>();
  /** Accepted prompts, including the pre-snapshot window before
   * `promptSessions` becomes visible. Survives a local renderer disconnect. */
  private readonly activePromptContexts = new Map<
    string,
    ActivePromptContext
  >();
  /** Last session metadata returned by new/load. An active session cannot be
   * handed to adapter.loadSession again (Codex would dispose its live thread),
   * so re-adoption replies from this engine-owned cache. */
  private readonly sessionLoadResponses = new Map<
    string,
    LoadSessionResponse
  >();
  /** Exact provider bindings deleted while an adapter create/resume is still
   * resolving. The late response must not resurrect a handle that an earlier
   * provider_binding_detached event already compare-and-cleared. */
  private readonly detachedProviderBindings = new Map<
    string,
    ProviderBinding
  >();
  /** Agent sessionId → the authoritative provider turn currently recording.
   *  A mid-turn steer uses this owner instead of opening a second turn row. */
  private readonly activeTurnSnapshots = new Map<string, TurnSnapshotContext>();
  /** Workspace process/session starts and checkout mutations that have crossed
   *  the caller-side gate but have not settled. Archive/delete wait for these
   *  promises before enumerating processes and snapshotting. Without this
   *  barrier, setup env resolution, agent initialization, or a cross-window Git
   *  write could finish just after the reaper's snapshot and recreate/change a
   *  removed worktree. */
  private readonly workspaceProcessStarts = new Map<
    string,
    Set<Promise<unknown>>
  >();
  /** Only starts that can publish or retain a code-agent authority profile.
   * Setup, runs, and human terminals still use workspaceProcessStarts for
   * archive/delete safety, but they do not hold a provider Design capability
   * and therefore must not delay a view/territory transition. */
  private readonly designAuthorityStarts = new Map<
    string,
    Set<Promise<unknown>>
  >();
  /** Workspace ids whose active Design territory is being created or moved.
   * This is a short authority transition, independent of archive/delete
   * lifecycle. New code agents fail closed until old-authority sessions are
   * retired and the new fence is complete. */
  private readonly designTerritoryTransitions = new Set<string>();
  /** Agent sessionId → the running coalesced message list — the accumulator the
   *  shared applyUpdate folds chunks into, so the engine upserts only the rows
   *  that changed on each chunk. */
  private readonly sessionMessages = new Map<string, AgentMessage[]>();
  /** Agent sessionIds with a user cancel in flight. Set by AGENT_CANCEL (and
   *  the remote-client-drop relay cancel) BEFORE the cancel is dispatched,
   *  consumed by the AGENT_PROMPT catch: a cancel that tears down the
   *  subprocess can surface as a prompt REJECTION instead of a clean
   *  stopReason:"cancelled", and without the intent the turn row would be
   *  recorded "failed" — a reloaded chat would then read AGENT STOPPED
   *  instead of STOPPED BY USER. Cleared when the in-flight prompt settles,
   *  and at the start of the next prompt (a stale intent from a previous
   *  turn must not mislabel a genuine failure). */
  private readonly cancelRequested = new Set<string>();
  /** Agent permissionId → owning clientId, so only the client that owns the
   *  session may answer its permission prompts. */
  private readonly permissionOwner = new Map<string, string>();
  /** Agent questionId → owning clientId (twin of permissionOwner) — only the
   *  session owner may answer a blocking user-input question. */
  private readonly questionOwner = new Map<string, string>();
  /** Blocking interactions must be replayed to a replacement renderer. The
   * adapter resolver remains live while the desktop reloads. */
  private readonly pendingPermissionRequests = new Map<
    string,
    {
      agentId: string;
      request: RequestPermissionRequest;
    }
  >();
  private readonly pendingQuestionRequests = new Map<
    string,
    { agentId: string; request: QuestionRequest }
  >();
  /** Agent sessionId → ms timestamp when its LOCAL owner last disconnected.
   *  Within LOCAL_REOWN_GRACE_MS a relay client may not adopt the session. */
  private readonly recentlyLocalOwned = new Map<string, number>();
  /** Account-binding config (null = off / pairing-only). Built from env once. */
  private readonly accountAuth: AccountAuth | null = buildAccountAuthFromEnv();
  /** clientId → verified account user id (for audit / multi-device identity). */
  private readonly clientAccount = new Map<string, string>();
  /** clientId → the bound token's `exp` (Unix seconds). A relay session must
   *  not outlive the token it bound with — a periodic sweep demotes any client
   *  whose token has expired, forcing a re-auth with a fresh token. */
  private readonly clientTokenExp = new Map<string, number>();
  /** Periodic token re-verification sweep. Lazily started on the first relay
   *  bind; cleared in stop(). */
  private bindingSweep: ReturnType<typeof setInterval> | null = null;
  /** Qualified-cloud GitHub working credentials arrive through a root-owned,
   * owner-bound, short-lived projection. Agent processes cannot see this path. */
  private cloudGithubCredentialWatcher: CloudGithubCredentialProjectionWatcher | null =
    null;
  /** Parent-death watchdog (Electron host only — armed by ZEROS_PARENT_PID). */
  private parentWatchTimer: ReturnType<typeof setInterval> | null = null;
  private parentDeathExiting = false;
  /** The account that OWNS this desktop — seeded from the LOCAL client's
   *  (desktop renderer's) verified token. A relay (remote) client must be this
   *  same account, so "my account, my machine": a leaked pairing offer used by a
   *  DIFFERENT account is rejected. Null until the signed-in desktop renderer
   *  connects (then relay clients are fail-closed as owner-unknown). */
  private ownerAccountSub: string | null = null;
  // Native per-CLI adapter runtime — multiplexes the per-agent
  // adapter implementations behind a single gateway surface.
  private agents: AgentGateway;

  private root: string;
  private port: number;
  private portStart: number;
  private portSpan: number;
  private actualPort = 0;
  private framework: Framework = "unknown";
  private running = false;

  constructor(options?: EngineOptions) {
    this.root = options?.root
      ? path.resolve(options.root)
      : findProjectRoot(process.cwd());
    this.port = options?.port ?? engineBasePort();
    const requestedPortStart = options?.portStart ?? this.port;
    this.portStart =
      Number.isInteger(requestedPortStart) &&
      requestedPortStart >= this.port &&
      requestedPortStart < this.port + ENGINE_PORT_SPAN
        ? requestedPortStart
        : this.port;
    const remainingPortSpan = this.port + ENGINE_PORT_SPAN - this.portStart;
    const requestedPortSpan = options?.portSpan ?? ENGINE_PORT_SPAN;
    this.portSpan =
      Number.isInteger(requestedPortSpan) && requestedPortSpan > 0
        ? Math.min(remainingPortSpan, requestedPortSpan)
        : remainingPortSpan;
    this.cloudWorker = options?.executionBoundary
      ? null
      : loadCloudWorkerConfiguration();
    const cloudWorker = this.cloudWorker;
    if (cloudWorker) {
      assertQualifiedCloudAccountBinding(this.accountAuth);
      this.ownerAccountSub = cloudOwnerSubjectFromEnv();
      if (!this.ownerAccountSub) {
        throw new Error(
          "qualified cloud workspace needs ZEROS_CLOUD_OWNER_SUB",
        );
      }
    }
    this.executionBoundary =
      options?.executionBoundary ??
      new ZsrExecutionBoundary({
        projectRoot: this.root,
        ...(cloudWorker
          ? {
              cloudWorker,
              cloudWorkerToolchain: cloudWorker.toolchain,
            }
          : { localHostParity: true }),
      });
    const repoTaskBoundaryFactory = createRepoTaskBoundaryFactory(
      this.executionBoundary,
    );
    configureLoginShellPathRunner({
      cacheKey: `zsr:${this.root}`,
      run: async (command, args, { timeoutMs }) => {
        if (!path.isAbsolute(command)) {
          throw new Error("login shell must be an absolute path");
        }
        const env = stripEngineAuthorityEnv(
          Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          ),
        );
        const prepared = await repoTaskBoundaryFactory({
          executionId: `login-shell-path-${randomBytes(12).toString("hex")}`,
          cwd: this.root,
          workspaceRoot: this.root,
          repoRoot: this.root,
          env,
          serviceCapabilities: "none",
          // Nobody is blocked on the engine learning its own login PATH. This
          // used to admit as `interactive` (the factory's omitted default) and
          // therefore could not be jumped by the session the user was actually
          // starting — the boot burst's `admitted generic in 6410ms` line.
          admissionPriority: "background",
        });
        try {
          const child = await prepared.spawn({
            command,
            args,
            cwd: this.root,
            env,
            stdio: "pipe",
          });
          let stdout = "";
          let overflow = false;
          child.stdout?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            if (overflow) return;
            stdout += chunk;
            if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
              overflow = true;
              stdout = "";
            }
          });
          child.stderr?.resume();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const exit = await Promise.race([
              child.wait(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("login shell PATH probe timed out")),
                  timeoutMs,
                );
                timer.unref?.();
              }),
            ]);
            if (exit.code !== 0 || overflow) {
              throw new Error("login shell PATH probe failed");
            }
            return { stdout };
          } finally {
            if (timer) clearTimeout(timer);
          }
        } finally {
          await prepared.stopAndProve();
        }
      },
    });

    // Initialize components
    this.cache = new EngineCache(this.root);
    this.workspace = new WorkspaceService(this.root);
    this.workspace.setRepoTaskBoundaryFactory(repoTaskBoundaryFactory);
    // Let the mcp.gateway.* ops reach the (lazily-created) gateway instance.
    this.workspace.setGatewayAccessor(() => this.mcpGateway);
    this.workspace.setGatewayErrorAccessor(() => this.gatewayError);
    this.workspace.setGatewayHeaderSecretSetter((url, name, value) =>
      this.setMcpHeaderSecret(url, name, value),
    );
    this.workspace.setDesignTerritoryTransitioner((targets, mutation) =>
      this.withDesignTerritoryTransition(targets, mutation),
    );
    this.pty = new PtyService(
      this.root,
      cloudWorker
        ? (request) =>
            createNodePtyShell({
              ...request,
              cloudWorkerIdentity: cloudWorker,
              cloudWorkerSetprivPath: cloudWorker.toolchain.setpriv,
            })
        : createNodePtyShell,
      createTerminalMirror,
      cloudWorker
        ? { agentAuthIdentity: { uid: cloudWorker.uid, gid: cloudWorker.gid } }
        : undefined,
    );
    // Warm the login-shell PATH probe (`$SHELL -ilc 'echo $PATH'`) off the
    // critical path. It's cached process-wide and every one-shot command shell
    // — Setup script, Run action — awaits it before spawning; resolving it here
    // keeps that from showing up as a stall on the FIRST Run of a session.
    // Fire-and-forget: the resolver already falls back to the inherited PATH.
    //
    // DEFERRED, not immediate (§5.1): it admits a real boundary, and starting
    // that at engine construction put it in the middle of the boot burst —
    // ahead of the chats the user was opening. Nothing needs it until the first
    // Setup/Run, so let boot settle first. The timer is unref'd so it can never
    // hold the process open, and `admissionPriority: "background"` above means
    // even a late overlap yields to a real session.
    const loginShellWarmTimer = setTimeout(() => {
      void getLoginShellPath().catch(() => {
        /* probe failures are handled inside the resolver */
      });
    }, BOOT_LOGIN_SHELL_PATH_WARM_DELAY_MS);
    loginShellWarmTimer.unref?.();
    // Background setup runner (Setup tab): owns the worktree setup PTY, buffers
    // its output, and flips workspaces.setup_state on exit. It rides the same
    // pty.onData/onExit callbacks below (setup sessions are id-prefixed "setup:").
    this.setup = new SetupManager(
      this.pty,
      (workspaceId) =>
        this.broadcast(
          createMessage({
            type: "DB_CHANGED",
            source: "engine",
            kinds: ["workspaces"],
            ...(workspaceId ? { workspaceIds: [workspaceId] } : {}),
          }),
        ),
      undefined,
      repoTaskBoundaryFactory,
    );
    // Run-action status engine (Run tab): owns the run PTYs' lifecycle +
    // verdicts. Rides the same pty.onExit callback below (run sessions are
    // id-prefixed "pty-run-"); the terminal REGISTRY entry it registers makes
    // the run tab discoverable/attachable on every device, like a
    // renderer-spawned terminal.
    this.runs = new RunManager(
      this.pty,
      (workspaceId) =>
        this.broadcast(
          createMessage({
            type: "DB_CHANGED",
            source: "engine",
            kinds: ["workspaces"],
            ...(workspaceId ? { workspaceIds: [workspaceId] } : {}),
          }),
        ),
      (sessionId, cwd) => {
        if (this.terminals.has(sessionId)) {
          if (this.terminals.markAlive(sessionId))
            this.broadcastTerminalsChanged();
          return;
        }
        const added = this.terminals.add({
          sessionId,
          workspaceId: this.workspace.workspaceIdForCwd(cwd),
          cwd,
          createdAt: Date.now(),
        });
        if (added) this.broadcastTerminalsChanged();
      },
      undefined,
      repoTaskBoundaryFactory,
    );
    this.pty.onData((sessionId, data) => {
      // Shared terminals (multiplayer): fan PTY output to EVERY connected client
      // so the Mac AND the web watch the same shell live. Each client filters by
      // sessionId (it renders only terminals it has open). With deterministic
      // per-(folder,index) ids, both devices land on the SAME sessionId.
      this.broadcast(
        createMessage({ type: "PTY_DATA", source: "engine", sessionId, data }),
      );
      // Mirror setup-PTY output into the SetupManager buffer (no-op otherwise).
      this.setup.appendData(sessionId, data);
      // Same for run-action PTYs: a run that exits before the renderer attaches
      // has no other copy (its live mirror is disposed on exit), so buffer it
      // for the terminal's fast-exit replay (workspace.runLog).
      this.runs.appendData(sessionId, data);
    });
    this.pty.onExit((sessionId, exitCode, signal, reason) => {
      // `signal` matters as much as `exitCode`: node-pty reports a killed PTY as
      // `exitCode 0, signal N`, so a verdict read off the code alone scores an
      // OOM-killed or externally-killed install as a PASS.
      // Flip setup_state on a setup PTY's exit (no-op for normal terminals).
      this.setup.handleExit(sessionId, exitCode, signal);
      // Flip a run action's state on its PTY's exit (no-op otherwise).
      this.runs.handleExit(sessionId, exitCode, signal);
      this.broadcast(
        createMessage({
          type: "PTY_EXIT",
          source: "engine",
          sessionId,
          exitCode,
          signal,
          ...(reason ? { reason } : {}),
        }),
      );
      // Distinguish an EXPLICIT close from a natural shell exit:
      //  • explicit close (a client sent PTY_KILL) → remove the terminal so every
      //    device drops the tab (multiplayer close).
      //  • natural exit (the shell ran `exit` / the process died) → KEEP the
      //    entry, flagged exited, so every device shows "(exited)" and can
      //    restart it in place (the entry un-exits on the next PTY_CREATE).
      const wasExplicit = this.explicitlyClosing.delete(sessionId);
      const changed = wasExplicit
        ? this.terminals.remove(sessionId)
        : this.terminals.markExited(sessionId);
      if (changed) this.broadcastTerminalsChanged();
    });
    // Setup tab ops (workspace.setupInfo / workspace.rerunSetup /
    // workspace.stopSetup) reach the SetupManager — which owns this.pty/
    // this.setup — through injected accessors, mirroring the gateway-accessor
    // pattern above. All are local-only (not on any remote allowlist), so a
    // relay client never reaches them.
    this.workspace.setSetupRunner((workspaceId, command, target) => {
      if (!this.workspaceAllowsProcessStart(workspaceId)) return;
      void this.trackWorkspaceProcessStart(
        workspaceId,
        this.setup.start({ workspaceId, command, target }),
      ).catch((err) =>
        console.error(`[setup] start failed for ${workspaceId}:`, err),
      );
    });
    this.workspace.setSetupStopper((workspaceId) =>
      this.setup.stop(workspaceId),
    );
    // Archive/delete reaper: kill every engine-owned process still working
    // inside the worktree BEFORE the folder is snapshotted/removed — the
    // setup PTY (a mid-flight `npm install` recreates directories under the
    // removal), live run-action PTYs, and shell terminals cwd'd there.
    // Terminal kills go through the explicit-close path so every client
    // drops the tab instead of showing "(exited)".
    this.workspace.setWorkspaceProcessReaper(
      async (workspaceId, worktreePath) => {
        const root = path.resolve(worktreePath);
        const isUnderRoot = (candidate: string): boolean => {
          const relative = path.relative(root, path.resolve(candidate));
          return (
            relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative))
          );
        };
        // Resolving an owner reads the workspace list, and the same folder
        // backs many PTYs/terminals/chats — memoize per reap so one lifecycle
        // costs one lookup per DISTINCT path.
        const ownerCache = new Map<string, string | null>();
        const ownerOf = (candidate: string): string | null => {
          const cached = ownerCache.get(candidate);
          if (cached !== undefined) return cached;
          let owner: string | null = null;
          try {
            owner = this.workspace.workspaceIdForCwd(candidate);
          } catch {
            owner = null;
          }
          ownerCache.set(candidate, owner);
          return owner;
        };
        // Path containment alone is insufficient: a separately registered,
        // more-specific workspace may live below this folder. A RESOLVED owner
        // is authoritative — it must be able to EXCLUDE as well as include —
        // and raw containment is only the fallback for an unresolvable folder
        // (a legacy engine resource that predates workspace binding, or a
        // delete whose row is already gone).
        const belongsToWorkspace = (candidate: string): boolean => {
          const owner = ownerOf(candidate);
          return owner ? owner === workspaceId : isUnderRoot(candidate);
        };
        // Cancel manager-owned PRE-SPAWN flights before waiting: setup/run env
        // resolution can otherwise consume the whole lifecycle timeout even
        // though no child exists yet. These cancel-only entry points must never
        // kill a live PTY — kill() drops the session synchronously and
        // waitForExit() resolves true for an unknown one, so anything killed
        // before the enumeration below would be invisible to the exit wait and
        // the worktree could be removed while the process is still exiting.
        // The live ones are stopped after their exit observers are registered.
        this.setup.cancelPendingStart(workspaceId);
        this.runs.cancelPendingStartsForWorkspace(workspaceId);
        // Starts already admitted before this lifecycle acquired its
        // single-flight may still be resolving environment/session state and
        // therefore have no PTY/session to enumerate yet. Wait for them first.
        // Starts arriving after acquisition fail the lifecycle gate.
        await this.waitForWorkspaceProcessStarts(workspaceId);

        // Agent prompts are not necessarily represented by a workspace PTY
        // (SDK-backed agents can share a gateway process). Cancel them at the
        // engine boundary too, then dispose every session scoped to this
        // worktree. An idle SDK session can still own a watcher/subprocess even
        // when promptSessions is empty.
        const agentSessionIds = new Set<string>();
        for (const [sessionId, boundWorkspaceId] of this.sessionWorkspace) {
          if (boundWorkspaceId !== workspaceId) continue;
          const chatId = this.sessionChat.get(sessionId);
          const folder = chatId ? getChatLocation(chatId)?.folder : null;
          if (!folder || belongsToWorkspace(folder)) {
            agentSessionIds.add(sessionId);
          }
        }
        for (const [sessionId, chatId] of this.sessionChat) {
          const folder = getChatLocation(chatId)?.folder;
          if (folder && belongsToWorkspace(folder)) {
            agentSessionIds.add(sessionId);
            // Preserve a lifecycle tombstone after the adapter session is
            // disposed. A late prompt carrying only the old session id must
            // still resolve to this archived/deleted managed workspace and be
            // refused instead of escaping the gate as "unmanaged".
            this.sessionWorkspace.set(sessionId, workspaceId);
          }
        }
        const promptsSettled =
          await this.cancelLiveAgentSessions(agentSessionIds);
        if (!promptsSettled) {
          throw new GitError({
            code: "GIT_COMMAND_FAILED",
            message: `Couldn't stop every agent using ${worktreePath}`,
            remediation:
              "The workspace remains live. Stop its running agents, then retry.",
            context: { workspaceId, worktreePath },
          });
        }
        const endedAgents = await Promise.all(
          [...agentSessionIds].map(async (sessionId) => {
            const agentId = this.sessionAgent.get(sessionId);
            if (!agentId) return { sessionId, ended: true };
            let timer: ReturnType<typeof setTimeout> | null = null;
            try {
              const ended = await Promise.race([
                this.agents
                  .endSession(agentId, sessionId, { failClosed: true })
                  .then(() => true)
                  .catch(() => false),
                new Promise<boolean>((resolve) => {
                  timer = setTimeout(() => resolve(false), 3_000);
                }),
              ]);
              return { sessionId, ended };
            } finally {
              if (timer) clearTimeout(timer);
            }
          }),
        );
        for (const { sessionId, ended } of endedAgents) {
          if (!ended) continue;
          const conversationId = this.sessionChat.get(sessionId);
          this.router.clearOwner(sessionId);
          this.sessionAgent.delete(sessionId);
          this.sessionMessages.delete(sessionId);
          this.sessionLoadResponses.delete(sessionId);
          this.detachedProviderBindings.delete(sessionId);
          this.exitedAgentExecutions.delete(sessionId);
          this.activePromptContexts.delete(sessionId);
          this.clearPendingAgentInteractions(sessionId);
          if (
            conversationId &&
            this.conversationExecution.get(conversationId) === sessionId
          ) {
            this.conversationExecution.delete(conversationId);
          }
        }
        if (endedAgents.some(({ ended }) => !ended)) {
          throw new GitError({
            code: "GIT_COMMAND_FAILED",
            message: `Couldn't close every agent session using ${worktreePath}`,
            remediation:
              "The workspace remains live. Close its agent sessions, then retry.",
            context: { workspaceId, worktreePath },
          });
        }
        const ptyIds = this.pty
          .list()
          .filter((session) => belongsToWorkspace(session.cwd))
          .map((session) => session.sessionId);
        const ptyIdSet = new Set(ptyIds);
        // Register exit observers BEFORE the managers call kill(); a fast process
        // can otherwise exit between kill and waiter registration.
        const exitWaits = ptyIds.map((sessionId) =>
          this.pty.waitForExit(sessionId),
        );
        this.setup.stop(workspaceId);
        this.runs.stopAllForWorkspace(workspaceId);
        const terminalIds = new Set(
          this.terminals.sessionIds().filter((sessionId) => {
            const terminal = this.terminals.get(sessionId);
            if (!terminal) return false;
            // A resolved owner is authoritative both ways, so a row whose
            // durable binding predates a more-specific nested workspace is
            // excluded here rather than reaped across that boundary.
            const owner = ownerOf(terminal.cwd);
            if (owner) return owner === workspaceId;
            // Unresolvable owner (a legacy row that carried only a raw cwd, or
            // a delete whose workspace row is already gone): fall back to the
            // durable binding, then to raw containment — the same set the PTY
            // filter admits, so every terminal we kill also gets the
            // explicit-close marker and the stale-row prune below.
            return (
              terminal.workspaceId === workspaceId || isUnderRoot(terminal.cwd)
            );
          }),
        );
        for (const sessionId of terminalIds) {
          // Exited terminals have only a registry row, no process. Live ones
          // take the normal explicit-close path and disappear on PTY_EXIT.
          if (ptyIdSet.has(sessionId)) {
            this.explicitlyClosing.add(sessionId);
            this.pty.kill(sessionId);
          }
        }
        // Cover any engine-owned process cwd'd here that is not represented in
        // setup/run/terminal registries. The operation owns this workspace, so no
        // writer may survive into snapshot/removal.
        for (const sessionId of ptyIds) {
          if (!terminalIds.has(sessionId) && this.pty.has(sessionId)) {
            this.pty.kill(sessionId);
          }
        }
        const observed = await Promise.all(exitWaits);
        if (observed.some((exited) => !exited)) {
          throw new GitError({
            code: "GIT_COMMAND_FAILED",
            message: `Couldn't stop every process using ${worktreePath}`,
            remediation:
              "The workspace remains live. Close its terminals and running tasks, then retry.",
            context: {
              workspaceId,
              worktreePath,
              processCount: observed.filter((exited) => !exited).length,
            },
          });
        }
        try {
          await Promise.all([
            this.setup.proveWorkspaceBoundaryStopped(workspaceId),
            this.runs.proveWorkspaceBoundariesStopped(workspaceId),
          ]);
        } catch (error) {
          throw new GitError({
            code: "CONTAINMENT_TEARDOWN_FAILED",
            message: `Couldn't prove repository-task containment stopped for ${worktreePath}`,
            cause: error,
            remediation:
              "The workspace remains live. Restart Zeros so stale process-domain recovery can run, then retry.",
            context: { workspaceId, worktreePath },
          });
        }
        // Natural-exit tabs have no PTY_EXIT left to retire them. Once every
        // live process is confirmed gone, prune those stale rows too so restore
        // cannot surface a restartable terminal from the archived workspace.
        let terminalsChanged = false;
        for (const sessionId of terminalIds) {
          this.explicitlyClosing.delete(sessionId);
          terminalsChanged =
            this.terminals.remove(sessionId) || terminalsChanged;
        }
        if (terminalsChanged) this.broadcastTerminalsChanged();
      },
    );
    this.workspace.setWorkspaceCheckoutWatchSuspender(
      async (_workspaceId, worktreePath) =>
        (await this.gitWatcher?.suspendRoot(worktreePath)) ?? {
          resume() {},
          retire() {},
        },
    );
    this.workspace.setSetupInfoGetter((workspaceId) =>
      this.setup.info(workspaceId),
    );
    // Run tab ops (workspace.runInfo / workspace.startRun / workspace.stopRun)
    // reach the RunManager through the same injected-accessor pattern. All are
    // Repository-task controls are shared with cloud clients; the manager
    // validates their expected workspace owner and spawns through ZSR.
    this.workspace.setRunStarter((args) => {
      if (
        args.workspaceId &&
        !this.workspaceAllowsProcessStart(args.workspaceId)
      ) {
        this.assertWorkspaceProcessStartAllowed(args.workspaceId);
      }
      return this.trackWorkspaceProcessStart(
        args.workspaceId,
        this.runs.start(args),
      );
    });
    this.workspace.setRunStopper((sessionId, expectedWorkspaceId) =>
      this.runs.stop(sessionId, expectedWorkspaceId),
    );
    this.workspace.setRunInfoGetter((sessionIds, workspaceId) =>
      this.runs.info(sessionIds, workspaceId),
    );
    this.workspace.setRunLogGetter((sessionId, expectedWorkspaceId) =>
      this.runs.log(sessionId, expectedWorkspaceId),
    );
    this.resolver = new CSSResolver(this.root, this.cache);
    this.writer = new CSSFileWriter(this.root, this.cache);

    this.watcher = new FileWatcher(
      this.root,
      this.cache,
      (filePath, type, fileType) => {
        this.handleFileChange(filePath, type, fileType);
      },
    );

    // Transports: the loopback server is the only transport in this local-only
    // build. (A future CloudTransport will be pushed into this.transports[] to
    // reach an in-sandbox engine over a preview-URL WSS.)
    //
    // The loopback WebSocket authenticates with a per-process token minted by
    // this engine. A sidecar child returns it to Electron over private fd 3;
    // standalone engines keep it process-local. It never rides the spawn env,
    // command line, manifest, or logs. Combined with an Origin allowlist,
    // this stops any website the user visits from driving the engine as a
    // trusted "local" client. The dev renderer's http origin is allowlisted; the
    // packaged renderer loads file:// (always allowed).
    this.localToken = randomBytes(32).toString("hex");
    this.workspace.setDesignProtocolCapabilityProvider((workspaceId) =>
      createDesignProtocolCapability(this.localToken, workspaceId),
    );
    // The dev renderer's http origin is the Vite dev server. Its port is normally
    // 5193, but a per-worktree dev instance (scripts/dev-instance.mjs) moves Vite
    // to a free port and exports it as ZEROS_VITE_PORT so this allowlist tracks the
    // renderer's ACTUAL origin — otherwise the engine would reject that instance's
    // loopback WS on an Origin mismatch. Packaged builds load file:// (always ok).
    const devPort = Number.parseInt(
      process.env.ZEROS_VITE_PORT?.trim() || "",
      10,
    );
    const vitePort = Number.isInteger(devPort) && devPort > 0 ? devPort : 5193;
    const allowedOrigins = isDevRuntime()
      ? [`http://localhost:${vitePort}`, `http://127.0.0.1:${vitePort}`]
      : [];
    this.local = new LocalTransport({
      port: this.portStart,
      portSpan: this.portSpan,
      token: this.localToken,
      allowedOrigins,
      handleHttp: async ({ url }) => {
        const parsed = parseDesignProtocolResourcePath(
          url.pathname,
          this.localToken,
        );
        if (!parsed) return null;
        const { workspaceId, resourcePath } = parsed;
        const workspace = getWorkspaceById(workspaceId);
        if (!workspace || workspace.kind !== "design") return null;
        const resource = await readDesignProtocolResource(workspace.path, {
          path: resourcePath,
          sourceVersion: url.searchParams.get("v"),
        });
        return {
          status: resource.status,
          headers: resource.headers,
          body: resource.body,
        };
      },
    });
    this.transports = [this.local];

    // Cloud transport: when the engine runs inside a remote
    // sandbox the bootstrap sets ZEROS_CLOUD_PORT, and we add a SECOND transport
    // that binds 0.0.0.0 on that port so the Mac renderer can reach it over the
    // sandbox's public preview-URL WSS. It is a separate transport — LocalTransport's
    // loopback gate is untouched (do NOT relax it; see transport/cloud.ts). Inert
    // in the local desktop build (the env var is unset). The worker-minted
    // bridge token is mandatory; account binding adds a second gate when it is
    // configured.
    const cloudPort = parseCloudTransportPort(process.env.ZEROS_CLOUD_PORT);
    if (cloudPort !== null) {
      this.cloud = new CloudTransport({
        port: cloudPort,
        token: process.env.ZEROS_CLOUD_TOKEN?.trim() || "",
      });
      this.transports.push(this.cloud);
    }

    for (const t of this.transports) {
      t.onMessage((client, msg) => {
        // Safety net (gap A): an error escaping a sub-handler — i.e. not already
        // converted to an error response — is relayed to error tracking instead
        // of becoming a silent unhandled rejection.
        return this.handleMessage(msg, client).catch((err) => {
          this.reportEngineError(client, `message:${msg.type}`, err);
        });
      });
      t.onConnect((client) => {
        this.router.register(client);
        void this.handleConnect(client);
      });
      t.onDisconnect((client) => this.handleDisconnect(client));
    }

    // Native agent gateway — spawns agents on demand and fans notifications
    // over the same WebSocket the renderer is already listening on.
    // Credentials never cross this boundary; the agent owns its own auth.
    const backendOpts: AgentGatewayOptions = {
      projectRoot: this.root,
      executionBoundary: this.executionBoundary,
      ...(this.cloud
        ? { previewGatewayFactory: new CloudPreviewGatewayFactory() }
        : {}),
      events: {
        onBoundaryStatusChanged: (agentId, executionId, status) => {
          if (this.sessionAgent.get(executionId) !== agentId) return;
          this.routeSessionScoped(
            executionId,
            createMessage({
              type: "AGENT_BOUNDARY_STATUS_CHANGED",
              source: "engine",
              agentId,
              executionId,
              status,
              ...(this.sessionChat.get(executionId)
                ? { chatId: this.sessionChat.get(executionId) }
                : {}),
            }),
          );
        },
        onBoundaryPortsChanged: (agentId, executionId, snapshot) => {
          // The observer is attached during boundary preparation, before the
          // execution route is intentionally published. Suppress that initial
          // callback (the create/load response carries the exact snapshot) so
          // an unowned provisional execution can never broadcast to peers.
          if (this.sessionAgent.get(executionId) !== agentId) return;
          this.routeSessionScoped(
            executionId,
            createMessage({
              type: "AGENT_BOUNDARY_PORTS_CHANGED",
              source: "engine",
              agentId,
              executionId,
              snapshot,
              ...(this.sessionChat.get(executionId)
                ? { chatId: this.sessionChat.get(executionId) }
                : {}),
            }),
          );
        },
        onSessionUpdate: (
          agentId: string,
          notification: SessionNotification,
        ) => {
          if (
            notification.executionId &&
            notification.executionId !== notification.sessionId
          ) {
            console.warn(
              `[agents] ${agentId} emitted mismatched execution routes; update dropped`,
            );
            return;
          }
          if (
            (notification.update.sessionUpdate === "provider_binding_update" ||
              notification.update.sessionUpdate ===
                "provider_binding_detached") &&
            notification.update.providerBinding.providerId !== agentId
          ) {
            console.warn(
              `[agents] ${agentId} emitted another provider's binding; update dropped`,
            );
            return;
          }
          // Route the stream to the client that owns this session — not every
          // device. (Falls back to broadcast for an unowned session.)
          const executionId =
            notification.executionId ?? notification.sessionId;
          const executionAgentId = this.sessionAgent.get(executionId);
          if (executionAgentId && executionAgentId !== agentId) {
            console.warn(
              `[agents] ${agentId} emitted an update for ${executionAgentId}'s execution; update dropped`,
            );
            return;
          }
          const normalizedNotification = {
            ...notification,
            executionId,
            sessionId: executionId,
          };
          if (notification.update.sessionUpdate === "current_mode_update") {
            const cached = this.sessionLoadResponses.get(executionId);
            if (cached?.modes) {
              this.sessionLoadResponses.set(executionId, {
                ...cached,
                modes: {
                  ...cached.modes,
                  currentModeId: notification.update.currentModeId,
                },
              });
            }
          }
          if (notification.update.sessionUpdate === "provider_binding_update") {
            const detachedBinding =
              this.detachedProviderBindings.get(executionId);
            if (
              detachedBinding &&
              sameProviderBinding(
                detachedBinding,
                notification.update.providerBinding,
              )
            ) {
              console.warn(
                `[agents] ${agentId} emitted a binding update for an already-deleted provider reference; update dropped`,
              );
              return;
            }
            if (detachedBinding) {
              this.detachedProviderBindings.delete(executionId);
            }
            const cached = this.sessionLoadResponses.get(executionId) ?? {};
            this.sessionLoadResponses.set(executionId, {
              ...cached,
              providerBinding: notification.update.providerBinding,
              ...(notification.update.providerMetadata
                ? { providerMetadata: notification.update.providerMetadata }
                : {}),
            });
            this.persistProviderIdentityForChat(
              this.sessionChat.get(executionId),
              agentId,
              notification.update.providerBinding,
              notification.update.providerMetadata,
            );
          }
          if (
            notification.update.sessionUpdate === "provider_binding_detached"
          ) {
            const detachedBinding = notification.update.providerBinding;
            const cached = this.sessionLoadResponses.get(executionId);
            if (
              cached?.providerBinding &&
              !sameProviderBinding(cached.providerBinding, detachedBinding)
            ) {
              console.warn(
                `[agents] ${agentId} emitted a stale binding detachment; update dropped`,
              );
              return;
            }
            const chatId = this.sessionChat.get(executionId);
            const persistedBinding = chatId
              ? coerceProviderBinding(getChat(chatId)?.providerBinding)
              : null;
            if (
              persistedBinding &&
              !sameProviderBinding(persistedBinding, detachedBinding)
            ) {
              console.warn(
                `[agents] ${agentId} emitted a detachment older than the persisted binding; update dropped`,
              );
              return;
            }
            this.detachedProviderBindings.set(executionId, detachedBinding);
            if (cached) {
              const next = { ...cached };
              delete next.providerBinding;
              delete next.providerMetadata;
              this.sessionLoadResponses.set(executionId, next);
            }
            let cleared = false;
            if (chatId) {
              try {
                cleared = clearChatProviderIdentity(
                  chatId,
                  agentId,
                  detachedBinding,
                );
              } catch (err) {
                console.warn(
                  `[agents] failed to detach provider binding for chat ${chatId}: ` +
                    (err instanceof Error ? err.message : String(err)),
                );
              }
            }
            if (cleared) {
              this.broadcast(
                createMessage({
                  type: "DB_CHANGED",
                  source: "engine",
                  kinds: ["chats"],
                }),
              );
            }
          }
          this.touchActivePrompt(executionId);
          this.routeSessionScoped(
            executionId,
            createMessage({
              type: "AGENT_SESSION_UPDATE",
              source: "engine",
              agentId,
              executionId,
              notification: normalizedNotification as never,
              // Engine-authoritative routing: stamp the chat this session is
              // bound to so the renderer never drops an update on a stale
              // sessionId index (force-respawn / create-load / an adapter that
              // emits before the renderer has stored the sessionId). Same map
              // persistSessionUpdate uses below.
              ...(this.sessionChat.get(executionId)
                ? { chatId: this.sessionChat.get(executionId) }
                : {}),
            }),
          );
          // Persist the transcript as it streams; the engine is the source.
          this.persistSessionUpdate(executionId, normalizedNotification);
        },
        onPermissionRequest: (
          agentId: string,
          permissionId: string,
          request: RequestPermissionRequest,
        ) => {
          const sessionId = request.sessionId;
          this.touchActivePrompt(sessionId);
          this.pendingPermissionRequests.set(permissionId, {
            agentId,
            request,
          });
          // Record which client owns this prompt so only it (or a local host)
          // can answer — a relay client must not approve another's tool call.
          const owner = this.router.ownerOf(sessionId);
          if (owner) this.permissionOwner.set(permissionId, owner);
          this.routeSessionScoped(
            sessionId,
            createMessage({
              type: "AGENT_PERMISSION_REQUEST",
              source: "engine",
              agentId,
              permissionId,
              request: request as never,
            }),
          );
        },
        onPermissionSettled: (
          agentId: string,
          permissionId: string,
          sessionId: string,
        ) => {
          this.touchActivePrompt(sessionId);
          this.permissionOwner.delete(permissionId);
          // Twin of onQuestionSettled: this hook fires for EVERY way a resolver
          // dies (response, timeout, abort, rebuilt-SDK re-arm), so it is what
          // keeps the replay set honest. Without it a timed-out permission would
          // be re-sent to the next renderer as a card nothing can answer — the
          // exact failure replayPendingAgentInteractions exists to prevent.
          this.pendingPermissionRequests.delete(permissionId);
          this.routeSessionScoped(
            sessionId,
            createMessage({
              type: "AGENT_PERMISSION_SETTLED",
              source: "engine",
              agentId,
              permissionId,
              executionId: sessionId,
              sessionId,
            }),
          );
        },
        onQuestionRequest: (
          agentId: string,
          questionId: string,
          request: QuestionRequest,
        ) => {
          const sessionId = request.sessionId;
          this.touchActivePrompt(sessionId);
          this.pendingQuestionRequests.set(questionId, { agentId, request });
          const owner = this.router.ownerOf(sessionId);
          if (owner) this.questionOwner.set(questionId, owner);
          this.routeSessionScoped(
            sessionId,
            createMessage({
              type: "AGENT_QUESTION_REQUEST",
              source: "engine",
              agentId,
              questionId,
              request: request as never,
            }),
          );
        },
        onQuestionSettled: (
          agentId: string,
          questionId: string,
          sessionId: string,
          outcome: QuestionOutcome,
        ) => {
          this.touchActivePrompt(sessionId);
          // The engine resolver is gone (timeout / abort / answered elsewhere) —
          // any late AGENT_QUESTION_RESPONSE for this id is a no-op, so the
          // owner entry is dead weight either way.
          this.questionOwner.delete(questionId);
          this.pendingQuestionRequests.delete(questionId);
          this.routeSessionScoped(
            sessionId,
            createMessage({
              type: "AGENT_QUESTION_SETTLED",
              source: "engine",
              agentId,
              questionId,
              outcome: outcome as never,
            }),
          );
        },
        onAgentStderr: (agentId: string, line: string) => {
          this.broadcast(
            createMessage({
              type: "AGENT_AGENT_STDERR",
              source: "engine",
              agentId,
              line,
            }),
          );
        },
        onAgentExit: (
          agentId: string,
          code: number | null,
          signal: string | null,
          sessionId?: string | null,
        ) => {
          const exited = createMessage({
            type: "AGENT_AGENT_EXITED",
            source: "engine",
            agentId,
            ...(sessionId ? { executionId: sessionId } : {}),
            sessionId: sessionId ?? null,
            code,
            signal: signal ? String(signal) : null,
          });
          if (!sessionId) {
            this.broadcast(exited);
            return;
          }
          // Route while ownership/workspace tags still exist, then retire the
          // dead execution. Keeping an idle provider exit in these maps makes a
          // later chat reopen "re-adopt" a route the gateway can no longer run.
          this.routeSessionScoped(sessionId, exited);
          const promptStillSettling = this.activePromptContexts.has(sessionId);
          if (promptStillSettling) {
            this.exitedAgentExecutions.add(sessionId);
            this.sessionAgent.delete(sessionId);
            const conversationId = this.sessionChat.get(sessionId);
            if (
              conversationId &&
              this.conversationExecution.get(conversationId) === sessionId
            ) {
              this.conversationExecution.delete(conversationId);
            }
            void this.agents.endSession(agentId, sessionId).catch(() => {});
            return;
          }
          this.clearAgentExecutionRoute(sessionId, {
            preservePrompt: false,
          });
          void this.agents.endSession(agentId, sessionId).catch(() => {});
        },
      },
    };

    this.agents = new AgentGateway(backendOpts);
    this.loadMcpRegistry(); // boot-load; re-run by the settings watcher on edit

    const engineStartTime = Date.now();
    this.local.setInfoProvider(() => ({
      version: VERSION,
      uptime: Date.now() - engineStartTime,
      connections: this.local.connectionCount,
      stats: this.cache.stats(),
    }));
    this.cloud?.setInfoProvider(() => ({
      version: VERSION,
      uptime: Date.now() - engineStartTime,
      connections: this.cloud?.connectionCount ?? 0,
    }));
  }

  /** (Re)load the unified MCP registry from the resolved (user-level, global)
   *  settings — "configure once → all agents". resolveMcpServers() (no args)
   *  reads only ~/.zeros (+ managed), so this is the machine-wide set every
   *  workspace inherits; the per-session path re-resolves with the repo cwd.
   *  Called at boot
   *  AND by the settings watcher, so a hand-edit of ~/.zeros/settings.toml (or
   *  the Customize → MCP surface) reaches each agent's NEXT session with no
   *  restart. Best-effort: a malformed file never blocks boot or a reload. */
  private loadMcpRegistry(): void {
    try {
      // resolveMcpServers() (no args) composes user + managed PER-LAYER and
      // concatenates (first-wins), matching the per-session resolution exactly.
      // mcpServersFromSettings(effective) read the MERGED doc, where mcp.servers
      // replaces whole — so a managed layer declaring mcp.servers would have
      // dropped every user server. This keeps boot ≡ per-session.
      this.agents.setMcpServers(resolveMcpServers().servers);
    } catch (err) {
      console.warn(
        "[agents] MCP registry load failed (keeping the previous registry):",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Start the MCP gateway if the user-level settings declare any auth:"oauth"
   *  backend, and tell the agent gateway its URL so it's injected into sessions.
   *  Best-effort — a failure leaves agents running without the gateway. */
  private async startGateway(): Promise<void> {
    try {
      const { gatewayBackends } = resolveMcpServers();
      if (gatewayBackends.length === 0) {
        this.gatewayError = null; // nothing to front — not an error state
        return;
      }
      // base+8 = the gateway's MCP server; base+9 = the OAuth loopback redirect.
      // Both sit just past the engine's port-walk range [base, base+7]. Derived
      // from THIS engine's own base (this.port), not engineBasePort(), so a
      // per-worktree dev instance whose base was overridden gets its gateway ports
      // inside its OWN disjoint block instead of colliding with the default one.
      const gw = new McpGateway({
        port: this.port + ENGINE_PORT_SPAN,
        callbackPort: this.port + ENGINE_PORT_SPAN + 1,
        vault: this.ensureMcpVault(),
      });
      await gw.start(gatewayBackends);
      this.mcpGateway = gw;
      this.gatewayError = null;
      this.agents.setGatewayServer(gw.url);
      console.log(
        `[Zeros] MCP gateway on ${gw.url} fronting ${gatewayBackends.length} backend(s): ` +
          gw
            .getStatuses()
            .map((s) => `${s.name}(${s.state})`)
            .join(", "),
      );
    } catch (err) {
      this.gatewayError = err instanceof Error ? err.message : String(err);
      console.warn("[Zeros] MCP gateway failed to start:", this.gatewayError);
    }
  }

  /** Re-resolve the gateway's backend set on a settings change (fire-and-forget;
   *  the agent-facing endpoint stays stable so live sessions aren't dropped).
   *  Starts the gateway if a backend was just added, stops it if the last one
   *  was removed. */
  private reloadGateway(): void {
    // Serialize onto the chain: re-read this.mcpGateway AFTER each await so two
    // queued reloads can never both construct a gateway on the fixed port.
    const run = async () => {
      try {
        const { gatewayBackends } = resolveMcpServers();
        if (gatewayBackends.length === 0) {
          if (this.mcpGateway) {
            await this.mcpGateway.stop();
            this.mcpGateway = null;
            this.agents.setGatewayServer(null);
          }
          this.gatewayError = null;
          return;
        }
        if (!this.mcpGateway) {
          await this.startGateway();
        } else {
          await this.mcpGateway.reload(gatewayBackends);
          this.gatewayError = null;
        }
      } catch (err) {
        this.gatewayError = err instanceof Error ? err.message : String(err);
        console.warn("[Zeros] MCP gateway reload failed:", this.gatewayError);
      }
    };
    this.gatewayReloadChain = this.gatewayReloadChain.then(run, run);
  }

  /** The engine-level OAuth token vault, created on first use and seeded from the
   *  host's durable store (safeStorage) — pushed over stdin as `host.mcpVault`
   *  before this ran (buffered in `mcpVaultSeed`). Its onChange persists every
   *  mint/refresh/clear back to the host via the control fd, so tokens survive an
   *  engine restart. One vault for the whole process: a gateway stop/start
   *  (last oauth server removed, then re-added) keeps the live tokens. */
  private ensureMcpVault(): OAuthVault {
    if (!this.mcpVault) {
      this.mcpVault = new OAuthVault(() => this.scheduleVaultPersist());
      if (this.mcpVaultSeed) {
        this.mcpVault.restore(this.mcpVaultSeed);
        this.mcpVaultSeed = null;
      }
    }
    return this.mcpVault;
  }

  /** Coalesce a burst of vault writes (e.g. a refresh that rotates several
   *  tokens) into one control-fd message. */
  private scheduleVaultPersist(): void {
    if (this.vaultPersistTimer) return;
    this.vaultPersistTimer = setTimeout(() => {
      this.vaultPersistTimer = null;
      this.flushVaultPersist();
    }, 250);
  }

  /** Ask the host to persist the current vault to safeStorage. Written to the
   *  dedicated control fd (ZEROS_CONTROL_FD) — a private engine→host pipe the host
   *  never logs and the relay never sees, so the plaintext token blob stays off
   *  stdout/main.log AND off the renderer. No-op when there's no control fd (a
   *  standalone / CLI engine has no safeStorage host to persist to). */
  private flushVaultPersist(): void {
    if (!this.mcpVault) return;
    const fd = Number(process.env.ZEROS_CONTROL_FD);
    if (!Number.isInteger(fd) || fd <= 2) return;
    try {
      fs.writeSync(fd, vaultControlLine(this.mcpVault.snapshot()));
    } catch {
      /* host gone / pipe closed — the in-memory vault still serves this session */
    }
  }

  private publishLocalAuthorityToHost(): void {
    const fd = Number(process.env.ZEROS_CONTROL_FD);
    if (!Number.isInteger(fd) || fd <= 2) return;
    try {
      fs.writeSync(fd, engineLocalAuthorityControlLine(this.localToken));
    } catch {
      // Without the sidecar control pipe the parent cannot authenticate the
      // renderer and therefore never publishes this child as ready.
    }
  }

  /** Store a static auth-header secret for an MCP gateway backend (auth:"header")
   *  in the engine vault — persisted to safeStorage, NEVER written to settings.toml,
   *  the renderer, or any agent's command line — then (re)start the gateway so it
   *  fronts the backend with the header. Keyed by the backend's canonical resource
   *  URI (the vault key). Driven by the LOCAL-ONLY mcp.gateway.setHeaderSecret op
   *  when the user saves/imports the key. */
  private setMcpHeaderSecret(
    url: string,
    headerName: string,
    value: string,
  ): void {
    const vault = this.ensureMcpVault();
    vault.setHeader(canonicalResourceUri(url), { name: headerName, value }); // → persist
    this.reloadGateway(); // re-resolve + (re)connect so the backend picks up the header
  }

  /**
   * Start the engine. Builds indexes, starts server, starts watcher.
   */
  async start(): Promise<void> {
    if (this.running) return;

    const startTime = Date.now();

    // Recover hard-crash process domains before publishing a renderer token or
    // opening any transport. On macOS a detached, double-forked Seatbelt child
    // can outlive its POSIX process group; its generation-private kernel
    // fingerprint must remain intact until the native helper proves it empty.
    // Recovery failure aborts startup instead of silently restoring authority.
    const boundaryRecovery =
      await this.executionBoundary.recoverStaleProcesses?.();
    if (boundaryRecovery?.recovered) {
      console.log(
        `[Zeros] recovered ${boundaryRecovery.recovered} crashed process domain(s)`,
      );
    }
    const { sessionsRoot, sweepDeadSessions } =
      await import("./agents/session-paths");
    if (process.platform === "darwin") {
      const { recoverOrphanedOrbStackMachines } =
        await import("./agents/containment/macos-orbstack-container-worker");
      const orbStackRecovery = await recoverOrphanedOrbStackMachines({
        sessionsRoot: sessionsRoot(),
      });
      if (orbStackRecovery.active > 0) {
        throw new Error(
          `${orbStackRecovery.active} OrbStack container worker(s) are owned by another live Zeros engine`,
        );
      }
      if (orbStackRecovery.retained > 0) {
        throw new Error(
          `could not safely retire ${orbStackRecovery.retained} crashed OrbStack container worker(s); start or update OrbStack, ensure at least 4 GiB is free, and restart Zeros (recovery state was preserved)`,
        );
      }
      if (orbStackRecovery.recovered > 0) {
        console.log(
          `[Zeros] recovered ${orbStackRecovery.recovered} crashed OrbStack container worker(s)`,
        );
      }
    }
    const mutableRecovery =
      await this.executionBoundary.recoverStaleMutableState?.();
    if (mutableRecovery?.recovered) {
      console.log(
        `[Zeros] recovered ${mutableRecovery.recovered} crashed mutable runtime state entr${mutableRecovery.recovered === 1 ? "y" : "ies"}`,
      );
    }
    if (mutableRecovery?.preserved) {
      console.warn(
        `[Zeros] retained ${mutableRecovery.preserved} mutable runtime recovery entr${mutableRecovery.preserved === 1 ? "y" : "ies"} for a later retry`,
      );
    }
    const swept = await sweepDeadSessions();
    if (swept > 0) {
      console.log(`[Zeros] swept ${swept} crashed session dir(s)`);
    }

    // Publish launch authority only after stale write capabilities are gone.
    // The parent accepts readiness after both this private control message and
    // the owned runtime manifest arrive, so no renderer receives a token for
    // the wrong child generation.
    this.publishLocalAuthorityToHost();

    // 1. Detect framework
    const detection = detectFramework(this.root);
    this.framework = detection.framework;

    console.log(`[Zeros] Framework: ${this.framework}`);
    // Make the resolved release channel VISIBLE at every boot. A misconfigured
    // launch (for example, Beta resolving as Stable and taking Stable's engine
    // block/data dirs) shows up here instead of as mysterious cross-channel
    // contamination. See apps/desktop/src/engine/runtime.ts. The channel + base port are
    // non-sensitive; the ABSOLUTE project-root + data-dir paths are
    // user-identifying and land in the shipped main.log, so they're gated
    // behind ZEROS_DEBUG_PATHS=1.
    console.log(`[Zeros] Runtime: ${channel()} · base port ${this.port}`);
    if (process.env.ZEROS_DEBUG_PATHS === "1") {
      console.log(`[Zeros] Project root: ${this.root}`);
      console.log(`[Zeros] Data dir: ${zerosDataDir()}`);
    }

    // One-time settings carry-over for the 3-way dot-dir split. Before the split
    // Beta wrote settings into Production's `~/.zeros`; splitting the dirs without
    // this would silently reset every existing Beta user to defaults on upgrade.
    // Must run BEFORE loadMcpRegistry() / the settings watcher / any read of the
    // user layer. Synchronous, idempotent, never overwrites, never throws — see
    // settings/files.ts seedUserSettingsFromLegacyRoot.
    seedUserSettingsFromLegacyRoot();

    // The host owns durable GitHub credentials. The engine holds only the
    // selected in-memory working copy and reports invalidation as method +
    // reason — never the credential value.
    setTokenStore(engineGithubTokenStore);
    setGithubCredentialChangeNotifier((change) =>
      this.publishGithubCredentialChange(change),
    );

    if (this.cloudWorker && this.ownerAccountSub) {
      this.cloudGithubCredentialWatcher = watchCloudGithubCredentialProjection({
        ownerSubject: this.ownerAccountSub,
        onChange: (credential, method) => {
          seedGithubCredential(credential, method);
          if (credential) this.primeGithubLogin();
        },
        onRejected: () => {
          console.warn(
            "[Zeros] rejected the cloud GitHub credential projection",
          );
        },
      });
    }

    // Electron couriers the selected credential over private stdin. The engine
    // never auto-adopts gh on its own: that implicit writer made an explicit
    // disconnect re-connect on the next refresh/restart.
    this.setupHostControlChannel();
    this.setupParentDeathWatchdog();

    // 1a. One-time fold-in of the legacy ~/.zeros/state.db (workspaces + meta +
    // detach_state) into the unified zeros.db. Runs before seedFromDisk
    // so the richer DB rows win over disk re-seeding. Idempotent + best-effort;
    // reads the legacy file read-only and never deletes it (recovery net).
    try {
      const { migrateLegacyStateDb } = await import("./db/state-import");
      migrateLegacyStateDb();
    } catch {
      /* best-effort — never block startup on migration */
    }

    // 1a.2. Finish any create/archive/restore/delete interrupted between Git,
    // filesystem, and SQLite BEFORE any relocation or seed janitor can reinterpret
    // its source/target paths. A failed entry retains its journal and is skipped
    // by relocation below.
    try {
      const { reconcileInterruptedWorkspaceLifecycles } =
        await import("./git/worktree");
      const result = await reconcileInterruptedWorkspaceLifecycles(
        createRepoTaskBoundaryFactory(this.executionBoundary),
      );
      if (result.recovered > 0 || result.failed > 0) {
        console.log(
          `[Zeros] workspace lifecycle recovery: ${result.recovered} completed, ${result.failed} pending`,
        );
      }
    } catch {
      /* keep startup alive; journals/refs remain for the next retry */
    }

    // Reclaim heavy dependency/build directories staged by an engine that died
    // during archive/delete. Run only AFTER lifecycle recovery: a successfully
    // recovered journal no longer protects its trash; a still-pending journal
    // keeps the exact worktree's staged directories intact for another retry.
    try {
      const { pruneStaleHeavyDirTrash } = await import("./git/cleanup");
      const { legacyWorktreesRoot, listWorkspaceLifecycles, worktreesRoot } =
        await import("./git/state");
      const protectedPaths = new Set<string>();
      for (const journal of listWorkspaceLifecycles()) {
        if (journal.sourcePath) protectedPaths.add(journal.sourcePath);
        if (journal.targetPath) protectedPaths.add(journal.targetPath);
      }
      const scheduled = await pruneStaleHeavyDirTrash({
        managedRoots: [worktreesRoot(), legacyWorktreesRoot()],
        protectedWorktreePaths: protectedPaths,
      });
      if (scheduled > 0) {
        console.log(
          `[Zeros] scheduled cleanup for ${scheduled} abandoned archive trash director${scheduled === 1 ? "y" : "ies"}`,
        );
      }
    } catch {
      /* best-effort — temp trash is never startup-critical */
    }

    // 1a.5. One-time relocation of worktrees from the hidden ~/.zeros/worktrees
    // to the visible ~/zeros/workspaces. Runs at startup before any
    // agent spawns (so nothing holds a worktree cwd) and before seedFromDisk
    // (whose dual-root scan then recovers any that couldn't move). git-native
    // `worktree move` is atomic per worktree; failures leave the source intact.
    try {
      const { migrateWorktreesToNewRoot } = await import("./git/worktree");
      await migrateWorktreesToNewRoot();
    } catch {
      /* best-effort — never block startup on relocation */
    }

    // 1b. Crash recovery: re-register on-disk worktrees missing from
    // the registry (e.g. after a dev wipe). Idempotent — skips rows that
    // already exist and seeds lacking a repoRoot/branch. Only worktrees
    // whose folder + .zeros/workspace.json survive on disk are recovered, so
    // intentionally archived/deleted worktrees (folder gone) are never resurrected.
    try {
      const { seedFromDisk } = await import("./git/state");
      const { inserted } = seedFromDisk();
      if (inserted > 0) {
        console.log(
          `[Zeros] recovered ${inserted} orphaned workspace(s) from disk`,
        );
      }
    } catch {
      /* best-effort — never block startup on crash recovery */
    }

    // Mode/legacy-permission reconcile. First complete any mode transition a crash
    // interrupted (the durable marker knows the intended direction). Then two
    // routine invariants, per live stable owner, before any agent can spawn:
    //
    //   1. Every checkout sheds the process-independent ACLs installed by
    //      historical builds. The current boundary is scoped to Zeros actors,
    //      so external editors and coding platforms retain ordinary access.
    //   2. The one-time cleanup is durable and idempotent. A cleanup failure is
    //      logged and retried next boot, but is not an agent-admission gate.
    try {
      const { listWorkspaces, getWorkspaceLifecycle } =
        await import("./git/state");
      const { reconcileDesignModeTransition } =
        await import("./git/design-mode");
      const { cleanupLegacyDesignFilesystemGuards } =
        await import("./design/workspace-lock");
      for (const workspace of listWorkspaces()) {
        if (
          workspace.archivedAt != null ||
          getWorkspaceLifecycle(workspace.id) ||
          !fs.existsSync(workspace.path)
        ) {
          continue;
        }
        await reconcileDesignModeTransition(workspace.id).catch((error) => {
          console.warn(
            `[Zeros] couldn't complete the interrupted mode switch for ${workspace.id}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        // Re-read: the transition reconcile may have flipped the row.
        const settled = getWorkspaceById(workspace.id) ?? workspace;
        await cleanupLegacyDesignFilesystemGuards(settled.path).catch(
          (error) => {
            console.warn(
              `[Zeros] couldn't remove historical Design ACLs for ${workspace.id}; cleanup will retry next boot: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          },
        );
      }
    } catch {
      /* best-effort — failures are logged per workspace above */
    }

    // Clear any setup_state="running" left over from a previous process (engine
    // quit mid-install) so the Setup tab doesn't spin forever — the in-memory
    // setup buffers are empty now, so a "running" row is necessarily orphaned.
    this.setup.reconcileStaleRuns();

    // Same janitor for turn rows: a crash mid-turn leaves `status='running'`
    // in the turns table (a phantom live turn in the checkpoint timeline). No
    // prompt is in flight at boot, so settle them as failed — and FINISH the
    // attribution finishTurn never got to do (post snapshot at boot + authored
    // paths from the persisted transcript), so the crashed turn's file changes
    // stay visible to "Reset to this point" instead of silently escaping it.
    try {
      const { settleOrphanRunningTurns } = await import("./git/turn-recovery");
      const settled = await settleOrphanRunningTurns(Date.now());
      if (settled > 0) {
        console.log(`[Zeros] settled ${settled} orphaned running turn(s)`);
      }
    } catch {
      /* best-effort — never block startup on crash recovery */
    }

    // 1b.1. One-time: move legacy in-worktree `.zeros/workspace.json` seeds to
    // app-data and delete the in-tree `.zeros/`, so Zeros leaves no `.zeros` in
    // any worktree. Runs AFTER seedFromDisk (1b) so the registry is populated.
    try {
      const { migrateLegacyWorktreeSeeds } = await import("./git/state");
      const { migrated } = migrateLegacyWorktreeSeeds();
      if (migrated > 0)
        console.log(`[Zeros] moved ${migrated} worktree seed(s) out of .zeros`);
    } catch {
      /* best-effort — never block startup on seed migration */
    }

    // 1b.3. Retention janitor: drop orphan archive snapshots and branch-
    // ownership proofs left by a hard-delete or a crash after lifecycle
    // publication but before ref cleanup. Runs AFTER seedFromDisk so workspace
    // rows + journals are authoritative.
    try {
      const {
        pruneOrphanArchiveSnapshots,
        pruneOrphanWorkspaceBranchOwnershipRefs,
      } = await import("./git/worktree");
      await pruneOrphanArchiveSnapshots();
      await pruneOrphanWorkspaceBranchOwnershipRefs();
    } catch {
      /* best-effort — never block startup on retention */
    }

    // 1b.5. One-time cleanup of phantom worktree "projects" in the repos table:
    // a stale renderer regex (pre Phase-0 relocation) upserted worktrees under
    // ~/zeros/workspaces/<slug>/ws_* as top-level repos. Deterministic DB
    // self-heal — independent of the renderer prune / bridge timing. Runs AFTER
    // seedFromDisk (which only ever seeds parent repo roots, never worktree
    // paths), so nothing re-adds them. Best-effort; real repos are never under
    // a worktree root.
    try {
      const { pruneWorktreeRepos } = await import("./db/projects");
      const removed = pruneWorktreeRepos();
      if (removed > 0)
        console.log(
          `[Zeros] pruned ${removed} phantom worktree project(s) from repos`,
        );
    } catch {
      /* best-effort — never block startup on cleanup */
    }

    // 1c. One-time migration of the legacy Electron-main agent-history DB
    // (zeros-agent-history.db) into the unified Zeros DB. Idempotent and
    // best-effort; reads the legacy file READ-ONLY and never deletes it, so it
    // remains a recovery net even after the retired electron/db.ts is removed. No-op without
    // ZEROS_LEGACY_AGENT_DB (for example, outside the Electron sidecar).
    try {
      const { migrateLegacyAgentHistory } = await import("./db/legacy-import");
      migrateLegacyAgentHistory();
    } catch {
      /* best-effort — never block startup on migration */
    }

    // 1d. One-time backfill of chats.workspace_id (v11). The column defaults to
    // NULL; this resolves each pre-existing chat's `folder` to its owning
    // workspace via the resolver WorkspaceService wired at construction. Runs
    // AFTER the legacy agent-history fold-in (1c) so imported chats are covered,
    // and after seedFromDisk (1b) so the workspace registry is populated. Cheap
    // + idempotent (only touches workspace_id IS NULL rows); never bumps rev.
    try {
      const { backfillChatWorkspaceIds } = await import("./db/chats");
      const filled = backfillChatWorkspaceIds();
      if (filled > 0)
        console.log(`[Zeros] backfilled workspace_id for ${filled} chat(s)`);
      // Stamp a global rev onto pre-existing messages (rev=0 default) so the
      // message half of delta sync covers transcripts that predate rev stamping.
      const { backfillChatMessageRevs } = await import("./db/messages");
      const stamped = backfillChatMessageRevs();
      if (stamped > 0)
        console.log(`[Zeros] backfilled rev for ${stamped} message(s)`);
    } catch {
      /* best-effort — never block startup on backfill */
    }

    // 2. Build the retired selector index only if its legacy MCP consumer is
    // deliberately restored. The current Design workspace does not consume
    // this cache; naming this after the actual subsystem avoids implying that
    // the active Design surface is disabled.
    if (LEGACY_DESIGN_SELECTOR_INDEX_ENABLED) {
      await this.cache.buildIndex();
      const stats = this.cache.stats();
      console.log(
        `[Zeros] Index built: ${stats.selectors} selectors, ${stats.files} files, ${stats.tokens} tokens`,
      );
    }

    // 3. Start HTTP + WebSocket server (loopback transport)
    await this.local.start();
    this.actualPort = this.local.actualPort;

    // MCP gateway: front any auth:"oauth" backends on a localhost
    // endpoint + inject that one server into every agent. Best-effort — a
    // gateway failure must never block engine boot.
    await this.startGateway();

    // 4. Start the retired selector-index watcher only with that subsystem.
    if (LEGACY_DESIGN_SELECTOR_INDEX_ENABLED) {
      await this.watcher.start();
    }

    // Settings TOML watcher: external edits (editor, git checkout, an agent)
    // to any settings.toml nudge every client to re-resolve. Stat-poll —
    // bun-safe, immune to phantom FSEvents (mtime+size real-change guard).
    this.settingsWatcher = startSettingsWatcher(
      () => this.workspace.settingsRepoRoots(),
      () => {
        // A settings file changed on disk (hand-edit or the Settings UI's
        // write). Re-resolve the global MCP registry so the change reaches each
        // agent's next session live, then tell clients to refetch.
        this.loadMcpRegistry();
        this.reloadGateway();
        this.scheduleDesignTerritoryReconcile(
          listWorkspaces({ archived: false }),
          "settings",
        );
        this.broadcast(
          createMessage({
            type: "DB_CHANGED",
            source: "engine",
            kinds: ["settings"],
          }),
        );
      },
    );

    // Workspace + git watcher: agents, hand edits, and the embedded terminal
    // bypass bridge writes. Watch worktree content (create/change/delete) and
    // stat-poll tiny git-dir state (stage/commit/checkout), then broadcast one
    // workspaces invalidation so File / All Files / Changes re-pull together.
    this.gitWatcher = startGitWatcher(
      () => this.workspace.gitWatchTargets(),
      (change) => {
        this.broadcast(
          createMessage({
            type: "DB_CHANGED",
            source: "engine",
            kinds: ["workspaces"],
            ...(!change.coarse && change.workspaceIds.length > 0
              ? { workspaceIds: change.workspaceIds }
              : {}),
            ...(change.gitRefsChanged ? { gitRefsChanged: true } : {}),
          }),
        );
        // A Git ref move can add, remove, or retarget semantic Design
        // territory. Re-resolve it and retire any process whose creation-time
        // authority no longer matches; never rewrite the user's files here.
        if (change.gitRefsChanged) {
          const targets = change.coarse
            ? listWorkspaces({ archived: false })
            : change.workspaceIds.flatMap((id) => {
                const workspace = getWorkspaceById(id);
                return workspace && workspace.archivedAt == null
                  ? [workspace]
                  : [];
              });
          this.scheduleDesignTerritoryReconcile(targets, "git-refs");
        }
      },
      // Bun's macOS --compile runtime deadlocks its main event loop after
      // Chokidar arms a native FSEvents watcher: the process keeps a LISTEN
      // socket and completes TCP handshakes but never services HTTP/WS. Dev
      // runs Bun from source and is unaffected. Packaged/stable-mode engines
      // use Chokidar's stat-poll backend instead; its target set is bounded and
      // the watcher already coalesces changes. A 1.5s interval keeps packaged
      // idle CPU bounded while retaining prompt external-edit invalidation.
      {
        usePolling: !isDevRuntime(),
        worktreePollIntervalMs: 1_500,
      },
    );

    // 5. Write .zeros/.port file
    this.writePortFile(this.actualPort);

    // (.mcp.json / .vscode/mcp.json generation removed — Zeros MCP is
    // disabled; we no longer write MCP config into the user's repo.)

    // Start any non-local transports (e.g. the outbound relay control socket).
    for (const t of this.transports) {
      if (t !== this.local) await t.start();
    }

    this.running = true;
    const elapsed = Date.now() - startTime;
    console.log(
      `[Zeros] Engine ready on port ${this.actualPort} (${elapsed}ms)`,
    );
  }

  /**
   * Stop the engine gracefully.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    const failures: unknown[] = [];
    const settle = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };

    if (this.bindingSweep) {
      clearInterval(this.bindingSweep);
      this.bindingSweep = null;
    }
    const cloudGithubCredentialWatcher = this.cloudGithubCredentialWatcher;
    this.cloudGithubCredentialWatcher = null;
    if (cloudGithubCredentialWatcher) {
      await settle(() => cloudGithubCredentialWatcher.stop());
    }
    if (this.parentWatchTimer) {
      clearInterval(this.parentWatchTimer);
      this.parentWatchTimer = null;
    }
    await settle(() => this.agents.dispose());
    if (this.vaultPersistTimer) {
      // Flush a pending debounced persist so a clean stop never drops a token.
      clearTimeout(this.vaultPersistTimer);
      this.vaultPersistTimer = null;
      await settle(() => this.flushVaultPersist());
    }
    const mcpGateway = this.mcpGateway;
    this.mcpGateway = null;
    if (mcpGateway) {
      await settle(() => mcpGateway.stop());
    }
    await settle(() => this.pty.killAll());
    // Tear down the out-of-process Node hosts (PTY shells + the @cursor/sdk
    // host) so neither lingers as an orphan after the engine stops.
    await settle(() => disposePtyHost());
    await settle(() => disposeCursorHost());
    await settle(() => this.terminals.clear());
    await settle(() => this.watcher.stop());
    const settingsWatcher = this.settingsWatcher;
    this.settingsWatcher = null;
    if (settingsWatcher) await settle(() => settingsWatcher.stop());
    const gitWatcher = this.gitWatcher;
    this.gitWatcher = null;
    if (gitWatcher) await settle(() => gitWatcher.stop());
    await settle(() => closeGitCredentialBroker());
    for (const transport of this.transports) {
      await settle(() => transport.stop());
    }
    await settle(() => this.removePortFile());
    await settle(() => this.clearBusy());

    console.log("[Zeros] Engine stopped");
    if (failures.length > 0) {
      throw new AggregateError(failures, "Zeros engine teardown failed");
    }
  }

  /** Fan a message out to every connected client (across all transports). */
  private broadcast(msg: EngineMessage): void {
    this.router.broadcast(msg);
  }

  /** Return why a managed workspace cannot admit a new process right now.
   *  Rowless repository trunks are intentionally allowed: they have no
   *  archive/delete lifecycle. A journal without an in-memory flight is still
   *  blocking because it represents interrupted work that startup recovery
   *  must reconcile before anything writes through that checkout again. */
  private workspaceProcessStartBlock(
    workspaceId: string | null | undefined,
  ): string | null {
    if (!workspaceId) return null;
    let ws: ReturnType<typeof getWorkspaceById>;
    try {
      ws = getWorkspaceById(workspaceId);
    } catch {
      return "Workspace state is unavailable.";
    }
    // Managed ids are never legitimate rowless targets. Keeping this
    // distinction also makes an ended session from a permanently-deleted
    // workspace fail closed, while synthetic `local:*` trunks remain usable.
    if (!ws) {
      return workspaceId.startsWith("ws_")
        ? "This workspace no longer exists."
        : null;
    }
    if (ws.archivedAt != null) return "This workspace is archived.";
    let lifecycle: ReturnType<typeof getWorkspaceLifecycleStatus>;
    try {
      lifecycle = getWorkspaceLifecycleStatus(workspaceId);
    } catch {
      return "Workspace lifecycle state is unavailable.";
    }
    if (lifecycle.active || lifecycle.operation != null) {
      const operation = lifecycle.operation ?? "lifecycle operation";
      return `This workspace is currently in a ${operation} operation.`;
    }
    if (!fs.existsSync(ws.path)) {
      return "This workspace's checkout is not present on disk.";
    }
    if (this.designTerritoryTransitions.has(workspaceId)) {
      return "This workspace's Design territory is being updated.";
    }
    const fenceBlock = designFenceStartBlock(workspaceId);
    if (fenceBlock) return fenceBlock.message;
    return null;
  }

  private workspaceAllowsProcessStart(
    workspaceId: string | null | undefined,
  ): boolean {
    return this.workspaceProcessStartBlock(workspaceId) == null;
  }

  /** Freeze process admission, drain starts that crossed the prior gate, then
   * retire every code-agent session before semantic Design ownership changes.
   * The mutation runs while the block remains published; a failed mutation
   * never resurrects the old process authority. */
  private async withDesignTerritoryTransition<T>(
    targets: readonly { workspaceId: string; designDirectory: string }[],
    mutation: () => Promise<T>,
  ): Promise<T> {
    const ordered = [
      ...new Map(
        targets.map((target) => [target.workspaceId, target]),
      ).values(),
    ].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
    const validated: typeof ordered = [];
    const admittedStarts = new Map<string, Promise<unknown>[]>();
    try {
      for (const target of ordered) {
        const workspace = getWorkspaceById(target.workspaceId);
        if (!workspace) {
          throw new Error(`Workspace ${target.workspaceId} no longer exists.`);
        }
        const relative = path.relative(
          path.resolve(workspace.path),
          path.resolve(target.designDirectory),
        );
        if (
          !relative ||
          relative === "." ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error("The Design territory must be inside its workspace.");
        }
        if (this.designTerritoryTransitions.has(target.workspaceId)) {
          throw new Error(
            `Workspace ${target.workspaceId} already has a Design territory transition in progress.`,
          );
        }
        this.designTerritoryTransitions.add(target.workspaceId);
        validated.push(target);
      }
      // Snapshot while acquisition is still synchronous. The caller may
      // register this transition promise in workspaceProcessStarts immediately
      // after we first yield; waiting the live set would then wait on itself.
      // Starts after acquisition are rejected by workspaceProcessStartBlock.
      for (const target of ordered) {
        admittedStarts.set(target.workspaceId, [
          ...(this.designAuthorityStarts.get(target.workspaceId) ?? []),
        ]);
      }
      for (const target of ordered) {
        await this.waitForWorkspaceProcessStartSnapshot(
          target.workspaceId,
          admittedStarts.get(target.workspaceId) ?? [],
        );
        await this.retireCodeAgentSessionsForTerritoryChange(
          target.workspaceId,
        );
      }
      return await mutation();
    } finally {
      for (const target of validated) {
        this.designTerritoryTransitions.delete(target.workspaceId);
      }
    }
  }

  /** A provider sandbox's writable map is creation-time authority. Changing
   * the Design pointer can never retarget a live process: stop prompts, dispose
   * every workspace-bound adapter session, and leave each chat to resume under
   * the freshly resolved territory on its next send/load. */
  private async retireCodeAgentSessionsForTerritoryChange(
    workspaceId: string,
  ): Promise<void> {
    const workspace = getWorkspaceById(workspaceId);
    const sessionIds = new Set(
      [...this.sessionWorkspace]
        .filter(([, owner]) => owner === workspaceId)
        .map(([sessionId]) => sessionId),
    );
    if (workspace) {
      for (const sessionId of this.agents.workspaceSessionIds(
        workspaceId,
        workspace.path,
      )) {
        sessionIds.add(sessionId);
      }
    }
    // Legacy/live maps may predate session→workspace publication. Chat
    // location is the canonical fallback, and keeps an idle resumed agent from
    // surviving a territory change merely because its binding was incomplete.
    for (const [sessionId, chatId] of this.sessionChat) {
      const location = getChatLocation(chatId);
      if (
        location &&
        this.workspaceIdForProcess(location.workspaceId, location.folder) ===
          workspaceId
      ) {
        sessionIds.add(sessionId);
      }
    }
    // A pooled background boundary (chat titles, provider probes, key
    // validation) compiled its policy under the OUTGOING territory generation,
    // exactly like a session boundary. Retire the pool here too, so no one-shot
    // can keep running against the old Design authority after the pointer moves.
    await this.agents.retirePooledUtilityBoundaries();
    // Publish the semantic cause while the old execution route is still
    // owner-bound. Cancellation/revocation immediately follows; this status is
    // never an authority gate and cannot postpone the transition.
    for (const sessionId of sessionIds) {
      this.agents.markBoundaryDraining(sessionId, "territory-restart");
    }
    // A failed retire must not leave SURVIVORS wearing a `draining` status
    // that nothing will ever complete or clear — the renderer's boundary pill
    // would spin forever on a session that is still live and routable. The
    // sessions endSession already retired publish their own terminal state;
    // everything still routable gets its pre-drain `ready` back before the
    // failure propagates. Fail-closed enforcement is untouched: the transition
    // itself still fails, and admission health still gates new boundaries.
    const undrainSurvivors = () => {
      for (const sessionId of sessionIds) {
        this.agents.markBoundaryDrainingCleared(sessionId);
      }
    };
    if (!(await this.cancelLiveAgentSessions(sessionIds))) {
      undrainSurvivors();
      throw new Error(
        "Couldn't stop agents admitted under the old Design territory.",
      );
    }
    try {
      for (const sessionId of sessionIds) {
        const agentId = this.sessionAgent.get(sessionId);
        if (agentId) {
          await this.agents.endSession(agentId, sessionId, {
            failClosed: true,
          });
        }
        this.router.clearOwner(sessionId);
        this.sessionAgent.delete(sessionId);
        this.sessionWorkspace.delete(sessionId);
        this.sessionMessages.delete(sessionId);
        this.sessionLoadResponses.delete(sessionId);
        this.activePromptContexts.delete(sessionId);
        this.promptSessions.delete(sessionId);
        this.cancelRequested.delete(sessionId);
        this.clearPendingAgentInteractions(sessionId);
      }
    } catch (error) {
      undrainSurvivors();
      throw error;
    }
  }

  /** Reconcile a prospective pointer/recognized-Design set after an external
   * settings or Git mutation. Pure preview first: ordinary fetches, commits,
   * and unrelated settings saves do not disturb agents. When authority did
   * change, the existing transition primitive blocks starts and retires old
   * sandboxes before publication/fencing. Any preview or fence failure records
   * unhealthy state, so subsequent process admission fails closed. */
  private scheduleDesignTerritoryReconcile(
    candidates: readonly {
      id: string;
      path: string;
      repoRoot: string;
      archivedAt?: number | null;
    }[],
    source: "settings" | "git-refs" | "design-init",
  ): void {
    const targets = [
      ...new Map(
        candidates.map((candidate) => [candidate.id, candidate]),
      ).values(),
    ];
    this.designTerritoryReconcileChain = this.designTerritoryReconcileChain
      .then(async () => {
        for (const workspace of targets) {
          if (workspace.archivedAt != null || !fs.existsSync(workspace.path)) {
            continue;
          }
          await withDesignWorkspaceMutation(workspace.path, async () => {
            let prospective: Awaited<
              ReturnType<typeof previewCodeAgentTerritory>
            >;
            try {
              prospective = await previewCodeAgentTerritory({
                cwd: workspace.path,
                workspaceRoot: workspace.path,
                repoRoot: workspace.repoRoot,
              });
            } catch (error) {
              // A new invalid pointer, symlink, or hard-link alias is itself an
              // authority change. Retire anything already running, then let the
              // territory reconcile keep process admission fail-closed.
              if (
                this.agents.workspaceHasSessions(workspace.id, workspace.path)
              ) {
                const fallback = path.join(
                  workspace.path,
                  ...designDirectoryNameFor(workspace.path).split("/"),
                );
                await this.withDesignTerritoryTransition(
                  [{ workspaceId: workspace.id, designDirectory: fallback }],
                  async () => {
                    await fenceWorkspaceDesignDirectoryIfPresent(workspace);
                  },
                );
              } else {
                await fenceWorkspaceDesignDirectoryIfPresent(workspace);
              }
              throw error;
            }

            const changed = this.agents.workspaceTerritoryChanged(
              workspace.id,
              workspace.path,
              prospective,
            );
            const publish = async () => {
              if (source === "git-refs") {
                await reconcileDesignDirAfterExternalGit(workspace);
              }
              await resolveCodeAgentTerritory({
                cwd: workspace.path,
                workspaceRoot: workspace.path,
                repoRoot: workspace.repoRoot,
              });
              await fenceWorkspaceDesignDirectoryIfPresent(workspace);
            };
            if (!changed) {
              await publish();
              return;
            }
            const designDirectory =
              prospective?.designDirectory ??
              path.join(
                workspace.path,
                ...designDirectoryNameFor(workspace.path).split("/"),
              );
            await this.withDesignTerritoryTransition(
              [{ workspaceId: workspace.id, designDirectory }],
              publish,
            );
          });
        }
      })
      .catch((error) => {
        console.warn(
          `[design-territory] ${source} reconciliation failed; new processes remain fail-closed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  private assertWorkspaceProcessStartAllowed(
    workspaceId: string | null | undefined,
  ): void {
    const message = this.workspaceProcessStartBlock(workspaceId);
    if (!message) return;
    const fenceBlock = workspaceId ? designFenceStartBlock(workspaceId) : null;
    throw new GitError({
      code: "VALIDATION_FAILED",
      message,
      remediation:
        fenceBlock?.remediation ??
        "Wait for the workspace operation to finish, then try again.",
      context: { workspaceId },
    });
  }

  /** Canonical managed owner for a process/session. Desktop clients normally
   *  send both fields, but older callers sent only cwd; resolving both prevents
   *  those sessions from escaping archive/delete cleanup. */
  private workspaceIdForProcess(
    workspaceId: string | null | undefined,
    cwd: string | null | undefined,
  ): string | null {
    return (
      this.workspace.workspaceIdForCwd(workspaceId ?? undefined) ??
      this.workspace.workspaceIdForCwd(cwd ?? undefined) ??
      workspaceId ??
      null
    );
  }

  private workspaceIdForAgentSession(sessionId: string): string | null {
    const bound = this.sessionWorkspace.get(sessionId);
    if (bound) return bound;
    const chatId = this.sessionChat.get(sessionId);
    const location = chatId ? getChatLocation(chatId) : null;
    return this.workspaceIdForProcess(
      location?.workspaceId ?? null,
      location?.folder ?? null,
    );
  }

  /** Register an asynchronous start/mutation before yielding the event loop. The
   *  lifecycle reaper drains this exact workspace's set before it enumerates
   *  PTYs/sessions; finally removes the promise on every success/failure path. */
  private trackWorkspaceProcessStart<T>(
    workspaceId: string | null | undefined,
    start: Promise<T>,
  ): Promise<T> {
    if (!workspaceId) return start;
    let starts = this.workspaceProcessStarts.get(workspaceId);
    if (!starts) {
      starts = new Set<Promise<unknown>>();
      this.workspaceProcessStarts.set(workspaceId, starts);
    }
    const tracked = start.finally(() => {
      const current = this.workspaceProcessStarts.get(workspaceId);
      current?.delete(tracked);
      if (current?.size === 0) this.workspaceProcessStarts.delete(workspaceId);
    });
    starts.add(tracked);
    return tracked;
  }

  /** Register an in-flight code-agent creation/resume/fork in both lifecycle
   * and Design-authority drains. The outer tracker owns archive/delete; this
   * narrower map is what a first Design territory transition snapshots. */
  private trackDesignAuthorityStart<T>(
    workspaceId: string | null | undefined,
    start: Promise<T>,
  ): Promise<T> {
    if (!workspaceId) return start;
    let starts = this.designAuthorityStarts.get(workspaceId);
    if (!starts) {
      starts = new Set<Promise<unknown>>();
      this.designAuthorityStarts.set(workspaceId, starts);
    }
    const tracked = start.finally(() => {
      const current = this.designAuthorityStarts.get(workspaceId);
      current?.delete(tracked);
      if (current?.size === 0) this.designAuthorityStarts.delete(workspaceId);
    });
    starts.add(tracked);
    return this.trackWorkspaceProcessStart(workspaceId, tracked);
  }

  private beginConversationBind(
    conversationId: string | undefined,
  ): number | null {
    if (!conversationId) return null;
    const token = ++this.conversationBindSerial;
    this.conversationBindTokens.set(conversationId, token);
    // A newer bind supersedes the older one's admission the same way a close
    // does: if the superseded operation is still queued in the admission gate,
    // cancel it there so it never burns a slot building a world nobody wants.
    this.conversationBindAborts.get(conversationId)?.controller.abort();
    this.conversationBindAborts.set(conversationId, {
      token,
      controller: new AbortController(),
    });
    return token;
  }

  /** The gate-cancellation signal for a bind minted by beginConversationBind.
   * Undefined when the bind was already superseded — the caller's own
   * stale-bind check is about to throw anyway. */
  private conversationAdmissionSignal(
    conversationId: string | undefined,
    token: number | null,
  ): AbortSignal | undefined {
    if (!conversationId || token === null) return undefined;
    const entry = this.conversationBindAborts.get(conversationId);
    return entry?.token === token ? entry.controller.signal : undefined;
  }

  /** Release a completed/failed bind token without deleting a newer bind or a
   * close invalidation that superseded it while the adapter was awaiting. */
  private finishConversationBind(
    conversationId: string | undefined,
    token: number | null,
  ): void {
    if (
      conversationId &&
      token !== null &&
      this.conversationBindTokens.get(conversationId) === token
    ) {
      this.conversationBindTokens.delete(conversationId);
    }
    if (
      conversationId &&
      token !== null &&
      this.conversationBindAborts.get(conversationId)?.token === token
    ) {
      this.conversationBindAborts.delete(conversationId);
    }
  }

  /** Register the route fields needed by stream routing and persistence. For a
   * resume this runs before adapter.loadSession, closing the window where an
   * adapter update had no owner/chat/workspace and therefore broadcast. */
  private registerAgentExecutionRoute(input: {
    executionId: string;
    agentId: string;
    ownerId: string;
    chatId?: string;
    workspaceId?: string | null;
  }): void {
    this.router.setOwner(input.executionId, input.ownerId);
    this.sessionAgent.set(input.executionId, input.agentId);
    if (input.chatId) {
      this.sessionChat.set(input.executionId, input.chatId);
      this.conversationExecution.set(input.chatId, input.executionId);
    }
    if (input.workspaceId) {
      this.sessionWorkspace.set(input.executionId, input.workspaceId);
    }
  }

  /** Remove all engine-owned routing for an execution. A provider process exit
   * can race the prompt promise's own finalizer, so that path may preserve the
   * turn record until its existing settle logic completes. */
  private clearAgentExecutionRoute(
    executionId: string,
    opts: { preservePrompt?: boolean } = {},
  ): void {
    const conversationId = this.sessionChat.get(executionId);
    this.router.clearOwner(executionId);
    this.sessionAgent.delete(executionId);
    this.sessionChat.delete(executionId);
    this.sessionWorkspace.delete(executionId);
    this.sessionMessages.delete(executionId);
    this.sessionLoadResponses.delete(executionId);
    this.detachedProviderBindings.delete(executionId);
    this.exitedAgentExecutions.delete(executionId);
    this.clearPendingAgentInteractions(executionId);
    if (!opts.preservePrompt) {
      this.activePromptContexts.delete(executionId);
      this.promptSessions.delete(executionId);
    }
    if (
      conversationId &&
      this.conversationExecution.get(conversationId) === executionId
    ) {
      this.conversationExecution.delete(conversationId);
    }
  }

  /** The engine learns provider identity at creation/resume and sometimes
   * later from the stream (Claude init). Persist at every authoritative point
   * so renderer unmount can never be the durability boundary. */
  private persistProviderIdentityForChat(
    chatId: string | undefined,
    agentId: string,
    providerBinding: ProviderBinding | null | undefined,
    providerMetadata?: ProviderMetadata | null,
  ): void {
    if (!chatId || !providerBinding) return;
    try {
      updateChatProviderIdentity(
        chatId,
        agentId,
        providerBinding,
        providerMetadata,
      );
    } catch (err) {
      // Identity durability is best-effort at the engine boundary; never break
      // provider startup/streaming. The renderer's chat-state mirror remains a
      // second write path whenever its surface stays mounted.
      console.warn(
        `[agents] failed to persist provider binding for chat ${chatId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** Prevent an adapter response that resolves after provider deletion from
   * resurrecting the deleted durable handle in caches, SQLite, or the
   * renderer. A genuinely different replacement binding supersedes the marker
   * and is allowed through. */
  private withoutDetachedProviderIdentity<
    T extends {
      providerBinding?: ProviderBinding;
      providerMetadata?: ProviderMetadata;
    },
  >(executionId: string, value: T): T {
    const detached = this.detachedProviderBindings.get(executionId);
    if (!detached || !value.providerBinding) return value;
    if (!sameProviderBinding(detached, value.providerBinding)) {
      this.detachedProviderBindings.delete(executionId);
      return value;
    }
    const next = { ...value };
    delete next.providerBinding;
    delete next.providerMetadata;
    return next;
  }

  private conversationBindIsCurrent(
    conversationId: string | undefined,
    token: number | null,
  ): boolean {
    return (
      !conversationId ||
      token === null ||
      this.conversationBindTokens.get(conversationId) === token
    );
  }

  private invalidateConversationBind(conversationId: string | undefined): void {
    if (!conversationId) return;
    this.conversationBindTokens.delete(conversationId);
    const abortEntry = this.conversationBindAborts.get(conversationId);
    if (abortEntry) {
      this.conversationBindAborts.delete(conversationId);
      abortEntry.controller.abort();
    }
  }

  private async waitForConversationClose(
    conversationId: string | undefined,
  ): Promise<void> {
    if (!conversationId) return;
    for (;;) {
      const flight = this.conversationCloseFlights.get(conversationId);
      if (!flight) return;
      await flight.catch(() => {});
    }
  }

  private staleConversationBindFailure(
    stage: "newSession" | "loadSession" | "forkSession",
  ): AgentFailureError {
    return new AgentFailureError({
      // Losing this engine-local ownership race says nothing about the
      // provider's durable thread. In particular, it must never trigger the
      // renderer's provider-binding invalidation path.
      kind: "lifecycle-superseded",
      stage,
      message:
        "The conversation was closed or superseded while its provider operation was in progress.",
    });
  }

  /** Drain work admitted before archive/delete acquired its lifecycle flight.
   *  Looping covers a start that registered just before acquisition while an
   *  earlier one was already being awaited. Fail closed after a bounded wait:
   *  the checkout remains live, so the delayed start is still safe to finish. */
  private async waitForWorkspaceProcessStarts(
    workspaceId: string,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while ((this.workspaceProcessStarts.get(workspaceId)?.size ?? 0) > 0) {
      const starts = [...(this.workspaceProcessStarts.get(workspaceId) ?? [])];
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new GitError({
          code: "GIT_COMMAND_FAILED",
          message: "A workspace operation is still settling.",
          remediation:
            "The workspace remains live. Wait for Git, setup, runs, or agents to settle, then retry.",
          context: { workspaceId, processCount: starts.length },
        });
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const settled = await Promise.race([
        Promise.allSettled(starts).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!settled) {
        throw new GitError({
          code: "GIT_COMMAND_FAILED",
          message: "A workspace operation is still settling.",
          remediation:
            "The workspace remains live. Wait for Git, setup, runs, or agents to settle, then retry.",
          context: { workspaceId, processCount: starts.length },
        });
      }
    }
  }

  /** Drain exactly the work admitted before a Design authority transition
   * acquired its process-start block. A live-set loop would include the
   * transition's own promise once the outer workspace handler registers it. */
  private async waitForWorkspaceProcessStartSnapshot(
    workspaceId: string,
    starts: readonly Promise<unknown>[],
  ): Promise<void> {
    if (starts.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settled = await Promise.race([
      Promise.allSettled(starts).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (settled) return;
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: "A workspace operation is still settling.",
      remediation:
        "The workspace remains live. Wait for Git, setup, runs, or agents to settle, then retry.",
      context: { workspaceId, processCount: starts.length },
    });
  }

  /** Start every `run_on_create` run action for a freshly-created workspace
   *  (immediately when the repo has no setup script, else once setup passes —
   *  see the workspace.create block in handleWorkspaceRequest). Platform-
   *  filtered like the renderer's tabs; best-effort — a run failure must
   *  never surface on the create flow. */
  private startRunOnCreateActions(workspaceId: string): void {
    try {
      const ws = getWorkspaceById(workspaceId);
      if (!ws?.path || !this.workspaceAllowsProcessStart(workspaceId)) return;
      const actions = filterRunActionsForPlatform(
        resolveRunActions(ws.repoRoot),
        normalizeRunPlatform(process.platform),
      );
      for (const action of actions) {
        if (!action.runOnCreate) continue;
        void this.trackWorkspaceProcessStart(
          workspaceId,
          this.runs.start({
            sessionId: runSessionId(ws.path, action.id),
            workspaceId: ws.id,
            actionId: action.id,
            command: action.command,
            oneShot: runActionOneShot(action),
            cwd: ws.path,
            repoRoot: ws.repoRoot,
          }),
        ).catch((err) =>
          console.error(
            `[run] run-on-create "${action.id}" failed for ${workspaceId}:`,
            err,
          ),
        );
      }
    } catch {
      /* settings/state unavailable — skip auto-runs */
    }
  }

  // ── Message Routing ────────────────────────────────────

  /** Relay a CAUGHT engine-side error to a client for PostHog error tracking
   *  (gap A — the engine has no PostHog client of its own, so handled errors
   *  would otherwise only reach the log). Scrubbed to metadata only: error
   *  class/name + redacted message/stack + GitError code. Skips expected,
   *  user-correctable control-flow codes so error tracking stays signal —
   *  those still surface in the renderer's `git_op` funnel. Never throws
   *  (telemetry must not break request handling). */
  private reportEngineError(
    client: TransportClient,
    origin: string,
    err: unknown,
  ): void {
    try {
      const code = isGitError(err) ? err.code : undefined;
      if (code && EXPECTED_ENGINE_ERROR_CODES.has(code)) return;
      const s = scrubError(err);
      client.send(
        createMessage({
          type: "ENGINE_ERROR",
          source: "engine",
          origin,
          name: s.name,
          message: s.message,
          stack: s.stack,
          code,
          severity: engineErrorSeverity(code),
        }),
      );
    } catch {
      /* never let telemetry break the engine */
    }
  }

  private async handleMessage(
    msg: EngineMessage,
    client: TransportClient,
  ): Promise<void> {
    // Account-binding ENFORCEMENT gate. When binding is REQUIRED, a remote client
    // must complete CONNECTED (valid access token → clientAccount populated)
    // before ANY privileged message is processed — otherwise "never send
    // CONNECTED" would silently bypass the requirement (the per-message handlers
    // don't consult the bound identity). Fails CLOSED.
    if (
      remoteMustBindFirst({
        clientKind: client.kind,
        required: this.accountAuth?.required ?? false,
        verified: this.clientAccount.has(client.id),
        msgType: msg.type,
      })
    ) {
      client.close(1008, "account binding required");
      return;
    }
    // Client→engine AGENT_* messages route to the agent dispatcher. This used
    // to be a per-type case list DUPLICATING the dispatcher's own switch, and
    // the two drifted: AGENT_QUESTION_RESPONSE had a dispatcher case but no
    // routing case, so every question answer was silently discarded at
    // `default: break` below — the composer card's answer never reached the
    // agent and the turn hung until the response timeout (field-debugged
    // 2026-07-04, a full day of "I answered but it keeps loading"). Routing
    // now keys on the prefix; the dispatcher's own switch decides per-type
    // (its default warns instead of vanishing), so a client→engine agent
    // message can never again exist in one switch but not the other.
    // Engine→client AGENT_* types arriving here would be a protocol violation
    // and hit the dispatcher's warning default — still better than silence.
    if (msg.type.startsWith("AGENT_")) {
      await this.handleAgentMessage(msg, client);
      return;
    }
    switch (msg.type) {
      case "CONNECTED": {
        // Version negotiation. A remote client may lag the engine after a
        // release; reject cleanly rather than mis-parse.
        // A missing protocolVersion = legacy client, assumed compatible.
        const v = msg.protocolVersion;
        if (typeof v === "number" && !isCompatible(v)) {
          client.send(
            createMessage({
              type: "CONNECTION_REJECTED",
              source: "engine",
              reason:
                v < MIN_SUPPORTED_PROTOCOL
                  ? "protocol-too-old"
                  : "protocol-too-new",
              message: `Engine speaks protocol ${MIN_SUPPORTED_PROTOCOL}–${PROTOCOL_VERSION}; client sent ${v}.`,
              engineProtocolVersion: PROTOCOL_VERSION,
              minProtocolVersion: MIN_SUPPORTED_PROTOCOL,
            }),
          );
          client.close(1002, "protocol version mismatch");
          break;
        }
        // Optional account-binding: verify a remote client's access token.
        await this.verifyAccountBinding(msg, client);
        break;
      }
      case "HEARTBEAT":
        // No response needed
        break;
      case "GITHUB_TOKEN_SET":
        // Option B: the host (Electron-main, the safeStorage owner) seeds the
        // engine's in-memory GitHub token over the bridge. LOCAL clients only.
        if (!this.isHostRelayClient(client)) seedGithubToken(msg.token);
        break;
      case "OWNER_SIGNED_OUT":
        // The desktop owner signed out. LOCAL clients only — a remote client must
        // never be able to clear the owner binding (that would be the inverse of
        // privilege escalation: dropping every device's gate). Fire-and-forget.
        if (client.kind === "local") this.clearOwnerBinding();
        break;
      case "WORKSPACE_REQUEST":
        await this.handleWorkspaceMessage(msg, client);
        break;
      // (Removed) WORKSPACE_APPROVAL_RESPONSE — the per-op host-approval broker
      // was never wired to a desktop prompt, so it always timed out and silently
      // broke remote writes. The real, intentional gate is the per-workspace
      // remote-restriction list (see authorizeRemoteWrite); a paired device is a
      // trusted operator. An unknown message type now falls through to default.
      case "PTY_CREATE":
        await this.handlePtyCreate(msg, client);
        break;
      case "PTY_WRITE":
        // Shared terminal (multiplayer): ANY paired device may type into it —
        // the only gate is the per-workspace restriction (remote clients refused
        // for a restricted/unknown workspace; local desktop always allowed).
        if (this.mayOperateTerminal(client, msg.sessionId))
          this.pty.write(msg.sessionId, msg.data);
        break;
      case "PTY_RESIZE":
        if (this.mayOperateTerminal(client, msg.sessionId))
          this.pty.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      case "PTY_KILL":
        if (this.mayOperateTerminal(client, msg.sessionId)) {
          if (this.pty.has(msg.sessionId)) {
            // EXPLICIT close of a LIVE terminal: flag it so onExit removes it for
            // every device (vs a natural exit, which keeps it as "(exited)").
            this.explicitlyClosing.add(msg.sessionId);
            this.pty.kill(msg.sessionId);
          } else if (this.terminals.remove(msg.sessionId)) {
            // Closing an already-EXITED terminal — no live pty to kill (so no
            // onExit fires); drop the registry entry directly.
            this.broadcastTerminalsChanged();
          }
        }
        break;
      case "PTY_LIST": {
        const terminals = this.terminals.visibleTo({
          isRemote: this.isHostRelayClient(client),
          restricted: listRemoteRestrictedWorkspaceIds(),
          workspaceId:
            typeof msg.workspaceId === "string" && msg.workspaceId
              ? msg.workspaceId
              : undefined,
        });
        client.send(
          createMessage({
            type: "PTY_LIST_RESULT",
            source: "engine",
            requestId: msg.id,
            terminals,
            // A local resource monitor needs process OWNERSHIP, not a name
            // heuristic. Include every live PtyService root (shared terminal,
            // Run, Setup, ephemeral command) only for the trusted desktop.
            // PID is sufficient: never send session IDs, cwd, argv, or other
            // private metadata, and never expose even the census to a relay.
            ...(client.kind === "local"
              ? {
                  processPids: this.pty.list().map((process) => process.pid),
                }
              : {}),
          }),
        );
        break;
      }
      case "RESOLVE_AGENT_BINARY":
        await this.handleResolveAgentBinary(msg, client);
        break;
      default:
        break;
    }
  }

  /** Resolve an agent's on-disk CLI binary for the embedded terminal. LOCAL
   *  ONLY — a relay device must never be told a host filesystem path (and has
   *  no embedded terminal to run it in). Only `claude` is wired today (its
   *  terminal commands are the only ones classified); other agents resolve to
   *  their bare binary name (login-shell PATH resolves it). Never throws. */
  private async handleResolveAgentBinary(
    msg: Extract<EngineMessage, { type: "RESOLVE_AGENT_BINARY" }>,
    client: TransportClient,
  ): Promise<void> {
    if (client.kind !== "local") {
      // A relay device has no embedded terminal and must never be told a host
      // filesystem path. Reply IMMEDIATELY with the bare agent id — the exact
      // value the caller falls back to (bridgeResolveAgentBinary) — so it
      // resolves at once instead of waiting out the 5s bridge timeout. No host
      // path leaves the desktop; `fallback` marks it as PATH-resolved.
      client.send(
        createMessage({
          type: "AGENT_BINARY_RESOLVED",
          source: "engine",
          requestId: msg.id,
          agentId: msg.agentId,
          path: msg.agentId,
          resolvedVia: "fallback",
        }),
      );
      return;
    }
    let binPath = msg.agentId;
    let resolvedVia: "override" | "well-known" | "path" | "fallback" =
      "fallback";
    if (msg.agentId.toLowerCase().includes("claude")) {
      const resolved = await resolveClaudeBinary();
      binPath = resolved.path;
      resolvedVia = resolved.source;
    }
    client.send(
      createMessage({
        type: "AGENT_BINARY_RESOLVED",
        source: "engine",
        requestId: msg.id,
        agentId: msg.agentId,
        path: binPath,
        resolvedVia,
      }),
    );
  }

  /**
   * Dispatch AGENT_* messages from the renderer to the native agent gateway.
   * Responses fan back out via the shared WebSocket; permission prompts are
   * pushed proactively by the gateway (not via this request path).
   */
  private async handleAgentMessage(
    msg: EngineMessage,
    client: TransportClient,
  ): Promise<void> {
    // Normalize the canonical route name once at the dispatch edge. Handlers and
    // adapters still accept `sessionId` during the compatibility window, but
    // whenever a canonical executionId is present it is the route they see.
    if (
      msg.type !== "AGENT_LOAD_SESSION" &&
      "executionId" in msg &&
      typeof msg.executionId === "string"
    ) {
      msg = { ...msg, sessionId: msg.executionId } as EngineMessage;
    }
    const routedExecutionId = (msg as { sessionId?: unknown }).sessionId;
    const suppliedAgentId = (msg as { agentId?: unknown }).agentId;
    if (
      EXECUTION_ROUTED_AGENT_MESSAGES.has(msg.type) &&
      typeof routedExecutionId === "string" &&
      typeof suppliedAgentId === "string"
    ) {
      const executionAgentId = this.sessionAgent.get(routedExecutionId);
      if (executionAgentId && executionAgentId !== suppliedAgentId) {
        console.warn(
          `[agents] normalized stale agent label ${suppliedAgentId} → ${executionAgentId} ` +
            `for execution ${routedExecutionId.slice(0, 8)}…`,
        );
        msg = { ...msg, agentId: executionAgentId } as EngineMessage;
      }
    }
    // Diagnostic: log every AGENT_* message at the dispatch boundary so
    // we can tell from main.log whether prompts are even reaching the
    // engine. Used to triage "user sent codex prompt, no response" —
    // without this the only visible log was occasional adapter creation,
    // and any "request never made it to the engine" bug was invisible.
    {
      const requestId = (msg as { id?: string }).id;
      const agentId = (msg as { agentId?: string }).agentId;
      const executionId =
        (msg as { executionId?: string; sessionId?: string }).executionId ??
        (msg as { sessionId?: string }).sessionId;
      console.log(
        `[agents] dispatch ${msg.type}` +
          (agentId ? ` agent=${agentId}` : "") +
          (executionId ? ` execution=${executionId.slice(0, 8)}…` : "") +
          (requestId ? ` reqId=${requestId.slice(0, 8)}…` : ""),
      );
    }
    let bindToFinish: {
      conversationId: string | undefined;
      token: number | null;
    } | null = null;
    let forkSourceToFinish: string | null = null;
    try {
      switch (msg.type) {
        case "AGENT_LIST_AGENTS": {
          const agents = msg.force
            ? await this.agents.refreshRegistry()
            : await this.agents.listAgents();
          client.send(
            createMessage({
              type: "AGENT_AGENTS_LIST",
              source: "engine",
              requestId: msg.id,
              agents,
            }),
          );
          return;
        }
        case "AGENT_PREFLIGHT": {
          // Diagnostic only: do not construct spawn env, credentials, an
          // execution route, or a provider session. The live provider/OS
          // canary may start a short child, so it still participates in the
          // workspace/Design transition drains exactly like admission.
          const cwd =
            client.kind === "local"
              ? msg.cwd
              : this.assertRemoteWorkspaceOperable(
                  msg.workspaceId,
                  "newSession",
                );
          const lifecycleWorkspaceId = this.workspaceIdForProcess(
            msg.workspaceId,
            cwd,
          );
          this.assertAgentWorkspaceProcessStartAllowed(
            lifecycleWorkspaceId,
            msg.workspaceId,
            cwd,
          );
          const status = await this.trackDesignAuthorityStart(
            lifecycleWorkspaceId,
            this.agents.preflightSession(msg.agentId, {
              cwd,
              workspaceId: msg.workspaceId,
              cliBinary: client.kind === "local" ? msg.cliBinary : undefined,
            }),
          );
          client.send(
            createMessage({
              type: "AGENT_PREFLIGHTED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              status,
            }),
          );
          return;
        }
        case "AGENT_OPEN_BOUNDARY_PORT": {
          if (
            !this.sessionAgent.has(msg.executionId) ||
            this.remoteMayNotActOnSession(msg.executionId, client, false)
          ) {
            this.refuseSessionAccess(
              msg.id,
              this.sessionAgent.get(msg.executionId) ?? msg.agentId,
              client,
            );
            return;
          }
          const opened = await this.agents.openBoundaryPort(
            msg.executionId,
            msg.portId,
          );
          client.send(
            createMessage({
              type: "AGENT_BOUNDARY_PORT_OPENED",
              source: "engine",
              requestId: msg.id,
              executionId: msg.executionId,
              portId: msg.portId,
              url: opened.url,
              admissionUrl: opened.admissionUrl,
              expiresAt: opened.expiresAt,
            }),
          );
          return;
        }
        case "AGENT_VALIDATE_KEY": {
          const result = await this.agents.validateProviderKey(
            msg.agentId,
            msg.apiKey,
          );
          client.send(
            createMessage({
              type: "AGENT_KEY_VALIDATED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              ok: result.ok,
              ...(result.error ? { error: result.error } : {}),
            }),
          );
          return;
        }
        case "AGENT_GENERATE_TITLE": {
          // Background AI chat-title one-shot. Best-effort by contract:
          // the gateway never throws, and a null title just means the
          // renderer keeps its snippet title. The env rides the same local
          // bridge as AGENT_NEW_SESSION.env and is never logged.
          const result = await this.agents.generateTitle(msg.agentId, {
            model: msg.model,
            systemPrompt: msg.systemPrompt,
            prompt: msg.prompt,
            env: this.scrubTitleGenerationEnv(msg.env),
          });
          client.send(
            createMessage({
              type: "AGENT_TITLE_GENERATED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              title: result.title,
              ...(result.error ? { error: result.error } : {}),
            }),
          );
          return;
        }
        case "AGENT_NEW_SESSION": {
          const bindToken = this.beginConversationBind(msg.chatId);
          bindToFinish = { conversationId: msg.chatId, token: bindToken };
          await this.waitForConversationClose(msg.chatId);
          if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
            throw this.staleConversationBindFailure("newSession");
          }
          const spawnOpts = await this.agentSpawnOpts(
            msg,
            client,
            "newSession",
          );
          if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
            throw this.staleConversationBindFailure("newSession");
          }
          const lifecycleWorkspaceId = this.workspaceIdForProcess(
            spawnOpts.workspaceId,
            spawnOpts.cwd,
          );
          this.assertAgentWorkspaceProcessStartAllowed(
            lifecycleWorkspaceId,
            spawnOpts.workspaceId,
            spawnOpts.cwd,
          );
          let provisionalExecutionId: string | undefined;
          const { initialize, session } = await this.trackDesignAuthorityStart(
            lifecycleWorkspaceId,
            (async () => {
              const initialize = await this.agents.ensureAgent(msg.agentId, {
                env: spawnOpts.env,
              });
              // ensureAgent may spawn/initialize asynchronously. Re-check
              // before the workspace-scoped session itself is created.
              this.assertAgentWorkspaceProcessStartAllowed(
                lifecycleWorkspaceId,
              );
              if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
                throw this.staleConversationBindFailure("newSession");
              }
              let session: NewSessionResponse;
              try {
                session = await this.agents.newSession(msg.agentId, {
                  cwd: spawnOpts.cwd,
                  env: spawnOpts.env,
                  workspaceId: spawnOpts.workspaceId,
                  cliBinary: spawnOpts.cliBinary,
                  admissionSignal: this.conversationAdmissionSignal(
                    msg.chatId,
                    bindToken,
                  ),
                  onExecutionCreated: (executionId) => {
                    if (
                      !this.conversationBindIsCurrent(msg.chatId, bindToken)
                    ) {
                      throw this.staleConversationBindFailure("newSession");
                    }
                    this.assertAgentWorkspaceProcessStartAllowed(
                      lifecycleWorkspaceId,
                    );
                    provisionalExecutionId = executionId;
                    this.registerAgentExecutionRoute({
                      executionId,
                      agentId: msg.agentId,
                      ownerId: client.id,
                      chatId: msg.chatId,
                      workspaceId: lifecycleWorkspaceId,
                    });
                  },
                });
              } catch (err) {
                if (provisionalExecutionId) {
                  this.clearAgentExecutionRoute(provisionalExecutionId);
                }
                throw err;
              }
              const executionId = session.executionId;
              if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
                this.clearAgentExecutionRoute(executionId);
                await this.agents
                  .endSession(msg.agentId, executionId)
                  .catch(() => {});
                throw this.staleConversationBindFailure("newSession");
              }
              if (
                provisionalExecutionId &&
                this.sessionAgent.get(executionId) !== msg.agentId
              ) {
                await this.agents
                  .endSession(msg.agentId, executionId)
                  .catch(() => {});
                throw new AgentFailureError({
                  kind: "session-expired",
                  stage: "newSession",
                  message: "The agent execution exited while it was starting.",
                });
              }
              // Publish ownership before the tracked promise resolves so a
              // concurrently-starting reaper can discover and dispose it.
              if (!provisionalExecutionId) {
                provisionalExecutionId = executionId;
                this.registerAgentExecutionRoute({
                  executionId,
                  agentId: msg.agentId,
                  ownerId: client.id,
                  chatId: msg.chatId,
                  workspaceId: lifecycleWorkspaceId,
                });
              }
              session = this.withoutDetachedProviderIdentity(
                executionId,
                session,
              );
              this.sessionLoadResponses.set(executionId, {
                ...(this.sessionLoadResponses.get(executionId) ?? {}),
                ...(session.modes ? { modes: session.modes } : {}),
                ...(session.models ? { models: session.models } : {}),
                ...(session.providerBinding
                  ? { providerBinding: session.providerBinding }
                  : {}),
                ...(session.providerMetadata
                  ? { providerMetadata: session.providerMetadata }
                  : {}),
              });
              if (msg.chatId) {
                this.persistProviderIdentityForChat(
                  msg.chatId,
                  msg.agentId,
                  session.providerBinding,
                  session.providerMetadata,
                );
              }
              try {
                this.assertAgentWorkspaceProcessStartAllowed(
                  lifecycleWorkspaceId,
                );
              } catch (err) {
                // The lifecycle acquired ownership while newSession was
                // awaiting the adapter. Dispose before releasing the start
                // barrier so cleanup never misses this late session.
                await this.agents
                  .endSession(msg.agentId, executionId)
                  .catch(() => {});
                this.clearAgentExecutionRoute(executionId);
                throw err;
              }
              return { initialize, session };
            })(),
          );
          this.assertAgentWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
            const executionId = session.executionId;
            const stillRegistered =
              this.sessionAgent.get(executionId) === msg.agentId;
            this.router.clearOwner(executionId);
            this.sessionAgent.delete(executionId);
            this.sessionChat.delete(executionId);
            this.sessionWorkspace.delete(executionId);
            this.sessionMessages.delete(executionId);
            this.sessionLoadResponses.delete(executionId);
            this.detachedProviderBindings.delete(executionId);
            this.exitedAgentExecutions.delete(executionId);
            this.activePromptContexts.delete(executionId);
            this.promptSessions.delete(executionId);
            this.clearPendingAgentInteractions(executionId);
            if (
              msg.chatId &&
              this.conversationExecution.get(msg.chatId) === executionId
            ) {
              this.conversationExecution.delete(msg.chatId);
            }
            if (stillRegistered) {
              await this.agents
                .endSession(msg.agentId, executionId)
                .catch(() => {});
            }
            throw this.staleConversationBindFailure("newSession");
          }
          if (msg.chatId) {
            // One live agent session per chat. This fresh session supersedes
            // any prior session still bound to the same chat — a model/effort
            // respawn (the envKey force-rebuild) or a self-heal rebuild. Tear
            // the predecessor(s) down so an old SDK agent / app-server child /
            // subprocess can't LINGER (resource leak) or keep streaming into
            // the chat (the second half of the cursor "duplicate turn" bug).
            // Mirrors the AGENT_CLOSE_SESSION teardown. Best-effort and NON-
            // blocking: the new session is already live and the renderer has
            // moved its slot to it, so the predecessor's in-flight work is
            // abandoned regardless — endSession is fire-and-forget so a slow
            // or failing dispose can't delay (or fail) this creation.
            const superseded: string[] = [];
            for (const [priorSessionId, boundChatId] of this.sessionChat) {
              if (
                boundChatId === msg.chatId &&
                priorSessionId !== session.executionId
              )
                superseded.push(priorSessionId);
            }
            for (const priorSessionId of superseded) {
              const priorAgentId =
                this.sessionAgent.get(priorSessionId) ?? msg.agentId;
              this.router.clearOwner(priorSessionId);
              this.sessionAgent.delete(priorSessionId);
              this.sessionChat.delete(priorSessionId);
              if (
                this.conversationExecution.get(msg.chatId) === priorSessionId
              ) {
                this.conversationExecution.delete(msg.chatId);
              }
              this.sessionWorkspace.delete(priorSessionId);
              this.sessionMessages.delete(priorSessionId);
              this.sessionLoadResponses.delete(priorSessionId);
              this.detachedProviderBindings.delete(priorSessionId);
              this.exitedAgentExecutions.delete(priorSessionId);
              // The predecessor's turn is abandoned by definition here, and its
              // prompt promise may never settle after endSession — so its own
              // finally may never run. Retire the record with the rest of the
              // session's bookkeeping (the identity checks in that finally keep
              // a late settle from touching anything that outlived it).
              this.activePromptContexts.delete(priorSessionId);
              this.clearPendingAgentInteractions(priorSessionId);
              void this.agents
                .endSession(priorAgentId, priorSessionId)
                .catch((err) =>
                  console.warn(
                    `[agents] superseded-session dispose failed for ` +
                      `${priorSessionId}: ` +
                      (err instanceof Error ? err.message : String(err)),
                  ),
                );
            }
          }
          client.send(
            createMessage({
              type: "AGENT_SESSION_CREATED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              session,
              initialize,
            }),
          );
          return;
        }
        case "AGENT_INIT_AGENT": {
          // Spawns the subprocess with empty env (if not already running)
          // so the auth screen can read the agent's advertised auth methods.
          // Providing a real env later (via AGENT_NEW_SESSION) will transparently
          // respawn the subprocess when needed.
          const initialize = await this.agents.initializeAgent(msg.agentId);
          client.send(
            createMessage({
              type: "AGENT_AGENT_INITIALIZED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              initialize,
            }),
          );
          return;
        }
        case "AGENT_AUTHENTICATE": {
          await this.agents.authenticate(msg.agentId, msg.methodId);
          client.send(
            createMessage({
              type: "AGENT_AUTH_COMPLETED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              methodId: msg.methodId,
            }),
          );
          return;
        }
        case "AGENT_PROMPT": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, true)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          const promptChatId = this.sessionChat.get(msg.sessionId);
          if (promptChatId && this.conversationForkSources.has(promptChatId)) {
            client.send(
              createMessage({
                type: "AGENT_PROMPT_FAILED",
                source: "engine",
                requestId: msg.id,
                agentId: msg.agentId,
                executionId: msg.sessionId,
                sessionId: msg.sessionId,
                error:
                  "Wait for this conversation's provider fork to finish before sending.",
              }),
            );
            return;
          }
          // Renderer-local send locks disappear on reload. Keep the hard
          // concurrency invariant at the engine too so an older renderer (or
          // another client) cannot open a phantom second durable turn while
          // the provider is already responding on this session.
          const inFlight = this.activePromptContexts.get(msg.sessionId);
          if (inFlight) {
            if (this.activePromptIsLive(inFlight)) {
              client.send(
                createMessage({
                  type: "AGENT_PROMPT_FAILED",
                  source: "engine",
                  requestId: msg.id,
                  agentId: msg.agentId,
                  executionId: msg.sessionId,
                  sessionId: msg.sessionId,
                  error: "The agent is already responding to this chat.",
                }),
              );
              return;
            }
            // A record with no sign of life left is a ghost: the adapter's
            // prompt promise never settled, so its own cleanup will never run.
            // Release it instead of refusing this send — otherwise the guard
            // wedges the chat permanently (see PROMPT_STALE_AFTER_MS).
            console.warn(
              `[agents] releasing a stale in-flight prompt for session ` +
                `${msg.sessionId}: no activity for ` +
                `${Math.round((Date.now() - inFlight.lastActivityAt) / 1000)}s`,
            );
            this.activePromptContexts.delete(msg.sessionId);
            this.promptSessions.delete(msg.sessionId);
          }
          const lifecycleWorkspaceId = this.workspaceIdForAgentSession(
            msg.sessionId,
          );
          this.assertAgentWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          this.router.setOwner(msg.sessionId, client.id);
          this.sessionAgent.set(msg.sessionId, msg.agentId);
          const activePrompt: ActivePromptContext = {
            sessionId: msg.sessionId,
            agentId: msg.agentId,
            chatId: this.sessionChat.get(msg.sessionId) ?? null,
            turnId: msg.userMessageId ?? `turn-${msg.id}`,
            promptId: durablePromptId(msg.promptId, `prompt-${msg.id}`),
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
          };
          this.activePromptContexts.set(msg.sessionId, activePrompt);
          // Keep a start barrier registered from before the first await until
          // promptSessions is visible. Archive/delete either waits for this
          // preparation or sees the live prompt and cancels it; there is no
          // unobservable gap between the two states.
          let releasePromptStart = () => {};
          const promptStartSettled = this.trackWorkspaceProcessStart(
            lifecycleWorkspaceId,
            new Promise<void>((resolve) => {
              releasePromptStart = resolve;
            }),
          );
          let turnCtx: TurnSnapshotContext | null = null;
          try {
            // Persist the user's turn FIRST so the engine transcript is complete
            // (ordered user→agent) for every adapter — see persistUserPrompt.
            // `bubble` carries the composer's inline pills/chips so a reopened
            // chat re-renders them faithfully (else they'd reload as plain text).
            this.persistUserPrompt(
              msg.sessionId,
              msg.prompt,
              msg.bubble,
              msg.userMessageId,
            );
            // Mark the engine busy for the duration of the turn so the dev
            // HMR watcher defers respawning (a save mid-turn must not kill
            // the in-flight response). Cleared in finally — including on the
            // error path — so a failed turn never leaves a stale marker.
            // Record this turn: snapshot the work tree BEFORE the agent runs.
            turnCtx = await this.beginTurn(msg.sessionId, msg.userMessageId);
            // Publish the snapshot itself on the record so the settle watchdog
            // can recognise THIS turn's row by reference instead of re-deriving
            // a turn id that can disagree with beginTurn's (see turnSnapshot).
            activePrompt.turnSnapshot = turnCtx;
            this.assertAgentWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
            this.enterPrompt();
            this.promptSessions.add(msg.sessionId);
            if (turnCtx) {
              this.activeTurnSnapshots.set(msg.sessionId, turnCtx);
            }
            // Don't announce a turn as running when a Stop already landed on it
            // during this preparation: the client flipped its chat to stopped
            // the moment the user clicked, and `running` would drag the shimmer
            // and its elapsed timer back for as long as the cancelled settle
            // takes. The terminal state below is the only event it needs.
            if (!activePrompt.cancelledByUser) {
              this.emitTurnState(activePrompt, "running");
            }
          } catch (err) {
            // A lifecycle that acquired the workspace while the pre-snapshot
            // was being built must leave no forever-"running" turn row. Do not
            // take a post snapshot here: cleanup owns the checkout now.
            if (turnCtx) {
              finishTurnRow(turnCtx.chatId, turnCtx.turnId, {
                endedAt: Date.now(),
                stopReason: "workspace-lifecycle",
                status: "cancelled",
                postSnapshot: turnCtx.pre,
                files: [],
                usage: null,
              });
            }
            this.emitTurnState(activePrompt, "failed");
            if (this.activePromptContexts.get(msg.sessionId) === activePrompt) {
              this.activePromptContexts.delete(msg.sessionId);
            }
            throw err;
          } finally {
            releasePromptStart();
            void promptStartSettled;
          }
          // A cancel intent recorded before this turn began belongs to a
          // PREVIOUS turn — drop it so it can't mislabel this one. The intent
          // for THIS turn rides activePrompt.cancelledByUser, which is minted
          // with the turn and therefore survives this line.
          this.cancelRequested.delete(msg.sessionId);
          try {
            // Stop clicked while this turn was still being PREPARED (persisting
            // the user message, the pre-snapshot, the workspace barrier — all
            // before any adapter sees the prompt). Never dispatch: handing the
            // provider work the user already stopped is what made "send, then
            // Stop a second later" run to completion behind a STOPPED BY USER
            // pill, and left the engine holding a live turn that reappeared as
            // a running shimmer on the next reload.
            const response: PromptResponse = activePrompt.cancelledByUser
              ? { stopReason: "cancelled" }
              : await this.agents
                  .prompt(msg.agentId, msg.sessionId, msg.prompt)
                  .finally(() => {
                    activePrompt.adapterSettled = true;
                  });
            // Gated on the DURABLE fact, not on terminalPublished: the watchdog
            // can announce a stop in a window where it had no row to close yet
            // (a pre-snapshot still running past the deadline), and this is the
            // call that must still close it.
            if (turnCtx && !activePrompt.turnRowSettled) {
              await this.finishTurn(
                turnCtx,
                response.stopReason === "cancelled" ? "cancelled" : "completed",
                response.stopReason ?? null,
                response.usage ?? null,
              );
            }
            if (!activePrompt.terminalPublished) {
              this.emitTurnState(
                activePrompt,
                response.stopReason === "cancelled" ? "cancelled" : "completed",
                response.stopReason ?? null,
              );
            }
            client.send(
              createMessage({
                type: "AGENT_PROMPT_COMPLETE",
                source: "engine",
                requestId: msg.id,
                agentId: msg.agentId,
                executionId: msg.sessionId,
                sessionId: msg.sessionId,
                stopReason: response.stopReason,
                response,
              }),
            );
          } catch (err) {
            // Either signal means the user stopped this turn: the turn-scoped
            // flag (a Stop for THIS prompt, from any cancel site) or the
            // session-wide intent recorded while the adapter was running.
            const wasCancelled =
              activePrompt.cancelledByUser === true ||
              this.cancelRequested.has(msg.sessionId);
            if (turnCtx && !activePrompt.turnRowSettled) {
              // A user cancel can surface as a rejection instead of a clean
              // stopReason:"cancelled" (e.g. the SIGTERM'd subprocess tears
              // the stream down before the adapter can settle the turn).
              // Record what the user DID — cancelled — so a reloaded chat
              // shows STOPPED BY USER, not AGENT STOPPED.
              await this.finishTurn(
                turnCtx,
                wasCancelled ? "cancelled" : "failed",
                wasCancelled ? "cancelled" : null,
              );
            }
            if (!activePrompt.terminalPublished) {
              this.emitTurnState(
                activePrompt,
                wasCancelled ? "cancelled" : "failed",
                wasCancelled ? "cancelled" : null,
              );
            }
            // Forward the structured failure when the adapter raised
            // AgentFailureError — without this, the renderer has to
            // regex-match `error` and any wording drift drops
            // recoverable failures (session-expired, transport-closed)
            // into the hard-error toast. Matches the AGENT_ERROR
            // envelope behaviour for non-prompt handlers below.
            const failure =
              err instanceof AgentFailureError ? err.failure : undefined;
            client.send(
              createMessage({
                type: "AGENT_PROMPT_FAILED",
                source: "engine",
                requestId: msg.id,
                agentId: msg.agentId,
                executionId: msg.sessionId,
                sessionId: msg.sessionId,
                error: err instanceof Error ? err.message : String(err),
                failure,
              }),
            );
          } finally {
            activePrompt.adapterSettled = true;
            this.disarmCancelSettleDeadline(activePrompt);
            if (this.activeTurnSnapshots.get(msg.sessionId) === turnCtx) {
              this.activeTurnSnapshots.delete(msg.sessionId);
            }
            // The rest of this state is keyed by SESSION, not by turn, so it is
            // released whenever this turn ends — unless a later prompt has
            // already taken the session over (only possible after a stale
            // release above). Stripping the start barrier or dropping the
            // unanswered gates of THAT live turn is the failure this guards.
            const promptOwner = this.activePromptContexts.get(msg.sessionId);
            if (promptOwner === activePrompt) {
              this.activePromptContexts.delete(msg.sessionId);
            }
            if (!promptOwner || promptOwner === activePrompt) {
              this.promptSessions.delete(msg.sessionId);
              this.cancelRequested.delete(msg.sessionId);
              this.clearPendingAgentInteractions(msg.sessionId);
            }
            if (this.exitedAgentExecutions.has(msg.sessionId)) {
              this.clearAgentExecutionRoute(msg.sessionId);
            }
            this.exitPrompt();
          }
          return;
        }
        case "AGENT_CANCEL": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          // Record the intent BEFORE dispatching: if the cancel kills the
          // subprocess and the in-flight prompt rejects, the AGENT_PROMPT
          // catch still knows this was a user stop (turn row → cancelled).
          // markCancelIntent also stamps the accepted turn itself, so a Stop
          // that lands while the turn is still being prepared is honoured
          // instead of dispatched-then-forgotten.
          this.markCancelIntent(msg.sessionId);
          await this.agents.cancel(msg.agentId, msg.sessionId);
          return;
        }
        case "AGENT_STOP_BACKGROUND_TASK": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          await this.agents.stopBackgroundTask(
            msg.agentId,
            msg.sessionId,
            msg.taskId,
          );
          return;
        }
        case "AGENT_STEER": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, true)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          this.assertAgentWorkspaceProcessStartAllowed(
            this.workspaceIdForAgentSession(msg.sessionId),
          );
          // Deliver FIRST, persist after: if the adapter refuses (no turn in
          // flight, non-steerable turn, old codex CLI), the message stays
          // queued client-side and must NOT appear in the transcript. No
          // beginTurn/enterPrompt — the steered input rides the in-flight
          // AGENT_PROMPT's turn, which is still awaited above.
          await this.agents.steer(msg.agentId, msg.sessionId, msg.prompt);
          const steeredTurnId = this.activeTurnSnapshots.get(
            msg.sessionId,
          )?.turnId;
          this.persistSteeredUserPrompt(
            msg.sessionId,
            msg.prompt,
            msg.bubble,
            msg.userMessageId,
            steeredTurnId,
          );
          client.send(
            createMessage({
              type: "AGENT_STEERED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              executionId: msg.sessionId,
              sessionId: msg.sessionId,
              ...(steeredTurnId ? { turnId: steeredTurnId } : {}),
            }),
          );
          return;
        }
        case "AGENT_CLOSE_SESSION": {
          const requestedExecutionId = msg.executionId ?? msg.sessionId;
          // A conversation-only close can arrive while create/load is still
          // awaiting the provider, before sessionWorkspace has an execution
          // key to authorize. Fall back to the durable chat owner so a paired
          // device cannot invalidate a bind hidden by the desktop owner's
          // remote-workspace restriction.
          if (
            msg.chatId &&
            this.isHostRelayClient(client) &&
            this.conversationRestrictedFromRemote(msg.chatId)
          ) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          const candidateExecutionIds = new Set<string>();
          if (requestedExecutionId) {
            candidateExecutionIds.add(requestedExecutionId);
          }
          if (msg.chatId) {
            const mappedExecution = this.conversationExecution.get(msg.chatId);
            if (mappedExecution) candidateExecutionIds.add(mappedExecution);
            // A timed-out/retried bind can briefly leave more than one route
            // attached to a conversation. Closing the tab owns all of them.
            for (const [executionId, conversationId] of this.sessionChat) {
              if (conversationId === msg.chatId) {
                candidateExecutionIds.add(executionId);
              }
            }
          }
          for (const executionId of candidateExecutionIds) {
            if (this.remoteMayNotActOnSession(executionId, client, false)) {
              this.refuseSessionAccess(msg.id, msg.agentId, client);
              return;
            }
          }
          // Invalidate even when no execution exists yet. A create/resume that
          // was already awaiting provider startup will dispose its late result;
          // a later reopen receives a new token and may bind normally.
          this.invalidateConversationBind(msg.chatId);

          const previousClose = msg.chatId
            ? this.conversationCloseFlights.get(msg.chatId)
            : undefined;
          let releaseClose: (() => void) | undefined;
          const closeFlight = msg.chatId
            ? new Promise<void>((resolve) => {
                releaseClose = resolve;
              })
            : null;
          if (msg.chatId && closeFlight) {
            // Publish the barrier before the first await. A History restore in
            // the next task may bind immediately, but it must not hand a
            // provider its durable resume id while this execution is still
            // cancelling/disposing that same provider conversation.
            this.conversationCloseFlights.set(msg.chatId, closeFlight);
          }

          try {
            // Do not `await undefined`: even that yields one microtask, which
            // lets a prompt in its pre-dispatch window reach the adapter before
            // this first close records cancellation. Only serialized follow-up
            // closes have an earlier transaction to await.
            if (previousClose) await previousClose.catch(() => {});
            const candidateIsKnown = (executionId: string) =>
              this.sessionAgent.has(executionId) ||
              this.sessionChat.has(executionId) ||
              this.activePromptContexts.has(executionId) ||
              this.promptSessions.has(executionId);
            const hasKnownCandidate = [...candidateExecutionIds].some(
              candidateIsKnown,
            );
            const executions = [...candidateExecutionIds]
              .filter(
                (executionId) =>
                  candidateIsKnown(executionId) ||
                  // A trusted local close may be the final cleanup attempt
                  // after engine routing maps were partially lost. The gateway
                  // still knows how to dispose its exact explicit route. A
                  // remote client never gets this unknown-route capability.
                  (client.kind === "local" &&
                    !hasKnownCandidate &&
                    executionId === requestedExecutionId),
              )
              .map((executionId) => ({
                executionId,
                agentId: this.sessionAgent.get(executionId) ?? msg.agentId,
                conversationId: this.sessionChat.get(executionId),
              }));

            const settlements = await Promise.all(
              executions.map(({ executionId }) =>
                this.cancelLiveAgentSessions([executionId]),
              ),
            );
            for (const [index, execution] of executions.entries()) {
              const { executionId, conversationId } = execution;
              this.router.clearOwner(executionId);
              this.sessionAgent.delete(executionId);
              this.sessionChat.delete(executionId);
              this.sessionWorkspace.delete(executionId);
              this.sessionMessages.delete(executionId);
              this.sessionLoadResponses.delete(executionId);
              this.detachedProviderBindings.delete(executionId);
              this.exitedAgentExecutions.delete(executionId);
              // A wedged adapter is still owned by the cancel-settle watchdog.
              // Do not erase its record/timer; it will publish + persist
              // cancellation even if disposeSession never makes the prompt
              // promise return.
              if (settlements[index]) {
                this.activePromptContexts.delete(executionId);
                this.promptSessions.delete(executionId);
              }
              this.clearPendingAgentInteractions(executionId);
              if (
                conversationId &&
                this.conversationExecution.get(conversationId) === executionId
              ) {
                this.conversationExecution.delete(conversationId);
              }
            }
            if (msg.chatId) {
              const currentExecution = this.conversationExecution.get(
                msg.chatId,
              );
              if (
                currentExecution &&
                candidateExecutionIds.has(currentExecution)
              ) {
                this.conversationExecution.delete(msg.chatId);
              }
            }
            await Promise.all(
              executions.map(({ agentId, executionId }) =>
                this.agents.endSession(agentId, executionId),
              ),
            );
          } finally {
            releaseClose?.();
            if (
              msg.chatId &&
              closeFlight &&
              this.conversationCloseFlights.get(msg.chatId) === closeFlight
            ) {
              this.conversationCloseFlights.delete(msg.chatId);
            }
          }
          client.send(
            createMessage({
              type: "AGENT_SESSION_CLOSED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              ...(requestedExecutionId
                ? {
                    executionId: requestedExecutionId,
                    sessionId: requestedExecutionId,
                  }
                : {}),
              ...(msg.chatId ? { chatId: msg.chatId } : {}),
            }),
          );
          return;
        }
        case "AGENT_PERMISSION_RESPONSE": {
          // A relay client may answer ONLY a prompt it owns; a local host is
          // trusted and may always answer on the desktop's behalf.
          if (client.kind !== "local") {
            const owner = this.permissionOwner.get(msg.permissionId);
            if (owner !== client.id) return;
          }
          this.permissionOwner.delete(msg.permissionId);
          this.pendingPermissionRequests.delete(msg.permissionId);
          this.agents.answerPermission(msg.permissionId, msg.response);
          return;
        }
        case "AGENT_QUESTION_RESPONSE": {
          // Twin of AGENT_PERMISSION_RESPONSE — a relay client may answer ONLY a
          // question it owns; a local host may always answer.
          if (client.kind !== "local") {
            const owner = this.questionOwner.get(msg.questionId);
            if (owner !== client.id) return;
          }
          this.questionOwner.delete(msg.questionId);
          this.pendingQuestionRequests.delete(msg.questionId);
          this.agents.answerQuestion(
            msg.questionId,
            msg.response,
            msg.nativeRequestId,
          );
          return;
        }
        case "AGENT_SET_MODE": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          await this.agents.setMode(msg.agentId, msg.sessionId, msg.modeId);
          const cached = this.sessionLoadResponses.get(msg.sessionId);
          if (cached?.modes) {
            this.sessionLoadResponses.set(msg.sessionId, {
              ...cached,
              modes: { ...cached.modes, currentModeId: msg.modeId },
            });
          }
          client.send(
            createMessage({
              type: "AGENT_MODE_CHANGED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              executionId: msg.sessionId,
              sessionId: msg.sessionId,
              modeId: msg.modeId,
            }),
          );
          return;
        }
        case "AGENT_SET_MODEL": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          // Fire-and-forget: apply the new model to the live session (Claude
          // SDK → query.setModel). No-op for adapters without live model
          // selection. Errors surface via the outer handler's AGENT_ERROR.
          await this.agents.setModel(msg.agentId, msg.sessionId, msg.model);
          return;
        }
        case "AGENT_COMPACT": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          // Real compaction through Codex thread/compact/start.
          // Fire-and-forget: progress streams back as the agent's own
          // contextCompaction item (the two-state transcript row); errors
          // surface via the outer handler's AGENT_ERROR.
          await this.agents.compactContext(msg.agentId, msg.sessionId);
          return;
        }
        case "AGENT_UPDATE_CONFIG": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          // The env map flows into the agent subprocess environment
          // (Options.env). A relay (untrusted) client must NOT inject hazardous
          // names (NODE_OPTIONS/DYLD_*/PATH code-injection, *_BASE_URL/proxy
          // credential-redirect, secret-shaped) or point the agent at arbitrary
          // absolute dirs — the very threats the spawn path (agentSpawnOpts)
          // refuses caller env for. Local clients own the machine (pass through);
          // remote clients are scrubbed + their extra dirs clamped to the
          // managed-workspace allowlist.
          const updateEnv =
            (client.kind === "local"
              ? msg.env
              : this.scrubRelayUpdateConfigEnv(msg.env)) ?? {};
          // Fire-and-forget: apply the mid-session config change (effort /
          // fast / ultracode / additionalDirectories / allow-deny / maxTurns,
          // carried as the composer env map) to the live session. No-op for
          // adapters without live config changes. Errors surface via the
          // outer handler's AGENT_ERROR.
          await this.agents.updateConfig(msg.agentId, msg.sessionId, updateEnv);
          return;
        }
        case "AGENT_LIST_SESSIONS": {
          // A relay (untrusted) client must not enumerate sessions — or boot
          // an adapter's session-store lookup — at an arbitrary host cwd.
          // Clamp to the managed-workspace allowlist; drop anything else (the
          // adapter then lists its default location). Local stays unrestricted.
          const listCwd =
            client.kind === "local"
              ? msg.cwd
              : msg.cwd && this.pty.isWithinAllowed(msg.cwd)
                ? msg.cwd
                : undefined;
          const resp = await this.agents.listSessions(msg.agentId, {
            cwd: listCwd,
            cursor: msg.cursor,
          });
          client.send(
            createMessage({
              type: "AGENT_SESSIONS_LIST",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              sessions: resp.sessions,
              nextCursor: resp.nextCursor ?? null,
            }),
          );
          return;
        }
        case "AGENT_FORK_CONVERSATION": {
          const bindToken = this.beginConversationBind(msg.destinationChatId);
          bindToFinish = {
            conversationId: msg.destinationChatId,
            token: bindToken,
          };
          await Promise.all([
            this.waitForConversationClose(msg.sourceChatId),
            this.waitForConversationClose(msg.destinationChatId),
          ]);
          if (
            !this.conversationBindIsCurrent(msg.destinationChatId, bindToken)
          ) {
            throw this.staleConversationBindFailure("forkSession");
          }

          const sourceChat = getChat(msg.sourceChatId);
          const destinationChat = getChat(msg.destinationChatId);
          const sourceBinding = coerceProviderBinding(
            sourceChat?.providerBinding,
          );
          if (
            !sourceChat ||
            !destinationChat ||
            msg.sourceChatId === msg.destinationChatId
          ) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "A provider fork requires distinct persisted source and destination conversations.",
            });
          }
          if (
            sourceChat.agentId !== msg.agentId ||
            destinationChat.agentId !== msg.agentId ||
            sourceBinding?.providerId !== msg.agentId ||
            sourceBinding.kind !== "native"
          ) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "The source and destination must belong to the selected agent and the source must have a native provider binding.",
            });
          }
          if (
            destinationChat.sourceChatId !== sourceChat.id ||
            destinationChat.providerBinding ||
            destinationChat.sessionId
          ) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "The destination must be an unbound Zeros fork of the source conversation.",
            });
          }
          if (
            !sourceChat.folder ||
            !destinationChat.folder ||
            path.resolve(sourceChat.folder) !==
              path.resolve(destinationChat.folder)
          ) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "Conversation fork must stay inside the source Zeros workspace.",
            });
          }

          const sourceLocation = getChatLocation(sourceChat.id);
          const destinationLocation = getChatLocation(destinationChat.id);
          const sourceWorkspaceId = this.workspaceIdForProcess(
            sourceLocation?.workspaceId,
            sourceChat.folder,
          );
          const destinationWorkspaceId = this.workspaceIdForProcess(
            destinationLocation?.workspaceId,
            destinationChat.folder,
          );
          if (
            sourceWorkspaceId !== destinationWorkspaceId ||
            (client.kind !== "local" && !msg.workspaceId) ||
            (msg.workspaceId !== undefined &&
              msg.workspaceId !== destinationWorkspaceId)
          ) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "The fork request does not match the conversations' persisted Zeros workspace.",
            });
          }
          if (
            this.conversationExecution.has(destinationChat.id) ||
            Array.from(this.sessionChat.values()).includes(destinationChat.id)
          ) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "The destination conversation already has a live execution.",
            });
          }
          if (this.conversationForkSources.has(sourceChat.id)) {
            throw new AgentFailureError({
              kind: "lifecycle-superseded",
              stage: "forkSession",
              message:
                "Another provider fork is already reading this source conversation.",
            });
          }
          this.conversationForkSources.add(sourceChat.id);
          forkSourceToFinish = sourceChat.id;
          const sourceHasActiveWork = Array.from(
            this.sessionChat.entries(),
          ).some(
            ([executionId, conversationId]) =>
              conversationId === sourceChat.id &&
              this.activePromptContexts.has(executionId),
          );
          if (sourceHasActiveWork) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "forkSession",
              message:
                "Wait for the source conversation's active turn to finish before forking it.",
            });
          }

          const forkSpawnOpts = await this.agentSpawnOpts(
            {
              cwd: destinationChat.folder,
              env: msg.env,
              workspaceId: destinationWorkspaceId ?? undefined,
              cliBinary: msg.cliBinary,
            },
            client,
            "forkSession",
          );
          this.assertAgentWorkspaceProcessStartAllowed(
            destinationWorkspaceId,
            forkSpawnOpts.workspaceId,
            forkSpawnOpts.cwd,
          );
          const providerBinding = await this.trackDesignAuthorityStart(
            destinationWorkspaceId,
            this.agents.forkProviderBinding(msg.agentId, sourceBinding, {
              cwd: forkSpawnOpts.cwd,
              env: forkSpawnOpts.env,
              workspaceId: forkSpawnOpts.workspaceId,
              cliBinary: forkSpawnOpts.cliBinary,
              admissionSignal: this.conversationAdmissionSignal(
                msg.destinationChatId,
                bindToken,
              ),
            }),
          );
          if (
            !this.conversationBindIsCurrent(msg.destinationChatId, bindToken)
          ) {
            throw this.staleConversationBindFailure("forkSession");
          }
          this.assertAgentWorkspaceProcessStartAllowed(destinationWorkspaceId);
          const attached = attachChatProviderIdentityIfUnbound(
            destinationChat.id,
            msg.agentId,
            sourceChat.id,
            sourceChat.folder,
            destinationChat.folder,
            sourceBinding,
            providerBinding,
          );
          if (!attached) {
            // Do not compensate by deleting the provider thread: native delete
            // can cascade through descendants. The newer Zeros mutation wins;
            // an unattached provider fork is safer than destructive rollback.
            throw new AgentFailureError({
              kind: "lifecycle-superseded",
              stage: "forkSession",
              message:
                "The destination conversation changed before its provider binding could be attached.",
            });
          }
          this.broadcast(
            createMessage({
              type: "DB_CHANGED",
              source: "engine",
              kinds: ["chats"],
            }),
          );
          client.send(
            createMessage({
              type: "AGENT_CONVERSATION_FORKED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              sourceChatId: sourceChat.id,
              destinationChatId: destinationChat.id,
              providerBinding,
            }),
          );
          return;
        }
        case "AGENT_LOAD_SESSION": {
          const bindToken = this.beginConversationBind(msg.chatId);
          bindToFinish = { conversationId: msg.chatId, token: bindToken };
          await this.waitForConversationClose(msg.chatId);
          if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
            throw this.staleConversationBindFailure("loadSession");
          }
          // A renderer persists only the provider binding. On reload it
          // re-adopts the engine's current execution by Zeros conversation id;
          // after an engine restart there is no live route, so the gateway
          // mints a fresh execution for the same durable binding.
          let mappedConversationExecution = msg.chatId
            ? this.conversationExecution.get(msg.chatId)
            : undefined;
          // Repair an older/partial map state before spawning. `sessionChat`
          // remains authoritative evidence that this conversation already has
          // a live engine execution; missing only the reverse index must not
          // create a second provider process for the same chat.
          if (!mappedConversationExecution && msg.chatId) {
            for (const [executionId, conversationId] of this.sessionChat) {
              if (
                conversationId === msg.chatId &&
                this.sessionAgent.get(executionId) === msg.agentId
              ) {
                mappedConversationExecution = executionId;
                this.conversationExecution.set(msg.chatId, executionId);
                break;
              }
            }
          }
          const requestedExecutionId =
            // The chat's engine-owned route is newer evidence than a renderer
            // execution captured before a reload/restart. Letting an explicit
            // stale id win here would miss the live route and mint a duplicate
            // adapter process for the same conversation.
            mappedConversationExecution ??
            msg.executionId ??
            // A lone v8 load sessionId may still be a durable provider
            // locator. When an explicit binding accompanies it, never try the
            // compatibility locator as a live route.
            (msg.providerBinding ? undefined : msg.sessionId);
          if (
            requestedExecutionId &&
            this.remoteMayNotActOnSession(requestedExecutionId, client, true)
          ) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          // A local renderer reload does not stop its provider prompt. Re-own
          // the live session without calling adapter.loadSession: several
          // adapters implement load as replacement/disposal, which would kill
          // the exact turn we are trying to recover.
          //
          // A live execution can be re-adopted whether its provider is busy or
          // idle. Prompt state is stricter: a stopped/stale record must be
          // released before the cached execution is returned, or a renderer
          // reload would resurrect the running shimmer and its old timer.
          const existingPrompt = requestedExecutionId
            ? this.activePromptContexts.get(requestedExecutionId)
            : undefined;
          if (existingPrompt && !this.activePromptIsLive(existingPrompt)) {
            console.warn(
              `[agents] releasing a dead in-flight prompt for execution ` +
                `${requestedExecutionId!.slice(0, 8)}… on load: ` +
                `${existingPrompt.terminalPublished ? "already settled" : "no activity"}`,
            );
            this.disarmCancelSettleDeadline(existingPrompt);
            this.activePromptContexts.delete(requestedExecutionId!);
            this.promptSessions.delete(requestedExecutionId!);
          }
          const activePrompt = requestedExecutionId
            ? this.activePromptContexts.get(requestedExecutionId)
            : undefined;
          const liveExecution =
            requestedExecutionId && this.sessionAgent.has(requestedExecutionId)
              ? requestedExecutionId
              : null;
          if (liveExecution) {
            const liveAgentId = this.sessionAgent.get(liveExecution);
            if (liveAgentId !== msg.agentId) {
              throw new AgentFailureError({
                kind: "protocol-error",
                stage: "loadSession",
                message:
                  "This conversation's live execution belongs to a different agent.",
              });
            }
            // Nothing is spawned here, so cwd/env/cliBinary are moot — but
            // agentSpawnOpts is ALSO the choke point that refuses a remote
            // (untrusted) client naming no resolvable managed workspace, and
            // this path hands the caller a live turn: stream ownership, every
            // unresolved permission/question card (replayed below), and the
            // session→chat binding the transcript is written under. Skipping
            // the check would make re-adoption a way around it, so enforce the
            // remote half here. Local clients own the machine.
            //
            // All of it runs BEFORE any mutation: a refusal must not have
            // already moved ownership off the client that legitimately holds it.
            if (client.kind !== "local") {
              this.assertRemoteWorkspaceOperable(
                msg.workspaceId,
                "loadSession",
              );
              // …and it must be THIS session's workspace. Satisfying the clamp
              // with any workspace the caller can reach would otherwise let it
              // adopt a live turn belonging to a different one.
              const sessionWorkspaceId =
                this.sessionWorkspace.get(liveExecution);
              if (
                sessionWorkspaceId &&
                sessionWorkspaceId !== msg.workspaceId
              ) {
                throw new AgentFailureError({
                  kind: "protocol-error",
                  message:
                    "This session belongs to a different workspace than the one requested.",
                  stage: "loadSession",
                });
              }
              // Re-binding session→chat mid-turn redirects where the running
              // turn's transcript is persisted and where its pushes are routed.
              // A local renderer legitimately re-states the binding it already
              // owns after a reload; an untrusted client may only CONFIRM the
              // existing one (or establish one where none exists) — never move
              // a live turn onto a chat of its choosing.
              const boundChatId = this.sessionChat.get(liveExecution);
              if (msg.chatId && boundChatId && boundChatId !== msg.chatId) {
                throw new AgentFailureError({
                  kind: "protocol-error",
                  message:
                    "This session is already bound to a different chat; a remote client cannot rebind a running turn.",
                  stage: "loadSession",
                });
              }
            }
            this.router.setOwner(liveExecution, client.id);
            this.sessionAgent.set(liveExecution, msg.agentId);
            if (msg.chatId) {
              this.sessionChat.set(liveExecution, msg.chatId);
              this.conversationExecution.set(msg.chatId, liveExecution);
              if (activePrompt) activePrompt.chatId = msg.chatId;
            }
            client.send(
              createMessage({
                type: "AGENT_SESSION_LOADED",
                source: "engine",
                requestId: msg.id,
                agentId: msg.agentId,
                executionId: liveExecution,
                sessionId: liveExecution,
                response: this.sessionLoadResponses.get(liveExecution) ?? {},
                promptActive: !!activePrompt,
                ...(activePrompt
                  ? {
                      activeTurnStartedAt: activePrompt.startedAt,
                      promptId: activePrompt.promptId,
                    }
                  : {}),
              }),
            );
            if (activePrompt) this.emitTurnState(activePrompt, "running");
            this.replayPendingAgentInteractions(liveExecution, client);
            return;
          }
          // Lazy boot resume (§5.1). The caller asked to re-adopt only, and
          // there is nothing live to adopt. Answer now — before any teardown,
          // territory resolution, spawn-option derivation or boundary admission
          // runs — so restoring a surfaced-but-unfocused chat costs the engine
          // nothing. This is not a user-visible failure: the renderer keeps the
          // persisted transcript on screen and re-asks without `adoptOnly` the
          // moment the chat is focused, typed into, or sent to.
          if (msg.adoptOnly) {
            throw new AgentFailureError({
              kind: "session-expired",
              stage: "loadSession",
              message: "adopt-only load found no live execution to adopt.",
            });
          }
          // A reverse mapping without an owning agent route is not adoptable.
          // Dispose the gateway's possible leftover before minting a replacement
          // so partial bookkeeping loss cannot leak a duplicate provider child.
          if (
            requestedExecutionId &&
            (this.sessionChat.has(requestedExecutionId) ||
              mappedConversationExecution === requestedExecutionId)
          ) {
            this.clearAgentExecutionRoute(requestedExecutionId);
            await this.agents
              .endSession(msg.agentId, requestedExecutionId)
              .catch(() => {});
          }
          // A persisted Zeros conversation is authoritative for cold resume.
          // The renderer still couriers binding/cwd fields for older engines
          // and rowless compatibility, but a stale local mirror must never
          // roll SQLite back to an older provider thread or workspace.
          const persistedChat = msg.chatId ? getChat(msg.chatId) : null;
          if (persistedChat && persistedChat.agentId !== msg.agentId) {
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "loadSession",
              message:
                "The persisted conversation belongs to a different agent.",
            });
          }
          const persistedProviderBinding = persistedChat?.providerBinding;
          const persistedLegacyBinding =
            persistedChat?.agentId === msg.agentId && persistedChat.sessionId
              ? legacyProviderBinding(msg.agentId, persistedChat.sessionId)
              : null;
          const persistedLocation = msg.chatId
            ? getChatLocation(msg.chatId)
            : null;
          const persistedWorkspaceId = this.workspaceIdForProcess(
            persistedLocation?.workspaceId,
            persistedLocation?.folder,
          );
          const loadOpts = await this.agentSpawnOpts(
            client.kind === "local" && persistedChat
              ? {
                  ...msg,
                  cwd: persistedChat.folder,
                  workspaceId: persistedWorkspaceId ?? undefined,
                }
              : msg,
            client,
            "loadSession",
          );
          if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
            throw this.staleConversationBindFailure("loadSession");
          }
          const currentPersistedChat = msg.chatId ? getChat(msg.chatId) : null;
          const currentPersistedLocation = msg.chatId
            ? getChatLocation(msg.chatId)
            : null;
          const currentPersistedWorkspaceId = this.workspaceIdForProcess(
            currentPersistedLocation?.workspaceId,
            currentPersistedLocation?.folder,
          );
          if (
            Boolean(currentPersistedChat) !== Boolean(persistedChat) ||
            (persistedChat &&
              currentPersistedChat &&
              (currentPersistedChat.agentId !== persistedChat.agentId ||
                currentPersistedChat.folder !== persistedChat.folder ||
                currentPersistedChat.sessionId !== persistedChat.sessionId ||
                !sameProviderBinding(
                  currentPersistedChat.providerBinding,
                  persistedChat.providerBinding,
                ) ||
                currentPersistedWorkspaceId !== persistedWorkspaceId))
          ) {
            throw this.staleConversationBindFailure("loadSession");
          }
          const lifecycleWorkspaceId = this.workspaceIdForProcess(
            loadOpts.workspaceId,
            loadOpts.cwd,
          );
          this.assertAgentWorkspaceProcessStartAllowed(
            lifecycleWorkspaceId,
            loadOpts.workspaceId,
            loadOpts.cwd,
          );
          // The renderer may have unmounted between an engine-authoritative
          // provider_binding_update and its React chat-row mirror. A
          // conversation-only probe therefore falls back to the durable engine
          // row before degrading a compatibility sessionId into a legacy
          // binding. This is also the crash-safe path for a close/reopen in
          // that narrow window.
          if (client.kind !== "local") {
            const suppliedBinding = coerceProviderBinding(msg.providerBinding);
            const trustedBinding =
              persistedProviderBinding?.providerId === msg.agentId
                ? persistedProviderBinding
                : persistedLegacyBinding;
            if (
              !msg.chatId ||
              !persistedChat ||
              persistedChat.agentId !== msg.agentId ||
              !trustedBinding ||
              (msg.providerBinding &&
                (!suppliedBinding ||
                  !sameProviderBinding(suppliedBinding, trustedBinding))) ||
              (msg.sessionId &&
                msg.sessionId !==
                  (trustedBinding.legacySessionId ??
                    trustedBinding.resumeId)) ||
              !msg.workspaceId ||
              persistedWorkspaceId !== lifecycleWorkspaceId ||
              persistedWorkspaceId !== msg.workspaceId
            ) {
              throw new AgentFailureError({
                kind: "protocol-error",
                stage: "loadSession",
                message:
                  "A remote resume must match the provider identity and workspace persisted for this chat.",
              });
            }
          }
          const persistedBinding =
            persistedProviderBinding?.providerId === msg.agentId
              ? persistedProviderBinding
              : persistedLegacyBinding;
          const providerBinding = persistedChat
            ? persistedBinding
            : (coerceProviderBinding(msg.providerBinding) ??
              (msg.sessionId
                ? legacyProviderBinding(msg.agentId, msg.sessionId)
                : null));
          if (!providerBinding || providerBinding.providerId !== msg.agentId) {
            const persistedBindingMissing = Boolean(
              msg.chatId && persistedChat?.agentId === msg.agentId,
            );
            throw new AgentFailureError({
              kind:
                persistedBindingMissing ||
                (!msg.providerBinding && !msg.sessionId)
                  ? "session-expired"
                  : "protocol-error",
              stage: "loadSession",
              message:
                persistedBindingMissing ||
                (!msg.providerBinding && !msg.sessionId)
                  ? "This conversation has no live execution or durable provider binding."
                  : "This conversation has no valid provider binding for the selected agent.",
            });
          }
          let provisionalExecutionId: string | undefined;
          let response = await this.trackDesignAuthorityStart(
            lifecycleWorkspaceId,
            (async () => {
              let adapterLoadCompleted = false;
              try {
                const loaded = await this.agents.loadSession(
                  msg.agentId,
                  providerBinding,
                  {
                    cwd: loadOpts.cwd,
                    env: loadOpts.env,
                    workspaceId: loadOpts.workspaceId,
                    cliBinary: loadOpts.cliBinary,
                    admissionSignal: this.conversationAdmissionSignal(
                      msg.chatId,
                      bindToken,
                    ),
                    onExecutionCreated: (executionId) => {
                      if (
                        !this.conversationBindIsCurrent(msg.chatId, bindToken)
                      ) {
                        throw this.staleConversationBindFailure("loadSession");
                      }
                      this.assertAgentWorkspaceProcessStartAllowed(
                        lifecycleWorkspaceId,
                      );
                      provisionalExecutionId = executionId;
                      this.registerAgentExecutionRoute({
                        executionId,
                        agentId: msg.agentId,
                        ownerId: client.id,
                        chatId: msg.chatId,
                        workspaceId: lifecycleWorkspaceId,
                      });
                    },
                  },
                );
                adapterLoadCompleted = true;
                // Defensive compatibility for a mocked/older gateway that did
                // not invoke the early callback. Keep registration inside the
                // tracked start so a concurrent workspace reaper still sees it.
                if (!provisionalExecutionId && loaded.executionId) {
                  provisionalExecutionId = loaded.executionId;
                  this.registerAgentExecutionRoute({
                    executionId: loaded.executionId,
                    agentId: msg.agentId,
                    ownerId: client.id,
                    chatId: msg.chatId,
                    workspaceId: lifecycleWorkspaceId,
                  });
                }
                this.assertAgentWorkspaceProcessStartAllowed(
                  lifecycleWorkspaceId,
                );
                return loaded;
              } catch (err) {
                if (provisionalExecutionId) {
                  this.clearAgentExecutionRoute(provisionalExecutionId);
                }
                if (adapterLoadCompleted && provisionalExecutionId) {
                  await this.agents
                    .endSession(msg.agentId, provisionalExecutionId)
                    .catch(() => {});
                }
                if (
                  err instanceof AgentFailureError &&
                  err.failure.kind === "session-expired" &&
                  this.conversationBindIsCurrent(msg.chatId, bindToken) &&
                  msg.chatId
                ) {
                  const cleared = clearChatProviderIdentity(
                    msg.chatId,
                    msg.agentId,
                    providerBinding.resumeId,
                  );
                  if (cleared) {
                    // This mutation bypasses WorkspaceService, so publish the
                    // same keyed invalidation its write path would. Every open
                    // renderer must forget the dead durable handle, not only
                    // the surface whose load received AGENT_ERROR.
                    this.broadcast(
                      createMessage({
                        type: "DB_CHANGED",
                        source: "engine",
                        kinds: ["chats"],
                      }),
                    );
                  }
                }
                throw err;
              }
            })(),
          );
          const executionId = response.executionId;
          if (!executionId) {
            if (provisionalExecutionId) {
              this.clearAgentExecutionRoute(provisionalExecutionId);
              await this.agents
                .endSession(msg.agentId, provisionalExecutionId)
                .catch(() => {});
            }
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "loadSession",
              message: "The agent adapter did not return a Zeros execution id.",
            });
          }
          if (
            provisionalExecutionId &&
            provisionalExecutionId !== executionId
          ) {
            this.clearAgentExecutionRoute(provisionalExecutionId);
            await Promise.all([
              this.agents
                .endSession(msg.agentId, provisionalExecutionId)
                .catch(() => {}),
              this.agents.endSession(msg.agentId, executionId).catch(() => {}),
            ]);
            throw new AgentFailureError({
              kind: "protocol-error",
              stage: "loadSession",
              message:
                "The agent gateway returned a different execution than it published.",
            });
          }
          if (!this.conversationBindIsCurrent(msg.chatId, bindToken)) {
            this.clearAgentExecutionRoute(executionId);
            await this.agents
              .endSession(msg.agentId, executionId)
              .catch(() => {});
            throw this.staleConversationBindFailure("loadSession");
          }
          try {
            this.assertAgentWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          } catch (err) {
            this.clearAgentExecutionRoute(executionId);
            await this.agents
              .endSession(msg.agentId, executionId)
              .catch(() => {});
            throw err;
          }
          // A provider exit emitted during load has already retired this route;
          // never resurrect a dead execution merely because load then resolved.
          if (this.sessionAgent.get(executionId) !== msg.agentId) {
            await this.agents
              .endSession(msg.agentId, executionId)
              .catch(() => {});
            throw new AgentFailureError({
              kind: "session-expired",
              stage: "loadSession",
              message: "The agent execution exited while it was resuming.",
            });
          }
          response = this.withoutDetachedProviderIdentity(
            executionId,
            response,
          );
          if (msg.chatId) {
            this.persistProviderIdentityForChat(
              msg.chatId,
              msg.agentId,
              response.providerBinding,
              response.providerMetadata,
            );
          }
          this.sessionLoadResponses.set(executionId, {
            ...(this.sessionLoadResponses.get(executionId) ?? {}),
            ...response,
          });
          client.send(
            createMessage({
              type: "AGENT_SESSION_LOADED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              executionId,
              sessionId: executionId,
              response,
              promptActive: false,
            }),
          );
          this.replayPendingAgentInteractions(executionId, client);
          return;
        }
        default:
          // Every AGENT_* frame routes here now (prefix routing in
          // handleMessage) — an unhandled type is either a new client→engine
          // message missing its dispatcher case (the AGENT_QUESTION_RESPONSE
          // drop class) or a protocol violation. Never silent.
          console.warn(
            `[agents] dispatch ${msg.type}: no handler — message dropped`,
          );
          return;
      }
    } catch (err) {
      const agentId =
        "agentId" in msg ? (msg as { agentId?: string }).agentId : undefined;
      // Structured AgentFailure classification travels alongside the
      // free-form message so the UI can route deterministically on
      // failure.kind. The AgentFailureError class is the native
      // gateway's structured error boundary.
      const message = err instanceof Error ? err.message : String(err);
      const failure =
        err instanceof AgentFailureError ? err.failure : undefined;
      client.send(
        createMessage({
          type: "AGENT_ERROR",
          source: "engine",
          requestId: msg.id,
          agentId,
          code: failure?.kind
            ? `AGENT_${failure.kind.toUpperCase().replace(/-/g, "_")}`
            : "AGENT_DISPATCH_FAILED",
          message,
          failure,
        }),
      );
    } finally {
      if (bindToFinish) {
        this.finishConversationBind(
          bindToFinish.conversationId,
          bindToFinish.token,
        );
      }
      if (forkSourceToFinish) {
        this.conversationForkSources.delete(forkSourceToFinish);
      }
    }
  }

  /** Resolve the spawn inputs for an agent session, enforcing the remote
   *  trust boundary. A LOCAL (desktop) client is trusted and keeps full
   *  control of cwd/env/cliBinary. A REMOTE (cloud) client is UNTRUSTED, so:
   *   - its cwd is resolved server-side from a managed `workspaceId` (a raw
   *     client path is never trusted) and clamped to the
   *     same allowlist the PTY uses (engine root + managed worktrees);
   *   - ordinary client environment (provider keys, MCP/env-vault secrets,
   *     models and app variables) is preserved for normal-workspace parity,
   *     while the authority-bearing subset is removed/clamped before the
   *     gateway derives filesystem/socket/toolchain/container grants;
   *   - the client-supplied `cliBinary` override is dropped so it cannot point
   *     the spawn at an arbitrary executable (RCE) — the registry default wins.
   *  Mirrors the PTY clamp + env-scrub. Throws AgentFailureError (→ AGENT_ERROR)
   *  when a remote client names no resolvable managed workspace. The agent's
   *  own tool calls remain gated by the per-action permission flow (routed to
   *  the owning client), so within the workspace the remote operator keeps the
   *  intended remote-control parity. */
  private async agentSpawnOpts(
    msg: {
      cwd?: string;
      env?: Record<string, string>;
      workspaceId?: string;
      cliBinary?: string;
    },
    client: TransportClient,
    stage: "newSession" | "loadSession" | "forkSession",
  ): Promise<{
    cwd?: string;
    env?: Record<string, string>;
    workspaceId?: string;
    cliBinary?: string;
  }> {
    if (client.kind === "local") {
      const agentEnv = msg.env;
      const pathValue = agentEnv?.PATH ?? process.env.PATH ?? "";
      const contextId = msg.workspaceId
        ? `workspace:${msg.workspaceId}`
        : msg.cwd
          ? `folder:${path.resolve(msg.cwd)}`
          : "folder:unresolved";
      const credentialEnv = await prepareGitCredentialShellEnvironment(
        contextId,
        pathValue,
      );
      return {
        cwd: msg.cwd,
        env: credentialEnv
          ? { ...(agentEnv ?? {}), ...credentialEnv.env }
          : agentEnv,
        workspaceId: msg.workspaceId,
        cliBinary: msg.cliBinary,
      };
    }
    return {
      cwd: this.assertRemoteWorkspaceOperable(msg.workspaceId, stage),
      env: this.scrubRemoteAgentSpawnEnv(msg.env),
      workspaceId: msg.workspaceId,
      cliBinary: undefined,
    };
  }

  /** Preserve a cloud session's normal child environment without treating any
   * client-supplied coordinate as host authority. The returned map is still
   * completed from the worker's ambient environment by AgentGateway and then
   * installed only after ZSR containment. This choke point therefore needs to
   * remove only values consulted while constructing that boundary:
   *
   *  - process-start injection and engine/Conductor controls;
   *  - provider/config HOME roots, PATH/toolchain roots, host agent sockets,
   *    and ambient container endpoints;
   *  - unknown future `ZEROS_*` controls (positive allowlist);
   *  - additional directories outside managed workspace roots.
   *
   * API keys, MCP/env-vault secrets, provider routing, loopback application
   * service URLs, and arbitrary application variables remain intact. Their
   * child is already inside `agent-code`; service URLs receive a revocable
   * façade and reserved Zeros ports are rejected again by policy admission. */
  private scrubRemoteAgentSpawnEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env) return undefined;
    const stripped = stripEngineAuthorityEnv(env);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(stripped)) {
      if (
        !PORTABLE_ENV_NAME.test(name) ||
        value.includes("\0") ||
        isRuntimeInjectionEnvName(name) ||
        REMOTE_AGENT_ENGINE_DERIVED_ENV.has(name) ||
        name.startsWith("CONDUCTOR_")
      ) {
        continue;
      }
      if (name.startsWith("ZEROS_")) {
        if (!REMOTE_AGENT_SAFE_ZEROS_ENV.has(name)) continue;
        if (name === "ZEROS_ADDITIONAL_DIRS") {
          const clamped = clampRemoteAdditionalDirectories(value, (candidate) =>
            this.pty.isWithinAllowed(candidate),
          );
          if (clamped) out[name] = clamped;
          continue;
        }
      }
      out[name] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** Cosmetic title calls accept provider credentials/routing only. They have
   * no session boundary and no user-facing arbitrary-env contract. */
  private scrubTitleGenerationEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    if (!env) return undefined;
    const out = Object.fromEntries(
      Object.entries(stripEngineAuthorityEnv(env)).filter(
        ([name, value]) =>
          TITLE_GENERATION_ENV.has(name) &&
          PORTABLE_ENV_NAME.test(name) &&
          !value.includes("\0"),
      ),
    );
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /** The remote (untrusted) half of the spawn clamp, split out so the paths that
   *  do NOT spawn — re-adopting a live session — can enforce the same trust
   *  boundary without asking for spawn inputs they have no use for. Returns the
   *  server-resolved cwd for the named workspace; throws AgentFailureError
   *  (→ AGENT_ERROR) for a remote caller that named no resolvable, operable,
   *  allowlisted managed workspace. */
  private assertRemoteWorkspaceOperable(
    workspaceId: string | undefined,
    stage: "newSession" | "loadSession" | "forkSession",
  ): string {
    // Remote (untrusted): never trust a client-supplied cwd / env / cliBinary.
    if (!workspaceId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message:
          "Remote agent sessions must target a managed workspace " +
          "(workspaceId); a raw folder path is not accepted from a remote client.",
        stage,
      });
    }
    // A workspace the owner restricted from remote is non-operable: refuse
    // to spawn OR resume any agent session there. This is the durable choke point
    // (it runs for new AND load, before the session exists), so a relay device
    // can never get a restricted session into a runnable state; combined with the
    // chat-list redaction it also can't discover one. Fails closed.
    if (
      this.cloudWorker === null &&
      listRemoteRestrictedWorkspaceIds().has(workspaceId)
    ) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: "This workspace is restricted from remote access.",
        stage,
      });
    }
    // Server-side resolution (throws GitError for an unknown id) + allowlist
    // clamp — the resolved path is the engine root or a managed worktree, both
    // inside the PTY allowlist; reject anything else (fails closed).
    const cwd = this.workspace.resolveCwd(workspaceId);
    if (!this.pty.isWithinAllowed(cwd)) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `Remote agent cwd is outside the managed-workspace allowlist.`,
        stage,
      });
    }
    return cwd;
  }

  /** Concurrent duality: agents run in EVERY workspace regardless of its
   *  mode — they're code actors, and code territory stays live while the
   *  user designs. Provider-native process sandboxes carve Design out of each
   *  code actor's write authority; a workspace-level agent ban is unnecessary.
   *  This method survives as the lifecycle/territory-transition gate its
   *  callers need. The extra targets are accepted (and ignored) so the many
   *  spawn paths that passed cwd/workspaceId candidates for the retired design
   *  check didn't all need re-threading. */
  private assertAgentWorkspaceProcessStartAllowed(
    workspaceId: string | null | undefined,
    ..._targets: Array<string | null | undefined>
  ): void {
    this.assertWorkspaceProcessStartAllowed(workspaceId);
    if (workspaceId && this.designTerritoryTransitions.has(workspaceId)) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "This workspace's Design territory is being updated.",
        remediation:
          "Wait for the Design territory transition to finish, then retry the coding agent.",
        context: { workspaceId },
      });
    }
  }

  /** Sanitize a cloud (untrusted) client's AGENT_UPDATE_CONFIG env before it
   *  reaches the agent subprocess (Options.env). Mirrors the spawn-path policy
   *  (agentSpawnOpts refuses caller env entirely for remote), but updateConfig
   *  needs a few composer knobs — so this is a positive ALLOWLIST: only the
   *  known-safe knobs pass (with ZEROS_ADDITIONAL_DIRS clamped to the managed
   *  workspace). An allowlist (vs a denylist) means an unanticipated env-exec /
   *  credential vector — GIT_ASKPASS, GIT_EDITOR, SSH_ASKPASS, NODE_OPTIONS,
   *  *_BASE_URL, NODE_REPL_EXTERNAL_MODULE, … — can NEVER slip through a
   *  denylist gap. We also drop the privilege/manipulation knobs a remote must
   *  not set this way: CLAUDE_APPEND_SYSTEM_PROMPT (prompt injection),
   *  CLAUDE_ALLOWED/DISALLOWED_TOOLS (auto-run scope), and ZEROS_PERMISSION_MODE
   *  (auto-approval posture — that rides the separately-guarded AGENT_SET_MODE
   *  path). Local clients own the machine and are NOT scrubbed (see call site). */
  private scrubRelayUpdateConfigEnv(
    env: Record<string, string>,
  ): Record<string, string> {
    const RELAY_SAFE_KEYS = new Set([
      "ZEROS_THINKING_EFFORT",
      "ZEROS_FAST_MODE",
      "ZEROS_CLAUDE_IDLE_TIMEOUT_MINUTES",
      "ANTHROPIC_MODEL",
      "OPENAI_MODEL",
      "CURSOR_MODEL",
      "CLAUDE_FALLBACK_MODEL",
      "CLAUDE_MAX_BUDGET_USD",
    ]);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(env)) {
      if (RELAY_SAFE_KEYS.has(name)) {
        out[name] = value;
        continue;
      }
      if (name === "ZEROS_ADDITIONAL_DIRS") {
        // Extra working dirs are allowed but CLAMPED to the managed-workspace
        // allowlist, so a remote can't widen the agent's filesystem scope to
        // arbitrary absolute paths. Drop the key when nothing survives (the
        // adapter treats absence as "no dirs"); a hostile non-array/non-string
        // value is rejected by the same guard.
        const clamped = clampRemoteAdditionalDirectories(value, (candidate) =>
          this.pty.isWithinAllowed(candidate),
        );
        if (clamped) out[name] = clamped;
        continue;
      }
      // Everything else is dropped by default.
    }
    return out;
  }

  // ── Transcripts (engine persists on emit) ───────────────

  /** Persist a streaming session update to the unified DB AS IT EMITS. The
   *  engine is the source — this runs even when no client is attached (a cloud
   *  agent after the laptop closes). It folds the chunk with the SAME shared
   *  applyUpdate the renderer uses (no drift), then upserts only the rows that
   *  changed (a streaming text message upserts one growing row; a tool update
   *  rewrites its row). Best-effort: persistence must NEVER throw into the live
   *  stream. Only sessions bound to a chat (chatId sent at new/load-session) are
   *  persisted; unbound sessions (e.g. terminal) are skipped. */
  /** Persist the user's prompt to the engine transcript — mirroring the renderer's
   *  speculative user bubble (sendPrompt adds it locally before the round-trip).
   *  This makes the engine the COMPLETE source: it holds user turns for EVERY
   *  adapter, not just the ones that echo the prompt back as a user_message_chunk
   *  (Cursor/Claude/Codex do; others may not). Folding it through the same
   *  applyUpdate path means a later adapter echo (which carries a messageId)
   *  ADOPTS this same bubble via the dedup in applyUpdate — so the turn is stored
   *  exactly once, never duplicated. Non-text blocks (images, etc.) are skipped by
   *  applyUpdate, same as the renderer's bubble. */
  private persistUserPrompt(
    sessionId: string,
    prompt: ContentBlock[],
    bubble?: AgentPromptBubble,
    /** The renderer's local user-message id (v13). Persist the user message
     *  under it so turn ids align with the renderer without a re-window. */
    userMessageId?: string,
  ): void {
    const hasRich =
      !!bubble &&
      ((bubble.segments != null && bubble.segments.length > 0) ||
        (bubble.attachments != null && bubble.attachments.length > 0) ||
        bubble.displayText != null ||
        bubble.autoAction != null);
    if (hasRich && bubble) {
      // Rich-bubble path: persist ONE user message that mirrors the composer
      // exactly — `displayText` (mention TOKENS, not their wire expansion) plus
      // the inline segments / attachment chips. Folding it through the SAME
      // user_message_chunk path preserves the adapter-echo dedup (a later echo
      // carrying a messageId ADOPTS this bubble — `{...last, messageId}` keeps
      // the rich fields). We stamp segments/attachments onto the freshly
      // appended message so a REOPENED chat re-renders inline pills instead of
      // falling back to plain backtick text (the "pills disappear" bug).
      const text =
        bubble.displayText ??
        prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      this.persistSessionUpdate(
        sessionId,
        {
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text },
          },
        } as SessionNotification,
        (m) =>
          // Stamp ONLY a fresh user bubble that has no rich fields yet. The
          // `== null` guards keep a rare same-role coalesce (two user prompts
          // with no agent turn between) from clobbering an earlier turn's
          // already-stamped segments/attachments.
          m.kind === "text" && m.role === "user"
            ? {
                ...m,
                // Adopt the renderer's id so the persisted msg_id (and turn id)
                // matches turn.userPrompt.id in the live session.
                ...(userMessageId ? { id: userMessageId } : {}),
                ...(m.segments == null &&
                bubble.segments != null &&
                bubble.segments.length > 0
                  ? { segments: bubble.segments }
                  : {}),
                ...(m.attachments == null &&
                bubble.attachments != null &&
                bubble.attachments.length > 0
                  ? { attachments: bubble.attachments }
                  : {}),
                ...(m.autoAction == null && bubble.autoAction != null
                  ? { autoAction: bubble.autoAction }
                  : {}),
              }
            : m,
      );
      return;
    }
    for (const content of prompt) {
      this.persistSessionUpdate(
        sessionId,
        {
          update: { sessionUpdate: "user_message_chunk", content },
        } as SessionNotification,
        // Stamp the renderer's id onto the freshly-appended user bubble (later
        // blocks coalesce into it, so only the first append is stamped).
        userMessageId
          ? (m) =>
              m.kind === "text" && m.role === "user"
                ? { ...m, id: userMessageId }
                : m
          : undefined,
      );
    }
  }

  /** Persist a mid-turn steer as its own user row. Unlike AGENT_PROMPT, this
   *  cannot use the user_message_chunk reducer path: a steered input can arrive
   *  before any assistant/tool update has persisted, and the reducer's
   *  id-adoption branch would merge it into the original prompt. */
  private persistSteeredUserPrompt(
    sessionId: string,
    prompt: ContentBlock[],
    bubble?: AgentPromptBubble,
    userMessageId?: string,
    steeredTurnId?: string,
  ): void {
    const chatId = this.sessionChat.get(sessionId);
    if (!chatId) return;
    const text =
      bubble?.displayText ??
      prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
    const message: AgentTextMessage = {
      id:
        userMessageId ?? `user-${Date.now()}-${randomBytes(3).toString("hex")}`,
      kind: "text",
      role: "user",
      text,
      createdAt: Date.now(),
      ...(steeredTurnId ? { steeredTurnId } : {}),
      ...(bubble?.segments && bubble.segments.length > 0
        ? { segments: bubble.segments }
        : {}),
      ...(bubble?.attachments && bubble.attachments.length > 0
        ? { attachments: bubble.attachments }
        : {}),
      ...(bubble?.autoAction != null ? { autoAction: bubble.autoAction } : {}),
    };
    try {
      const next = [...(this.sessionMessages.get(sessionId) ?? []), message];
      this.sessionMessages.set(sessionId, next);
      upsertChatMessagesBulk(chatId, [
        {
          msgId: message.id,
          kind: message.kind,
          payload: JSON.stringify(message),
          createdAt: message.createdAt,
        },
      ]);
    } catch (err) {
      console.warn(
        "[agents] persist steered user prompt failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private persistSessionUpdate(
    sessionId: string,
    notification: SessionNotification,
    /** Applied ONLY to messages this update newly appended (those not in the
     *  prior list) — lets persistUserPrompt stamp inline pills/chips onto the
     *  fresh user bubble without touching already-persisted earlier turns. */
    enrichNew?: (m: AgentMessage) => AgentMessage,
  ): void {
    const chatId = this.sessionChat.get(sessionId);
    if (!chatId) return;
    try {
      const prev = this.sessionMessages.get(sessionId) ?? [];
      const folded = applyUpdate(prev, notification);
      if (folded === prev) return; // plan/mode/etc. — nothing to persist
      const prevSet = new Set(prev);
      const next = enrichNew
        ? folded.map((m) => (prevSet.has(m) ? m : enrichNew(m)))
        : folded;
      this.sessionMessages.set(sessionId, next);
      const changed = next.filter((m) => !prevSet.has(m));
      if (changed.length === 0) return;
      upsertChatMessagesBulk(
        chatId,
        changed.map((m) => ({
          msgId: m.id,
          kind: m.kind,
          payload: JSON.stringify(m),
          createdAt: m.createdAt,
        })),
      );
      // Nudge OTHER devices to re-window this chat (debounced). The initiator
      // sees the change live; this catches a passive observer (the chat open on
      // web while the Mac drives it) and is the robust fallback when a live
      // AGENT_SESSION_UPDATE is dropped (no slot / mid force-respawn) — the
      // "messages don't sync Mac↔web" fix.
      this.scheduleMessagesChanged(chatId);
    } catch {
      // Persistence must never disturb the live stream.
    }
  }

  /** Cancel any in-flight prompt on sessions bound to `chatId`, then wait
   *  (bounded) for the prompt to settle so its finishTurn lands before a reset
   *  truncates the timeline or a workspace lifecycle removes its cwd. The
   *  boolean lets destructive lifecycle callers fail closed; reset remains
   *  best-effort and intentionally ignores it. */
  private async cancelLivePromptForChat(chatId: string): Promise<boolean> {
    if (!chatId) return true;
    const sessions: string[] = [];
    for (const [sessionId, boundChat] of this.sessionChat) {
      if (boundChat === chatId && this.promptSessions.has(sessionId)) {
        sessions.push(sessionId);
      }
    }
    return this.cancelLiveAgentSessions(sessions);
  }

  /** Cancel an exact set of live sessions and wait until their prompt handlers
   *  have finalized their turns. Used by chat reset and by workspace cleanup;
   *  the latter also covers chatless/legacy sessions by workspace binding. */
  private async cancelLiveAgentSessions(
    sessionIds: Iterable<string>,
  ): Promise<boolean> {
    // activePromptContexts is installed before the pre-snapshot awaits and
    // promptSessions only after preparation. Looking at promptSessions alone
    // leaves a close/archive race where an accepted prompt is invisible and
    // gets dispatched after its session has already been disposed.
    const live = [...new Set(sessionIds)].filter(
      (sessionId) =>
        this.promptSessions.has(sessionId) ||
        this.activePromptContexts.has(sessionId),
    );
    if (live.length === 0) return true;
    await Promise.all(
      live.map(async (sessionId) => {
        const agentId = this.sessionAgent.get(sessionId);
        if (!agentId) return;
        // Record the intent first so the settling turn row reads "cancelled"
        // (STOPPED BY USER), not "failed" — mirrors the AGENT_CANCEL handler.
        this.markCancelIntent(sessionId);
        try {
          await Promise.race([
            this.agents.cancel(agentId, sessionId),
            new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
          ]);
        } catch {
          /* the bounded settlement check below remains authoritative */
        }
      }),
    );
    const deadline = Date.now() + 3000;
    while (
      live.some(
        (sessionId) =>
          this.promptSessions.has(sessionId) ||
          this.activePromptContexts.has(sessionId),
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A lifecycle (tab close, reset, workspace disposal) cannot leave the
    // durable turn looking live until the general 15-second Stop watchdog.
    // The adapter has already had its bounded cancel window; publish and await
    // the bookkeeping half now, before the caller disposes the execution or
    // lets this conversation resume through a replacement route. Keep the
    // active record itself until the adapter promise settles, so its eventual
    // catch/finally remains correctly attributed and cannot take over a newer
    // execution.
    await Promise.all(
      live.map(async (sessionId) => {
        const prompt = this.activePromptContexts.get(sessionId);
        if (prompt?.cancelledByUser) {
          await this.settleCancelledPrompt(prompt, 3_000, {
            warnIfUnacknowledged: false,
          });
        }
      }),
    );
    return live.every(
      (sessionId) =>
        !this.promptSessions.has(sessionId) &&
        !this.activePromptContexts.has(sessionId),
    );
  }

  // ── Turn recording (v13: footer / per-turn changes / reset) ──────────
  //
  // A turn = one prompt() round-trip. beginTurn snapshots the work tree BEFORE
  // the agent runs (so "pre" is the state before this turn's edits) and records
  // a running row; finishTurn snapshots AFTER, attributes the changed files from
  // THIS turn's own tool calls, and finalizes the row. Both are best-effort —
  // they must NEVER throw into or delay-fail the live prompt path.

  /** Begin recording a turn. Returns null when the session isn't chat-bound or
   *  has no folder (nothing to record / snapshot). */
  private async beginTurn(
    sessionId: string,
    userMessageId?: string,
  ): Promise<TurnSnapshotContext | null> {
    try {
      const chatId = this.sessionChat.get(sessionId);
      if (!chatId) return null;
      const loc = getChatLocation(chatId);
      const folder = loc?.folder ?? "";
      if (!folder) return null;
      const msgs = this.sessionMessages.get(sessionId) ?? [];
      // The opening user message (just persisted by persistUserPrompt) is the
      // turn id — also what truncateChatMessagesFrom keys on for reset.
      // Prefer the renderer's id (now also the persisted msg_id) so the turn id
      // matches turn.userPrompt.id; fall back to the last user msg's id.
      let turnId = userMessageId ?? "";
      let summary: string | null = null;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.kind === "text" && (m as { role?: string }).role === "user") {
          if (!turnId) turnId = m.id;
          const text = (m as { text?: string }).text ?? "";
          const firstLine =
            text
              .split("\n")
              .find((l) => l.trim().length > 0)
              ?.trim() ?? "";
          summary =
            firstLine.length > 80
              ? `${firstLine.slice(0, 80)}…`
              : firstLine || null;
          break;
        }
      }
      if (!turnId) {
        turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      }
      const startIndex = msgs.length;
      const agentId = this.sessionAgent.get(sessionId) ?? null;
      const isGit = await isGitWorkTree(folder);
      // Anchor everything at the worktree TOP, not the (possibly sub-)folder:
      // `git add -A` from a subdir with the empty scratch index would capture
      // only that subdir (prefix-stripped), so snapshots/diffs/reset would
      // misalign. repoToplevel resolves the top; fall back to `folder` (non-git
      // or resolution failed → behaves as before).
      const root = (isGit ? await repoToplevel(folder) : null) ?? folder;
      const pre = isGit
        ? await snapshotWorkingTree(root, snapshotRef(chatId, turnId, "pre"))
        : null;
      startTurnRow({
        chatId,
        turnId,
        workspaceId: loc?.workspaceId ?? null,
        // Store the worktree root — all turn paths/snapshots are relative to it,
        // and reset/diff (service.ts) run their git ops in this directory.
        folder: root,
        agentId,
        summary,
        startedAt: Date.now(),
        preSnapshot: pre,
      });
      return {
        sessionId,
        chatId,
        turnId,
        folder,
        root,
        workspaceId: loc?.workspaceId ?? null,
        startIndex,
        pre,
        isGit,
      };
    } catch {
      return null;
    }
  }

  /** Finalize a recorded turn: post snapshot + authored file set + duration. */
  private async finishTurn(
    ctx: TurnSnapshotContext,
    status: "completed" | "failed" | "cancelled",
    stopReason: string | null,
    // The turn's token/cost usage comes from the adapter's PromptResponse;
    // persisted on the turn row so the footer's usage popover survives reloads.
    usage: TurnUsage | null = null,
  ): Promise<void> {
    try {
      const msgs = this.sessionMessages.get(ctx.sessionId) ?? [];
      const turnMsgs = msgs.slice(ctx.startIndex);
      // Resolve tool paths against the agent cwd (ctx.folder), but express them
      // relative to the worktree root (ctx.root) so they line up with the
      // root-anchored snapshots below.
      const authored = authoredPathsFromMessages(
        turnMsgs,
        ctx.folder,
        ctx.root,
      );
      const post = ctx.isGit
        ? await snapshotWorkingTree(
            ctx.root,
            snapshotRef(ctx.chatId, ctx.turnId, "post"),
          )
        : null;
      let files: TurnFile[];
      if (ctx.pre && post && authored.length > 0) {
        // Real ±counts/status, restricted to authored paths (concurrency-safe).
        files = (await turnFileDiffs(
          ctx.root,
          ctx.pre,
          post,
          authored.map((a) => a.path),
        )) as TurnFile[];
      } else {
        // Without BOTH snapshots, a tool event is only an intent: permission
        // may have been denied, the tool may have failed, or the edit may have
        // been a no-op. Accuracy wins over an unverifiable pill (the Changes
        // surface is Git-backed anyway), so snapshot-less turns record no files.
        files = [];
      }
      finishTurnRow(ctx.chatId, ctx.turnId, {
        endedAt: Date.now(),
        stopReason,
        status,
        postSnapshot: post,
        files,
        usage: usage ?? null,
      });
      // Conversational, denied, failed-without-write, and net-zero turns remain
      // as lightweight timeline rows for duration/transcript reset, but their
      // whole-tree checkpoints serve no file operation. Drop those hidden refs
      // immediately so chat-only turns neither consume disk nor evict useful
      // file-changing checkpoints from the retention window — but ONLY when the
      // turn is provably a no-op (pre and post point at the same tree). Zero
      // ATTRIBUTED files with a tree that DID change means either a concurrent
      // chat's edit (harmless to keep) or an agent tool shape that escaped
      // attribution — in that case the refs are the only recovery net, so they
      // stay and the retention cap prunes them later.
      if (ctx.isGit && files.length === 0) {
        const noop =
          ctx.pre && post
            ? await treesIdentical(ctx.root, ctx.pre, post)
            : false;
        if (noop) {
          await deleteSnapshotRefs(ctx.root, ctx.chatId, [ctx.turnId]);
          clearTurnSnapshots(ctx.chatId, [ctx.turnId]);
        }
      }
      // A filesystem watcher may have refreshed Changes while this turn was
      // still running, before its authored file set had been finalized. Emit a
      // second authoritative generation only after the row is complete so the
      // turn filter/footer/count converge immediately — including when this was
      // an inactive concurrent chat whose renderer has no streaming→idle hook.
      if (files.length > 0) {
        const workspaceIds = dbChangedWorkspaceIds(
          { workspaceId: ctx.workspaceId },
          null,
        );
        this.broadcast(
          createMessage({
            type: "DB_CHANGED",
            source: "engine",
            kinds: ["workspaces"],
            ...(workspaceIds ? { workspaceIds } : {}),
          }),
        );
      }
      // Retention: cap this chat's hidden turn snapshots so a long-lived chat
      // doesn't pin an unbounded set of commits. The rows stay (they still feed
      // the dropdown/footer); only the now-old git refs are dropped + their OIDs
      // nulled. Best-effort, inside the same guard as the rest of finishTurn.
      if (ctx.isGit) {
        const stale = turnsWithSnapshotsBeyond(
          ctx.chatId,
          TURN_SNAPSHOT_RETENTION,
        );
        if (stale.length > 0) {
          await deleteSnapshotRefs(ctx.root, ctx.chatId, stale);
          clearTurnSnapshots(ctx.chatId, stale);
        }
      }
    } catch {
      // Turn recording must never disturb the live stream.
    }
  }

  // Coalesce a turn's many per-chunk persists into at most one DB_CHANGED per
  // ~250ms, carrying the affected chatIds so a client re-windows ONLY those
  // chats. Broadcast to all transports; every client subscribes, but on the
  // device that owns the live turn the re-window is a no-op (its own stream
  // already advanced the slot) — the nudge only does real work on OTHER devices.
  private readonly pendingMessageChats = new Set<string>();
  private messagesChangedTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleMessagesChanged(chatId: string): void {
    if (chatId) this.pendingMessageChats.add(chatId);
    if (this.messagesChangedTimer) return;
    this.messagesChangedTimer = setTimeout(() => {
      this.messagesChangedTimer = null;
      const chatIds = [...this.pendingMessageChats];
      this.pendingMessageChats.clear();
      if (chatIds.length === 0) return;
      this.router.broadcast(
        createMessage({
          type: "DB_CHANGED",
          source: "engine",
          kinds: ["messages"],
          chatIds,
        }),
      );
    }, 250);
    this.messagesChangedTimer.unref?.();
  }

  // ── Remote Workspace API ───────────────────────────────

  /** Dispatch a WORKSPACE_REQUEST (files / git read+write) to the workspace
   *  service. Writes from a remote (relay) client are gated by the
   *  remote-restriction list (authorizeRemoteWrite), not a per-op host prompt. */
  private async handleWorkspaceMessage(
    msg: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }>,
    client: TransportClient,
  ): Promise<void> {
    const { op } = msg;
    const params = msg.params ?? {};
    const hostRelay = this.isHostRelayClient(client);

    // Deny-by-default for remote clients: an op must be on the explicit allowlist
    // (an allowed remote read, a known repo write — restriction-gated below — or a
    // permitted chat/transcript metadata mutation). Any other op (incl. an
    // unknown/future one, or a read not yet opened to the web) is refused before
    // it can reach a handler. LOCAL desktop clients are never gated here — their
    // behavior is byte-identical to before.
    if (hostRelay && !this.workspace.isRemoteAllowed(op)) {
      client.send(
        createMessage({
          type: "WORKSPACE_ERROR",
          source: "engine",
          requestId: msg.id,
          op,
          code: "REMOTE_OP_NOT_ALLOWED",
          message: `Operation '${op}' is not permitted from a remote connection.`,
        }),
      );
      return;
    }

    if (this.workspace.isWriteOp(op) && hostRelay) {
      const approved = await this.authorizeRemoteWrite(op, params, client);
      if (!approved) {
        client.send(
          createMessage({
            type: "WORKSPACE_ERROR",
            source: "engine",
            requestId: msg.id,
            op,
            code: "APPROVAL_DENIED",
            message: "The host denied (or did not approve) this remote write.",
          }),
        );
        return;
      }
    }

    try {
      // A reset that truncates a chat's timeline must not race a turn still
      // streaming INTO that timeline (its trailing chunks would re-persist as
      // zombie rows past the cut). The renderer's footer cancels before it
      // calls turns.reset, but a reset from another device — or any future
      // caller — arrives here without that guard, so the engine enforces it.
      if (op === "turns.reset" && typeof params.chatId === "string") {
        await this.cancelLivePromptForChat(params.chatId);
      }
      // Register checkout/ref mutations before yielding. Archive/delete drains
      // this same workspace barrier before it snapshots or removes anything;
      // the service also rejects mutations submitted after lifecycle ownership
      // begins. This closes the cross-window stage/write/rebase-vs-archive gap.
      const lifecycleMutationWorkspaceId =
        this.workspace.lifecycleMutationWorkspaceId(op, params);
      const startedAt = Date.now();
      const dispatch = () =>
        this.workspace.handle(op, params, {
          remote: hostRelay,
        });
      // Every worktree-rewriting Git op can introduce, remove, rename, or
      // retarget Design territory (including when the current tree has none).
      // Freeze process admission and retire live code sandboxes before Git
      // starts: waiting until its result would leave a window where an old
      // sandbox could write a newly checked-out Design subtree. The chat is
      // retained and resumes under freshly resolved authority on its next
      // turn.
      const rewriteTarget =
        DESIGN_DIR_REWRITE_OPS.has(op) && lifecycleMutationWorkspaceId
          ? getWorkspaceById(lifecycleMutationWorkspaceId)
          : null;
      // A design write can INITIALIZE the design document on disk (design
      // root + canvas marker, document.ts initializeDesignDocumentUnlocked —
      // reachable from design.frame.create and every design write-back). That
      // is a territory identity flip for live CODE sessions, but it moves no
      // git ref and touches no settings file, so neither reconcile trigger
      // fires until the NEXT unrelated ref move — leaving already-admitted
      // code sandboxes with write authority over the newborn Design subtree
      // and, once the late restart finally landed, a composer pill that spun
      // with no repair. Snapshot existence before dispatch; a birth observed
      // after success schedules the reconcile immediately.
      const designInitTarget =
        op.startsWith("design.") &&
        this.workspace.isWriteOp(op) &&
        typeof params.workspaceId === "string"
          ? getWorkspaceById(params.workspaceId)
          : null;
      const designDirOf = (target: { path: string }) =>
        path.join(
          target.path,
          ...designDirectoryNameFor(target.path).split("/"),
        );
      const designDirExistedBefore =
        !designInitTarget ||
        designInitTarget.archivedAt != null ||
        fs.existsSync(designDirOf(designInitTarget));
      const rewriteHasDesign =
        rewriteTarget &&
        fs.existsSync(rewriteTarget.path) &&
        fs.existsSync(
          path.join(
            rewriteTarget.path,
            ...designDirectoryNameFor(rewriteTarget.path).split("/"),
          ),
        );
      const operation = rewriteTarget
        ? this.withDesignTerritoryTransition(
            [
              {
                workspaceId: rewriteTarget.id,
                designDirectory: path.join(
                  rewriteTarget.path,
                  ...designDirectoryNameFor(rewriteTarget.path).split("/"),
                ),
              },
            ],
            () =>
              withDesignWorkspaceMutation(rewriteTarget.path, async () => {
                const rewrite = () => dispatch();
                try {
                  return await (rewriteHasDesign
                    ? withDesignDirectoryWritable(rewriteTarget.path, rewrite)
                    : rewrite());
                } finally {
                  // Git failures may still leave a partially rewritten tree.
                  // Resolve that actual post-operation state before process
                  // admission reopens. If this fails, containment validation
                  // intentionally takes precedence over the Git error.
                  await resolveCodeAgentTerritory({
                    cwd: rewriteTarget.path,
                    workspaceRoot: rewriteTarget.path,
                    repoRoot: rewriteTarget.repoRoot,
                  });
                  await fenceWorkspaceDesignDirectoryIfPresent(rewriteTarget);
                }
              }),
          )
        : dispatch();
      const result = lifecycleMutationWorkspaceId
        ? await this.trackWorkspaceProcessStart(
            lifecycleMutationWorkspaceId,
            operation,
          )
        : await operation;
      // Leave evidence for the slow ones. Workspace ops log NOTHING today (the
      // error line below is gated on isWriteOp), so a save that outlived its
      // RPC budget left main.log with no trace it was ever dispatched — the
      // only visible artifacts were the watchdog respawning the engine and an
      // ambiguous "Request timeout" in the renderer, neither naming the op.
      // One line per genuinely slow op, so this can be diagnosed from a log
      // next time without turning every `git.status` into noise.
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= SLOW_WORKSPACE_OP_MS) {
        console.warn(`[workspace] ${op} took ${elapsedMs}ms`);
      }
      client.send(
        createMessage({
          type: "WORKSPACE_RESPONSE",
          source: "engine",
          requestId: msg.id,
          op,
          result,
        }),
      );
      if (
        designInitTarget &&
        !designDirExistedBefore &&
        fs.existsSync(designDirOf(designInitTarget))
      ) {
        this.scheduleDesignTerritoryReconcile(
          [designInitTarget],
          "design-init",
        );
      }
      // Kick off BACKGROUND setup for a freshly-created workspace: the
      // worktree already exists (create returned), so a slow `pnpm install` runs
      // in a PTY surfaced by the Setup tab — never on the create RPC. Local and
      // cloud use the same repo-code-task boundary; client placement does not
      // change the repository automation contract.
      if (op === "workspace.create") {
        const created = result as CreatedWorkspace | null;
        if (created) {
          // Gate on any pending LATE SEED PASS first (a seed scan cut short at
          // create time completes in the background — see worktree.ts). The
          // setup command and run-on-create actions may read seeded files
          // (.env, .npmrc, …), so they must observe the COMPLETE set. Resolves
          // immediately in the normal case (no pending pass); never rejects.
          void whenSeedingSettled(created.workspaceId)
            .then(() => {
              if (!this.workspaceAllowsProcessStart(created.workspaceId)) {
                return;
              }
              if (created.setupCommand) {
                return this.trackWorkspaceProcessStart(
                  created.workspaceId,
                  this.setup.start({
                    workspaceId: created.workspaceId,
                    command: created.setupCommand,
                    // run-on-create actions start once the install PASSES — a
                    // dev server before node_modules exists would just crash.
                    onPassed: () =>
                      this.startRunOnCreateActions(created.workspaceId),
                  }),
                );
              }
              // No setup to wait on — start run-on-create actions right away.
              this.startRunOnCreateActions(created.workspaceId);
            })
            .catch((err) =>
              console.error(
                `[setup] failed to start for ${created.workspaceId}:`,
                err,
              ),
            );
        }
      }
      // Cross-device live sync: tell the other clients a list changed
      // so they refetch. The originator already has the change locally — except
      // for the ops dbChangedIncludesOriginator names, which broadcast to
      // EVERYONE (a refetch is idempotent + cheap on the happy path). See that
      // predicate for why each family is there.
      const changed = dbChangedKinds(op, result);
      if (changed) {
        const workspaceIds = changed.includes("workspaces")
          ? dbChangedWorkspaceIds(params, result)
          : undefined;
        const dbChangedMsg = createMessage({
          type: "DB_CHANGED",
          source: "engine",
          kinds: changed,
          ...(workspaceIds ? { workspaceIds } : {}),
        });
        if (dbChangedIncludesOriginator(op)) {
          this.router.broadcast(dbChangedMsg);
        } else {
          this.router.broadcastExcept(client.id, dbChangedMsg);
        }
      }
      // A transcript mutation (click-to-edit truncate/clear, or a turn
      // reset/undo) leaves no live stream for the OTHER devices — nudge them to
      // re-window the affected chat so it reflects everywhere. Excludes the
      // originator, which already updated its own in-memory transcript. The
      // ["workspaces"] kind above only refreshes git/changes state; a chat
      // re-window needs ["messages"] + chatIds (sessions-provider's DB_CHANGED
      // handler returns early otherwise), so turns.reset/undoReset must emit
      // this too — they truncate / re-insert chat_messages via direct calls,
      // not the messages.* ops.
      let transcriptChat = "";
      if (
        op === "messages.clear" ||
        op === "messages.truncateFrom" ||
        op === "turns.reset"
      ) {
        transcriptChat = typeof params.chatId === "string" ? params.chatId : "";
      } else if (op === "turns.undoReset") {
        // undoReset's params carry only resetId; the handler returns the chatId
        // (and only re-inserts the transcript when it wasn't continued past the
        // reset — no re-window needed when it didn't).
        const r = result as {
          chatId?: unknown;
          transcriptRestored?: unknown;
        } | null;
        if (r && typeof r.chatId === "string" && r.transcriptRestored) {
          transcriptChat = r.chatId;
        }
      }
      if (transcriptChat) {
        this.router.broadcastExcept(
          client.id,
          createMessage({
            type: "DB_CHANGED",
            source: "engine",
            kinds: ["messages"],
            chatIds: [transcriptChat],
          }),
        );
      }
    } catch (err) {
      const code = isGitError(err) ? err.code : "WORKSPACE_OP_FAILED";
      client.send(
        createMessage({
          type: "WORKSPACE_ERROR",
          source: "engine",
          requestId: msg.id,
          op,
          code,
          message: err instanceof Error ? err.message : String(err),
          remediation: isGitError(err) ? err.remediation : undefined,
        }),
      );
      // Mutation failures are operationally important even when they are an
      // expected/user-correctable Git outcome (and therefore intentionally
      // excluded from error tracking). Keep a privacy-scrubbed breadcrumb in
      // main.log so a failed target change, rebase, stage, or GitHub action is
      // diagnosable from a support bundle instead of existing only as a toast.
      // `isWriteOp` is the REMOTE-security allowlist, so it misses the
      // local-only checkout mutations (working directories, and any future
      // sibling) — exactly the ops whose failure most needs a breadcrumb.
      // Widen to "anything that can rewrite a managed checkout", which is what
      // the sentence above actually means by "mutation".
      if (
        this.workspace.isWriteOp(op) ||
        this.workspace.lifecycleMutationWorkspaceId(op, params) !== null
      ) {
        const scrubbed = scrubError(err);
        console.error(
          `[workspace] ${op} failed (${code}): ${scrubbed.message}`,
        );
      }
      // Forward to error tracking (gap A) — scrubbed metadata; skips expected
      // git control-flow codes. Covers every git/file/workspace op, all surfaces.
      this.reportEngineError(client, `workspace:${op}`, err);
    }
  }

  /** Authorize a remote client's WRITE / terminal op. Remote writes/terminal
   *  actions run without a per-op desktop prompt for shared workspaces. There is
   *  intentionally no per-op
   *  host-approval prompt (the old ApprovalBroker / WORKSPACE_APPROVAL_REQUEST
   *  had no desktop UI consumer, so it always timed out and silently broke remote
   *  writes; it has been removed). The single gate is the per-workspace
   *  remote-restriction list: an op targeting a RESTRICTED workspace is refused —
   *  those are hidden from the remote list and must stay non-operable.
   *  `params.workspaceId` is the opaque id the remote client carries; pty.create
   *  passes the same id here too. Returns true ⇒ the op may proceed. */
  private async authorizeRemoteWrite(
    op: string,
    params: Record<string, unknown>,
    from: TransportClient,
  ): Promise<boolean> {
    void op;
    void from;
    const targetWs =
      typeof params.workspaceId === "string" ? params.workspaceId : undefined;
    return !(targetWs && listRemoteRestrictedWorkspaceIds().has(targetWs));
  }

  /** Whether a remote client may NOT act on / receive a given session.
   *  MULTIPLAYER (remote == local): every connected client can watch shared
   *  sessions. The agent backend's per-turn "already running" check is the
   *  concurrency guard.
   *
   *  The ONE exception is the per-workspace restriction list: a session running
   *  in a remote-restricted workspace must be invisible and non-operable to
   *  remote clients. */
  private sessionRestrictedFromRemote(sessionId: string): boolean {
    const wsId = this.sessionWorkspace.get(sessionId);
    return !!(wsId && listRemoteRestrictedWorkspaceIds().has(wsId));
  }

  /** Authorize a route-less conversation lifecycle request. The cached
   * workspace id is normally present; deriving from the folder covers a row
   * written just before the cache backfill. A live mapping remains a second
   * source for legacy rows with no durable workspace cache. */
  private conversationRestrictedFromRemote(chatId: string): boolean {
    const liveExecutionId = this.conversationExecution.get(chatId);
    if (liveExecutionId && this.sessionRestrictedFromRemote(liveExecutionId)) {
      return true;
    }
    const location = getChatLocation(chatId);
    const workspaceId =
      location?.workspaceId ??
      this.workspace.workspaceIdForCwd(location?.folder ?? undefined);
    return !!(
      workspaceId && listRemoteRestrictedWorkspaceIds().has(workspaceId)
    );
  }

  /** Publish prompt lifecycle independently of the request/response socket.
   * The current owner may be a renderer that adopted the session after the
   * prompt began, which is precisely why the original RPC response is not
   * sufficient. */
  private emitTurnState(
    prompt: ActivePromptContext,
    state: "running" | "completed" | "failed" | "cancelled",
    stopReason: StopReason | null = null,
  ): void {
    this.routeSessionScoped(
      prompt.sessionId,
      createMessage({
        type: "AGENT_SESSION_UPDATE",
        source: "engine",
        agentId: prompt.agentId,
        executionId: prompt.sessionId,
        ...(prompt.chatId ? { chatId: prompt.chatId } : {}),
        notification: {
          executionId: prompt.sessionId,
          sessionId: prompt.sessionId,
          update: {
            sessionUpdate: "turn_state",
            turnId: prompt.turnId,
            state,
            startedAt: prompt.startedAt,
            ...(stopReason ? { stopReason } : {}),
          },
        },
      }),
    );
  }

  /** Re-send unresolved permission/question gates after renderer replacement.
   * The adapter-side promises never went away, so hiding these cards would
   * strand an otherwise healthy turn behind an invisible interaction. */
  private replayPendingAgentInteractions(
    sessionId: string,
    client: TransportClient,
  ): void {
    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      if (pending.request.sessionId !== sessionId) continue;
      this.permissionOwner.set(permissionId, client.id);
      client.send(
        createMessage({
          type: "AGENT_PERMISSION_REQUEST",
          source: "engine",
          agentId: pending.agentId,
          permissionId,
          request: pending.request as never,
        }),
      );
    }
    for (const [questionId, pending] of this.pendingQuestionRequests) {
      if (pending.request.sessionId !== sessionId) continue;
      this.questionOwner.set(questionId, client.id);
      client.send(
        createMessage({
          type: "AGENT_QUESTION_REQUEST",
          source: "engine",
          agentId: pending.agentId,
          questionId,
          request: pending.request as never,
        }),
      );
    }
  }

  /** Record a sign of life for a session's in-flight prompt. Feeds only the
   *  staleness bound — cheap enough to call from every adapter push. */
  private touchActivePrompt(sessionId: string): void {
    const prompt = this.activePromptContexts.get(sessionId);
    if (prompt) prompt.lastActivityAt = Date.now();
  }

  /** Whether an accepted prompt still looks like the session's live turn: recent
   *  adapter activity, OR an unanswered permission/question gate — a gate can
   *  legitimately sit idle for hours while the user is away, and its resolver is
   *  proof the turn is alive. A turn whose ending the engine has already
   *  published is never live, however fresh its last chunk was. */
  private activePromptIsLive(prompt: ActivePromptContext): boolean {
    if (prompt.terminalPublished) return false;
    if (Date.now() - prompt.lastActivityAt < PROMPT_STALE_AFTER_MS) return true;
    return this.hasPendingAgentInteraction(prompt.sessionId);
  }

  /** Record a cancel for a session, on the SESSION and on the accepted turn.
   *
   *  The turn-scoped half is what makes a Stop unconditional: AGENT_PROMPT
   *  clears the session-wide intent before dispatching (it cannot tell a stale
   *  intent from one meant for the turn it is about to run), so a Stop clicked
   *  during the pre-dispatch window used to be lost by the engine AND by the
   *  adapter, which clears its own cancel flag as it enters prompt(). Also arms
   *  the settle deadline so the turn cannot stay "live" if the adapter never
   *  comes back. */
  private markCancelIntent(sessionId: string): void {
    this.cancelRequested.add(sessionId);
    const prompt = this.activePromptContexts.get(sessionId);
    if (!prompt) return;
    prompt.cancelledByUser = true;
    this.armCancelSettleDeadline(prompt);
  }

  /** Publish a cancelled turn ourselves if the adapter hasn't settled within
   *  CANCEL_SETTLE_DEADLINE_MS. Bookkeeping only — the adapter's cancel was
   *  already dispatched; this is what keeps a reload from re-adopting a turn the
   *  user stopped. */
  private armCancelSettleDeadline(prompt: ActivePromptContext): void {
    if (prompt.cancelSettleTimer || prompt.adapterSettled) return;
    const timer = setTimeout(() => {
      prompt.cancelSettleTimer = undefined;
      void this.settleCancelledPrompt(prompt, CANCEL_SETTLE_DEADLINE_MS);
    }, CANCEL_SETTLE_DEADLINE_MS);
    // Never hold the engine's event loop open for a stop deadline.
    timer.unref?.();
    prompt.cancelSettleTimer = timer;
  }

  /** Make the stopped outcome authoritative while retaining ownership of a
   * wedged adapter promise. Used by both the general Stop watchdog and the
   * shorter explicit-lifecycle boundary. */
  private async settleCancelledPrompt(
    prompt: ActivePromptContext,
    acknowledgementWindowMs: number,
    opts: { warnIfUnacknowledged?: boolean } = {},
  ): Promise<void> {
    if (prompt.adapterSettled || prompt.terminalPublished) return;
    // A later prompt already owns this session (only reachable after a stale
    // release), so this record no longer speaks for it.
    if (this.activePromptContexts.get(prompt.sessionId) !== prompt) return;
    this.disarmCancelSettleDeadline(prompt);
    prompt.terminalPublished = true;
    if (opts.warnIfUnacknowledged !== false) {
      console.warn(
        `[agents] cancel not acknowledged within ` +
          `${Math.round(acknowledgementWindowMs / 1000)}s for session ` +
          `${prompt.sessionId.slice(0, 8)}…: settling the turn as cancelled`,
      );
    }
    // finishTurn is self-contained (it never throws) and owns the durable
    // half: the row this chat's footer reads as STOPPED BY USER after a reload.
    // Matched by REFERENCE, not by turn id — the record's id and beginTurn's are
    // derived separately and disagree whenever the client omitted
    // userMessageId, so an id comparison here skipped the write for exactly the
    // turns it was meant to close.
    const turnCtx = this.activeTurnSnapshots.get(prompt.sessionId);
    if (turnCtx && turnCtx === prompt.turnSnapshot) {
      this.activeTurnSnapshots.delete(prompt.sessionId);
      // Claim the durable half only now that we are performing it. A turn still
      // being PREPARED has no row here yet; leaving this false is what lets the
      // prompt handler finalize that row instead of skipping it forever.
      prompt.turnRowSettled = true;
      await this.finishTurn(turnCtx, "cancelled", "cancelled");
    }
    this.emitTurnState(prompt, "cancelled", "cancelled");
  }

  private disarmCancelSettleDeadline(prompt: ActivePromptContext): void {
    if (!prompt.cancelSettleTimer) return;
    clearTimeout(prompt.cancelSettleTimer);
    prompt.cancelSettleTimer = undefined;
  }

  private hasPendingAgentInteraction(sessionId: string): boolean {
    for (const pending of this.pendingPermissionRequests.values()) {
      if (pending.request.sessionId === sessionId) return true;
    }
    for (const pending of this.pendingQuestionRequests.values()) {
      if (pending.request.sessionId === sessionId) return true;
    }
    return false;
  }

  private clearPendingAgentInteractions(sessionId: string): void {
    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      if (pending.request.sessionId !== sessionId) continue;
      this.pendingPermissionRequests.delete(permissionId);
      this.permissionOwner.delete(permissionId);
    }
    for (const [questionId, pending] of this.pendingQuestionRequests) {
      if (pending.request.sessionId !== sessionId) continue;
      this.pendingQuestionRequests.delete(questionId);
      this.questionOwner.delete(questionId);
    }
  }

  private remoteMayNotActOnSession(
    sessionId: string,
    client: TransportClient,
    allowAdopt: boolean,
  ): boolean {
    void allowAdopt;
    // Local desktop is always allowed; remote clients are refused only for a
    // session whose workspace the owner restricted from remote.
    return (
      this.isHostRelayClient(client) &&
      this.sessionRestrictedFromRemote(sessionId)
    );
  }

  /** Route a session-scoped push (agent stream / permission prompt) honoring the
   *  per-workspace remote restriction. A restricted session goes to local
   *  clients only — its transcript + tool output must never reach a remote client.
   *  Everything else broadcasts to all connected clients (multiplayer). */
  private routeSessionScoped(sessionId: string, msg: EngineMessage): void {
    if (!this.cloudWorker && this.sessionRestrictedFromRemote(sessionId)) {
      this.router.broadcastLocal(msg);
    } else {
      this.router.routeToSession(sessionId, msg);
    }
  }

  private refuseSessionAccess(
    requestId: string,
    agentId: string | undefined,
    client: TransportClient,
  ): void {
    client.send(
      createMessage({
        type: "AGENT_ERROR",
        source: "engine",
        requestId,
        agentId,
        code: "SESSION_RESTRICTED",
        message:
          "This session is restricted from remote access by the desktop owner.",
      }),
    );
  }

  // ── Account-binding (optional access token) ───────────

  /** Verify a relay client's access token on CONNECTED, if account-binding is
   *  configured. The token rode inside the E2EE channel (relay stays blind).
   *  On success, bind the client to its account id (audit). On failure — or a
   *  missing token when binding is REQUIRED — reject + close the client. Local
   *  clients (the trusted desktop) are never account-gated. */
  private async verifyAccountBinding(
    msg: Extract<EngineMessage, { type: "CONNECTED" }>,
    client: TransportClient,
  ): Promise<void> {
    if (!this.accountAuth) return;
    const token = typeof msg.authToken === "string" ? msg.authToken : "";

    // LOCAL client = the desktop's OWN renderer. It is the trusted desktop and
    // is NEVER gated, but its verified token ESTABLISHES the owner account (the
    // account signed into this Mac). Every remote device must then match it.
    if (client.kind === "local") {
      // The local desktop renderer ESTABLISHES the owner from its verified
      // token. A missing / expired / unverifiable LOCAL token leaves the current
      // owner intact (nextOwnerAccount keeps it) — a transient empty must never
      // lock out the trusted desktop or its remote devices; only an explicit
      // sign-out (OWNER_SIGNED_OUT → clearOwnerBinding) clears the owner.
      let sub: string | null = null;
      if (token) {
        try {
          sub = (await this.verifyAccountToken(token)).sub;
        } catch {
          sub = null;
        }
      }
      const next = nextOwnerAccount(this.ownerAccountSub, {
        kind: "local-connected",
        sub,
      });
      if (this.ownerAccountSub && next !== this.ownerAccountSub) {
        console.log(
          `[Zeros] engine owner account changed ${this.ownerAccountSub.slice(0, 8)}… → ${next?.slice(0, 8) ?? "∅"}…`,
        );
      }
      this.ownerAccountSub = next;
      return;
    }

    // REMOTE client (relay device, or a cloud-sandbox peer) — account-bound when
    // required; both reach this same branch (only LOCAL is handled above).
    if (!token) {
      if (this.accountAuth.required) {
        this.rejectConnection(
          client,
          "auth-required",
          "This engine requires an account-bound sign-in.",
        );
      }
      return; // optional + no token → allowed (pairing remains the auth)
    }

    let claims: VerifiedClaims;
    try {
      // Production: resolve the signing key by `kid` from the project JWKS
      // (rotation-safe, public-only). Falls back to the configured static key
      // (HS256 secret / pinned public key) for self-host / offline / tests.
      claims = await this.verifyAccountToken(token);
    } catch (err) {
      // Log the precise cause server-side for diagnostics, but send the remote
      // client a FIXED string — echoing the verifier's reason ("jwt expired" /
      // "invalid signature" / "JWKS fetch failed") back over the wire is a
      // verification oracle that distinguishes failure modes to a caller.
      console.warn(
        "[Zeros] relay account binding failed:",
        err instanceof Error ? err.message : err,
      );
      this.rejectConnection(
        client,
        "auth-invalid",
        "We couldn't verify your account for this desktop.",
      );
      return;
    }

    // OWNER CHECK: a remote client must be the SAME account that owns this
    // desktop (remoteAccountVerdict centralises the policy — future collaboration
    // widens it to invited, capability-scoped accounts).
    const verdict = remoteAccountVerdict({
      required: this.accountAuth.required,
      ownerSub: this.ownerAccountSub,
      clientSub: claims.sub,
    });
    if (verdict === "reject-owner-unknown") {
      // The desktop has no bound owner yet (still starting, OR the Mac operator
      // isn't signed in). RETRYABLE — the moment the desktop signs in, the owner
      // seeds and the next reconnect succeeds. Distinct reason so the web shows
      // "sign in on your Mac" instead of futilely refreshing its OWN (valid)
      // token in a loop — the client's token was never the problem.
      this.rejectConnection(
        client,
        "desktop-unbound",
        "Your Mac isn't signed in to Zeros yet (it may still be starting). Sign in to Zeros on your Mac, then retry.",
      );
      return;
    }
    if (verdict === "reject-wrong-account") {
      this.rejectConnection(
        client,
        "auth-wrong-account",
        "This desktop belongs to a different Zeros account. Sign in with the account that owns it.",
      );
      return;
    }
    this.clientAccount.set(client.id, claims.sub);
    if (typeof claims.exp === "number")
      this.clientTokenExp.set(client.id, claims.exp);
    this.ensureBindingSweep();
    appendSecurityAudit({
      type: "account-bound",
      clientId: client.id,
      accountSub: claims.sub,
    });
    console.log(
      `[Zeros] relay client ${client.id.slice(0, 8)}… bound to account ${claims.sub.slice(0, 8)}…`,
    );
  }

  /** The desktop owner signed out (OWNER_SIGNED_OUT, LOCAL clients only). Forget
   *  the bound owner account so a remote device holding a still-valid token for
   *  the old account can't keep — or regain — access under the old identity, and
   *  proactively drop connected relay devices so an OPEN session can't keep
   *  streaming after sign-out (the lazy remoteMustBindFirst gate otherwise only
   *  fires on the device's NEXT message). Relay devices are dropped with a
   *  RETRYABLE reason: they reconnect automatically the moment the desktop signs
   *  back in and re-seeds the owner. Until then remoteAccountVerdict returns
   *  reject-owner-unknown (also retryable) — the binding fails CLOSED.
   *
   *  Dropping is only meaningful when binding is ENFORCED: in pairing-only mode
   *  the owner doesn't gate access (remoteAccountVerdict allows any account), so a
   *  drop would be pointless reconnect churn. We still forget the owner in either
   *  mode so a later flip to required-mode starts from a clean slate. */
  private clearOwnerBinding(): void {
    this.ownerAccountSub = nextOwnerAccount(this.ownerAccountSub, {
      kind: "signed-out",
    });
    this.clientAccount.clear();
    this.clientTokenExp.clear();
    appendSecurityAudit({ type: "owner-signed-out" });
    if (this.accountAuth?.required) {
      for (const remoteClient of this.router.remoteClients()) {
        this.rejectConnection(
          remoteClient,
          "auth-required",
          "The desktop owner signed out. Sign in again to reconnect.",
        );
      }
    }
  }

  /** Verify an access token via the configured path (JWKS-by-kid in
   *  production, or a static key for self-host / offline / tests). */
  private async verifyAccountToken(token: string): Promise<VerifiedClaims> {
    const cfg = this.accountAuth!.config;
    return cfg.jwksUrl
      ? await verifyAccountJwtViaJwks(token, cfg)
      : verifyAccountJwt(token, cfg);
  }

  /** Send CONNECTION_REJECTED + close a relay client (1008). */
  private rejectConnection(
    client: TransportClient,
    reason:
      | "auth-required"
      | "auth-invalid"
      | "auth-wrong-account"
      | "desktop-unbound",
    message: string,
  ): void {
    appendSecurityAudit({
      type: "account-rejected",
      clientId: client.id,
      reason,
    });
    client.send(
      createMessage({
        type: "CONNECTION_REJECTED",
        source: "engine",
        reason,
        message,
        engineProtocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_SUPPORTED_PROTOCOL,
      }),
    );
    client.close(1008, reason);
  }

  /** Demote any remote client (relay or cloud) whose bound token has expired,
   *  so a session can't outlive the JWT it bound with. Rejected with a RETRYABLE
   *  reason — the client auto-refreshes its token and reconnects with a fresh one.
   *  Only meaningful in required mode (optional mode never gates on the account). */
  private sweepExpiredBindings(): void {
    if (!this.accountAuth?.required || this.clientTokenExp.size === 0) return;
    const skewMs = (this.accountAuth.config.clockSkewSec ?? 30) * 1000;
    const now = Date.now();
    for (const remoteClient of this.router.remoteClients()) {
      const exp = this.clientTokenExp.get(remoteClient.id);
      if (exp === undefined || now <= exp * 1000 + skewMs) continue;
      const sub = this.clientAccount.get(remoteClient.id);
      this.clientAccount.delete(remoteClient.id);
      this.clientTokenExp.delete(remoteClient.id);
      appendSecurityAudit({
        type: "session-expired",
        clientId: remoteClient.id,
        accountSub: sub,
      });
      this.rejectConnection(
        remoteClient,
        "auth-invalid",
        "Your session expired. Sign in again to reconnect.",
      );
    }
  }

  /** Lazily start the token re-verification sweep on the first remote bind. unref so
   *  it never keeps the process alive; cleared in stop(). */
  private ensureBindingSweep(): void {
    if (this.bindingSweep) return;
    this.bindingSweep = setInterval(() => this.sweepExpiredBindings(), 60_000);
    this.bindingSweep.unref?.();
  }

  // ── Terminal (PTY) ─────────────────────────────────────

  /** A non-local socket is not automatically a low-authority desktop relay.
   * In an attested cloud-worker deployment it is the owner's only workspace
   * UI and receives normal in-sandbox product authority after transport/account
   * authentication. The old host-relay policy remains deny-by-default when no
   * immutable cloud-worker admission is present. */
  private isHostRelayClient(client: TransportClient): boolean {
    return client.kind !== "local" && this.cloudWorker === null;
  }

  /** Credential invalidation carries method identity and reason only. In a
   * qualified cloud workspace the cloud UI is the owner-facing host and must
   * receive it so its credential coordinator can refresh/reseed the working
   * copy. On a desktop engine, preserve the legacy host-relay privacy boundary
   * and notify local Electron only. */
  private publishGithubCredentialChange(change: GithubCredentialChange): void {
    if (this.cloudWorker && this.ownerAccountSub) {
      try {
        requestCloudGithubCredentialRefresh({
          ownerSubject: this.ownerAccountSub,
          method: change.method,
          reason: change.reason,
        });
      } catch {
        // The browser event remains useful, but the external coordinator must
        // not infer success from a log line. Keep diagnostics secret/path-free;
        // qualification treats a missing refresh marker as a failed rotation.
        console.error(
          "[Zeros] could not publish the cloud GitHub credential refresh request",
        );
      }
    }
    const message = createMessage({
      type: "GITHUB_CREDENTIAL_CHANGED",
      source: "engine",
      ...change,
    });
    if (this.cloudWorker) this.router.broadcast(message);
    else this.router.broadcastLocal(message);
  }

  /** Whether `client` may drive a SHARED terminal (write/resize/kill). The local
   *  desktop is the trusted operator and may always act; a remote client may act
   *  only on a terminal in a KNOWN, non-restricted workspace (fail-closed). */
  private mayOperateTerminal(
    client: TransportClient,
    sessionId: string,
  ): boolean {
    if (!this.isHostRelayClient(client)) return true;
    return this.terminals.remoteMayOperate(
      sessionId,
      listRemoteRestrictedWorkspaceIds(),
    );
  }

  /** Notify every connected device that the shared terminal set changed (one was
   *  created or exited) so each re-fetches PTY_LIST and its tab strip stays in
   *  sync — multiplayer, like agent sessions. */
  private broadcastTerminalsChanged(): void {
    this.broadcast(
      createMessage({ type: "PTY_TERMINALS_CHANGED", source: "engine" }),
    );
  }

  /** Spawn a host PTY for a client. Remote creation is gated by the
   *  remote-restriction list (trusted device; no per-spawn host prompt). */
  private async handlePtyCreate(
    msg: Extract<EngineMessage, { type: "PTY_CREATE" }>,
    client: TransportClient,
  ): Promise<void> {
    const ptyExit = () =>
      client.send(
        createMessage({
          type: "PTY_EXIT",
          source: "engine",
          sessionId: msg.sessionId,
          exitCode: null,
          signal: null,
        }),
      );

    // (#9) Resolve the cwd ONCE — reused for the approval prompt AND the spawn —
    // so a symlink swapped during the (awaited) approval can't make the spawned
    // cwd differ from the path the operator approved.
    const reattach = this.pty.has(msg.sessionId);

    // Shared-terminal reattach gate (multiplayer): a second device attaching to
    // an existing terminal is the intended behaviour — but a remote client may
    // only (re)attach to one in a KNOWN, non-restricted workspace. Gate on the
    // REGISTRY's stored workspace (authoritative), NOT the client-supplied cwd —
    // otherwise a remote client could attach to a restricted terminal by passing a shared
    // workspace id and leak its scrollback. (Fresh spawns have no registry entry
    // yet; they are gated below by the cwd check and restriction approval.)
    if (reattach && !this.mayOperateTerminal(client, msg.sessionId)) {
      ptyExit();
      return;
    }
    // Resolve the canonical managed workspace id for this terminal — from an
    // explicit workspaceId if sent, else from the cwd token (which may be a
    // workspace ID or a real host PATH). Drives the restriction gate + the shared
    // registry for both local (cwd is always a path) and remote (id or path).
    // Terminals run in every workspace regardless of view mode. The strong
    // Design carve-out is attached only to Zeros-launched code agents.
    const canonicalWsId =
      (reattach ? this.terminals.get(msg.sessionId)?.workspaceId : null) ??
      this.workspace.workspaceIdForCwd(msg.workspaceId) ??
      this.workspace.workspaceIdForCwd(msg.cwd);

    // Publish the start barrier before any authorization/credential await.
    // Archive/delete either rejects this start at the lifecycle gate below or
    // waits for it to become enumerable, then reaps it; there is no gap where a
    // late PTY can appear after process enumeration.
    const start = Promise.resolve().then(() =>
      this.handlePtyCreateForWorkspace(
        msg,
        client,
        ptyExit,
        reattach,
        canonicalWsId,
      ),
    );
    return this.trackWorkspaceProcessStart(canonicalWsId, start);
  }

  private async handlePtyCreateForWorkspace(
    msg: Extract<EngineMessage, { type: "PTY_CREATE" }>,
    client: TransportClient,
    ptyExit: () => void,
    reattach: boolean,
    canonicalWsId: string | null,
  ): Promise<void> {
    let cwdInput = msg.cwd;
    if (client.kind !== "local" && !reattach) {
      // A qualified cloud workspace runs the provider's own login CLI in a
      // repository-free cwd under the attested human-worker identity. The URL
      // is still opened by the renderer on the user's device. A remote caller
      // reaching a local desktop engine never receives this escape from the
      // managed-workspace cwd clamp.
      if (msg.cwd === PTY_AGENT_AUTH_CWD) {
        if (!this.cloudWorker || !msg.ephemeral) {
          ptyExit();
          return;
        }
        cwdInput = PTY_AGENT_AUTH_CWD;
      } else {
        // Fail closed: a new remote terminal must resolve to a known managed
        // workspace dir inside the PTY allowlist — never a shell at the engine
        // root from a bogus cwd. A reattach reuses the already-validated pty.
        let real: string | null = null;
        try {
          real = msg.cwd ? this.workspace.resolveCwd(msg.cwd) : null;
        } catch {
          real = msg.cwd ?? null; // not an id → candidate path, validated next
        }
        if (!real || !this.pty.isWithinAllowed(real)) {
          ptyExit();
          return;
        }
        cwdInput = real;
      }
    }
    const resolvedCwd = this.pty.resolveCwd(cwdInput);

    if (this.isHostRelayClient(client)) {
      // No per-spawn prompt for a trusted device — the terminal opens like local
      // for a SHARED workspace. The single gate is the restriction list, checked
      // on the RESOLVED workspace id so a restricted workspace is refused whether
      // the client sent its id OR its real path. (resolvedCwd is the real host
      // path the shell actually spawns in.)
      const approved = await this.authorizeRemoteWrite(
        "pty.create",
        { workspaceId: canonicalWsId ?? undefined, cwd: resolvedCwd, reattach },
        client,
      );
      if (!approved) {
        ptyExit();
        return;
      }
    }
    // Re-check after the awaited remote authorization. For local callers this
    // is also the final synchronous gate immediately before spawn/reattach.
    // The archive/delete flight is registered before its reaper runs, so a
    // late terminal cannot appear after that reaper enumerated the workspace.
    if (!this.workspaceAllowsProcessStart(canonicalWsId)) {
      ptyExit();
      return;
    }
    let env: Record<string, string> | undefined;
    const fullHumanEnvironment =
      client.kind === "local" || this.cloudWorker !== null;
    if (!reattach && fullHumanEnvironment) {
      const baseEnv = buildPtyEnv({
        cwd: resolvedCwd,
        workspaceId: canonicalWsId,
      });
      const credentialEnv = await prepareGitCredentialShellEnvironment(
        canonicalWsId ? `workspace:${canonicalWsId}` : `folder:${resolvedCwd}`,
        baseEnv.PATH ?? "",
        this.cloudWorker
          ? { uid: this.cloudWorker.uid, gid: this.cloudWorker.gid }
          : undefined,
      );
      env = credentialEnv ? { ...baseEnv, ...credentialEnv.env } : baseEnv;
    }
    // Local credential setup is asynchronous too. Avoid spawning at all when
    // archive/delete acquired the workspace while it was resolving.
    if (!this.workspaceAllowsProcessStart(canonicalWsId)) {
      ptyExit();
      return;
    }
    const info = this.pty.create({
      sessionId: msg.sessionId,
      resolvedCwd,
      cols: msg.cols,
      rows: msg.rows,
      // A cloud transport connected to a qualified in-workspace coordinator is
      // not the old host relay: its explicit human terminal gets that worker's
      // normal env. A remote caller reaching a local engine remains scrubbed.
      scrubEnv: !fullHumanEnvironment,
      ...(env ? { env } : {}),
    });
    // Register a freshly-spawned terminal in the SHARED registry so every device
    // can discover + attach to it (PTY_LIST) and the restriction gate can scope
    // it. The workspace is resolved server-side from the cwd (id OR path), so a
    // DESKTOP terminal (local, always a path cwd) is correctly scoped too — no
    // null-workspace blind spot. null only for a genuinely unmanaged folder.
    //
    // EXCEPTION: an ephemeral one-shot (the composer's inline `claude /mcp`
    // runner) is NOT registered — it's a private, transient command terminal,
    // so it never shows in another device's PTY_LIST and leaves no "(exited)"
    // tab when its shell ends. The live PtyService session still exists (so
    // write/resize/kill + PTY_DATA/PTY_EXIT all work for the owning client);
    // only the multiplayer bookkeeping is skipped. On exit, markExited no-ops
    // (no entry) so no spurious terminals-changed broadcast fires.
    if (!info.reattached && !msg.ephemeral) {
      if (this.terminals.has(info.sessionId)) {
        // Restart in place of a previously-EXITED terminal (its old pty had died,
        // so this is a fresh spawn) — clear the exited flag so every device shows
        // it live again.
        if (this.terminals.markAlive(info.sessionId))
          this.broadcastTerminalsChanged();
      } else {
        const added = this.terminals.add({
          sessionId: info.sessionId,
          workspaceId: canonicalWsId,
          cwd: info.cwd,
          createdAt: Date.now(),
        });
        if (added) this.broadcastTerminalsChanged();
      }
    }
    // On reattach (refresh / panel reopen / a second device), ship a serialized
    // scrollback snapshot so the client repaints the exact pre-existing screen
    // instead of a blank shell. Fresh spawns carry no replay. Best-effort — a
    // missing/expired mirror just yields an empty replay (live shell, no ghost).
    const snap = info.reattached
      ? await this.pty.snapshot(info.sessionId)
      : null;
    client.send(
      createMessage({
        type: "PTY_CREATED",
        source: "engine",
        requestId: msg.id,
        sessionId: info.sessionId,
        pid: info.pid,
        cwd: info.cwd,
        cols: info.cols,
        rows: info.rows,
        reattached: info.reattached === true,
        replay: snap?.data ?? "",
        replayTruncated: snap?.truncated ?? false,
        replayBytes: snap?.bytes ?? 0,
      }),
    );
  }

  /** A client dropped: unregister it and cancel any agent sessions a REMOTE
   *  client owned (a remote agent run must not outlive its client). SHARED
   *  terminals are NOT torn down here — they're engine-owned and persist for the
   *  other devices (see the note at the end of this method). */
  private handleDisconnect(client: TransportClient): void {
    const owned = this.router.sessionsOwnedBy(client.id);
    const hostRelay = this.isHostRelayClient(client);
    // A remote client that drops must not leave its agent sessions running —
    // they'd keep streaming updates and raising permission prompts to nobody.
    // Local renderer disconnects are transient reloads, so we deliberately
    // DON'T cancel those: the reconnecting desktop re-adopts the session via
    // the local-host fallback in routeToSession.
    if (hostRelay) {
      for (const sessionId of owned) {
        const agentId = this.sessionAgent.get(sessionId);
        if (agentId) {
          // Deliberate engine-policy cancel — mark the intent so a turn torn
          // down by it records "cancelled", not "failed" (same race as the
          // user Stop button; see cancelRequested).
          this.markCancelIntent(sessionId);
          void this.agents.cancel(agentId, sessionId).catch(() => {});
        }
      }
    } else {
      // (#3) A LOCAL disconnect is almost always a renderer reload: reserve its
      // sessions briefly so a connected remote client can't adopt the still-running
      // agent before the desktop reconnects. Prune expired entries (bounds the
      // map; this is the only place that grows it).
      const now = Date.now();
      for (const sessionId of owned)
        this.recentlyLocalOwned.set(sessionId, now);
      for (const [sid, ts] of this.recentlyLocalOwned) {
        if (now - ts > LOCAL_REOWN_GRACE_MS)
          this.recentlyLocalOwned.delete(sid);
      }
    }
    // A local renderer is only the VIEW onto an engine-owned session. Preserve
    // session→agent identity across its reload so workspace cleanup, cancel,
    // and prompt re-adoption can still address the live adapter. Remote-owned
    // sessions are deliberately cancelled above, so their ownership metadata
    // can be released with that client.
    if (hostRelay) {
      for (const sessionId of owned) this.sessionAgent.delete(sessionId);
    }
    for (const [permissionId, owner] of this.permissionOwner) {
      if (owner === client.id) this.permissionOwner.delete(permissionId);
    }
    for (const [questionId, owner] of this.questionOwner) {
      if (owner === client.id) this.questionOwner.delete(questionId);
    }
    this.clientAccount.delete(client.id);
    this.clientTokenExp.delete(client.id);
    this.router.unregister(client.id);
    // NOTE: shared terminals deliberately PERSIST across a client disconnect.
    // They're engine-owned multiplayer resources — a relay disconnecting or
    // the desktop renderer reloading must NOT kill a shell another
    // device is still using (and the reattach snapshot restores it on
    // reconnect). Terminals end only on explicit PTY_KILL or engine shutdown
    // (killAllPty / killAll).
  }

  // ── Connection Handling ────────────────────────────────

  /** When a browser connects, send ENGINE_READY. */
  private async handleConnect(client: TransportClient): Promise<void> {
    console.log("[Zeros] Browser connected");

    // Don't leak the host's absolute project path to a remote client. ENGINE_READY
    // is sent on connect — BEFORE the account-binding gate runs on the later
    // CONNECTED frame — so a paired-but-unbound (ZEROS_REQUIRE_ACCOUNT=1) client
    // would otherwise receive the host path before the second factor. A remote
    // client operates via workspaceId and never needs the host path, so withhold
    // it; local (loopback) clients get it as before.
    client.send(
      createMessage({
        type: "ENGINE_READY",
        source: "engine",
        version: VERSION,
        root: client.kind === "local" ? this.root : "",
        framework: this.framework,
        port: this.actualPort,
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_SUPPORTED_PROTOCOL,
      }),
    );
  }

  // ── File Change Handling ───────────────────────────────

  private handleFileChange(
    filePath: string,
    type: string,
    fileType: "css" | "jsx" | "other",
  ): void {
    const relPath = path.relative(this.root, filePath);

    if (fileType === "css") {
      // The watcher keeps the CSS index fresh for the resolver and MCP
      // tools; it no longer broadcasts to the renderer (HMR is the dev
      // server's job, and no client consumed CSS_FILE_CHANGED).
      console.log(`[Zeros] CSS ${type}: ${relPath}`);
    }
  }

  // ── Busy marker (HMR-safe hot reload) ──────────────────
  //
  // The dev HMR watcher (apps/desktop/electron/sidecar.ts) respawns this engine on any
  // apps/desktop/src/engine change. Without coordination, a save mid-turn SIGTERMs the
  // engine and kills the in-flight agent response — the user sees "Agent is
  // responding…" forever with no reply (exactly the reported symptom). We
  // write `<root>/.zeros/.busy` while any AGENT_PROMPT is in flight,
  // heartbeated every 10s so a long turn stays "fresh" while a crashed
  // engine's marker goes stale; the watcher defers respawn until it clears
  // (capped, so hot-reload can never be blocked forever). Production builds
  // have no watcher, so this marker is simply ignored there.
  private activePrompts = 0;
  private busyHeartbeat: ReturnType<typeof setInterval> | null = null;

  private busyFilePath(): string {
    return path.join(engineRuntimeDir(this.root), "busy");
  }
  private enterPrompt(): void {
    this.activePrompts += 1;
    if (this.activePrompts === 1) {
      this.touchBusy();
      this.busyHeartbeat = setInterval(() => this.touchBusy(), 10_000);
      this.busyHeartbeat.unref?.();
    }
  }
  private exitPrompt(): void {
    this.activePrompts = Math.max(0, this.activePrompts - 1);
    if (this.activePrompts === 0) this.clearBusy();
  }
  private touchBusy(): void {
    try {
      const dir = engineRuntimeDir(this.root);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.busyFilePath(),
        String(this.activePrompts),
        "utf-8",
      );
    } catch {
      /* best-effort — the watcher's staleness + max-defer caps cover a miss */
    }
  }
  private clearBusy(): void {
    if (this.busyHeartbeat) {
      clearInterval(this.busyHeartbeat);
      this.busyHeartbeat = null;
    }
    try {
      const f = this.busyFilePath();
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  // ── Parent-death watchdog ──────────────────────────────
  //
  // When Electron dies without cleanly stopping the engine (crash, SIGKILL,
  // force-quit), the engine used to linger as an orphan until the NEXT app
  // launch reaped it (apps/desktop/electron/sidecar.ts orphan sweep). Self-exit instead:
  //
  //   1. stdin EOF — the engine's stdin is a pipe from Electron main (the
  //      host control channel); EOF means the parent is gone. Works on every
  //      platform, including Windows (where ppid goes stale, not reparented).
  //   2. ppid poll — on macOS/Linux an orphan is reparented (launchd/init),
  //      so `process.ppid` changing away from the spawning pid is definitive.
  //      Covers the case where some intermediary keeps the stdin pipe open.
  //
  // Armed ONLY when the host passes ZEROS_PARENT_PID (apps/desktop/electron/sidecar.ts).
  // Standalone `zeros serve` and cloud/CI runs don't set it — a supervisor
  // that spawns with stdin at /dev/null would otherwise see instant EOF and
  // the engine would kill itself at boot.
  private setupParentDeathWatchdog(): void {
    const raw = process.env.ZEROS_PARENT_PID?.trim();
    const parentPid = raw ? Number(raw) : NaN;
    if (!Number.isFinite(parentPid) || parentPid <= 0) return;

    const selfExit = (why: string): void => {
      if (this.parentDeathExiting) return;
      this.parentDeathExiting = true;
      console.log(`[Zeros] ${why} — engine self-exiting`);
      // Bounded graceful stop, mirroring cli.ts shutdown: a wedged adapter
      // dispose must not keep the orphan alive — that's the bug this fixes.
      void Promise.race([
        this.stop().catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ]).then(() => process.exit(0));
    };

    const stdin = process.stdin;
    if (stdin && !stdin.isTTY) {
      stdin.on("end", () => selfExit("host closed stdin (parent gone)"));
      stdin.on("close", () => selfExit("host stdin closed (parent gone)"));
    }
    this.parentWatchTimer = setInterval(() => {
      if (process.ppid !== parentPid) {
        selfExit(
          `parent process ${parentPid} is gone (ppid now ${process.ppid})`,
        );
      }
    }, 15_000);
    // Never let the watchdog itself keep an otherwise-drained process alive.
    this.parentWatchTimer.unref?.();
  }

  // ── Host control channel (stdin) ───────────────────────
  //
  // Only the PARENT process (Electron main) can write to this process's stdin,
  // so it's a trusted host→engine channel. Used to courier the GitHub token
  // without passing through the renderer. Attached only when stdin is a
  // pipe (the sidecar) — never an interactive TTY (`zeros serve` in a terminal),
  // where it would swallow keystrokes.
  private setupHostControlChannel(): void {
    const stdin = process.stdin;
    if (!stdin || stdin.isTTY) return;
    let buf = "";
    try {
      stdin.setEncoding("utf-8");
    } catch {
      return;
    }
    stdin.on("data", (chunk: string) => {
      buf += chunk;
      // Defensive cap: control lines are tiny; drop a runaway no-newline blob.
      if (buf.length > 1_000_000) buf = "";
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.handleHostControlLine(line);
        nl = buf.indexOf("\n");
      }
    });
    stdin.on("error", () => {
      /* parent gone — ignore */
    });
    stdin.resume();
  }

  /** Learn the login behind the credential the host just seeded.
   *
   *  `cachedGithubLogin()` is process-local and starts null on every engine
   *  boot. Workspace creation reads it to build a `branch_prefix_type =
   *  "github"` branch name and must not block on the network, so it takes
   *  whatever is cached. Without this prime the first workspace created after
   *  a relaunch silently fell back to the default `zeros/` prefix while
   *  Settings still showed "GitHub username (…)", and nothing said why.
   *
   *  It hangs off the SEED rather than off startup because the credential
   *  arrives asynchronously over stdin — a probe fired at boot would run
   *  before there is anything to probe. This is not auto-adoption: it reads
   *  the credential the host explicitly selected and writes no token.
   *  Fire-and-forget, so offline just leaves the fallback in place. */
  private primeGithubLogin(): void {
    void getAuthStatus().catch(() => {
      /* best-effort — a failed probe just leaves the prefix fallback */
    });
  }

  private handleHostControlLine(line: string): void {
    let msg: {
      type?: string;
      token?: string | null;
      method?: unknown;
      credential?: unknown;
      data?: unknown;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "host.githubToken") {
      seedGithubToken(typeof msg.token === "string" ? msg.token : null);
      this.primeGithubLogin();
      return;
    }
    if (msg.type === "host.githubCredential") {
      seedGithubCredential(
        msg.credential && typeof msg.credential === "object"
          ? (msg.credential as never)
          : null,
        msg.method === "gh-cli" ||
          msg.method === "github-app" ||
          msg.method === "pat"
          ? msg.method
          : null,
      );
      this.primeGithubLogin();
      return;
    }
    if (msg.type === MCP_VAULT_SEED_TYPE) {
      // The host's durable OAuth vault (safeStorage), pushed at boot. Apply now if
      // the vault exists; otherwise buffer until ensureMcpVault() creates it (the
      // seed can arrive before the gateway starts). Never echoed back — restore is
      // not a write (the host is already the source).
      const data: VaultSnapshot =
        msg.data && typeof msg.data === "object" && !Array.isArray(msg.data)
          ? (msg.data as VaultSnapshot)
          : {};
      if (this.mcpVault) this.mcpVault.restore(data);
      else this.mcpVaultSeed = data;
    }
  }

  // ── Port File ──────────────────────────────────────────

  private writePortFile(port: number): void {
    try {
      const dir = engineRuntimeDir(this.root);
      fs.mkdirSync(dir, { recursive: true });
      // The engine bootstrap manifest, in the app-data dir keyed per repo — NOT
      // `<root>/.zeros` in the served repo anymore. It contains discovery and
      // ownership metadata only. The loopback bearer deliberately never lands
      // on disk: Electron already owns it and gives it to the renderer over
      // trusted IPC, while coding agents must have no way to recover it.
      // `pid` lets a reader spot a dead engine; `root` is for reverse-lookup.
      const manifest = {
        pid: process.pid,
        port,
        // Bind the host's readiness/watchdog probes to THIS exact engine boot,
        // not merely to any process that returns `{status:"ok"}` on the port.
        instance: this.local.instanceNonce,
        protocolVersion: PROTOCOL_VERSION,
        root: this.root,
        startedAt: new Date().toISOString(),
      };
      fs.writeFileSync(
        path.join(dir, "engine.json"),
        JSON.stringify(manifest),
        {
          encoding: "utf-8",
          mode: 0o600,
        },
      );
    } catch (err) {
      console.error("[Zeros] Failed to write engine manifest:", err);
    }
    // One-time: clear the legacy runtime files this engine used to drop into the
    // served repo's `.zeros/`, so already-opened repos get cleaned up on boot.
    this.sweepLegacyDotZeros();
  }

  private removePortFile(): void {
    try {
      const manifest = path.join(engineRuntimeDir(this.root), "engine.json");
      if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
    } catch {
      // Ignore cleanup errors
    }
  }

  /** One-time migration of the legacy `<root>/.zeros/{.port,.token,.busy}` the
   *  engine used to write into the served repo. Removes ONLY those runtime files
   *  and rmdir's `.zeros` if nothing else remains — never `.zeros/attachments`
   *  (old chats still reference those paths; new ones go to `.context/`) nor a
   *  user-committed `setup.sh`. Best-effort; no-ops once the repo is clean. */
  private sweepLegacyDotZeros(): void {
    try {
      const legacy = path.join(this.root, ".zeros");
      if (!fs.existsSync(legacy)) return;
      for (const f of [".port", ".token", ".busy"]) {
        try {
          fs.unlinkSync(path.join(legacy, f));
        } catch {
          /* not present — fine */
        }
      }
      try {
        fs.rmdirSync(legacy); // succeeds only if now empty
      } catch {
        /* non-empty (attachments / setup.sh) or already gone — leave it */
      }
    } catch {
      /* best-effort */
    }
  }
}
