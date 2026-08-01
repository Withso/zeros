// ──────────────────────────────────────────────────────────
// AgentGateway — orchestrator for per-agent adapters
// ──────────────────────────────────────────────────────────
//
// Native agent gateway. Exposes the same public surface the engine
// entry point (src/engine/index.ts) already uses:
//
//   new AgentGateway({ projectRoot, events })
//   gateway.refreshRegistry() / gateway.listAgents()
//   gateway.initializeAgent(agentId)
//   gateway.ensureAgent(agentId, { env })
//   gateway.authenticate(agentId, methodId)
//   gateway.newSession(agentId, { cwd, env })
//   gateway.loadSession(agentId, sessionId, { cwd, env })
//   gateway.listSessions(agentId, { cwd, cursor })
//   gateway.prompt(agentId, sessionId, prompt)
//   gateway.cancel(agentId, sessionId)
//   gateway.setMode(agentId, sessionId, modeId)
//   gateway.answerPermission(permissionId, response)
//   gateway.dispose()
//
// Internally the gateway routes by agent id to a lazily-instantiated
// AgentAdapter. Each adapter owns its own subprocesses; the gateway
// owns only the adapter cache and the session→agent routing table.
//
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";

// Roadmap 03a follow-up B: resolve workspaceId → cwd before spawning.
// We import directly from the workspace state module (not the git
// barrel) to avoid pulling GitHub auth/Octokit wiring into the engine
// bundle.
import { getWorkspaceById } from "../git/state";
import { resolveWorkspaceTargetRef } from "../git/target-branch";
import { mergeSpawnEnv } from "../settings/spawn-env";
import { applyUserProviderConfig } from "../settings/provider-env";
import {
  AGENT_MANIFEST,
  bundledRuntimeVersion,
  findAgent,
  toBridgeAgents,
  type AgentVersionInfo,
  type AuthProbe,
} from "./registry";
import { sessionsRoot } from "./session-paths";
import {
  buildFirstTurnInstructionBody,
  buildFirstTurnSystemInstruction,
} from "@zeros/core/system-instructions";
import {
  probeCliInstalled,
  evaluateAuthProbe,
  latestAuthFileMtimeMs,
  secretAccountFingerprint,
  probeCliCompatibility,
  clearVersionCache,
} from "./probes";
import type {
  AgentAdapter,
  AgentAdapterContext,
  AgentGatewayEvents,
  AgentGatewayOptions,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  McpServerRegistration,
  NewSessionResponse,
  PromptResponse,
  QuestionResponse,
  RequestPermissionResponse,
} from "./types";
import type { AccountDetails, EnrichedRegistryAgent } from "../types";
import { AgentFailureError } from "./types";
import { dedupeMcpServers, resolveMcpServersForRepo } from "./mcp-registry";

export const DESIGN_MCP_TOKEN_ENV = "ZEROS_DESIGN_MCP_TOKEN";

export interface DesignServerConnection {
  url: string;
  bearerToken: string;
}

/** Phase 2 chat overhaul (2026-05-07): every agent spawn MUST carry an
 *  explicit, non-empty cwd. The earlier silent fallback to engine
 *  projectRoot caused chats labelled with one project in the UI to spawn agents
 *  in the Zeros source tree because cwd resolution invisibly fell
 *  through. Validating here turns the bug into a surfaceable failure
 *  that routes through the existing error pill.
 *
 *  Roadmap 03a follow-up B (2026-05-20): callers may also pass a
 *  `workspaceId` instead of (or in addition to) `cwd`. If provided and
 *  the workspace is known to ~/.zeros/state.db, the resolved
 *  worktree path is used. Provided `cwd` still wins when both are set
 *  — the renderer is the source of truth for the *current* path even
 *  if the workspace record is stale.
 */
// Exported for unit testing — the function is not part of the public
// gateway API but tests want to verify the three-branch resolution path
// (cwd wins / workspaceId resolves / both missing throws) without
// spinning up adapters.
/** Resolve a workspaceId to its CURRENT on-disk path, but ONLY if that path
 *  still exists — so a stale/archived record never spawns the agent in a
 *  nonexistent cwd. Returns null on any miss (unknown id, empty/missing path). */
function resolveExistingWorkspacePath(workspaceId: string): string | null {
  try {
    const ws = getWorkspaceById(workspaceId);
    if (ws && ws.path && ws.path.length > 0 && existsSync(ws.path)) {
      return ws.path;
    }
  } catch {
    /* unknown id / DB error — fall through to null */
  }
  return null;
}

export function resolveAgentCwd(
  cwd: string | undefined,
  stage: "newSession" | "loadSession",
  workspaceId?: string,
): string {
  // Prefer explicit cwd when supplied — the renderer knows where the
  // user is right now.
  if (typeof cwd === "string" && cwd.length > 0) {
    // S2: validate the folder still exists before handing it to an
    // adapter. A chat bound to a worktree that was since deleted,
    // archived, or renamed would otherwise spawn the CLI with a
    // nonexistent cwd. Node's child_process surfaces that as an ENOENT
    // error event that is indistinguishable from a missing binary, so
    // buildSpawnFailure mislabelled it "<cli> is not installed or not
    // on $PATH" — telling the user to reinstall a CLI that is in fact
    // installed. Fail loud and specific instead so they can re-bind.
    if (existsSync(cwd)) return cwd;
    // The cwd is stale: the chat's folder was deleted/renamed, OR the worktree
    // was archived and RESTORED to a different on-disk path. Before failing,
    // self-heal through the workspaceId — a restored worktree keeps its id but
    // may sit at a new path. (Restore normally rebinds chats to the new folder,
    // so this is a belt-and-suspenders net for a stale tab snapshot or an
    // out-of-band move that still reaches here with the old cwd.)
    if (workspaceId) {
      const healed = resolveExistingWorkspacePath(workspaceId);
      if (healed) {
        console.warn(
          `[gateway] chat cwd no longer exists (${cwd}); self-healing to ` +
            `workspace ${workspaceId} at ${healed}`,
        );
        return healed;
      }
    }
    throw new AgentFailureError({
      kind: "protocol-error",
      message:
        `Agent cannot spawn: the chat's folder no longer exists on disk ` +
        `(${cwd}). It may have been deleted, archived, or renamed — ` +
        `re-bind the chat to an existing folder.`,
      stage,
    });
  }
  // No cwd was passed — resolve from the workspaceId instead. E.5: only trust
  // the stored path if it still exists on disk; an archived/deleted worktree's
  // stale path must fail loud rather than spawn the agent in the wrong place.
  if (workspaceId) {
    const fromWs = resolveExistingWorkspacePath(workspaceId);
    if (fromWs) return fromWs;
  }
  throw new AgentFailureError({
    kind: "protocol-error",
    message:
      `Agent cannot spawn: chat has no project folder bound. ` +
      `Set the chat's folder before starting a session.`,
    stage,
  });
}

/** True when a cached initialize belongs to an adapter that discovers its
 *  model list asynchronously (`_meta.modelsDynamic`, set by the @cursor/sdk) and
 *  hasn't populated `_meta.models` yet. Such an initialize must be re-read on
 *  the next request so the live, account-specific catalog replaces the
 *  model-less first snapshot — otherwise the model pill is stuck on the
 *  bundled fallback and never reflects the user's real Cursor models. */
export function shouldRepollInitialize(init: InitializeResponse): boolean {
  const meta = init._meta as
    | { modelsDynamic?: unknown; models?: unknown }
    | undefined;
  return (
    !!meta?.modelsDynamic &&
    !(Array.isArray(meta.models) && meta.models.length > 0)
  );
}

/** TTL on the listAgents result cache. Short enough that an
 *  install/login change shows up within seconds; long enough to
 *  absorb the typical 5-10 renderer-churn calls/second that hit
 *  this code path. force-refresh (via refreshRegistry) bypasses. */
