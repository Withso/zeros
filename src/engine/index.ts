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
import { CloudTransport } from "./transport/cloud";
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
import { dbChangedKinds, LONG_LIFECYCLE_OPS } from "./workspace/change-events";
import { PtyService } from "./pty/service";
import {
  createNodePtyShell,
  createTerminalMirror,
  disposePtyHost,
} from "./pty/node-pty-spawn";
import { disposeCursorHost } from "./agents/adapters/cursor-sdk/host/host-client";
import { getLoginShellPath } from "./agents/adapters/shared/login-shell-path";
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
import { getWorkspaceById } from "./git/state";
import { resolveRunActions } from "./settings/repo-scripts";
import {
  filterRunActionsForPlatform,
  normalizeRunPlatform,
  runActionOneShot,
  runSessionId,
} from "@zeros/core/run-actions";
import { detectGhCli, setTokenStore } from "./git/github";
import {
  engineGithubTokenStore,
  seedGithubToken,
  setGithubTokenChangeNotifier,
} from "./git/engine-token-store";
import { AgentGateway } from "./agents/gateway";
import { resolveMcpServers } from "./agents/mcp-registry";
import { McpGateway } from "./agents/gateway/server";
import { OAuthVault } from "./agents/gateway/oauth-provider";
import {
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
import { scrubError } from "@zeros/core/scrub";
import {
  PROTOCOL_VERSION,
  MIN_SUPPORTED_PROTOCOL,
  isCompatible,
} from "@zeros/core/version";
import type {
  SessionNotification,
  RequestPermissionRequest,
  QuestionOutcome,
  QuestionRequest,
  ContentBlock,
  TurnUsage,
} from "@zeros/core/agent-events";
import {
  applyUpdate,
  type AgentMessage,
  type AgentTextMessage,
} from "@zeros/core/agent-messages";
import {
  PTY_AGENT_AUTH_CWD,
  type AgentPromptBubble,
} from "@zeros/core/messages";
import { upsertChatMessagesBulk } from "./db/messages";
import {
  startTurn as startTurnRow,
  finishTurn as finishTurnRow,
  turnsWithSnapshotsBeyond,
  clearTurnSnapshots,
  type TurnFile,
} from "./db/turns";
import { getChatLocation } from "./db/chats";
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

const VERSION = "0.0.5";

/** Master switch for the Zeros design surface (CSS selector index, design MCP,
 *  canvas element-picker, apply-change). Currently OFF — the surface is being
 *  rebuilt in the Zeros CLI (see the disabled MCP block in `start()`). While it
 *  is off we skip the per-boot `cache.buildIndex()` walk, which globs + PostCSS-
 *  parses every CSS file in the repo for a feature nothing consumes — pure
 *  startup tax that scales with repo size and is paid on every (re)spawn. Flip
 *  to true alongside re-enabling the MCP to restore the index. */
const DESIGN_SURFACE_ENABLED = false;

/** A workspace op slower than this gets one log line naming it and its
 *  duration. Set above every ordinary read (a `git.status` fan-out on a large
 *  repo lands in the low hundreds of ms) so the log stays readable, and well
 *  below the host watchdog's ~15s kill window so anything that could plausibly
 *  cost the engine its life is on the record before it does. */
const SLOW_WORKSPACE_OP_MS = 2_000;

/** How long a session whose LOCAL owner just disconnected stays reserved for
 *  the desktop. A relay client may not ADOPT it during this window — it covers
 *  a renderer reload, where the agent keeps running but ownership is briefly
 *  cleared, so the reconnecting desktop wins the re-adopt over a connected
 *  relay. */
const LOCAL_REOWN_GRACE_MS = 30_000;

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
}

/** Expected, user-correctable git/workspace outcomes — control flow, not bugs.
 *  Kept OUT of error tracking (they'd be noise); they still surface in the
 *  renderer's `git_op` analytics funnel as error outcomes. See reportEngineError. */
