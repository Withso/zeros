// ──────────────────────────────────────────────────────────
// WorkspaceService — the Remote Workspace API over the bridge
// ──────────────────────────────────────────────────────────
//
// A blind byte-forwarder gets a remote client to the engine; this gets it
// a *workspace*. It exposes Files (tree/read), Git read (status/diff/log/
// branches), and the full Git write surface (stage/commit/push/…) as a
// single RPC: { op, params } → result. Every op is a thin pass-through to
// the already-tested engine git module (src/engine/git) — no logic is
// re-implemented here.
//
// Security: git ops are keyed by `workspaceId` (resolved server-side via
// the engine state DB). File ops need a `cwd`, which we resolve from the
// workspaceId server-side — a remote client never supplies a raw host
// path, so it can't escape a workspace. Writes are gated by the host
// (see authorizeRemoteWrite in ZerosEngine — the remote-restriction list).
//
// Deferred (follow-ups): artifacts/canvas (renderer-owned persistence).
// ──────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import {
  GitError,
  addPrComment,
  changeTargetBranch,
  checkoutBranch,
  commit,
  continueOnNewBranch,
  createBranchFrom,
  createPr,
  checkRepoNameAvailable,
  changeCounts,
  changeLineCounts,
  listGithubOwners,
  publishRepoToGithub,
  initRepoInPlace,
  diff,
  fetch,
  getAuthStatus,
  getPr,
  getPrChecks,
  getPrCommits,
  getPrReviews,
  getRepositoryOwnerAvatar,
  getWorkspaceRepoAccess,
  createWorkspace,
  prepareWorkspaceCreate,
  getWorkspace,
  getWorkspaceLifecycleStatus,
  getWorkspaceById,
  whenSeedingSettled,
  workspaceOwnsManagedCheckout,
  resolveSetupCommand,
  listBranches,
  listRemoteBranches,
  listWorkspaceFiles,
  listIgnoredEntries,
  listWorkspaces,
  listRemoteRestrictedWorkspaceIds,
  getWorkingDirectories,
  setWorkingDirectories,
  setWorkspaceRemoteRestricted,
  setWorkspaceStatus,
  log,
  markPrReady,
  mergePr,
  pull,
  discardFiles,
  push,
  rebase,
  renameBranch,
  showCommit,
  stagePaths,
  stashPop,
  stashSave,
  status,
  stampChangeState,
  hasWorkspaceChanges,
  syncWorkspacePr,
  readOriginUrl,
  unstagePaths,
  updatePr,
  type Workspace,
  type WorkspaceStatus,
  type DiffMode,
  type SetupInfo,
  type SetupTarget,
} from "../git";
import { resolveRepoScript, resolveRunActions } from "../settings/repo-scripts";
import { isRunSessionId, runActionOneShot } from "@zeros/core/run-actions";
import type {
  RunActionStatus,
  RunStartArgs,
  RunStartResult,
} from "../run/run-manager";
// Phase 2 (single-writer): the remaining DB-touching git/workspace/PR ops the
// desktop drove via in-process Electron IPC, now exposed on the bridge so the
// engine is the sole zeros.db writer. Thin pass-throughs, same as above — the
// DB-touching handlers were removed from electron/ipc/commands/git.ts (the file
// remains, now DB-free) and their marshalling moved here.
import {
  reset,
  restoreFrom,
  clean,
  merge,
  cherryPick,
  revert,
  continueOperation,
  abortOperation,
  listStashes,
  applyStash,
  dropStash,
  deleteBranch,
  stageHunk,
  unstageHunk,
  discardHunk,
  createTag,
  listTags,
  deleteTag,
  listAllBranches,
  repoBranchCatalog,
  archiveWorkspace,
  restoreWorkspace,
  deleteWorkspace,
  adoptExistingWorktree,
  createWorkspaceFromBranch,
  getCreateWorkspaceFromBranchStatus,
  proposeBranchRename,
  listPrs,
  parseGitHubRemote,
  detachStart,
  detachStop,
  detachStatus,
  previewFilesToCopy,
  type ResetMode,
  type DetectedTool,
} from "../git";
import { readWorkspaceFile, isSensitiveRepoPath } from "../files/read-file";
import { writeWorkspaceFile } from "../files/write-file";
import {
  opSettingsMigrateLegacy,
  opSettingsRead,
  opSettingsResolve,
  opSettingsWrite,
  opSettingsWriteRaw,
  READABLE_LAYERS,
  redactDocForRemote,
  redactResolvedForRemote,
  secretEnvNamesInPatch,
  SettingsOpError,
  WRITABLE_LAYERS,
  type MigrateLegacyInput,
  type ReadableLayer,
  type WritableLayer,
} from "../settings/ops";
import { getTeamContextMeta, setTeamContext } from "../settings/team-context";
import { scanNativeMcpConfigs } from "../agents/mcp-scan";
import { resolveMcpServers } from "../agents/mcp-registry";
import type { McpGateway } from "../agents/gateway/server";
import {
  listProjects,
  upsertRepoByRoot,
  removeRepoByRoot,
  renameRepoByRoot,
  bulkUpsertRepos,
  isKnownRepoRoot,
  listKnownRepoRoots,
} from "../db/projects";
import {
  listChats,
  listChatsSince,
  summariesForFolder,
  getChat,
  getChatLocation,
  upsertChat,
  deleteChat,
  bulkUpsertChats,
  coerceChatRow,
  setChatWorkspaceResolver,
  type ChatRow,
} from "../db/chats";
import { headRev, tombstonesSince } from "../db/sync";
import {
  WINDOW_MAX_ROWS,
  windowChatMessages,
  windowOlderChatMessages,
  upsertChatMessagesBulk,
  searchMessages,
  clearChatMessages,
  truncateChatMessagesFrom,
  getChatMessagesFrom,
  maxChatMessageOrd,
  reinsertChatMessages,
  listChatMessagesSince,
  CHAT_MESSAGE_DELTA_CAP,
} from "../db/messages";
import {
  listTurnsForWorkspace,
  listTurnsForChat,
  getTurn,
  deleteTurnsFrom,
  deleteTurnsForChat,
  getRawTurnsFrom,
  reinsertTurns,
} from "../db/turns";
import {
  saveResetUndo,
  getResetUndo,
  deleteResetUndo,
  pruneResetUndo,
} from "../db/reset-undo";
import {
  turnPatch,
  applyTurnSpanReset,
  undoTurnReset,
  deleteSnapshotRefs,
  deleteAllChatSnapshotRefs,
} from "../git/turns-git";

/** How many reset-undo records to retain per chat (lock-step with the pre-reset
 *  snapshot cap RESET_SNAPSHOT_KEEP). */
const RESET_UNDO_KEEP = 5;

/** Sentinel id for the project's primary checkout (the engine root). */
export const LOCAL_MAIN_WORKSPACE_ID = "local-main";

// ── Remote secret boundary helpers ──────────────────────────
// Shared by git.status / git.diff / git.show so the secret filtering stays
// identical across them. All fail CLOSED.

/** Drop entries whose path (or rename oldPath) is a secret/credential file. */
function filterSecretFiles<T extends { path: string; oldPath?: string }>(
  files: T[],
): T[] {
  return files.filter(
    (f) =>
      !isSensitiveRepoPath(f.path) &&
      !(f.oldPath && isSensitiveRepoPath(f.oldPath)),
  );
}

/** Drop diff hunks whose path is unparseable (empty) or sensitive on either
 *  side (the a-side catches a rename FROM a secret / a mis-split header). */
function filterSecretHunks<
  T extends { filePath: string; oldFilePath?: string },
>(hunks: T[]): T[] {
  return hunks.filter(
    (h) =>
      !!h.filePath &&
      !isSensitiveRepoPath(h.filePath) &&
      !(h.oldFilePath && isSensitiveRepoPath(h.oldFilePath)),
  );
}

/** Drop sensitive per-file sections from a raw multi-file unified diff. Splits
 *  on each `diff --git` header and parses the a/…b/ paths with the SAME regex
 *  the engine diff parser uses; a section whose header is unparseable/quoted or
 *  sensitive on EITHER side is dropped (fails closed — never leaks). */
function filterSecretPatch(patch: string): string {
  return patch
    .split(/(?=^diff --git )/m)
    .filter((s) => s.startsWith("diff --git"))
    .filter((section) => {
      const m = section.split("\n", 1)[0].match(/^diff --git a\/(.+) b\/(.+)$/);
      const oldFilePath = m ? m[1] : "";
      const filePath = m ? m[2] : "";
      return (
        !!filePath &&
        !isSensitiveRepoPath(filePath) &&
        !isSensitiveRepoPath(oldFilePath)
      );
    })
    .join("");
}

/** Ops that mutate the repo — gated by the remote-restriction list for remote
 *  clients (a paired device is a trusted operator; no per-op host prompt). */
// ── Host directory browse (folder picker) ─────────────────
// Lets a remote client browse the host filesystem to pick a folder to open as a
// project (the engine fs is the source
// of truth; mirrors Paseo's directory-suggestions). Read-only, immediate child
// directories only. Dotfolders are hidden for a cleaner picker.

interface DirEntry {
  name: string;
  path: string;
}
interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
}