const LIST_AGENTS_FRESHNESS_MS = 5_000;

// Account details (provider / plan / org / email) are far more expensive to
// fetch than the install/auth/version probes — each can spawn a short-lived
// child (Claude SDK query / Codex app-server). Cache them well past the
// listAgents freshness window so the hot path never re-pays it; the Providers
// panel's Refresh clears this cache (refreshRegistry) to force a re-fetch.
const ACCOUNT_INFO_TTL_MS = 10 * 60_000;

/** Agents that natively tell their own model the working directory, so the
 *  gateway must NOT prepend a cwd hint (it would be redundant noise):
 *   - "claude" injects `<env> Working directory: …` via the `claude_code`
 *     system-prompt preset (claude-sdk/adapter.ts).
 *   - "codex" injects `<cwd>` from the `thread/start.cwd` it's handed.
 *   - "cursor" surfaces the workspace root to its model via the local SDK's
 *     `agent.v1.RequestContextEnv` block (workspace_paths / project_folder /
 *     process_working_directory), populated from the `local: { cwd }` we hand
 *     it — cursor-sdk/adapter.ts buildLocalOpts. NOT the proto's
 *     `workspace_root_path` field, which the local executor never sets.
 *  All three active agents self-report, so the hint below is currently
 *  dormant — kept as a safety net for any FUTURE backend that only receives
 *  cwd as its process working directory and never surfaces it (such a model
 *  guesses a path on its first write, fails, and recovers via `pwd`). */
const CWD_SELF_AWARE_AGENTS = new Set(["claude", "codex", "cursor"]);

/** Stamp the resolved worktree path into the spawn env as `ZEROS_WORKTREE_PATH`
 *  — the same idiomatic signal Zeros already sets for terminals and git hooks
 *  (pty/shell-setup.ts, git/setup-hooks.ts). It is the AUTHORITATIVE cwd, so it
 *  is applied LAST (wins over any repo `settings.toml` / caller value). Lets
 *  scripts/hooks the agent runs learn which worktree they're in. */
function withWorktreeEnv(
  env: Record<string, string> | undefined,
  cwd: string,
): Record<string, string> {
  return { ...(env ?? {}), ZEROS_WORKTREE_PATH: cwd };
}

/** Stamp `ZEROS_TARGET_BRANCH` — the ref the first-turn instruction tells the
 *  agent to diff against and open PRs onto (parseInstructionCtx reads it; the
 *  preamble otherwise falls back to a literal "origin/main", wrong for any
 *  repo whose base isn't main or whose remote isn't origin). Resolution lives
 *  in git/target-branch.ts (workspace row + configured `git.remote`). A
 *  caller/settings-provided value wins (tests, overrides); plain-folder chats
 *  (no workspaceId) are untouched. */
async function withTargetBranchEnv(
  env: Record<string, string>,
  workspaceId: string | undefined,
): Promise<Record<string, string>> {
  if (!workspaceId || env.ZEROS_TARGET_BRANCH?.trim()) return env;
  const targetRef = await resolveWorkspaceTargetRef(workspaceId);
  if (!targetRef) return env;
  return { ...env, ZEROS_TARGET_BRANCH: targetRef };
}

/** The workspace row, not renderer/local settings, is authoritative for the
 *  backend contract. This prevents a stale code chat or spoofed env value from
 *  enabling design instructions in the wrong checkout, while still allowing
 *  rowless test/plain-folder sessions to carry an explicit mode. */
function withWorkspaceModeEnv(
  env: Record<string, string>,
  workspaceId: string | undefined,
): Record<string, string> {
  if (!workspaceId) return env;
  let isDesign = false;
  try {
    isDesign = getWorkspaceById(workspaceId)?.kind === "design";
  } catch {
    /* An unknown workspace is treated as code and will fail cwd resolution. */
  }
  const next = { ...env };
  if (isDesign) next.ZEROS_CHAT_MODE = "design";
  else delete next.ZEROS_CHAT_MODE;
  return next;
}

/** Claude supports project-relative Edit deny rules; Codex and Cursor do not.
 *  In a cone-mode sparse design checkout the only root entries are Git's root
 *  files plus `Zeros Design/`. `Edit(/*)` blocks those root files while still
 *  permitting nested frame/token edits. Bash remains cooperative in v1 (the
 *  sparse checkout + lint contract is the uniform cross-agent boundary). */
function withDesignAgentGuards(
  env: Record<string, string>,
  agentId: string,
): Record<string, string> {
  if (agentId !== "claude" || env.ZEROS_CHAT_MODE !== "design") return env;
  const existing = (env.CLAUDE_DISALLOWED_TOOLS ?? "")
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
  const deny = Array.from(new Set([...existing, "Edit(/*)"]));
  return { ...env, CLAUDE_DISALLOWED_TOOLS: deny.join(",") };
}

export class AgentGateway {
  private readonly projectRoot: string;
  private readonly events: AgentGatewayEvents;

  /** The raw MCP registry (may hold dupes; deduped into the view below). */
  private readonly mcpServers: McpServerRegistration[] = [];
  /** Deduped, SHARED view handed by reference to every adapter's
   *  `ctx.mcpServers`. All three adapters read `ctx.mcpServers` LAZILY at
   *  session-build time, so mutating this array in place (setMcpServers →
   *  refreshMcpView) makes the NEXT session each agent starts pick up registry
   *  changes without an app restart — live sessions keep the options they were
   *  already built with. */
  private readonly mcpServersView: McpServerRegistration[] = [];
  private readonly adapters = new Map<string, AgentAdapter>();
  private readonly sessionToAgent = new Map<string, string>();
  /** Roadmap 03a follow-up B: track which workspace each session belongs
   *  to so adapter callbacks can look it up (e.g. for the background-
   *  rename hook in follow-up C). Sessions without a workspaceId
   *  (chats spawned from a plain folder) simply have no entry here. */
  private readonly sessionToWorkspace = new Map<string, string>();
  /** Resolved cwd (worktree path) per session — so `prompt()` can tell an
   *  agent that doesn't self-report its cwd where it is. Set at
   *  newSession/loadSession, cleared on endSession/dispose. */
  private readonly sessionToCwd = new Map<string, string>();
  /** Sessions already given the one-shot cwd hint (see CWD_SELF_AWARE_AGENTS).
   *  First prompt per session only — the agent's server keeps it in history. */
  private readonly sessionsCwdHinted = new Set<string>();
  // System-instruction one-shot tracking + captured per-session context. Like
  // the cwd hint: the first-turn <system_instruction> (workspace preamble +
  // /add-dir awareness + repo `[prompts] general`) is injected on the FIRST
  // prompt of a NEW session, then lives in the agent's history. A RESUMED
  // session (loadSession) is pre-marked instructed so the block — already in the
  // resumed transcript — isn't sent twice. See system-instructions/ for the text.
  private readonly sessionsInstructed = new Set<string>();
  private readonly sessionToInstructionCtx = new Map<
    string,
    {
      additionalDirectories: string[];
      targetBranch?: string;
      customInstructions?: string;
      mode: "code" | "design";
    }
  >();
  private readonly agentInitializes = new Map<string, InitializeResponse>();
  /** Dedupe concurrent listAgents calls. Without this, every render
   *  loop in the renderer that hits sessions.listAgents() spawns its
   *  own round of N PATH+auth+version probes (one per agent). The renderer sometimes
   *  fires listAgents 5-10×/sec on session-state churn, which used
   *  to balloon the engine to 200+ live `--version` subprocesses. */
  private listAgentsInFlight: Promise<EnrichedRegistryAgent[]> | null = null;
  /** Short freshness cache for listAgents. Bursts of render-churn
   *  calls within LIST_AGENTS_FRESHNESS_MS share the prior result
   *  instead of re-spawning probes. Force-refresh (via
   *  refreshRegistry) bypasses by calling listAgents directly after
   *  clearing this cache implicitly — see refreshRegistry below. */
  private cachedAgents: EnrichedRegistryAgent[] | null = null;
  private cachedAgentsAt: number | null = null;