const EXPECTED_ENGINE_ERROR_CODES = new Set<string>([
  "VALIDATION_FAILED",
  "BRANCH_IN_USE",
  "NOT_AUTHENTICATED",
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
  /** The local MCP gateway (auth:"oauth" backends fronted on localhost). Lazily
   *  started when the user-level settings declare a gateway-managed server. */
  private mcpGateway: McpGateway | null = null;
  /** Why the gateway isn't running when it should be (start/reload failure, e.g.
   *  the port is taken) — surfaced via mcp.gateway.status so the UI shows
   *  "Gateway unavailable" instead of an OAuth server silently vanishing (P0-3).
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
  /** Per-launch secret the local renderer presents on the /ws upgrade (C1). */
  private readonly localToken: string;
  /** The in-sandbox 0.0.0.0 bridge (Phase 1 spike). Null in the local build —
   *  only constructed when ZEROS_CLOUD_PORT is set. */
  private cloud: CloudTransport | null = null;
  private transports: Transport[] = [];
  private readonly router = new MessageRouter();
  private workspace!: WorkspaceService;
  private pty!: PtyService;
  private setup!: SetupManager;
  private runs!: RunManager;
  /** Shared multiplayer terminals (Paseo model): a PTY is an engine-owned shared
   *  resource, NOT owned by one client. Every paired device may attach to, watch,
   *  and drive the SAME terminal; the only gate is the per-workspace remote
   *  restriction. Terminals PERSIST across client disconnects (a phone dropping
   *  must not kill the Mac's shell). Replaces the old exclusive ptyOwner map. */
  private readonly terminals = new TerminalRegistry();
  /** PTY sessionIds currently being EXPLICITLY closed (a client sent PTY_KILL).
   *  Lets onExit tell an explicit close (remove the terminal everywhere) apart
   *  from a natural shell exit (keep it as "(exited)", restartable). */
  private readonly explicitlyClosing = new Set<string>();
  /** Agent sessionId → agentId, so a disconnecting client's owned sessions can
   *  be cancelled (a remote client must not leave an agent running). */
  private readonly sessionAgent = new Map<string, string>();
  /** Agent sessionId → renderer chatId (Phase 2b). Lets the persist hook write
   *  the transcript by chatId as the engine streams. Kept while the session
   *  LIVES (survives a client reload so persistence continues); cleared on
   *  explicit AGENT_CLOSE_SESSION. */
  private readonly sessionChat = new Map<string, string>();
  /** Agent sessionId → its workspaceId. Lets the engine withhold a session in a
   *  remote-RESTRICTED workspace from relay devices (H2/M2): its stream +
   *  permission prompts go to LOCAL clients only, and a relay client may not act
   *  on it. Empty for sessions with no managed workspace (never restricted). */
  private readonly sessionWorkspace = new Map<string, string>();
  /** Agent sessionIds with a `prompt()` currently in flight. Lets turns.reset
   *  cancel a live turn ENGINE-side before truncating the timeline it streams
   *  into (the renderer's footer does the same, but a reset arriving from any
   *  other device/caller must not race a live stream into zombie rows). */
  private readonly promptSessions = new Set<string>();
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
  /** Agent sessionId → ms timestamp when its LOCAL owner last disconnected.
   *  Within LOCAL_REOWN_GRACE_MS a relay client may not adopt the session. */
  private readonly recentlyLocalOwned = new Map<string, number>();
  /** Account-binding config (null = off / pairing-only). Built from env once. */
  private readonly accountAuth: AccountAuth | null = buildAccountAuthFromEnv();
  /** clientId → verified account user id (for audit / multi-device identity). */
  private readonly clientAccount = new Map<string, string>();
  /** clientId → the bound token's `exp` (unix seconds). M1: a relay session must
   *  not outlive the token it bound with — a periodic sweep demotes any client
   *  whose token has expired, forcing a re-auth with a fresh token. */
  private readonly clientTokenExp = new Map<string, number>();
  /** Periodic re-verification sweep (M1). Lazily started on the first relay
   *  bind; cleared in stop(). */
  private bindingSweep: ReturnType<typeof setInterval> | null = null;
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

    // Initialize components
    this.cache = new EngineCache(this.root);
    this.workspace = new WorkspaceService(this.root);
    // Let the mcp.gateway.* ops reach the (lazily-created) gateway instance.
    this.workspace.setGatewayAccessor(() => this.mcpGateway);
    this.workspace.setGatewayErrorAccessor(() => this.gatewayError);
    this.workspace.setGatewayHeaderSecretSetter((url, name, value) =>
      this.setMcpHeaderSecret(url, name, value),
    );
    this.pty = new PtyService(
      this.root,
      createNodePtyShell,
      createTerminalMirror,
    );
    // Warm the login-shell PATH probe (`$SHELL -ilc 'echo $PATH'`) now, off the
    // critical path. It's cached process-wide and every one-shot command shell
    // — Setup script, Run action — awaits it before spawning; resolving it here
    // keeps that from showing up as a stall on the FIRST Run of a session.
    // Fire-and-forget: the resolver already falls back to the inherited PATH.
    void getLoginShellPath().catch(() => {
      /* probe failures are handled inside the resolver */
    });
    // Background setup runner (Setup tab): owns the worktree setup PTY, buffers
    // its output, and flips workspaces.setup_state on exit. It rides the same
    // pty.onData/onExit callbacks below (setup sessions are id-prefixed "setup:").
    this.setup = new SetupManager(this.pty, (workspaceId) =>
      this.broadcast(
        createMessage({
          type: "DB_CHANGED",
          source: "engine",
          kinds: ["workspaces"],
          ...(workspaceId ? { workspaceIds: [workspaceId] } : {}),
        }),
      ),
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
          if (boundWorkspaceId === workspaceId) agentSessionIds.add(sessionId);
        }
        for (const [sessionId, chatId] of this.sessionChat) {
          const folder = getChatLocation(chatId)?.folder;
          if (folder && isUnderRoot(folder)) {
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
                  .endSession(agentId, sessionId)
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
          this.router.clearOwner(sessionId);
          this.sessionAgent.delete(sessionId);
          this.sessionMessages.delete(sessionId);
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
          .filter((session) => isUnderRoot(session.cwd))
          .map((session) => session.sessionId);
        // Register exit observers BEFORE the managers call kill(); a fast process
        // can otherwise exit between kill and waiter registration.
        const exitWaits = ptyIds.map((sessionId) =>
          this.pty.waitForExit(sessionId),
        );
        this.setup.stop(workspaceId);
        this.runs.stopAllForWorkspace(workspaceId);
        const terminalIds = new Set(
          this.terminals.idsUnderFolder(worktreePath),
        );
        for (const sessionId of terminalIds) {
          this.explicitlyClosing.add(sessionId);
          this.pty.kill(sessionId);
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
    // LOCAL-ONLY (not on any remote allowlist).
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
    this.workspace.setRunStopper((sessionId) => this.runs.stop(sessionId));
    this.workspace.setRunInfoGetter((sessionIds, workspaceId) =>
      this.runs.info(sessionIds, workspaceId),
    );
    this.workspace.setRunLogGetter((sessionId) => this.runs.log(sessionId));
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
    // C1: the loopback WS authenticates with a per-launch token (supplied by the
    // Electron host via ZEROS_LOCAL_WS_TOKEN, or self-minted for a standalone
    // engine and written to `.zeros/.token`). Combined with an Origin allowlist,
    // this stops any website the user visits from driving the engine as a
    // trusted "local" client. The dev renderer's http origin is allowlisted; the
    // packaged renderer loads file:// (always allowed).
    this.localToken =
      process.env.ZEROS_LOCAL_WS_TOKEN?.trim() ||
      randomBytes(32).toString("hex");
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
    });
    this.transports = [this.local];

    // Cloud transport (Phase 1 spike): when the engine runs inside a remote
    // sandbox the bootstrap sets ZEROS_CLOUD_PORT, and we add a SECOND transport
    // that binds 0.0.0.0 on that port so the Mac renderer can reach it over the
    // sandbox's public preview-URL WSS. It is a separate transport — LocalTransport's
    // loopback gate is untouched (do NOT relax it; see transport/cloud.ts). Inert
    // in the local desktop build (the env var is unset). Per-user JWT auth lands
    // in Phase 2; today a cloud peer is ungated exactly like local while
    // `accountAuth` is unset (the spike runs without account-binding env).
    const cloudPort = Number(process.env.ZEROS_CLOUD_PORT);
    if (Number.isInteger(cloudPort) && cloudPort > 0) {
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
        void this.handleMessage(msg, client).catch((err) => {
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
      events: {
        onSessionUpdate: (
          agentId: string,
          notification: SessionNotification,
        ) => {
          // Route the stream to the client that owns this session — not every
          // device. (Falls back to broadcast for an unowned session.)
          const sessionId = notification.sessionId;
          this.routeSessionScoped(
            sessionId,
            createMessage({
              type: "AGENT_SESSION_UPDATE",
              source: "engine",
              agentId,
              notification: notification as never,
              // Engine-authoritative routing: stamp the chat this session is
              // bound to so the renderer never drops an update on a stale
              // sessionId index (force-respawn / create-load / an adapter that
              // emits before the renderer has stored the sessionId). Same map
              // persistSessionUpdate uses below.
              ...(this.sessionChat.get(sessionId)
                ? { chatId: this.sessionChat.get(sessionId) }
                : {}),
            }),
          );
          // Phase 2b — persist the transcript as it streams (engine is the source).
          this.persistSessionUpdate(sessionId, notification);
        },
        onPermissionRequest: (
          agentId: string,
          permissionId: string,
          request: RequestPermissionRequest,
        ) => {
          const sessionId = request.sessionId;
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
        onQuestionRequest: (
          agentId: string,
          questionId: string,
          request: QuestionRequest,
        ) => {
          const sessionId = request.sessionId;
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
          // The engine resolver is gone (timeout / abort / answered elsewhere) —
          // any late AGENT_QUESTION_RESPONSE for this id is a no-op, so the
          // owner entry is dead weight either way.
          this.questionOwner.delete(questionId);
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
          this.broadcast(
            createMessage({
              type: "AGENT_AGENT_EXITED",
              source: "engine",
              agentId,
              sessionId: sessionId ?? null,
              code,
              signal: signal ? String(signal) : null,
            }),
          );
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
   *  engine restart (P0-1). One vault for the whole process: a gateway stop/start
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
   *  dedicated control fd (ZEROS_CONTROL_FD) — a private host↔engine pipe the host
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

    // 1. Detect framework
    const detection = detectFramework(this.root);
    this.framework = detection.framework;

    console.log(`[Zeros] Framework: ${this.framework}`);
    // Make the resolved release channel VISIBLE at every boot. A misconfigured
    // launch (for example, Beta resolving as Stable and taking Stable's engine
    // block/data dirs) shows up here instead of as mysterious cross-channel
    // contamination. See src/engine/runtime.ts. The channel + base port are
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

    // Boot-time session housekeeping. Fire-and-forget — must never block
    // startup. GC session dirs orphaned by a prior crash — runs before any
    // session is created this run, so it only ever sees prior-run dirs.
    void (async () => {
      try {
        const { sweepDeadSessions } = await import("./agents/session-paths");
        const swept = await sweepDeadSessions();
        if (swept > 0)
          console.log(`[Zeros] swept ${swept} crashed session dir(s)`);
      } catch {
        /* best-effort */
      }
    })();

    // GitHub token (option B). The engine can't read Electron safeStorage (where
    // the OAuth token is encrypted at rest), so it reads an in-memory working
    // copy the host pushes over the bridge (GITHUB_TOKEN_SET). Wire that store +
    // a notifier that mirrors an engine-originated change (today only the 401
    // auto-clear inside a PR op) back to the host so safeStorage stays in sync —
    // via broadcastLocal, so a relay device never receives the token value.
    setTokenStore(engineGithubTokenStore);
    setGithubTokenChangeNotifier((token) =>
      this.router.broadcastLocal(
        createMessage({
          type: "GITHUB_TOKEN_CHANGED",
          source: "engine",
          token,
        }),
      ),
    );

    // H4: the host couriers the GitHub OAuth token DIRECTLY to the engine —
    // never through the renderer, where an XSS could read it. It arrives two
    // ways: ZEROS_GITHUB_TOKEN in the spawn env (token present at launch) and a
    // newline-delimited control line on stdin (a mid-session sign-in/out). Both
    // seed the in-memory copy only. The legacy renderer GITHUB_TOKEN_SET path
    // still works for non-Electron hosts but the Mac app no longer uses it.
    if (process.env.ZEROS_GITHUB_TOKEN !== undefined) {
      seedGithubToken(process.env.ZEROS_GITHUB_TOKEN || null);
    }
    // Zero-config GitHub auth: when the host couriered NO token (fresh
    // install / the user never opened Settings → GitHub), adopt the gh CLI's
    // login — the same "primary auth path" the Settings GitHub section runs
    // on mount. Without this, gh.prSync silently no-ops (NOT_AUTHENTICATED
    // is swallowed) while the AGENT's own `gh` works fine — so a PR the
    // agent creates never surfaces in the app: no PR-status island, no
    // "PR #N" pill, and the topbar keeps showing "Create PR". Fire-and-
    // forget + best-effort: no gh binary / not logged in leaves the engine
    // unauthenticated exactly as before.
    void (async () => {
      try {
        if ((await engineGithubTokenStore.get()) === null) {
          const r = await detectGhCli();
          if (r.authenticated)
            console.log(
              `[Zeros] adopted gh CLI GitHub auth (${r.login ?? "unknown"})`,
            );
        }
      } catch {
        /* best-effort */
      }
    })();
    this.setupHostControlChannel();
    this.setupParentDeathWatchdog();

    // 1a. One-time fold-in of the legacy ~/.zeros/state.db (workspaces + meta +
    // detach_state) into the unified zeros.db (Phase 0). Runs BEFORE seedFromDisk
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
      const result = await reconcileInterruptedWorkspaceLifecycles();
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
    // to the visible ~/zeros/workspaces (Phase 0). Runs at startup BEFORE any
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
    // already exist and seeds lacking a repoRoot/branch (C9). Only worktrees
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
    // (zeros-agent-history.db) into the unified Zeros DB (Phase 2c). Idempotent +
    // best-effort; reads the legacy file READ-ONLY and never deletes it, so it
    // remains a recovery net even after electron/db.ts is removed. No-op without
    // ZEROS_LEGACY_AGENT_DB (web / cloud / standalone engine).
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

    // 2. Build CSS selector index — DEFERRED while the design surface is off
    // (DESIGN_SURFACE_ENABLED). The index feeds ONLY the design MCP + canvas
    // (disabled at step 4); building it every boot walks the repo and parses
    // every CSS file for a feature nothing consumes. Skip it until the surface
    // returns — stats() then reports zeros, which the info provider + log
    // tolerate (the resolver/writer build lazily off the same cache when used).
    if (DESIGN_SURFACE_ENABLED) {
      await this.cache.buildIndex();
      const stats = this.cache.stats();
      console.log(
        `[Zeros] Index built: ${stats.selectors} selectors, ${stats.files} files, ${stats.tokens} tokens`,
      );
    }

    // 3. Start HTTP + WebSocket server (loopback transport)
    await this.local.start();
    this.actualPort = this.local.actualPort;

    // MCP gateway (Phase 2): front any auth:"oauth" backends on a localhost
    // endpoint + inject that one server into every agent. Best-effort — a
    // gateway failure must never block engine boot.
    await this.startGateway();

    // 4. Start file watcher — gated on the design surface (it feeds ONLY the
    //    design index/canvas, which is disabled), so starting it otherwise
    //    just burns per-save globbing that nothing reads.
    if (DESIGN_SURFACE_ENABLED) {
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

    if (this.bindingSweep) {
      clearInterval(this.bindingSweep);
      this.bindingSweep = null;
    }
    if (this.parentWatchTimer) {
      clearInterval(this.parentWatchTimer);
      this.parentWatchTimer = null;
    }
    await this.agents.dispose();
    if (this.vaultPersistTimer) {
      // Flush a pending debounced persist so a clean stop never drops a token.
      clearTimeout(this.vaultPersistTimer);
      this.vaultPersistTimer = null;
      this.flushVaultPersist();
    }
    if (this.mcpGateway) {
      try {
        await this.mcpGateway.stop();
      } catch (err) {
        console.warn(
          "[Zeros] MCP gateway stop error:",
          err instanceof Error ? err.message : err,
        );
      }
      this.mcpGateway = null;
    }
    this.pty.killAll();
    // Tear down the out-of-process Node hosts (PTY shells + the @cursor/sdk
    // host) so neither lingers as an orphan after the engine stops.
    disposePtyHost();
    disposeCursorHost();
    this.terminals.clear();
    await this.watcher.stop();
    this.settingsWatcher?.stop();
    this.settingsWatcher = null;
    await this.gitWatcher?.stop();
    this.gitWatcher = null;
    for (const t of this.transports) await t.stop();
    this.removePortFile();
    this.clearBusy();

    console.log("[Zeros] Engine stopped");
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
    return null;
  }

  private workspaceAllowsProcessStart(
    workspaceId: string | null | undefined,
  ): boolean {
    return this.workspaceProcessStartBlock(workspaceId) == null;
  }

  private assertWorkspaceProcessStartAllowed(
    workspaceId: string | null | undefined,
  ): void {
    const message = this.workspaceProcessStartBlock(workspaceId);
    if (!message) return;
    throw new GitError({
      code: "VALIDATION_FAILED",
      message,
      remediation:
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
        if (client.kind === "local") seedGithubToken(msg.token);
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
          isRemote: client.kind !== "local",
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
    // Diagnostic: log every AGENT_* message at the dispatch boundary so
    // we can tell from main.log whether prompts are even reaching the
    // engine. Used to triage "user sent codex prompt, no response" —
    // without this the only visible log was occasional adapter creation,
    // and any "request never made it to the engine" bug was invisible.
    {
      const requestId = (msg as { id?: string }).id;
      const agentId = (msg as { agentId?: string }).agentId;
      const sessionId = (msg as { sessionId?: string }).sessionId;
      console.log(
        `[agents] dispatch ${msg.type}` +
          (agentId ? ` agent=${agentId}` : "") +
          (sessionId ? ` session=${sessionId.slice(0, 8)}…` : "") +
          (requestId ? ` reqId=${requestId.slice(0, 8)}…` : ""),
      );
    }
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
            env: msg.env,
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
          const spawnOpts = this.agentSpawnOpts(msg, client, "newSession");
          const lifecycleWorkspaceId = this.workspaceIdForProcess(
            spawnOpts.workspaceId,
            spawnOpts.cwd,
          );
          this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          const { initialize, session } = await this.trackWorkspaceProcessStart(
            lifecycleWorkspaceId,
            (async () => {
              const initialize = await this.agents.ensureAgent(msg.agentId, {
                env: spawnOpts.env,
              });
              // ensureAgent may spawn/initialize asynchronously. Re-check
              // before the workspace-scoped session itself is created.
              this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
              const session = await this.agents.newSession(msg.agentId, {
                cwd: spawnOpts.cwd,
                env: spawnOpts.env,
                workspaceId: spawnOpts.workspaceId,
                cliBinary: spawnOpts.cliBinary,
              });
              // Publish ownership before the tracked promise resolves so a
              // concurrently-starting reaper can discover and dispose it.
              this.router.setOwner(session.sessionId, client.id);
              this.sessionAgent.set(session.sessionId, msg.agentId);
              if (msg.chatId)
                this.sessionChat.set(session.sessionId, msg.chatId);
              if (lifecycleWorkspaceId) {
                this.sessionWorkspace.set(
                  session.sessionId,
                  lifecycleWorkspaceId,
                );
              }
              try {
                this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
              } catch (err) {
                // The lifecycle acquired ownership while newSession was
                // awaiting the adapter. Dispose before releasing the start
                // barrier so cleanup never misses this late session.
                await this.agents
                  .endSession(msg.agentId, session.sessionId)
                  .catch(() => {});
                this.router.clearOwner(session.sessionId);
                this.sessionAgent.delete(session.sessionId);
                this.sessionChat.delete(session.sessionId);
                this.sessionWorkspace.delete(session.sessionId);
                this.sessionMessages.delete(session.sessionId);
                throw err;
              }
              return { initialize, session };
            })(),
          );
          this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
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
                priorSessionId !== session.sessionId
              )
                superseded.push(priorSessionId);
            }
            for (const priorSessionId of superseded) {
              const priorAgentId =
                this.sessionAgent.get(priorSessionId) ?? msg.agentId;
              this.router.clearOwner(priorSessionId);
              this.sessionAgent.delete(priorSessionId);
              this.sessionChat.delete(priorSessionId);
              this.sessionWorkspace.delete(priorSessionId);
              this.sessionMessages.delete(priorSessionId);
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
          const lifecycleWorkspaceId = this.workspaceIdForAgentSession(
            msg.sessionId,
          );
          this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          this.router.setOwner(msg.sessionId, client.id);
          this.sessionAgent.set(msg.sessionId, msg.agentId);
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
            this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
            this.enterPrompt();
            this.promptSessions.add(msg.sessionId);
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
            throw err;
          } finally {
            releasePromptStart();
            void promptStartSettled;
          }
          // A cancel intent recorded before this turn began belongs to a
          // PREVIOUS turn — drop it so it can't mislabel this one.
          this.cancelRequested.delete(msg.sessionId);
          try {
            const response = await this.agents.prompt(
              msg.agentId,
              msg.sessionId,
              msg.prompt,
            );
            if (turnCtx) {
              await this.finishTurn(
                turnCtx,
                response.stopReason === "cancelled" ? "cancelled" : "completed",
                response.stopReason ?? null,
                response.usage ?? null,
              );
            }
            client.send(
              createMessage({
                type: "AGENT_PROMPT_COMPLETE",
                source: "engine",
                requestId: msg.id,
                agentId: msg.agentId,
                sessionId: msg.sessionId,
                stopReason: response.stopReason,
                response,
              }),
            );
          } catch (err) {
            if (turnCtx) {
              // A user cancel can surface as a rejection instead of a clean
              // stopReason:"cancelled" (e.g. the SIGTERM'd subprocess tears
              // the stream down before the adapter can settle the turn).
              // Record what the user DID — cancelled — so a reloaded chat
              // shows STOPPED BY USER, not AGENT STOPPED.
              const wasCancelled = this.cancelRequested.has(msg.sessionId);
              await this.finishTurn(
                turnCtx,
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
                sessionId: msg.sessionId,
                error: err instanceof Error ? err.message : String(err),
                failure,
              }),
            );
          } finally {
            this.promptSessions.delete(msg.sessionId);
            this.cancelRequested.delete(msg.sessionId);
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
          this.cancelRequested.add(msg.sessionId);
          await this.agents.cancel(msg.agentId, msg.sessionId);
          return;
        }
        case "AGENT_STEER": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, true)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          this.assertWorkspaceProcessStartAllowed(
            this.workspaceIdForAgentSession(msg.sessionId),
          );
          // Deliver FIRST, persist after: if the adapter refuses (no turn in
          // flight, non-steerable turn, old codex CLI), the message stays
          // queued client-side and must NOT appear in the transcript. No
          // beginTurn/enterPrompt — the steered input rides the in-flight
          // AGENT_PROMPT's turn, which is still awaited above.
          await this.agents.steer(msg.agentId, msg.sessionId, msg.prompt);
          this.persistSteeredUserPrompt(
            msg.sessionId,
            msg.prompt,
            msg.bubble,
            msg.userMessageId,
          );
          client.send(
            createMessage({
              type: "AGENT_STEERED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              sessionId: msg.sessionId,
            }),
          );
          return;
        }
        case "AGENT_CLOSE_SESSION": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, false)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          // Fire-and-forget teardown of a closed chat's engine resources.
          this.router.clearOwner(msg.sessionId);
          this.sessionAgent.delete(msg.sessionId);
          this.sessionChat.delete(msg.sessionId);
          this.sessionWorkspace.delete(msg.sessionId);
          this.sessionMessages.delete(msg.sessionId);
          await this.agents.endSession(msg.agentId, msg.sessionId);
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
          client.send(
            createMessage({
              type: "AGENT_MODE_CHANGED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
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
          // §3.5 Task A — real compaction (Codex thread/compact/start).
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
            client.kind === "local"
              ? msg.env
              : this.scrubRelayUpdateConfigEnv(msg.env);
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
        case "AGENT_LOAD_SESSION": {
          if (this.remoteMayNotActOnSession(msg.sessionId, client, true)) {
            this.refuseSessionAccess(msg.id, msg.agentId, client);
            return;
          }
          const loadOpts = this.agentSpawnOpts(msg, client, "loadSession");
          const lifecycleWorkspaceId = this.workspaceIdForProcess(
            loadOpts.workspaceId,
            loadOpts.cwd,
          );
          this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          this.router.setOwner(msg.sessionId, client.id);
          this.sessionAgent.set(msg.sessionId, msg.agentId);
          if (msg.chatId) this.sessionChat.set(msg.sessionId, msg.chatId);
          if (lifecycleWorkspaceId) {
            this.sessionWorkspace.set(msg.sessionId, lifecycleWorkspaceId);
          }
          const response = await this.trackWorkspaceProcessStart(
            lifecycleWorkspaceId,
            (async () => {
              const response = await this.agents.loadSession(
                msg.agentId,
                msg.sessionId,
                {
                  cwd: loadOpts.cwd,
                  env: loadOpts.env,
                  workspaceId: loadOpts.workspaceId,
                  cliBinary: loadOpts.cliBinary,
                },
              );
              this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
              return response;
            })(),
          );
          this.assertWorkspaceProcessStartAllowed(lifecycleWorkspaceId);
          client.send(
            createMessage({
              type: "AGENT_SESSION_LOADED",
              source: "engine",
              requestId: msg.id,
              agentId: msg.agentId,
              sessionId: msg.sessionId,
              response,
            }),
          );
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
    }
  }

  /** Resolve the spawn inputs for an agent session, enforcing the remote
   *  trust boundary. A LOCAL (desktop) client is trusted and keeps full
   *  control of cwd/env/cliBinary. A REMOTE (relay) client is UNTRUSTED, so:
   *   - its cwd is resolved SERVER-SIDE from a managed `workspaceId` (Phase 5
   *     invariant — a raw client path is never trusted) and clamped to the
   *     same allowlist the PTY uses (engine root + managed worktrees);
   *   - the client-supplied `env` is dropped so it cannot inject PATH /
   *     LD_PRELOAD to hijack the spawn — the agent inherits the host env;
   *   - the client-supplied `cliBinary` override is dropped so it cannot point
   *     the spawn at an arbitrary executable (RCE) — the registry default wins.
   *  Mirrors the PTY clamp + env-scrub. Throws AgentFailureError (→ AGENT_ERROR)
   *  when a remote client names no resolvable managed workspace. The agent's
   *  own tool calls remain gated by the per-action permission flow (routed to
   *  the owning client), so within the workspace the remote operator keeps the
   *  intended "control your agent from your phone" parity. */
  private agentSpawnOpts(
    msg: {
      cwd?: string;
      env?: Record<string, string>;
      workspaceId?: string;
      cliBinary?: string;
    },
    client: TransportClient,
    stage: "newSession" | "loadSession",
  ): {
    cwd?: string;
    env?: Record<string, string>;
    workspaceId?: string;
    cliBinary?: string;
  } {
    if (client.kind === "local") {
      return {
        cwd: msg.cwd,
        env: msg.env,
        workspaceId: msg.workspaceId,
        cliBinary: msg.cliBinary,
      };
    }
    // Remote (untrusted): never trust a client-supplied cwd / env / cliBinary.
    if (!msg.workspaceId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message:
          "Remote agent sessions must target a managed workspace " +
          "(workspaceId); a raw folder path is not accepted from a remote client.",
        stage,
      });
    }
    // M2: a workspace the owner restricted from remote is non-operable — refuse
    // to spawn OR resume any agent session there. This is the durable choke point
    // (it runs for new AND load, before the session exists), so a relay device
    // can never get a restricted session into a runnable state; combined with the
    // chat-list redaction it also can't discover one. Fails closed.
    if (listRemoteRestrictedWorkspaceIds().has(msg.workspaceId)) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: "This workspace is restricted from remote access.",
        stage,
      });
    }
    // Server-side resolution (throws GitError for an unknown id) + allowlist
    // clamp — the resolved path is the engine root or a managed worktree, both
    // inside the PTY allowlist; reject anything else (fails closed).
    const cwd = this.workspace.resolveCwd(msg.workspaceId);
    if (!this.pty.isWithinAllowed(cwd)) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `Remote agent cwd is outside the managed-workspace allowlist.`,
        stage,
      });
    }
    return {
      cwd,
      env: undefined,
      workspaceId: msg.workspaceId,
      cliBinary: undefined,
    };
  }

  /** Sanitize a relay (untrusted) client's AGENT_UPDATE_CONFIG env before it
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
      "ANTHROPIC_MODEL",
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
        let parsed: unknown;
        try {
          parsed = JSON.parse(value);
        } catch {
          continue;
        }
        const clamped = Array.isArray(parsed)
          ? parsed.filter(
              (d): d is string =>
                typeof d === "string" && this.pty.isWithinAllowed(d),
            )
          : [];
        if (clamped.length > 0) out[name] = JSON.stringify(clamped);
        continue;
      }
      // Everything else is dropped by default.
    }
    return out;
  }

  // ── Transcripts (Phase 2b: engine-persists-on-emit) ─────

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
    const live = [...new Set(sessionIds)].filter((sessionId) =>
      this.promptSessions.has(sessionId),
    );
    if (live.length === 0) return true;
    await Promise.all(
      live.map(async (sessionId) => {
        const agentId = this.sessionAgent.get(sessionId);
        if (!agentId) return;
        // Record the intent first so the settling turn row reads "cancelled"
        // (STOPPED BY USER), not "failed" — mirrors the AGENT_CANCEL handler.
        this.cancelRequested.add(sessionId);
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
      live.some((sessionId) => this.promptSessions.has(sessionId)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return live.every((sessionId) => !this.promptSessions.has(sessionId));
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
    // §3.6 R6 — the turn's token/cost usage from the adapter's PromptResponse;
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

    // Deny-by-default for remote clients: an op must be on the explicit allowlist
    // (an allowed remote read, a known repo write — restriction-gated below — or a
    // permitted chat/transcript metadata mutation). Any other op (incl. an
    // unknown/future one, or a read not yet opened to the web) is refused before
    // it can reach a handler. LOCAL desktop clients are never gated here — their
    // behavior is byte-identical to before.
    if (client.kind !== "local" && !this.workspace.isRemoteAllowed(op)) {
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

    if (this.workspace.isWriteOp(op) && client.kind !== "local") {
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
      const operation = this.workspace.handle(op, params, {
        remote: client.kind !== "local",
      });
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
      // Kick off BACKGROUND setup for a freshly-created LOCAL workspace: the
      // worktree already exists (create returned), so a slow `pnpm install` runs
      // in a PTY surfaced by the Setup tab — never on the create RPC. A remote
      // create never carries a setupCommand (host-shell gate, C1), and we only
      // start it for local clients as defence in depth.
      if (op === "workspace.create" && client.kind === "local") {
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
      // Cross-device live sync (Phase 3): tell the OTHER clients a list changed
      // so they refetch. The originator already has the change locally — EXCEPT
      // for the long worktree lifecycle ops (create/restore/archive/…), whose
      // RPC can outlive the renderer's request budget: the engine finishes and
      // the row is real, but the originator's promise already rejected with
      // "Request timeout", so it never learned about the change. Those ops
      // broadcast to EVERYONE (a refetch is idempotent + cheap for the
      // originator on the happy path) so a timed-out creator still sees the
      // workspace appear instead of a phantom that only shows after a restart.
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
        if (LONG_LIFECYCLE_OPS.has(op)) {
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

  private remoteMayNotActOnSession(
    sessionId: string,
    client: TransportClient,
    allowAdopt: boolean,
  ): boolean {
    void allowAdopt;
    // Local desktop is always allowed; remote clients are refused only for a
    // session whose workspace the owner restricted from remote (M2).
    return (
      client.kind !== "local" && this.sessionRestrictedFromRemote(sessionId)
    );
  }

  /** Route a session-scoped push (agent stream / permission prompt) honoring the
   *  per-workspace remote restriction (H2). A restricted session goes to LOCAL
   *  clients only — its transcript + tool output must never reach a remote client.
   *  Everything else broadcasts to all connected clients (multiplayer). */
  private routeSessionScoped(sessionId: string, msg: EngineMessage): void {
    if (this.sessionRestrictedFromRemote(sessionId)) {
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

  /** M1: demote any remote client (relay or cloud) whose bound token has expired,
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

  /** Lazily start the M1 re-verification sweep on the first remote bind. unref so
   *  it never keeps the process alive; cleared in stop(). */
  private ensureBindingSweep(): void {
    if (this.bindingSweep) return;
    this.bindingSweep = setInterval(() => this.sweepExpiredBindings(), 60_000);
    this.bindingSweep.unref?.();
  }

  // ── Terminal (PTY) ─────────────────────────────────────

  /** Whether `client` may drive a SHARED terminal (write/resize/kill). The local
   *  desktop is the trusted operator and may always act; a remote client may act
   *  only on a terminal in a KNOWN, non-restricted workspace (fail-closed). */
  private mayOperateTerminal(
    client: TransportClient,
    sessionId: string,
  ): boolean {
    if (client.kind === "local") return true;
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
    // yet; they're gated below by the M4 cwd check + the restriction approval.)
    if (reattach && !this.mayOperateTerminal(client, msg.sessionId)) {
      ptyExit();
      return;
    }
    // Resolve the canonical managed workspace id for this terminal — from an
    // explicit workspaceId if sent, else from the cwd token (which may be a
    // workspace ID or a real host PATH). Drives the restriction gate + the shared
    // registry for both local (cwd is always a path) and remote (id or path).
    const canonicalWsId =
      (reattach ? this.terminals.get(msg.sessionId)?.workspaceId : null) ??
      this.workspace.workspaceIdForCwd(msg.workspaceId) ??
      this.workspace.workspaceIdForCwd(msg.cwd);

    let cwdInput = msg.cwd;
    if (client.kind !== "local" && !reattach) {
      // The app-owned authentication cwd is intentionally host-local. Never
      // let a relay client use the token to bypass managed-workspace scoping.
      if (msg.cwd === PTY_AGENT_AUTH_CWD) {
        ptyExit();
        return;
      }
      // M4 (fail-closed): a new remote terminal must resolve to a known managed
      // workspace dir inside the PTY allowlist — never a shell at the engine root
      // from a bogus cwd. msg.cwd may be a workspace ID (resolveCwd maps it) OR a
      // real workspace PATH (relaxed redaction sends real paths) — accept either,
      // then clamp to the allowlist. (A reattach reuses the existing, already-
      // validated pty and ignores cwd, so it skips this; the restriction list is
      // still enforced for both by authorizeRemoteWrite below.)
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
    const resolvedCwd = this.pty.resolveCwd(cwdInput);

    if (client.kind !== "local") {
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
    const info = this.pty.create({
      sessionId: msg.sessionId,
      resolvedCwd,
      cols: msg.cols,
      rows: msg.rows,
      // (#5) Scrub host secrets from the shell env for remote clients; local
      // shells keep the full env for desktop parity.
      scrubEnv: client.kind !== "local",
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
    // A remote client that drops must not leave its agent sessions running —
    // they'd keep streaming updates and raising permission prompts to nobody.
    // Local renderer disconnects are transient reloads, so we deliberately
    // DON'T cancel those: the reconnecting desktop re-adopts the session via
    // the local-host fallback in routeToSession.
    if (client.kind !== "local") {
      for (const sessionId of owned) {
        const agentId = this.sessionAgent.get(sessionId);
        if (agentId) {
          // Deliberate engine-policy cancel — mark the intent so a turn torn
          // down by it records "cancelled", not "failed" (same race as the
          // user Stop button; see cancelRequested).
          this.cancelRequested.add(sessionId);
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
    // Purge ownership bookkeeping for any disconnecting client
    // so dead-client entries can't accumulate — each reconnect mints a fresh
    // client id. A still-live local session re-registers on its next
    // prompt/load; the only consumer of sessionAgent is the relay-cancel above.
    for (const sessionId of owned) this.sessionAgent.delete(sessionId);
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
    // They're engine-owned multiplayer resources (Paseo model) — a phone
    // dropping, or the desktop renderer reloading, must NOT kill a shell another
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
  // The dev HMR watcher (electron/sidecar.ts) respawns this engine on any
  // src/engine change. Without coordination, a save mid-turn SIGTERMs the
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
  // launch reaped it (electron/sidecar.ts orphan sweep). Self-exit instead:
  //
  //   1. stdin EOF — the engine's stdin is a pipe from Electron main (the
  //      host control channel); EOF means the parent is gone. Works on every
  //      platform, including Windows (where ppid goes stale, not reparented).
  //   2. ppid poll — on macOS/Linux an orphan is reparented (launchd/init),
  //      so `process.ppid` changing away from the spawning pid is definitive.
  //      Covers the case where some intermediary keeps the stdin pipe open.
  //
  // Armed ONLY when the host passes ZEROS_PARENT_PID (electron/sidecar.ts).
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
  // (H4) without it passing through the renderer. Attached only when stdin is a
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

  private handleHostControlLine(line: string): void {
    let msg: { type?: string; token?: string | null; data?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "host.githubToken") {
      seedGithubToken(typeof msg.token === "string" ? msg.token : null);
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
      // `<root>/.zeros` in the served repo anymore. 0600 because it carries the
      // loopback /ws bearer token (C1), the secret a local CLI presents to drive
      // the engine (the Electron renderer gets it over IPC, never this file).
      // `pid` lets a reader spot a dead engine; `root` is for reverse-lookup.
      const manifest = {
        pid: process.pid,
        port,
        // Bind the host's readiness/watchdog probes to THIS exact engine boot,
        // not merely to any process that returns `{status:"ok"}` on the port.
        instance: this.local.instanceNonce,
        protocolVersion: PROTOCOL_VERSION,
        token: this.localToken,
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