function listHostDirectories(raw?: string, remote = false): DirListing {
  const home = os.homedir();
  const base = raw && raw.trim() ? raw.trim() : home;
  let dir = base;
  try {
    dir = fs.realpathSync(base);
  } catch {
    dir = home; // non-existent / unreadable → don't strand the picker
  }
  // SECURITY (M3): for a REMOTE client, confine browsing to the home-dir
  // subtree — a paired device can pick a project under ~ but can NOT enumerate /,
  // /etc, /System, /Users (other accounts), etc. The LOCAL desktop is the trusted
  // operator on its own machine and browses anywhere (native-picker parity).
  let realHome = home;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    /* keep home */
  }
  if (remote && dir !== realHome && !dir.startsWith(realHome + nodePath.sep)) {
    dir = realHome;
  }
  let entries: DirEntry[] = [];
  try {
    entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => {
        if (e.name.startsWith(".")) return false; // hide dotfolders
        try {
          // e.isDirectory() is false for a symlinked dir — stat to include those.
          return (
            e.isDirectory() ||
            fs.statSync(nodePath.join(dir, e.name)).isDirectory()
          );
        } catch {
          return false;
        }
      })
      .map((e) => ({ name: e.name, path: nodePath.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    entries = []; // permission denied / not a directory
  }
  // For a remote client, never expose a parent above the home dir (M3); locally
  // the picker can walk up to the filesystem root like a native dialog.
  const parent = remote && dir === realHome ? null : nodePath.dirname(dir);
  return { path: dir, parent, entries };
}

/** SECURITY: a REMOTE (remote) client may only register repositories under the
 *  owner's home subtree — the SAME clamp `fs.listDir` (M3) applies to remote
 *  browsing. Without this, `project.upsert` / `project.bulkUpsert` could seed an
 *  arbitrary host path into the `repos` table, which then satisfies
 *  `isKnownRepoRoot()` and lets a remote `workspace.create` (C1) build a worktree
 *  OUTSIDE ~ — silently defeating the M3 picker clamp (no host prompt, since
 *  `requestWriteApproval` only gates on a restricted `workspaceId`, which these
 *  ops don't carry). The LOCAL desktop is the trusted operator on its own
 *  machine and may register any path. Resolves symlinks (and collapses `..` for
 *  a not-yet-existing path) so neither can escape the home subtree. */
function assertRemoteRepoRootAllowed(repoRoot: string, remote: boolean): void {
  if (!remote) return;
  let realHome = os.homedir();
  try {
    realHome = fs.realpathSync(realHome);
  } catch {
    /* keep raw home */
  }
  let real: string;
  try {
    real = fs.realpathSync(repoRoot);
  } catch {
    real = nodePath.resolve(repoRoot);
  }
  if (real !== realHome && !real.startsWith(realHome + nodePath.sep)) {
    throw new GitError({
      code: "REMOTE_PATH_DENIED",
      message:
        "Remote devices may only register repositories under your home directory.",
    });
  }
}

const WRITE_OPS = new Set<string>([
  // Workspace lifecycle — create a worktree (remote == local for trusted devices).
  "workspace.create",
  "workspace.setStatus",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.clean",
  "git.commit",
  "git.push",
  "git.pull",
  "git.rebase",
  "git.fetch",
  "git.stashSave",
  "git.stashPop",
  "git.checkoutBranch",
  "git.createBranch",
  "git.renameBranch",
  "git.changeTarget",
  // Turn reset mutates the work tree (per-path restore / 3-way merge) +
  // truncates the chat's transcript — restriction-gated for remote clients.
  "turns.reset",
  "turns.undoReset",
  // GitHub PR mutations — restriction-gated for remote clients (trusted device; no per-op prompt). Auth-credential
  // mutations (sign-in / set-token / sign-out) are intentionally NOT remoted
  // at all (see the WorkspaceService.handle GitHub section), so they never
  // appear here.
  "gh.prCreate",
  "gh.prUpdate",
  "gh.prMarkReady",
  "gh.prMerge",
  "gh.prComment",
  // Detect + backfill a workspace's PR (prNumber/prState/prUrl) from GitHub for
  // PRs opened outside the engine (agent `gh pr create`, terminal, github.com).
  // Writes only the workspace's OWN row from real GitHub state (no client-
  // supplied PR data), so it's safe under the same restriction gate.
  "gh.prSync",
  // Project (Column 1 repo) mutations — restriction-gated for remote clients (trusted device; no per-op prompt).
  // The desktop is a LOCAL client so its write-through runs without a prompt.
  "project.upsert",
  "project.remove",
  "project.rename",
  "project.bulkUpsert",
  // Settings TOML writes (user / repo / repo-local layers). Open to paired
  // devices by design: a paired device already holds PTY (= arbitrary file
  // edits), so gating this would be theater. Remote repo targeting is still
  // clamped to repos the owner opened (isKnownRepoRoot in the handler).
  "settings.write",
  // Files-tab manual edit — write one file's content. Open to paired devices on
  // the SAME terms as settings.write (a paired device already holds PTY =
  // arbitrary file edits, so gating this would be theater). The handler still
  // applies the secret denylist + workspace containment, and remote targeting is
  // clamped to repos the owner opened (resolveReadCwd / isKnownRepoRoot).
  "file.write",
]);

/** Operations that can mutate a managed checkout, its index, or refs used by
 * archive/restore. Production routes register their whole promise with the
 * engine's workspace barrier; this service-side set also rejects a late call
 * after a lifecycle flight/journal owns the row. Kept separate from WRITE_OPS:
 * WRITE_OPS is a remote-security allowlist, and widening it would accidentally
 * expose local-only Git controls to relay clients. */
const LIFECYCLE_GATED_WORKSPACE_OPS = new Set<string>([
  "file.write",
  // Rewrites the checkout AND the index (sparse patterns + skip-worktree
  // bits), so it belongs on the barrier for the same reason checkoutBranch
  // does: archive/delete drains in-flight work before snapshotting or removing
  // a worktree, and an unregistered sparse-checkout would still be
  // materializing or deleting folders underneath it.
  "workspace.setWorkingDirectories",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.clean",
  "git.commit",
  "git.push",
  "git.pull",
  "git.rebase",
  "git.fetch",
  "git.stashSave",
  "git.stashPop",
  "git.checkoutBranch",
  "git.createBranch",
  "git.renameBranch",
  "git.reset",
  "git.restore",
  "git.merge",
  "git.cherryPick",
  "git.revert",
  "git.continue",
  "git.abort",
  "git.stashApply",
  "git.stashDrop",
  "git.deleteBranch",
  "git.stageHunk",
  "git.unstageHunk",
  "git.discardHunk",
  "git.tagCreate",
  "git.tagDelete",
  "gh.prCreate",
  "gh.prMerge",
  "turns.reset",
  "turns.undoReset",
  "workspace.continueOnNewBranch",
  "workspace.proposeBranchName",
  "detach.start",
]);

/** Read (non-mutating) ops a RELAY client is permitted to invoke — the
 *  deny-by-default allowlist for remote reads (the engine gates on this BEFORE
 *  dispatch; see ZerosEngine.handleWorkspaceMessage). This is the EXACT set the
 *  web client drives over the bridge today (enumerated 1:1 from
 *  src/zeros/bridge/workspace-bridge.ts) — every helper there maps to one of
 *  these, so the allowlist is complete and the web has ZERO read regression. A
 *  read NOT listed here is refused for remote clients (an unknown/future op can't
 *  silently expose data). LOCAL desktop clients bypass this gate entirely.
 *
 *  Notes:
 *   • `workspace.get`, `workspace.lifecycleStatus`, and
 *     `workspace.createFromBranchStatus` are intentionally ABSENT — they are
 *     exact local timeout-recovery probes, not web collection reads, so
 *     deny-by-default applies.
 *   • Write ops are NOT here; they stay gated by WRITE_OPS + the restriction list.
 *   • Chat-list mutations (chats.upsert/delete/bulkUpsert, messages.import/
 *     clear/truncateFrom) are the user's own metadata and are neither writes
 *     nor reads — they are not gated by this allowlist (a remote client edits
 *     its own chat list freely, matching the existing WRITE_OPS exclusion). */
const REMOTE_READABLE = new Set<string>([
  // Workspaces + projects (Column 1 / workspace picker)
  "workspace.list",
  "project.list",
  // Chats sidebar + handoff picker
  "chats.list",
  "chats.summariesForFolder",
  // Incremental delta sync
  "db.head",
  "db.pull",
  // Transcripts
  "messages.window",
  "messages.windowOlder",
  "messages.search",
  // Files. `file.ignored` is deliberately NOT here — see its handler.
  "file.tree",
  "file.read",
  // Host folder picker (browse to open a project remotely)
  "fs.listDir",
  // Git reads
  "git.status",
  "git.changeCounts",
  "git.changeLineCounts",
  "git.diff",
  "git.show",
  "git.log",
  "git.branches",
  "git.remoteBranches",
  "git.repoBranchCatalog",
  "git.hasChanges",
  // Turn reads (footer pills, per-turn changes filter, per-turn diff)
  "turns.list",
  "turns.get",
  "turns.diff",
  // GitHub PR reads
  "gh.authStatus",
  "gh.repoOwnerAvatar",
  "gh.prGet",
  "gh.prChecks",
  "gh.prCommits",
  "gh.prReviews",
  // Settings TOML reads (secret-shaped env values are masked for remote
  // clients in the handler; settings.migrateLegacy stays LOCAL-ONLY).
  "settings.resolve",
  "settings.read",
]);

/** Chat/transcript LIST mutations a remote client may issue without host
 *  approval. These are the user's OWN metadata (the chat sidebar + a chat's
 *  transcript), not repo writes — prompting the desktop on every chat-title
 *  edit would be absurd — so they sit in neither WRITE_OPS nor REMOTE_READABLE.
 *  They ARE part of the remote allowlist (deny-by-default), so an unknown
 *  mutation op is still refused. Enumerated 1:1 from the non-read helpers in
 *  src/zeros/bridge/workspace-bridge.ts (chats.* upserts/deletes + messages.*
 *  import/clear/truncate). Local desktop clients bypass the gate entirely. */
const REMOTE_METADATA_OPS = new Set<string>([
  "chats.upsert",
  "chats.delete",
  "chats.bulkUpsert",
  "messages.import",
  "messages.clear",
  "messages.truncateFrom",
]);

/** Top-level settings keys a REMOTE client may NOT write (any layer). These
 *  resolve into the scrubbed spawn/setup execution paths — a shell command
 *  (`scripts`), the spawned agent binary + its gateway (`providers`), an
 *  arbitrary host-file read into the agent env (`env_files`), or an MCP server
 *  the agent CLI executes (`mcp`: a stdio `command`/`args` is an arbitrary host
 *  process spawned when the agent boots the server — straight host RCE — and the
 *  engine boot-loads + live-reloads the user-level `[[mcp.servers]]` set, so a
 *  remote user-layer write would run on the next agent spawn) — so a paired
 *  device planting them is host RCE / secret exfiltration. The desktop owner
 *  edits these locally (MCP via the Customize tab). The `env` table's plain VALUES
 *  are remote-writable, but its NAMES are constrained two ways: a remote write of
 *  a secret-shaped name is refused here (see `secretEnvNamesInPatch`), and at
 *  spawn `spawnEnvNameHazard` drops any code-injection / credential-redirect /
 *  secret-shaped name from BOTH the `env` table and `env_files` (spawn-env.ts) —
 *  that spawn filter, not this denylist, is the actual backstop, since a
 *  committed file reaches it with no paired device involved. */
const REMOTE_WRITE_DENYLIST = [
  "scripts",
  "providers",
  "env_files",
  "mcp",
] as const;

/** A remote client may freely edit its OWN chat metadata (title, pin, model,
 *  effort…), but two fields are host-local capabilities it must not set from an
 *  untrusted wire object:
 *    • `additionalDirectories` widens the host Claude agent's sanctioned
 *      filesystem scope (→ ZEROS_ADDITIONAL_DIRS → SDK `Options.additionalDirectories`
 *      on the next respawn). Letting a paired-but-untrusted device upsert arbitrary
 *      absolute paths would expand local file access with no host prompt — the same
 *      class of leak the `RESOLVE_AGENT_BINARY` handler refuses for remote clients.
 *    • `fast` flips run mode (cost/behavior) and has no remote picker.
 *  On a remote upsert we keep whatever the host already persisted (or the safe
 *  default for a brand-new chat), never the value off the wire. Local desktop
 *  writes bypass this entirely. See the remote-client trust boundary. */
function preserveHostOnlyFields(c: ChatRow): ChatRow {
  const existing = getChat(c.id);
  return {
    ...c,
    additionalDirectories: existing?.additionalDirectories ?? [],
    fast: existing?.fast ?? false,
  };
}

type Params = Record<string, unknown>;

function reqStr(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `missing required string '${key}'`,
    });
  }
  return v;
}
function reqNum(p: Params, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `missing required number '${key}'`,
    });
  }
  return v;
}
const optStr = (p: Params, k: string): string | undefined =>
  typeof p[k] === "string" && (p[k] as string).length > 0
    ? (p[k] as string)
    : undefined;

const optStrArr = (p: Params, k: string): string[] | undefined => {
  const v = p[k];
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length > 0 ? arr : undefined;
};
const optNum = (p: Params, k: string): number | undefined =>
  typeof p[k] === "number" && Number.isFinite(p[k] as number)
    ? (p[k] as number)
    : undefined;
const optBool = (p: Params, k: string): boolean | undefined =>
  typeof p[k] === "boolean" ? (p[k] as boolean) : undefined;
const strArr = (p: Params, k: string): string[] =>
  Array.isArray(p[k])
    ? (p[k] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];

export class WorkspaceService {
  constructor(private readonly root: string) {
    // v11: hand the chats DB layer an authoritative folder→workspaceId resolver
    // so every chat upsert caches its owning workspace (db/chats.ts stays free of
    // a workspace-service import). Bound to this instance to read the live
    // registry; safe to wire in the constructor since it's only invoked later, at
    // upsert/backfill time — never before the DB is migrated.
    setChatWorkspaceResolver((folder) => this.workspaceIdForCwd(folder));
  }