  /** Per-agent account-details cache (provider / plan / org / email), keyed
   *  by agent id. Long TTL (ACCOUNT_INFO_TTL_MS) because each miss can spawn
   *  a child; null is cached too (so a logged-out / unsupported agent doesn't
   *  re-probe every call). Cleared by refreshRegistry. */
  private readonly accountInfoCache = new Map<
    string,
    { at: number; value: AccountDetails | null }
  >();

  /** Runtime auth invalidation. When an adapter throws `auth-required`,
   *  the agent's CLI is the source of truth — even if our file/keychain
   *  probe came back positive (stale / expired / scoped credentials).
   *  We override the probe result for any agent in this set so the
   *  green dot disappears the moment the CLI itself disagrees. Cleared
   *  on a successful prompt, on adapter dispose, when the underlying
   *  credentials file mtime jumps past the failure time (user re-signed
   *  in via Terminal.app), when a secret-store key's blob changes (user
   *  re-pasted the key in Settings → Providers), and after a 30 min TTL
   *  so a long-running app doesn't get stuck. */
  private readonly runtimeAuthFailed = new Map<
    string,
    { at: number; secretFingerprint: string | null }
  >();
  private static readonly AUTH_FAIL_TTL_MS = 30 * 60_000;

  /** Called by adapters whenever a prompt fails with auth-required.
   *  Drives the green-dot back to gray on the next listAgents fetch. */
  markAuthFailed(agentId: string): void {
    const entry = { at: Date.now(), secretFingerprint: null as string | null };
    this.runtimeAuthFailed.set(agentId, entry);
    // Snapshot the credential blob AT failure time (secret-account probes
    // only — null for every other kind) so isAuthRuntimeInvalidated can
    // detect "the user saved a different key since". Async fire-and-forget;
    // only stamps its own entry in case the marker was cleared meanwhile.
    const probe = findAgent(agentId)?.authProbe;
    if (probe) {
      void secretAccountFingerprint(probe)
        .then((fp) => {
          if (this.runtimeAuthFailed.get(agentId) === entry) {
            entry.secretFingerprint = fp;
          }
        })
        .catch(() => {});
    }
  }

  /** Called when a prompt succeeds — clears any prior auth-failed
   *  marker so the dot turns green again as soon as the user re-logs. */
  markAuthOk(agentId: string): void {
    this.runtimeAuthFailed.delete(agentId);
  }

  /** Should the runtime "auth-failed" marker still block this agent's
   *  probe result? It expires four ways:
   *    1. TTL (30 min) — long-app safety net.
   *    2. Credential file mtime > failure timestamp — user re-signed
   *       in via Terminal.app since we marked the agent failed. This is
   *       the critical case: without it, a single auth-required failure
   *       leaves Zeros stuck on "Sign in required" for 30 min even
   *       though the user just refreshed their token in another shell.
   *    3. Secret-store blob changed (secret-account probes, e.g. Cursor's
   *       API key) — the user re-pasted the key in Settings → Providers.
   *       Same rationale as #2: these agents have no credential-file mtime
   *       (latestAuthFileMtimeMs returns 0) AND auth-required disables the
   *       chat composer, so without this signal nothing could ever fire
   *       markAuthOk and the agent stayed amber for the full TTL after the
   *       key was fixed (user report 2026-07-04).
   *    4. markAuthOk on a successful prompt.
   */
  private async isAuthRuntimeInvalidated(
    agentId: string,
    probe: AuthProbe,
  ): Promise<boolean> {
    const entry = this.runtimeAuthFailed.get(agentId);
    if (entry === undefined) return false;
    if (Date.now() - entry.at > AgentGateway.AUTH_FAIL_TTL_MS) {
      this.runtimeAuthFailed.delete(agentId);
      return false;
    }
    const mtimeMs = await latestAuthFileMtimeMs(probe);
    if (mtimeMs > entry.at) {
      this.runtimeAuthFailed.delete(agentId);
      return false;
    }
    if (entry.secretFingerprint !== null) {
      const fp = await secretAccountFingerprint(probe);
      if (fp !== null && fp !== entry.secretFingerprint) {
        this.runtimeAuthFailed.delete(agentId);
        return false;
      }
    }
    return true;
  }

  constructor(opts: AgentGatewayOptions) {
    this.projectRoot = opts.projectRoot;
    this.events = opts.events;
  }

  /** Replace the MCP server registry. The engine boot-loads this from the
   *  resolved (user-level) settings; the Customize → MCP surface re-invokes it
   *  on every edit. Because the deduped view is shared by reference with every
   *  adapter ctx (see `mcpServersView`), the NEXT session each agent starts
   *  uses the new registry — no app restart, and in-flight sessions are
   *  untouched. Idempotent + safe to call before any adapter exists (boot). */
  setMcpServers(servers: readonly McpServerRegistration[]): void {
    this.mcpServers.splice(0, this.mcpServers.length, ...servers);
    this.refreshMcpView();
  }

  /** The Zeros MCP gateway's localhost URL (set by the engine when the gateway
   *  is running), or null when it's down. When set, every session is injected
   *  one extra http server pointing at the gateway, which fronts the auth:"oauth"
   *  backends (they're held out of direct injection by resolveMcpServers). */
  private gatewayServerUrl: string | null = null;
  setGatewayServer(url: string | null): void {
    this.gatewayServerUrl = url;
  }
  /** Resolve the first-party design MCP endpoint for one workspace. Kept as a
   *  callback (rather than a boot snapshot) so archive/delete immediately
   *  revokes the URL and every new session gets exact workspace identity. */
  private designServerConnectionForWorkspace:
    | ((workspaceId: string) => DesignServerConnection | null)
    | null = null;
  setDesignServerResolver(
    resolve: ((workspaceId: string) => DesignServerConnection | null) | null,
  ): void {
    this.designServerConnectionForWorkspace = resolve;
  }

  private resolveDesignConnection(
    workspaceId?: string,
  ): DesignServerConnection | null {
    return workspaceId && this.designServerConnectionForWorkspace
      ? this.designServerConnectionForWorkspace(workspaceId)
      : null;
  }
  /** Recompute the shared, deduped adapter-facing view IN PLACE (the reference
   *  is shared with live adapter ctxs, so we mutate rather than reassign). */
  private refreshMcpView(): void {
    const deduped = dedupeMcpServers(this.mcpServers);
    this.mcpServersView.splice(0, this.mcpServersView.length, ...deduped);
  }

