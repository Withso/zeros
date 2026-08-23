// ──────────────────────────────────────────────────────────
// AgentGateway — orchestrator for per-agent adapters
// ──────────────────────────────────────────────────────────
//
// Native agent gateway. Exposes the same public surface the engine
// entry point (apps/desktop/src/engine/zeros-engine.ts) already uses:
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
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";

// Resolve workspaceId → cwd before spawning.
// We import directly from the workspace state module (not the git
// barrel) to avoid pulling GitHub auth/Octokit wiring into the engine
// bundle.
import {
  designWorktreesRoot,
  getWorkspaceById,
  legacyWorktreesRoot,
  listWorkspaces,
  worktreesRoot,
} from "../git/state";
import { listKnownRepoRoots } from "../db/projects";
import { resolveWorkspaceTargetRef } from "../git/target-branch";
import { mergeSpawnEnv } from "../settings/spawn-env";
import { applyUserProviderConfig } from "../settings/provider-env";
import {
  assertSafeProspectiveDesignDirectory,
  discoverDesignDirectories,
  previewDesignDirectoryForEnter,
  reserveProspectiveDesignDirectory,
  resolveDesignDirectoryPointerState,
} from "../design/directory";
import {
  DESIGN_CANVAS_FILE,
  primeDesignDirectoryName,
} from "../design/directory-registry";
import {
  rememberRecognizedDesignDirectories,
  stickyRecognizedDesignDirectories,
} from "../design/recognition-store";
import {
  assertDesignDirHasNoHardlinkAliases,
  resolveDesignDirForLock,
} from "../files/design-lock";
import { repoSettingsPath, repoLocalSettingsPath } from "../settings/files";
import { runGit } from "../git/git-exec";
import {
  acquireZerosBrowserHost,
  browserUseEnabledForWorkspace,
  stripBrowserServiceCredentials,
} from "../browser/browser-tool-client";
import {
  AGENT_MANIFEST,
  bundledRuntimeVersion,
  findAgent,
  toBridgeAgents,
  type AgentVersionInfo,
  type AuthProbe,
} from "./registry";
import { removeSessionDir, sessionsRoot } from "./session-paths";
import {
  buildCodeAgentDesignTerritoryNotice,
  buildFirstTurnInstructionBody,
  buildFirstTurnSystemInstruction,
  wrapSystemInstruction,
} from "@zeros/protocol/system-instructions";
import {
  probeCliInstalled,
  evaluateAuthProbe,
  latestAuthFileMtimeMs,
  secretAccountFingerprint,
  probeCliCompatibility,
  clearVersionCache,
  type ProbeCommandRunner,
} from "./probes";
import type {
  AgentAdapter,
  AgentBrowserUse,
  AgentAdapterContext,
  AgentCapabilityPorts,
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
import type { AgentFilesystemTerritory } from "./types";
import type { AccountDetails, EnrichedRegistryAgent } from "../types";
import { AgentFailureError } from "./types";
import {
  advertiseAgentCapabilities,
  resolveAgentCapabilityPorts,
} from "./capabilities";
import { dedupeMcpServers, resolveMcpServersForRepo } from "./mcp-registry";
import {
  coerceProviderBinding,
  legacyProviderBinding,
  type ProviderBinding,
} from "@zeros/protocol/identities";
import {
  EXECUTION_BOUNDARY_PORTS_VERSION,
  type ExecutionBoundaryActor,
  type ExecutionBoundaryPortsSnapshot,
  type ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";
import { redactSensitive } from "@zeros/protocol/scrub";
import type { AgentProviderQuota } from "@zeros/protocol/agent-events";
import {
  AdmissionCancelledError,
  type BoundaryTerritoryContributionSnapshot,
  type BoundaryRequest,
  type ContainerWorkerRequest,
  type ExecutionBoundary,
  type PreparedBoundary,
} from "./containment/types";
import { ZsrExecutionBoundary } from "./containment/zsr-boundary";
import { UtilityBoundaryPool } from "./containment/utility-boundary-pool";
import { completeAgentSpawnEnv } from "./adapters/shared/config-isolation";
import { findOrbStackCli } from "./containment/macos-orbstack-container-worker";
import {
  localPreviewGatewayFactory,
  type BoundaryPreviewGateway,
  type BoundaryPreviewGatewayFactory,
  type ZsrPreviewTarget,
} from "./containment/zsr-preview-gateway";

/** Provider startup is a control-plane operation, not a model turn. Keep its
 * deadline below the renderer's 120s admission ceiling so the gateway still
 * has time to revoke capabilities, stop the adapter, and prove the kernel
 * boundary retired. Boundary preparation is intentionally outside this clock:
 * a qualified cold private-container path may take longer but is itself
 * bounded by its backend. */
const ADAPTER_START_TIMEOUT_MS = 90_000;

async function awaitAdapterStartup<T>(options: {
  readonly agentId: string;
  readonly stage: "newSession" | "loadSession" | "forkSession";
  readonly operation: Promise<T>;
  /** Promise.race does not cancel provider work. Reap any adapter allocation
   * that settles after the caller already received a timeout. */
  readonly onLateSettlement?: () => Promise<void>;
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const operation = options.operation.then(
    (value) => {
      if (timedOut && options.onLateSettlement) {
        void Promise.resolve()
          .then(options.onLateSettlement)
          .catch((error) => {
            console.warn(
              `[agents] ${options.agentId} ${options.stage} late-settlement ` +
                `cleanup failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
            );
          });
      }
      return value;
    },
    (error: unknown) => {
      if (timedOut && options.onLateSettlement) {
        void Promise.resolve()
          .then(options.onLateSettlement)
          .catch((cleanupError) => {
            console.warn(
              `[agents] ${options.agentId} ${options.stage} late-settlement ` +
                `cleanup failed: ${
                  cleanupError instanceof Error
                    ? cleanupError.message
                    : String(cleanupError)
                }`,
            );
          });
      }
      throw error;
    },
  );
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new AgentFailureError({
          kind: "timeout",
          stage: options.stage,
          agentId: options.agentId,
          message:
            `${options.agentId} ${options.stage} startup timed out after ` +
            `${Math.round(ADAPTER_START_TIMEOUT_MS / 1_000)} seconds.`,
          advice:
            "Retry once. If startup times out again, open the engine log and check the provider's contained-host diagnostics.",
        }),
      );
    }, ADAPTER_START_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundaryRequiresProviderAuthentication(
  agentId: string,
  error: unknown,
): boolean {
  if (agentId !== "claude" || !(error instanceof Error)) return false;
  return [
    "Claude OAuth refresh request was rejected",
    "Claude OAuth refresh token is unavailable",
    "Claude OAuth credential was invalid",
  ].some((message) => error.message.includes(message));
}

/** Select a local OCI implementation, never an ambient daemon endpoint. On
 * Linux the worker is launched later inside the already-projected ZSR domain,
 * so the executable has no more filesystem/network authority than the agent. */
export function deriveContainerWorker(
  env: Readonly<Record<string, string>> | undefined,
): ContainerWorkerRequest | undefined {
  if (!env) return undefined;
  if (process.platform === "darwin") {
    const executable = findOrbStackCli(env);
    return executable
      ? { runtime: "podman", backend: "orbstack-machine", executable }
      : undefined;
  }
  if (process.platform !== "linux") return undefined;
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, "podman");
    try {
      // Resolve symlinks before handing the path to the strict supervisor. The
      // target still runs as untrusted worker bytes inside ZSR.
      const executable = realpathSync(candidate);
      const metadata = lstatSync(executable);
      if (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.mode & 0o111
      ) {
        return {
          runtime: "podman",
          backend: "embedded-linux",
          executable,
        };
      }
    } catch {
      // Keep searching the exact PATH.
    }
  }
  return undefined;
}

/** Whether the normal child environment advertises a container workflow that
 * ZSR must preserve. Detection is intentionally capability-shaped: endpoint
 * variables and familiar CLIs count, but their ambient daemon authority is
 * never forwarded. */
export function expectsContainerWorkflow(
  env: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!env) return false;
  if (
    [
      "DOCKER_HOST",
      "CONTAINER_HOST",
      "DOCKER_CONTEXT",
      "PODMAN_HOST",
      "CONTAINER_CONNECTION",
    ].some((name) => Boolean(env[name]?.trim()))
  ) {
    return true;
  }
  const names = new Set([
    "docker",
    "podman",
    "docker-compose",
    "podman-compose",
  ]);
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        const executable = realpathSync(path.join(directory, name));
        const metadata = lstatSync(executable);
        if (
          metadata.isFile() &&
          !metadata.isSymbolicLink() &&
          (metadata.mode & 0o111) !== 0
        ) {
          return true;
        }
      } catch {
        // Continue through the trusted PATH snapshot.
      }
    }
  }
  return false;
}

function canonicalExecutable(candidate: string): string | null {
  try {
    const canonical = realpathSync(candidate);
    const metadata = lstatSync(canonical);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.platform !== "win32" && (metadata.mode & 0o111) === 0)
    ) {
      return null;
    }
    return canonical;
  } catch {
    return null;
  }
}

/** Resolve a provider command before the ZSR supervisor is launched. The
 * supervisor accepts only absolute commands, and Linux's hidden-root policy
 * must know the executable's exact read projection at admission time. */
function resolveProviderExecutable(
  binary: string,
  env: Readonly<Record<string, string>> | undefined,
): string | null {
  const value = binary.trim();
  if (!value || value.includes("\0")) return null;
  if (path.isAbsolute(value)) return canonicalExecutable(value);
  if (value.includes("/") || value.includes("\\")) return null;
  const extensions =
    process.platform === "win32"
      ? (env?.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.BAT;.CMD")
          .split(";")
          .filter(Boolean)
      : [""];
  for (const directory of (env?.PATH ?? process.env.PATH ?? "").split(
    path.delimiter,
  )) {
    if (!directory || !path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const resolved = canonicalExecutable(
        path.join(directory, value + extension),
      );
      if (resolved) return resolved;
    }
  }
  return null;
}

function normalizeProviderBinary(
  binary: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!binary?.trim() || !path.isAbsolute(binary.trim())) return binary;
  return resolveProviderExecutable(binary, env) ?? binary;
}

function normalizeProviderSpawn<
  T extends { env?: Record<string, string>; cliBinary?: string },
>(spawn: T): T {
  return {
    ...spawn,
    cliBinary: normalizeProviderBinary(spawn.cliBinary, spawn.env),
  };
}

export function agentTerritoryIdentity(
  territory: AgentFilesystemTerritory | undefined,
): string | null {
  if (!territory) return null;
  return JSON.stringify({
    role: territory.agentRole,
    workspaceRoot: path.resolve(territory.workspaceRoot),
    designDirectory: path.resolve(territory.designDirectory),
    protectedDesignDirectories: [...territory.protectedDesignDirectories]
      .map((candidate) => path.resolve(candidate))
      .sort(),
    // Part of the authority, so a change here must invalidate a resumed session
    // exactly like a change to the protected set: the recognition inputs are
    // what decide whether that set is still complete.
    designRecognitionPaths: [...territory.designRecognitionPaths]
      .map((candidate) => path.resolve(candidate))
      .sort(),
    deniedPaths: [...territory.writeCapabilities.deniedPaths]
      .map((candidate) => path.resolve(candidate))
      .sort(),
  });
}

const MAX_ADDITIONAL_TERRITORY_ROOTS = 32;

interface ResolvedTerritorySet {
  territory: AgentFilesystemTerritory | undefined;
  registeredDesignAuthorityIdentity: string | null;
  contributions: readonly BoundaryTerritoryContributionSnapshot[];
  additionalRoots: readonly string[];
  additionalGitWorkspaceRoots: readonly string[];
}

export interface RegisteredCodeTerritoryOwner {
  path: string;
  repoRoot: string;
}

function registeredOwnerRealpath(candidate: string): string | null {
  try {
    return realpathSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    // Permission, malformed-path, I/O, and descriptor-exhaustion failures do
    // not prove absence. Dropping that owner would make its Design tree
    // writable for this admission, so authority discovery fails closed.
    throw error;
  }
}

/** Physical local owners reachable by a host-parity code process. Worktree
 * rows and opened project roots are separate concepts in the DB; both must
 * feed the same deny union, while cloud rows name another filesystem namespace
 * and are intentionally absent. */
export function registeredCodeTerritorySnapshot(): {
  owners: RegisteredCodeTerritoryOwner[];
  workspaces: RegisteredCodeTerritoryOwner[];
} {
  const owners = new Map<string, RegisteredCodeTerritoryOwner>();
  const workspaces: RegisteredCodeTerritoryOwner[] = [];
  // Registry reads are authority discovery, not optional enrichment. Returning
  // a partial union after either query fails would silently make every omitted
  // Design root writable to a newly admitted code process.
  for (const workspace of listWorkspaces({ archived: false })) {
    if (workspace.placement === "cloud") continue;
    let repoRoot = path.resolve(workspace.repoRoot);
    const physicalRepoRoot = registeredOwnerRealpath(repoRoot);
    if (physicalRepoRoot) {
      repoRoot = physicalRepoRoot;
      owners.set(repoRoot, { path: repoRoot, repoRoot });
    } else {
      // A missing main checkout has no currently writable vnode. Resolve the
      // worktree independently below: one stale half of a workspace row must
      // not suppress the other live owner.
    }
    const workspacePath = registeredOwnerRealpath(workspace.path);
    if (workspacePath) {
      const worktree = { path: workspacePath, repoRoot };
      workspaces.push(worktree);
      owners.set(workspacePath, worktree);
    } else {
      // Stale worktree rows with no path contribute no currently reachable
      // vnode. The registry row itself was read successfully.
    }
  }
  for (const repoRoot of listKnownRepoRoots()) {
    const physicalRepoRoot = registeredOwnerRealpath(repoRoot);
    if (physicalRepoRoot) {
      owners.set(physicalRepoRoot, {
        path: physicalRepoRoot,
        repoRoot: physicalRepoRoot,
      });
    } else {
      // Stale project rows do not name a currently reachable vnode.
    }
  }
  return {
    owners: [...owners.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    workspaces: workspaces.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

function pathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Resolve missing managed roots through their deepest physical ancestor. A
 * newly-created sibling does not exist when an older boundary is admitted, so
 * exact `realpathSync(root)` with a lexical fallback would split aliases such
 * as macOS `/var` and `/private/var` at the security boundary. */
function canonicalProspectivePath(candidate: string): string {
  const missing: string[] = [];
  let cursor = path.resolve(candidate);
  for (;;) {
    try {
      const existing = realpathSync(cursor);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/** Stable collection-level subtraction for local actors. These parents
 * exist independently of the workspace registry, so a future sibling is
 * already read-only to every admitted boundary before Git creates it. */
export function protectedManagedWorkspaceDirectories(): string[] {
  return [worktreesRoot(), designWorktreesRoot(), legacyWorktreesRoot()]
    .map(canonicalProspectivePath)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .sort((left, right) => left.localeCompare(right));
}

export function isProtectedManagedWorkspacePath(
  candidate: string,
  protectedDirectories: readonly string[] = protectedManagedWorkspaceDirectories(),
): boolean {
  const canonical = canonicalProspectivePath(candidate);
  return protectedDirectories.some((directory) =>
    pathInsideOrEqual(canonical, directory),
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return pathInsideOrEqual(left, right) || pathInsideOrEqual(right, left);
}

function territoryForGrants(
  territory: AgentFilesystemTerritory | undefined,
  grants: readonly string[],
): AgentFilesystemTerritory | undefined {
  if (!territory) return undefined;
  const overlapsGrant = (candidate: string) =>
    grants.some((grant) => pathsOverlap(candidate, grant));
  const protectedDesignDirectories = territory.protectedDesignDirectories
    .filter(overlapsGrant)
    .map((candidate) => path.resolve(candidate))
    .sort();
  if (protectedDesignDirectories.length === 0) return undefined;
  const deniedPaths = territory.writeCapabilities.deniedPaths
    .filter(overlapsGrant)
    .map((candidate) => path.resolve(candidate))
    .sort();
  const active = protectedDesignDirectories.includes(
    path.resolve(territory.designDirectory),
  )
    ? path.resolve(territory.designDirectory)
    : protectedDesignDirectories[0]!;
  return {
    ...territory,
    designDirectory: active,
    protectedDesignDirectories: [...new Set(protectedDesignDirectories)],
    // Filtered by the same grant test as everything else. Carrying this list
    // through unfiltered would deny paths belonging to an owner the user did not
    // authorize for this session.
    designRecognitionPaths: [
      ...new Set(
        territory.designRecognitionPaths
          .filter(overlapsGrant)
          .map((candidate) => path.resolve(candidate)),
      ),
    ].sort(),
    writeCapabilities: {
      ...territory.writeCapabilities,
      deniedPaths: [...new Set(deniedPaths)],
    },
  };
}

export function mergeCodeAgentTerritories(
  workspaceRoot: string,
  primary: AgentFilesystemTerritory | undefined,
  additions: readonly AgentFilesystemTerritory[],
): AgentFilesystemTerritory | undefined {
  if (primary && additions.length === 0) return primary;
  const first = primary ?? additions[0];
  if (!first) return undefined;
  return {
    ...first,
    workspaceRoot,
    designDirectory: primary?.designDirectory ?? first.designDirectory,
    protectedDesignDirectories: [
      ...new Set(
        [primary, ...additions]
          .filter((entry): entry is AgentFilesystemTerritory => Boolean(entry))
          .flatMap((entry) => entry.protectedDesignDirectories)
          .map((candidate) => path.resolve(candidate)),
      ),
    ].sort(),
    // Unioned, not inherited from `first`: a secondary Git owner brings its own
    // `.zeros` settings directory and canvas markers, and spreading only the
    // primary's would leave that owner's Design folders de-registerable.
    designRecognitionPaths: [
      ...new Set(
        [primary, ...additions]
          .filter((entry): entry is AgentFilesystemTerritory => Boolean(entry))
          .flatMap((entry) => entry.designRecognitionPaths)
          .map((candidate) => path.resolve(candidate)),
      ),
    ].sort(),
    writeCapabilities: {
      workspace: "write",
      deniedPaths: [
        ...new Set(
          [primary, ...additions]
            .filter((entry): entry is AgentFilesystemTerritory =>
              Boolean(entry),
            )
            .flatMap((entry) => entry.writeCapabilities.deniedPaths)
            .map((candidate) => path.resolve(candidate)),
        ),
      ].sort(),
    },
  };
}

/** Identity of the filesystem subtraction itself, independent of which
 * workspace is the current process cwd. Repository tasks use this app-wide
 * value so an external owner change can retire them even when no chat session
 * exists to compare against. */
export function codeAgentWriteAuthorityIdentity(
  territory: AgentFilesystemTerritory | undefined,
): string | null {
  if (!territory) return null;
  return JSON.stringify({
    protectedDesignDirectories: [...territory.protectedDesignDirectories]
      .map((candidate) => path.resolve(candidate))
      .sort(),
    designRecognitionPaths: [...territory.designRecognitionPaths]
      .map((candidate) => path.resolve(candidate))
      .sort(),
    deniedPaths: [...territory.writeCapabilities.deniedPaths]
      .map((candidate) => path.resolve(candidate))
      .sort(),
  });
}

/** Pure snapshot of the Design subtraction shared by every local repository
 * task. Registry failures and invalid owners propagate: a partial identity
 * would make an old boundary look current and reopen writes. */
export async function previewRegisteredCodeWriteAuthorityIdentity(): Promise<
  string | null
> {
  const protectedWorkspaceDirectories = protectedManagedWorkspaceDirectories();
  const owners = registeredCodeTerritorySnapshot().owners.filter(
    (owner) =>
      !isProtectedManagedWorkspacePath(
        owner.path,
        protectedWorkspaceDirectories,
      ),
  );
  const territories: AgentFilesystemTerritory[] = [];
  for (const owner of owners) {
    const territory = await previewCodeAgentTerritory({
      cwd: owner.path,
      workspaceRoot: owner.path,
      repoRoot: owner.repoRoot,
    });
    if (territory) territories.push(territory);
  }
  const merged = mergeCodeAgentTerritories(
    owners[0]?.path ?? path.parse(process.cwd()).root,
    undefined,
    territories,
  );
  return codeAgentWriteAuthorityIdentity(merged);
}

async function canonicalAdditionalTerritoryRoots(
  candidates: readonly string[],
): Promise<string[]> {
  if (candidates.length > MAX_ADDITIONAL_TERRITORY_ROOTS) {
    throw new Error(
      `At most ${MAX_ADDITIONAL_TERRITORY_ROOTS} additional directories may be attached to one agent.`,
    );
  }
  const roots: string[] = [];
  for (const raw of candidates) {
    if (!path.isAbsolute(raw) || raw.includes("\0")) {
      throw new Error(
        "Additional directories must be absolute filesystem paths.",
      );
    }
    const lexical = path.resolve(raw);
    let canonical = lexical;
    try {
      const metadata = await fsp.lstat(lexical);
      if (!metadata.isDirectory()) {
        throw new Error("An additional directory is not a directory.");
      }
      canonical = await fsp.realpath(lexical);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // The normal provider contract permits a user-authorized future path.
      // It has no existing Design authority to discover yet; the immutable
      // boundary still grants only this exact prospective lexical location.
    }
    roots.push(canonical);
  }
  return [...new Set(roots)].sort((left, right) => left.localeCompare(right));
}

/** Every agent spawn must carry an
 *  explicit, non-empty cwd. The earlier silent fallback to engine
 *  projectRoot caused chats labelled with one project in the UI to spawn agents
 *  in the Zeros source tree because cwd resolution invisibly fell
 *  through. Validating here turns the bug into a surfaceable failure
 *  that routes through the existing error pill.
 *
 *  Callers may also pass a
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
  stage: "newSession" | "loadSession" | "forkSession",
  workspaceId?: string,
): string {
  // Prefer explicit cwd when supplied — the renderer knows where the
  // user is right now.
  if (typeof cwd === "string" && cwd.length > 0) {
    // Validate that the folder still exists before handing it to an
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
  const meta = init._meta;
  return (
    !!meta?.modelsDynamic &&
    !(Array.isArray(meta.models) && meta.models.length > 0)
  );
}

/** Resolve the active Design subtree for a code actor at admission time.
 * Missing Design content means there is no territory to carve out yet. An
 * existing target is validated segment-by-segment without following symlinks,
 * then every recognized real subtree is added to the immutable provider
 * profile. The provider sandbox is the promised boundary; the shared checkout
 * receives no persistent ACL. */
async function canonicalTerritoryWorkspaceRoot(opts: {
  cwd: string;
  workspaceRoot?: string;
}): Promise<string> {
  const cwd = path.resolve(opts.cwd);
  let root: string;
  if (opts.workspaceRoot) {
    root = path.resolve(opts.workspaceRoot);
  } else {
    try {
      const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
      root = path.resolve(stdout.trim());
    } catch {
      root = cwd;
    }
  }
  const relative = path.relative(root, cwd);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("The agent cwd is outside its canonical workspace.");
  }
  return root;
}

async function gitWorkspaceOwner(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
    const owner = stdout.trim();
    return owner ? path.resolve(owner) : null;
  } catch {
    return null;
  }
}

/** Provider profiles are keyed by physical absolute paths. Refuse a Design
 * session reached through a symlink or case alias instead of assuming every
 * provider canonicalizes allow and deny rules identically. Ordinary code-only
 * workspaces keep their historical behavior because this runs only after a
 * prospective Design subtree exists. */
async function assertCanonicalTerritoryPaths(
  workspaceRoot: string,
  cwd: string,
): Promise<void> {
  const lexicalCwd = path.resolve(cwd);
  const [physicalRoot, physicalCwd] = await Promise.all([
    fsp.realpath(workspaceRoot),
    fsp.realpath(lexicalCwd),
  ]);
  if (physicalRoot !== workspaceRoot || physicalCwd !== lexicalCwd) {
    throw new Error(
      "Design containment requires the canonical physical workspace and cwd paths; " +
        "reopen this workspace without a symlink or case alias.",
    );
  }
}

async function buildCodeAgentTerritory(opts: {
  cwd: string;
  workspaceRoot?: string;
  repoRoot?: string;
}): Promise<AgentFilesystemTerritory | undefined> {
  const workspaceRoot = await canonicalTerritoryWorkspaceRoot(opts);
  const repoRoot = path.resolve(opts.repoRoot ?? workspaceRoot);
  const pointer = await resolveDesignDirectoryPointerState({
    repoRoot,
    workspacePath: workspaceRoot,
  });
  if (!pointer.valid) {
    throw new Error(
      "The configured Design directory is not a safe repo-relative path.",
    );
  }
  // Engine memory of what previous admissions protected here. Both halves of the
  // repository evidence — the marker in Git's index/HEAD and the `[design]
  // directory` pointer — are agent-writable under host parity, so an agent that
  // removes them would otherwise hand the NEXT session an unprotected Design
  // folder. Sticky names are reported only while their directory still exists on
  // disk (see design/recognition-store.ts), so remembering can protect real
  // content but can never demand a folder the user legitimately deleted.
  const sticky = await stickyRecognizedDesignDirectories(workspaceRoot);
  // Publication happens only after the complete territory has been validated.
  // Priming before the existence check could turn a failed admission into
  // shared mutable registry state. The sticky names go in so the ACTIVE Design
  // name and the protected set are resolved from one universe.
  const designName = await previewDesignDirectoryForEnter(
    { path: workspaceRoot, repoRoot },
    { additionalRecognized: sticky },
  );
  const designDirectory = path.join(workspaceRoot, ...designName.split("/"));
  const recognized = [
    ...new Set([
      ...(await discoverDesignDirectories(workspaceRoot)),
      ...sticky,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const hasExistingOrRecognizedDesign =
    existsSync(designDirectory) || recognized.length > 0;

  // A caller-provided outer workspace cannot erase a more-specific Git
  // owner's Design policy. Git treats nested repositories/submodules as
  // separate control planes, and the outer index does not enumerate their
  // markers. Refuse the ambiguous bind whenever either owner carries Design
  // authority; the chat must be rebound to the exact owner so settings, Git
  // metadata, and the protected subtree are resolved as one unit. Preserve
  // historical behavior for genuinely code-only nested folders.
  const cwdOwner = await gitWorkspaceOwner(opts.cwd);
  if (cwdOwner && cwdOwner !== workspaceRoot) {
    const nestedPointer = await resolveDesignDirectoryPointerState({
      repoRoot: cwdOwner,
      workspacePath: cwdOwner,
    });
    const nestedRecognized = await discoverDesignDirectories(cwdOwner);
    const nestedTarget = path.join(
      cwdOwner,
      ...nestedPointer.directory.split("/"),
    );
    const nestedHasDesign =
      nestedPointer.configured ||
      existsSync(nestedTarget) ||
      nestedRecognized.length > 0;
    if (
      hasExistingOrRecognizedDesign ||
      pointer.configured ||
      nestedHasDesign
    ) {
      await assertCanonicalTerritoryPaths(workspaceRoot, opts.cwd);
      throw new Error(
        "The agent cwd belongs to a nested Git owner that differs from the " +
          "declared workspace; bind the chat to that exact repository before " +
          "starting a Design-contained code agent.",
      );
    }
  }
  if (!hasExistingOrRecognizedDesign && !pointer.configured) return undefined;

  await assertCanonicalTerritoryPaths(workspaceRoot, opts.cwd);

  const protectedDesignNames = [
    ...new Set([
      designName,
      ...(pointer.configured ? [pointer.directory] : []),
      ...recognized,
    ]),
  ];
  const protectedDesignDirectories: string[] = [];
  let verifiedActiveName = designName;
  for (const candidate of protectedDesignNames) {
    const candidatePath = path.join(workspaceRoot, ...candidate.split("/"));
    if (!existsSync(candidatePath)) {
      if (recognized.includes(candidate)) {
        throw new Error(
          `The recognized Design folder "${candidate}" is missing from this checkout; ` +
            "finish or revert the filesystem/Git transition before starting a code agent.",
        );
      }
      if (pointer.configured && candidate === pointer.directory) {
        await assertSafeProspectiveDesignDirectory(workspaceRoot, candidate);
        protectedDesignDirectories.push(candidatePath);
        continue;
      }
      throw new Error(
        `The active Design folder "${candidate}" is missing from this checkout.`,
      );
    }
    const verified = await resolveDesignDirForLock(workspaceRoot, candidate);
    await assertDesignDirHasNoHardlinkAliases(workspaceRoot, verified);
    if (candidate === designName) verifiedActiveName = verified;
    protectedDesignDirectories.push(
      path.join(workspaceRoot, ...verified.split("/")),
    );
  }

  // A Git index is one monolithic file: no OS sandbox can permit "stage code"
  // while forbidding "stage Design" inside that same index.
  //
  // Host parity keeps canonical Git metadata writable so normal staging,
  // commits, fetches, and pushes work. The consequences are explicit: a commit
  // can carry synthetic Design content into history, and mixed native path
  // operations may update code before the Design write is refused. Design bytes
  // in the worktree remain protected by the actor fence.
  const gitMetadata = new Set<string>();
  const dotGit = path.join(workspaceRoot, ".git");
  if (existsSync(dotGit)) gitMetadata.add(dotGit);
  for (const arg of ["--absolute-git-dir", "--git-common-dir"] as const) {
    try {
      const { stdout } = await runGit(workspaceRoot, ["rev-parse", arg]);
      const value = stdout.trim();
      if (value) {
        gitMetadata.add(
          path.resolve(
            path.isAbsolute(value) ? value : path.join(workspaceRoot, value),
          ),
        );
      }
    } catch {
      // discoverDesignDirectories already established the repository identity;
      // a failure here is not safely ignorable because it would reopen Git.
      throw new Error(
        "Couldn't resolve read-only Git metadata for this workspace.",
      );
    }
  }
  // What decides, for the NEXT session, whether these folders are Design at all:
  // the `.zeros` settings directories that hold the `[design] directory` pointer,
  // and the `.zeros-canvas.json` markers Git recognition reads. Host parity
  // leaves them writable because they are committed repository content; denying
  // `.zeros/settings.toml` broke any `git pull` that had to rewrite it) and closes
  // de-registration in engine state instead, via design/recognition-store.ts.
  const designRecognitionPaths = [
    path.dirname(repoSettingsPath(workspaceRoot)),
    ...(repoRoot !== workspaceRoot
      ? [path.dirname(repoLocalSettingsPath(repoRoot))]
      : []),
    ...protectedDesignDirectories.map((directory) =>
      path.join(directory, DESIGN_CANVAS_FILE),
    ),
  ];
  const deniedPaths = [
    ...protectedDesignDirectories,
    ...designRecognitionPaths,
    ...gitMetadata,
  ];
  return {
    agentRole: "code",
    workspaceRoot,
    designDirectory: path.join(workspaceRoot, ...verifiedActiveName.split("/")),
    protectedDesignDirectories: [...protectedDesignDirectories].sort(),
    designRecognitionPaths: [
      ...new Set(designRecognitionPaths.map((entry) => path.resolve(entry))),
    ].sort(),
    writeCapabilities: {
      workspace: "write",
      deniedPaths: [
        ...new Set(deniedPaths.map((candidate) => path.resolve(candidate))),
      ].sort(),
    },
  };
}

/** Pure authority preview for lifecycle invalidations. It validates the same
 * real tree and hard-link precondition as admission, but does not publish a
 * pointer or mutate shared filesystem permissions. */
export async function previewCodeAgentTerritory(opts: {
  cwd: string;
  workspaceRoot?: string;
  repoRoot?: string;
}): Promise<AgentFilesystemTerritory | undefined> {
  return buildCodeAgentTerritory(opts);
}

export async function resolveCodeAgentTerritory(opts: {
  cwd: string;
  workspaceRoot?: string;
  repoRoot?: string;
}): Promise<AgentFilesystemTerritory | undefined> {
  let territory = await buildCodeAgentTerritory(opts);
  if (!territory) return undefined;
  const absentProtectedDirectories =
    territory.protectedDesignDirectories.filter(
      (candidate) => !existsSync(candidate),
    );
  for (const candidate of absentProtectedDirectories) {
    const relative = path
      .relative(territory.workspaceRoot, candidate)
      .split(path.sep)
      .join("/");
    await reserveProspectiveDesignDirectory(territory.workspaceRoot, relative);
  }
  // Reservation changes the path from prospective authority to a real vnode.
  // Re-run every recognition, canonicalization, hard-link and Git-metadata
  // check against that exact tree before publishing it or starting a provider.
  if (absentProtectedDirectories.length > 0) {
    territory = await buildCodeAgentTerritory(opts);
    if (!territory) {
      throw new Error(
        "The Design territory disappeared while its isolation lease was established.",
      );
    }
  }
  const activeName = path
    .relative(territory.workspaceRoot, territory.designDirectory)
    .split(path.sep)
    .join("/");
  primeDesignDirectoryName(territory.workspaceRoot, activeName);
  // Remember what this admission actually protected, so a later session still
  // protects it after the repository evidence is edited away. Only the resolve
  // path records — a preview must leave engine state alone — and the store drops
  // names whose directory no longer exists, so this cannot accumulate demands for
  // folders the user has deleted.
  await rememberRecognizedDesignDirectories(
    territory.workspaceRoot,
    territory.protectedDesignDirectories.map((directory) =>
      path
        .relative(territory!.workspaceRoot, directory)
        .split(path.sep)
        .join("/"),
    ),
  );
  return territory;
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

export class AgentGateway {
  private readonly projectRoot: string;
  private readonly events: AgentGatewayEvents;
  private readonly executionBoundary: ExecutionBoundary;
  private readonly previewGatewayFactory: BoundaryPreviewGatewayFactory;

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
  private readonly executionToAgent = new Map<string, string>();
  /** Track which workspace each session belongs
   *  to so adapter callbacks can look it up (e.g. for the background-
   *  rename hook in follow-up C). Sessions without a workspaceId
   *  (chats spawned from a plain folder) simply have no entry here. */
  private readonly executionToWorkspace = new Map<string, string>();
  /** Resolved cwd (worktree path) per session — so `prompt()` can tell an
   *  agent that doesn't self-report its cwd where it is. Set at
   *  newSession/loadSession, cleared on endSession/dispose. */
  private readonly executionToCwd = new Map<string, string>();
  /** Immutable Design boundary captured when the session is admitted. A null
   * entry is intentional: if a Design directory appears or the pointer moves
   * later, the session must be rebuilt rather than silently gaining a new
   * authority map. */
  private readonly executionToDesignDirectory = new Map<
    string,
    string | null
  >();
  /** Canonical serialized write map captured at admission. The engine uses
   * this to decide whether an external settings/Git event changed authority
   * and therefore requires session retirement. */
  private readonly executionToTerritoryIdentity = new Map<
    string,
    string | null
  >();
  /** Per-owner slices of a multi-root territory. The merged identity above is
   * useful for diagnostics; these slices are what make a Design transition in
   * an attached workspace invalidate the otherwise unrelated primary cwd. */
  private readonly executionToTerritoryContributions = new Map<
    string,
    readonly BoundaryTerritoryContributionSnapshot[]
  >();
  /** Territory snapshots are published as soon as resolution completes, before
   * MCP lookup or kernel-boundary preparation can yield. External Design
   * reconciliation can therefore compare a racing admission with the exact
   * owner state it captured instead of conservatively restarting it. */
  private readonly provisionalTerritoryContributions = new Map<
    string,
    readonly BoundaryTerritoryContributionSnapshot[]
  >();
  /** Redacted status paired with the exact execution admission. */
  private readonly executionToBoundaryStatus = new Map<
    string,
    ExecutionBoundaryStatus
  >();
  /** Live outer boundary per Zeros execution. It is installed before adapter
   * startup and revoked before any adapter teardown can run user code. */
  private readonly executionBoundaries = new Map<string, PreparedBoundary>();
  /** A rejected teardown proof is a runtime-wide admission hold. Keeping both
   * the boundary and failure makes lifecycle retries fail closed; a restart is
   * required so durable process-domain recovery can prove the orphan empty. */
  private readonly failedBoundaryRetirements = new Map<string, unknown>();
  /** Detach diagnostic observers before a session boundary is retired. */
  private readonly boundaryPortSubscriptions = new Map<string, () => void>();
  /** Capability-authenticated browser façades, keyed by execution then the
   * redacted port id. Promises dedupe simultaneous Open Preview clicks. */
  private readonly boundaryPreviews = new Map<
    string,
    Map<string, Promise<BoundaryPreviewGateway>>
  >();
  /** Main-checkout root used by layered settings for each live execution.
   * Plain-folder chats have no entry. */
  private readonly executionToMainRepoRoot = new Map<string, string>();
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
  /** A true resume predating the Design boundary already contains the general
   * first-turn preamble but not necessarily the current immutable territory.
   * Re-assert only the security notice on the first post-load turn. */
  private readonly sessionsTerritoryNoticePending = new Set<string>();
  private readonly executionToInstructionCtx = new Map<
    string,
    {
      additionalDirectories: string[];
      targetBranch?: string;
      customInstructions?: string;
      designDirectory?: string;
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

  /** Adapter startups still in flight, keyed by executionId. The engine
   *  publishes an executionId (and the renderer may persist or reuse it)
   *  before the adapter finishes registering the live session, so a prompt
   *  can legally arrive during that window — most visibly for Cursor, whose
   *  host boot is the slowest and whose prompt path refuses ids it has not
   *  registered ("no live session"). Prompt-shaped calls await the flight
   *  instead of failing on that transient gap. */
  private readonly adapterStartupFlights = new Map<
    string,
    { readonly promise: Promise<void>; readonly settle: () => void }
  >();

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

  /** True when at least one live session in this workspace was admitted under
   * a different immutable filesystem map. Used only to avoid unnecessary
   * retirements after broad Git/settings invalidations. */
  workspaceTerritoryChanged(
    workspaceId: string,
    workspaceRoot: string,
    territory: AgentFilesystemTerritory | undefined,
  ): boolean {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const next = agentTerritoryIdentity(territory);
    const candidates = new Set([
      ...this.executionToAgent.keys(),
      ...this.executionToTerritoryContributions.keys(),
      ...this.provisionalTerritoryContributions.keys(),
    ]);
    for (const sessionId of candidates) {
      const contribution = (
        this.executionToTerritoryContributions.get(sessionId) ??
        this.provisionalTerritoryContributions.get(sessionId)
      )?.find(
        (candidate) =>
          path.resolve(candidate.workspaceRoot) === normalizedWorkspace,
      );
      if (contribution) {
        const nextContribution = contribution.full
          ? territory
          : territoryForGrants(territory, contribution.grants);
        if (
          contribution.identity !== agentTerritoryIdentity(nextContribution)
        ) {
          return true;
        }
        continue;
      }
      const owner = this.executionToWorkspace.get(sessionId);
      const cwd = this.executionToCwd.get(sessionId);
      const relative = cwd
        ? path.relative(normalizedWorkspace, path.resolve(cwd))
        : "..";
      const belongsByPath =
        relative === "" ||
        (relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative));
      if (owner !== workspaceId && !belongsByPath) continue;
      if ((this.executionToTerritoryIdentity.get(sessionId) ?? null) !== next) {
        return true;
      }
    }
    return false;
  }

  /** Execution ids whose immutable authority depends on this workspace,
   * including sessions that attached it through `/add-dir`. The engine uses
   * this during a Design transition so the capability is revoked before the
   * pointer or recognized-root set changes. */
  workspaceSessionIds(workspaceId: string, workspaceRoot: string): string[] {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const sessions: string[] = [];
    const candidates = new Set([
      ...this.executionToAgent.keys(),
      ...this.executionToTerritoryContributions.keys(),
      ...this.provisionalTerritoryContributions.keys(),
    ]);
    for (const sessionId of candidates) {
      if (this.executionToWorkspace.get(sessionId) === workspaceId) {
        sessions.push(sessionId);
        continue;
      }
      const contributions =
        this.executionToTerritoryContributions.get(sessionId) ??
        this.provisionalTerritoryContributions.get(sessionId) ??
        [];
      if (
        contributions.some(
          (candidate) =>
            path.resolve(candidate.workspaceRoot) === normalizedWorkspace,
        )
      ) {
        sessions.push(sessionId);
        continue;
      }
      const cwd = this.executionToCwd.get(sessionId);
      if (cwd && pathInsideOrEqual(cwd, normalizedWorkspace)) {
        sessions.push(sessionId);
      }
    }
    return [...new Set(sessions)].sort();
  }

  workspaceHasSessions(workspaceId: string, workspaceRoot: string): boolean {
    return this.workspaceSessionIds(workspaceId, workspaceRoot).length > 0;
  }

  private async withProvisionalTerritory<T>(
    executionId: string,
    contributions: readonly BoundaryTerritoryContributionSnapshot[],
    run: () => Promise<T>,
  ): Promise<T> {
    this.provisionalTerritoryContributions.set(executionId, contributions);
    try {
      return await run();
    } finally {
      this.provisionalTerritoryContributions.delete(executionId);
    }
  }

  /** Establish the code actor's immutable territory before an adapter starts.
   * The instruction remains behavioral defense in depth; the provider-neutral
   * ZSR boundary prepared below is the actual admission boundary. */
  private async prepareCodeAgentTerritory(
    adapter: AgentAdapter,
    cwd: string,
    workspaceRoot: string | undefined,
    mainRepoRoot: string | undefined,
    stage: "newSession" | "loadSession" | "forkSession",
    opts?: { cliBinary?: string; persistRecognition?: boolean },
  ): Promise<AgentFilesystemTerritory | undefined> {
    let territory: AgentFilesystemTerritory | undefined;
    try {
      const resolveTerritory =
        opts?.persistRecognition === false
          ? previewCodeAgentTerritory
          : resolveCodeAgentTerritory;
      territory = await resolveTerritory({
        cwd,
        workspaceRoot,
        repoRoot: mainRepoRoot,
      });
    } catch (error) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message:
          `Code agent cannot start because the active Design territory ` +
          `could not be resolved and protected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        stage,
        agentId: adapter.agentId,
        advice:
          "Fix the Design directory setting or its filesystem permissions, then retry.",
      });
    }
    return territory;
  }

  /** Extend the primary immutable territory across every registered local
   * checkout and every user-authorized `/add-dir` owner before a provider
   * process exists. Host parity means an agent can otherwise walk to any of
   * those paths, so Design protection must be app-wide even though ordinary
   * write grants remain unchanged. A second Zeros/Git workspace is not an
   * implicit additional directory: only its Design roots are subtracted unless
   * the user explicitly attached it. Resolving by the physical Git owner also
   * covers a selected subdirectory of that workspace.
   *
   * Contributions remain separate for lifecycle comparison. This lets a
   * Design transition in an attached workspace retire the primary session
   * even though its cwd belongs elsewhere. */
  private async resolveTerritorySet(
    primary: AgentFilesystemTerritory | undefined,
    cwd: string,
    workspaceRoot: string | undefined,
    env: Record<string, string> | undefined,
    stage: "newSession" | "loadSession" | "forkSession",
    options: { persistRecognition?: boolean } = {},
  ): Promise<ResolvedTerritorySet> {
    const canonicalWorkspace = path.resolve(
      primary?.workspaceRoot ??
        (await canonicalTerritoryWorkspaceRoot({ cwd, workspaceRoot })),
    );
    let additionalRoots: string[];
    try {
      additionalRoots = await canonicalAdditionalTerritoryRoots(
        this.parseInstructionCtx(env).additionalDirectories,
      );
    } catch (error) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage,
        message: `Code agent cannot attach the requested directories: ${
          error instanceof Error ? error.message : String(error)
        }`,
        advice: "Remove the invalid linked directory and retry.",
      });
    }

    const contributions = new Map<
      string,
      {
        grants: Set<string>;
        full: boolean;
        territory?: AgentFilesystemTerritory;
      }
    >();
    contributions.set(canonicalWorkspace, {
      grants: new Set([canonicalWorkspace]),
      full: true,
      ...(primary ? { territory: primary } : {}),
    });

    const registered = registeredCodeTerritorySnapshot();
    const registeredWorkspaces = registered.workspaces;
    const protectedWorkspaceDirectories =
      protectedManagedWorkspaceDirectories();
    const exactRegisteredOwners = registered.owners.filter(
      (owner) =>
        !isProtectedManagedWorkspacePath(
          owner.path,
          protectedWorkspaceDirectories,
        ),
    );
    const exactRegisteredOwnerPaths = new Set(
      exactRegisteredOwners.map((owner) => owner.path),
    );
    const registeredTerritories: AgentFilesystemTerritory[] = [];
    if (primary && exactRegisteredOwnerPaths.has(canonicalWorkspace)) {
      registeredTerritories.push(primary);
    }
    const ownerGrants = new Map<
      string,
      {
        grants: Set<string>;
        repoRoot: string;
        full: boolean;
        attached: boolean;
      }
    >();
    const addOwnerGrant = (
      owner: string,
      repoRoot: string,
      grant: string,
      opts: { full?: boolean; attached?: boolean } = {},
    ) => {
      if (owner === canonicalWorkspace) return;
      const current = ownerGrants.get(owner) ?? {
        grants: new Set<string>(),
        repoRoot,
        full: false,
        attached: false,
      };
      current.grants.add(grant);
      current.full ||= opts.full === true;
      current.attached ||= opts.attached === true;
      ownerGrants.set(owner, current);
    };
    // These are deny-only contributions. Do not add them to `additionalRoots`
    // or `additionalGitWorkspaceRoots`: registration in Zeros is not a write
    // grant from one workspace to another.
    for (const owner of exactRegisteredOwners) {
      addOwnerGrant(owner.path, owner.repoRoot, owner.path, { full: true });
    }
    for (const root of additionalRoots) {
      let owner = root;
      try {
        owner = (await gitWorkspaceOwner(root)) ?? root;
        owner = await fsp.realpath(owner);
      } catch {
        // A prospective/non-Git directory has no semantic owner yet. Its exact
        // lexical grant is still represented so a later registered transition
        // can invalidate a resumed execution rather than widening it.
        owner = root;
      }
      const registeredOwner = registered.owners.find(
        (candidate) => candidate.path === owner,
      );
      addOwnerGrant(owner, registeredOwner?.repoRoot ?? owner, root, {
        attached: true,
      });
      // A browsed parent can contain multiple managed workspaces. Every one is
      // a separate Design authority even though `git rev-parse` at the parent
      // cannot discover its nested repositories.
      for (const workspace of registeredWorkspaces) {
        if (pathInsideOrEqual(workspace.path, root)) {
          addOwnerGrant(workspace.path, workspace.repoRoot, root, {
            attached: true,
          });
        }
      }
      // Open project roots can also sit below a browsed parent. Managed roots
      // were omitted from the default exact deny union above, so re-add every
      // explicitly covered owner as a grant-scoped contribution before its
      // exact writable island is reopened in the ZSR policy.
      for (const registeredOwner of registered.owners) {
        if (
          isProtectedManagedWorkspacePath(
            registeredOwner.path,
            protectedWorkspaceDirectories,
          ) &&
          pathsOverlap(registeredOwner.path, root)
        ) {
          addOwnerGrant(registeredOwner.path, registeredOwner.repoRoot, root, {
            attached: true,
          });
        }
      }
    }

    const additions: AgentFilesystemTerritory[] = [];
    const additionalGitWorkspaceRoots: string[] = [];
    const resolveTerritory =
      options.persistRecognition === false
        ? previewCodeAgentTerritory
        : resolveCodeAgentTerritory;
    try {
      for (const [owner, ownerGrant] of [...ownerGrants].sort(
        ([left], [right]) => left.localeCompare(right),
      )) {
        const grants = [...ownerGrant.grants].sort((left, right) =>
          left.localeCompare(right),
        );
        const ownerTerritory = await resolveTerritory({
          cwd: owner,
          workspaceRoot: owner,
          repoRoot: ownerGrant.repoRoot,
        });
        const contribution = ownerGrant.full
          ? ownerTerritory
          : territoryForGrants(ownerTerritory, grants);
        if (contribution) {
          additions.push(contribution);
          if (exactRegisteredOwnerPaths.has(owner)) {
            registeredTerritories.push(contribution);
          }
          if (ownerGrant.attached && existsSync(path.join(owner, ".git"))) {
            additionalGitWorkspaceRoots.push(owner);
          }
        }
        contributions.set(owner, {
          grants: new Set(grants),
          full: ownerGrant.full,
          ...(contribution ? { territory: contribution } : {}),
        });
      }
    } catch (error) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage,
        message:
          `Code agent cannot start because a registered or attached directory's Design ` +
          `territory could not be resolved and protected: ${
            error instanceof Error ? error.message : String(error)
          }`,
        advice:
          "Fix the registered workspace's Design directory or remove the invalid linked directory, then retry.",
      });
    }

    return {
      territory: mergeCodeAgentTerritories(
        canonicalWorkspace,
        primary,
        additions,
      ),
      registeredDesignAuthorityIdentity: codeAgentWriteAuthorityIdentity(
        mergeCodeAgentTerritories(
          canonicalWorkspace,
          undefined,
          registeredTerritories,
        ),
      ),
      additionalRoots,
      additionalGitWorkspaceRoots: additionalGitWorkspaceRoots.sort(
        (left, right) => left.localeCompare(right),
      ),
      contributions: [...contributions]
        .map(([owner, contribution]) => ({
          workspaceRoot: owner,
          grants: [...contribution.grants].sort((left, right) =>
            left.localeCompare(right),
          ),
          full: contribution.full,
          identity: agentTerritoryIdentity(contribution.territory),
        }))
        .sort((left, right) =>
          left.workspaceRoot.localeCompare(right.workspaceRoot),
        ),
    };
  }

  private async assertAdditionalTerritorySetStillCurrent(
    expected: ResolvedTerritorySet,
    adapter: AgentAdapter,
    cwd: string,
    workspaceRoot: string | undefined,
    mainRepoRoot: string | undefined,
    env: Record<string, string> | undefined,
    stage: "newSession" | "loadSession" | "forkSession",
  ): Promise<void> {
    // Re-read the primary owner too. Reusing the pre-admission object here
    // checked only secondary registered owners and missed a pointer/marker
    // change in the workspace whose process was about to start.
    const primary = await this.prepareCodeAgentTerritory(
      adapter,
      cwd,
      workspaceRoot,
      mainRepoRoot,
      stage,
      { persistRecognition: false },
    );
    const current = await this.resolveTerritorySet(
      primary,
      cwd,
      workspaceRoot,
      env,
      stage,
      { persistRecognition: false },
    );
    this.assertTerritorySetsEqual(expected, current, stage);
  }

  private assertTerritorySetsEqual(
    expected: ResolvedTerritorySet,
    current: ResolvedTerritorySet,
    stage: "newSession" | "loadSession" | "forkSession",
  ): void {
    const expectedIdentity = JSON.stringify({
      territory: agentTerritoryIdentity(expected.territory),
      registeredDesignAuthorityIdentity:
        expected.registeredDesignAuthorityIdentity,
      contributions: expected.contributions,
      additionalRoots: expected.additionalRoots,
      additionalGitWorkspaceRoots: expected.additionalGitWorkspaceRoots,
    });
    const currentIdentity = JSON.stringify({
      territory: agentTerritoryIdentity(current.territory),
      registeredDesignAuthorityIdentity:
        current.registeredDesignAuthorityIdentity,
      contributions: current.contributions,
      additionalRoots: current.additionalRoots,
      additionalGitWorkspaceRoots: current.additionalGitWorkspaceRoots,
    });
    if (expectedIdentity !== currentIdentity) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage,
        message:
          "A registered workspace's Design territory changed while the code boundary was being prepared.",
        advice: "Retry once the Design territory transition finishes.",
      });
    }
  }

  private async boundaryRequest(
    executionId: string,
    cwd: string,
    workspaceRoot: string | undefined,
    territory: AgentFilesystemTerritory | undefined,
    env: Record<string, string> | undefined,
    providerId: string | undefined,
    mcpServers: readonly McpServerRegistration[],
    resolvedAdditionalRoots?: readonly string[],
    additionalGitWorkspaceRoots: readonly string[] = [],
    includeSessionCapabilities = true,
    providerResumeId?: string,
    // Everything the gateway admits today is a code actor. A design actor
    // reaches the same boundary with code authority subtracted instead of
    // Design authority; the policy builder owns that difference, so the only
    // thing the caller chooses is which side of the contract it is on.
    actor: ExecutionBoundaryActor = "agent-code",
  ): Promise<BoundaryRequest> {
    const canonicalWorkspace =
      territory?.workspaceRoot ??
      (await canonicalTerritoryWorkspaceRoot({ cwd, workspaceRoot }));
    const additionalReadWriteRoots = resolvedAdditionalRoots
      ? [...resolvedAdditionalRoots]
      : await canonicalAdditionalTerritoryRoots(
          this.parseInstructionCtx(env).additionalDirectories,
        );
    const registeredSnapshot = registeredCodeTerritorySnapshot();
    const registeredCodeOwners = registeredSnapshot.owners.map(
      (owner) => owner.path,
    );
    // Both halves of the inverse authority model pre-deny managed workspace
    // collections. Code actors reopen their own checkout; Design actors reopen
    // only discovered Design islands. This keeps a future sibling protected
    // from every already-admitted actor before Git creates it.
    const protectedWorkspaceDirectories =
      protectedManagedWorkspaceDirectories();
    const protectedWorkspaceWriteDirectories =
      actor !== "design-agent"
        ? registeredSnapshot.owners
            .map((owner) => owner.path)
            .filter((owner) =>
              protectedWorkspaceDirectories.some(
                (directory) =>
                  owner !== directory && pathInsideOrEqual(owner, directory),
              ),
            )
            .filter((owner) =>
              additionalReadWriteRoots.some((grant) =>
                pathInsideOrEqual(owner, grant),
              ),
            )
            .sort((left, right) => left.localeCompare(right))
        : [];
    let effectiveTerritory = territory;
    if (actor === "design-agent") {
      const registeredTerritories: AgentFilesystemTerritory[] = [];
      for (const owner of registeredSnapshot.owners) {
        if (
          effectiveTerritory &&
          path.resolve(effectiveTerritory.workspaceRoot) === owner.path
        ) {
          continue;
        }
        try {
          const ownerTerritory = await previewCodeAgentTerritory({
            cwd: owner.path,
            workspaceRoot: owner.path,
            repoRoot: owner.repoRoot,
          });
          if (ownerTerritory) registeredTerritories.push(ownerTerritory);
        } catch (error) {
          throw new Error(
            `Design actor cannot resolve registered owner ${owner.path}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      effectiveTerritory = mergeCodeAgentTerritories(
        canonicalWorkspace,
        effectiveTerritory,
        registeredTerritories,
      );
    }
    const protectedCodeDirectories =
      actor === "design-agent"
        ? [
            ...new Set([
              path.resolve(canonicalWorkspace),
              ...additionalReadWriteRoots.map((root) => path.resolve(root)),
              ...registeredCodeOwners,
            ]),
          ].sort((left, right) => left.localeCompare(right))
        : [];
    const gitIntegrationRoots =
      actor !== "design-agent"
        ? [
            ...new Set([
              path.resolve(canonicalWorkspace),
              ...additionalGitWorkspaceRoots.map((root) => path.resolve(root)),
              ...registeredCodeOwners,
            ]),
          ].sort((left, right) => left.localeCompare(right))
        : [];
    const providerStateEnv = Object.fromEntries(
      [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
      ].flatMap((name) => {
        const value = env?.[name]?.trim();
        return value ? [[name, value] as const] : [];
      }),
    );
    const containerWorker = includeSessionCapabilities
      ? deriveContainerWorker(env)
      : undefined;
    const containerWorkflowExpected = includeSessionCapabilities
      ? expectsContainerWorkflow(env)
      : false;
    return {
      executionId,
      actor,
      ...(providerId ? { providerId } : {}),
      ...(providerResumeId ? { providerResumeId } : {}),
      ...(Object.keys(providerStateEnv).length > 0 ? { providerStateEnv } : {}),
      cwd: path.resolve(cwd),
      workspaceRoot: path.resolve(canonicalWorkspace),
      ...(effectiveTerritory ? { territory: effectiveTerritory } : {}),
      ...(additionalReadWriteRoots.length > 0
        ? { additionalReadWriteRoots }
        : {}),
      ...(protectedWorkspaceDirectories.length > 0
        ? { protectedWorkspaceDirectories }
        : {}),
      ...(protectedWorkspaceWriteDirectories.length > 0
        ? { protectedWorkspaceWriteDirectories }
        : {}),
      ...(protectedCodeDirectories.length > 0
        ? { protectedCodeDirectories }
        : {}),
      ...(gitIntegrationRoots.length > 0 ? { gitIntegrationRoots } : {}),
      allowedLocalPorts: includeSessionCapabilities
        ? this.scopedLocalServicePorts(mcpServers)
        : [],
      trustedLocalPorts: includeSessionCapabilities
        ? this.trustedLocalServicePorts()
        : [],
      ...(containerWorker ? { containerWorker } : {}),
      ...(containerWorkflowExpected ? { containerWorkflowExpected: true } : {}),
      ...(additionalGitWorkspaceRoots.length > 0
        ? { additionalGitWorkspaceRoots }
        : {}),
      backendHint: this.executionBoundary.backend,
    };
  }

  private async prepareExecutionBoundary(
    executionId: string,
    cwd: string,
    workspaceRoot: string | undefined,
    adapter: AgentAdapter,
    territory: AgentFilesystemTerritory | undefined,
    env: Record<string, string> | undefined,
    mcpServers: readonly McpServerRegistration[],
    stage: "newSession" | "loadSession" | "forkSession",
    resolvedAdditionalRoots?: readonly string[],
    additionalGitWorkspaceRoots: readonly string[] = [],
    options: {
      includeSessionCapabilities?: boolean;
      providerResumeId?: string;
      actor?: ExecutionBoundaryActor;
      /** Cancels at the next safe preparation checkpoint. */
      admissionSignal?: AbortSignal;
    } = {},
  ): Promise<PreparedBoundary> {
    try {
      this.assertBoundaryRetirementHealthy();
      const request = await this.boundaryRequest(
        executionId,
        cwd,
        workspaceRoot,
        territory,
        env,
        adapter.agentId,
        mcpServers,
        resolvedAdditionalRoots,
        additionalGitWorkspaceRoots,
        options.includeSessionCapabilities !== false,
        options.providerResumeId,
        options.actor,
      );
      const prepared = options.admissionSignal
        ? await this.executionBoundary.prepare(request, {
            signal: options.admissionSignal,
          })
        : await this.executionBoundary.prepare(request);
      try {
        if (stage !== "forkSession") {
          this.observeBoundaryPorts(executionId, adapter.agentId, prepared);
        }
        return prepared;
      } catch (error) {
        try {
          await this.retirePreparedBoundary(executionId, prepared);
        } catch (teardownError) {
          throw new AggregateError(
            [error, teardownError],
            "execution boundary setup failed and teardown could not be proven",
          );
        }
        throw error;
      }
    } catch (error) {
      throw this.boundaryAdmissionFailure(adapter.agentId, stage, error);
    }
  }

  /** One translation of "the boundary could not be established" for every
   * admission path — sessions and pooled one-shots alike — so a stale provider
   * login is detected, recorded, and advised identically wherever it surfaces. */
  private boundaryAdmissionFailure(
    providerId: string,
    stage: "newSession" | "loadSession" | "forkSession",
    error: unknown,
  ): AgentFailureError {
    if (error instanceof AdmissionCancelledError) {
      // The chat was closed during admission. Proven cleanup already ran, and
      // the provider's durable thread is untouched, so route this like losing
      // the conversation-bind race rather than a boundary defect.
      return new AgentFailureError({
        kind: "lifecycle-superseded",
        stage,
        agentId: providerId,
        message:
          "The conversation was closed before its execution boundary was ready.",
      });
    }
    const authenticationRequired = boundaryRequiresProviderAuthentication(
      providerId,
      error,
    );
    if (authenticationRequired) {
      this.markAuthFailed(providerId);
    }
    return new AgentFailureError({
      kind: authenticationRequired ? "auth-required" : "protocol-error",
      message:
        `${providerId} cannot start because Zeros Sandbox Runtime ` +
        `could not establish the execution boundary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      stage,
      agentId: providerId,
      advice: authenticationRequired
        ? "Sign in to Claude again, then retry this message. The stored OAuth session is no longer accepted by Claude."
        : "Repair or enable the qualified Zeros sandbox backend for this workspace, then retry. Zeros will not run this session uncontained.",
    });
  }

  /** Warm background boundaries shared by engine-owned one-shots (chat titles,
   * provider probes, key validation, session listing). See
   * containment/utility-boundary-pool.ts for the reuse contract. Created lazily
   * so a gateway that never runs a one-shot never holds one. */
  private utilityBoundariesInstance: UtilityBoundaryPool | null = null;

  private get utilityBoundaries(): UtilityBoundaryPool {
    if (!this.utilityBoundariesInstance) {
      this.utilityBoundariesInstance = new UtilityBoundaryPool({
        prepare: (request) => this.executionBoundary.prepare(request),
        retire: (executionId, boundary) =>
          this.retirePreparedBoundary(executionId, boundary),
        assertHealthy: () => this.assertBoundaryRetirementHealthy(),
      });
    }
    return this.utilityBoundariesInstance;
  }

  /** Run an engine-owned background one-shot inside a reusable boundary.
   *
   * The boundary is shared with any other one-shot whose BoundaryRequest is
   * byte-identical (executionId excluded) and released back to the pool on
   * success, so a burst of probes/titles pays ONE admission instead of one each.
   * A failure retires it rather than reusing it. Local services declared by the
   * request are leased once, at admission, exactly as the per-call path did.
   *
   * Admission failures are translated exactly as the per-session path translates
   * them (auth-required detection included), so a Claude OAuth session that has
   * gone stale still marks the provider's dot and still gets its advice. */
  private async withUtilityBoundary<T>(
    providerId: string,
    stage: "newSession" | "loadSession" | "forkSession",
    request: BoundaryRequest,
    registeredDesignAuthorityIdentity: string | null,
    territoryContributions: readonly BoundaryTerritoryContributionSnapshot[],
    operation: (context: {
      boundary: PreparedBoundary;
      executionId: string;
      reused: boolean;
    }) => Promise<T>,
  ): Promise<T> {
    let lease;
    try {
      lease = await this.utilityBoundaries.acquire(request);
    } catch (error) {
      throw this.boundaryAdmissionFailure(providerId, stage, error);
    }
    let releaseStarted = false;
    try {
      const admittedIdentity = lease.boundary.registeredDesignAuthorityIdentity;
      if (admittedIdentity === undefined) {
        Object.defineProperty(
          lease.boundary,
          "registeredDesignAuthorityIdentity",
          {
            configurable: false,
            enumerable: false,
            writable: false,
            value: registeredDesignAuthorityIdentity,
          },
        );
      } else if (admittedIdentity !== registeredDesignAuthorityIdentity) {
        throw new Error(
          "pooled utility boundary has stale registered Design authority",
        );
      }
      const admittedContributions = lease.boundary.territoryContributions;
      if (admittedContributions === undefined) {
        Object.defineProperty(lease.boundary, "territoryContributions", {
          configurable: false,
          enumerable: false,
          writable: false,
          value: territoryContributions,
        });
      } else if (
        JSON.stringify(admittedContributions) !==
        JSON.stringify(territoryContributions)
      ) {
        throw new Error("pooled utility boundary has stale local territory");
      }
      const result = await operation({
        boundary: lease.boundary,
        executionId: lease.executionId,
        reused: lease.reused,
      });
      releaseStarted = true;
      await lease.release("ok");
      return result;
    } catch (error) {
      // Already releasing: this IS the release's own failure (an unprovable
      // teardown at dispose time). Surface it as-is.
      if (releaseStarted) throw error;
      releaseStarted = true;
      // The operation failed. Retire the boundary rather than reuse it, keeping
      // the SAME shape the per-call path had: an unprovable teardown is reported
      // alongside the original failure, never instead of it.
      try {
        await lease.release("failed");
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          "provider one-shot failed and its boundary could not be proven stopped",
        );
      }
      throw error;
    }
  }

  /** Prove every pooled utility boundary stopped. A global Design-owner
   * transaction passes `reopen:false` and owns the later reopen, keeping title,
   * probe, validation, and listing admissions closed through the mutation. */
  async retirePooledUtilityBoundaries(
    options: { reopen?: boolean } = {},
  ): Promise<void> {
    if (!this.utilityBoundariesInstance) return;
    try {
      await this.utilityBoundariesInstance.disposeAll();
    } finally {
      if (options.reopen !== false) this.utilityBoundariesInstance.reopen();
    }
  }

  /** Reopen utility admission after the outer engine transaction has
   * published the new registered-owner map. No-op when the pool was never
   * instantiated. */
  reopenPooledUtilityBoundaries(): void {
    this.utilityBoundariesInstance?.reopen();
  }

  /** Whether a prepared title/probe/validation/listing boundary still carries
   * code authority. Admissions still inside prepare() are absent here, but
   * their post-prepare territory recheck prevents provider bytes from crossing
   * an external owner change. */
  hasPooledUtilityCodeAuthority(): boolean {
    return (this.utilityBoundariesInstance?.size() ?? 0) > 0;
  }

  pooledUtilityRegisteredDesignAuthorityChanged(
    identity: string | null,
  ): boolean {
    return (
      this.utilityBoundariesInstance?.registeredDesignAuthorityChanged(
        identity,
      ) ?? false
    );
  }

  pooledUtilityWorkspaceTerritoryChanged(
    workspaceRoot: string,
    territory: AgentFilesystemTerritory | undefined,
  ): boolean {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    for (const contributions of this.utilityBoundariesInstance?.territoryContributionSnapshots() ??
      []) {
      if (!contributions) return true;
      const contribution = contributions.find(
        (candidate) =>
          path.resolve(candidate.workspaceRoot) === normalizedWorkspace,
      );
      if (!contribution) continue;
      const nextContribution = contribution.full
        ? territory
        : territoryForGrants(territory, contribution.grants);
      if (contribution.identity !== agentTerritoryIdentity(nextContribution)) {
        return true;
      }
    }
    return false;
  }

  /** A rejected stop proof is process-wide, not session-local. Preserve the
   * exact boundary so shutdown can retry it, and reject every later admission
   * until a fresh engine instance has run durable stale-domain recovery. */
  private assertBoundaryRetirementHealthy(): void {
    if (this.failedBoundaryRetirements.size === 0) return;
    throw new Error(
      "a prior execution boundary could not be proven stopped; restart Zeros to run stale process-domain recovery",
    );
  }

  private async retirePreparedBoundary(
    executionId: string,
    boundary: PreparedBoundary,
  ): Promise<void> {
    try {
      await boundary.stopAndProve();
    } catch (error) {
      this.executionBoundaries.set(executionId, boundary);
      this.failedBoundaryRetirements.set(executionId, error);
      throw error;
    }
    if (this.executionBoundaries.get(executionId) === boundary) {
      this.executionBoundaries.delete(executionId);
    }
    this.failedBoundaryRetirements.delete(executionId);
    await this.removeRetiredSessionDir(executionId);
  }

  private async retirePreparedBoundaryAfterFailure(
    executionId: string,
    boundary: PreparedBoundary,
    primaryError: unknown,
  ): Promise<never> {
    try {
      await this.retirePreparedBoundary(executionId, boundary);
    } catch (teardownError) {
      throw new AggregateError(
        [primaryError, teardownError],
        "execution admission failed and boundary teardown could not be proven",
      );
    }
    throw primaryError;
  }

  /** Convert authority-bearing listener state into the minimal owner-facing
   * diagnostic contract. The HMAC id is stable only for this generation and
   * cannot reveal or be replayed as the broker lease id. */
  private boundaryPortsSnapshot(
    executionId: string,
    boundary: PreparedBoundary,
  ): ExecutionBoundaryPortsSnapshot {
    const discovery = boundary.portDiscoveryStatus();
    return {
      version: EXECUTION_BOUNDARY_PORTS_VERSION,
      discovery: {
        state: discovery.state,
        ...(discovery.issue ? { issue: discovery.issue } : {}),
      },
      ports: boundary.activePorts().map((mapping) => ({
        id: this.boundaryPortId(executionId, boundary, mapping.leaseId),
        protocol: "tcp" as const,
        port: mapping.displayPort,
        purpose: mapping.purpose,
        source: mapping.source,
      })),
    };
  }

  private boundaryPortId(
    executionId: string,
    boundary: PreparedBoundary,
    leaseId: string,
  ): string {
    return createHmac("sha256", boundary.generation)
      .update(executionId)
      .update("\0")
      .update(leaseId)
      .digest("base64url")
      .slice(0, 32);
  }

  private sameOpaquePortId(left: string, right: string): boolean {
    if (!/^[A-Za-z0-9_-]{32}$/.test(left) || right.length !== left.length) {
      return false;
    }
    return timingSafeEqual(Buffer.from(left), Buffer.from(right));
  }

  /** Mint (or reuse) the dedicated authenticated preview façade for a live
   * mapping. This trusted-engine method never returns the real listener. */
  async openBoundaryPort(
    executionId: string,
    portId: string,
  ): Promise<{ url: string; admissionUrl: string; expiresAt: number }> {
    const boundary = this.executionBoundaries.get(executionId);
    if (!boundary) throw new Error("execution boundary is unavailable");
    const mapping = boundary
      .activePorts()
      .find((candidate) =>
        this.sameOpaquePortId(
          portId,
          this.boundaryPortId(executionId, boundary, candidate.leaseId),
        ),
      );
    if (!mapping) throw new Error("session preview is no longer active");
    if (mapping.host !== "127.0.0.1" && mapping.host !== "::1") {
      throw new Error("session preview target is not loopback");
    }
    const target: ZsrPreviewTarget = {
      targetHost: mapping.host,
      targetPort: mapping.port,
      displayPort: mapping.displayPort,
    };
    let previews = this.boundaryPreviews.get(executionId);
    if (!previews) {
      previews = new Map();
      this.boundaryPreviews.set(executionId, previews);
    }
    let gateway = previews.get(portId);
    if (!gateway) {
      gateway = this.previewGatewayFactory.open(target);
      previews.set(portId, gateway);
      void gateway.catch(() => {
        if (previews?.get(portId) === gateway) previews.delete(portId);
        if (previews?.size === 0) this.boundaryPreviews.delete(executionId);
      });
    }
    const opened = await gateway;
    // A listener can disappear while bind/start is awaiting. Never publish a
    // façade for a retired mapping or replacement execution.
    const stillActive =
      this.executionBoundaries.get(executionId) === boundary &&
      boundary
        .activePorts()
        .some((candidate) =>
          this.sameOpaquePortId(
            portId,
            this.boundaryPortId(executionId, boundary, candidate.leaseId),
          ),
        );
    if (!stillActive) {
      previews.delete(portId);
      if (previews.size === 0) this.boundaryPreviews.delete(executionId);
      await opened.close().catch(() => undefined);
      throw new Error("session preview is no longer active");
    }
    return opened.navigation();
  }

  private retireMissingBoundaryPreviews(
    executionId: string,
    activePortIds: ReadonlySet<string>,
  ): void {
    const previews = this.boundaryPreviews.get(executionId);
    if (!previews) return;
    for (const [portId, gateway] of previews) {
      if (activePortIds.has(portId)) continue;
      previews.delete(portId);
      void gateway.then((opened) => opened.close()).catch(() => undefined);
    }
    if (previews.size === 0) this.boundaryPreviews.delete(executionId);
  }

  private async closeBoundaryPreviews(executionId: string): Promise<void> {
    const previews = this.boundaryPreviews.get(executionId);
    this.boundaryPreviews.delete(executionId);
    if (!previews) return;
    const results = await Promise.allSettled(
      [...previews.values()].map(async (gateway) => (await gateway).close()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "failed to revoke preview capabilities",
      );
    }
  }

  private observeBoundaryPorts(
    executionId: string,
    agentId: string,
    boundary: PreparedBoundary,
  ): void {
    this.boundaryPortSubscriptions.get(executionId)?.();
    const unsubscribe = boundary.onPortsChanged(() => {
      const snapshot = this.boundaryPortsSnapshot(executionId, boundary);
      this.retireMissingBoundaryPreviews(
        executionId,
        new Set(snapshot.ports.map((port) => port.id)),
      );
      this.events.onBoundaryPortsChanged?.(agentId, executionId, snapshot);
    });
    this.boundaryPortSubscriptions.set(executionId, unsubscribe);
  }

  private stopObservingBoundaryPorts(executionId: string): void {
    this.boundaryPortSubscriptions.get(executionId)?.();
    this.boundaryPortSubscriptions.delete(executionId);
  }

  /** Publish a replacement snapshot for the exact live execution. The status
   * map is the race guard: provisional and retired executions cannot emit, and
   * callers can update only the redacted contract already admitted here. */
  private updateBoundaryStatus(
    executionId: string,
    update: (current: ExecutionBoundaryStatus) => ExecutionBoundaryStatus,
  ): boolean {
    const current = this.executionToBoundaryStatus.get(executionId);
    const agentId = this.executionToAgent.get(executionId);
    if (!current || !agentId) return false;
    const next = update(current);
    this.executionToBoundaryStatus.set(executionId, next);
    this.events.onBoundaryStatusChanged?.(agentId, executionId, next);
    return true;
  }

  /** Explain why a live execution is being retired before its capability and
   * process tree are revoked. This is diagnostic only; the synchronous status
   * update does not weaken or delay the fail-closed lifecycle transition. */
  markBoundaryDraining(
    executionId: string,
    transition: "territory-restart",
  ): boolean {
    const transitionedAt = Date.now();
    return this.updateBoundaryStatus(executionId, (current) => ({
      ...current,
      state: "draining",
      lifecycle: { lastTransition: transition, transitionedAt },
      checkedAt: transitionedAt,
    }));
  }

  /** Undo markBoundaryDraining for a session that SURVIVED a failed retire
   * (e.g. a streaming turn would not settle inside the territory transition's
   * bounded cancel). The session stays live and routable, so leaving it
   * `draining` would spin the renderer's boundary pill forever with no repair
   * path — a drain that will never complete is a lie. Diagnostic only, exactly
   * like the mark it reverses. */
  markBoundaryDrainingCleared(executionId: string): boolean {
    const current = this.executionToBoundaryStatus.get(executionId);
    if (!current || current.state !== "draining") return false;
    return this.updateBoundaryStatus(executionId, (status) => {
      const { lifecycle: _lifecycle, ...rest } = status;
      return { ...rest, state: "ready", checkedAt: Date.now() };
    });
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
   *       markAuthOk and the agent would stay amber for the full TTL after the
   *       key was fixed.
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
    this.executionBoundary =
      opts.executionBoundary ??
      new ZsrExecutionBoundary({
        projectRoot: opts.projectRoot,
      });
    this.previewGatewayFactory =
      opts.previewGatewayFactory ?? localPreviewGatewayFactory;
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

  private scopedLocalServicePorts(
    servers: readonly McpServerRegistration[] = this.mcpServers,
  ): number[] {
    return this.localPortsForUrls(
      servers.flatMap((server) =>
        server.transport === "http" && server.name !== "zeros-gateway"
          ? [server.url]
          : [],
      ),
    );
  }

  private trustedLocalServicePorts(): number[] {
    return this.localPortsForUrls(
      this.gatewayServerUrl ? [this.gatewayServerUrl] : [],
    );
  }

  private localPortsForUrls(urls: readonly string[]): number[] {
    const ports = new Set<number>();
    for (const raw of urls) {
      try {
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
          continue;
        }
        const port = parsed.port
          ? Number.parseInt(parsed.port, 10)
          : parsed.protocol === "https:"
            ? 443
            : parsed.protocol === "http:"
              ? 80
              : 0;
        if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
          ports.add(port);
        }
      } catch {
        // Registry validation owns malformed URLs; they do not become a
        // capability merely because a session is being admitted.
      }
    }
    return [...ports].sort((a, b) => a - b);
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
  ): Promise<McpServerRegistration[]> {
    try {
      const { servers, gatewayBackends, warnings } =
        await resolveMcpServersForRepo(mainRepoRoot ?? cwd);
      for (const w of warnings) console.warn(`[agents] ${agentId} MCP: ${w}`);
      const injected: McpServerRegistration[] = [];
      // The gateway endpoint fronting the auth:"oauth"/"header" backends.
      if (this.gatewayServerUrl) {
        injected.push({
          name: "zeros-gateway",
          transport: "http",
          url: this.gatewayServerUrl,
        });
      }
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
      return this.mcpServersView;
    }
  }

  /** Resolve only browser capabilities the selected provider exposes natively.
   * Codex receives an opaque IAB host id for its official Browser plugin;
   * Claude receives its official Agent SDK/Chrome flag; Cursor receives none.
   * Browser startup failures degrade only this capability. */
  private async resolveBrowserUse(
    agentId: string,
    cwd: string,
    workspaceId: string | undefined,
    conversationId: string | undefined,
    mainRepoRoot?: string,
  ): Promise<AgentBrowserUse | undefined> {
    if (agentId !== "claude" && agentId !== "codex") return undefined;
    // Claude's Chrome integration is provider-owned and needs no Zeros browser
    // lease, so it also works for chats bound directly to a folder. Codex's
    // in-app host still needs durable workspace/conversation ownership.
    if (agentId === "codex" && (!workspaceId || !conversationId)) {
      return undefined;
    }
    try {
      const workspaceRoot =
        agentId === "claude"
          ? cwd
          : workspaceId
            ? getWorkspaceById(workspaceId)?.path
            : undefined;
      if (!workspaceRoot) {
        throw new Error("The owning Zeros workspace path is unavailable.");
      }
      const browserProvider = agentId === "claude" ? "claude" : "codex";
      if (
        !browserUseEnabledForWorkspace(
          workspaceRoot,
          mainRepoRoot,
          browserProvider,
        )
      ) {
        return undefined;
      }
      if (agentId === "claude") return { kind: "claude-agent-sdk" };
      const browser = await acquireZerosBrowserHost({
        workspaceId: workspaceId!,
        conversationId: conversationId!,
        workspaceRoot,
        mainRepoRoot,
      });
      return browser
        ? {
            kind: "codex-app-server",
            browserSessionId: browser.browserSessionId,
          }
        : undefined;
    } catch (error) {
      this.events.onAgentStderr(
        agentId,
        `[zeros-browser] capability unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
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
    const runtimeOverrides = this.resolveRuntimeOverrides();
    const selectedBinaries = AGENT_MANIFEST.map(
      (agent) => runtimeOverrides.get(agent.id) ?? agent.cliBinary,
    );
    // Install-probe + auth-probe fan out in parallel. Version probe
    // is scoped to *installed* binaries only (running `--version` on
    // an ENOENT is slow ENOENT + noise in logs), so it waits for the
    // install probe first. probeCliVersion has its own 5min cache so
    // repeated listAgents calls are cheap.
    const [installed, authentication] = await Promise.all([
      probeCliInstalled(selectedBinaries),
      (async () => {
        const authenticated = new Set<string>();
        const unavailable = new Map<string, string>();
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
              if (
                await evaluateAuthProbe(
                  m.authProbe,
                  this.providerProbeRunner(m.id),
                )
              ) {
                authenticated.add(m.id);
              }
            } catch {
              unavailable.set(
                m.id,
                "Zeros Sandbox Runtime could not verify this CLI's sign-in state.",
              );
            }
          }),
        );
        return { authenticated, unavailable };
      })(),
    ]);
    const { authenticated, unavailable: authenticationUnavailable } =
      authentication;

    const versionInfo = new Map<string, AgentVersionInfo>();
    const versionProbe = Promise.all(
      AGENT_MANIFEST.map(async (m) => {
        // Claude + Codex run a CLI BUNDLED with the app (the Agent SDK's pinned
        // claude-code; the @openai/codex dep) — NOT the user's global `<cli>`,
        // which only matters for sign-in via Terminal. Report the BUNDLED
        // version so the picker + Providers page reflect what actually runs
        // (e.g. 2.1.170), not a possibly-stale global install (e.g. 2.1.169).
        // Falls through to the PATH probe if the bundle can't be read.
        const selectedBinary = runtimeOverrides.get(m.id) ?? m.cliBinary;
        const bundled = runtimeOverrides.has(m.id)
          ? null
          : bundledRuntimeVersion(m.id);
        if (bundled) {
          versionInfo.set(m.id, {
            installedVersion: bundled,
            versionCompatible: true,
          });
          return;
        }
        if (!installed.has(selectedBinary)) return;
        try {
          const { version, compatible } = await probeCliCompatibility(
            {
              binary: selectedBinary,
              minVersion: m.minCliVersion,
              maxVersion: m.maxCliVersion,
            },
            this.providerProbeRunner(m.id),
          );
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
      runtimeOverrides,
      AGENT_MANIFEST,
      authenticationUnavailable,
    );
  }

  private providerProbeRunner(providerId: string): ProbeCommandRunner {
    const configuredBinary = applyUserProviderConfig(
      this.projectRoot,
      providerId,
      {},
    ).cliBinary;
    return {
      cacheKey: `${this.executionBoundary.backend}:${providerId}:${configuredBinary ?? "default"}`,
      run: (binary, args, options) =>
        this.runProviderProbeCommand(providerId, binary, args, options),
    };
  }

  /** One unpredictable-but-remembered neutral probe root per provider. Created
   * on first use with `mkdtemp` and reused for the life of the engine process, so
   * the probe's BoundaryRequest is stable (poolable) without publishing a
   * guessable path. Concurrent first probes for the same provider share one
   * creation rather than racing two roots into existence. */
  private readonly providerProbeRoots = new Map<string, Promise<string>>();

  private providerProbeRoot(safeProvider: string): Promise<string> {
    const existing = this.providerProbeRoots.get(safeProvider);
    if (existing) return existing;
    const created = fsp
      .mkdtemp(path.join(tmpdir(), `zeros-provider-probe-${safeProvider}-`))
      .catch((error: unknown) => {
        this.providerProbeRoots.delete(safeProvider);
        throw error;
      });
    this.providerProbeRoots.set(safeProvider, created);
    return created;
  }

  /** A provider's auth/version command is still provider code even though it
   * is short-lived. Give it a neutral writable root and normal host state,
   * never the active checkout or engine authority. */
  private async runProviderProbeCommand(
    providerId: string,
    binary: string,
    args: string[],
    options: { timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string }> {
    const safeProvider = providerId.replace(/[^a-z0-9_-]/gi, "-");
    // A neutral root that is STABLE per (engine process, provider) rather than
    // fresh per probe. Consecutive probes must produce the identical
    // BoundaryRequest for the utility pool to reuse one warm boundary instead of
    // admitting — and proving torn down — one each, and the request carries this
    // path as both cwd and workspaceRoot.
    //
    // Still created with `mkdtemp`, deliberately: a predictable /tmp path could
    // be pre-created by another local user, and the probe would then treat an
    // attacker-owned directory as its writable root. Minting once and REMEMBERING
    // it keeps mkdtemp's unpredictability and gets stability from the cache.
    const probeRoot = await this.providerProbeRoot(safeProvider);
    for (const entry of await fsp.readdir(probeRoot)) {
      await fsp
        .rm(path.join(probeRoot, entry), { recursive: true, force: true })
        .catch(() => undefined);
    }
    try {
      const ambientEnv = completeAgentSpawnEnv(undefined);
      const configured = applyUserProviderConfig(this.projectRoot, providerId, {
        env: ambientEnv,
      });
      const env = configured.env ?? ambientEnv;
      const manifestBinary = findAgent(providerId)?.cliBinary;
      const requestedBinary =
        configured.cliBinary && binary === manifestBinary
          ? configured.cliBinary
          : binary;
      const executable = resolveProviderExecutable(requestedBinary, env);
      if (!executable) {
        throw new Error("provider command probe executable is unavailable");
      }
      const primaryTerritory = await resolveCodeAgentTerritory({
        cwd: probeRoot,
        workspaceRoot: probeRoot,
        repoRoot: probeRoot,
      });
      const territorySet = await this.resolveTerritorySet(
        primaryTerritory,
        probeRoot,
        probeRoot,
        env,
        "newSession",
      );
      // Probes run in one remembered neutral root per provider, so their exact
      // boundary request remains poolable without any private-HOME projection.
      const request = await this.boundaryRequest(
        `probe-${safeProvider}-${randomUUID()}`,
        probeRoot,
        probeRoot,
        territorySet.territory,
        env,
        providerId,
        [],
        territorySet.additionalRoots,
        territorySet.additionalGitWorkspaceRoots,
        false,
      );
      return await this.withUtilityBoundary(
        providerId,
        "newSession",
        request,
        territorySet.registeredDesignAuthorityIdentity,
        territorySet.contributions,
        async ({ boundary }) => {
          const currentPrimary = await previewCodeAgentTerritory({
            cwd: probeRoot,
            workspaceRoot: probeRoot,
            repoRoot: probeRoot,
          });
          const currentTerritorySet = await this.resolveTerritorySet(
            currentPrimary,
            probeRoot,
            probeRoot,
            env,
            "newSession",
            { persistRecognition: false },
          );
          this.assertTerritorySetsEqual(
            territorySet,
            currentTerritorySet,
            "newSession",
          );
          const child = await boundary.spawn({
            command: executable,
            args,
            cwd: probeRoot,
            env,
            stdio: "pipe",
          });
          child.stdin?.end();
          const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
          let stdout = "";
          let stdoutBytes = 0;
          child.stdout?.on("data", (chunk: Buffer | string) => {
            if (stdoutBytes >= MAX_PROBE_OUTPUT_BYTES) return;
            const text = Buffer.isBuffer(chunk)
              ? chunk.toString("utf8")
              : chunk;
            const remaining = MAX_PROBE_OUTPUT_BYTES - stdoutBytes;
            const accepted = Buffer.from(text, "utf8").subarray(0, remaining);
            stdout += accepted.toString("utf8");
            stdoutBytes += accepted.byteLength;
          });
          // Drain diagnostics without retaining or logging provider/account data.
          child.stderr?.resume();
          const closed = child.child
            ? child.child.exitCode !== null || child.child.signalCode !== null
              ? Promise.resolve()
              : new Promise<void>((resolve) =>
                  child.child?.once("close", resolve),
                )
            : Promise.resolve();
          let timer: NodeJS.Timeout | undefined;
          try {
            const exit = await Promise.race([
              child.wait(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("provider command probe timed out")),
                  options.timeoutMs,
                );
              }),
            ]);
            await closed;
            return { exitCode: exit.code, stdout };
          } finally {
            if (timer) clearTimeout(timer);
            // The pooled boundary outlives this probe, so its child must not:
            // prove THIS process domain empty now rather than leaving a stray
            // provider child alive under a boundary the next probe will reuse.
            await child.stopAndProve();
          }
        },
      );
    } finally {
      // The directory itself stays (a pooled boundary's policy names it); only
      // this probe's leftovers go. The next probe empties it again on entry.
      for (const entry of await fsp
        .readdir(probeRoot)
        .catch(() => [] as string[])) {
        await fsp
          .rm(path.join(probeRoot, entry), { recursive: true, force: true })
          .catch(() => undefined);
      }
    }
  }

  /** Per-agent persisted `executable_path` from the user settings layer, keyed by
   *  agent id. Feeds each manifest entry's `runtimeUnavailable` probe.
   *
   *  WHY THIS EXISTS: the missing-runtime message tells the user to set Settings →
   *  Agents → Executable path. Without this the probe never read that
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
   *  agent whose adapter already has a live runtime. Registry discovery is a
   *  hot, best-effort UI path: it must never spawn provider code, clone a
   *  provider HOME, rotate OAuth, or mutate the authoritative auth result.
   *  Successful details are cached; null is deliberately not cached so the
   *  next registry read after a real session starts can enrich the panel. */
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
          const getAccountInfo =
            resolveAgentCapabilityPorts(adapter).account?.getAccountInfo;
          if (getAccountInfo) {
            value = (await getAccountInfo({ liveOnly: true })) ?? null;
          }
        } catch {
          // Decorative account metadata is not an authentication oracle.
          // Admission/prompt failures carry the provider's authoritative
          // auth-required signal and update runtimeAuthFailed themselves.
        }
        if (value) {
          this.accountInfoCache.set(m.id, { at: now, value });
          out.set(m.id, value);
        } else {
          this.accountInfoCache.delete(m.id);
        }
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
    // Drop cached account details so a user-triggered Refresh can reuse a
    // currently live runtime. Refresh never creates provider work by itself.
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
    const init = advertiseAgentCapabilities(
      adapter,
      await adapter.initialize(),
    );
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

  /** Run provider-owned one-shot bytes under the same ZSR contract as a
   * session, then prove the boundary retired before returning. These calls do
   * not need MCP, local-service, or container capabilities, but they may load
   * arbitrary provider SDK code and therefore must never use an engine-global
   * host. */
  private async runProviderOneShot<T>(opts: {
    agentId: string;
    executionPrefix: string;
    cwd?: string;
    env?: Record<string, string>;
    operation: (context: {
      adapter: AgentAdapter;
      cwd: string;
      env: Record<string, string>;
      cliBinary?: string;
      territory?: AgentFilesystemTerritory;
      executionBoundary: PreparedBoundary;
    }) => Promise<T>;
  }): Promise<T> {
    const adapter = await this.adapterFor(opts.agentId);
    const cwd = resolveAgentCwd(
      opts.cwd ?? this.projectRoot,
      "newSession",
      undefined,
    );
    const merged = mergeSpawnEnv(cwd, completeAgentSpawnEnv(opts.env));
    const spawn = normalizeProviderSpawn(
      applyUserProviderConfig(cwd, opts.agentId, { env: merged }),
    );
    const env = spawn.env ?? completeAgentSpawnEnv(opts.env);
    const territory = await this.prepareCodeAgentTerritory(
      adapter,
      cwd,
      cwd,
      undefined,
      "newSession",
      { cliBinary: spawn.cliBinary },
    );
    const territorySet = await this.resolveTerritorySet(
      territory,
      cwd,
      cwd,
      env,
      "newSession",
    );
    // Pooled, not per-call (§5.1 "reusable utility boundary"): key validation
    // and session listing are engine-owned, background, and identical from one
    // call to the next, so they share one warm boundary instead of each paying
    // another canary and proven teardown. The pool keys on this exact request,
    // serializes leases, and retires on failure.
    const request = await this.boundaryRequest(
      // Replaced by the pool with the pooled boundary's own id; only the shape
      // of the rest of this request decides whether a warm one may be reused.
      `${opts.executionPrefix}-${opts.agentId}-${randomUUID()}`,
      cwd,
      cwd,
      territorySet.territory,
      env,
      adapter.agentId,
      [],
      territorySet.additionalRoots,
      territorySet.additionalGitWorkspaceRoots,
      false,
    );
    return this.withUtilityBoundary(
      adapter.agentId,
      "newSession",
      request,
      territorySet.registeredDesignAuthorityIdentity,
      territorySet.contributions,
      async ({ boundary }) => {
        await this.assertAdditionalTerritorySetStillCurrent(
          territorySet,
          adapter,
          cwd,
          cwd,
          undefined,
          env,
          "newSession",
        );
        return opts.operation({
          adapter,
          cwd,
          env,
          cliBinary: spawn.cliBinary,
          territory: territorySet.territory,
          executionBoundary: boundary,
        });
      },
    );
  }

  /** Save-time provider-key validation (AGENT_VALIDATE_KEY). Delegates to
   *  the adapter's optional validateApiKey; agents without one (Claude /
   *  Codex CLI-auth paths) return ok=null so the renderer saves normally. */
  async validateProviderKey(
    agentId: string,
    apiKey: string,
  ): Promise<{ ok: boolean | null; error?: string }> {
    try {
      // Most providers use native CLI login and expose no candidate-key
      // validator. Preserve their cheap compatibility no-op without preparing
      // an otherwise unused provider boundary.
      const adapter = await this.adapterFor(agentId);
      if (!resolveAgentCapabilityPorts(adapter).account?.validateApiKey) {
        return { ok: null };
      }
      const result = await this.runProviderOneShot({
        agentId,
        executionPrefix: "validate-key",
        env: { CURSOR_API_KEY: apiKey },
        operation: async ({
          adapter: containedAdapter,
          cwd,
          env,
          executionBoundary,
        }) => {
          const validateApiKey =
            resolveAgentCapabilityPorts(containedAdapter).account
              ?.validateApiKey;
          if (!validateApiKey) return { ok: null };
          return validateApiKey(apiKey, {
            cwd,
            env,
            executionBoundary,
          });
        },
      });
      if (!result.error) return result;
      const withoutCandidate = apiKey
        ? result.error.split(apiKey).join("[redacted]")
        : result.error;
      return {
        ...result,
        error: redactSensitive(withoutCandidate).slice(0, 1_000),
      };
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
      const generateText =
        resolveAgentCapabilityPorts(adapter).textGeneration?.generateText;
      if (!generateText) return { title: null };
      const cwd = path.resolve(this.projectRoot);
      const env = applyUserProviderConfig(cwd, agentId, {
        env: completeAgentSpawnEnv(opts.env),
      }).env;
      const territory = await this.prepareCodeAgentTerritory(
        adapter,
        cwd,
        cwd,
        cwd,
        "newSession",
      );
      const territorySet = await this.resolveTerritorySet(
        territory,
        cwd,
        cwd,
        env,
        "newSession",
      );
      // Pooled (§5.1). Every title for a given provider builds the identical
      // request, so the second and later titles in a session reuse one warm
      // boundary. This is where the old per-title prepare+prove-teardown showed
      // up as five background admissions racing the user's own sends.
      const request = await this.boundaryRequest(
        `title-${randomUUID()}`,
        cwd,
        cwd,
        territorySet.territory,
        env,
        adapter.agentId,
        [],
        territorySet.additionalRoots,
        territorySet.additionalGitWorkspaceRoots,
        false,
      );
      const text = await this.withUtilityBoundary(
        adapter.agentId,
        "newSession",
        request,
        territorySet.registeredDesignAuthorityIdentity,
        territorySet.contributions,
        async ({ boundary }) => {
          await this.assertAdditionalTerritorySetStillCurrent(
            territorySet,
            adapter,
            cwd,
            cwd,
            cwd,
            env,
            "newSession",
          );
          return generateText({
            ...opts,
            env,
            timeoutMs: 30_000,
            executionBoundary: boundary,
          });
        },
      );
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
      /** When supplied, resolved against
       *  ~/.zeros/state.db. If cwd is also supplied, cwd wins (the
       *  renderer is the source of truth). If cwd is missing, the
       *  workspace's path is used. */
      workspaceId?: string;
      /** Durable Zeros conversation identity owning optional product tools. */
      conversationId?: string;
      /** Optional CLI binary override from Settings → Providers →
       *  Advanced. Threaded down to the adapter so the per-turn spawn
       *  uses this in place of the registry's `cliBinary`. */
      cliBinary?: string;
      /** Publish the engine-owned route before adapter.newSession can emit. */
      onExecutionCreated?: (executionId: string) => void;
      /** Aborted when the owning conversation is closed or superseded, so an
       * admission that is still queued is cancelled instead of burned. */
      admissionSignal?: AbortSignal;
    } = {},
  ): Promise<NewSessionResponse> {
    const adapter = await this.adapterFor(agentId);
    // The prior silent fallback
    // `opts.cwd ?? this.projectRoot` was a critical footgun. When a
    // caller passed `cwd: undefined` (e.g. renderer/shell/conversation/chat-view's
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
    // Overlay the repo/user TOML `env` table + `env_files` for this
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
    const canonicalWorkspaceRoot = opts.workspaceId
      ? getWorkspaceById(opts.workspaceId)?.path
      : undefined;
    const merged = await withTargetBranchEnv(
      withWorktreeEnv(
        mergeSpawnEnv(cwd, completeAgentSpawnEnv(opts.env), mainRepoRoot),
        cwd,
      ),
      opts.workspaceId,
    );
    const spawn = normalizeProviderSpawn(
      applyUserProviderConfig(
        cwd,
        agentId,
        { env: merged, cliBinary: opts.cliBinary },
        mainRepoRoot,
      ),
    );
    spawn.env = stripBrowserServiceCredentials(spawn.env);
    const primaryTerritory = await this.prepareCodeAgentTerritory(
      adapter,
      cwd,
      canonicalWorkspaceRoot,
      mainRepoRoot,
      "newSession",
      { cliBinary: spawn.cliBinary },
    );
    // ZSR wraps the complete provider runtime before any provider wrapper,
    // MCP server, hook, plugin or `/add-dir` child starts. Preserve the same
    // provider environment as a normal workspace; the boundary policy, not a
    // provider-specific feature clamp, subtracts Design authority.
    const sessionEnv = spawn.env;
    const territorySet = await this.resolveTerritorySet(
      primaryTerritory,
      cwd,
      canonicalWorkspaceRoot,
      sessionEnv,
      "newSession",
    );
    const territory = territorySet.territory;
    // Native-instruction adapters (Codex and Claude) take the first-turn orientation on
    // their protocol's own channel at thread creation; everyone else gets it
    // prepended in-band on the first prompt (withSystemInstruction).
    const instructionCtx = this.parseInstructionCtx(
      sessionEnv,
      territory?.designDirectory,
    );
    const systemInstruction = this.nativeInstructionFor(
      adapter,
      cwd,
      instructionCtx,
    );
    const executionId = randomUUID();
    const { mcpServers, preparedBoundary } =
      await this.withProvisionalTerritory(
        executionId,
        territorySet.contributions,
        async () => {
          const mcpServers = await this.resolveSessionMcp(
            agentId,
            cwd,
            mainRepoRoot,
          );
          const preparedBoundary = await this.prepareExecutionBoundary(
            executionId,
            cwd,
            canonicalWorkspaceRoot,
            adapter,
            territory,
            sessionEnv,
            mcpServers,
            "newSession",
            territorySet.additionalRoots,
            territorySet.additionalGitWorkspaceRoots,
            opts.admissionSignal
              ? { admissionSignal: opts.admissionSignal }
              : {},
          );
          try {
            await this.assertAdditionalTerritorySetStillCurrent(
              territorySet,
              adapter,
              cwd,
              canonicalWorkspaceRoot,
              mainRepoRoot,
              sessionEnv,
              "newSession",
            );
          } catch (error) {
            await this.retirePreparedBoundaryAfterFailure(
              executionId,
              preparedBoundary,
              error,
            );
          }
          this.executionBoundaries.set(executionId, preparedBoundary);
          this.executionToCwd.set(executionId, cwd);
          this.executionToTerritoryContributions.set(
            executionId,
            territorySet.contributions,
          );
          return { mcpServers, preparedBoundary };
        },
      );
    const boundary = preparedBoundary.status;
    const browserUse = await this.resolveBrowserUse(
      agentId,
      cwd,
      opts.workspaceId,
      opts.conversationId,
      mainRepoRoot,
    );
    // Local MCP, hooks, plugins and subagents are now descendants of the same
    // ZSR process root, so Design-bearing sessions retain the normal registry.
    try {
      opts.onExecutionCreated?.(executionId);
    } catch (error) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw error;
    }
    let session: NewSessionResponse;
    try {
      const startup = adapter.newSession({
        executionId,
        cwd,
        env: sessionEnv,
        cliBinary: spawn.cliBinary,
        mcpServers,
        ...(browserUse ? { browserUse } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(territory ? { territory } : {}),
        executionBoundary: preparedBoundary,
      });
      this.trackAdapterStartup(executionId, startup);
      ({ session } = await awaitAdapterStartup({
        agentId,
        stage: "newSession",
        operation: startup,
        onLateSettlement: () =>
          this.disposeRejectedExecutions(adapter, [executionId]),
      }));
    } catch (err) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw err;
    }
    if (
      session.executionId !== executionId ||
      session.sessionId !== executionId
    ) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "newSession",
        message: `Agent ${agentId} replaced the Zeros execution identity during startup.`,
      });
    }
    if (
      session.providerBinding &&
      session.providerBinding.providerId !== agentId
    ) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "newSession",
        message: `Agent ${agentId} returned another provider's binding.`,
      });
    }
    console.log(
      `[agents] ${agentId} newSession: executionId=${session.executionId} cwd=${cwd}` +
        (opts.workspaceId ? ` workspaceId=${opts.workspaceId}` : "") +
        (systemInstruction ? " sysInstr=native" : ""),
    );
    this.executionToAgent.set(session.executionId, agentId);
    this.settleAdapterStartup(session.executionId);
    this.executionToCwd.set(session.executionId, cwd);
    if (mainRepoRoot) {
      this.executionToMainRepoRoot.set(session.executionId, mainRepoRoot);
    }
    this.executionToInstructionCtx.set(session.executionId, instructionCtx);
    this.executionToDesignDirectory.set(
      session.executionId,
      territory?.designDirectory ?? null,
    );
    this.executionToTerritoryIdentity.set(
      session.executionId,
      territory ? agentTerritoryIdentity(territory) : null,
    );
    this.executionToBoundaryStatus.set(session.executionId, boundary);
    this.sessionsTerritoryNoticePending.delete(session.executionId);
    if (systemInstruction) {
      // Delivered natively at thread creation — the first prompt must NOT
      // also prepend the in-band block.
      this.sessionsInstructed.add(session.executionId);
    }
    // Otherwise: NEW session → left un-instructed so the first prompt injects
    // the preamble.
    if (opts.workspaceId) {
      this.executionToWorkspace.set(session.executionId, opts.workspaceId);
    }
    return {
      ...session,
      boundary,
      boundaryPorts: this.boundaryPortsSnapshot(executionId, preparedBoundary),
    };
  }

  async loadSession(
    agentId: string,
    bindingOrLegacyId: ProviderBinding | string,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      workspaceId?: string;
      conversationId?: string;
      cliBinary?: string;
      /** Publish the engine-owned route before adapter.loadSession can emit
       * updates. The caller must remove provisional routing if load rejects. */
      onExecutionCreated?: (executionId: string) => void;
      /** Aborted when the owning conversation is closed or superseded, so an
       * admission that is still queued is cancelled instead of burned. */
      admissionSignal?: AbortSignal;
    } = {},
  ): Promise<LoadSessionResponse> {
    const providerBinding =
      typeof bindingOrLegacyId === "string"
        ? legacyProviderBinding(agentId, bindingOrLegacyId)
        : coerceProviderBinding(bindingOrLegacyId);
    if (!providerBinding || providerBinding.providerId !== agentId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "loadSession",
        message:
          "The persisted provider binding does not belong to this agent.",
      });
    }
    // Validate ownership before constructing an adapter or touching provider
    // credentials/storage. A foreign binding must fail at the Zeros boundary.
    const adapter = await this.adapterFor(agentId);
    const executionId = randomUUID();
    const cwd = resolveAgentCwd(opts.cwd, "loadSession", opts.workspaceId);
    // Apply the same settings-env overlay + user-provider fallback as newSession,
    // so a resumed session gets the repo `env` table, `env_files`,
    // ZEROS_WORKTREE_PATH, and the user `[providers]` base_url/executable_path
    // fallback (couriered values win). The workspace-local layering applies here
    // too (see newSession).
    const mainRepoRoot = opts.workspaceId
      ? getWorkspaceById(opts.workspaceId)?.repoRoot
      : undefined;
    const canonicalWorkspaceRoot = opts.workspaceId
      ? getWorkspaceById(opts.workspaceId)?.path
      : undefined;
    const merged = await withTargetBranchEnv(
      withWorktreeEnv(
        mergeSpawnEnv(cwd, completeAgentSpawnEnv(opts.env), mainRepoRoot),
        cwd,
      ),
      opts.workspaceId,
    );
    const spawn = normalizeProviderSpawn(
      applyUserProviderConfig(
        cwd,
        agentId,
        { env: merged, cliBinary: opts.cliBinary },
        mainRepoRoot,
      ),
    );
    spawn.env = stripBrowserServiceCredentials(spawn.env);
    const primaryTerritory = await this.prepareCodeAgentTerritory(
      adapter,
      cwd,
      canonicalWorkspaceRoot,
      mainRepoRoot,
      "loadSession",
      { cliBinary: spawn.cliBinary },
    );
    const sessionEnv = spawn.env;
    const territorySet = await this.resolveTerritorySet(
      primaryTerritory,
      cwd,
      canonicalWorkspaceRoot,
      sessionEnv,
      "loadSession",
    );
    const territory = territorySet.territory;
    const instructionCtx = this.parseInstructionCtx(
      sessionEnv,
      territory?.designDirectory,
    );
    const systemInstruction = this.nativeInstructionFor(
      adapter,
      cwd,
      instructionCtx,
    );
    const { mcpServers, preparedBoundary } =
      await this.withProvisionalTerritory(
        executionId,
        territorySet.contributions,
        async () => {
          const mcpServers = await this.resolveSessionMcp(
            agentId,
            cwd,
            mainRepoRoot,
          );
          const preparedBoundary = await this.prepareExecutionBoundary(
            executionId,
            cwd,
            canonicalWorkspaceRoot,
            adapter,
            territory,
            sessionEnv,
            mcpServers,
            "loadSession",
            territorySet.additionalRoots,
            territorySet.additionalGitWorkspaceRoots,
            {
              providerResumeId: providerBinding.resumeId,
              ...(opts.admissionSignal
                ? { admissionSignal: opts.admissionSignal }
                : {}),
            },
          );
          try {
            await this.assertAdditionalTerritorySetStillCurrent(
              territorySet,
              adapter,
              cwd,
              canonicalWorkspaceRoot,
              mainRepoRoot,
              sessionEnv,
              "loadSession",
            );
          } catch (error) {
            await this.retirePreparedBoundaryAfterFailure(
              executionId,
              preparedBoundary,
              error,
            );
          }
          this.executionBoundaries.set(executionId, preparedBoundary);
          this.executionToCwd.set(executionId, cwd);
          this.executionToTerritoryContributions.set(
            executionId,
            territorySet.contributions,
          );
          return { mcpServers, preparedBoundary };
        },
      );
    const boundary = preparedBoundary.status;
    const browserUse = await this.resolveBrowserUse(
      agentId,
      cwd,
      opts.workspaceId,
      opts.conversationId,
      mainRepoRoot,
    );
    try {
      opts.onExecutionCreated?.(executionId);
    } catch (error) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw error;
    }
    let response: LoadSessionResponse;
    try {
      const startup = adapter.loadSession({
        executionId,
        providerBinding,
        // Compatibility for adapters/tests that have not yet adopted bindings.
        sessionId: providerBinding.legacySessionId ?? providerBinding.resumeId,
        cwd,
        env: sessionEnv,
        cliBinary: spawn.cliBinary,
        mcpServers,
        ...(browserUse ? { browserUse } : {}),
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(territory ? { territory } : {}),
        executionBoundary: preparedBoundary,
      });
      this.trackAdapterStartup(executionId, startup);
      response = await awaitAdapterStartup({
        agentId,
        stage: "loadSession",
        operation: startup,
        onLateSettlement: () =>
          this.disposeRejectedExecutions(adapter, [executionId]),
      });
    } catch (err) {
      // Adapters may allocate a subprocess/session directory before discovering
      // that the provider locator is invalid. A rejected load must not strand
      // that provisional execution after its engine route is torn down.
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw err;
    }
    if (response.executionId && response.executionId !== executionId) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "loadSession",
        message: `Agent ${agentId} replaced the Zeros execution identity during resume.`,
      });
    }
    if (
      response.providerBinding &&
      response.providerBinding.providerId !== agentId
    ) {
      await this.disposeRejectedExecutions(adapter, [executionId]);
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "loadSession",
        message: `Agent ${agentId} returned another provider's binding.`,
      });
    }
    console.log(
      `[agents] ${agentId} loadSession: executionId=${executionId} cwd=${cwd}` +
        (opts.workspaceId ? ` workspaceId=${opts.workspaceId}` : "") +
        (systemInstruction ? " sysInstr=native" : ""),
    );
    this.executionToAgent.set(executionId, agentId);
    this.settleAdapterStartup(executionId);
    this.executionToCwd.set(executionId, cwd);
    if (mainRepoRoot) {
      this.executionToMainRepoRoot.set(executionId, mainRepoRoot);
    }
    this.executionToInstructionCtx.set(executionId, instructionCtx);
    this.executionToDesignDirectory.set(
      executionId,
      territory?.designDirectory ?? null,
    );
    this.executionToTerritoryIdentity.set(
      executionId,
      territory ? agentTerritoryIdentity(territory) : null,
    );
    this.executionToBoundaryStatus.set(executionId, boundary);
    if (systemInstruction) {
      // NATIVE channel: the adapter attached the orientation on thread/resume
      // — and its degraded resume-→-fresh-thread fallback attaches it on the
      // fresh thread/start too — so BOTH resume shapes are covered. Never
      // re-inject in-band. (The cwd hint re-arm below still applies on a
      // fresh thread for non-self-aware agents.)
      this.sessionsInstructed.add(executionId);
      if (response.resumedFresh) this.sessionsCwdHinted.delete(executionId);
    } else if (response.resumedFresh) {
      // DEGRADED RESUME → the adapter couldn't resume and started a FRESH
      // thread/agent (Codex stale rollout, Cursor "agent not found", Claude
      // with no persisted session id). That transcript is empty, so the
      // preamble would be lost forever; re-arm the one-shot (delete, don't
      // add) so the next prompt() re-injects the workspace orientation + cwd
      // hint.
      this.sessionsInstructed.delete(executionId);
      this.sessionsCwdHinted.delete(executionId);
      this.sessionsTerritoryNoticePending.delete(executionId);
    } else {
      // TRUE RESUME → the first-turn <system_instruction> already rides in
      // the resumed transcript; pre-mark instructed so prompt() never
      // re-sends it.
      this.sessionsInstructed.add(executionId);
      if (territory) this.sessionsTerritoryNoticePending.add(executionId);
    }
    if (opts.workspaceId) {
      this.executionToWorkspace.set(executionId, opts.workspaceId);
    }
    return {
      ...response,
      executionId,
      providerBinding: response.providerBinding ?? providerBinding,
      boundary,
      boundaryPorts: this.boundaryPortsSnapshot(executionId, preparedBoundary),
    };
  }

  /** Ask an adapter to fork an opaque durable provider reference. Zeros owns
   * the source/destination conversations and persistence around this call; the
   * gateway only applies the ordinary spawn/config boundary and validates that
   * the adapter returned a distinct native binding for the selected provider. */
  async forkProviderBinding(
    agentId: string,
    binding: ProviderBinding,
    opts: {
      cwd?: string;
      env?: Record<string, string>;
      workspaceId?: string;
      cliBinary?: string;
      /** Aborted when the destination conversation is closed or superseded,
       * so an admission that is still queued is cancelled instead of burned. */
      admissionSignal?: AbortSignal;
    },
  ): Promise<ProviderBinding> {
    const providerBinding = coerceProviderBinding(binding);
    if (!providerBinding || providerBinding.providerId !== agentId) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "forkSession",
        message: "The source provider binding does not belong to this agent.",
      });
    }
    const adapter = await this.adapterFor(agentId);
    const forkProviderBinding =
      resolveAgentCapabilityPorts(adapter).conversation?.forkProviderBinding;
    if (!forkProviderBinding) {
      throw new AgentFailureError({
        kind: "protocol-error",
        stage: "forkSession",
        message: `Agent ${agentId} does not support native conversation fork.`,
      });
    }
    const cwd = resolveAgentCwd(opts.cwd, "forkSession", opts.workspaceId);
    const mainRepoRoot = opts.workspaceId
      ? getWorkspaceById(opts.workspaceId)?.repoRoot
      : undefined;
    const canonicalWorkspaceRoot = opts.workspaceId
      ? getWorkspaceById(opts.workspaceId)?.path
      : undefined;
    const merged = await withTargetBranchEnv(
      withWorktreeEnv(
        mergeSpawnEnv(cwd, completeAgentSpawnEnv(opts.env), mainRepoRoot),
        cwd,
      ),
      opts.workspaceId,
    );
    const spawn = normalizeProviderSpawn(
      applyUserProviderConfig(
        cwd,
        agentId,
        { env: merged, cliBinary: opts.cliBinary },
        mainRepoRoot,
      ),
    );
    spawn.env = stripBrowserServiceCredentials(spawn.env);
    const primaryTerritory = await this.prepareCodeAgentTerritory(
      adapter,
      cwd,
      canonicalWorkspaceRoot,
      mainRepoRoot,
      "forkSession",
      { cliBinary: spawn.cliBinary },
    );
    const sessionEnv = spawn.env;
    const territorySet = await this.resolveTerritorySet(
      primaryTerritory,
      cwd,
      canonicalWorkspaceRoot,
      sessionEnv,
      "forkSession",
    );
    const territory = territorySet.territory;
    const instructionCtx = this.parseInstructionCtx(
      sessionEnv,
      territory?.designDirectory,
    );
    const systemInstruction = this.nativeInstructionFor(
      adapter,
      cwd,
      instructionCtx,
    );
    const forkExecutionId = `fork-${randomUUID()}`;
    return this.withProvisionalTerritory(
      forkExecutionId,
      territorySet.contributions,
      async () => {
        const mcpServers = await this.resolveSessionMcp(
          agentId,
          cwd,
          mainRepoRoot,
        );
        const preparedBoundary = await this.prepareExecutionBoundary(
          forkExecutionId,
          cwd,
          canonicalWorkspaceRoot,
          adapter,
          territory,
          sessionEnv,
          mcpServers,
          "forkSession",
          territorySet.additionalRoots,
          territorySet.additionalGitWorkspaceRoots,
          {
            providerResumeId: providerBinding.resumeId,
            ...(opts.admissionSignal
              ? { admissionSignal: opts.admissionSignal }
              : {}),
          },
        );
        try {
          await this.assertAdditionalTerritorySetStillCurrent(
            territorySet,
            adapter,
            cwd,
            canonicalWorkspaceRoot,
            mainRepoRoot,
            sessionEnv,
            "forkSession",
          );
        } catch (error) {
          await this.retirePreparedBoundaryAfterFailure(
            forkExecutionId,
            preparedBoundary,
            error,
          );
        }
        let result: { providerBinding: ProviderBinding };
        try {
          result = await awaitAdapterStartup({
            agentId,
            stage: "forkSession",
            operation: forkProviderBinding({
              providerBinding,
              cwd,
              env: sessionEnv,
              cliBinary: spawn.cliBinary,
              mcpServers,
              ...(systemInstruction ? { systemInstruction } : {}),
              ...(territory ? { territory } : {}),
              executionBoundary: preparedBoundary,
            }),
            onLateSettlement: () =>
              this.retirePreparedBoundary(forkExecutionId, preparedBoundary),
          });
        } finally {
          await this.retirePreparedBoundary(forkExecutionId, preparedBoundary);
        }
        const forkedBinding = coerceProviderBinding(result.providerBinding);
        if (
          !forkedBinding ||
          forkedBinding.kind !== "native" ||
          forkedBinding.providerId !== agentId ||
          forkedBinding.resumeId === providerBinding.resumeId
        ) {
          throw new AgentFailureError({
            kind: "protocol-error",
            stage: "forkSession",
            message: `Agent ${agentId} returned an invalid provider fork binding.`,
          });
        }
        return forkedBinding;
      },
    );
  }

  /** Tear down a single session's resources when its chat tab is closed.
   *  Clears the gateway's routing maps and asks the owning adapter to
   *  release the session's subprocess / server child / SDK agent. The shared
   *  session dir remains held by its process-domain descriptor until the
   *  gateway proves the kernel boundary stopped, then is removed here. Without
   *  this, every started session leaked an
   *  on-disk session dir (+ a per-session Codex server child) until app
   *  quit. Best-effort by default so closing a tab can't surface an error.
   *  Lifecycle callers use failClosed: archive/delete must abort when the
   *  adapter cannot confirm that its session resource was disposed. */
  private async disposeRejectedExecutions(
    adapter: AgentAdapter,
    executionIds: Array<string | undefined>,
  ): Promise<void> {
    for (const executionId of new Set(
      executionIds.filter(Boolean) as string[],
    )) {
      const boundary = this.executionBoundaries.get(executionId);
      // Every path that abandons a startup lands here, so this is where a
      // prompt still waiting on that startup is released.
      this.settleAdapterStartup(executionId);
      this.executionToAgent.delete(executionId);
      this.executionToWorkspace.delete(executionId);
      this.executionToCwd.delete(executionId);
      this.executionToInstructionCtx.delete(executionId);
      this.executionToDesignDirectory.delete(executionId);
      this.executionToTerritoryIdentity.delete(executionId);
      this.executionToTerritoryContributions.delete(executionId);
      this.provisionalTerritoryContributions.delete(executionId);
      this.executionToBoundaryStatus.delete(executionId);
      this.stopObservingBoundaryPorts(executionId);
      const failures: unknown[] = [];
      // Each step is independent and teardown is fail-closed: an adapter
      // cleanup failure must never skip the kernel-boundary kill/proof, while
      // a lease-revocation failure must not leave the provider process alive.
      try {
        await this.closeBoundaryPreviews(executionId);
      } catch (error) {
        failures.push(error);
      }
      try {
        await boundary?.revoke();
      } catch (error) {
        failures.push(error);
      }
      try {
        await adapter.disposeSession?.(executionId);
      } catch (error) {
        failures.push(error);
      }
      let boundaryStopped = boundary === undefined;
      try {
        await boundary?.stopAndProve();
        boundaryStopped = true;
      } catch (error) {
        failures.push(error);
        this.failedBoundaryRetirements.set(executionId, error);
      }
      if (boundaryStopped) {
        this.executionBoundaries.delete(executionId);
        this.failedBoundaryRetirements.delete(executionId);
        await this.removeRetiredSessionDir(executionId);
      }
      for (const err of failures) {
        console.warn(
          `[agents] ${adapter.agentId} failed to dispose rejected execution ` +
            `${executionId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  async endSession(
    agentId: string,
    sessionId: string,
    opts: { failClosed?: boolean } = {},
  ): Promise<void> {
    const resolvedAgentId = this.executionToAgent.get(sessionId) ?? agentId;
    const boundary = this.executionBoundaries.get(sessionId);
    this.settleAdapterStartup(sessionId);
    this.stopObservingBoundaryPorts(sessionId);
    // Publish the terminal state BEFORE the map deletes below make publishing
    // impossible. Without this, a retire that followed markBoundaryDraining
    // (territory restart) left `draining` as the LAST status the renderer
    // would ever receive for this execution — the composer's boundary pill
    // spun forever on a restart that had long since finished. `revoked` is
    // the honest terminal value; the lifecycle annotation goes with it.
    this.updateBoundaryStatus(sessionId, (current) => {
      const { lifecycle: _lifecycle, ...rest } = current;
      return { ...rest, state: "revoked", checkedAt: Date.now() };
    });
    this.executionToAgent.delete(sessionId);
    this.executionToWorkspace.delete(sessionId);
    this.executionToCwd.delete(sessionId);
    this.executionToMainRepoRoot.delete(sessionId);
    this.sessionsCwdHinted.delete(sessionId);
    this.sessionsInstructed.delete(sessionId);
    this.sessionsTerritoryNoticePending.delete(sessionId);
    this.executionToInstructionCtx.delete(sessionId);
    this.executionToDesignDirectory.delete(sessionId);
    this.executionToTerritoryIdentity.delete(sessionId);
    this.executionToTerritoryContributions.delete(sessionId);
    this.provisionalTerritoryContributions.delete(sessionId);
    this.executionToBoundaryStatus.delete(sessionId);
    const adapter = this.adapters.get(resolvedAgentId);
    let failure: unknown;
    try {
      // Revoke boundary-owned integration and port capabilities before asking
      // provider code to unwind.
      await this.closeBoundaryPreviews(sessionId);
    } catch (err) {
      failure = err;
    }
    try {
      await boundary?.revoke();
    } catch (err) {
      failure ??= err;
      console.warn(
        `[agents] ${resolvedAgentId} boundary revoke(${sessionId}) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    try {
      await adapter?.disposeSession?.(sessionId);
    } catch (err) {
      failure ??= err;
      console.warn(
        `[agents] ${resolvedAgentId} disposeSession(${sessionId}) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    let boundaryStopped = boundary === undefined;
    try {
      await boundary?.stopAndProve();
      boundaryStopped = true;
    } catch (err) {
      failure ??= err;
      this.failedBoundaryRetirements.set(sessionId, err);
      console.warn(
        `[agents] ${resolvedAgentId} boundary teardown(${sessionId}) failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    if (boundaryStopped) {
      this.executionBoundaries.delete(sessionId);
      this.failedBoundaryRetirements.delete(sessionId);
      await this.removeRetiredSessionDir(sessionId);
    }
    if (failure && opts.failClosed) throw failure;
  }

  async listSessions(
    agentId: string,
    opts: { cwd?: string; cursor?: string | null } = {},
  ): Promise<ListSessionsResponse> {
    return this.runProviderOneShot({
      agentId,
      executionPrefix: "list-sessions",
      cwd: opts.cwd,
      operation: ({ adapter, env, executionBoundary }) =>
        adapter.listSessions({
          cwd: opts.cwd,
          cursor: opts.cursor,
          env,
          executionBoundary,
        }),
    });
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
    const cwd = this.executionToCwd.get(sessionId);
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
   *  still ship. Callers stash the result in executionToInstructionCtx. */
  private parseInstructionCtx(
    env: Record<string, string> | undefined,
    designDirectory?: string,
  ): {
    additionalDirectories: string[];
    targetBranch?: string;
    customInstructions?: string;
    designDirectory?: string;
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
      ...(designDirectory ? { designDirectory } : {}),
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
      designDirectory: ctx.designDirectory ?? null,
    });
    return body || undefined;
  }

  /** Prepend the one-shot first-turn <system_instruction> (workspace preamble +
   *  /add-dir awareness + repo `[prompts] general`) — the orientation an agent
   *  needs before its first tool call — for every agent WITHOUT a native
   *  instruction channel. Adapters
   *  declaring `nativeSystemInstruction` (Codex and Claude) get the same body on their
   *  protocol's instruction field at session create/resume instead, and are
   *  pre-marked instructed there. First prompt per NEW session only; a resumed
   *  session is pre-marked (the block already rides in its history). The text
   *  itself lives in @zeros/protocol/system-instructions (one editable home). */
  private withSystemInstruction(
    sessionId: string,
    prompt: ContentBlock[],
  ): ContentBlock[] {
    if (this.sessionsInstructed.has(sessionId)) {
      if (!this.sessionsTerritoryNoticePending.delete(sessionId)) return prompt;
      const ctx = this.executionToInstructionCtx.get(sessionId);
      const territoryBlock = wrapSystemInstruction(
        buildCodeAgentDesignTerritoryNotice(ctx?.designDirectory ?? null),
      );
      return territoryBlock
        ? [{ type: "text", text: territoryBlock }, ...prompt]
        : prompt;
    }
    this.sessionsInstructed.add(sessionId);
    this.sessionsTerritoryNoticePending.delete(sessionId);
    const cwd = this.executionToCwd.get(sessionId);
    if (!cwd) return prompt;
    const ctx = this.executionToInstructionCtx.get(sessionId);
    const block = buildFirstTurnSystemInstruction({
      workspaceDir: cwd,
      targetBranch: ctx?.targetBranch ?? null,
      additionalDirectories: ctx?.additionalDirectories ?? [],
      customInstructions: ctx?.customInstructions ?? null,
      designDirectory: ctx?.designDirectory ?? null,
    });
    if (!block) return prompt;
    return [{ type: "text", text: block }, ...prompt];
  }

  /** Track an in-flight adapter startup so prompt-shaped traffic for its
   *  executionId waits for registration instead of racing it.
   *
   *  The flight deliberately outlives the adapter's own promise: the gateway
   *  registers this execution's route AFTER that promise resolves, and a
   *  prompt released in between finds no route — indistinguishable from an id
   *  left over from a previous engine. Every abandonment path runs through
   *  disposeRejectedExecutions, and a rejected startup settles itself, so no
   *  outcome can strand a waiter. */
  private trackAdapterStartup(
    executionId: string,
    operation: Promise<unknown>,
  ): void {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const flight = { promise, settle };
    this.adapterStartupFlights.set(executionId, flight);
    void operation.catch(() => this.settleAdapterStartup(executionId, flight));
  }

  /** Release anything waiting on this execution's startup. */
  private settleAdapterStartup(
    executionId: string,
    expected?: { readonly promise: Promise<void>; readonly settle: () => void },
  ): void {
    const flight = this.adapterStartupFlights.get(executionId);
    if (!flight || (expected && flight !== expected)) return;
    this.adapterStartupFlights.delete(executionId);
    flight.settle();
  }

  /** Wait for this execution's adapter startup to settle, if one is running.
   *  After the wait the session is either registered (the prompt proceeds) or
   *  its startup failed (the prompt fails on the adapter's real state). */
  private async awaitAdapterStartupSettled(sessionId: string): Promise<void> {
    const flight = this.adapterStartupFlights.get(sessionId);
    if (flight) await flight.promise;
  }

  async prompt(
    agentId: string,
    sessionId: string,
    prompt: ContentBlock[],
    turnId?: string,
  ): Promise<PromptResponse> {
    await this.awaitAdapterStartupSettled(sessionId);
    const adapter = this.adapterForSession(sessionId, agentId, {
      requireLiveRoute: true,
    });
    const updateBrowserUse =
      resolveAgentCapabilityPorts(adapter).browser?.updateUse;
    if (updateBrowserUse) {
      const cwd = this.executionToCwd.get(sessionId);
      if (cwd) {
        let enabled = false;
        try {
          enabled = browserUseEnabledForWorkspace(
            cwd,
            this.executionToMainRepoRoot.get(sessionId),
            "claude",
          );
        } catch (error) {
          // Browser is optional. A malformed/transient settings read must not
          // block an ordinary Claude turn, but it must fail the external,
          // signed-in browser capability closed for this query generation.
          this.events.onAgentStderr(
            adapter.agentId,
            `[zeros-browser] capability unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        await updateBrowserUse({
          sessionId,
          ...(enabled
            ? { browserUse: { kind: "claude-agent-sdk" as const } }
            : {}),
        });
      }
    }
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
        ...(turnId ? { turnId } : {}),
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
    const stopTask =
      resolveAgentCapabilityPorts(adapter).backgroundWork?.stopTask;
    if (!stopTask) {
      throw new AgentFailureError({
        kind: "protocol-error",
        message: `agent ${adapter.agentId} does not support stopping background tasks`,
        stage: "stopBackgroundTask",
        agentId: adapter.agentId,
      });
    }
    await stopTask({ sessionId, taskId });
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
    await this.awaitAdapterStartupSettled(sessionId);
    const adapter = this.adapterForSession(sessionId, agentId, {
      requireLiveRoute: true,
    });
    const steer = resolveAgentCapabilityPorts(adapter).turnControl?.steer;
    if (!steer) {
      throw new Error(`agent ${adapter.agentId} does not support steering`);
    }
    await steer({ sessionId, prompt });
  }

  async setMode(
    agentId: string,
    sessionId: string,
    modeId: string,
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    const setMode = resolveAgentCapabilityPorts(adapter).turnControl?.setMode;
    if (!setMode) {
      throw new Error(`agent ${adapter.agentId} does not support set-mode`);
    }
    await setMode({ sessionId, modeId });
  }

  /** Run a real context compaction on a live session through Codex
   *  `thread/compact/start`. Progress streams back as the agent's own
   *  contextCompaction item (the two-state transcript row); this call just
   *  triggers it. */
  async compactContext(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    const compactContext =
      resolveAgentCapabilityPorts(adapter).turnControl?.compactContext;
    if (!compactContext) {
      throw new Error(`agent ${adapter.agentId} does not support compaction`);
    }
    await compactContext({ sessionId });
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
    const setModel =
      resolveAgentCapabilityPorts(adapter).runtimeConfiguration?.setModel;
    if (!setModel) return;
    await setModel({ sessionId, model });
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
    const updateConfig =
      resolveAgentCapabilityPorts(adapter).runtimeConfiguration?.updateConfig;
    if (!updateConfig) return;
    await updateConfig({ sessionId, env });
  }

  async readMemorySettings(agentId: string) {
    return this.runProviderOneShot({
      agentId,
      executionPrefix: "memory-read",
      operation: ({ adapter, cwd, env, cliBinary, executionBoundary }) => {
        const memory = resolveAgentCapabilityPorts(adapter).memory;
        if (!memory) {
          throw new Error(
            `agent ${adapter.agentId} does not support memory settings`,
          );
        }
        return memory.readSettings({
          cwd,
          env,
          cliBinary,
          executionBoundary,
        });
      },
    });
  }

  async readConfigurationProvenance(agentId: string, cwd?: string) {
    return this.runProviderOneShot({
      agentId,
      cwd,
      executionPrefix: "configuration-provenance",
      operation: ({
        adapter,
        cwd: resolvedCwd,
        env,
        cliBinary,
        territory,
        executionBoundary,
      }) => {
        const configuration =
          resolveAgentCapabilityPorts(adapter).configuration;
        if (!configuration) {
          throw new Error(
            `agent ${adapter.agentId} does not support configuration provenance`,
          );
        }
        return configuration.readProvenance({
          cwd: resolvedCwd,
          env,
          cliBinary,
          territory,
          executionBoundary,
        });
      },
    });
  }

  async readProviderQuota(agentId: string): Promise<AgentProviderQuota | null> {
    return this.runProviderOneShot({
      agentId,
      executionPrefix: "provider-quota",
      operation: async ({
        adapter,
        cwd,
        env,
        cliBinary,
        executionBoundary,
      }) => {
        const readQuota = resolveAgentCapabilityPorts(adapter).account?.readQuota;
        if (!readQuota) return null;
        return await readQuota({ cwd, env, cliBinary, executionBoundary });
      },
    });
  }

  async updateMemorySettings(
    agentId: string,
    settings: Parameters<
      NonNullable<AgentCapabilityPorts["memory"]>["updateSettings"]
    >[0]["settings"],
  ) {
    return this.runProviderOneShot({
      agentId,
      executionPrefix: "memory-update",
      operation: ({ adapter, cwd, env, cliBinary, executionBoundary }) => {
        const memory = resolveAgentCapabilityPorts(adapter).memory;
        if (!memory) {
          throw new Error(
            `agent ${adapter.agentId} does not support memory settings`,
          );
        }
        return memory.updateSettings({
          cwd,
          env,
          cliBinary,
          executionBoundary,
          settings,
        });
      },
    });
  }

  async resetMemory(agentId: string): Promise<void> {
    await this.runProviderOneShot({
      agentId,
      executionPrefix: "memory-reset",
      operation: async ({
        adapter,
        cwd,
        env,
        cliBinary,
        executionBoundary,
      }) => {
        const memory = resolveAgentCapabilityPorts(adapter).memory;
        if (!memory) {
          throw new Error(
            `agent ${adapter.agentId} does not support memory reset`,
          );
        }
        await memory.reset({ cwd, env, cliBinary, executionBoundary });
      },
    });
  }

  async getGoal(agentId: string, sessionId: string) {
    const adapter = this.adapterForSession(sessionId, agentId);
    const goal = resolveAgentCapabilityPorts(adapter).goal;
    if (!goal)
      throw new Error(`agent ${adapter.agentId} does not support goals`);
    return goal.get({ sessionId });
  }

  async setGoal(
    agentId: string,
    sessionId: string,
    update: Parameters<
      NonNullable<AgentCapabilityPorts["goal"]>["set"]
    >[0]["update"],
  ) {
    const adapter = this.adapterForSession(sessionId, agentId);
    const goal = resolveAgentCapabilityPorts(adapter).goal;
    if (!goal)
      throw new Error(`agent ${adapter.agentId} does not support goals`);
    return goal.set({ sessionId, update });
  }

  async clearGoal(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    const goal = resolveAgentCapabilityPorts(adapter).goal;
    if (!goal)
      throw new Error(`agent ${adapter.agentId} does not support goals`);
    await goal.clear({ sessionId });
  }

  async retryDeniedAction(
    agentId: string,
    sessionId: string,
    retryId: string,
  ): Promise<void> {
    const adapter = this.adapterForSession(sessionId, agentId);
    const retry =
      resolveAgentCapabilityPorts(adapter).safety?.retryDeniedAction;
    if (!retry) {
      throw new Error(
        `agent ${adapter.agentId} does not support denied-action retry`,
      );
    }
    await retry({ sessionId, retryId });
  }

  answerPermission(
    permissionId: string,
    response: RequestPermissionResponse,
  ): void {
    // Permission IDs are uuids; at most one adapter will have it
    // pending. Fan out rather than tracking a permissionId→agent map
    // — simpler and avoids a second source of truth.
    for (const adapter of this.adapters.values()) {
      resolveAgentCapabilityPorts(adapter).interaction?.respondToPermission?.({
        permissionId,
        response,
      });
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
        resolveAgentCapabilityPorts(adapter).interaction?.respondToQuestion?.({
          questionId,
          response,
          nativeRequestId,
        })
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
    const boundaryEntries = [...this.executionBoundaries.entries()];
    const boundaries = boundaryEntries.map(([, boundary]) => boundary);
    const failures: unknown[] = [];
    const settle = async (operations: Array<() => unknown>) => {
      const results = await Promise.allSettled(
        operations.map((operation) => Promise.resolve().then(operation)),
      );
      for (const result of results) {
        if (result.status === "rejected") failures.push(result.reason);
      }
    };
    for (const executionId of this.boundaryPortSubscriptions.keys()) {
      this.stopObservingBoundaryPorts(executionId);
    }
    // Pooled one-shot boundaries are not in `executionBoundaries` (nothing owns
    // them by execution id), so shutdown has to prove them stopped explicitly.
    // Their neutral probe roots are removed AFTER, since a pooled boundary names
    // one as its workspace root until it is retired.
    await settle([() => this.retirePooledUtilityBoundaries()]);
    const probeRoots = [...this.providerProbeRoots.values()];
    this.providerProbeRoots.clear();
    await settle(
      probeRoots.map(
        (pending) => () =>
          pending
            .then((root) => fsp.rm(root, { recursive: true, force: true }))
            .catch(() => undefined),
      ),
    );
    await settle(
      [...this.boundaryPreviews.keys()].map(
        (executionId) => () => this.closeBoundaryPreviews(executionId),
      ),
    );
    await settle(boundaries.map((boundary) => () => boundary.revoke()));
    await settle(
      Array.from(this.adapters.values()).map(
        (adapter) => () => adapter.dispose(),
      ),
    );
    const stopResults = await Promise.allSettled(
      boundaryEntries.map(([, boundary]) => boundary.stopAndProve()),
    );
    for (let index = 0; index < stopResults.length; index += 1) {
      const result = stopResults[index]!;
      if (result.status === "rejected") {
        failures.push(result.reason);
      } else {
        await this.removeRetiredSessionDir(boundaryEntries[index]![0]);
      }
    }
    this.executionBoundaries.clear();
    this.failedBoundaryRetirements.clear();
    this.adapters.clear();
    this.executionToAgent.clear();
    this.executionToWorkspace.clear();
    this.executionToCwd.clear();
    this.executionToMainRepoRoot.clear();
    this.executionToInstructionCtx.clear();
    this.executionToDesignDirectory.clear();
    this.executionToTerritoryIdentity.clear();
    this.executionToTerritoryContributions.clear();
    this.provisionalTerritoryContributions.clear();
    this.executionToBoundaryStatus.clear();
    this.sessionsTerritoryNoticePending.clear();
    this.sessionsCwdHinted.clear();
    this.sessionsInstructed.clear();
    this.agentInitializes.clear();
    this.cachedAgents = null;
    this.cachedAgentsAt = null;
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "failed to dispose agent execution boundaries",
      );
    }
  }

  private async removeRetiredSessionDir(executionId: string): Promise<void> {
    try {
      await removeSessionDir(executionId);
    } catch (error) {
      console.warn(
        `[agents] session-dir cleanup(${executionId}) failed after boundary retirement: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
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
      // Hand the shared, deduplicated registry view (mutated in place by
      // setMcpServers). Adapters read ctx.mcpServers lazily per session, so a
      // settings edit reaches each agent's next session live. Dedup (collapse
      // duplicate names/endpoints — matters for Cursor's ~40-tool cap) happens
      // in refreshMcpView; native agent configuration remains owned by each
      // adapter's discovery path.
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
  private adapterForSession(
    sessionId: string,
    agentId?: string,
    opts: { requireLiveRoute?: boolean } = {},
  ): AgentAdapter {
    const routedId = this.executionToAgent.get(sessionId);
    if (!routedId && opts.requireLiveRoute) {
      // Every live session registers a route in newSession/loadSession, so a
      // missing route means this execution belongs to a previous engine
      // process — the caller's agentId only says which adapter it WOULD have
      // used. Without this the id falls through to a freshly created adapter
      // that has never registered it; Claude and Codex quietly rebuild, but
      // Cursor refuses with a hard "no live session (load it first)" and the
      // user's message is lost. session-expired is recoverable, so the
      // renderer re-establishes the session and resends instead.
      console.warn(
        `[agents] prompt for an execution this engine never admitted: ` +
          `sessionId=${sessionId} agentId=${agentId ?? "(unset)"} ` +
          `routes=${this.executionToAgent.size}`,
      );
      throw new AgentFailureError({
        kind: "session-expired",
        message: `session ${sessionId} belongs to a previous engine`,
        stage: "prompt",
        agentId: agentId ?? "claude",
      });
    }
    const resolvedId = routedId ?? agentId;
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
          `routes=${this.executionToAgent.size}`,
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
      // apps/desktop/src/renderer/platform/bridge/failure.ts.
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