  /** Live accessor for the engine's MCP gateway (created lazily after this
   *  service), wired by the engine so the mcp.gateway.* ops can reach it. */
  private gatewayAccessor: (() => McpGateway | null) | null = null;
  setGatewayAccessor(fn: () => McpGateway | null): void {
    this.gatewayAccessor = fn;
  }
  /** Why the gateway isn't running when it should be (start failure) — for the
   *  "Gateway unavailable" status (P0-3). null = healthy / not expected. */
  private gatewayErrorAccessor: (() => string | null) | null = null;
  setGatewayErrorAccessor(fn: () => string | null): void {
    this.gatewayErrorAccessor = fn;
  }
  /** Stores a static auth-header secret for an auth:"header" gateway backend in
   *  the engine vault (never settings/renderer) + reconnects it. Wired by the
   *  engine; driven by the LOCAL-ONLY mcp.gateway.setHeaderSecret op. */
  private gatewayHeaderSecretSetter:
    | ((url: string, headerName: string, value: string) => void)
    | null = null;
  setGatewayHeaderSecretSetter(
    fn: (url: string, headerName: string, value: string) => void,
  ): void {
    this.gatewayHeaderSecretSetter = fn;
  }
  /** Starts (or restarts) a background setup PTY. Wired by the engine (which
   *  owns the PtyService + SetupManager); driven by the LOCAL-ONLY
   *  workspace.rerunSetup op. `target` carries the cwd/repo for a ROWLESS run
   *  (the trunk / "main" synthetic workspace); a real workspace omits it and
   *  the SetupManager resolves everything from the row. */
  private setupRunner:
    | ((workspaceId: string, command: string, target?: SetupTarget) => void)
    | null = null;
  setSetupRunner(
    fn: (workspaceId: string, command: string, target?: SetupTarget) => void,
  ): void {
    this.setupRunner = fn;
  }
  /** Stops a live setup run (records "stopped", not "failed"). Wired by the
   *  engine; driven by the LOCAL-ONLY workspace.stopSetup op. */
  private setupStopper: ((workspaceId: string) => void) | null = null;
  setSetupStopper(fn: (workspaceId: string) => void): void {
    this.setupStopper = fn;
  }
  /** Kills every engine-owned process still working inside a workspace's
   *  worktree — the running setup PTY, live run-action PTYs, and shell
   *  terminals cwd'd under the folder. Wired by the engine; called BEFORE
   *  archive/delete removes the worktree, because a live `npm install` (or
   *  any busy child) recreates directories mid-removal and leaves a
   *  half-resurrected folder behind. */
  private workspaceProcessReaper:
    | ((workspaceId: string, worktreePath: string) => Promise<void>)
    | null = null;
  setWorkspaceProcessReaper(
    fn: (workspaceId: string, worktreePath: string) => Promise<void>,
  ): void {
    this.workspaceProcessReaper = fn;
  }
  /** Retires the engine's exact recursive filesystem subscription before a
   * managed checkout is moved for archive/delete. The returned release lets a
   * failed lifecycle operation make a still-live checkout observable again. */
  private workspaceCheckoutWatchSuspender:
    | ((
        workspaceId: string,
        worktreePath: string,
      ) => Promise<{ resume(): void; retire(): void }>)
    | null = null;
  setWorkspaceCheckoutWatchSuspender(
    fn: (
      workspaceId: string,
      worktreePath: string,
    ) => Promise<{ resume(): void; retire(): void }>,
  ): void {
    this.workspaceCheckoutWatchSuspender = fn;
  }
  /** Reads the live setup buffer/state for the Setup tab. Wired by the engine;
   *  driven by the LOCAL-ONLY workspace.setupInfo op. */
  private setupInfoGetter: ((workspaceId: string) => SetupInfo) | null = null;
  setSetupInfoGetter(fn: (workspaceId: string) => SetupInfo): void {
    this.setupInfoGetter = fn;
  }
  /** Starts a run-action PTY (RunManager). Wired by the engine; driven by the
   *  LOCAL-ONLY workspace.startRun op. */
  private runStarter:
    | ((args: RunStartArgs) => Promise<RunStartResult>)
    | null = null;
  setRunStarter(
    fn: (args: RunStartArgs) => Promise<RunStartResult>,
  ): void {
    this.runStarter = fn;
  }
  /** Stops a live run (records "stopped", not "failed"). Wired by the engine;
   *  driven by the LOCAL-ONLY workspace.stopRun op. */
  private runStopper: ((sessionId: string) => void) | null = null;
  setRunStopper(fn: (sessionId: string) => void): void {
    this.runStopper = fn;
  }
  /** Reads run-action statuses (live + durable). Wired by the engine; driven
   *  by the LOCAL-ONLY workspace.runInfo op. */
  private runInfoGetter:
    | ((
        sessionIds: string[],
        workspaceId: string | null,
      ) => Record<string, RunActionStatus>)
    | null = null;
  setRunInfoGetter(
    fn: (
      sessionIds: string[],
      workspaceId: string | null,
    ) => Record<string, RunActionStatus>,
  ): void {
    this.runInfoGetter = fn;
  }
  /** Reads one run's buffered output for the terminal's fast-exit replay (a run
   *  that exited before the renderer could attach — its live PTY mirror is
   *  gone). Wired by the engine; driven by the LOCAL-ONLY workspace.runLog op. */
  private runLogGetter:
    | ((sessionId: string) => { log: string; truncated: boolean })
    | null = null;
  setRunLogGetter(
    fn: (sessionId: string) => { log: string; truncated: boolean },
  ): void {
    this.runLogGetter = fn;
  }
  /** Resolve + kick off a workspace's background setup PTY (host shell — LOCAL
   *  ONLY). Shared by workspace.rerunSetup and the post-restore auto-setup so an
   *  unarchived worktree gets its gitignored deps (node_modules, .venv, …) back —
   *  bulk ignored dependencies aren't captured in the archive checkpoint.
   *  Returns whether a setup command was found + started; no-op (false) when the
   *  repo has no setup configured or the runner isn't wired (e.g. unit tests).
   *  Fire-and-forget — the PTY runs in the background (Setup tab), so callers
   *  don't await completion. */
  private assertWorkspaceProcessStartAllowed(ws: Workspace): void {
    const lifecycle = getWorkspaceLifecycleStatus(ws.id);
    const unavailable =
      ws.archivedAt != null ||
      lifecycle.active ||
      lifecycle.operation != null ||
      !fs.existsSync(ws.path);
    if (!unavailable) return;
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        ws.archivedAt != null
          ? "This workspace is archived."
          : lifecycle.operation != null
            ? `This workspace is currently in a ${lifecycle.operation} operation.`
            : "This workspace's checkout is not available.",
      remediation:
        "Wait for the workspace operation to finish, then try again.",
      context: { workspaceId: ws.id },
    });
  }

  private async triggerWorkspaceSetup(ws: Workspace): Promise<boolean> {
    this.assertWorkspaceProcessStartAllowed(ws);
    const command = await resolveSetupCommand({
      repoRoot: ws.repoRoot,
      inlineCommand: resolveRepoScript(ws.repoRoot, "setup") || undefined,
      allowAutoSetup: true,
    });
    if (!command) return false;
    // Command resolution may stat files and build a login-shell environment.
    // Re-check after that await, immediately before the engine registers the
    // tracked SetupManager start.
    this.assertWorkspaceProcessStartAllowed(ws);
    this.setupRunner?.(ws.id, command);
    return true;
  }
  /** Same, for the trunk / "main" — the renderer's synthetic `local:<repoSlug>`
   *  workspace, which has NO row. The setup command runs in the repo root
   *  itself via an explicit SetupTarget, so main shares the worktrees' status
   *  language (running / passed / failed / stopped). LOCAL-ONLY callers. */
  private async triggerLocalMainSetup(
    workspaceId: string,
    repoRoot: string,
  ): Promise<boolean> {
    const command = await resolveSetupCommand({
      repoRoot,
      inlineCommand: resolveRepoScript(repoRoot, "setup") || undefined,
      allowAutoSetup: true,
    });
    if (!command) return false;
    this.setupRunner?.(workspaceId, command, {
      cwd: repoRoot,
      repoRoot,
      baseBranch: "",
    });
    return true;
  }
  /** The gateway every gateway op targets — the user-global one. (Per-repo
   *  gateways were retired with the 2026-07-17 repo-file slimming: MCP is
   *  user-level only, so there is exactly one gateway instance.) */
  private gatewayForScope(): McpGateway | null {
    return this.gatewayAccessor?.() ?? null;
  }

  isWriteOp(op: string): boolean {
    return WRITE_OPS.has(op);
  }

  /** Resolve the managed workspace whose checkout/refs an operation may mutate.
   * Public so the engine can retain the operation promise in the same barrier
   * archive/delete drains before snapshot/removal. Rowless local-main targets
   * are returned too but harmless: no workspace lifecycle ever reaps them. */
  lifecycleMutationWorkspaceId(op: string, params: Params = {}): string | null {
    if (!LIFECYCLE_GATED_WORKSPACE_OPS.has(op)) return null;
    if (op === "turns.reset") {
      const chatId = optStr(params, "chatId");
      const location = chatId ? getChatLocation(chatId) : null;
      return location
        ? this.workspaceIdForCwd(
            location.workspaceId ?? location.folder ?? undefined,
          )
        : null;
    }
    if (op === "turns.undoReset") {
      const resetId = optStr(params, "resetId");
      const record = resetId ? getResetUndo(resetId) : null;
      return record?.folder ? this.workspaceIdForCwd(record.folder) : null;
    }
    return optStr(params, "workspaceId") ?? null;
  }

  /** True when `op` is a read a RELAY client is allowed to invoke (the
   *  deny-by-default remote-read allowlist). Reads outside this set are refused
   *  for remote clients. Local clients are never gated by this. */
  remoteReadable(op: string): boolean {
    return REMOTE_READABLE.has(op);
  }

  /** The full deny-by-default gate for a RELAY client: an op is permitted only
   *  if it's a known repo write (then restriction-gated separately), an allowed
   *  remote read, or an allowed chat/transcript metadata mutation. Anything else
   *  (incl. an unknown/future op) is refused — a remote client can never reach a
   *  handler that wasn't explicitly opened to it. Local clients bypass this. */
  isRemoteAllowed(op: string): boolean {
    return (
      WRITE_OPS.has(op) ||
      REMOTE_READABLE.has(op) ||
      REMOTE_METADATA_OPS.has(op)
    );
  }

  /** Every repo root whose settings files the engine should watch: the
   *  engine's own root + every opened project. Re-evaluated per watcher tick
   *  so newly opened repos are picked up live. */
  settingsRepoRoots(): string[] {
    const roots = new Set<string>([this.root]);
    try {
      for (const p of listProjects(listWorkspaces({}))) {
        if (p.repoRoot) roots.add(p.repoRoot);
      }
    } catch {
      /* DB briefly unavailable — watch what we have */
    }
    return Array.from(roots);
  }

  /** Working-tree roots to observe for terminal/agent file and git activity:
   *  every live worktree path (agents + the terminal write there) plus every
   *  repo root (the editable "Local main" trunk). Re-evaluated per watcher tick
   *  so newly created worktrees are subscribed without an engine restart. */
  gitWatchTargets(): Array<{ root: string; workspaceId: string | null }> {
    const targets = new Map<
      string,
      { root: string; workspaceId: string | null }
    >();
    // Let a transient DB failure propagate to git/watch.ts. Its readTargets()
    // treats that as "keep the prior subscriptions"; swallowing it into []
    // here would incorrectly unwatch every repo until the next poll.
    // Archived worktrees cannot back an active File/Source panel; excluding
    // them keeps the recursive watcher set bounded as History grows.
    const all = listWorkspaces({ archived: false });
    for (const w of all) {
      if (w.path && w.present !== false) {
        targets.set(w.path, { root: w.path, workspaceId: w.id });
      }
    }
    // Read-only hot-path query: unlike listProjects(all), this does not run the
    // workspace→repo seeding transaction once per watcher tick.
    for (const repoRoot of listKnownRepoRoots()) {
      if (!targets.has(repoRoot)) {
        // A repo root has no globally unique workspace row. Keep it watchable,
        // but mark it coarse rather than leaking the host path to remote peers.
        targets.set(repoRoot, { root: repoRoot, workspaceId: null });
      }
    }
    return Array.from(targets.values());
  }

  /** Clamp a settings op's repo target: a REMOTE client may only address a
   *  repo the owner already opened (mirrors workspace.create's C1 clamp —
   *  never an arbitrary host path); the local desktop is the trusted operator
   *  on its own machine. The engine's own root always counts as known. */
  private assertSettingsRepoRoot(repoRoot: string, remote: boolean): void {
    if (!remote) return;
    const norm = WorkspaceService.normalizeFolder(repoRoot);
    if (norm === WorkspaceService.normalizeFolder(this.root)) return;
    if (!isKnownRepoRoot(repoRoot)) {
      throw new GitError({
        code: "WORKSPACE_NOT_FOUND",
        message:
          "That repository isn't open in Zeros — open the folder first, then edit its settings.",
      });
    }
  }

  /** Run a settings op, mapping its module-local error type onto the
   *  GitError shape the WORKSPACE_ERROR envelope already carries. */
  private settingsOp<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof SettingsOpError) {
        throw new GitError({ code: err.code, message: err.message });
      }
      throw err;
    }
  }

  /** Resolve a workspaceId to a folder for file ops. Throws GitError for an
   *  unknown id (never trusts a client-supplied path). Public so the engine
   *  can reuse the SAME server-side resolution to clamp a remote agent
   *  session's cwd to a managed workspace (Phase 5 invariant) instead of
   *  trusting a raw client-supplied path. */
  resolveCwd(workspaceId: string): string {
    if (workspaceId === LOCAL_MAIN_WORKSPACE_ID) return this.root;
    return getWorkspace(workspaceId).path; // throws GitError WORKSPACE_NOT_FOUND
  }

  /** Resolve a file-READ cwd. Like resolveCwd, but for a LOCAL desktop client it
   *  also accepts a registered repo ROOT path — the read-only "Local main" trunk,
   *  which has no workspace row and isn't the engine's own root. Gated by
   *  isKnownRepoRoot so only repos the owner opened are reachable (mirrors the
   *  read-only git-op trunk resolution). A REMOTE client gets the strict
   *  resolveCwd (it addresses workspaces by opaque id, never a raw host path), so
   *  this widens local Files parity without granting a remote client any new path. */
  private resolveReadCwd(workspaceId: string, remote: boolean): string {
    try {
      return this.resolveCwd(workspaceId);
    } catch (err) {
      if (!remote && isKnownRepoRoot(workspaceId)) return workspaceId;
      throw err;
    }
  }

  /** Canonicalize a pty/agent cwd token to its managed workspace id. The token
   *  may be a workspace ID (the web's opaque form) OR a real host PATH — the
   *  relaxed redaction sends real paths to trusted devices, and the desktop
   *  ALWAYS sends a path (chat.folder). Returns the id, LOCAL_MAIN_WORKSPACE_ID
   *  for the primary checkout, or null for an unmanaged folder. Lets the engine
   *  gate + scope a SHARED terminal by the per-workspace restriction list
   *  regardless of which form the client sent (the fix for the registry storing
   *  a raw path that never matched the restricted-id set). */
  workspaceIdForCwd(cwdOrId: string | undefined): string | null {
    if (!cwdOrId) return null;
    if (cwdOrId === LOCAL_MAIN_WORKSPACE_ID) return LOCAL_MAIN_WORKSPACE_ID;
    // A known workspace id? (getWorkspace throws for a path / unknown id.)
    try {
      getWorkspace(cwdOrId);
      return cwdOrId;
    } catch {
      /* not an id — resolve as a real path below */
    }
    // A path within the primary checkout (the root OR any subdir) → local-main.
    // redactChatFolderForRemote only matches the EXACT root, so a terminal opened
    // in a subdir of the main repo would otherwise resolve to nothing.
    const f = WorkspaceService.normalizeFolder(cwdOrId);
    const root = WorkspaceService.normalizeFolder(this.root);
    if (f === root || f.startsWith(root + "/")) return LOCAL_MAIN_WORKSPACE_ID;
    // Otherwise the owning managed workspace, via the SAME folder→id mapping the
    // chat redaction uses (under a workspace → its id; an unmanaged folder → an
    // ext:<hash> token or the raw string, both → null).
    const mapped = this.redactChatFolderForRemote(cwdOrId, listWorkspaces({}));
    if (mapped === LOCAL_MAIN_WORKSPACE_ID) return LOCAL_MAIN_WORKSPACE_ID;
    if (!mapped || mapped === cwdOrId || mapped.startsWith("ext:")) return null;
    return mapped;
  }

  /** A synthetic entry for the primary checkout so a remote client can browse
   *  the project root without a managed worktree. */
  private localMainEntry(): Workspace {
    return {
      id: LOCAL_MAIN_WORKSPACE_ID,
      repoSlug: "",
      repoRoot: this.root,
      branch: "",
      baseBranch: "",
      path: this.root,
      status: "in-progress",
      createdAt: 0,
      archivedAt: null,
      stashRef: null,
      prNumber: null,
      prState: null,
      prUrl: null,
      agentId: null,
      lastActiveAt: null,
      present: true,
    };
  }

  /** Strip absolute host paths from a workspace before it leaves for a RELAY
   *  client. The web UI is keyed by `id` (the engine resolves the cwd
   *  server-side from the id, never from a client-supplied path) and a chat
   *  binds to `path` only as an opaque join token — so we keep `path = id` (an
   *  opaque, non-host string that the web round-trips as `chat.folder` and that
   *  yields a non-blank display fallback) and BLANK the absolute `repoRoot`.
   *  Branch / repoSlug / status are kept for the picker's human label. Local
   *  clients never reach this — they get the full unredacted shape. */
  private redactWorkspaceForRemote(w: Workspace): Workspace {
    return {
      ...w,
      repoRoot: "",
      path: w.id,
    };
  }

  /** macOS symlinks /tmp, /var, /etc under /private — normalize so a folder
   *  captured as `/private/var/…` matches a workspace stored as `/var/…`. Mirrors
   *  the renderer's normalizePath (src/zeros/store/workspace-resolution.ts) so
   *  both sides resolve a folder to the SAME workspace. */
  private static normalizeFolder(p: string): string {
    return p.replace(/^\/private(\/(?:var|tmp|etc)\/)/, "$1");
  }

  /** Map an absolute-host-path chat `folder` to the SAME opaque token the
   *  redacted workspace list uses (`workspace.id`), so a remote client never sees
   *  a host path yet its folder still joins to a workspace (the redacted
   *  `path = id`) for the picker / spawn. The engine root → the synthetic
   *  `local-main` id. A folder under no managed workspace (a foreign/legacy
   *  path) maps to a stable, non-reversible `ext:<hash>` token — still opaque,
   *  and equal for two chats in the same folder so they group. A folder that is
   *  already a bare workspace id (a chat CREATED on web, post-redaction) or empty
   *  is passed through unchanged. */
  private redactChatFolderForRemote(
    folder: string,
    workspaces: Workspace[],
  ): string {
    if (!folder) return folder;
    // Already an opaque id (no path separator) — a web-created chat's folder, or
    // the local-main sentinel. Leave it (it's not a host path).
    if (!folder.includes("/")) return folder;
    const f = WorkspaceService.normalizeFolder(folder);
    if (f === WorkspaceService.normalizeFolder(this.root)) {
      return LOCAL_MAIN_WORKSPACE_ID;
    }
    for (const w of workspaces) {
      const wp = WorkspaceService.normalizeFolder(w.path);
      if (f === wp || f.startsWith(wp + "/")) return w.id;
    }
    // Unknown folder: emit a stable opaque token, never the raw path.
    return `ext:${createHash("sha1").update(f).digest("hex").slice(0, 12)}`;
  }

  /** Redact the absolute-path `folder` of every chat row for a remote client
   *  (resolves the workspace list ONCE for the batch). The chat list is the
   *  user's own data, but a chat's folder is often an absolute host path; map it
   *  to the same opaque token the redacted workspace list carries so the web
   *  still resolves the owning workspace without ever seeing a host path. */
  private redactChatsForRemote<T extends { folder: string }>(rows: T[]): T[] {
    if (rows.length === 0) return rows;
    // Trusted-device model: keep the REAL chat folders (remote == local). Only
    // drop chats whose workspace the owner restricted from remote — its
    // workspace is hidden, so its transcript must be too. No restrictions →
    // pass the rows through untouched.
    const restricted = listRemoteRestrictedWorkspaceIds();
    if (restricted.size === 0) return rows;
    const workspaces = listWorkspaces({});
    return rows.filter(
      (r) =>
        !restricted.has(this.redactChatFolderForRemote(r.folder, workspaces)),
    );
  }

  /** H3: whether the chat `chatId` lives in a workspace the owner restricted from
   *  remote — so a remote client must NOT be able to delete it or clear/truncate/
   *  overwrite its transcript. Resolves the chat's folder → workspace with the
   *  SAME mapping the list redaction uses (no drift). Unknown chat / no
   *  restrictions → false (allowed). Local clients never reach this. */
  private remoteChatRestricted(chatId: string): boolean {
    const restricted = listRemoteRestrictedWorkspaceIds();
    if (restricted.size === 0) return false;
    const chat = listChats().find((c) => c.id === chatId);
    if (!chat) return false;
    return restricted.has(
      this.redactChatFolderForRemote(chat.folder, listWorkspaces({})),
    );
  }

  async handle(
    op: string,
    params: Params = {},
    opts: { remote?: boolean } = {},
  ): Promise<unknown> {
    const remote = opts.remote === true;
    const lifecycleMutationWorkspaceId = this.lifecycleMutationWorkspaceId(
      op,
      params,
    );
    if (lifecycleMutationWorkspaceId) {
      const workspace = getWorkspaceById(lifecycleMutationWorkspaceId);
      if (workspace) this.assertWorkspaceProcessStartAllowed(workspace);
    }
    // H3: a remote client may freely edit its OWN chat metadata, but it must not
    // DESTROY a chat/transcript that lives in a remote-restricted workspace (that
    // chat is hidden from its list, so its data must be non-destroyable too).
    // Gate the destructive metadata ops on the target chat's workspace before the
    // switch reaches them. (chats.upsert/bulkUpsert add/move the client's own
    // rows and carry no existing-chat target, so they're not gated here.)
    if (remote) {
      const targetChatId =
        op === "chats.delete"
          ? optStr(params, "id")
          : op === "messages.clear" ||
              op === "messages.truncateFrom" ||
              op === "messages.import"
            ? optStr(params, "chatId")
            : undefined;
      if (targetChatId && this.remoteChatRestricted(targetChatId)) {
        throw new GitError({
          code: "REMOTE_RESTRICTED",
          message: "This chat is in a workspace restricted from remote access.",
        });
      }
    }
    switch (op) {
      // ── Read: workspaces + files ──────────────────────────
      case "workspace.list": {
        const archived = optBool(params, "archived");
        const list = listWorkspaces({
          status: optStr(params, "status") as WorkspaceStatus | undefined,
          repoSlug: optStr(params, "repoSlug"),
          archived,
        });
        // The synthetic local-main trunk is a LIVE entry — never part of an
        // archived-only list (History).
        const base =
          archived === true ? list : [this.localMainEntry(), ...list];
        // Enrich with per-row `hasChanges` ONLY when asked (the Dashboard) — this
        // fires git probes per live row, so the sidebar's frequent refetches
        // (which don't pass withChanges) stay git-free.
        const workspaces =
          optBool(params, "withChanges") === true
            ? await stampChangeState(base)
            : base;
        if (!remote) return { workspaces };
        // Relay client: drop workspaces the owner restricted from remote
        // (opt-out; default share-all). Real paths are kept — under the
        // trusted-device model (remote == local) a paired device is an operator
        // and needs real paths to open/spawn/create like local; the restriction
        // list, NOT path-hiding, is the boundary (a restricted workspace is gone
        // from this list entirely).
        const restricted = listRemoteRestrictedWorkspaceIds();
        return {
          workspaces: workspaces.filter((w) => !restricted.has(w.id)),
        };
      }
      // ── Remote-access restriction (per-workspace opt-out) ──
      // NOT on the remote allowlist (isRemoteAllowed) → these are LOCAL-ONLY:
      // the deny-by-default gate rejects them for a remote client, so a remote
      // device can neither read nor change what's hidden from it. The desktop
      // owner manages the list from repo settings.
      case "workspace.listRemoteRestricted": {
        return { ids: Array.from(listRemoteRestrictedWorkspaceIds()) };
      }
      case "workspace.setRemoteRestricted": {
        setWorkspaceRemoteRestricted(
          reqStr(params, "workspaceId"),
          params.restricted === true || params.restricted === "true",
        );
        return { ok: true };
      }
      // ── Working directories (per-worktree sparse-checkout) ──
      // LOCAL-ONLY for the same reason as the restriction list above: applying
      // a selection REMOVES folders from the checkout, and a paired device is
      // not the place to do that blind. Both ops are off the remote allowlist
      // so the deny-by-default gate rejects them together — a remote client
      // never sees a picker it could not save.
      //
      // No Zeros-side persistence on purpose: git already stores the cone in
      // the worktree's own `.git` config and it survives restarts. A second
      // copy in settings could only drift from the real thing.
      case "workspace.listWorkingDirectories": {
        return getWorkingDirectories(
          this.resolveReadCwd(reqStr(params, "workspaceId"), remote),
        );
      }
      case "workspace.setWorkingDirectories": {
        const raw = params.directories;
        if (!Array.isArray(raw)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "directories must be an array of directory names.",
          });
        }
        const workspaceId = reqStr(params, "workspaceId");
        const cwd = this.resolveReadCwd(workspaceId, remote);
        const directories = raw.filter(
          (d): d is string => typeof d === "string",
        );
        // Deafen the worktree watcher for the duration — the single most
        // expensive part of this operation, and the reason a save on a real
        // monorepo timed out.
        //
        // Chokidar subscribes PER DIRECTORY (v4 has no recursive mode), so
        // unlinking a folder makes it re-read every surviving parent directory
        // once per batch of events while tearing down one subscription per
        // removed subdirectory — all on the engine's single Bun thread. Measured
        // on Linux against a synthetic repo, watcher attached vs. not:
        //
        //     8k files   149ms → 630ms    (263ms of event-loop lag)
        //    30k files   387ms → 1766ms   (563ms)
        //    60k files   795ms → 3403ms   (1075ms)
        //
        // macOS is worse: each subscription is its own FSEvents stream and every
        // ancestor stream sees the same subtree events. Past ~15s of blocked
        // loop the host watchdog stops getting /health back, SIGKILLs the engine
        // MID-`git sparse-checkout` (the child shares the engine's process
        // group), and the renderer's in-flight request rejects with "Request
        // timeout: engine disconnected" — a scary error for work that was
        // succeeding. The same hazard is already handled this way for
        // archive/delete; this is the same rewrite with the same cure.
        //
        // Nothing is lost by going deaf: the op broadcasts its own DB_CHANGED,
        // which is the invalidation the watcher would have produced anyway.
        const suspension = await this.workspaceCheckoutWatchSuspender?.(
          workspaceId,
          cwd,
        );
        try {
          return await setWorkingDirectories(cwd, directories);
        } finally {
          // Always resume, including after a throw: the checkout is still live
          // (unlike archive/delete, nothing moved it), so leaving it unwatched
          // would silently stop reporting terminal/agent edits until restart.
          suspension?.resume();
        }
      }
      // ── Write: create a workspace (worktree) ──
      // A WRITE op, so remotely it runs through the same trust gate as other
      // writes (allowed for a trusted device; the repo isn't a restricted
      // workspace). Lets the web/phone create a new workspace — remote == local.
      case "workspace.create": {
        const repoRoot = reqStr(params, "repoRoot");
        if (remote) {
          // SECURITY (C1 — was an RCE): a remote client may ONLY create a worktree
          // in a repo the owner already opened — never an arbitrary host path —
          // and the RCE-capable inputs (setupScript / copyPaths / symlinkPaths)
          // are DROPPED (local-only). Without this, workspace.create skipped the
          // write gate (no workspaceId to restriction-check) → arbitrary-repo
          // `git worktree add` + setup-script execution with the full host env.
          if (!isKnownRepoRoot(repoRoot)) {
            throw new GitError({
              code: "WORKSPACE_NOT_FOUND",
              message:
                "That repository isn't open in Zeros — open the folder first, then create a workspace.",
            });
          }
          return createWorkspace({
            repoRoot,
            repoSlug: optStr(params, "repoSlug"),
            baseBranch: optStr(params, "baseBranch"),
            prompt: optStr(params, "prompt"),
            agentId: optStr(params, "agentId"),
            // Remote create must not trigger the repo's `scripts.setup` (host
            // shell). The committed/working-tree TOML is not a remote-trusted
            // execution source — see REMOTE_WRITE_DENYLIST.
            runRepoScripts: false,
          });
        }
        return createWorkspace({
          repoRoot,
          repoSlug: optStr(params, "repoSlug"),
          baseBranch: optStr(params, "baseBranch"),
          prompt: optStr(params, "prompt"),
          setupScript: optStr(params, "setupScript"),
          copyPaths: optStrArr(params, "copyPaths"),
          symlinkPaths: optStrArr(params, "symlinkPaths"),
          agentId: optStr(params, "agentId"),
          // Optimistic-navigation handshake: the id + branch previously
          // reserved by workspace.prepareCreate. LOCAL-ONLY (the remote branch
          // above never forwards them) — a relay client gets a plain create.
          preparedId: optStr(params, "preparedId"),
          preparedBranch: optStr(params, "preparedBranch"),
          optimisticChatId: optStr(params, "optimisticChatId"),
          // H6: only the LOCAL desktop path may auto-pickup `.zeros/setup.sh`
          // (and even then only with the ZEROS_AUTORUN_SETUP_SH opt-in). The
          // remote branch above never sets this, so a remote client can't make a
          // repo-resident script run.
          allowAutoSetup: true,
        });
      }

      // ── Write: prepare a workspace identity for instant navigation. ──
      // LOCAL-ONLY: it is on no remote allowlist (deny-by-default refuses a
      // relay client before this guard), so keep the defence-in-depth check
      // anyway. Cheap and metadata-only by contract — validation + naming, no
      // mkdir/git mutation — so a disconnected caller leaks no directory.
      case "workspace.prepareCreate": {
        if (remote) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "workspace.prepareCreate is local-only.",
          });
        }
        return prepareWorkspaceCreate({
          repoRoot: reqStr(params, "repoRoot"),
          repoSlug: optStr(params, "repoSlug"),
          prompt: optStr(params, "prompt"),
        });
      }

      // ── Setup tab: live setup output + state. LOCAL-ONLY (absent from every
      // remote allowlist) so a remote client can't read host setup output. The
      // buffer/command come from the engine's SetupManager (injected getter);
      // a real workspace's `state` is also persisted on the row. The trunk /
      // "main" (synthetic `local:` id, no row) passes `repoRoot` instead and
      // reads the in-memory entry only. ──
      case "workspace.setupInfo": {
        const workspaceId = reqStr(params, "workspaceId");
        const ws = getWorkspaceById(workspaceId);
        const repoRoot = ws?.repoRoot ?? optStr(params, "repoRoot");
        if (!repoRoot) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found.",
          });
        }
        const live: SetupInfo | null =
          this.setupInfoGetter?.(workspaceId) ?? null;
        const state = live?.state ?? ws?.setupState ?? null;
        // statusOnly: the Setup tab-dot poller refires on every workspaces
        // broadcast and needs just `state` — skip the command resolution
        // (disk stat + login-shell PATH) and the log payload (up to 512 KB).
        // The other fields are placeholders in this mode.
        if (optBool(params, "statusOnly")) {
          return {
            hasCommand: false,
            command: null,
            state,
            log: "",
            truncated: false,
          };
        }
        const command = await resolveSetupCommand({
          repoRoot,
          inlineCommand: resolveRepoScript(repoRoot, "setup") || undefined,
          allowAutoSetup: true,
        });
        // omitLog: the chat's provenance row needs `hasCommand` (to tell
        // "Configure setup script" from "Completed setup script") but never
        // renders the output — and it re-pulls on every workspaces broadcast
        // like the tab dot does. Shipping the log to it would push up to
        // 512 KB over the bridge per broadcast for bytes nothing reads.
        // statusOnly can't serve this: it reports hasCommand:false as a
        // placeholder, which would read as "no setup script configured".
        if (optBool(params, "omitLog")) {
          return {
            hasCommand: !!command,
            command: live?.command ?? command,
            state,
            log: "",
            truncated: false,
          };
        }
        return {
          hasCommand: !!command,
          command: live?.command ?? command,
          state,
          log: live?.log ?? "",
          truncated: live?.truncated ?? false,
        };
      }
      // ── Setup tab: (re)run setup in the background. LOCAL-ONLY: it runs host
      // shell, so the C1 RCE gate must keep a remote client from triggering it.
      // (It's not on any remote allowlist, so isRemoteAllowed already refuses a
      // remote client before here — this guard is defence in depth.) A real
      // workspace runs in its worktree; the trunk (`local:` id + `repoRoot`)
      // runs in the repo root itself. ──
      case "workspace.rerunSetup": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_RESTRICTED",
            message: "Setup can only be run from the desktop app.",
          });
        }
        const workspaceId = reqStr(params, "workspaceId");
        const ws = getWorkspaceById(workspaceId);
        const localRepoRoot = optStr(params, "repoRoot");
        if (!ws && !localRepoRoot) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found.",
          });
        }
        const started = ws
          ? await this.triggerWorkspaceSetup(ws)
          : await this.triggerLocalMainSetup(workspaceId, localRepoRoot!);
        return { ok: started, hasCommand: started };
      }
      // ── Setup tab: stop a live setup run (records "stopped", not "failed").
      // LOCAL-ONLY, same defence-in-depth remote guard as rerunSetup. ──
      case "workspace.stopSetup": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_RESTRICTED",
            message: "Setup can only be controlled from the desktop app.",
          });
        }
        const workspaceId = reqStr(params, "workspaceId");
        if (!getWorkspaceById(workspaceId) && !optStr(params, "repoRoot")) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found.",
          });
        }
        this.setupStopper?.(workspaceId);
        return { ok: true };
      }
      // ── Run tab: per-action run statuses (live + durable last-run). LOCAL-
      // ONLY (absent from every remote allowlist), mirroring workspace.setupInfo.
      // The renderer supplies the deterministic per-action session ids it
      // computed (runSessionId); durable rows come from the workspace row when
      // one exists — the trunk (`local:` id, no row) reads in-memory only. ──
      case "workspace.runInfo": {
        const workspaceId = reqStr(params, "workspaceId");
        const ws = getWorkspaceById(workspaceId);
        const repoRoot = ws?.repoRoot ?? optStr(params, "repoRoot");
        if (!repoRoot) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found.",
          });
        }
        const raw = (params as { sessionIds?: unknown }).sessionIds;
        const sessionIds = Array.isArray(raw)
          ? raw.filter(
              (s): s is string => typeof s === "string" && isRunSessionId(s),
            )
          : [];
        return {
          actions: this.runInfoGetter?.(sessionIds, ws ? ws.id : null) ?? {},
        };
      }
      // ── Run tab: start (or focus) a run action in the background. LOCAL-ONLY:
      // it runs a host shell, so the C1 RCE gate must keep a remote client from
      // triggering it (defence in depth — it's not on any remote allowlist).
      // The COMMAND is resolved engine-side from the repo's settings by
      // actionId; the client never supplies it. A real workspace runs in its
      // worktree; the trunk (`local:` id + `repoRoot`) in the repo root. ──
      case "workspace.startRun": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_RESTRICTED",
            message: "Run actions can only be started from the desktop app.",
          });
        }
        const workspaceId = reqStr(params, "workspaceId");
        const ws = getWorkspaceById(workspaceId);
        const localRepoRoot = optStr(params, "repoRoot");
        const repoRoot = ws?.repoRoot ?? localRepoRoot;
        if (!repoRoot) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "Workspace not found.",
          });
        }
        const actionId = reqStr(params, "actionId");
        const sessionId = reqStr(params, "sessionId");
        if (!isRunSessionId(sessionId)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "Not a run session id.",
          });
        }
        const action = resolveRunActions(repoRoot).find(
          (a) => a.id === actionId,
        );
        if (!action || !this.runStarter) {
          return { ok: false, hasCommand: false, alreadyRunning: false };
        }
        if (ws) this.assertWorkspaceProcessStartAllowed(ws);
        const res = await this.runStarter({
          sessionId,
          workspaceId: ws ? ws.id : null,
          actionId,
          command: action.command,
          oneShot: runActionOneShot(action),
          cwd: ws?.path ?? repoRoot,
          repoRoot,
        });
        return {
          ok: true,
          hasCommand: true,
          alreadyRunning: res.alreadyRunning,
          // A Stop (or the archive reaper) landed while the env was still
          // resolving, so nothing spawned. Passed through so the renderer does
          // not open a run tab that would attach to nothing — see RunStartResult.
          cancelled: res.cancelled === true,
        };
      }
      // ── Run tab: stop a live run (records "stopped", not "failed").
      // LOCAL-ONLY, same defence-in-depth remote guard as startRun. ──
      case "workspace.stopRun": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_RESTRICTED",
            message: "Run actions can only be controlled from the desktop app.",
          });
        }
        const sessionId = reqStr(params, "sessionId");
        if (!isRunSessionId(sessionId)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "Not a run session id.",
          });
        }
        this.runStopper?.(sessionId);
        return { ok: true };
      }
      // ── Run tab: one run's buffered output. The terminal replays this when it
      // mounts too late to attach to a fast-exiting run PTY (an instant build/
      // lint failure, a dev server that died on boot) — the live PTY mirror is
      // disposed on exit, so this engine buffer is the only copy. LOCAL-ONLY
      // (absent from every remote allowlist, like workspace.runInfo) — run
      // output is host data. Unknown / non-run ids read back empty. ──
      case "workspace.runLog": {
        const sessionId = reqStr(params, "sessionId");
        if (!isRunSessionId(sessionId)) {
          return { log: "", truncated: false };
        }
        return this.runLogGetter?.(sessionId) ?? { log: "", truncated: false };
      }
      // ── Read: projects (Column 1) — unified Zeros DB, seeded from workspaces ──
      // ── Read: browse host directories (folder picker) ──
      // Lets the web/phone pick a folder on the host to open as a project.
      // Remote-readable (trusted-device model); read-only.
      case "fs.listDir": {
        return listHostDirectories(optStr(params, "path"), remote);
      }

      case "project.list": {
        // Projects come from the repos table — populated ONLY by explicit user
        // actions (desktop "open folder" → project.upsert write-through). We do
        // NOT seed the engine's OWN root (the synthetic local-main entry) as a
        // project: auto-adding the daemon's cwd is the phantom-projects
        // anti-pattern (it surfaced the dev source tree + its parent repo). We
        // still pass the real managed worktrees so a worktree's parent repo —
        // which the user DID open to create it — has a row even if write-through
        // hasn't landed yet; the engine's own root is excluded.
        const all = listWorkspaces({});
        const projects = listProjects(all);
        // Trusted-device model (remote == local): send the REAL repoRoot +
        // origin so the web can open folders and create workspaces by path,
        // exactly like the desktop. (Path-hiding was superseded by the
        // per-workspace restriction list as the access boundary.)
        return { projects };
      }
      // ── Write: projects (Phase 1b desktop write-through; restriction-gated remote) ──
      case "project.upsert": {
        const repoRoot = reqStr(params, "repoRoot");
        assertRemoteRepoRootAllowed(repoRoot, remote);
        upsertRepoByRoot({
          repoRoot,
          repoSlug: optStr(params, "repoSlug"),
          name: optStr(params, "name"),
          originUrl: optStr(params, "originUrl") ?? null,
        });
        return { ok: true };
      }
      case "project.remove": {
        removeRepoByRoot(reqStr(params, "repoRoot"));
        return { ok: true };
      }
      case "project.rename": {
        renameRepoByRoot(reqStr(params, "repoRoot"), reqStr(params, "name"));
        return { ok: true };
      }
      case "project.bulkUpsert": {
        const raw = Array.isArray(params.projects) ? params.projects : [];
        const rows = raw
          .map((p) => {
            const o = (p ?? {}) as Record<string, unknown>;
            return {
              repoRoot: typeof o.repoRoot === "string" ? o.repoRoot : "",
              repoSlug: typeof o.repoSlug === "string" ? o.repoSlug : undefined,
              name: typeof o.name === "string" ? o.name : undefined,
              originUrl: typeof o.originUrl === "string" ? o.originUrl : null,
            };
          })
          .filter((p) => p.repoRoot);
        // Fail-closed: a remote batch with ANY path outside ~ is rejected whole.
        for (const r of rows) assertRemoteRepoRootAllowed(r.repoRoot, remote);
        bulkUpsertRepos(rows);
        return { ok: true };
      }

      // ── Team context (O4) — the team settings layer ──
      // The renderer (which owns the control-plane session) couriers the
      // active team's settings doc into the engine's in-memory slot.
      // LOCAL-ONLY via the deny-by-default remote allowlists AND an explicit
      // guard — a paired remote device must never plant settings that feed
      // agent spawns on this machine.
      case "team.setContext": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_RESTRICTED",
            message: "team.setContext is local-only.",
          });
        }
        const doc =
          typeof params.doc === "object" &&
          params.doc !== null &&
          !Array.isArray(params.doc)
            ? (params.doc as Record<string, unknown>)
            : null;
        setTeamContext({ teamId: optStr(params, "teamId") ?? null, doc });
        return { ok: true, ...getTeamContextMeta() };
      }

      // ── Settings (TOML layers — engine-owned; plan §4.3) ──
      // Layered settings.toml files: user (~/.zeros) + per-repo (.zeros/ in the
      // repo). The engine is the ONLY reader/writer; clients see resolved
      // values + per-leaf provenance over these ops. Repo layers are addressed
      // by repoRoot; a REMOTE client may only target a repo the owner opened
      // (same clamp as workspace.create — never an arbitrary host path).
      case "settings.resolve": {
        const repoRoot = optStr(params, "repoRoot");
        // mainRepoRoot (optional, per-workspace view): repo-local resolves from
        // the main checkout, workspace-local from the worktree `repoRoot`.
        const mainRepoRoot = optStr(params, "mainRepoRoot");
        if (repoRoot) this.assertSettingsRepoRoot(repoRoot, remote);
        if (mainRepoRoot) this.assertSettingsRepoRoot(mainRepoRoot, remote);
        const resolved = this.settingsOp(() =>
          opSettingsResolve(repoRoot, mainRepoRoot),
        );
        return remote ? redactResolvedForRemote(resolved) : resolved;
      }
      // Files to copy — everything the settings pane renders in one read:
      // which source won (.worktreeinclude / file_include_globs / the default),
      // what those patterns resolve to ON DISK right now, per-pattern match
      // counts, and which rows need a warning. `patterns` previews an UNSAVED
      // draft from the textarea.
      //
      // LOCAL-ONLY (absent from every remote allowlist). It expands patterns
      // into the actual on-disk set of GITIGNORED paths — exactly what
      // `file.tree` filters out for remote clients and `file.read` refuses to
      // open — plus their sizes and the verbatim text of `.worktreeinclude`.
      // A caller-supplied `patterns: ["*"]` turns it into a directory listing
      // of every ignored file in any repo the owner has opened, and an
      // attacker-chosen list also drives up to MAX_ATTRIBUTED_PATTERNS extra
      // tree walks per request. The settings pane is a desktop surface; when a
      // remote one needs this, it needs its own filtered shape, not this one.
      case "filesToCopy.preview": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_PATH_DENIED",
            message: "Files-to-copy preview is only available on the desktop.",
          });
        }
        const repoRoot = reqStr(params, "repoRoot");
        const mainRepoRoot = optStr(params, "mainRepoRoot");
        return await previewFilesToCopy(repoRoot, {
          ...(mainRepoRoot ? { mainRepoRoot } : {}),
          // Not optStrArr: an EMPTY draft array is meaningful ("I cleared the
          // box"), and optStrArr collapses it to undefined ("use the saved
          // patterns") — the preview would then contradict the box.
          ...(Array.isArray(params.patterns)
            ? { patterns: strArr(params, "patterns") }
            : {}),
        });
      }
      case "settings.read": {
        const layer = reqStr(params, "layer");
        if (!(READABLE_LAYERS as readonly string[]).includes(layer)) {
          throw new GitError({
            code: "SETTINGS_BAD_LAYER",
            message: `Unknown settings layer '${layer}'.`,
          });
        }
        const repoRoot = optStr(params, "repoRoot");
        if (repoRoot) this.assertSettingsRepoRoot(repoRoot, remote);
        const result = this.settingsOp(() =>
          opSettingsRead(layer as ReadableLayer, repoRoot),
        );
        // Strip the raw `text` for remote — it's the unmasked file (secret-shaped
        // env VALUES would leak); the redacted `doc` is enough for the web form.
        return remote
          ? { ...result, doc: redactDocForRemote(result.doc), text: undefined }
          : result;
      }
      case "settings.write": {
        const layer = reqStr(params, "layer");
        if (!(WRITABLE_LAYERS as readonly string[]).includes(layer)) {
          throw new GitError({
            code: "SETTINGS_BAD_LAYER",
            message: `Settings layer '${layer}' is not writable.`,
          });
        }
        const repoRoot = optStr(params, "repoRoot");
        if (repoRoot) this.assertSettingsRepoRoot(repoRoot, remote);
        const patch = params.patch;
        if (
          typeof patch !== "object" ||
          patch === null ||
          Array.isArray(patch)
        ) {
          throw new GitError({
            code: "SETTINGS_BAD_PATCH",
            message: "settings.write requires a `patch` object.",
          });
        }
        // SECURITY: a REMOTE (paired-but-untrusted) client may NOT write the
        // execution/IO-bearing keys. These flow into the *scrubbed* spawn/setup
        // paths (shell scripts, the spawned agent binary, arbitrary host-file
        // reads via env_files) — letting a remote client plant them re-arms the
        // exact RCE / exfiltration vectors the workspace.create (C1) + env-scrub
        // (H6) hardening was built to prevent. Remote writes are confined to
        // declarative config (git, env values [name-denylisted at spawn],
        // workspaces). The desktop is the trusted local operator.
        if (remote) {
          const denied = REMOTE_WRITE_DENYLIST.filter((k) =>
            Object.prototype.hasOwnProperty.call(patch, k),
          );
          if (denied.length > 0) {
            throw new GitError({
              code: "SETTINGS_REMOTE_KEY_DENIED",
              message: `Remote clients cannot write settings keys: ${denied.join(", ")}. Edit these on the desktop.`,
            });
          }
          // Symmetric with read masking: a paired device may not park a
          // secret-shaped NAME in the `env` table. (Reads already mask these and
          // the spawn path strips them, but refusing the write keeps the file
          // itself clean and tells the client why.)
          const secretEnvNames = secretEnvNamesInPatch(patch);
          if (secretEnvNames.length > 0) {
            throw new GitError({
              code: "SETTINGS_REMOTE_SECRET_ENV",
              message: `Remote clients cannot set secret-shaped env names: ${secretEnvNames.join(", ")}. Keep credentials in the Keychain; edit the env table on the desktop.`,
            });
          }
        }
        return this.settingsOp(() =>
          opSettingsWrite(
            layer as WritableLayer,
            patch as Record<string, unknown>,
            repoRoot,
          ),
        );
      }
      case "settings.writeRaw": {
        // LOCAL-ONLY: raw text bypasses the per-key denylist settings.write
        // enforces (a remote raw write could plant scripts/secrets), so it sits
        // on no remote allowlist. Defensive guard in case that ever changes.
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "Raw settings editing is desktop-only.",
          });
        }
        const layer = reqStr(params, "layer");
        if (!(WRITABLE_LAYERS as readonly string[]).includes(layer)) {
          throw new GitError({
            code: "SETTINGS_BAD_LAYER",
            message: `Settings layer '${layer}' is not writable.`,
          });
        }
        const repoRoot = optStr(params, "repoRoot");
        if (repoRoot) this.assertSettingsRepoRoot(repoRoot, remote);
        const text = params.text;
        if (typeof text !== "string") {
          throw new GitError({
            code: "SETTINGS_BAD_PATCH",
            message: "settings.writeRaw requires a `text` string.",
          });
        }
        return this.settingsOp(() =>
          opSettingsWriteRaw(layer as WritableLayer, text, repoRoot),
        );
      }
      // LOCAL-ONLY: the adopt wizard reads the user's home MCP config files
      // (Cursor / Claude / Codex / Factory), which can hold secrets — never
      // exposed to a remote client, and it runs on the desktop anyway.
      case "mcp.scanNative": {
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "Scanning other tools' MCP configs is desktop-only.",
          });
        }
        const scanRoots = Array.isArray(
          (params as { repoRoots?: unknown })?.repoRoots,
        )
          ? ((params as { repoRoots?: unknown[] }).repoRoots ?? []).filter(
              (r): r is string => typeof r === "string",
            )
          : [];
        return { sources: scanNativeMcpConfigs(undefined, scanRoots) };
      }
      case "mcp.resolveComposed": {
        // Read-only: the MERGED user-scope MCP registry (user + managed; a
        // repo's own repo-local servers are read directly off that layer by
        // the Customize tab's repo scope), each server tagged with the layer
        // it came from, for the Customize → MCP source badges.
        // Local-only. Legacy repoRoot/mainRepoRoot params are ignored.
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP resolve is desktop-only.",
          });
        }
        const r = resolveMcpServers();
        const direct = r.servers.map((s, i) => ({
          name: s.name,
          transport: s.transport,
          ...(s.transport === "http"
            ? { url: s.url }
            : { command: s.command, ...(s.args ? { args: s.args } : {}) }),
          source: r.sources[i]!,
        }));
        const gateway = r.gatewayBackends.map((b) => ({
          name: b.name,
          transport: "http" as const,
          url: b.url,
          source: b.source,
          auth: b.auth,
        }));
        return { servers: [...direct, ...gateway], warnings: r.warnings };
      }
      // LOCAL-ONLY: the MCP gateway holds OAuth tokens + opens the system
      // browser — all desktop concerns, never driven from a remote client.
      case "mcp.gateway.status": {
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP gateway status is desktop-only.",
          });
        }
        const gw = this.gatewayForScope();
        return {
          running: gw?.running ?? false,
          error: this.gatewayErrorAccessor?.() ?? null,
          servers: gw?.getStatuses() ?? [],
        };
      }
      case "mcp.gateway.authorize": {
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP sign-in is desktop-only.",
          });
        }
        const gw = this.gatewayForScope();
        if (!gw) {
          throw new GitError({
            code: "MCP_GATEWAY_DOWN",
            message:
              "The MCP gateway isn't running — add an OAuth server first.",
          });
        }
        return { status: await gw.authorize(reqStr(params, "server")) };
      }
      case "mcp.gateway.disconnect": {
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP disconnect is desktop-only.",
          });
        }
        const gw = this.gatewayForScope();
        if (gw) await gw.disconnect(reqStr(params, "server"));
        return { ok: true };
      }
      case "mcp.gateway.beginAuth": {
        // Headless sign-in step 1 — return the authorization URL (no browser).
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP sign-in is desktop-only.",
          });
        }
        const gw = this.gatewayForScope();
        if (!gw) {
          throw new GitError({
            code: "MCP_GATEWAY_DOWN",
            message: "The MCP gateway isn't running.",
          });
        }
        return await gw.beginAuthorize(reqStr(params, "server"));
      }
      case "mcp.gateway.completeAuth": {
        // Headless sign-in step 2 — finish with the pasted code/URL.
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP sign-in is desktop-only.",
          });
        }
        const gw = this.gatewayForScope();
        if (!gw) {
          throw new GitError({
            code: "MCP_GATEWAY_DOWN",
            message: "The MCP gateway isn't running.",
          });
        }
        return {
          status: await gw.completeAuthorize(
            reqStr(params, "server"),
            reqStr(params, "code"),
          ),
        };
      }
      case "mcp.gateway.setHeaderSecret": {
        // LOCAL-ONLY: the secret value transits the loopback bridge once, then
        // lives engine-only in the vault — never settings.toml / remote clients.
        if (remote) {
          throw new GitError({
            code: "SETTINGS_REMOTE_KEY_DENIED",
            message: "MCP header secrets are desktop-only.",
          });
        }
        this.gatewayHeaderSecretSetter?.(
          reqStr(params, "url"),
          reqStr(params, "headerName"),
          reqStr(params, "value"),
        );
        return { ok: true };
      }
      // LOCAL-ONLY (not on any remote allowlist): one-time import of the
      // renderer's legacy localStorage settings into the TOML files.
      case "settings.migrateLegacy": {
        return this.settingsOp(() =>
          opSettingsMigrateLegacy((params ?? {}) as MigrateLegacyInput),
        );
      }
      // ── Chats (sidebar list) — Phase 2a. NOT a restriction-gated write: a chat is the
      // user's own metadata and a remote client edits its list freely (it would
      // be absurd to prompt the desktop on every chat title change). So these
      // are deliberately NOT in WRITE_OPS — direct for local AND remote. ──
      case "chats.list": {
        const chats = listChats();
        return {
          chats: remote ? this.redactChatsForRemote(chats) : chats,
          // A full list cannot represent deletions by itself. Pair it with the
          // complete tombstone set so a renderer's instant boot cache never
          // resurrects a chat deleted while that renderer was offline.
          chatDeletions: tombstonesSince("chat", 0),
        };
      }
      case "chats.summariesForFolder": {
        const exclude = optStr(params, "excludeChatId");
        const summaries = summariesForFolder(reqStr(params, "folder"), exclude);
        // Each summary carries its chat's `folder` — redact it for remote too.
        return {
          summaries: remote ? this.redactChatsForRemote(summaries) : summaries,
        };
      }
      // ── Incremental delta sync (Phase 3, real pull). `db.head` returns the
      // current global rev — a client's cursor right after a full load. `db.pull`
      // returns only what changed after the cursor: chats with rev > since +
      // tombstoned (deleted) chat ids. Both are reads. ──
      case "db.head":
        return { rev: headRev() };
      case "db.pull": {
        const since = optNum(params, "since") ?? 0;
        const chats = listChatsSince(since);
        const visibleChats = remote ? this.redactChatsForRemote(chats) : chats;
        // The MESSAGE half of delta sync: transcript rows changed since the
        // cursor + chats whose transcript was cleared/truncated (msgreset
        // tombstones → the client re-windows them). On a remote client, drop any
        // whose chat lives in a remote-restricted workspace so a hidden
        // transcript never leaks via the delta; the common (no-restriction) path
        // keeps everything.
        let messages = listChatMessagesSince(since);
        let messageResets = tombstonesSince("msgreset", since);
        // H11: if the message half hit its cap, the rows past it are NOT in this
        // pull — so advance the cursor only to the last delivered rev, never to
        // the global head, or the client skips every capped message forever.
        // Compute the cap rev from the UNFILTERED rows (what the DB returned),
        // before the remote-restriction filter trims the visible subset.
        const capped = messages.length >= CHAT_MESSAGE_DELTA_CAP;
        const pullRev =
          capped && messages.length > 0
            ? Math.min(headRev(), messages[messages.length - 1].rev)
            : headRev();
        if (remote) {
          messages = messages.filter(
            (m) => !this.remoteChatRestricted(m.chatId),
          );
          messageResets = messageResets.filter(
            (id) => !this.remoteChatRestricted(id),
          );
        }
        return {
          rev: pullRev,
          chats: visibleChats,
          chatDeletions: tombstonesSince("chat", since),
          messages,
          messageResets,
        };
      }
      case "chats.upsert": {
        const c = coerceChatRow(params.chat);
        if (c) upsertChat(remote ? preserveHostOnlyFields(c) : c);
        return { ok: true };
      }
      case "chats.delete": {
        const id = reqStr(params, "id");
        // GC the chat's hidden turn/reset snapshot refs + its turn rows before
        // the chat row goes — deleteChat doesn't cascade (turns has no FK), so
        // without this a deleted chat leaks its rows AND its pinned git commits.
        const loc = getChatLocation(id);
        if (loc?.folder) await deleteAllChatSnapshotRefs(loc.folder, id);
        deleteTurnsForChat(id);
        deleteChat(id);
        return { ok: true };
      }
      case "chats.bulkUpsert": {
        const raw = Array.isArray(params.chats) ? params.chats : [];
        const rows = raw
          .map(coerceChatRow)
          .filter((c): c is ChatRow => c !== null)
          .map((c) => (remote ? preserveHostOnlyFields(c) : c));
        bulkUpsertChats(rows);
        return { ok: true };
      }
      // ── Transcripts (Phase 2b) — reads; the engine persists on emit. ──
      case "messages.window": {
        // Clamp a caller-controlled limit so a remote `limit:1e9` can't
        // materialize a whole transcript into memory. WINDOW_MAX_ROWS is also
        // the ceiling windowChatMessages honours when it extends a tail window
        // back to a turn boundary, so the two stay one number.
        const limit = Math.min(optNum(params, "limit") ?? 200, WINDOW_MAX_ROWS);
        const before = optNum(params, "before");
        return {
          messages: windowChatMessages(reqStr(params, "chatId"), limit, before),
        };
      }
      case "messages.windowOlder": {
        const limit = Math.min(optNum(params, "limit") ?? 200, WINDOW_MAX_ROWS);
        return {
          messages: windowOlderChatMessages(
            reqStr(params, "chatId"),
            limit,
            reqStr(params, "beforeMsgId"),
          ),
        };
      }
      // Phase 2c — import pre-2b transcripts into the engine so the web sees a
      // chat's FULL history (not just messages streamed after 2b). The user's
      // own data; idempotent (upsert by msg_id). The messages.import op is
      // remote-reachable (REMOTE_METADATA_OPS) and M15-bounded — see the import
      // case below.
      case "messages.search": {
        const limit = Math.min(optNum(params, "limit") ?? 50, 500);
        // H10: a remote client may search ONLY within a single chat/folder it
        // scopes to. An unscoped remote search returns nothing. CRUCIALLY the
        // scope is now PASSED to searchMessages (it was previously checked then
        // discarded, so a scoped remote query still matched the WHOLE corpus).
        // Results are additionally filtered to drop any remote-restricted chat.
        const chatId = optStr(params, "chatId");
        const folder = optStr(params, "folder");
        const scope = chatId ?? folder;
        if (remote && !scope) return { hits: [] };
        let hits = searchMessages(reqStr(params, "query"), limit, {
          chatId,
          folder,
        });
        if (remote)
          hits = hits.filter((h) => !this.remoteChatRestricted(h.chatId));
        return { hits };
      }
      case "messages.clear":
        return { cleared: clearChatMessages(reqStr(params, "chatId")) };
      case "messages.truncateFrom":
        return {
          removed: truncateChatMessagesFrom(
            reqStr(params, "chatId"),
            reqStr(params, "fromMsgId"),
          ),
        };
      case "messages.import": {
        const chatId = reqStr(params, "chatId");
        const raw = Array.isArray(params.messages) ? params.messages : [];
        // M15: messages.import is remote-reachable (REMOTE_METADATA_OPS). Bound
        // the batch, require the target chat to exist, and validate each row's
        // payload is JSON (it's later JSON.parsed for FTS + rendered) so a paired
        // device can't grow the table with unbounded / un-parseable junk.
        if (raw.length > 5000) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "messages.import: batch too large (max 5000 messages)",
          });
        }
        if (remote && !listChats().some((c) => c.id === chatId)) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "messages.import: unknown chat",
          });
        }
        const rows = raw
          .map((m) => {
            const o = (m ?? {}) as Record<string, unknown>;
            const msgId = typeof o.msgId === "string" ? o.msgId : "";
            const payload = typeof o.payload === "string" ? o.payload : "";
            if (!msgId || !payload || payload.length > 1_000_000) return null;
            try {
              JSON.parse(payload); // FTS + renderer require valid JSON
            } catch {
              return null;
            }
            return {
              msgId,
              kind: typeof o.kind === "string" ? o.kind : "",
              payload,
              createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
            };
          })
          .filter((m): m is NonNullable<typeof m> => m !== null);
        upsertChatMessagesBulk(chatId, rows);
        return { ok: true, imported: rows.length };
      }
      case "workspace.get":
        return getWorkspace(reqStr(params, "workspaceId"));
      case "workspace.lifecycleStatus":
        return getWorkspaceLifecycleStatus(reqStr(params, "workspaceId"));
      case "workspace.createFromBranchStatus":
        return getCreateWorkspaceFromBranchStatus({
          repoRoot: reqStr(params, "repoRoot"),
          repoSlug: reqStr(params, "repoSlug"),
          branchName: reqStr(params, "branchName"),
        });
      case "file.tree": {
        const cwd = this.resolveReadCwd(reqStr(params, "workspaceId"), remote);
        const files = await listWorkspaceFiles(cwd, optNum(params, "limit"));
        // Hide credential/secret files from a remote client even if they're
        // tracked (the .gitignore-respect in ls-files only hides ignored ones).
        return {
          files: remote ? files.filter((f) => !isSensitiveRepoPath(f)) : files,
        };
      }
      // ── Files tab: the .gitignore'd entries file.tree deliberately omits.
      // A separate op rather than a flag on file.tree, because that list also
      // feeds the @-mention picker and quick-open — neither of which should
      // start offering node_modules paths. LAZY: no `dir` returns the collapsed
      // ignored roots (~8 rows), `dir` returns one level inside one of them.
      //
      // LOCAL-ONLY, and not by omission — by an explicit refusal, because the
      // reasoning is easy to lose. With `dir` this is a one-level directory
      // enumerator over the worktree, and .gitignore is exactly the boundary it
      // stops honouring. That boundary was load-bearing for remote clients in a
      // way a path denylist cannot replace: `.conductor/` is gitignored and
      // holds SIBLING WORKTREES, so a remote client authorised for one
      // workspace could walk into another one's checkout — around the
      // remote-restriction list entirely — and no per-entry name filter would
      // notice, because none of those paths look sensitive. The desktop app is
      // the operator's own machine and already reads these files freely. ──
      case "file.ignored": {
        if (remote) {
          throw new GitError({
            code: "REMOTE_RESTRICTED",
            message: "Ignored files can only be listed from the desktop app.",
          });
        }
        const cwd = this.resolveReadCwd(reqStr(params, "workspaceId"), remote);
        return { entries: await listIgnoredEntries(cwd, optStr(params, "dir")) };
      }
      case "file.read": {
        const cwd = this.resolveReadCwd(reqStr(params, "workspaceId"), remote);
        const rel = reqStr(params, "path");
        if (remote && isSensitiveRepoPath(rel)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message:
              "refusing to read a secret/credential file over a remote connection",
          });
        }
        // readWorkspaceFile re-checks the RESOLVED + realpath target so a
        // collapsing path ('.env/.') or an innocuously-named symlink can't leak.
        return readWorkspaceFile(cwd, rel, { remote });
      }
      case "file.write": {
        const cwd = this.resolveReadCwd(reqStr(params, "workspaceId"), remote);
        const rel = reqStr(params, "path");
        const content = params.content;
        if (typeof content !== "string") {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: "file.write requires string content",
          });
        }
        if (remote && isSensitiveRepoPath(rel)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message:
              "refusing to write a secret/credential file over a remote connection",
          });
        }
        // writeWorkspaceFile re-checks the RESOLVED + realpath target (lexical
        // containment + symlink-escape + secret denylist) — the SAME boundary as
        // file.read — and writes atomically (tmp + rename) so a crash can't
        // truncate the file.
        return writeWorkspaceFile(cwd, rel, content, { remote });
      }

      // ── Read: git ─────────────────────────────────────────
      case "git.status": {
        const result = await status(reqStr(params, "workspaceId"));
        if (!remote) return result;
        // (#1) Mirror the file.tree/read/diff secret boundary: a remote client
        // must not ENUMERATE secret file paths via status either — `-uall` now
        // lists every untracked file individually, so an untracked secrets/.env
        // would otherwise leak its path. Filter sensitive entries (path +
        // rename oldPath) from every bucket.
        const safe = (f: { path: string; oldPath?: string }) =>
          !isSensitiveRepoPath(f.path) &&
          !(f.oldPath && isSensitiveRepoPath(f.oldPath));
        return {
          ...result,
          staged: result.staged.filter(safe),
          unstaged: result.unstaged.filter(safe),
          conflicted: result.conflicted.filter(safe),
          untracked: result.untracked.filter((p) => !isSensitiveRepoPath(p)),
        };
      }
      case "git.changeCounts":
        // Counts must describe the same rows this client can actually see. Do
        // the remote secret filtering before counting inside the engine; never
        // return the underlying path sets over the bridge.
        return changeCounts(
          reqStr(params, "workspaceId"),
          remote
            ? (path, oldPath) =>
                !isSensitiveRepoPath(path) &&
                !(oldPath && isSensitiveRepoPath(oldPath))
            : undefined,
        );
      case "git.changeLineCounts":
        // Read: the ± line pair for the same All Changes comparison. Same
        // boundary as git.changeCounts — filter inside the engine so a remote
        // client's totals never measure a file its own lists hide.
        return changeLineCounts(
          reqStr(params, "workspaceId"),
          remote
            ? (path, oldPath) =>
                !isSensitiveRepoPath(path) &&
                !(oldPath && isSensitiveRepoPath(oldPath))
            : undefined,
        );
      case "git.hasChanges":
        // Read: exact All Changes net state. Gates Create PR without enabling
        // it for a cancelling index/worktree pair. No sensitive data (just a
        // boolean), so no remote filtering is needed.
        return {
          hasChanges: await hasWorkspaceChanges(reqStr(params, "workspaceId")),
        };
      case "git.diff": {
        const filePath = optStr(params, "filePath");
        // (#4) git.diff returns file CONTENT (hunks). For a remote client,
        // refuse an explicit secret path and filter secret files out of a
        // whole-tree diff — the same boundary as file.read.
        if (remote && filePath && isSensitiveRepoPath(filePath)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message:
              "refusing to diff a secret/credential file over a remote connection",
          });
        }
        const result = await diff({
          workspaceId: reqStr(params, "workspaceId"),
          filePath,
          against: optStr(params, "against") as
            | "index"
            | "HEAD"
            | "main"
            | undefined,
          // Generalized comparison ("All changes" vs a base branch). mode:'refs'
          // base/head are caller refs — assertSafeGitRef-guarded in diffRangeArgs
          // before they reach the git argv. An unknown mode falls through to a
          // safe default in the engine.
          mode: optStr(params, "mode") as DiffMode | undefined,
          base: optStr(params, "base"),
          head: optStr(params, "head"),
          rawPatch: params.rawPatch === true,
        });
        if (remote) {
          result.hunks = filterSecretHunks(result.hunks);
          // rawPatch returns a whole-tree multi-file patch (file CONTENT) — apply
          // the same per-section secret filter as git.show, or it would leak a
          // secret file's contents in the raw text.
          if (typeof result.patch === "string") {
            result.patch = filterSecretPatch(result.patch);
          }
        }
        return result;
      }
      case "git.show": {
        // git.show returns file CONTENT — a `files` enumeration AND a raw
        // multi-file `patch`. It takes a `sha` (assertSafeGitRef-guarded in
        // showCommit), not a `filePath`, so there's no single path to refuse up
        // front; instead we filter the WHOLE commit for a remote client with the
        // shared fail-closed helpers (same boundary as git.diff/git.status).
        const result = await showCommit(
          reqStr(params, "workspaceId"),
          reqStr(params, "sha"),
        );
        if (!remote) return result;
        return {
          files: filterSecretFiles(result.files),
          patch: filterSecretPatch(result.patch),
        };
      }
      case "git.log":
        return {
          commits: await log({
            workspaceId: reqStr(params, "workspaceId"),
            limit: optNum(params, "limit"),
            since: optNum(params, "since"),
            ref: optStr(params, "ref"),
            base: optStr(params, "base"),
          }),
        };
      case "git.branches":
        return { branches: await listBranches(reqStr(params, "workspaceId")) };
      case "git.remoteBranches":
        return {
          branches: await listRemoteBranches(reqStr(params, "workspaceId")),
        };
      case "git.repoBranchCatalog": {
        // Repo page Git dropdowns — repoRoot-scoped (no workspace exists yet).
        // Same clamp as gh.repoOwnerAvatar: only repos the owner opened. A
        // remote client never triggers a host-side network fetch (read-only
        // parity with the other remote git reads).
        const repoRoot = reqStr(params, "repoRoot");
        if (!isKnownRepoRoot(repoRoot)) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "That repository isn't open in Zeros.",
          });
        }
        return repoBranchCatalog({
          repoRoot,
          remote: optStr(params, "remote"),
          fetch: remote ? false : (optBool(params, "fetch") ?? false),
        });
      }

      // ── Write: git (restriction-gated for remote clients (trusted device; no per-op prompt)) ─────
      case "git.stage":
        await stagePaths({
          workspaceId: reqStr(params, "workspaceId"),
          paths: strArr(params, "paths"),
        });
        return { ok: true };
      case "git.unstage":
        await unstagePaths({
          workspaceId: reqStr(params, "workspaceId"),
          paths: strArr(params, "paths"),
        });
        return { ok: true };
      case "git.discard":
        // discardFiles resolves the worktree server-side from workspaceId and
        // runs `git restore --worktree -- <paths>` (git's `--` confines paths to
        // the repo). In WRITE_OPS, so a remote client is restriction-gated.
        await discardFiles({
          workspaceId: reqStr(params, "workspaceId"),
          paths: strArr(params, "paths"),
        });
        return { ok: true };
      case "git.commit":
        return commit({
          workspaceId: reqStr(params, "workspaceId"),
          message: reqStr(params, "message"),
          files: Array.isArray(params.files)
            ? strArr(params, "files")
            : undefined,
          amend: optBool(params, "amend") ?? false,
        });
      case "git.push":
        return push({
          workspaceId: reqStr(params, "workspaceId"),
          setUpstream: optBool(params, "setUpstream"),
          force: optBool(params, "force") ?? false,
          remote: optStr(params, "remote"),
        });
      case "git.pull":
        return pull({
          workspaceId: reqStr(params, "workspaceId"),
          strategy: (optStr(params, "strategy") ?? "rebase") as
            | "rebase"
            | "merge",
          autoStash: optBool(params, "autoStash") ?? false,
          remote: optStr(params, "remote"),
        });
      case "git.rebase":
        return rebase({
          workspaceId: reqStr(params, "workspaceId"),
          ontoBranch: reqStr(params, "ontoBranch"),
          autoStash: optBool(params, "autoStash") ?? false,
        });
      case "git.fetch":
        return fetch({
          workspaceId: reqStr(params, "workspaceId"),
          prune: optBool(params, "prune") ?? false,
          remote: optStr(params, "remote"),
        });
      case "git.stashSave":
        return stashSave({
          workspaceId: reqStr(params, "workspaceId"),
          message: optStr(params, "message"),
        });
      case "git.stashPop":
        return stashPop({
          workspaceId: reqStr(params, "workspaceId"),
          stashRef: reqStr(params, "stashRef"),
        });
      case "git.checkoutBranch":
        await checkoutBranch({
          workspaceId: reqStr(params, "workspaceId"),
          branchName: reqStr(params, "branchName"),
          createIfMissing: optBool(params, "createIfMissing") ?? false,
        });
        return { ok: true };
      case "git.createBranch":
        await createBranchFrom({
          workspaceId: reqStr(params, "workspaceId"),
          sourceBranch: reqStr(params, "sourceBranch"),
          newBranchName: reqStr(params, "newBranchName"),
        });
        return { ok: true };
      case "git.renameBranch":
        return {
          ok: true,
          // The resulting ref, so the caller doesn't have to re-derive a
          // prefix it can't see (see renameBranch's contract).
          branch: await renameBranch({
            workspaceId: reqStr(params, "workspaceId"),
            newName: reqStr(params, "newName"),
          }),
        };
      case "git.changeTarget":
        return changeTargetBranch({
          workspaceId: reqStr(params, "workspaceId"),
          newTarget: reqStr(params, "newTarget"),
          rebase: optBool(params, "rebase") ?? false,
        });

      // ── Read: GitHub PR metadata ──────────────────────────
      // The engine GitHub fns resolve owner/repo from the workspaceId
      // themselves (workspaceRemote() → parseGitHubRemote on the workspace's
      // origin), exactly like the electron IPC handlers — so these ops just
      // pass { workspaceId, prNumber } through. PR metadata is NOT file
      // content, so there is NO secret filter (unlike git.status/diff/show).
      case "gh.authStatus":
        // No workspaceId: probes the host's token, never leaks repo paths.
        return getAuthStatus();
      case "gh.repoOwnerAvatar": {
        // Automatic repository-icon fallback. Resolve the origin from the
        // already-open checkout instead of trusting an arbitrary owner/repo
        // supplied by a bridge client. Public repositories work without GitHub
        // auth; a persisted credential also covers private repositories.
        const repoRoot = reqStr(params, "repoRoot");
        if (!isKnownRepoRoot(repoRoot)) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message: "That repository isn't open in Zeros.",
          });
        }
        try {
          const originUrl = await readOriginUrl(repoRoot);
          return await getRepositoryOwnerAvatar(originUrl);
        } catch {
          // This is a visual fallback, never a blocking GitHub operation. No
          // origin, a non-GitHub host, missing access, rate limiting, and an
          // offline network all degrade to the repository initial.
          return null;
        }
      }
      // Publish-to-GitHub (create private repo + push). Desktop-only: these ops
      // are in NONE of the remote allowlists (isRemoteAllowed), so a remote
      // client is refused before reaching here — they write the user's GitHub +
      // host fs and are driven by the desktop publish dialog.
      case "gh.listOwners":
        return listGithubOwners();
      case "gh.checkRepoName":
        return checkRepoNameAvailable({
          owner: reqStr(params, "owner"),
          name: reqStr(params, "name"),
        });
      case "gh.publishRepo": {
        // Defense-in-depth: even a LOCAL bridge caller (these ops are
        // desktop-only — refused over the remote) may only publish a repo the
        // owner already opened, never an arbitrary host path. publishRepoToGithub
        // mutates the user's GitHub and runs git in repoRoot.
        const repoRoot = reqStr(params, "repoRoot");
        if (!isKnownRepoRoot(repoRoot)) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message:
              "That repository isn't open in Zeros — open the folder first, then publish it.",
          });
        }
        return publishRepoToGithub({
          repoRoot,
          name: reqStr(params, "name"),
          owner: optStr(params, "owner"),
          private: optBool(params, "private") ?? true,
        });
      }
      // Local-only "Initialize Git": git init + initial commit, NO remote.
      // Desktop-only like the publish ops above — absent from every remote
      // allowlist, so a remote client is refused before it reaches here.
      case "git.initInPlace": {
        // Same isKnownRepoRoot clamp as gh.publishRepo: never init git in an
        // arbitrary host path supplied by a local bridge caller.
        const repoRoot = reqStr(params, "repoRoot");
        if (!isKnownRepoRoot(repoRoot)) {
          throw new GitError({
            code: "WORKSPACE_NOT_FOUND",
            message:
              "That folder isn't open in Zeros — open it first, then initialize Git.",
          });
        }
        return initRepoInPlace(repoRoot);
      }
      // Can the selected connection open a PR on this workspace's remote? A
      // read, and LOCAL-ONLY by omission from every remote allowlist: it guards
      // the desktop's Create PR control, which never renders without a native
      // runtime. Returns a status object rather than throwing — see
      // getWorkspaceRepoAccess.
      case "gh.repoAccess":
        return getWorkspaceRepoAccess(reqStr(params, "workspaceId"));
      case "gh.prGet":
        return getPr({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
        });
      case "gh.prChecks":
        return getPrChecks({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
        });
      case "gh.prCommits":
        return getPrCommits({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
        });
      case "gh.prReviews":
        return getPrReviews({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
        });

      // ── Write: GitHub PR mutations (restriction-gated for remote clients (trusted device; no per-op prompt)) ──
      case "gh.prCreate":
        return createPr({
          workspaceId: reqStr(params, "workspaceId"),
          title: reqStr(params, "title"),
          body: reqStr(params, "body"),
          draft: optBool(params, "draft") ?? true,
        });
      case "gh.prUpdate":
        return updatePr({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
          title: optStr(params, "title"),
          body: optStr(params, "body"),
        });
      case "gh.prMarkReady":
        return markPrReady({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
        });
      case "gh.prMerge": {
        const method = reqStr(params, "method");
        if (method !== "squash" && method !== "merge" && method !== "rebase") {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `gh.prMerge: 'method' must be 'squash', 'merge', or 'rebase', got "${method}"`,
          });
        }
        return mergePr({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
          method,
          commitTitle: optStr(params, "commitTitle"),
          commitMessage: optStr(params, "commitMessage"),
        });
      }
      case "gh.prComment":
        return addPrComment({
          workspaceId: reqStr(params, "workspaceId"),
          prNumber: reqNum(params, "prNumber"),
          body: reqStr(params, "body"),
        });
      case "gh.prSync":
        // Detect + backfill the workspace's PR from GitHub. Returns the PR (or
        // null) and stamps the row when a not-yet-recorded PR is found.
        return syncWorkspacePr(reqStr(params, "workspaceId"));

      // ── Phase 2 (single-writer): the remaining DB-touching ops moved off
      //    in-process Electron IPC onto the bridge. Their DB-touching handlers
      //    were removed from electron/ipc/commands/git.ts (the file remains, now
      //    DB-free). These are NOT in the remote allowlists, so a remote client is
      //    refused by deny-by-default (the gate runs before dispatch); only the
      //    LOCAL desktop reaches them. ──
      // Write: git — extended
      case "git.reset":
        await reset({
          workspaceId: reqStr(params, "workspaceId"),
          mode: reqStr(params, "mode") as ResetMode,
          ref: optStr(params, "ref"),
          confirm: optBool(params, "confirm"),
        });
        return { ok: true };
      case "git.restore":
        await restoreFrom({
          workspaceId: reqStr(params, "workspaceId"),
          paths: strArr(params, "paths"),
          source: reqStr(params, "source"),
          staged: optBool(params, "staged"),
        });
        return { ok: true };
      case "git.clean":
        return clean({
          workspaceId: reqStr(params, "workspaceId"),
          paths: optStrArr(params, "paths"),
          directories: optBool(params, "directories"),
          confirm: optBool(params, "confirm") ?? false,
        });
      case "git.merge":
        return merge({
          workspaceId: reqStr(params, "workspaceId"),
          branch: reqStr(params, "branch"),
          noFF: optBool(params, "noFF"),
        });
      case "git.cherryPick":
        return cherryPick({
          workspaceId: reqStr(params, "workspaceId"),
          sha: reqStr(params, "sha"),
        });
      case "git.revert":
        return revert({
          workspaceId: reqStr(params, "workspaceId"),
          sha: reqStr(params, "sha"),
        });
      case "git.continue":
        return continueOperation(reqStr(params, "workspaceId"));
      case "git.abort":
        return abortOperation(reqStr(params, "workspaceId"));
      case "git.stashApply":
        return applyStash({
          workspaceId: reqStr(params, "workspaceId"),
          stashRef: reqStr(params, "stashRef"),
        });
      case "git.stashDrop":
        await dropStash({
          workspaceId: reqStr(params, "workspaceId"),
          stashRef: reqStr(params, "stashRef"),
        });
        return { ok: true };
      case "git.deleteBranch":
        await deleteBranch({
          workspaceId: reqStr(params, "workspaceId"),
          branchName: reqStr(params, "branchName"),
          force: optBool(params, "force"),
        });
        return { ok: true };
      case "git.stageHunk":
        await stageHunk({
          workspaceId: reqStr(params, "workspaceId"),
          patch: reqStr(params, "patch"),
        });
        return { ok: true };
      case "git.unstageHunk":
        await unstageHunk({
          workspaceId: reqStr(params, "workspaceId"),
          patch: reqStr(params, "patch"),
        });
        return { ok: true };
      case "git.discardHunk":
        await discardHunk({
          workspaceId: reqStr(params, "workspaceId"),
          patch: reqStr(params, "patch"),
        });
        return { ok: true };
      case "git.tagCreate":
        await createTag({
          workspaceId: reqStr(params, "workspaceId"),
          name: reqStr(params, "name"),
          ref: optStr(params, "ref"),
          message: optStr(params, "message"),
        });
        return { ok: true };
      case "git.tagDelete":
        await deleteTag({
          workspaceId: reqStr(params, "workspaceId"),
          name: reqStr(params, "name"),
        });
        return { ok: true };
      // Read: git — extended (raw result, matching the old IPC return shape)
      case "git.stashList":
        return listStashes(reqStr(params, "workspaceId"));
      case "git.tagList":
        return listTags(reqStr(params, "workspaceId"));
      case "git.listAllBranches":
        return listAllBranches({
          repoSlug: reqStr(params, "repoSlug"),
          repoRoot: reqStr(params, "repoRoot"),
        });
      // Workspace lifecycle
      case "workspace.setStatus": {
        const workspaceId = reqStr(params, "workspaceId");
        const status = reqStr(params, "status");
        const valid: readonly WorkspaceStatus[] = [
          "backlog",
          "in-progress",
          "in-review",
          "done",
          "cancelled",
        ];
        if (!valid.includes(status as WorkspaceStatus)) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `Invalid workspace status "${status}"`,
          });
        }
        setWorkspaceStatus(workspaceId, status as WorkspaceStatus);
        return { ok: true };
      }
      case "workspace.archive": {
        const workspaceId = reqStr(params, "workspaceId");
        return archiveWorkspace(
          {
            workspaceId,
            stashUncommitted: optBool(params, "stashUncommitted") ?? false,
          },
          async () => {
            // This callback runs INSIDE the engine lifecycle single-flight, so a
            // timeout probe sees archive active even while process shutdown is
            // still waiting. Reap only after exact Git ownership is proved: a
            // stale row must never kill work in a replacement folder.
            const target = getWorkspaceById(workspaceId);
            if (target && (await workspaceOwnsManagedCheckout(workspaceId))) {
              await this.workspaceProcessReaper?.(workspaceId, target.path);
            }
          },
          this.workspaceCheckoutWatchSuspender ?? undefined,
        );
      }
      // "Continue" after a merged PR — same worktree + chats, fresh generated
      // branch, PR fields cleared. Desktop-only (absent from every remote
      // allowlist, so a remote client is refused by deny-by-default).
      case "workspace.continueOnNewBranch":
        return continueOnNewBranch({
          workspaceId: reqStr(params, "workspaceId"),
          baseBranch: optStr(params, "baseBranch"),
          mergedSha: optStr(params, "mergedSha"),
        });
      case "workspace.restore": {
        const workspaceId = reqStr(params, "workspaceId");
        const result = await restoreWorkspace(workspaceId);
        // Re-run the repo setup script in the background so the worktree's
        // gitignored deps (node_modules, .venv, …) — which aren't captured in the
        // archive checkpoint — come back, so restore lands in the same state a
        // fresh create would.
        // LOCAL-ONLY (restore isn't remote-allowed; this guard is defence in
        // depth) and fire-and-forget: a setup miss must never fail the restore.
        if (!remote) {
          try {
            const ws = getWorkspaceById(workspaceId);
            if (ws) await this.triggerWorkspaceSetup(ws);
          } catch (err) {
            console.warn(
              `[restore] background setup failed to start for ${workspaceId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        return result;
      }
      case "workspace.delete": {
        const workspaceId = reqStr(params, "workspaceId");
        await deleteWorkspace(
          {
            workspaceId,
            includeBranch: optBool(params, "includeBranch") ?? false,
          },
          async () => {
            // Same single-flight + ownership rule as archive.
            const target = getWorkspaceById(workspaceId);
            if (target && (await workspaceOwnsManagedCheckout(workspaceId))) {
              await this.workspaceProcessReaper?.(workspaceId, target.path);
            }
          },
          this.workspaceCheckoutWatchSuspender ?? undefined,
        );
        return { ok: true };
      }
      case "workspace.createFromBranch": {
        const result = await createWorkspaceFromBranch({
          repoRoot: reqStr(params, "repoRoot"),
          repoSlug: optStr(params, "repoSlug"),
          branchName: reqStr(params, "branchName"),
          sourceTool: optStr(params, "sourceTool") as DetectedTool | undefined,
          prNumber: optNum(params, "prNumber"),
          prUrl: optStr(params, "prUrl"),
          // A remote (relay) client must not trigger a settings-driven file
          // copy from the host checkout — mirrors workspace.create's C1 gate,
          // which skips seeding for remote creates.
          seedFiles: !remote,
        });
        // Branch/PR workspaces need the same dependency recovery as ordinary
        // create and restore. Resolution is quick; the setup PTY itself is
        // background and local-only.
        if (!remote) {
          // A bounded create-time seed scan may still be completing. Do not let
          // setup read a half-copied .env/.npmrc, and do not hold the create RPC
          // open while that uncommon cold-disk pass finishes.
          void whenSeedingSettled(result.workspaceId)
            .then(async () => {
              const ws = getWorkspaceById(result.workspaceId);
              if (ws && ws.archivedAt == null) {
                await this.triggerWorkspaceSetup(ws);
              }
            })
            .catch((err) => {
              console.warn(
                `[create-from-branch] background setup failed to start for ${result.workspaceId}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
        return result;
      }
      case "workspace.adoptExisting":
        return adoptExistingWorktree({
          repoRoot: reqStr(params, "repoRoot"),
          worktreePath: reqStr(params, "worktreePath"),
          branchName: reqStr(params, "branchName"),
          repoSlug: optStr(params, "repoSlug"),
          sourceTool: optStr(params, "sourceTool") as DetectedTool | undefined,
        });
      case "workspace.proposeBranchName":
        return proposeBranchRename({
          workspaceId: reqStr(params, "workspaceId"),
          prompt: reqStr(params, "prompt"),
          force: optBool(params, "force") ?? false,
        });
      // GitHub: list PRs (DB-free, but routed here so ALL PR ops live on the
      // bridge; auth ops stay in Electron main). Accepts { originUrl } OR
      // { owner, repo }, mirroring the old IPC handler.
      case "gh.prList": {
        let owner: string;
        let repo: string;
        const originUrl = optStr(params, "originUrl");
        if (originUrl) {
          const parsed = parseGitHubRemote(originUrl);
          owner = parsed.owner;
          repo = parsed.repo;
        } else {
          owner = reqStr(params, "owner");
          repo = reqStr(params, "repo");
        }
        return listPrs({
          owner,
          repo,
          state: optStr(params, "state") as
            | "open"
            | "closed"
            | "all"
            | undefined,
        });
      }

      // ── Detach mode (Spotlight equivalent) ──
      // Mutates detach_state (zeros.db) + the root checkout, so it lives here on
      // the engine bridge with the other DB-touching ops. LOCAL-only (a host op;
      // absent from the remote allowlists). No renderer caller today — the UI was
      // never built — but it's wired so reviving detach needs only the UI.
      case "detach.start":
        return detachStart({ workspaceId: reqStr(params, "workspaceId") });
      case "detach.stop":
        return detachStop();
      case "detach.status":
        return detachStatus();

      // ── Turns (v13: footer / per-turn changes / reset) ──
      // A turn = one agent prompt() round-trip, recorded by the engine's turn
      // hooks (index.ts beginTurn/finishTurn). Reads power the footer pills, the
      // Changes-tab turn filter, and the per-turn diff; reset = transcript
      // truncation + per-path 3-way-merge restore (see git/turns-git.ts).
      case "turns.list":
        return {
          turns: listTurnsForWorkspace(
            reqStr(params, "workspaceId"),
            optNum(params, "limit") ?? 200,
          ),
        };
      case "turns.get":
        return {
          turn: getTurn(reqStr(params, "chatId"), reqStr(params, "turnId")),
        };
      case "turns.diff": {
        const turn = getTurn(
          reqStr(params, "chatId"),
          reqStr(params, "turnId"),
        );
        if (!turn || !turn.folder || !turn.preSnapshot || !turn.postSnapshot) {
          return { patch: "" };
        }
        const only = optStr(params, "path");
        const paths = only ? [only] : turn.files.map((f) => f.path);
        return {
          patch: await turnPatch(
            turn.folder,
            turn.preSnapshot,
            turn.postSnapshot,
            paths,
          ),
        };
      }
      case "turns.reset": {
        const chatId = reqStr(params, "chatId");
        const turnId = reqStr(params, "turnId");
        const mode = (optStr(params, "mode") ?? "filesAndTranscript") as
          | "filesAndTranscript"
          | "filesOnly"
          | "transcriptOnly";
        const turn = getTurn(chatId, turnId);
        if (!turn) {
          throw new GitError({
            code: "VALIDATION_FAILED",
            message: `unknown turn ${turnId}`,
          });
        }
        const folder = turn.folder ?? "";
        // Authored union across THIS chat's turns from this one onward (confirmed
        // reset scope: "this turn + all later turns of this chat").
        const chatTurns = listTurnsForChat(chatId);
        const span = chatTurns.filter((t) => t.ord >= turn.ord);
        const authored = [
          ...new Set(span.flatMap((t) => t.files.map((f) => f.path))),
        ];
        // Capture the rows the truncate is about to delete, BEFORE deleting, so
        // undo can restore the full CONVERSATION (user messages, every tool call
        // with its inputs/outputs, the final answer) + turn rows — not just the
        // files. Skipped for filesOnly (no truncation happens).
        const willTruncate = mode !== "filesOnly";
        const captured = willTruncate
          ? getChatMessagesFrom(chatId, turnId)
          : null;
        const capturedTurns = willTruncate
          ? getRawTurnsFrom(chatId, turnId)
          : [];

        let fileResult: Awaited<ReturnType<typeof applyTurnSpanReset>> = {
          applied: [],
          conflicts: [],
          skipped: [],
          preResetSnapshot: null,
          postResetSnapshot: null,
        };
        if (mode !== "transcriptOnly" && folder) {
          // Unwind only file-changing turns, newest-first inside the helper.
          // Each path uses the pre/post pair of the turn that authored it, so a
          // later conversational turn or another-file edit cannot become a
          // false merge base and clobber concurrent work.
          fileResult = await applyTurnSpanReset(
            folder,
            chatId,
            span
              .filter((item) => item.files.length > 0)
              .map((item) => ({
                paths: item.files.map((file) => file.path),
                preSnapshot: item.preSnapshot,
                postSnapshot: item.postSnapshot,
              })),
          );
        }
        let truncated = 0;
        if (willTruncate) {
          truncated = truncateChatMessagesFrom(chatId, turnId);
          const { turnIds } = deleteTurnsFrom(chatId, turnId);
          if (folder) await deleteSnapshotRefs(folder, chatId, turnIds);
        }
        // Stash everything undo needs under a fresh id, then cap per chat.
        const resetId = `reset-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        saveResetUndo({
          resetId,
          chatId,
          folder: folder || null,
          snapshot: fileResult.preResetSnapshot,
          postSnapshot: fileResult.postResetSnapshot,
          resetPaths: authored,
          cutOrd: captured?.cutOrd ?? null,
          messages: captured?.rows ?? [],
          turns: capturedTurns,
          createdAt: Date.now(),
        });
        pruneResetUndo(chatId, RESET_UNDO_KEEP);
        return {
          applied: fileResult.applied,
          conflicts: fileResult.conflicts,
          skipped: fileResult.skipped,
          preResetSnapshot: fileResult.preResetSnapshot,
          resetPaths: authored,
          truncated,
          resetId,
        };
      }
      case "turns.undoReset": {
        const resetId = reqStr(params, "resetId");
        const rec = getResetUndo(resetId);
        if (!rec) {
          return {
            restored: [],
            transcriptRestored: false,
            messagesRestored: 0,
          };
        }
        // 1) Files — restore the working tree from the pre-reset snapshot.
        // rec.postSnapshot (the tree the reset left) is the 3-way merge base:
        // edits made AFTER the reset are merged around, overlaps conflict and
        // stay put. Legacy records (null) keep the original blind restore.
        const restored =
          rec.snapshot && rec.folder
            ? await undoTurnReset(
                rec.folder,
                rec.snapshot,
                rec.resetPaths,
                rec.postSnapshot,
              )
            : [];
        // 2) Transcript — re-insert the stashed messages + turns ONLY when the
        // chat wasn't continued past the reset (the truncated ord range is still
        // free), so they land at their exact original positions. Otherwise the
        // files are undone but the conversation is left as-is (the caller warns).
        let transcriptRestored = false;
        let messagesRestored = 0;
        if (
          rec.cutOrd != null &&
          rec.messages.length > 0 &&
          maxChatMessageOrd(rec.chatId) < rec.cutOrd
        ) {
          reinsertChatMessages(rec.chatId, rec.messages);
          reinsertTurns(rec.turns);
          transcriptRestored = true;
          messagesRestored = rec.messages.length;
        }
        deleteResetUndo(resetId);
        // `chatId` lets the engine target the cross-device transcript re-window
        // nudge (params here carry only resetId); the renderer ignores it.
        return {
          restored,
          transcriptRestored,
          messagesRestored,
          chatId: rec.chatId,
        };
      }

      default:
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `unknown workspace op: ${op}`,
        });
    }
  }
}