  /** Resolve the per-session MCP registry — the user + managed set, plus the
   *  session repo's PERSONAL repo-local servers (the Customize tab's repo
   *  scope), plus the gateway endpoint when it's up. `mainRepoRoot` is the
   *  workspace's primary checkout (repo-local lives there, shared by every
   *  worktree); absent (a plain-folder chat) it falls back to cwd — the same
   *  layering mergeSpawnEnv uses. Re-resolving per spawn (rather than reusing
   *  the boot view) keeps a settings edit live for the NEXT session without a
   *  registry reload race. Async because the repo-local trust check shells
   *  `git check-ignore` (off the event loop — the old sync resolve blocked the
   *  whole engine per spawn). Falls back to the global boot-loaded view on any
   *  error so a spawn is never blocked. */
  private async resolveSessionMcp(
    agentId: string,
    cwd: string,
    mainRepoRoot?: string,
    workspaceId?: string,
    designConnection = this.resolveDesignConnection(workspaceId),
  ): Promise<McpServerRegistration[]> {
    const injected: McpServerRegistration[] = [];
    // The gateway endpoint fronting the auth:"oauth"/"header" backends.
    if (this.gatewayServerUrl) {
      injected.push({
        name: "zeros-gateway",
        transport: "http",
        url: this.gatewayServerUrl,
      });
    }
    if (designConnection) {
      injected.push({
        name: "zeros-design",
        transport: "http",
        url: designConnection.url,
        bearerTokenEnvVar: DESIGN_MCP_TOKEN_ENV,
        // This URL is minted in-process, loopback-only, workspace-scoped, and
        // authenticated with an opaque token. Annotated reads run directly;
        // the structured source mutations retain Codex's MCP elicitation gate.
        trusted: true,
        approval: { defaultMode: "writes" },
      });
    }
    try {
      const { servers, gatewayBackends, warnings } =
        await resolveMcpServersForRepo(mainRepoRoot ?? cwd);
      for (const w of warnings) console.warn(`[agents] ${agentId} MCP: ${w}`);
      // Surface gateway backends that exist but have NO endpoint up yet.
      if (gatewayBackends.length > 0 && !this.gatewayServerUrl) {
        console.warn(
          `[agents] ${agentId} MCP: gateway-managed server(s) ` +
            `[${gatewayBackends.map((b) => b.name).join(", ")}] pending the MCP gateway (not yet available).`,
        );
      }
      // Reserve the injected gateway name: drop any resolved server that would
      // collide with "zeros-gateway" (a name clash would overwrite the gateway
      // entry in the adapters' name-keyed MCP maps).
      const reserved = new Set(injected.map((s) => s.name));
      const safeServers = servers.filter((s) => {
        if (!reserved.has(s.name)) return true;
        console.warn(
          `[agents] ${agentId} MCP: server "${s.name}" uses a reserved gateway name — ignored.`,
        );
        return false;
      });
      return [...injected, ...safeServers];
    } catch (err) {
      console.warn(
        `[agents] ${agentId} MCP resolve failed for ${cwd}; using the global registry:`,
        err instanceof Error ? err.message : String(err),
      );
      const reserved = new Set(injected.map((server) => server.name));
      return [
        ...injected,
        ...this.mcpServersView.filter((server) => !reserved.has(server.name)),
      ];
    }
  }

  // ── Engine-facing gateway API ───────────────────────────

  async listAgents(): Promise<EnrichedRegistryAgent[]> {
    // Concurrent calls share the same in-flight promise so we never
    // fan out N×(call count) subprocesses on render-loop churn.
    if (this.listAgentsInFlight) return this.listAgentsInFlight;
    // Short freshness cache. Without this, back-to-back calls (e.g. a
    // settings panel that re-fetches on every focus + a chat-mount
    // effect on the same tick) re-spawn every probe — one install
    // probe + one auth probe + one version probe per agent per call. The 5-second
    // window keeps the cost bounded while still letting force-refresh
    // (via refreshRegistry) cut through. Tuned for renderer-churn
    // bursts, not for catching the moment the user installs a CLI —
    // that path uses refreshRegistry explicitly.
    if (
      this.cachedAgents &&
      this.cachedAgentsAt !== null &&
      Date.now() - this.cachedAgentsAt < LIST_AGENTS_FRESHNESS_MS
    ) {
      return this.cachedAgents;
    }
    this.listAgentsInFlight = this.listAgentsImpl()
      .then((result) => {
        this.cachedAgents = result;
        this.cachedAgentsAt = Date.now();
        return result;
      })
      .finally(() => {
        this.listAgentsInFlight = null;
      });
    return this.listAgentsInFlight;
  }

  private async listAgentsImpl(): Promise<EnrichedRegistryAgent[]> {
    // Install-probe + auth-probe fan out in parallel. Version probe
    // is scoped to *installed* binaries only (running `--version` on
    // an ENOENT is slow ENOENT + noise in logs), so it waits for the
    // install probe first. probeCliVersion has its own 5min cache so
    // repeated listAgents calls are cheap.
    const [installed, authenticated] = await Promise.all([
      probeCliInstalled(AGENT_MANIFEST.map((a) => a.cliBinary)),
      (async () => {
        const set = new Set<string>();
        await Promise.all(
          AGENT_MANIFEST.map(async (m) => {
            // Runtime invalidation wins. If the agent's CLI itself
            // told us "not logged in" recently, trust that over the
            // file/keychain probe (which can show stale positives) —
            // unless the credential file has been touched since the
            // failure, in which case the user has re-signed in via
            // Terminal.app and the probe result is fresh again.
            if (await this.isAuthRuntimeInvalidated(m.id, m.authProbe)) return;
            try {
              if (await evaluateAuthProbe(m.authProbe)) set.add(m.id);
            } catch {
              /* probe failed — treat as unauthenticated */
            }
          }),
        );
        return set;
      })(),
    ]);

    const versionInfo = new Map<string, AgentVersionInfo>();
    const versionProbe = Promise.all(
      AGENT_MANIFEST.map(async (m) => {
        // Claude + Codex run a CLI BUNDLED with the app (the Agent SDK's pinned
        // claude-code; the @openai/codex dep) — NOT the user's global `<cli>`,
        // which only matters for sign-in via Terminal. Report the BUNDLED
        // version so the picker + Providers page reflect what actually runs
        // (e.g. 2.1.170), not a possibly-stale global install (e.g. 2.1.169).
        // Falls through to the PATH probe if the bundle can't be read.
        const bundled = bundledRuntimeVersion(m.id);
        if (bundled) {
          versionInfo.set(m.id, {
            installedVersion: bundled,
            versionCompatible: true,
          });
          return;
        }
        if (!installed.has(m.cliBinary)) return;
        try {
          const { version, compatible } = await probeCliCompatibility({
            binary: m.cliBinary,
            minVersion: m.minCliVersion,
            maxVersion: m.maxCliVersion,
          });
          versionInfo.set(m.id, {
            installedVersion: version ?? undefined,
            versionCompatible: compatible ?? undefined,
          });
        } catch {
          /* timeout / parse error → leave entry absent */
        }
      }),
    );

    // Account details run in parallel with the version probe (both only need
    // the auth result above). Behind a long TTL (see fetchAccountInfo) so the
    // hot listAgents path rarely re-spawns a child.
    const [, accountByAgentId] = await Promise.all([
      versionProbe,
      this.fetchAccountInfo(authenticated),
    ]);

    return toBridgeAgents(
      installed,
      authenticated,
      versionInfo,
      accountByAgentId,
      this.resolveRuntimeOverrides(),
    );
  }

  /** Per-agent persisted `executable_path` from the user settings layer, keyed by
   *  agent id. Feeds each manifest entry's `runtimeUnavailable` probe.
   *
   *  WHY THIS EXISTS: the missing-runtime message tells the user to set Settings →
   *  Agent providers → Executable path. Without this the probe never read that
   *  value, so setting it changed nothing — `installed`/`authenticated` stayed
   *  false, `isRunnableAgent()` returned false, and every send was refused with
   *  "Not installed". The advice and the code disagreed, leaving no way out.
   *
   *  `providers` is a USER-only settings key, so the cwd only selects which repo's
   *  layers are consulted for OTHER keys — the engine's own projectRoot is the right
   *  anchor. Best-effort: a settings read failure degrades to "no override" and must
   *  never break listAgents. */
  private resolveRuntimeOverrides(): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of AGENT_MANIFEST) {
      if (!m.runtimeUnavailable) continue;
      try {
        const { cliBinary } = applyUserProviderConfig(
          this.projectRoot,
          m.id,
          {},
        );
        const trimmed = cliBinary?.trim();
        if (trimmed) out.set(m.id, trimmed);
      } catch {
        /* unreadable settings — treat as no override */
      }
    }
    return out;
  }

  /** Account details (provider / plan / org / email) for each authenticated
   *  agent whose adapter implements `getAccountInfo`. Cached behind
   *  ACCOUNT_INFO_TTL_MS (and `refreshRegistry` clears it) because each miss
   *  can spawn a short-lived child. Unauthenticated agents and those without
   *  the capability (Cursor) are skipped. Failures cache as null so a
   *  logged-out agent doesn't re-probe every call. */
  private async fetchAccountInfo(
    authenticated: Set<string>,
  ): Promise<Map<string, AccountDetails>> {
    const out = new Map<string, AccountDetails>();
    const now = Date.now();
    await Promise.all(
      AGENT_MANIFEST.map(async (m) => {
        if (!authenticated.has(m.id)) return;
        const cached = this.accountInfoCache.get(m.id);
        if (cached && now - cached.at < ACCOUNT_INFO_TTL_MS) {
          if (cached.value) out.set(m.id, cached.value);
          return;
        }
        let value: AccountDetails | null = null;
        try {
          const adapter = await this.adapterFor(m.id);
          value = (await adapter.getAccountInfo?.()) ?? null;
        } catch {
          /* best-effort — cache null, retry after the TTL / on Refresh */
        }
        this.accountInfoCache.set(m.id, { at: now, value });
        if (value) out.set(m.id, value);
      }),
    );
    return out;
  }

  /** The registry is local/manifest-backed, so `refresh` re-probes PATH.
   *  Invalidates the listAgents freshness cache so the next call
   *  actually re-runs probes. */
  async refreshRegistry(): Promise<EnrichedRegistryAgent[]> {
    this.cachedAgents = null;
    this.cachedAgentsAt = null;
    // A force-refresh is the user explicitly re-checking auth (the Providers
    // panel fires it, including right after saving a provider key). Drop the
    // runtime auth-failed overrides so a corrected agent's fresh probe wins
    // again. File-credential agents already self-heal via the mtime-jump
    // path, but env-key agents (e.g. Cursor's CURSOR_API_KEY pasted in
    // Settings) have no credential-file mtime to trip that — without this
    // their dot stayed gray until the next prompt or the 30-min TTL.
    this.runtimeAuthFailed.clear();
    // Bust the `<cli> --version` probe cache (5-min TTL) so a just-updated
    // global CLI (cursor) shows its new version immediately on
    // a user-triggered Refresh instead of waiting out the TTL.
    clearVersionCache();
    // Drop cached account details so a user-triggered Refresh actually
    // re-fetches them (the re-probe re-spawns the child — exactly the intent).
    this.accountInfoCache.clear();
    return this.listAgents();
  }

  async initializeAgent(agentId: string): Promise<InitializeResponse> {
    const adapter = await this.adapterFor(agentId);
    const cached = this.agentInitializes.get(agentId);
    // Serve the cache UNLESS it's a dynamic-models adapter (Cursor) whose
    // first initialize was model-less because the catalog is discovered only
    // after a runtime boots. In that case re-read the adapter so a freshly
    // populated `_meta.models` reaches the renderer instead of the stale
    // model-less snapshot. adapter.initialize() is cheap+idempotent (returns
    // the adapter's own cached object), so the re-poll is safe and self-
    // limits once `models` lands.
    if (cached && !shouldRepollInitialize(cached)) return cached;
    const init = await adapter.initialize();
    this.agentInitializes.set(agentId, init);
    return init;
  }

  async ensureAgent(
    agentId: string,
    _opts: { env?: Record<string, string> } = {},
  ): Promise<InitializeResponse> {
    // PTY adapters spawn per-session, so env is applied at newSession
    // time; ensureAgent just means "the adapter is initialized."
    return this.initializeAgent(agentId);
  }

  /** Save-time provider-key validation (AGENT_VALIDATE_KEY). Delegates to
   *  the adapter's optional validateApiKey; agents without one (Claude /
   *  Codex CLI-auth paths) return ok=null so the renderer saves normally. */
  async validateProviderKey(
    agentId: string,
    apiKey: string,
  ): Promise<{ ok: boolean | null; error?: string }> {
    try {
      const adapter = await this.adapterFor(agentId);
      if (!adapter.validateApiKey) return { ok: null };
      return await adapter.validateApiKey(apiKey);
    } catch {
      return { ok: null };
    }
  }

  /** Background one-shot chat-title generation (AGENT_GENERATE_TITLE).
   *  Delegates to the adapter's optional generateText; adapters without one
   *  — or any failure — return title=null so the renderer silently keeps
   *  the snippet title. Never throws: this is a cosmetic background call
   *  and must not surface errors into the user's real turn. */
  async generateTitle(
    agentId: string,
    opts: {
      model: string;
      systemPrompt: string;
      prompt: string;
      env?: Record<string, string>;
    },
  ): Promise<{ title: string | null; error?: string }> {
    try {
      const adapter = await this.adapterFor(agentId);
      if (!adapter.generateText) return { title: null };
      const text = await adapter.generateText({ ...opts, timeoutMs: 30_000 });
      const title = text.trim();
      return { title: title.length > 0 ? title : null };
    } catch (err) {
      return {
        title: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async authenticate(_agentId: string, _methodId: string): Promise<void> {
    // Authentication for native CLIs happens in the provider panel's embedded
    // engine-owned PTY (registry.loginCommand). AGENT_AUTHENTICATE remains a
    // compatibility handshake; accept it without starting a second login path.
    return;
  }

  async newSession(
    agentId: string,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      /** Roadmap 03a follow-up B: when supplied, resolved against
       *  ~/.zeros/state.db. If cwd is also supplied, cwd wins (the
       *  renderer is the source of truth). If cwd is missing, the
       *  workspace's path is used. */
      workspaceId?: string;
      /** Optional CLI binary override from Settings → Providers →
       *  Advanced. Threaded down to the adapter so the per-turn spawn
       *  uses this in place of the registry's `cliBinary`. */
      cliBinary?: string;
    } = {},
  ): Promise<NewSessionResponse> {
    const adapter = await this.adapterFor(agentId);
    // Phase 2 chat overhaul (2026-05-07): the prior silent fallback
    // `opts.cwd ?? this.projectRoot` was a critical footgun. When a
    // caller passed `cwd: undefined` (e.g. column2-chat-view's
    // `cwd: chat.folder || undefined` collapsing an empty-string
    // chat.folder to undefined), the agent silently spawned in the
    // engine's projectRoot — the user's currently-open Zeros project
    // — instead of the chat's intended folder. So a chat labelled
    // "my-app" in the UI ended up exploring the Zeros source tree
    // because cwd resolution silently fell through to engine root.
    //
    // The fix: refuse to spawn without an explicit cwd. The caller's
    // chat MUST have a folder bound. The error surfaces as a real
    // failure the user can act on instead of an invisible misfire.
    const cwd = resolveAgentCwd(opts.cwd, "newSession", opts.workspaceId);
    const designConnection = this.resolveDesignConnection(opts.workspaceId);
    // Phase 4: overlay the repo/user TOML `env` table + `env_files` for this
    // cwd, UNDER the caller's env (per-session knobs + keychain secrets win),
    // then stamp ZEROS_WORKTREE_PATH so the agent's process/scripts know their
    // worktree. Provider config (executable_path, gateway base_url) is USER-only
    // (no per-repo layer): the renderer couriers it in opts.env / opts.cliBinary,
    // and applyUserProviderConfig fills any gap from the resolved user
    // settings.toml — the authoritative fallback for headless/relay/cron spawns
    // that have no renderer or localStorage. The couriered value always wins.
    //
    // workspace-local layering: a worktree agent inherits the repo's MAIN-checkout
    // repo-local (the machine-wide override the Settings UI edits) PLUS its OWN
    // worktree workspace-local. mainRepoRoot is the workspace's primary checkout;
    // absent (a plain-folder chat) → repo-local resolves from cwd, no
    // workspace-local — the prior behavior.
    const mainRepoRoot = opts.workspaceId
      ? getWorkspaceById(opts.workspaceId)?.repoRoot
      : undefined;
    const merged = withDesignAgentGuards(
      withWorkspaceModeEnv(
        await withTargetBranchEnv(
          withWorktreeEnv(mergeSpawnEnv(cwd, opts.env, mainRepoRoot), cwd),
          opts.workspaceId,
        ),
        opts.workspaceId,
      ),
      agentId,
    );
    const spawn = applyUserProviderConfig(
      cwd,
      agentId,
      { env: merged, cliBinary: opts.cliBinary },
      mainRepoRoot,
    );
    const spawnEnv = designConnection
      ? { ...spawn.env, [DESIGN_MCP_TOKEN_ENV]: designConnection.bearerToken }
      : spawn.env;
    // Native-instruction adapters (Codex) take the first-turn orientation on
    // their protocol's own channel at thread creation; everyone else gets it
    // prepended in-band on the first prompt (withSystemInstruction).
    const instructionCtx = this.parseInstructionCtx(spawnEnv);
    const systemInstruction = this.nativeInstructionFor(
      adapter,
      cwd,
      instructionCtx,
    );
    const { session } = await adapter.newSession({
      cwd,
      env: spawnEnv,
      cliBinary: spawn.cliBinary,
      mcpServers: await this.resolveSessionMcp(
        agentId,
        cwd,
        mainRepoRoot,
        opts.workspaceId,
        designConnection,
      ),
      ...(systemInstruction ? { systemInstruction } : {}),
    });
    console.log(
      `[agents] ${agentId} newSession: sessionId=${session.sessionId} cwd=${cwd}` +
        (opts.workspaceId ? ` workspaceId=${opts.workspaceId}` : "") +
        (systemInstruction ? " sysInstr=native" : ""),
    );
    this.sessionToAgent.set(session.sessionId, agentId);
    this.sessionToCwd.set(session.sessionId, cwd);
    this.sessionToInstructionCtx.set(session.sessionId, instructionCtx);
    if (systemInstruction) {
      // Delivered natively at thread creation — the first prompt must NOT
      // also prepend the in-band block.
      this.sessionsInstructed.add(session.sessionId);
    }
    // Otherwise: NEW session → left un-instructed so the first prompt injects
    // the preamble.
    if (opts.workspaceId) {
      this.sessionToWorkspace.set(session.sessionId, opts.workspaceId);
    }
    return session;
  }

  async loadSession(
    agentId: string,
    sessionId: string,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      workspaceId?: string;
      cliBinary?: string;
    } = {},
  ): Promise<LoadSessionResponse> {
    const adapter = await this.adapterFor(agentId);
    const workspaceId =
      opts.workspaceId ?? this.sessionToWorkspace.get(sessionId);
    const cwd = resolveAgentCwd(opts.cwd, "loadSession", workspaceId);
    const designConnection = this.resolveDesignConnection(workspaceId);
    // Phase 4: same settings-env overlay + user-provider fallback as newSession,
    // so a resumed session gets the repo `env` table, `env_files`,
    // ZEROS_WORKTREE_PATH, and the user `[providers]` base_url/executable_path
    // fallback (couriered values win). The workspace-local layering applies here
    // too (see newSession).
    const mainRepoRoot = workspaceId
      ? getWorkspaceById(workspaceId)?.repoRoot
      : undefined;
    const merged = withDesignAgentGuards(
      withWorkspaceModeEnv(
        await withTargetBranchEnv(
          withWorktreeEnv(mergeSpawnEnv(cwd, opts.env, mainRepoRoot), cwd),
          workspaceId,
        ),
        workspaceId,
      ),
      agentId,
    );
    const spawn = applyUserProviderConfig(
      cwd,
      agentId,
      { env: merged, cliBinary: opts.cliBinary },
      mainRepoRoot,
    );
    const spawnEnv = designConnection
      ? { ...spawn.env, [DESIGN_MCP_TOKEN_ENV]: designConnection.bearerToken }
      : spawn.env;
    const instructionCtx = this.parseInstructionCtx(spawnEnv);
    const systemInstruction = this.nativeInstructionFor(
      adapter,
      cwd,
      instructionCtx,
    );
    const response = await adapter.loadSession({
      sessionId,
      cwd,
      env: spawnEnv,
      cliBinary: spawn.cliBinary,
      mcpServers: await this.resolveSessionMcp(
        agentId,
        cwd,
        mainRepoRoot,
        workspaceId,
        designConnection,
      ),
      ...(systemInstruction ? { systemInstruction } : {}),
    });
    const loadedSessionId = response.sessionId ?? sessionId;
    console.log(
      `[agents] ${agentId} loadSession: sessionId=${loadedSessionId} cwd=${cwd}` +
        (loadedSessionId !== sessionId
          ? ` requestedSessionId=${sessionId}`
          : "") +
        (workspaceId ? ` workspaceId=${workspaceId}` : "") +
        (systemInstruction ? " sysInstr=native" : ""),
    );
    if (loadedSessionId !== sessionId) {
      this.sessionToAgent.delete(sessionId);
      this.sessionToWorkspace.delete(sessionId);
      this.sessionToCwd.delete(sessionId);
      this.sessionToInstructionCtx.delete(sessionId);
      this.sessionsCwdHinted.delete(sessionId);
      this.sessionsInstructed.delete(sessionId);
    }
    this.sessionToAgent.set(loadedSessionId, agentId);
    this.sessionToCwd.set(loadedSessionId, cwd);
    this.sessionToInstructionCtx.set(loadedSessionId, instructionCtx);
    if (systemInstruction) {
      // NATIVE channel: the adapter attached the orientation on thread/resume
      // — and its degraded resume-→-fresh-thread fallback attaches it on the
      // fresh thread/start too — so BOTH resume shapes are covered. Never
      // re-inject in-band. (The cwd hint re-arm below still applies on a
      // fresh thread for non-self-aware agents.)
      this.sessionsInstructed.add(loadedSessionId);
      if (response.resumedFresh) this.sessionsCwdHinted.delete(loadedSessionId);
    } else if (response.resumedFresh) {
      // DEGRADED RESUME → the adapter couldn't resume and started a FRESH
      // thread/agent (Codex stale rollout, Cursor "agent not found", Claude
      // with no persisted session id). That transcript is empty, so the
      // preamble would be lost forever; re-arm the one-shot (delete, don't
      // add) so the next prompt() re-injects the workspace orientation + cwd
      // hint.
      this.sessionsInstructed.delete(loadedSessionId);
      this.sessionsCwdHinted.delete(loadedSessionId);
    } else {
      // TRUE RESUME → the first-turn <system_instruction> already rides in
      // the resumed transcript; pre-mark instructed so prompt() never
      // re-sends it.
      this.sessionsInstructed.add(loadedSessionId);
    }
    if (workspaceId) {
      this.sessionToWorkspace.set(loadedSessionId, workspaceId);
    }
    return response;
  }

  /** Tear down a single session's resources when its chat tab is closed.
   *  Clears the gateway's routing maps and asks the owning adapter to
   *  release the session's subprocess / server child / SDK agent +
   *  session dir. Without this, every started session leaked an
   *  on-disk session dir (+ a per-session Codex server child) until app
   *  quit. Best-effort: a teardown failure is logged, never thrown, so
   *  closing a tab can't surface an error. */
  async endSession(agentId: string, sessionId: string): Promise<void> {
    const resolvedAgentId = this.sessionToAgent.get(sessionId) ?? agentId;
    this.sessionToAgent.delete(sessionId);
    this.sessionToWorkspace.delete(sessionId);
    this.sessionToCwd.delete(sessionId);
    this.sessionsCwdHinted.delete(sessionId);
    this.sessionsInstructed.delete(sessionId);
    this.sessionToInstructionCtx.delete(sessionId);
    const adapter = this.adapters.get(resolvedAgentId);
    if (adapter?.disposeSession) {
      try {
        await adapter.disposeSession(sessionId);
      } catch (err) {
        console.warn(
          `[agents] ${resolvedAgentId} disposeSession(${sessionId}) failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  async listSessions(
    agentId: string,
    opts: { cwd?: string; cursor?: string | null } = {},
  ): Promise<ListSessionsResponse> {
    const adapter = await this.adapterFor(agentId);
    return adapter.listSessions({ cwd: opts.cwd, cursor: opts.cursor });
  }

  /** Prepend a one-shot working-directory note for agents that don't tell
   *  their own model the cwd (anything NOT in CWD_SELF_AWARE_AGENTS — today
   *  every active agent self-reports, so this is dormant insurance for a
   *  future backend). Without it such a model guesses a path on its first
   *  write, hits the wrong (often read-only) location, and only recovers after
   *  running `pwd`. First prompt per session only — the agent server keeps it
   *  in history. No-op when the agent self-reports, the session was already
   *  hinted, or no cwd is on file. */
  private withCwdHint(
    sessionId: string,
    resolvedAgentId: string,
    prompt: ContentBlock[],
  ): ContentBlock[] {
    if (CWD_SELF_AWARE_AGENTS.has(resolvedAgentId)) return prompt;
    if (this.sessionsCwdHinted.has(sessionId)) return prompt;
    const cwd = this.sessionToCwd.get(sessionId);
    if (!cwd) return prompt;
    this.sessionsCwdHinted.add(sessionId);
    const hint: ContentBlock = {
      type: "text",
      text:
        `<environment>\n` +
        `Your working directory is: ${cwd}\n` +
        `Use this absolute path (or paths under it) for all file operations ` +
        `unless explicitly told otherwise. Do NOT write to the filesystem root.\n` +
        `</environment>`,
    };
    return [hint, ...prompt];
  }

  /** Parse the inputs the first-turn system instruction needs, from the spawn
   *  env. `additionalDirectories` ride in ZEROS_ADDITIONAL_DIRS (renderer
   *  /add-dir, a JSON array). ZEROS_TARGET_BRANCH / ZEROS_PROMPTS_GENERAL are
   *  optional — once the Actions settings UI + spawn-env feed them they flow
   *  through here automatically; until then the preamble + /add-dir awareness
   *  still ship. Callers stash the result in sessionToInstructionCtx. */
  private parseInstructionCtx(env: Record<string, string> | undefined): {
    additionalDirectories: string[];
    targetBranch?: string;
    customInstructions?: string;
    mode: "code" | "design";
  } {
    const e = env ?? {};
    let dirs: string[] = [];
    const raw = e.ZEROS_ADDITIONAL_DIRS?.trim();
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          dirs = parsed.filter(
            (d): d is string => typeof d === "string" && d.trim() !== "",
          );
        }
      } catch {
        /* tolerate a malformed value — no extra dirs */
      }
    }
    return {
      additionalDirectories: dirs,
      targetBranch: e.ZEROS_TARGET_BRANCH?.trim() || undefined,
      customInstructions: e.ZEROS_PROMPTS_GENERAL || undefined,
      mode: e.ZEROS_CHAT_MODE === "design" ? "design" : "code",
    };
  }

  /** The first-turn instruction body for a NATIVE-channel adapter (see
   *  AgentAdapter.nativeSystemInstruction), or undefined for everyone else —
   *  those get the in-band <system_instruction> via withSystemInstruction(). */
  private nativeInstructionFor(
    adapter: AgentAdapter,
    cwd: string,
    ctx: ReturnType<AgentGateway["parseInstructionCtx"]>,
  ): string | undefined {
    if (!adapter.nativeSystemInstruction) return undefined;
    const body = buildFirstTurnInstructionBody({
      workspaceDir: cwd,
      targetBranch: ctx.targetBranch ?? null,
      additionalDirectories: ctx.additionalDirectories,
      customInstructions: ctx.customInstructions ?? null,
      mode: ctx.mode,
    });
    return body || undefined;
  }

  /** Prepend the one-shot first-turn <system_instruction> (workspace preamble +
   *  /add-dir awareness + repo `[prompts] general`) — the orientation an agent
   *  needs before its first tool call — for every agent WITHOUT a native
   *  instruction channel. Adapters
   *  declaring `nativeSystemInstruction` (Codex) get the same body on their
   *  protocol's instruction field at session create/resume instead, and are
   *  pre-marked instructed there. First prompt per NEW session only; a resumed
   *  session is pre-marked (the block already rides in its history). The text
   *  itself lives in @zeros/core/system-instructions (one editable home). */
  private withSystemInstruction(
    sessionId: string,
    prompt: ContentBlock[],
  ): ContentBlock[] {
    if (this.sessionsInstructed.has(sessionId)) return prompt;
    this.sessionsInstructed.add(sessionId);
    const cwd = this.sessionToCwd.get(sessionId);
    if (!cwd) return prompt;
    const ctx = this.sessionToInstructionCtx.get(sessionId);
    const block = buildFirstTurnSystemInstruction({
      workspaceDir: cwd,
      targetBranch: ctx?.targetBranch ?? null,
      additionalDirectories: ctx?.additionalDirectories ?? [],
      customInstructions: ctx?.customInstructions ?? null,
      mode: ctx?.mode ?? "code",
    });
    if (!block) return prompt;
    return [{ type: "text", text: block }, ...prompt];
  }

  async prompt(
    agentId: string,
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse> {
    const adapter = this.adapterForSession(sessionId, agentId);
    // First-turn orientation for EVERY agent (workspace preamble + /add-dir +
    // repo prompts.general), then the cwd hint for agents that don't self-report
    // their cwd. Both one-shot per session; system instruction goes outermost so
    // it's the very first block the model reads.
    const outgoing = this.withSystemInstruction(
      sessionId,
      this.withCwdHint(sessionId, adapter.agentId, prompt),
    );
    try {
      const { response } = await adapter.prompt({
        sessionId,
        prompt: outgoing,
      });
      // A clean prompt is the strongest possible signal that auth is
      // good — clear any prior failed-auth marker so the green dot
      // re-illuminates the moment the user resolves their login.
      this.markAuthOk(adapter.agentId);
      return response;
    } catch (err) {
      // Mark the agent auth-failed ONLY on an explicit `auth-required`
      // failure. The adapters already promote every real sign-in signal
      // to `auth-required` at the source — a stderr auth-hint match
      // (in the per-agent adapter) or an in-stream "you're not signed in"
      // chunk both throw `auth-required`, which still grays the dot here.
      //
      // The previous heuristic ALSO grayed the dot for any prompt-stage
      // `protocol-error`. That was wrong: a prompt-stage protocol-error
      // is the catch-all bucket for non-auth failures too — a double-send
      // ("a prompt is already in flight"), an unknown/stale session, a
      // watchdog kill on a slow first turn ("produced no output"), a
      // streaming schema-version mismatch, or a deleted cwd. Every one of
      // those falsely flipped the agent to amber "Sign in required" across
      // every agent (the single biggest multiplier behind the
      // cross-agent false-auth pills). Inferring auth from a generic
      // protocol-error is exactly the kind of guessing that should live in
      // the adapter (which has the stderr/stream context), not the gateway.
      const failure = (
        err as {
          failure?: { kind?: string; stage?: string };
        }
      ).failure;
      if (failure?.kind === "auth-required") {
        this.markAuthFailed(adapter.agentId);
      }
      throw err;
    }
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    await adapter.cancel({ sessionId });
  }

  async stopBackgroundTask(
    agentId: string,
    sessionId: string,
    taskId: string,
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    if (!adapter.stopBackgroundTask) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `agent ${adapter.agentId} does not support stopping background tasks`,
        stage: "stopBackgroundTask",
        agentId: adapter.agentId,
      });
    }
    await adapter.stopBackgroundTask({ sessionId, taskId });
  }

  /** Inject a user message into the running turn (mid-turn steering). No
   *  system-instruction / cwd-hint wrapping: those are first-turn one-shots
   *  and a steer is by definition never the first turn — leaving them
   *  unconsumed keeps them for the next real prompt. */
  async steer(
    agentId: string,
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    if (!adapter.steer) {
      throw new Error(`agent ${adapter.agentId} does not support steering`);
    }
    await adapter.steer({ sessionId, prompt });
  }

  async setMode(
    agentId: string,
    sessionId: string,
    modeId: string,
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    if (!adapter.setMode) {
      throw new Error(`agent ${adapter.agentId} does not support set-mode`);
    }
    await adapter.setMode({ sessionId, modeId });
  }

  /** Run a REAL context compaction on a live session (§3.5 Task A — Codex
   *  `thread/compact/start`). Progress streams back as the agent's own
   *  contextCompaction item (the two-state transcript row); this call just
   *  triggers it. */
  async compactContext(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    if (!adapter.compactContext) {
      throw new Error(`agent ${adapter.agentId} does not support compaction`);
    }
    await adapter.compactContext({ sessionId });
  }

  /** Change a live session's model (no rebuild). No-op for adapters that
   *  don't support live model selection — the choice still applies when the
   *  session is next (re)created from env. */
  async setModel(
    agentId: string,
    sessionId: string,
    model: string,
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    if (!adapter.setModel) return;
    await adapter.setModel({ sessionId, model });
  }

  /** Apply a mid-session config change (effort / fast / ultracode /
   *  additionalDirectories / allow-deny / maxTurns), carried as the full
   *  composer env map, to a live session (no rebuild). No-op for adapters
   *  that don't support live config changes — the choice still applies when
   *  the session is next (re)created from env. */
  async updateConfig(
    agentId: string,
    sessionId: string,
    env: Record<string, string>,
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    if (!adapter.updateConfig) return;
    await adapter.updateConfig({ sessionId, env });
  }

  answerPermission(
    permissionId: string,
    response: RequestPermissionResponse,
  ): void {
    // Permission IDs are uuids; at most one adapter will have it
    // pending. Fan out rather than tracking a permissionId→agent map
    // — simpler and avoids a second source of truth.
    for (const adapter of this.adapters.values()) {
      adapter.respondToPermission({ permissionId, response });
    }
  }

  answerQuestion(
    questionId: string,
    response: QuestionResponse,
    nativeRequestId?: string,
  ): void {
    // Twin of answerPermission — questionIds are uuids; fan out to whichever
    // adapter has it parked. Adapters without a blocking question channel
    // (Cursor) omit respondToQuestion → skipped. `nativeRequestId` is the
    // vendor-id fallback for answers whose questionId went stale (replay /
    // session rebuild).
    let handled = false;
    for (const adapter of this.adapters.values()) {
      if (
        adapter.respondToQuestion?.({ questionId, response, nativeRequestId })
      ) {
        handled = true;
      }
    }
    // A user's answer that NO adapter could deliver is the "answered but the
    // agent kept loading" bug — make it findable in the engine log even when
    // the per-adapter stderr lines are missed.
    if (!handled) {
      console.warn(
        `[agents] answerQuestion: no adapter had ${questionId} pending (native ${nativeRequestId ?? "-"}) — answer dropped`,
      );
    }
  }

  async dispose(): Promise<void> {
    const disposals = Array.from(this.adapters.values()).map((a) =>
      a.dispose().catch((err) => {
        console.warn(`[agents] ${a.agentId} dispose error:`, err);
      }),
    );
    await Promise.all(disposals);
    this.adapters.clear();
    this.sessionToAgent.clear();
    this.sessionToWorkspace.clear();
    this.sessionToCwd.clear();
    this.sessionsCwdHinted.clear();
    this.agentInitializes.clear();
    this.cachedAgents = null;
    this.cachedAgentsAt = null;
  }

  // ── Internals ─────────────────────────────────────────

  private async adapterFor(agentId: string): Promise<AgentAdapter> {
    const cached = this.adapters.get(agentId);
    if (cached) return cached;

    const entry = findAgent(agentId);
    if (!entry) throw new Error(`unknown agent id: ${agentId}`);

    // Session dir must exist before adapters write per-session config into
    // it (idempotent).
    await fsp.mkdir(sessionsRoot(), { recursive: true });

    const ctx: AgentAdapterContext = {
      projectRoot: this.projectRoot,
      // Phase 1: hand the SHARED, deduped registry view (mutated in place by
      // setMcpServers). Adapters read ctx.mcpServers lazily per session, so a
      // settings edit reaches each agent's next session live. Dedup (collapse
      // duplicate names/endpoints — matters for Cursor's ~40-tool cap) happens
      // in refreshMcpView; cross-native dedup needs the Phase 1b scanner. See
      // docs/mcp-consolidated-architecture-audit-and-test-plan-2026-06-30.md (§3, §12).
      mcpServers: this.mcpServersView,
      sessionDirRoot: sessionsRoot(),
      emit: this.events,
    };
    const adapter = entry.createAdapter(ctx);
    this.adapters.set(agentId, adapter);
    console.log(
      `[agents] adapter created: ${agentId} (live=[${Array.from(this.adapters.keys()).join(",")}])`,
    );
    return adapter;
  }

  /** Resolve the adapter responsible for a session id. The session→agent
   *  map wins over a caller-supplied agentId when both are present: the map
   *  is written at newSession/loadSession from the agentId that actually
   *  spawned the adapter, whereas a renderer-supplied agentId can be stale
   *  (e.g. after a close/reopen). The `?? agentId` fallback still covers the
   *  pre-session window before the map has an entry. Mirrors endSession so
   *  prompt/cancel/setMode and teardown all resolve a session identically. */
  private adapterForSession(sessionId: string, agentId?: string): AgentAdapter {
    const resolvedId = this.sessionToAgent.get(sessionId) ?? agentId;
    if (!resolvedId) {
      // No route AND no caller agentId — the renderer is holding a
      // sessionId we have no record of (almost always: the engine
      // restarted and this is a stale id from the previous process).
      // session-expired (recoverable) so the renderer re-establishes
      // instead of surfacing a hard "Agent error" toast.
      throw new AgentFailureError({
        kind: "session-expired",
        message: `unknown session: ${sessionId}`,
        stage: "prompt",
        agentId: agentId ?? "claude",
      });
    }
    const adapter = this.adapters.get(resolvedId);
    if (!adapter) {
      // Diagnostic: which adapters DO we have, and what's the routing
      // table look like? Without this the "adapter not live" error
      // gives the user a black-box failure with no recovery path.
      console.warn(
        `[agents] adapterForSession miss: agentId=${resolvedId} sessionId=${sessionId} ` +
          `live=[${Array.from(this.adapters.keys()).join(",")}] ` +
          `routes=${this.sessionToAgent.size}`,
      );
      // The adapter map is ONLY cleared by gateway.dispose() — i.e. the
      // engine process restarted (HMR respawn / watchdog / crash) and the
      // renderer is still pointed at a sessionId from the previous engine.
      // This is exactly the user's "send a 2nd message → claude: Agent
      // error — adapter not live" report. Classify it as session-expired
      // (recoverable) rather than a bare Error (which the renderer
      // classified as a NON-recoverable protocol-error and toasted). The
      // renderer's sendPrompt recovery then rebuilds the session and
      // retries the prompt transparently. See isRecoverable() in
      // src/zeros/bridge/failure.ts.
      throw new AgentFailureError({
        kind: "session-expired",
        message: `adapter not live: ${resolvedId}`,
        stage: "prompt",
        agentId: resolvedId,
      });
    }
    return adapter;
  }
}
