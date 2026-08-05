// Worktree lifecycle — create, list, get, archive, restore, delete.
//
// The contract is "engine-pure": every function takes plain JSON args
// and returns plain JSON. Callers reach these over the engine bridge
// (WorkspaceService { op, params }), which validates inputs and forwards.
// This makes the engine module trivial to unit-test against a tmpdir repo.

import { existsSync } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { GitError } from "./errors";
import {
  assertSafeGitRef,
  runGit as runGitCommand,
  type RunGitOptions,
} from "./git-exec";
import { isConflictEntry, parsePorcelainZ } from "./porcelain";
import {
  allocatedNameSuffix,
  branchDisplayName,
  DEFAULT_BRANCH_PREFIX,
  generateWorkspaceId,
  isValidBranchName,
  joinBranchPrefix,
  normalizeBranchPrefix,
  pickFreeColourName,
} from "./naming";
import { cachedGithubLogin } from "./github";
import { isRepo, readOriginUrl, repoSlugFromOriginUrl } from "./repo";
import {
  beginWorkspaceLifecycle,
  clearWorkspaceLifecycle,
  deleteWorkspaceRow,
  finishWorkspaceLifecycle,
  getWorkspaceById,
  getWorkspaceByBranch,
  listWorkspaceBranches,
  getWorkspaceByPath,
  getWorkspaceLifecycle,
  getWorkspaceMeta,
  setWorkspaceMeta,
  insertWorkspaceWithLifecycle,
  listWorkspaceLifecycles,
  writeWorktreeSeed,
  removeWorktreeSeed,
  sealWorkspaceArchiveCheckpoint,
  listWorkspaces as listWorkspacesFromDb,
  type WorkspaceLifecycleJournal,
  type WorkspaceLifecycleOperation,
  type WorkspaceLifecyclePhase,
  updateWorkspaceLifecycleDetails,
  updateWorkspaceLifecyclePhase,
  updateWorkspace,
  designWorktreesRoot,
  worktreesRoot,
  legacyWorktreesRoot,
  isManagedWorktreePath,
  WORKSPACE_OWNERSHIP_META_KEY,
} from "./state";
import {
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
} from "../design/document";
import {
  lockDesignWorkspaceRoot,
  unlockDesignWorkspaceRoot,
} from "../design/workspace-lock";
import { setWorkingDirectories } from "./sparse-checkout";
import {
  runSetupHooks,
  runInlineScript,
  resolveSetupCommand,
  copyFromRepo,
  pathExists,
} from "./setup-hooks";
import { resolveFilesToCopy, resolvePatternSource } from "./files-to-copy";
import {
  CONTEXT_GRAPH_DIR,
  contextGraphHasContent,
  ensureContextGraph,
} from "../files/context-graph";
import { resolveRepoScript } from "../settings/repo-scripts";
import { resolveRepoGit } from "../settings/repo-git";
import { isKnownRepoRoot, listKnownRepoRoots } from "../db/projects";
import { deleteChat, getChat, rebindChatsFolder } from "../db/chats";
import {
  detectRemoteDefaultBranch,
  fetchRemote,
  refExists,
  repoHasRemote,
} from "./default-branch";
import { withStashLock } from "./stash-lock";
import {
  prepareWorktreeDirectoryEviction,
  type PreparedDirectoryEviction,
} from "./cleanup";
import {
  archiveSnapshotRef,
  applyArchiveSnapshotOntoCurrent,
  snapshotWorkingTree,
  restoreWorktreeFromSnapshot,
  deleteArchiveSnapshotRef,
  listArchiveSnapshotWorkspaceIds,
} from "./turns-git";
import { listTurnsForWorkspace } from "../db/turns";
import type {
  ArchiveOptions,
  ArchiveResult,
  CreatedWorkspace,
  CreateWorkspaceOptions,
  DeleteOptions,
  RestoreResult,
  Workspace,
  WorkspaceKind,
  WorkspaceStatus,
} from "./types";

const PROVISION_PATHS_META_KEY = "create.provision-paths.v1";
const WORKTREE_REMOVE_TIMEOUT_MS = 30_000;
const LEGACY_ATTACHMENT_ARCHIVE_PATHS = [
  ".context/.gitignore",
  ".context/attachments",
] as const;

/** A repo with no commits (unborn HEAD — e.g. freshly `git init`'d) can't host
 *  a worktree: there's no base commit to fork from, and resolveWorktreeBase
 *  would otherwise die with a cryptic `rev-parse --abbrev-ref HEAD failed`.
 *  Shared by prepare + create so the two phases can't drift on the wording the
 *  renderer surfaces. The Changes tab's "Initialize Git" makes the initial
 *  commit (initRepoInPlace), after which create works. */
const NO_COMMITS_MESSAGE =
  "this repository has no commits yet — open the Changes tab and click Initialize Git (it makes an initial commit), then create a workspace.";

function isAdoptedWorkspace(workspaceId: string): boolean {
  return (
    getWorkspaceMeta(workspaceId, WORKSPACE_OWNERSHIP_META_KEY) === "adopted"
  );
}

/** Record paths that were actually PROVISIONED into a workspace (explicit
 *  copy/symlink paths at create, plus every files-to-copy seed that landed),
 *  merged into the durable per-workspace list archive force-adds.
 *
 *  Archive can't re-derive this from today's patterns: `.worktreeinclude` is
 *  committed and editable, so a pattern removed a week after the workspace was
 *  created leaves a real, agent-edited file that no current pattern matches —
 *  `git add -A` skips it (it's gitignored), it never enters the checkpoint,
 *  and `git worktree remove` destroys it. What we seeded is a fact about this
 *  workspace, so it is stored as one. */
function addProvisionPaths(workspaceId: string, rels: string[]): void {
  if (rels.length === 0) return;
  try {
    const merged = [...new Set([...readProvisionPaths(workspaceId), ...rels])];
    setWorkspaceMeta(
      workspaceId,
      PROVISION_PATHS_META_KEY,
      JSON.stringify(merged),
    );
  } catch (err) {
    // Optional metadata: failing to record it must never fail a create. The
    // pattern-based archive scan still covers the normal case.
    console.warn(
      `[worktree] could not record provisioned paths for ${workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readProvisionPaths(workspaceId: string): string[] {
  const raw = getWorkspaceMeta(workspaceId, PROVISION_PATHS_META_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    // Malformed optional metadata must never block archive. Configured
    // files-to-copy are still resolved below and cover the normal UI path.
    return [];
  }
}

type WorkspaceLifecycleFlight = {
  operation: WorkspaceLifecycleOperation;
  promise: Promise<unknown>;
};
const workspaceLifecycleFlights = new Map<string, WorkspaceLifecycleFlight>();

/** Engine-side single flight is the authority across every renderer/device.
 * Same-operation repeats share one result. Conflicts fail before racing Git,
 * except a user-requested remove may queue behind this exact workspace's
 * prepared create (the provisional UI makes that sequence intentional). */
function withWorkspaceLifecycleFlight<T>(
  workspaceId: string,
  operation: WorkspaceLifecycleFlight["operation"],
  run: () => Promise<T>,
): Promise<T> {
  const active = workspaceLifecycleFlights.get(workspaceId);
  if (active) {
    if (active.operation === operation) return active.promise as Promise<T>;
    // A prepared workspace is visible and actionable before its checkout
    // finishes. Archive/delete requested during that narrow window should mean
    // "finish constructing this exact owner, then remove it"—not a transient
    // validation error. Queue only behind CREATE and only for removal; every
    // other conflicting lifecycle pair remains fail-fast. Concurrent duplicate
    // removals converge on the single flight registered after create settles.
    if (
      active.operation === "create" &&
      (operation === "archive" || operation === "delete")
    ) {
      return active.promise.then(() =>
        withWorkspaceLifecycleFlight(workspaceId, operation, run),
      ) as Promise<T>;
    }
    return Promise.reject(
      new GitError({
        code: "VALIDATION_FAILED",
        message: `Workspace ${workspaceId} is already being ${active.operation}d`,
        remediation: "Wait for the current workspace operation to finish.",
      }),
    );
  }
  const promise = run().finally(() => {
    if (workspaceLifecycleFlights.get(workspaceId)?.promise === promise) {
      workspaceLifecycleFlights.delete(workspaceId);
    }
  });
  workspaceLifecycleFlights.set(workspaceId, { operation, promise });
  return promise;
}

/** Exact local observation for a renderer whose lifecycle RPC timed out.
 *
 * `active` covers work that has started but has not reached the durable journal
 * yet (notably a create still resolving/fetching its base). `operation` and
 * `phase` retain an interrupted journal after the promise stops, which lets the
 * renderer distinguish "still running", "needs recovery", and "rolled back"
 * without guessing from a wall-clock timeout. */
export interface WorkspaceLifecycleStatus {
  active: boolean;
  operation: WorkspaceLifecycleOperation | null;
  phase: WorkspaceLifecyclePhase | null;
  startedAt: number | null;
}

export function getWorkspaceLifecycleStatus(
  workspaceId: string,
): WorkspaceLifecycleStatus {
  const active = workspaceLifecycleFlights.get(workspaceId);
  const journal = getWorkspaceLifecycle(workspaceId);
  return {
    active: active != null,
    operation: active?.operation ?? journal?.operation ?? null,
    phase: journal?.phase ?? null,
    startedAt: journal?.startedAt ?? null,
  };
}

/** Run `git` with the given args at the given cwd. Captures stderr for
 *  diagnostic context if the command fails. We always pass args as an
 *  array (never a single concatenated string) so user-supplied values
 *  can never inject. */
async function runGit(
  cwd: string,
  args: string[],
  opts: RunGitOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  // The shared runner provides the empty-cwd guard, bounded output, structured
  // errors, and bounded retries for transient Git lock contention. Lifecycle
  // operations on different workspaces can legitimately overlap in one repo.
  return runGitCommand(cwd, args, opts);
}

/** Read the current HEAD branch name in a repo. Throws GitError if the
 *  repo is in a detached state — we never want to base a new workspace
 *  off a detached HEAD silently.
 *
 *  Uses `rev-parse --abbrev-ref HEAD` (not `symbolic-ref`): symbolic-ref
 *  EXITS NON-ZERO on a detached HEAD, which made `runGit` throw a generic
 *  GIT_COMMAND_FAILED and left the clear "HEAD is detached" message below
 *  as dead code. `rev-parse --abbrev-ref` returns the literal "HEAD"
 *  on detach and exits 0, so we can detect it and raise the right error. */
async function currentBranchName(repoRoot: string): Promise<string> {
  const { stdout } = await runGit(repoRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const name = stdout.trim();
  if (!name || name === "HEAD") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Repository HEAD is detached. Check out a branch in the root before creating a workspace.",
    });
  }
  return name;
}

/** Resolve the start point for a new worktree.
 *
 *  - An explicit caller `baseBranch` (the relay create path, or a future base
 *    picker) is used verbatim — no fetch, preserving that contract.
 *  - Otherwise, when the repo has a remote, fetch it (best-effort, non-fatal)
 *    and fork from `<remote>/<default>` so a new workspace always starts from
 *    the latest PUSHED tip — even if the local checkout is behind (safe because
 *    the trunk is read-only here, so local main == origin/main).
 *    An explicit `git.base_branch` setting overrides `origin/HEAD` detection.
 *  - With no remote / offline / a missing remote ref, fall back to the local
 *    default branch (the `git.base_branch` setting if it exists locally, else
 *    the current HEAD — preserving the pre-existing behavior, including the
 *    detached-HEAD error).
 *
 *  Returns `baseRef` (what `git worktree add` forks from, e.g. "origin/main")
 *  and `baseBranch` (the local-branch-shaped name persisted to the workspace row
 *  + exported as ZEROS_BASE_BRANCH — downstream diff/PR/topbar all expect a
 *  plain branch name, NEVER "origin/main"). */
async function resolveWorktreeBase(
  input: CreateWorkspaceInput,
): Promise<{ baseRef: string; baseBranch: string }> {
  // Explicit caller base wins (relay contract / future picker) — verbatim, no fetch.
  if (input.baseBranch) {
    return { baseRef: input.baseBranch, baseBranch: input.baseBranch };
  }

  const {
    remote,
    baseBranch: settingBase,
    baseBranchExplicit,
  } = resolveRepoGit(input.repoRoot);

  if (await repoHasRemote(input.repoRoot, remote)) {
    // Best-effort; non-fatal (offline ok). Wait-capped: after 4s we proceed
    // with the local refs (base freshness is best-effort by contract — an
    // offline create already falls back) while the fetch keeps running in the
    // background, landing in the ref store + freshness memo so the NEXT create
    // is both fresh and instant. Worst case the branch starts ≤ one fetch
    // stale, which a rebase fixes; a slow network no longer stalls create.
    await fetchRemote(input.repoRoot, remote, { maxWaitMs: 4_000 });
    // Explicit user/repo `git.base_branch` overrides origin/HEAD detection;
    // otherwise auto-detect the remote's default; otherwise the setting default.
    const def =
      (baseBranchExplicit ? settingBase : null) ??
      (await detectRemoteDefaultBranch(input.repoRoot, remote)) ??
      settingBase;
    if (
      def &&
      (await refExists(input.repoRoot, `refs/remotes/${remote}/${def}`))
    ) {
      return { baseRef: `${remote}/${def}`, baseBranch: def };
    }
    // Remote exists but its <def> ref isn't present locally (never fetched /
    // never pushed) — try the matching local branch before HEAD.
    if (def && (await refExists(input.repoRoot, `refs/heads/${def}`))) {
      return { baseRef: def, baseBranch: def };
    }
  }

  // No remote (or no usable remote ref): the local default branch, else HEAD.
  if (await refExists(input.repoRoot, `refs/heads/${settingBase}`)) {
    return { baseRef: settingBase, baseBranch: settingBase };
  }
  const head = await currentBranchName(input.repoRoot);
  return { baseRef: head, baseBranch: head };
}

// (writeSeed removed — the crash-recovery seed now lives in app-data, written
// via state.ts `writeWorktreeSeed`, so no `.zeros/` is created in the worktree.)

// ── Late seed pass (guaranteed background seeding) ─────────────────────────
//
// The create-time seed scan runs under a small sync budget so a pathological
// cold-disk walk can't stall the create RPC. When that budget is exceeded —
// or the match set overflows the sync copy cap — the seeding is NOT skipped:
// this pass finishes it in the background, guaranteed. User-configured
// seeding (.worktreeinclude / file_include_globs / the .env* default) is
// never compromised, only (rarely) a few seconds late. The engine gates the
// background setup script AND run-on-create actions on `whenSeedingSettled`,
// so anything that might read a seeded file (.env, .npmrc, …) still sees the
// complete set.

const lateSeedPasses = new Map<string, Promise<void>>();

/** Ceiling for the background rescan. Not unbounded: `whenSeedingSettled`
 *  gates the setup command and run-on-create actions, so a scan that never
 *  returns is a workspace that never starts, with nothing in the log. */
const LATE_SEED_SCAN_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolves when any pending late seed pass for the workspace has finished
 *  (immediately when none is pending — the normal case). Never rejects. */
export function whenSeedingSettled(workspaceId: string): Promise<void> {
  return lateSeedPasses.get(workspaceId) ?? Promise.resolve();
}

/** Seed gitignored config files (files-to-copy) into a worktree that was NOT
 *  created by createWorkspace — the from-branch / open-PR flow, which used to
 *  skip seeding entirely (a PR workspace started with no .env at all). Same
 *  contract as the create path: sync-bounded scan, best-effort per-file copy,
 *  guaranteed background completion when the scan is cut short or overflows.
 *  Never throws; never clobbers a file the branch checkout already contains
 *  (a committed file at a seed path wins over the main checkout's copy). */
export async function seedWorktreeFiles(args: {
  workspaceId: string;
  repoRoot: string;
  worktreePath: string;
}): Promise<void> {
  let ftc: Awaited<ReturnType<typeof resolveFilesToCopy>>;
  try {
    ftc = await resolveFilesToCopy(args.repoRoot);
  } catch (err) {
    // resolveFilesToCopy shouldn't throw, but seeding must never fail the flow.
    console.warn(
      `[worktree] files-to-copy resolve failed for ${args.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  for (const w of ftc.warnings) console.warn(`[worktree] ${w}`);
  const seeded: string[] = [];
  for (const rel of ftc.paths) {
    // pathExists, not existsSync: existsSync follows symlinks, so a DANGLING
    // one committed on the base branch reads as "nothing here" and the copy
    // then writes through it, outside the worktree.
    if (pathExists(path.join(args.worktreePath, rel))) continue;
    try {
      await copyFromRepo(args.repoRoot, args.worktreePath, rel);
      seeded.push(rel);
    } catch (err) {
      console.warn(
        `[worktree] files-to-copy: skipped "${rel}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  addProvisionPaths(args.workspaceId, seeded);
  if (seeded.length > 0) {
    console.log(
      `[worktree] seeded ${seeded.length} gitignored file(s) into ${args.workspaceId}`,
    );
  }
  if (!ftc.complete || ftc.deferredPaths.length > 0) {
    scheduleLateSeedPass({
      workspaceId: args.workspaceId,
      repoRoot: args.repoRoot,
      worktreePath: args.worktreePath,
      rescan: !ftc.complete,
      deferred: ftc.deferredPaths,
      explicit: new Set(),
    });
  }
}

interface LateSeedPassArgs {
  workspaceId: string;
  repoRoot: string;
  worktreePath: string;
  /** true → the create-time scan was cut short: re-enumerate unbounded.
   *  false → the scan was complete; only `deferred` still needs copying. */
  rescan: boolean;
  /** Known-but-deferred matches (sync copy cap overflow). */
  deferred: string[];
  /** Caller-explicit copyPaths — already provisioned synchronously (fatal on
   *  failure), so the late pass must not re-touch them. */
  explicit: Set<string>;
}

/** Start the guaranteed background completion of a cut-short/overflowed seed
 *  resolve. Exported for direct unit testing; production callers reach it only
 *  through createWorkspace. Per-file best-effort with three safety rules:
 *  bail if the worktree vanished (workspace deleted meanwhile), never clobber
 *  a path that already exists in the worktree (the sync pass seeded it, or the
 *  user/agent created it since), and log the outcome so a late pass is always
 *  visible in the log store. */
export function scheduleLateSeedPass(args: LateSeedPassArgs): void {
  const task = (async () => {
    try {
      let rels: string[];
      if (args.rescan) {
        // Not `timeoutMs: 0`. A truly unbounded `git ls-files` on a wedged
        // network mount never returns, and `whenSeedingSettled` gates the
        // setup command and every run-on-create action — so the workspace
        // would sit silently doing nothing, forever. A ceiling turns that into
        // a logged failure. Generous enough that no real scan reaches it.
        const ftc = await resolveFilesToCopy(args.repoRoot, {
          timeoutMs: LATE_SEED_SCAN_TIMEOUT_MS,
          noSecondChance: true,
        });
        for (const w of ftc.warnings)
          console.warn(`[worktree] late seed pass: ${w}`);
        // A rescan that ALSO came back short would otherwise log
        // "copied 0 file(s)" — indistinguishable from a healthy no-op, for the
        // one case where seeding genuinely did not happen.
        if (!ftc.complete) {
          console.error(
            `[worktree] late seed pass for ${args.workspaceId}: rescan did not complete — configured files may be missing from the workspace. Check the warnings above.`,
          );
        }
        rels = [...ftc.paths, ...ftc.deferredPaths];
      } else {
        rels = args.deferred;
      }
      rels = rels.filter((p) => !args.explicit.has(p));
      const seeded: string[] = [];
      let skipped = 0;
      for (const rel of rels) {
        // Workspace deleted while we worked — nothing left to seed.
        if (!existsSync(args.worktreePath)) return;
        if (pathExists(path.join(args.worktreePath, rel))) {
          skipped++;
          continue;
        }
        try {
          await copyFromRepo(args.repoRoot, args.worktreePath, rel);
          seeded.push(rel);
        } catch (err) {
          console.warn(
            `[worktree] late seed pass: skipped "${rel}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      addProvisionPaths(args.workspaceId, seeded);
      console.log(
        `[worktree] late seed pass for ${args.workspaceId}: copied ${seeded.length} file(s)` +
          (skipped ? ` (${skipped} already present)` : ""),
      );
    } catch (err) {
      console.warn(
        `[worktree] late seed pass FAILED for ${args.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })().finally(() => {
    if (lateSeedPasses.get(args.workspaceId) === task) {
      lateSeedPasses.delete(args.workspaceId);
    }
  });
  lateSeedPasses.set(args.workspaceId, task);
}

export interface CreateWorkspaceInput extends CreateWorkspaceOptions {
  /** Absolute path to the repo root (the "main" working tree). Required
   *  — the engine doesn't guess the repo location for the caller. */
  repoRoot: string;
  /** Run the repo's resolved `scripts.setup` after the worktree is created.
   *  Defaults to true (local desktop). The REMOTE create path sets this false:
   *  a relay client must not be able to trigger host shell execution from the
   *  repository's committed or working-tree TOML, like the setupScript drop. */
  runRepoScripts?: boolean;
  /** A workspace id previously reserved by prepareWorkspaceCreate. The id is
   *  the ONLY identity the caller passes back — the path is always re-derived
   *  from trusted repo/branch metadata here, so a tampered path can't escape.
   *  Prepare is metadata-only; `git worktree add` creates the directory. */
  preparedId?: string;
  /** The branch name reserved alongside `preparedId` — the renderer shows it
   *  as the workspace's display name from the first frame, so the create must
   *  reuse it verbatim (shape-validated against the generator's format). */
  preparedBranch?: string;
  /** Renderer-created optimistic chat bound to the prepared path. If create is
   * rolled back, recovery removes this exact empty-shell identity so a crash
   * cannot resurrect a chat pointing at a folder that never became usable. */
  optimisticChatId?: string;
}

/** The shape a prepared/generated workspace id must match — the exact output
 *  of generateWorkspaceId. Anything else is rejected before it can reach a
 *  path join. */
const WORKSPACE_ID_RE = /^ws_[a-z0-9]{6}-[a-z0-9-]+$/;
/** The allocator's exact NAME output — a colour ("Cream") plus the exhaustion
 *  fallback suffix ("Cream-v2"). Anchored at the END of the branch so the
 *  prefix can be peeled off whatever it is. Was
 *  `/^zeros\/[a-z]+-[0-9a-f]{4}$/` before the 2026-07-29 colour scheme, and
 *  `/^zeros\/…/` before Settings → Git made the prefix a choice. */
const PREPARED_NAME_RE = /[A-Z][a-z]{2,15}(?:-v[1-9][0-9]{0,2})?$/;

/** Is this a branch prepareWorkspaceCreate could have produced?
 *
 *  `preparedBranch` arrives from the renderer, so it is untrusted input that
 *  ends up as a `git update-ref` argument — this is the shape gate in front of
 *  it (assertSafeGitRef is the second). Structural rather than one regex,
 *  because the prefix is now open-ended: peel the allocator's fixed name off
 *  the tail, then hold the namespace that remains to the SAME validator that
 *  accepted it as a setting.
 *
 *  Byte-identity against normalizeBranchPrefix, not merely "normalizes to
 *  something legal": that is what rejects ` jordan/Cream` and `jordan//Cream`,
 *  whose namespaces would otherwise be repaired into a legal one and let a
 *  string the allocator could never have produced through the gate.
 *
 *  Rejects e.g. `--upload-pack=x/Cream` (namespace fails the grammar) and
 *  `zeros/../../etc` (no allocator name at the tail). */
function isPreparedBranch(branch: string): boolean {
  const match = PREPARED_NAME_RE.exec(branch);
  if (!match) return false;
  // The name half must ALSO clear isValidBranchName, which folds case against
  // RESERVED_BRANCHES. PREPARED_NAME_RE on its own matches "Main" / "Master" /
  // "Release", and now that the prefix is optional a bare "Main" would be
  // accepted — creating `refs/heads/Main`, which is the same loose ref as
  // `main` on a case-insensitive filesystem. The old `/^zeros\/…/` pattern
  // excluded those only as a side effect of demanding the namespace.
  if (!isValidBranchName(match[0])) return false;
  const head = branch.slice(0, branch.length - match[0].length);
  if (head === "") return true; // branch_prefix_type = "none"
  // The allocator joins with exactly one "/" (joinBranchPrefix), so a prefixed
  // branch it produced ALWAYS has the separator here. Demanding it is what
  // keeps the gate at "could prepareWorkspaceCreate have emitted this": a head
  // that merely satisfies the prefix grammar without a separator describes
  // `mainCream` / `zeros.Cream` / `a.b-Cream`, none of which the allocator can
  // produce. (There is no legacy shape to admit — the separator-less
  // `myname-Cream` needed a configurable prefix, which has never shipped.)
  if (!head.endsWith("/")) return false;
  const namespace = head.slice(0, -1);
  return normalizeBranchPrefix(namespace) === namespace;
}

/** Filesystem-safe, human-readable directory component. Git branch names may
 * contain slashes and repository folders may contain spaces; neither should
 * create accidental nested owners under the managed workspaces root. */
function workspaceDirectorySegment(value: string, fallback: string): string {
  const segment = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 96);
  return segment && segment !== "." && segment !== ".." ? segment : fallback;
}

/** The visible, user-navigable layout:
 *   <workspaces root>/<repository folder>/<human workspace name>
 *
 * Repository basenames are preferred (`.../Documents/widgets` → `widgets`).
 * If two registered repositories share that basename, the globally unique
 * repoSlug is used for the colliding owner. Existing workspace paths are never
 * moved; this governs new creates only. */
function managedRepositoryDirectory(
  repoRoot: string,
  repoSlug: string,
  kind: WorkspaceKind = "code",
): string {
  const preferred = workspaceDirectorySegment(
    path.basename(repoRoot),
    repoSlug,
  );
  const normalizedRoot = path.resolve(repoRoot);
  const managedRoot = path.resolve(
    kind === "design" ? designWorktreesRoot() : worktreesRoot(),
  );
  // Once an owner has any managed workspace, its repository directory is
  // durable identity. A second same-basename repository registered later must
  // not make future workspaces jump from `<basename>/…` to `<repoSlug>/…`.
  for (const workspace of listWorkspacesFromDb({ repoSlug })) {
    if (path.resolve(workspace.repoRoot) !== normalizedRoot) continue;
    // An adopted checkout is external placement, not a naming decision for
    // future Zeros-owned folders.
    if (isAdoptedWorkspace(workspace.id)) continue;
    const relative = path.relative(managedRoot, path.resolve(workspace.path));
    const parts = relative.split(path.sep);
    if (
      parts.length >= 2 &&
      parts[0] &&
      // Pre-human-layout builds stored
      // `<root>/<repoSlug>/<workspaceId>`. Do not perpetuate that legacy slug
      // merely because one such row survives; the next create should use the
      // repository basename users recognize.
      !WORKSPACE_ID_RE.test(parts[1] ?? "") &&
      parts[0] !== ".." &&
      !path.isAbsolute(relative)
    ) {
      return parts[0];
    }
  }
  const preferredKey = preferred.toLocaleLowerCase();
  const ownerRoots = new Set([
    ...listKnownRepoRoots(),
    ...listWorkspacesFromDb().map((workspace) => workspace.repoRoot),
  ]);
  const collides = [...ownerRoots].some(
    (knownRoot) =>
      path.resolve(knownRoot).toLocaleLowerCase() !==
        normalizedRoot.toLocaleLowerCase() &&
      workspaceDirectorySegment(
        path.basename(knownRoot),
        repoSlug,
      ).toLocaleLowerCase() === preferredKey,
  );
  return collides
    ? workspaceDirectorySegment(repoSlug, "repository")
    : preferred;
}

/** Deterministic target path shared by prepare/create/from-branch. The branch
 * is the name users already see in the UI; strip Zeros' internal namespace so
 * `zeros/lupine-1a2b` becomes the readable folder `lupine-1a2b`. */
export function managedWorkspacePath(
  repoRoot: string,
  repoSlug: string,
  branch: string,
  kind: WorkspaceKind = "code",
): string {
  const displayBranch = branchDisplayName(branch);
  const repoDirectory = managedRepositoryDirectory(repoRoot, repoSlug, kind);
  const workspaceDirectory = workspaceDirectorySegment(
    displayBranch,
    "workspace",
  );
  const managedRoot =
    kind === "design" ? designWorktreesRoot() : worktreesRoot();
  const target = path.join(managedRoot, repoDirectory, workspaceDirectory);
  const root = path.resolve(managedRoot);
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Workspace path escapes the managed root: ${target}`,
    });
  }
  return target;
}

/** Names handed out by prepareWorkspaceCreate that have no DB row yet.
 *
 *  prepare and create are SEPARATE engine operations: the renderer prepares
 *  (to show the name and navigate), then creates. prepare is metadata-only by
 *  design — it writes no row — so between the two, nothing in the DB, git, or
 *  the filesystem records that the name is spoken for. Two "New Workspace"
 *  clicks in quick succession therefore both allocated the same name under the
 *  old code, and the second create died on the pre-insert revalidation with
 *  "create again for a fresh name". The random hex tail hid this; colour names
 *  do not.
 *
 *  The engine is the single writer for zeros.db (see migrations.ts), so an
 *  in-process map is sufficient — there is no second process to coordinate
 *  with. Entries expire: an abandoned prepare (user closes the dialog, create
 *  never arrives) must not hold a name out of the pool forever. The TTL is far
 *  longer than any real prepare→create gap, so it only ever collects garbage.
 *
 *  Keyed `<repoSlug>\u0000<lowercased display name>` — reservations are
 *  per-repo, exactly like the DB constraint. NUL is an unambiguous separator:
 *  it cannot occur in a repo slug (validated /^[a-z0-9][a-z0-9-]*$/) or in a
 *  branch name, so no pair of inputs can produce the same key.
 *
 *  Written as the ESCAPE `\u0000`, not a literal NUL byte. It was a literal
 *  until 2026-07-29, which made this whole 3.5k-line file read as binary:
 *  `file` reported "data", `grep` silently matched nothing without `-a`, and
 *  git diffed it as a blob. Same character, same behaviour, greppable source. */
const preparedNameReservations = new Map<string, number>();
const PREPARED_NAME_TTL_MS = 10 * 60_000;

function reservationKey(repoSlug: string, name: string): string {
  return `${repoSlug}\u0000${name.toLowerCase()}`;
}

/** Atomically claim a prepared name after the allocator's async snapshot.
 * Concurrent prepares may all select the same candidate before any of them
 * reaches this synchronous compare-and-set; exactly one wins and the others
 * retry against the now-visible reservation. */
function tryReservePreparedName(repoSlug: string, branch: string): boolean {
  const key = reservationKey(repoSlug, branchDisplayName(branch));
  const now = Date.now();
  const currentExpiry = preparedNameReservations.get(key);
  if (currentExpiry != null && currentExpiry > now) return false;
  preparedNameReservations.set(key, now + PREPARED_NAME_TTL_MS);
  return true;
}

/** Called once a DB row owns the name — the row is now the reservation. */
function releasePreparedName(repoSlug: string, branch: string): void {
  preparedNameReservations.delete(
    reservationKey(repoSlug, branchDisplayName(branch)),
  );
}

function activePreparedNames(repoSlug: string): string[] {
  const now = Date.now();
  const prefix = `${repoSlug}\u0000`;
  const out: string[] = [];
  for (const [key, expiresAt] of preparedNameReservations) {
    if (expiresAt <= now) {
      preparedNameReservations.delete(key);
      continue;
    }
    if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
  }
  return out;
}

/** Every workspace name already claimed in this repo, from all three
 *  authorities that can hold one. A name is unavailable if ANY of them has it:
 *
 *    - a DB row (archived included — an archived "Cream" keeps its name);
 *    - a git ref under `zeros/` (a row can be deleted while its branch lives);
 *    - a directory in the repo's workspace folder (renameBranch moves the ref
 *      and the row but NOT the folder, so a stale "Cream" folder can outlive
 *      both — populating it would silently adopt someone else's files).
 *
 *  Gathered in bulk — one query, one git call, one readdir — because the
 *  allocator tests all 350 names at once. Doing it per-candidate would mean up
 *  to 350 `git rev-parse` spawns per workspace create.
 *
 *  Returned lowercased: callers compare case-insensitively (macOS filesystems
 *  fold case, and git loose refs are files). */
async function collectUsedWorkspaceNames(
  repoRoot: string,
  repoSlug: string,
): Promise<{
  /** Display names already claimed, lowercased. */
  used: Set<string>;
  /** Every local branch this repo has, lowercased and whole (not just the
   *  display name). Only the prefix D/F check needs these — see
   *  branchPrefixIsBlocked — but they fall out of the same `for-each-ref`, so
   *  returning them costs nothing. Empty if the git call failed. */
  branches: Set<string>;
}> {
  const used = new Set<string>();
  const branches = new Set<string>();
  for (const branch of listWorkspaceBranches(repoSlug)) {
    used.add(branchDisplayName(branch).toLowerCase());
  }
  for (const name of activePreparedNames(repoSlug)) used.add(name);
  // Refs. A failure here (corrupt repo, git missing) must not block creation:
  // the DB and filesystem checks still apply, and `git worktree add -b` is the
  // final authority — it refuses to clobber an existing branch.
  try {
    // ALL local heads, not just `refs/heads/zeros/*`. Two reasons:
    //   • Settings → Git makes the prefix a choice, so this repo may hold
    //     workspace branches under several prefixes (`zeros/Cream` created
    //     last month, `jordan/Cream` today) — globbing one prefix would
    //     miss the others and hand out a name whose FOLDER already exists.
    //   • The checkout folder is named after the display name alone, so any
    //     branch ending in `/Cream` — ours or the user's — contends for the
    //     same directory. Treating the whole ref space as the authority costs
    //     at most a few skipped names out of 350.
    const { stdout } = await runGitCommand(repoRoot, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/",
    ]);
    const refPrefix = "refs/heads/";
    for (const line of stdout.split("\n")) {
      const ref = line.trim();
      if (!ref.startsWith(refPrefix)) continue;
      const branch = ref.slice(refPrefix.length);
      branches.add(branch.toLowerCase());
      const name = branchDisplayName(branch);
      if (name) used.add(name.toLowerCase());
      // Reserve an allocator name found ANYWHERE in the ref path, not just at
      // the tail branchDisplayName looks at. Two conflicts need this, and both
      // end in git's opaque "cannot lock ref" at create time:
      //   • `refs/heads/jordan/Cream/wip` makes `refs/heads/jordan/Cream` a
      //     DIRECTORY, so handing out `Cream` again under prefix `jordan`
      //     cannot create the ref;
      //   • with no prefix configured the branch IS the bare name, so an
      //     unrelated `refs/heads/Bone/wip` blocks `Bone` the same way.
      // branchDisplayName can't see either — a `wip` tail isn't allocator-
      // shaped, so it returns the whole ref and reserves nothing useful.
      // Over-reserving is the safe direction: it costs one colour out of 350.
      for (const part of branch.split("/")) {
        const allocated = allocatedNameSuffix(part);
        if (allocated) used.add(allocated.toLowerCase());
      }
    }
  } catch {
    /* best effort; worktree add remains authoritative */
  }
  // Directory entries under this repo's workspace container.
  try {
    const container = path.join(
      worktreesRoot(),
      managedRepositoryDirectory(repoRoot, repoSlug),
    );
    for (const entry of await readdir(container)) {
      used.add(entry.toLowerCase());
    }
  } catch {
    /* container doesn't exist yet — nothing claimed on disk */
  }
  return { used, branches };
}

/** The NAMESPACE a new workspace branch goes under, per Settings → Git — a
 *  bare segment with no separator, or null for "no prefix" (`none`). The
 *  separator is added once, by joinBranchPrefix, so every type produces
 *  `<namespace>/<Name>` and none of them can emit a doubled or missing slash.
 *
 *  Every failure path falls back to `zeros` rather than to null: that namespace
 *  is what marks a ref as workspace-owned, and silently creating unprefixed
 *  branches in a user's repo because a lookup failed would litter it with names
 *  indistinguishable from their own. A settings problem must never block or
 *  reshape workspace creation.
 *
 *  Unset means `github` (DEFAULT_BRANCH_PREFIX_TYPE), not `zeros` — so on a
 *  signed-in machine that has never touched Settings → Git, new branches read
 *  `jordan/Cream`. `zeros/` is then only the fallback for an unknown login. */
export async function resolveNewBranchPrefix(
  repoRoot: string,
  /** The connected GitHub login, for `branch_prefix_type = "github"`.
   *  Defaults to the process-cached login — deliberately NOT a live /user
   *  call: creating a workspace must not block on (or fail because of) the
   *  network. Overridable so tests can pin it. */
  githubLogin: string | null = cachedGithubLogin(),
): Promise<string | null> {
  /** The default type's namespace. Not signed in / login unusable as a ref →
   *  `zeros` rather than null, so a missing login degrades the NAME and never
   *  litters the repo with unprefixed branches. */
  const fromLogin = () =>
    normalizeBranchPrefix(githubLogin ?? undefined) ?? DEFAULT_BRANCH_PREFIX;

  let config;
  try {
    config = resolveRepoGit(repoRoot);
  } catch {
    // resolveRepoGit swallows its own failures, so this is belt-and-braces —
    // but it must still mean the DEFAULT type, not the historical `zeros`, or
    // an unreadable settings tree would quietly answer a different question
    // from an empty one.
    return fromLogin();
  }
  switch (config.branchPrefixType) {
    case "none":
      return null;
    case "custom":
      // Already normalized by resolveRepoGit; null when unset or unusable.
      return config.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
    case "zeros":
      // Only reachable from an explicit setting now (a hand-edited
      // settings.toml or a team/managed layer) — unset resolves to the default
      // type. Still honoured: it is what pre-2026-08-03 branches are under.
      return DEFAULT_BRANCH_PREFIX;
    case "github":
    default:
      return fromLogin();
  }
}

/** Would `<namespace>/<anything>` collide with an existing ref?
 *
 *  Git stores loose refs as files, so `refs/heads/main` being a FILE makes it
 *  impossible to also create the DIRECTORY `refs/heads/main/`. Configure the
 *  prefix as `main` (or connect a GitHub account whose login already exists as
 *  a branch) and every single workspace create would die with git's
 *  "cannot lock ref … 'refs/heads/main' exists" — an opaque failure from a
 *  setting made once, somewhere else, weeks earlier.
 *
 *  Cheap to rule out because the caller already listed every head for the
 *  used-name scan. Any namespace component counts: with prefix `a/b`, an
 *  existing `refs/heads/a` blocks it just as `refs/heads/a/b` does. */
function branchPrefixIsBlocked(
  prefix: string,
  existingBranches: ReadonlySet<string>,
): boolean {
  const parts = prefix.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    if (existingBranches.has(parts.slice(0, i).join("/").toLowerCase()))
      return true;
  }
  return false;
}

/** Allocate a free workspace branch (`zeros/Cream`, or whatever prefix
 *  Settings → Git configures) for this repo.
 *
 *  Snapshot-based, so it cannot by itself prevent two concurrent creates from
 *  picking the same name — the UNIQUE index on (repo_slug, lower(branch))
 *  does that, and callers retry. Calling this in the retry loop is what makes
 *  the retry converge: each attempt re-reads the used-set, so the loser of a
 *  race sees the winner's name and picks a different one.
 *
 *  Note the used-set is keyed on the NAME, not the full branch: "Cream" stays
 *  taken in this repo even if the prefix setting changed since it was created,
 *  so flipping the setting can never hand out a second workspace whose folder
 *  (which is named after the display name alone) would collide on disk. */
export async function allocateWorkspaceBranch(
  repoRoot: string,
  repoSlug: string,
  githubLogin: string | null = cachedGithubLogin(),
): Promise<string> {
  const { used, branches } = await collectUsedWorkspaceNames(
    repoRoot,
    repoSlug,
  );
  const name = pickFreeColourName(used);
  if (!name) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message:
        "Could not allocate a workspace name: every colour name is in use in this repository.",
      remediation:
        "Delete or archive-and-remove some workspaces in this repository, then retry.",
    });
  }
  const configured = await resolveNewBranchPrefix(repoRoot, githubLogin);
  // null is the `none` SETTING, not a failure — resolveNewBranchPrefix already
  // substitutes the default for everything it can't resolve, so a null here is
  // the user's answer and there is nothing to fall back from. (Folding this
  // into the candidate walk below silently turned `none` back into `zeros/`.)
  if (configured === null) return joinBranchPrefix(null, name);

  // A namespace that already exists as a branch cannot hold one (git's loose
  // refs are files). Rather than fail every create until the user finds the
  // setting, degrade: to the default, and if THAT is blocked too, to no prefix
  // at all, which needs no directory. Same principle as the fallbacks inside
  // resolveNewBranchPrefix — a settings problem degrades the name, never the
  // creation — and noisy, because the pane goes on previewing the namespace it
  // was told to use and has no way to know about this repo's refs.
  if (!branchPrefixIsBlocked(configured, branches))
    return joinBranchPrefix(configured, name);
  const fallback = branchPrefixIsBlocked(DEFAULT_BRANCH_PREFIX, branches)
    ? null
    : DEFAULT_BRANCH_PREFIX;
  console.warn(
    `[worktree] branch prefix "${configured}" is already a branch in this repo — ` +
      "a ref cannot be both a file and a directory, so new workspace branches " +
      `will use ${fallback ? `"${fallback}/"` : "no prefix"} instead.`,
  );
  return joinBranchPrefix(fallback, name);
}

export interface PreparedWorkspaceCreate {
  workspaceId: string;
  path: string;
  repoSlug: string;
  branch: string;
}

type WorkspaceBranchOwnershipOperation = "create" | "restore";

function workspaceBranchOwnershipRef(
  operation: WorkspaceBranchOwnershipOperation,
  workspaceId: string,
): string {
  return `refs/zeros/${operation}/${workspaceId}`;
}

/** Atomically create a user-visible branch and hidden ownership proof at the
 * same commit. Recovery can then distinguish a branch this lifecycle owns from
 * an identically-named ref another process won, even if the process stops
 * before the next SQLite phase write. */
async function createOwnedBranch(args: {
  repoRoot: string;
  workspaceId: string;
  branch: string;
  startPoint: string;
  operation: WorkspaceBranchOwnershipOperation;
}): Promise<void> {
  assertSafeGitRef(args.branch, "workspace branch");
  assertSafeGitRef(args.startPoint, "workspace branch start");
  await runGit(args.repoRoot, ["check-ref-format", "--branch", args.branch]);
  const { stdout } = await runGit(args.repoRoot, [
    "rev-parse",
    "--verify",
    `${args.startPoint}^{commit}`,
  ]);
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Couldn't resolve workspace branch start ${args.startPoint}`,
    });
  }
  const branchRef = `refs/heads/${args.branch}`;
  const ownershipRef = workspaceBranchOwnershipRef(
    args.operation,
    args.workspaceId,
  );
  // Keep the ordinary `git branch` creation record even though the branch and
  // ownership marker are created through one ref transaction. forkPoint()
  // relies on this durable record after the base absorbs the branch: at that
  // point base..HEAD is empty, but the oldest genuine creation reflog still
  // identifies the commit the workspace forked from.
  await runGit(
    args.repoRoot,
    [
      "update-ref",
      "--create-reflog",
      "-m",
      `branch: Created from ${args.startPoint}`,
      "--stdin",
    ],
    {
      input:
        `start\n` +
        `create ${branchRef} ${commit}\n` +
        `create ${ownershipRef} ${commit}\n` +
        `prepare\ncommit\n`,
    },
  );
}

export function createOwnedWorkspaceBranch(args: {
  repoRoot: string;
  workspaceId: string;
  branch: string;
  startPoint: string;
}): Promise<void> {
  return createOwnedBranch({ ...args, operation: "create" });
}

function createOwnedRestoreBranch(args: {
  repoRoot: string;
  workspaceId: string;
  branch: string;
  startPoint: string;
}): Promise<void> {
  return createOwnedBranch({ ...args, operation: "restore" });
}

/** Publication makes rollback ownership irrelevant. Marker cleanup is
 * best-effort and deliberately happens after the SQLite commit; a stale hidden
 * ref is harmless, while deleting it before a crash could weaken rollback. */
async function clearWorkspaceBranchOwnershipMarkerFor(
  repoRoot: string,
  workspaceId: string,
  operation: WorkspaceBranchOwnershipOperation,
): Promise<void> {
  await runGit(repoRoot, [
    "update-ref",
    "-d",
    workspaceBranchOwnershipRef(operation, workspaceId),
  ]).catch(() => {});
}

export function clearWorkspaceBranchOwnershipMarker(
  repoRoot: string,
  workspaceId: string,
): Promise<void> {
  return clearWorkspaceBranchOwnershipMarkerFor(
    repoRoot,
    workspaceId,
    "create",
  );
}

async function restoreBranchOwnershipState(
  repoRoot: string,
  workspaceId: string,
  branch: string,
): Promise<"absent" | "owned" | "branch-missing" | "mismatch"> {
  const marker = await revParseCommitOrNull(
    repoRoot,
    workspaceBranchOwnershipRef("restore", workspaceId),
  );
  if (!marker) return "absent";
  const branchCommit = await revParseCommitOrNull(
    repoRoot,
    `refs/heads/${branch}`,
  );
  if (!branchCommit) return "branch-missing";
  return branchCommit === marker ? "owned" : "mismatch";
}

/** Delete a create-owned branch only when its hidden marker still points at the
 * same commit. `absent` means no branch was atomically claimed by this create;
 * `mismatch` preserves a branch that has since gained unrelated/user work. */
async function deleteOwnedWorkspaceBranch(
  repoRoot: string,
  workspaceId: string,
  branch: string,
): Promise<"deleted" | "absent" | "mismatch"> {
  const ownershipRef = workspaceBranchOwnershipRef("create", workspaceId);
  const marker = await revParseCommitOrNull(repoRoot, ownershipRef);
  if (!marker) return "absent";
  const branchRef = `refs/heads/${branch}`;
  const branchCommit = await revParseCommitOrNull(repoRoot, branchRef);
  if (branchCommit && branchCommit !== marker) return "mismatch";
  const registrations = await listWorktreeRegistrations(repoRoot, {
    strict: true,
  });
  if ([...registrations.values()].some((value) => value === branch)) {
    return "mismatch";
  }
  const commands = [
    "start",
    ...(branchCommit ? [`delete ${branchRef} ${branchCommit}`] : []),
    `delete ${ownershipRef} ${marker}`,
    "prepare",
    "commit",
    "",
  ].join("\n");
  await runGit(repoRoot, ["update-ref", "--stdin"], { input: commands });
  await runGit(repoRoot, [
    "config",
    "--remove-section",
    `branch.${branch}`,
  ]).catch(() => {});
  return "deleted";
}

/** Reserve a workspace identity BEFORE the real create runs, so the renderer
 * can navigate to the final path the moment the user clicks. The directory is
 * intentionally NOT created here: if the client disconnects after prepare (or
 * its request times out), there is no empty orphan to leak forever. Folder-keyed
 * renderer surfaces are guarded by the settling state until create commits.
 * Cheap by contract: validation + naming only; no fetch or checkout. */
export async function prepareWorkspaceCreate(input: {
  repoRoot: string;
  repoSlug?: string;
  prompt?: string;
  kind?: WorkspaceKind;
}): Promise<PreparedWorkspaceCreate> {
  if (!(await isRepo(input.repoRoot))) {
    throw new GitError({
      code: "NOT_A_REPO",
      message: `prepareWorkspaceCreate: ${input.repoRoot} is not a git repository`,
    });
  }
  // Reject an unborn HEAD HERE rather than leaving it to createWorkspace. By the
  // time create runs, the renderer has already reserved the identity, navigated
  // to the announced path and spawned a provisional chat — so a late rejection
  // flashes a "Setting up workspace…" tab and rolls it back. Both unusable-repo
  // states now fail in the same phase, before any optimistic UI. A local ref
  // read costs nothing and respects prepare's no-fetch/no-checkout contract.
  if (!(await refExists(input.repoRoot, "HEAD"))) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: NO_COMMITS_MESSAGE,
    });
  }
  let repoSlug: string;
  if (input.repoSlug) {
    repoSlug = input.repoSlug;
  } else {
    const origin = await readOriginUrl(input.repoRoot);
    repoSlug = repoSlugFromOriginUrl(origin);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(repoSlug) || repoSlug.includes("..")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `prepareWorkspaceCreate: invalid repoSlug "${repoSlug}"`,
    });
  }
  const workspaceId = generateWorkspaceId(input.prompt);
  if (!WORKSPACE_ID_RE.test(workspaceId) || getWorkspaceById(workspaceId)) {
    // A 6-hex collision with an existing row is ~1-in-16M; just ask the
    // caller to retry rather than looping here.
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `prepareWorkspaceCreate: id collision for ${workspaceId}. Retry.`,
    });
  }
  // Reserve the branch name too — it IS the workspace's display name. Avoid a
  // stale filesystem occupant as well as a DB collision; a leaked folder from
  // an older build must never be silently overwritten.
  const kind: WorkspaceKind = input.kind === "design" ? "design" : "code";
  let branch = "";
  let workspacePath = "";
  for (let attempt = 0; attempt < 20; attempt++) {
    // Re-reads the used-set each attempt, so a name that lost a race to a
    // concurrent create is seen as taken on the next pass.
    const candidate = await allocateWorkspaceBranch(input.repoRoot, repoSlug);
    const candidatePath = managedWorkspacePath(
      input.repoRoot,
      repoSlug,
      candidate,
      kind,
    );
    if (
      !getWorkspaceByBranch(repoSlug, candidate) &&
      !(await refExists(input.repoRoot, `refs/heads/${candidate}`)) &&
      !existsSync(candidatePath)
    ) {
      // Everything above can overlap with another prepare. Claim only after
      // the final await, with no yield between this check and the map write.
      if (!tryReservePreparedName(repoSlug, candidate)) continue;
      branch = candidate;
      workspacePath = candidatePath;
      // Hold the name until create inserts a row for it, so a second prepare
      // arriving before that create picks something else.
      break;
    }
  }
  if (!branch || !workspacePath) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message:
        "prepareWorkspaceCreate: couldn't reserve a unique workspace name. Retry.",
    });
  }
  return { workspaceId, path: workspacePath, repoSlug, branch };
}

export function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<CreatedWorkspace> {
  // Prepared creates have a stable renderer-announced id. Register the flight
  // before the first async repo/fetch read so timeout recovery can prove that a
  // rowless create is still running, and duplicate submissions join the exact
  // same operation instead of racing on the announced branch/path.
  return input.preparedId
    ? withWorkspaceLifecycleFlight(input.preparedId, "create", () =>
        createWorkspaceInner(input),
      )
    : createWorkspaceInner(input);
}

async function createWorkspaceInner(
  input: CreateWorkspaceInput,
): Promise<CreatedWorkspace> {
  if (!(await isRepo(input.repoRoot))) {
    throw new GitError({
      code: "NOT_A_REPO",
      message: `createWorkspace: ${input.repoRoot} is not a git repository`,
    });
  }
  if (Boolean(input.preparedId) !== Boolean(input.preparedBranch)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "createWorkspace: preparedId and preparedBranch must be supplied together",
    });
  }
  // prepareWorkspaceCreate already rejects an unborn HEAD, so a prepared create
  // never reaches here. Re-checked because createWorkspace is also callable
  // WITHOUT a prepare (bare `{ repoRoot }` — tests, relay, adopt flows), and the
  // repo can lose its only commit between the two phases.
  if (!(await refExists(input.repoRoot, "HEAD"))) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: NO_COMMITS_MESSAGE,
    });
  }
  // Derive repoSlug. If caller passed one, trust it; otherwise derive
  // from origin URL. Mismatch would silently fragment worktrees on disk,
  // so we don't auto-correct.
  let repoSlug: string;
  if (input.repoSlug) {
    repoSlug = input.repoSlug;
  } else {
    const origin = await readOriginUrl(input.repoRoot);
    repoSlug = repoSlugFromOriginUrl(origin);
  }
  // repoSlug is joined into worktreesRoot(). A caller-supplied
  // "../../etc" (relay forwards it raw) would escape. Constrain to the same
  // shape repoSlugFromOriginUrl emits (lowercase alnum + hyphen) — rejecting
  // separators, dots and traversal — and assert containment below as a backstop.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(repoSlug) || repoSlug.includes("..")) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `createWorkspace: invalid repoSlug "${repoSlug}" (expected ^[a-z0-9][a-z0-9-]*$)`,
    });
  }
  const kind: WorkspaceKind = input.kind === "design" ? "design" : "code";
  // Phase timings, logged on success below. Create sits on a renderer RPC with
  // a finite budget; when it runs long in the field, this line in the log store
  // says WHICH phase ate the time (fetch/base, checkout, seed scan, file hooks)
  // instead of leaving a bare "Request timeout: WORKSPACE_REQUEST" to guess at.
  const tStart = Date.now();
  // Resolve where the new worktree forks from. `baseRef` is the start point
  // (e.g. "origin/main" when a remote exists); `baseBranch` is the plain branch
  // name we persist + export. See resolveWorktreeBase.
  const { baseRef, baseBranch } = await resolveWorktreeBase(input);
  const tBase = Date.now();
  // baseRef is a bare positional to `git worktree add`. A value starting
  // with "-" would be parsed as a flag (option injection); a NUL is rejected too.
  // ("origin/main" is fine — a slash is allowed.)
  assertSafeGitRef(baseRef, "baseRef");
  // A prepared branch (prepareWorkspaceCreate) is reused verbatim — the
  // renderer already shows it as the workspace name. Shape-validated: only
  // the generator's own format is accepted, never an arbitrary ref.
  let branch: string;
  if (input.preparedBranch) {
    if (!isPreparedBranch(input.preparedBranch)) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `createWorkspace: invalid prepared branch "${input.preparedBranch}"`,
      });
    }
    branch = input.preparedBranch;
  } else {
    branch = await allocateWorkspaceBranch(input.repoRoot, repoSlug);
  }
  // A prepared id (prepareWorkspaceCreate) is reused verbatim — the renderer
  // already navigated to its path. Validate the SHAPE and re-derive the path
  // from it; the caller never supplies a path. A fresh create generates here.
  let workspaceId: string;
  if (input.preparedId) {
    if (!WORKSPACE_ID_RE.test(input.preparedId)) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `createWorkspace: invalid prepared workspace id "${input.preparedId}"`,
      });
    }
    if (getWorkspaceById(input.preparedId)) {
      throw new GitError({
        code: "WORKSPACE_ALREADY_EXISTS",
        message: `createWorkspace: workspace ${input.preparedId} already exists`,
      });
    }
    workspaceId = input.preparedId;
  } else {
    workspaceId = generateWorkspaceId(input.prompt);
  }
  const workspacePath = managedWorkspacePath(
    input.repoRoot,
    repoSlug,
    branch,
    kind,
  );

  // Sanity: branch should be unique. The 4-char hex suffix means a
  // collision is ~1/65k per adj-noun pair — vanishingly rare, but
  // we'd rather catch it early than fail mid-`git worktree add`.
  if (getWorkspaceByBranch(repoSlug, branch)) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `Generated branch ${branch} collides with an existing workspace. Retry.`,
    });
  }
  if (await refExists(input.repoRoot, `refs/heads/${branch}`)) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `Branch ${branch} already exists. Create the workspace again for a fresh name.`,
    });
  }
  // Ensure only the repository container exists. `git worktree add` creates
  // the final component itself; prepare is metadata-only and never owns an
  // existing directory, even an empty one.
  await mkdir(path.dirname(workspacePath), { recursive: true });
  // A directory can appear after prepare. Never populate it and later remove
  // it as "our" worktree merely because it happens to be empty; its ownership
  // is unknown and the caller can safely prepare a fresh human name.
  if (existsSync(workspacePath)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `createWorkspace: target folder ${workspacePath} is already occupied`,
      remediation:
        "Keep that folder; create the workspace again for a fresh name.",
    });
  }

  // Resolve the background setup command before mutating Git. A settings/read
  // failure therefore cannot strand an unregistered linked worktree.
  const setupCommand =
    kind === "design" || input.runRepoScripts === false
      ? null
      : await resolveSetupCommand({
          repoRoot: input.repoRoot,
          setupScript: input.setupScript,
          inlineCommand:
            resolveRepoScript(input.repoRoot, "setup") || undefined,
          allowAutoSetup: input.allowAutoSetup,
        });

  // Setup resolution above can await settings/filesystem work. Revalidate every
  // durable identity immediately before the synchronous SQLite reservation so
  // another create/adopt cannot win that window and leave duplicate rows.
  if (getWorkspaceById(workspaceId)) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `Workspace ${workspaceId} was created concurrently. Create again for a fresh name.`,
    });
  }
  if (getWorkspaceByBranch(repoSlug, branch)) {
    throw new GitError({
      code: "WORKSPACE_ALREADY_EXISTS",
      message: `Branch ${branch} was registered concurrently. Create again for a fresh name.`,
    });
  }
  if (getWorkspaceByPath(workspacePath) || existsSync(workspacePath)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `createWorkspace: target folder ${workspacePath} became occupied`,
      remediation:
        "Keep that folder; create the workspace again for a fresh name.",
    });
  }

  const now = Date.now();
  const workspace: Workspace = {
    id: workspaceId,
    kind,
    repoSlug,
    repoRoot: input.repoRoot,
    branch,
    baseBranch,
    path: workspacePath,
    status: "in-progress",
    createdAt: now,
    archivedAt: null,
    stashRef: null,
    archivedHead: null,
    archiveSnapshot: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    // Design workspaces intentionally have no coding-agent owner. Ignore stale
    // or external callers that still submit the old optimistic-chat fields;
    // a future native design harness will own a separate identity contract.
    agentId: kind === "code" ? (input.agentId ?? null) : null,
    lastActiveAt: now,
    setupState: setupCommand ? "running" : null,
  };
  const createJournal: WorkspaceLifecycleJournal = {
    workspaceId,
    operation: "create",
    phase: "prepared",
    sourcePath: workspacePath,
    targetPath: workspacePath,
    sourceBranch: branch,
    targetBranch: branch,
    createFrom: baseRef,
    archiveSnapshot: null,
    archivedHead: null,
    adaptations: [],
    payload: {
      copyPaths: input.copyPaths ?? [],
      symlinkPaths: input.symlinkPaths ?? [],
      seedFiles: kind === "code" && input.runRepoScripts !== false,
      ...(kind === "code" && input.optimisticChatId
        ? { optimisticChatId: input.optimisticChatId }
        : {}),
    },
    includeBranch: true,
    startedAt: now,
  };
  const provisionPaths = [
    ...new Set([...(input.copyPaths ?? []), ...(input.symlinkPaths ?? [])]),
  ];
  insertWorkspaceWithLifecycle(
    workspace,
    createJournal,
    provisionPaths.length > 0
      ? { [PROVISION_PATHS_META_KEY]: JSON.stringify(provisionPaths) }
      : {},
  );
  // The row now owns the name; the in-memory hold is redundant. Released here
  // rather than in a finally: if this create fails later, rollback deletes the
  // row, and the TTL returns the name to the pool on its own.
  releasePreparedName(repoSlug, branch);

  // Create the branch as its own atomic Git step. This proves ownership before
  // rollback is ever allowed to delete it: `worktree add -b` can fail because
  // another process created the same branch, and blindly deleting after that
  // failure would destroy the other process's branch. `--no-track` keeps a
  // remote start point from becoming the workspace branch's upstream.
  let branchCreated = false;
  try {
    await createOwnedWorkspaceBranch({
      repoRoot: input.repoRoot,
      workspaceId,
      branch,
      startPoint: baseRef,
    });
    branchCreated = true;
    updateWorkspaceLifecyclePhase(workspaceId, "branch-created");
    await runGit(input.repoRoot, ["worktree", "add", workspacePath, branch]);
    updateWorkspaceLifecyclePhase(workspaceId, "worktree-created");
  } catch (err) {
    const rolledBack = await safeRollback(
      input.repoRoot,
      workspacePath,
      workspaceId,
      branch,
      branchCreated ? branch : undefined,
    );
    if (!rolledBack) {
      throw new GitError({
        code: "GIT_COMMAND_FAILED",
        message: `Couldn't safely roll back the incomplete workspace at ${workspacePath}`,
        cause: err,
        remediation:
          "The hidden recovery record was retained. Close processes using the folder and restart Zeros to finish cleanup.",
      });
    }
    throw err;
  }
  const tAdd = Date.now();

  // Files-to-copy: seed gitignored files (.env*, …) from the
  // main checkout into the new worktree. LOCAL creates only — a remote create
  // (runRepoScripts === false) skips it, since the patterns come from repo
  // settings / a committed .worktreeinclude and we don't let a paired device
  // trigger a settings-driven file copy (mirrors the setupCommand gate below).
  let seedPaths: string[] = [];
  let seedDeferred: string[] = [];
  let seedScanComplete = true;
  let tSeeds = tAdd;
  try {
    if (kind === "code" && input.runRepoScripts !== false) {
      const ftc = await resolveFilesToCopy(input.repoRoot);
      for (const w of ftc.warnings) console.warn(`[worktree] ${w}`);
      const explicit = new Set(input.copyPaths ?? []);
      seedPaths = ftc.paths.filter((p) => !explicit.has(p));
      seedDeferred = ftc.deferredPaths.filter((p) => !explicit.has(p));
      seedScanComplete = ftc.complete;
      // Same visibility as seedWorktreeFiles: the log store should always show
      // WHAT files-to-copy decided for a create, so "my .env wasn't copied"
      // reports are diagnosable from logs alone.
      console.log(
        `[worktree] files-to-copy (${ftc.source}) for ${workspaceId}: ` +
          (seedPaths.length > 0
            ? `seeding ${seedPaths.length} file(s)`
            : "nothing to seed"),
      );
    }
    tSeeds = Date.now();

    if (kind === "design") {
      // Design workspaces deliberately skip every repo ritual. Seed only the
      // portable design document, force-stage the whole app-owned directory,
      // then commit only when that produced a tree delta. The unconditional
      // add covers files a checkout hook created untracked (including ignored
      // files), where initialization correctly reports no writes but the
      // sparse cone still requires a tracked top-level directory.
      await initializeDesignDocument(workspacePath);
      await runGit(workspacePath, [
        "add",
        "-f",
        "-A",
        "--",
        DESIGN_DIRECTORY_NAME,
      ]);
      const stagedDesign = await runGit(workspacePath, [
        "diff",
        "--cached",
        "--name-only",
        "--",
        DESIGN_DIRECTORY_NAME,
      ]);
      if (stagedDesign.stdout.trim()) {
        await runGit(workspacePath, [
          "-c",
          "user.name=Zeros",
          "-c",
          "user.email=zeros@localhost",
          "commit",
          "--no-verify",
          "-m",
          "Initialize Zeros Design",
        ]);
      }
      await setWorkingDirectories(workspacePath, [DESIGN_DIRECTORY_NAME], {
        forceSparse: true,
      });
      await lockDesignWorkspaceRoot(workspacePath);
    } else {
      // Run post-create FILE provisioning ONLY (copy / symlink / seed). The
      // setup command runs in the background. Explicit provisioning remains
      // transactional: failure rolls back the hidden checkout.
      await runSetupHooks({
        workspaceId,
        worktreePath: workspacePath,
        repoRoot: input.repoRoot,
        baseBranch,
        copyPaths: input.copyPaths,
        seedPaths,
        symlinkPaths: input.symlinkPaths,
      });
      // Durably record what we seeded, so archive force-adds these even if the
      // patterns that chose them are edited away before the workspace is
      // archived. Cross-tool safe: a path the hooks skipped (already present from
      // the branch checkout, or a vanished source) is simply one more entry for
      // `git add -f`, which no-ops when the file isn't there.
      addProvisionPaths(workspaceId, seedPaths);
      // Code workspaces get a `.context-graph/` skeleton (Context tab canvas +
      // composer-attachment store). Design workspaces deliberately expose only
      // `Zeros Design/`, so they skip this repo-root scaffold with every other
      // code-workspace ritual above. Best-effort and quiet: the scaffold is
      // self-gitignoring, and a failure here must never roll back the worktree —
      // the attachment IPC and the Context tab both re-scaffold lazily.
      const graph = await ensureContextGraph(workspacePath);
      if (!graph.ok) {
        console.warn(
          `[worktree] context-graph scaffold skipped for ${workspaceId}: ${graph.error}`,
        );
      }
    }
    updateWorkspaceLifecyclePhase(workspaceId, "work-applied");
  } catch (err) {
    if (kind === "design" && existsSync(workspacePath)) {
      await unlockDesignWorkspaceRoot(workspacePath).catch(() => {});
    }
    const rolledBack = await safeRollback(
      input.repoRoot,
      workspacePath,
      workspaceId,
      branch,
      branch,
    );
    if (!rolledBack) {
      throw new GitError({
        code: "GIT_COMMAND_FAILED",
        message: `Couldn't safely roll back the incomplete workspace at ${workspacePath}`,
        cause: err,
        remediation:
          "The hidden recovery record was retained. Close processes using the folder and restart Zeros to finish cleanup.",
      });
    }
    throw err;
  }

  // Guaranteed seeding: if the scan was cut short (cold-disk timeout / git
  // error) or the match set overflowed the sync cap, finish it in the
  // background. Registered only AFTER the hooks above succeeded, so a rolled-
  // back workspace never gets a late pass. The setup script / run-on-create
  // actions gate on whenSeedingSettled(), so they still see the complete set.
  if (
    kind === "code" &&
    input.runRepoScripts !== false &&
    (!seedScanComplete || seedDeferred.length > 0)
  ) {
    console.log(
      `[worktree] seed scan for ${workspaceId} ${
        seedScanComplete
          ? `overflowed the sync cap (${seedDeferred.length} deferred)`
          : "was cut short"
      } — completing seeding in the background`,
    );
    scheduleLateSeedPass({
      workspaceId,
      repoRoot: input.repoRoot,
      worktreePath: workspacePath,
      rescan: !seedScanComplete,
      deferred: seedDeferred,
      explicit: new Set(input.copyPaths ?? []),
    });
  }

  // Publish the row only after checkout + required synchronous provisioning
  // completed. The row and create journal transition atomically in SQLite.
  writeWorktreeSeed(workspace);
  finishWorkspaceLifecycle(workspaceId, {});
  await clearWorkspaceBranchOwnershipMarker(input.repoRoot, workspaceId);

  const tEnd = Date.now();
  console.log(
    `[worktree] created ${workspaceId} in ${tEnd - tStart}ms ` +
      `(base=${tBase - tStart}ms, add=${tAdd - tBase}ms, ` +
      `seed-scan=${tSeeds - tAdd}ms, hooks=${tEnd - tSeeds}ms)`,
  );

  return {
    workspaceId,
    branch,
    path: workspacePath,
    status: "in-progress",
    setupCommand,
  };
}

export interface WorkspaceLifecycleRecoveryResult {
  recovered: number;
  failed: number;
}

/** Roll every durable lifecycle intent forward before any workspace list or
 * archive-ref retention janitor runs. Operations are deliberately idempotent:
 * filesystem/Git work may already have completed even when its phase write did
 * not. A failed recovery keeps its journal + snapshot for the next startup or
 * explicit retry; it is never "cleaned up" into data loss. */
export async function reconcileInterruptedWorkspaceLifecycles(): Promise<WorkspaceLifecycleRecoveryResult> {
  let entries: WorkspaceLifecycleJournal[];
  try {
    entries = listWorkspaceLifecycles();
  } catch {
    return { recovered: 0, failed: 0 };
  }
  let recovered = 0;
  let failed = 0;
  for (const entry of entries) {
    const row = getWorkspaceById(entry.workspaceId);
    if (!row) {
      clearWorkspaceLifecycle(entry.workspaceId);
      continue;
    }
    try {
      switch (entry.operation) {
        case "create": {
          const targetPath = entry.targetPath ?? entry.sourcePath;
          const targetBranch = entry.targetBranch ?? entry.sourceBranch;
          const validCheckout =
            existsSync(targetPath) &&
            (await managedCheckoutIdentityMatches({
              ...row,
              path: targetPath,
              branch: targetBranch,
            }));
          const branchOwned = entry.includeBranch ? targetBranch : undefined;
          if (!validCheckout || entry.phase !== "work-applied") {
            const rolledBack = await safeRollback(
              row.repoRoot,
              targetPath,
              row.id,
              targetBranch,
              branchOwned,
            );
            if (!rolledBack) {
              throw new GitError({
                code: "GIT_COMMAND_FAILED",
                message: `Create rollback is still pending for ${row.id}`,
                remediation:
                  "Close processes using the workspace folder, then restart Zeros to retry recovery.",
              });
            }
            break;
          }
          // Default files-to-copy is idempotent and never clobbers files already
          // present. Explicit copy/symlink hooks may not be, so recovery leaves
          // an already-created checkout untouched rather than replaying them.
          if (entry.payload.seedFiles === true) {
            await seedWorktreeFiles({
              workspaceId: row.id,
              repoRoot: row.repoRoot,
              worktreePath: targetPath,
            });
          }
          writeWorktreeSeed(row);
          finishWorkspaceLifecycle(row.id, {});
          await clearWorkspaceBranchOwnershipMarker(row.repoRoot, row.id);
          break;
        }
        case "archive":
          await archiveWorkspaceInner({
            workspaceId: row.id,
            stashUncommitted: true,
          });
          break;
        case "restore":
          await restoreWorkspaceInner(row.id);
          break;
        case "delete":
          await deleteWorkspaceInner({
            workspaceId: row.id,
            includeBranch: entry.includeBranch,
          });
          break;
      }
      recovered++;
    } catch (err) {
      failed++;
      console.error(
        `[worktree] lifecycle recovery failed for ${entry.operation} ${entry.workspaceId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return { recovered, failed };
}

/** Boot janitor: drop archive snapshot refs that no longer
 *  back a live archive. `refs/zeros/archive/<id>` should exist ONLY while a
 *  workspace row is in the `archived` state; any other ref — the workspace was
 *  hard-deleted out-of-band, or restored without its ref being dropped (a crash
 *  between the two) — is an orphan pinning a commit forever. We only visit repos
 *  the registry knows about, and only delete refs whose id is NOT a
 *  currently-archived row. Best-effort + idempotent. Returns the count dropped. */
export async function pruneOrphanArchiveSnapshots(): Promise<number> {
  let workspaces: Workspace[];
  try {
    workspaces = listWorkspacesFromDb();
  } catch {
    return 0;
  }
  // Ids that legitimately keep an archive ref: currently-archived workspaces
  // plus journaled archive/restore operations. The latter closes the exact crash
  // seam where a live row's folder was gone but its not-yet-committed snapshot
  // was incorrectly pruned as an orphan.
  const archivedIds = new Set(
    workspaces.filter((w) => w.archivedAt != null).map((w) => w.id),
  );
  try {
    for (const entry of listWorkspaceLifecycles()) {
      if (entry.operation === "archive" || entry.operation === "restore") {
        archivedIds.add(entry.workspaceId);
      }
    }
  } catch {
    // If journal visibility fails, fail closed: skip pruning altogether rather
    // than risk deleting a recovery ref.
    return 0;
  }
  // The archive refs live in each host repo's shared object store.
  const repoRoots = [
    ...new Set([
      ...workspaces.map((w) => w.repoRoot).filter(Boolean),
      // The last workspace row in a registered project can be deleted
      // out-of-band while its archive ref survives. The project registry is
      // then the only remaining route to that shared object store.
      ...listKnownRepoRoots(),
    ]),
  ];
  let dropped = 0;
  for (const repoRoot of repoRoots) {
    let ids: string[];
    try {
      ids = await listArchiveSnapshotWorkspaceIds(repoRoot);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (archivedIds.has(id)) continue;
      await deleteArchiveSnapshotRef(repoRoot, id);
      dropped++;
    }
  }
  if (dropped > 0) {
    console.log(`[zeros] pruned ${dropped} orphan archive snapshot ref(s)`);
  }
  return dropped;
}

/** Drop stale branch-ownership proofs left by a crash after the workspace row
 * was published but before best-effort marker cleanup. A marker is retained
 * only while the matching lifecycle journal still exists; without that intent
 * it has no rollback authority and merely pins a commit. */
export async function pruneOrphanWorkspaceBranchOwnershipRefs(): Promise<number> {
  let workspaces: Workspace[];
  let lifecycles: WorkspaceLifecycleJournal[];
  try {
    workspaces = listWorkspacesFromDb();
    lifecycles = listWorkspaceLifecycles();
  } catch {
    return 0;
  }
  const retained: Record<WorkspaceBranchOwnershipOperation, Set<string>> = {
    create: new Set(
      lifecycles
        .filter((entry) => entry.operation === "create")
        .map((entry) => entry.workspaceId),
    ),
    restore: new Set(
      lifecycles
        .filter((entry) => entry.operation === "restore")
        .map((entry) => entry.workspaceId),
    ),
  };
  const repoRoots = [
    ...new Set([
      ...workspaces.map((workspace) => workspace.repoRoot).filter(Boolean),
      ...listKnownRepoRoots(),
    ]),
  ];
  let dropped = 0;
  for (const repoRoot of repoRoots) {
    for (const operation of ["create", "restore"] as const) {
      const prefix = `refs/zeros/${operation}/`;
      let refs: string[];
      try {
        const { stdout } = await runGit(repoRoot, [
          "for-each-ref",
          "--format=%(refname)",
          prefix,
        ]);
        refs = stdout
          .split("\n")
          .map((ref) => ref.trim())
          .filter((ref) => ref.startsWith(prefix));
      } catch {
        continue;
      }
      for (const ref of refs) {
        const workspaceId = ref.slice(prefix.length);
        if (retained[operation].has(workspaceId)) continue;
        try {
          await runGit(repoRoot, ["update-ref", "-d", ref]);
          dropped++;
        } catch {
          /* best effort; retry at the next startup */
        }
      }
    }
  }
  if (dropped > 0) {
    console.log(
      `[zeros] pruned ${dropped} orphan workspace branch ownership ref(s)`,
    );
  }
  return dropped;
}

/** Tear down a partially-created workspace. Returns false instead of guessing
 * when Git/filesystem ownership or removal cannot be proved; the hidden row
 * and journal then remain available for a later recovery pass. */
async function safeRollback(
  repoRoot: string,
  worktreePath: string,
  workspaceId: string,
  expectedBranch: string,
  branchToDelete?: string,
): Promise<boolean> {
  const lifecycle = getWorkspaceLifecycle(workspaceId);
  const workspace = getWorkspaceById(workspaceId);
  if (
    !workspace ||
    normalizePathForCompare(path.resolve(workspace.path)) !==
      normalizePathForCompare(path.resolve(worktreePath)) ||
    workspace.branch !== expectedBranch
  ) {
    return false;
  }
  let phaseProvesCheckout =
    lifecycle?.operation === "create" &&
    (lifecycle.phase === "worktree-created" ||
      lifecycle.phase === "work-applied");
  // Never recursively remove an unregistered path. It may have appeared after
  // prepare and belong to another process/user. A matching Git registration is
  // the ownership proof that permits filesystem cleanup.
  let ownsWorktree = false;
  let registrationReadSucceeded = false;
  try {
    const registrations = await listWorktreeRegistrations(repoRoot, {
      strict: true,
    });
    registrationReadSucceeded = true;
    const registrationMatches =
      registrations.get(normalizePathForCompare(worktreePath)) ===
      expectedBranch;
    if (registrationMatches && existsSync(worktreePath)) {
      // A stale common-dir entry can survive while an unrelated repository
      // replaces the human-readable folder. Parent registration alone must
      // never authorize recursive removal of that replacement.
      if (!(await managedCheckoutIdentityMatches(workspace))) return false;
    }
    ownsWorktree = registrationMatches;
  } catch {
    /* fail closed: preserve an unproven directory */
  }
  if (ownsWorktree) {
    // Persist the ownership proof before asking Git to remove anything. If Git
    // unregisters the worktree and then hits a filesystem error, the next
    // recovery pass must not mistake the surviving folder for an unrelated
    // pre-create path and discard the only recovery record.
    if (!phaseProvesCheckout) {
      try {
        updateWorkspaceLifecyclePhase(workspaceId, "worktree-created");
        phaseProvesCheckout = true;
      } catch {
        return false;
      }
    }
    if (workspace.kind === "design" && existsSync(worktreePath)) {
      try {
        await unlockDesignWorkspaceRoot(worktreePath);
      } catch {
        return false;
      }
    }
    try {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      // A checkout folder can disappear after Git registered it. Verify only
      // this operation's exact registration below; never repository-wide prune
      // entries owned by another Zeros/dev/tool instance.
      if (existsSync(worktreePath)) {
        if (workspace.kind === "design") {
          await lockDesignWorkspaceRoot(worktreePath).catch(() => {});
        }
        return false;
      }
    }
  }
  // Retain the hidden row + journal unless Git proved ownership and the owned
  // checkout is now gone. Deleting the only recovery record while a permission-
  // blocked directory/registration survives would manufacture an orphan.
  if (!registrationReadSucceeded) return false;
  if (!ownsWorktree && phaseProvesCheckout && existsSync(worktreePath)) {
    return false;
  }
  if (ownsWorktree) {
    if (existsSync(worktreePath)) return false;
    try {
      const registrations = await listWorktreeRegistrations(repoRoot, {
        strict: true,
      });
      if (
        registrations.get(normalizePathForCompare(worktreePath)) ===
        expectedBranch
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if (branchToDelete) {
    try {
      if (
        (await deleteOwnedWorkspaceBranch(
          repoRoot,
          workspaceId,
          branchToDelete,
        )) === "mismatch"
      ) {
        return false;
      }
    } catch {
      return false;
    }
  }
  const optimisticChatId =
    typeof lifecycle?.payload.optimisticChatId === "string"
      ? lifecycle.payload.optimisticChatId
      : null;
  if (optimisticChatId) {
    // The id is local-renderer supplied, so clamp deletion to the exact
    // announced workspace folder. Never let a malformed request name an
    // unrelated existing chat.
    const chat = getChat(optimisticChatId);
    if (chat?.folder === worktreePath) {
      try {
        deleteChat(optimisticChatId);
      } catch {
        return false;
      }
    }
  }
  try {
    deleteWorkspaceRow(workspaceId);
  } catch {
    return false;
  }
  if (getWorkspaceById(workspaceId)) return false;
  removeWorktreeSeed(worktreePath); // drop the app-data seed (internally guarded)
  return true;
}

/** Shared fail-closed create rollback for cross-tool/from-branch creation.
 * Returns false when ownership/removal cannot be verified; in that case the
 * hidden row + journal remain available for startup recovery. */
export function rollbackIncompleteWorkspace(args: {
  repoRoot: string;
  worktreePath: string;
  workspaceId: string;
  expectedBranch: string;
  branchToDelete?: string;
}): Promise<boolean> {
  return safeRollback(
    args.repoRoot,
    args.worktreePath,
    args.workspaceId,
    args.expectedBranch,
    args.branchToDelete,
  );
}

export interface ListWorkspacesOptions {
  repoSlug?: string;
  status?: WorkspaceStatus;
  /** true → archived only (History); false → non-archived (sidebar + Dashboard);
   *  undefined → all. Archived is identified by `archivedAt`, not `status`. */
  archived?: boolean;
}

/** Stamp the `present` flag on a workspace by stat-ing its worktree
 *  path. Synchronous fs check because every call site already runs in
 *  a sync engine context (the DB reads above are sync too) and the
 *  signal is needed before the caller hands the record to the renderer.
 *  ENOENT is the only non-present outcome we care about; permission
 *  errors fall through to `true` so a transient PEBKAC doesn't make
 *  every workspace look gone. */
function stampPresence(ws: Workspace): Workspace {
  return { ...ws, present: existsSync(ws.path) };
}

export function listWorkspaces(opts: ListWorkspacesOptions = {}): Workspace[] {
  return listWorkspacesFromDb(opts).map(stampPresence);
}

export function getWorkspace(workspaceId: string): Workspace {
  const ws = getWorkspaceById(workspaceId);
  if (!ws) {
    throw new GitError({
      code: "WORKSPACE_NOT_FOUND",
      message: `Workspace ${workspaceId} not found`,
    });
  }
  return stampPresence(ws);
}

/** Manually set a workspace's lifecycle status (right-click → Set status). This
 *  is the ONLY path to "backlog"/"cancelled", and it deliberately BYPASSES
 *  advanceLifecycle's guards — the user is choosing explicitly (incl. reviving a
 *  cancelled workspace or moving a done one back to in-progress). Archive state
 *  is orthogonal and untouched. */
export function setWorkspaceStatus(
  workspaceId: string,
  status: WorkspaceStatus,
): void {
  getWorkspace(workspaceId); // throws WORKSPACE_NOT_FOUND if the row is gone
  updateWorkspace(workspaceId, { status });
}

/** Synthesize a Workspace for a repo's primary checkout ("Local main" trunk) —
 *  no DB row exists for it. Used by `resolveRepoForGitOp` so git ops
 *  (status/diff/log + commit/push/stage/discard) can address the trunk by its
 *  repo root, exactly like a worktree. */
async function trunkWorkspace(repoRoot: string): Promise<Workspace> {
  let branch = "main";
  try {
    branch = await currentBranchName(repoRoot);
  } catch {
    /* detached HEAD → label it "main"; git ops still run against the path */
  }
  return {
    id: repoRoot,
    repoSlug: "",
    repoRoot,
    branch,
    // base-diff (`<base>...HEAD`) is a no-op for the trunk (HEAD is on the
    // branch); the meaningful trunk view is the working tree, via status().
    baseBranch: branch,
    path: repoRoot,
    status: "in-progress",
    createdAt: 0,
    archivedAt: null,
    stashRef: null,
    archivedHead: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    present: true,
  };
}

/** Resolve a git-op target. A real worktree id → its DB row. A registered repo
 *  ROOT path (the "Local main" trunk, which has no row) → a synthesized trunk
 *  workspace running against the root itself. Gated by `isKnownRepoRoot` so a
 *  caller can only address repositories the owner has opened (mirrors the
 *  workspace.create clamp). Throws WORKSPACE_NOT_FOUND for an unknown id/path.
 *
 *  "Local main" is a FIRST-CLASS, EDITABLE workspace — the trunk is a full
 *  read+write git target, exactly like any worktree (status/diff/log AND
 *  commit/push/pull/stage/discard). It used to be read-only (writes threw
 *  TRUNK_READ_ONLY); that restriction was removed so main behaves like every
 *  other workspace. The `isKnownRepoRoot` gate stays — it's the security clamp
 *  (a caller can only reach repos the owner opened), NOT a read-only gate. */
export async function resolveRepoForGitOp(
  idOrRoot: string,
): Promise<Workspace> {
  try {
    return getWorkspace(idOrRoot);
  } catch (err) {
    if (isKnownRepoRoot(idOrRoot)) {
      return trunkWorkspace(idOrRoot);
    }
    throw err;
  }
}

/** Archive a workspace. We capture the WHOLE working tree (committed +
 *  uncommitted + untracked-not-ignored), plus explicitly configured
 *  files-to-copy such as ignored `.env` files, into a durable per-workspace ref
 *  `refs/zeros/archive/<id>` via the per-turn snapshot plumbing, persist that
 *  snapshot's commit OID + the branch-tip anchor (`archived_head`) on the row,
 *  then remove the worktree folder. The branch ref is kept, and
 *  `restoreWorkspace` recreates the worktree and overlays the snapshot.
 *
 *  This replaces the old `git stash` path: the snapshot ref lives in the repo's
 *  shared object store (so it outlives the folder removal AND a later orphaned
 *  gitdir). Removal is verified before SQLite publishes the archive, so a
 *  blocked directory leaves a recoverable live row rather than a false success.
 *
 *  `repoRoot` is read off the workspace record (stored at create time),
 *  so callers don't need to re-supply it. */
export function archiveWorkspace(
  opts: ArchiveOptions,
  beforeMutation?: () => Promise<void>,
  beforeCheckoutEviction?: (
    workspaceId: string,
    worktreePath: string,
  ) => Promise<{ resume(): void; retire(): void }>,
): Promise<ArchiveResult> {
  return withWorkspaceLifecycleFlight(opts.workspaceId, "archive", async () => {
    const lifecycleStartedAt = Date.now();
    const reaperStartedAt = Date.now();
    await beforeMutation?.();
    const reaperMs = Date.now() - reaperStartedAt;
    return archiveWorkspaceInner(
      opts,
      { lifecycleStartedAt, reaperMs },
      beforeCheckoutEviction,
    );
  });
}

async function readManagedWorktreeRegistration(
  ws: Workspace,
): Promise<string | null | undefined> {
  let registrations: Map<string, string | null>;
  try {
    registrations = await listWorktreeRegistrations(ws.repoRoot, {
      strict: true,
    });
  } catch (cause) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Couldn't verify ownership of workspace directory ${ws.path}`,
      cause,
      remediation:
        "The workspace remains unchanged. Repair the repository's Git metadata, then retry.",
    });
  }
  return registrations.get(normalizePathForCompare(ws.path));
}

function resolveGitReportedPath(cwd: string, reported: string): string {
  return path.resolve(cwd, reported.trim());
}

async function canonicalExistingPath(candidate: string): Promise<string> {
  return normalizePathForCompare(
    await realpath(candidate).catch(() => path.resolve(candidate)),
  );
}

/** Return a separately registered semantic owner nested below this checkout.
 * Removing/moving the parent would cross that ownership boundary. Repository
 * roots and other workspace paths both count; stale registrations are still
 * protected until their owner is explicitly removed. */
function registeredNestedOwnerPath(ws: Workspace): string | null {
  const root = normalizePathForCompare(path.resolve(ws.path));
  const candidates = new Set<string>([
    ...listKnownRepoRoots(),
    ...listWorkspacesFromDb()
      .filter((workspace) => workspace.id !== ws.id)
      .map((workspace) => workspace.path),
  ]);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = normalizePathForCompare(path.resolve(candidate));
    const relative = path.relative(root, resolved);
    if (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    ) {
      return candidate;
    }
  }
  return null;
}

function assertNoRegisteredNestedOwner(ws: Workspace): void {
  const nested = registeredNestedOwnerPath(ws);
  if (!nested) return;
  throw new GitError({
    code: "VALIDATION_FAILED",
    message: `Workspace contains a separately registered repository/workspace: ${nested}`,
    remediation:
      "Move or remove the nested project from Zeros before archiving, deleting, or relocating its parent workspace.",
    context: { workspaceId: ws.id, path: ws.path, nestedOwner: nested },
  });
}

/** Verify both halves of linked-worktree ownership:
 *
 *  1. the parent repository still registers this exact path + branch; and
 *  2. the folder itself still resolves to that repository's common Git dir,
 *     top-level, and branch.
 *
 * Registration alone is insufficient: Finder/another tool can remove the
 * checkout without pruning `$GIT_COMMON_DIR/worktrees/*`, then place an
 * unrelated repository at the same human-readable path. */
async function managedCheckoutIdentityMatches(ws: Workspace): Promise<boolean> {
  const registeredBranch = await readManagedWorktreeRegistration(ws);
  if (registeredBranch !== ws.branch) return false;
  // Every linked checkout has its own `.git` indirection. Its absence proves
  // the registered path is stale without needing to run Git in a parent repo.
  if (!existsSync(path.join(ws.path, ".git"))) return false;

  try {
    const [top, worktreeCommon, repoCommon, branch] = await Promise.all([
      runGit(ws.path, ["rev-parse", "--show-toplevel"]),
      runGit(ws.path, ["rev-parse", "--git-common-dir"]),
      runGit(ws.repoRoot, ["rev-parse", "--git-common-dir"]),
      runGit(ws.path, ["branch", "--show-current"]),
    ]);
    const [actualTop, expectedTop, actualCommon, expectedCommon] =
      await Promise.all([
        canonicalExistingPath(top.stdout.trim()),
        canonicalExistingPath(ws.path),
        canonicalExistingPath(
          resolveGitReportedPath(ws.path, worktreeCommon.stdout),
        ),
        canonicalExistingPath(
          resolveGitReportedPath(ws.repoRoot, repoCommon.stdout),
        ),
      ]);
    return (
      actualTop === expectedTop &&
      actualCommon === expectedCommon &&
      branch.stdout.trim() === ws.branch
    );
  } catch (cause) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Couldn't verify the Git identity of workspace directory ${ws.path}`,
      cause,
      remediation:
        "The folder was preserved. Repair its Git worktree metadata, then retry.",
      context: { workspaceId: ws.id, path: ws.path },
    });
  }
}

/** Does this row still own a present, Zeros-managed checkout? Used before the
 * service reaps processes so a stale row can never kill work in a replacement
 * folder. A failed Git read throws; `false` means ownership was disproved. */
export async function workspaceOwnsManagedCheckout(
  workspaceId: string,
): Promise<boolean> {
  const ws = getWorkspace(workspaceId);
  if (
    isAdoptedWorkspace(ws.id) ||
    !isManagedWorktreePath(ws.path) ||
    !existsSync(ws.path)
  ) {
    return false;
  }
  // Abort the service-side process reaper before it can kill terminals/agents
  // owned by a more-specific nested project.
  assertNoRegisteredNestedOwner(ws);
  return managedCheckoutIdentityMatches(ws);
}

/** Prove that a managed-looking path is still this row's registered checkout.
 * A row plus a path under the managed root is not sufficient ownership: the
 * original folder can be deleted and replaced by another repository between
 * renders. Destructive lifecycle work must fail closed in that case. */
async function assertManagedWorktreeOwnership(ws: Workspace): Promise<void> {
  assertNoRegisteredNestedOwner(ws);
  if (!(await managedCheckoutIdentityMatches(ws))) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Workspace directory no longer has this workspace's exact Git identity: ${ws.path}`,
      remediation:
        "The folder was preserved. Refresh the workspace or repair its Git worktree registration before retrying.",
      context: {
        workspaceId: ws.id,
        path: ws.path,
        expectedBranch: ws.branch,
      },
    });
  }
}

/** Remove a managed checkout and verify the destructive half actually landed.
 * A journaled archive/delete is never committed while a replaced,
 * process-recreated, or permission-blocked directory is still present. */
async function removeManagedWorktreeForLifecycle(
  ws: Workspace,
  beforeCheckoutEviction?: (
    workspaceId: string,
    worktreePath: string,
  ) => Promise<{ resume(): void; retire(): void }>,
): Promise<PreparedDirectoryEviction> {
  await assertManagedWorktreeOwnership(ws);
  // Retire the exact recursive filesystem subscription before moving the
  // directory. A timer after the rename is not a synchronization primitive:
  // Chokidar/FSEvents can keep following the moved inode and then overwhelm
  // Bun when background cleanup recursively deletes a real, large checkout.
  const observation = await beforeCheckoutEviction?.(ws.id, ws.path);
  let staged: PreparedDirectoryEviction;
  try {
    if (ws.kind === "design") {
      await unlockDesignWorkspaceRoot(ws.path);
    }
    staged = await prepareWorktreeDirectoryEviction(ws.path);
  } catch (cause) {
    observation?.resume();
    if (ws.kind === "design" && existsSync(ws.path)) {
      await lockDesignWorkspaceRoot(ws.path).catch(() => {});
    }
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Workspace directory could not be staged for removal: ${ws.path}`,
      cause,
      remediation:
        "Close processes using this folder and retry. The checkout and recovery journal were preserved.",
      context: { workspaceId: ws.id, path: ws.path },
    });
  }
  // Do not resume immediately after the rename: thousands of native callbacks
  // can already be queued for a busy checkout. Retiring keeps those exact old-
  // path events inert through background deletion. A restore at the same path
  // is recognized as a new target and gets a fresh watcher automatically.
  observation?.retire();
  console.log(`[worktree] staged ${ws.id} checkout for background removal`);
  try {
    // The original path is now absent, so Git only removes its small exact
    // administrative entry. It never recursively walks the checkout while the
    // engine is serving workspace requests.
    await removeMissingWorkspaceRegistration(ws);
  } catch (cause) {
    // Once the atomic rename lands, the durable lifecycle journal owns
    // roll-forward recovery. Do not restore an uncertain Git registration into
    // a live path; startup will retry exact registration cleanup, then reclaim
    // the owner-marked staged directory.
    console.warn(
      `[worktree] ${ws.id} checkout staged at ${staged.moved[0]}, but registration cleanup is pending`,
    );
    throw cause;
  }
  console.log(`[worktree] removed ${ws.id} checkout`);
  // The caller owns commit ordering. Recursive cleanup must not start until
  // the authoritative archive/delete DB transition has committed.
  return staged;
}

async function archiveWorkspaceInner(
  opts: ArchiveOptions,
  timing?: { lifecycleStartedAt: number; reaperMs: number },
  beforeCheckoutEviction?: (
    workspaceId: string,
    worktreePath: string,
  ) => Promise<{ resume(): void; retire(): void }>,
): Promise<ArchiveResult> {
  const archiveStartedAt = timing?.lifecycleStartedAt ?? Date.now();
  const reaperMs = timing?.reaperMs ?? 0;
  let checkpointMs = 0;
  let hookMs = 0;
  let removalMs = 0;
  let stagedWorktree: PreparedDirectoryEviction | null = null;
  let ws = getWorkspace(opts.workspaceId);
  let journal = getWorkspaceLifecycle(opts.workspaceId);
  if (ws.archivedAt != null) {
    // A crash after the final row update but before an older build cleared its
    // intent is safe to settle idempotently.
    if (journal?.operation === "archive") {
      finishWorkspaceLifecycle(ws.id, {});
      journal = null;
    }
    return {
      archivedAt: ws.archivedAt,
      stashRef: ws.stashRef,
      archiveSnapshot: ws.archiveSnapshot ?? null,
      workspace: ws,
    };
  }
  if (journal && journal.operation !== "archive") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Workspace ${ws.id} has an interrupted ${journal.operation} operation`,
      remediation: "Restart Zeros to finish recovery, then retry.",
    });
  }
  // Refuse to archive an ADOPTED foreign worktree: archiving removes its folder,
  // which belongs to the external tool even when it happens to sit under the
  // managed root. Adopted worktrees are dropped via "remove from Zeros"
  // instead — the folder stays.
  if (isAdoptedWorkspace(ws.id) || !isManagedWorktreePath(ws.path)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "This worktree was adopted from another tool, so its folder isn't owned by Zeros and can't be archived.",
      remediation: "Remove it from Zeros instead — the worktree stays on disk.",
    });
  }
  // Refuse to archive a worktree whose FOLDER is gone from disk (deleted
  // out-of-band via `rm -rf`, Finder, or a parallel tool). Archiving checkpoints
  // uncommitted work then removes the folder — but there's nothing here to
  // checkpoint or remove, and marking the row archived would let a later restore
  // fabricate a PHANTOM worktree from the branch anchor: a fresh checkout with
  // the same name, NOT the user's lost work. That's the exact "unarchive
  // created a new worktree" bug. The record is corrupted; the only safe
  // recovery is permanent deletion, which the renderer offers on this error.
  // (An already-archived row short-circuits above, so restore's own
  // missing-folder handling is untouched.)
  if (!journal && !existsSync(ws.path)) {
    throw new GitError({
      code: "WORKTREE_MISSING",
      message:
        "This workspace's worktree folder is missing from disk, so it can't be archived.",
      remediation:
        "The workspace record is corrupted — delete it permanently to clean it up.",
      context: { workspaceId: ws.id, path: ws.path },
    });
  }
  if (existsSync(ws.path)) {
    await assertManagedWorktreeOwnership(ws);
  }
  // Capture the branch tip up-front as the restore recovery anchor. The branch
  // ref lives in the shared common gitdir, so this SHA stays valid after the
  // worktree folder is removed below — and lets `restoreWorkspace` recreate the
  // branch from the exact commit if it's later deleted out-of-band (stronger
  // than a legacy stash's first parent, which only exists when work was stashed).
  // Best-effort: a repo in a weird state must never block archiving.
  if (!journal) {
    const checkpointStartedAt = Date.now();
    let archivedHead: string | null = null;
    try {
      const { stdout } = await runGit(ws.repoRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${ws.branch}`,
      ]);
      archivedHead = stdout.trim() || null;
    } catch {
      /* restore falls back to origin/base/HEAD */
    }
    // Enumerate the checkout being archived, not the main checkout. A user may
    // create a configured ignored file (for example `.env.workspace`) only in
    // this worktree after creation; scanning main would omit it from the forced
    // snapshot paths and silently lose it on archive.
    //
    // Both PATTERN SETS apply, unioned. `.worktreeinclude` is a committed,
    // per-branch file, so a workspace branched before a pattern was added
    // (or one whose branch narrows the list) carries a different list from the
    // main checkout that SEEDED it. Scanning with the worktree's patterns
    // alone left every file seeded under a main-only pattern out of the
    // checkpoint — and `git worktree remove` then destroyed it with no way
    // back.
    //
    // The second scan is skipped when both checkouts resolve to the same
    // pattern list, which is the overwhelmingly common case (nobody edits
    // `.worktreeinclude` on a feature branch); the comparison is two file
    // reads against one more tree walk.
    const patternsDiffer =
      path.resolve(ws.repoRoot) !== path.resolve(ws.path) &&
      JSON.stringify(
        resolvePatternSource(ws.path, ws.repoRoot).patterns.map((p) => p.raw),
      ) !==
        JSON.stringify(
          resolvePatternSource(ws.repoRoot).patterns.map((p) => p.raw),
        );
    const scans = await Promise.all([
      resolveFilesToCopy(ws.path, {
        timeoutMs: 0,
        mainRepoRoot: ws.repoRoot,
        noSecondChance: true,
      }),
      ...(patternsDiffer
        ? [
            resolveFilesToCopy(ws.path, {
              timeoutMs: 0,
              mainRepoRoot: ws.repoRoot,
              patternRoot: ws.repoRoot,
              noSecondChance: true,
            }),
          ]
        : []),
    ]);
    for (const warning of scans.flatMap((s) => s.warnings)) {
      console.warn(`[archive] ${warning}`);
    }
    if (scans.some((s) => !s.complete)) {
      throw new GitError({
        code: "STASH_FAILED",
        message: `Couldn't enumerate configured files-to-copy for ${ws.path}`,
        remediation:
          "The workspace is unchanged and still live. Repair the repository's Git metadata, then retry.",
      });
    }
    const archiveIncludePaths = [
      ...new Set([
        ...scans.flatMap((s) => [...s.paths, ...s.deferredPaths]),
        // Explicit create-time copy/symlink paths can be outside today's repo
        // settings. Keep them durable for the workspace's whole lifetime so a
        // later archive never drops an ignored provisioned file.
        ...readProvisionPaths(ws.id),
        // The context graph survives archive — a workspace's attachments and
        // shared docs are part of its durable record: force-add the whole
        // tree, since `local/` is gitignored and `add -A` alone would drop it.
        // Only when it holds real content, so an empty skeleton doesn't make
        // the missing-snapshot check below stricter for clean workspaces.
        ...((await contextGraphHasContent(ws.path)) ? [CONTEXT_GRAPH_DIR] : []),
        // Disk-backed transcript images briefly lived under `.context/` before
        // the context graph landed. A transcript window lazily copies them into
        // the graph, but an unopened chat must survive archive until that read.
        ...(existsSync(path.join(ws.path, ".context/attachments"))
          ? LEGACY_ATTACHMENT_ARCHIVE_PATHS.filter((relative) =>
              existsSync(path.join(ws.path, relative)),
            )
          : []),
      ]),
    ];
    const archiveSnapshot = await snapshotWorkingTree(
      ws.path,
      archiveSnapshotRef(ws.id),
      {
        ...(archivedHead ? { parent: archivedHead } : {}),
        forceAddPaths: archiveIncludePaths,
      },
    );
    // Snapshot capture is allowed to be absent for a genuinely clean tree
    // (committed work remains on the branch), but never remove a dirty tree
    // without a durable checkpoint.
    if (!archiveSnapshot) {
      let stdout: string;
      try {
        ({ stdout } = await runGit(ws.path, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]));
      } catch (err) {
        throw new GitError({
          code: "STASH_FAILED",
          message: `Couldn't verify a durable archive snapshot for ${ws.path}`,
          cause: err,
          remediation:
            "The workspace is unchanged and still live. Repair its Git worktree metadata, then retry.",
        });
      }
      // `git status` intentionally hides ignored files. Configured
      // files-to-copy/provisioned paths are part of the archive contract, so
      // their presence also makes a missing checkpoint fatal.
      const hasConfiguredIgnoredData = archiveIncludePaths.some((relative) =>
        existsSync(path.resolve(ws.path, relative)),
      );
      if (stdout.length > 0 || hasConfiguredIgnoredData) {
        throw new GitError({
          code: "STASH_FAILED",
          message: `Couldn't capture the working tree for ${ws.path}`,
          remediation:
            "The workspace is unchanged and still live. Retry after checking Git status.",
        });
      }
    }
    journal = {
      workspaceId: ws.id,
      operation: "archive",
      phase: "prepared",
      sourcePath: ws.path,
      targetPath: null,
      sourceBranch: ws.branch,
      targetBranch: null,
      createFrom: null,
      archiveSnapshot,
      archivedHead,
      adaptations: [],
      payload: { archiveIncludePaths },
      includeBranch: false,
      startedAt: Date.now(),
    };
    try {
      beginWorkspaceLifecycle(journal, {
        stashRef: null,
        archivedHead,
        archiveSnapshot,
      });
    } catch (err) {
      if (!getWorkspaceLifecycle(ws.id)) {
        await deleteArchiveSnapshotRef(ws.repoRoot, ws.id);
      }
      throw err;
    }
    ws = getWorkspace(ws.id);
    checkpointMs += Date.now() - checkpointStartedAt;
  }

  // Run the repository's committed `scripts.archive` in the worktree while
  // it's still intact (after the snapshot, before eviction/removal). Non-fatal:
  // a cleanup script must never block archiving — the user keeps the ability to
  // archive even if the script errors.
  if (journal.phase === "prepared") {
    const archiveCommand = resolveRepoScript(ws.repoRoot, "archive");
    if (!archiveCommand) {
      // The pre-hook checkpoint is already the exact final tree. Advancing it
      // atomically avoids a second whole-tree `git add -A` on the overwhelmingly
      // common no-hook path (which doubled archive latency on large repos).
      sealWorkspaceArchiveCheckpoint(ws.id, {
        archiveSnapshot: journal.archiveSnapshot,
        archivedHead: journal.archivedHead,
      });
      journal = { ...journal, phase: "archive-script-finished" };
      ws = getWorkspace(ws.id);
    } else {
      // Mark before execution: after a crash it is safer to skip a potentially
      // non-idempotent cleanup script than to run it twice. The durable snapshot
      // was already taken, so the script is never load-bearing for user data.
      updateWorkspaceLifecyclePhase(ws.id, "archive-script-started");
      journal = { ...journal, phase: "archive-script-started" };
      const hookStartedAt = Date.now();
      try {
        await runInlineScript({
          kind: "archive",
          command: archiveCommand,
          workspaceId: ws.id,
          worktreePath: ws.path,
          repoRoot: ws.repoRoot,
          baseBranch: ws.baseBranch ?? "",
        });
      } catch (err) {
        console.warn(
          `[archive] archive script failed for ${ws.id} (continuing): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        hookMs += Date.now() - hookStartedAt;
      }
    }
  }

  // The repo hook is allowed to mutate the worktree. Seal the exact post-hook
  // tree before removal, and repeat this step on restart when a crash happened
  // during/after the hook. This narrows the final snapshot→removal race and
  // prevents hook-created tracked/untracked files from being lost.
  if (journal.phase === "archive-script-started") {
    const checkpointStartedAt = Date.now();
    if (existsSync(ws.path)) {
      // A hook may edit files, but it must not silently switch this worktree to
      // another branch/repository. Preserve the pre-hook checkpoint and stop
      // before sealing an unrelated checkout under this workspace's ref.
      await assertManagedWorktreeOwnership(ws);
    }
    let finalHead = journal.archivedHead;
    try {
      const { stdout } = await runGit(ws.repoRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${ws.branch}`,
      ]);
      finalHead = stdout.trim() || finalHead;
    } catch {
      /* retain the pre-hook branch anchor */
    }
    const archiveIncludePaths = Array.isArray(
      journal.payload.archiveIncludePaths,
    )
      ? journal.payload.archiveIncludePaths.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    const sealedSnapshot = await snapshotWorkingTree(
      ws.path,
      archiveSnapshotRef(ws.id),
      {
        ...(finalHead ? { parent: finalHead } : {}),
        forceAddPaths: archiveIncludePaths,
      },
    );
    // A hook may deliberately remove its own checkout. The pre-hook snapshot
    // still losslessly protects the user's starting tree, so finish from it
    // when the directory is already gone. If the directory remains, fail
    // closed: a final checkpoint failure must not be followed by deletion.
    const folderMissing = !existsSync(ws.path);
    const finalSnapshot =
      sealedSnapshot ?? (folderMissing ? journal.archiveSnapshot : null);
    if (!finalSnapshot && !folderMissing) {
      throw new GitError({
        code: "STASH_FAILED",
        message: `Couldn't seal the final archive snapshot for ${ws.path}`,
        remediation:
          "The workspace remains live and its recovery journal is retained. Repair its Git worktree metadata, then retry.",
      });
    }
    sealWorkspaceArchiveCheckpoint(ws.id, {
      archiveSnapshot: finalSnapshot,
      archivedHead: finalHead,
    });
    journal = {
      ...journal,
      phase: "archive-script-finished",
      archiveSnapshot: finalSnapshot,
      archivedHead: finalHead,
    };
    ws = getWorkspace(ws.id);
    checkpointMs += Date.now() - checkpointStartedAt;
  }

  if (journal.phase !== "worktree-removed" || existsSync(ws.path)) {
    const removalStartedAt = Date.now();
    if (existsSync(ws.path)) {
      stagedWorktree = await removeManagedWorktreeForLifecycle(
        ws,
        beforeCheckoutEviction,
      );
    } else {
      await removeMissingWorkspaceRegistration(ws);
    }
    updateWorkspaceLifecyclePhase(ws.id, "worktree-removed");
    removalMs += Date.now() - removalStartedAt;
  }
  const archivedAt = Date.now();
  finishWorkspaceLifecycle(opts.workspaceId, {
    // Archive is ORTHOGONAL to lifecycle status: keep `status` intact so History
    // preserves it and restore brings the workspace back exactly as it was.
    // `archivedAt` is the archived flag (queried in listWorkspaces).
    archivedAt,
    stashRef: null,
    archivedHead: journal.archivedHead,
    archiveSnapshot: journal.archiveSnapshot,
  });
  stagedWorktree?.commit();
  // Cleanup follows the DB commit. A crash here leaves only a stale app-data
  // seed; seed recovery will not resurrect it because the row already exists.
  removeWorktreeSeed(ws.path);
  const archived = getWorkspace(opts.workspaceId);
  console.log(
    `[worktree] archived ${ws.id} in ${Date.now() - archiveStartedAt}ms ` +
      `(reap=${reaperMs}ms, checkpoint=${checkpointMs}ms, ` +
      `hook=${hookMs}ms, remove=${removalMs}ms)`,
  );
  return {
    archivedAt,
    stashRef: null,
    archiveSnapshot: journal.archiveSnapshot,
    workspace: archived,
  };
}

// ── Restore robustness helpers ("always unarchivable") ─────────────────────

/** The worktree paths git currently has registered for `repoRoot` (porcelain).
 *  Restore consults this so it never picks a target path that belongs to a LIVE
 *  worktree. Best-effort: returns [] if the listing fails.
 *
 *  Retried (see `readWorktreeListPorcelain`) because the empty fallback is the
 *  DANGEROUS direction here: this feeds `worktreePathOccupied()` and
 *  `firstFreeWorktreePath()`, so a transient read failure reads as "no path is
 *  occupied" and restore can target a path belonging to a LIVE worktree — a
 *  silent collision, strictly worse than the loud error the `strict: true`
 *  caller raises from the same race. */
async function listWorktreePaths(repoRoot: string): Promise<string[]> {
  try {
    const stdout = await readWorktreeListPorcelain(repoRoot);
    const paths: string[] = [];
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree "))
        paths.push(line.slice("worktree ".length).trim());
    }
    return paths;
  } catch {
    return [];
  }
}

/** `git worktree list --porcelain` reads `.git/worktrees/<name>/` for every
 *  registration in the repo. A CONCURRENT `git worktree add` writes that admin
 *  directory in stages, so an overlapping read can hit a half-written entry and
 *  exit non-zero — a race inside Git itself, not in this code. Lifecycle
 *  operations on different workspaces legitimately overlap in one repo, so the
 *  window is reachable in normal use (and reliably in tests that drive
 *  create/archive through `Promise.all`).
 *
 *  `runGit` already retries transient `.git` LOCK contention, but no lock file
 *  is involved here, so `isGitLockContention` never matches and the blip
 *  reaches `strict: true` callers as a hard GitError.
 *
 *  Retrying is unconditionally safe: the command is read-only, so a failed
 *  attempt mutated nothing. The backoff is short because the admin directory is
 *  written in one burst — the window closes in milliseconds. */
const WORKTREE_LIST_RETRY_BACKOFF_MS = [15, 50, 150];

async function readWorktreeListPorcelain(repoRoot: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await runGit(repoRoot, [
        "worktree",
        "list",
        "--porcelain",
      ]);
      return stdout;
    } catch (error) {
      if (attempt >= WORKTREE_LIST_RETRY_BACKOFF_MS.length) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, WORKTREE_LIST_RETRY_BACKOFF_MS[attempt]),
      );
    }
  }
}

/** Registered worktree path → checked-out branch. Used by restart recovery to
 * distinguish the worktree this restore already created from an unrelated
 * occupant that must never be removed. */
async function listWorktreeRegistrations(
  repoRoot: string,
  opts: { strict?: boolean } = {},
): Promise<Map<string, string | null>> {
  const registrations = new Map<string, string | null>();
  try {
    const stdout = await readWorktreeListPorcelain(repoRoot);
    let currentPath: string | null = null;
    for (const raw of `${stdout}\n`.split("\n")) {
      if (raw.startsWith("worktree ")) {
        currentPath = normalizePathForCompare(
          raw.slice("worktree ".length).trim(),
        );
        registrations.set(currentPath, null);
      } else if (currentPath && raw.startsWith("branch refs/heads/")) {
        registrations.set(
          currentPath,
          raw.slice("branch refs/heads/".length).trim(),
        );
      } else if (raw === "") {
        currentPath = null;
      }
    }
  } catch (error) {
    if (opts.strict) throw error;
    /* best effort; the subsequent git worktree add remains authoritative */
  }
  return registrations;
}

/** Remove only a missing workspace's exact Git registration.
 *
 * `git worktree prune` is repository-wide: deleting/restoring one workspace
 * would also erase stale registrations belonging to another dev instance or
 * external tool. `git worktree remove --force <exact path>` handles a missing
 * checkout and scopes cleanup to that path. A branch mismatch is preserved as
 * another owner's registration; read/remove/verify failures leave the DB
 * lifecycle journal intact so recovery can retry without guessing.
 */
async function removeMissingWorkspaceRegistration(
  ws: Pick<Workspace, "id" | "repoRoot" | "path" | "branch">,
): Promise<void> {
  if (existsSync(ws.path)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Refusing stale-registration cleanup while a folder exists at ${ws.path}`,
      remediation:
        "The folder and workspace record were preserved. Refresh and retry.",
      context: { workspaceId: ws.id, path: ws.path },
    });
  }
  const normalizedPath = normalizePathForCompare(ws.path);
  const registrations = await listWorktreeRegistrations(ws.repoRoot, {
    strict: true,
  });
  if (registrations.get(normalizedPath) !== ws.branch) return;

  try {
    // One --force removes an unlocked missing worktree registration. A locked
    // entry deliberately remains protected rather than escalating to -ff.
    await runGit(ws.repoRoot, ["worktree", "remove", "--force", ws.path], {
      timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
    });
  } catch (cause) {
    const afterFailure = await listWorktreeRegistrations(ws.repoRoot, {
      strict: true,
    });
    if (afterFailure.get(normalizedPath) !== ws.branch) return;
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Couldn't remove the stale Git registration for workspace ${ws.id}`,
      cause,
      remediation:
        "The workspace record was preserved. Unlock or repair only this worktree registration, then retry.",
      context: { workspaceId: ws.id, path: ws.path },
    });
  }

  const remaining = await listWorktreeRegistrations(ws.repoRoot, {
    strict: true,
  });
  if (remaining.get(normalizedPath) === ws.branch) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Git kept the stale registration for workspace ${ws.id}`,
      remediation:
        "The workspace record was preserved. Repair only this worktree registration, then retry.",
      context: { workspaceId: ws.id, path: ws.path },
    });
  }
}

/** macOS reports some temp/home-adjacent paths through `/private/{var,tmp,etc}`
 *  while app state may store the shorter `/var` form. Normalize only for path
 *  equality checks; keep the original stored path for user-visible results. */
function normalizePathForCompare(p: string): string {
  return p.replace(/^\/private(\/(?:var|tmp|etc)\/)/, "$1");
}

/** Can a path NOT host a fresh `git worktree add`? Any existing directory is
 *  occupied unless Git already proves it is this operation's worktree. Empty
 *  directories can still belong to another user/process and must never be
 *  populated, then removed, based on inference alone. */
async function worktreePathOccupied(
  p: string,
  registered: Set<string>,
  exceptWorkspaceId?: string,
): Promise<boolean> {
  if (registered.has(normalizePathForCompare(p))) return true;
  // Exact lookup includes create-journal rows that workspace.list deliberately
  // hides. Their path is still a durable reservation and must not be claimed by
  // a concurrent restore.
  const exactOwner = getWorkspaceByPath(p);
  if (exactOwner && exactOwner.id !== exceptWorkspaceId) return true;
  const normalized = normalizePathForCompare(path.resolve(p));
  if (
    listWorkspacesFromDb().some(
      (workspace) =>
        workspace.id !== exceptWorkspaceId &&
        normalizePathForCompare(path.resolve(workspace.path)) === normalized,
    )
  ) {
    return true;
  }
  return existsSync(p);
}

/** First free sibling path for a restored worktree: `<base>-2`, `-3`, … skipping
 *  anything on disk or registered as a worktree. Bounded so a pathological repo
 *  can't spin forever. */
async function firstFreeWorktreePath(
  basePath: string,
  registered: Set<string>,
  exceptWorkspaceId?: string,
): Promise<string> {
  for (let n = 2; n < 100; n++) {
    const candidate = `${basePath}-${n}`;
    if (
      !(await worktreePathOccupied(candidate, registered, exceptWorkspaceId))
    ) {
      return candidate;
    }
  }
  throw new GitError({
    code: "VALIDATION_FAILED",
    message: `restoreWorkspace: could not find a free path near ${basePath}`,
  });
}

/** Is `branch` currently checked out in ANY worktree of the repo (including the
 *  main checkout)? git refuses to check the same branch out twice, so restore
 *  forks a new branch when this is true. */
async function branchCheckedOutElsewhere(
  repoRoot: string,
  branch: string,
): Promise<boolean> {
  try {
    const { stdout } = await runGit(repoRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const want = `branch refs/heads/${branch}`;
    return stdout.split("\n").some((l) => l.trim() === want);
  } catch {
    return false;
  }
}

/** First free branch name for a forked restore: `<branch>-restored`,
 *  `<branch>-restored-2`, … skipping any that already exist. */
async function firstFreeBranchName(
  repoRoot: string,
  branch: string,
): Promise<string> {
  const base = `${branch}-restored`;
  if (!(await refExists(repoRoot, `refs/heads/${base}`))) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!(await refExists(repoRoot, `refs/heads/${candidate}`)))
      return candidate;
  }
  throw new GitError({
    code: "VALIDATION_FAILED",
    message: `restoreWorkspace: could not find a free branch name near ${base}`,
  });
}

/** Resolve a commit-ish to a SHA, or null if it doesn't resolve to a commit.
 *  `^{commit}` peeling is literal under execFile (no shell), so a stash SHA or a
 *  `<sha>^1` parent both resolve safely. */
async function revParseCommitOrNull(
  cwd: string,
  ref: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(cwd, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Pick the best anchor to recreate a DELETED branch from, most-faithful first:
 *  the archive-time tip, the stash's first parent, origin/<branch>, the base
 *  branch, finally the repo HEAD. Restore must ALWAYS yield a worktree, so the
 *  chain bottoms out at a guaranteed-resolvable ref. */
async function resolveRestoreAnchor(
  ws: Workspace,
): Promise<{ ref: string; label: string }> {
  // 1. The exact commit the branch was on when archived (v16 anchor).
  if (ws.archivedHead) {
    const sha = await revParseCommitOrNull(ws.repoRoot, ws.archivedHead);
    if (sha) return { ref: sha, label: "its last saved commit" };
  }
  // 2. The stash's first parent == the branch tip at stash time.
  if (ws.stashRef) {
    const sha = await revParseCommitOrNull(ws.repoRoot, `${ws.stashRef}^1`);
    if (sha) return { ref: sha, label: "its last saved commit" };
  }
  // 3. The remote-tracking branch, if it still exists.
  const { remote } = resolveRepoGit(ws.repoRoot);
  if (await refExists(ws.repoRoot, `refs/remotes/${remote}/${ws.branch}`)) {
    return { ref: `${remote}/${ws.branch}`, label: `${remote}/${ws.branch}` };
  }
  // 4. The base branch.
  if (
    ws.baseBranch &&
    (await refExists(ws.repoRoot, `refs/heads/${ws.baseBranch}`))
  ) {
    return { ref: ws.baseBranch, label: `the base branch "${ws.baseBranch}"` };
  }
  // 5. Last resort — the repo's current HEAD. Loses branch-specific commits, but
  //    the worktree + any stashed WIP still come back, so restore succeeds.
  return { ref: "HEAD", label: "the repository's current state" };
}

/** Best-effort recovery net for an archive that captured NO durable snapshot
 *  (e.g. the worktree was already orphaned at archive time, so
 *  snapshotWorkingTree returned null). Re-applies the most recent per-turn POST
 *  snapshot for the workspace that still resolves to a commit. Returns true when
 *  something was overlaid. Turn snapshots are pruned at the retention cap, so
 *  this is a safety net, not a guarantee — committed work is already back via
 *  the branch checkout regardless. */
async function recoverFromLatestTurnSnapshot(
  ws: Workspace,
  targetPath: string,
): Promise<boolean> {
  try {
    for (const turn of listTurnsForWorkspace(ws.id)) {
      const snap = turn.postSnapshot ?? turn.preSnapshot;
      if (!snap) continue;
      if (!(await revParseCommitOrNull(ws.repoRoot, snap))) continue;
      return await restoreWorktreeFromSnapshot(targetPath, snap);
    }
  } catch {
    /* best effort — committed work is already restored via the branch */
  }
  return false;
}

/** Restore an archived workspace, adapting to the world as it is now. Recreates
 *  the worktree and reapplies its durable checkpoint (or a legacy stash),
 *  ADAPTING rather than failing
 *  when the world changed while archived:
 *    • original folder reoccupied  → restore to a fresh sibling path
 *    • branch checked out elsewhere → fork a new branch off it
 *    • branch deleted out-of-band   → recreate it from the saved commit anchor
 *  Checkpoint/stash conflicts are returned as a list (not thrown) — the
 *  worktree remains usable, with conflict markers in the listed files. `adaptations`
 *  describes anything that had to change so the caller can tell the user. */
export function restoreWorkspace(workspaceId: string): Promise<RestoreResult> {
  return withWorkspaceLifecycleFlight(workspaceId, "restore", async () => {
    const startedAt = Date.now();
    const result = await restoreWorkspaceInner(workspaceId);
    console.log(
      `[worktree] restored ${workspaceId} in ${Date.now() - startedAt}ms ` +
        `(conflicts=${result.conflicts.length}, adaptations=${result.adaptations.length})`,
    );
    return result;
  });
}

async function restoreWorkspaceInner(
  workspaceId: string,
): Promise<RestoreResult> {
  const ws = getWorkspace(workspaceId);
  if (ws.archivedAt == null) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Workspace ${workspaceId} is not archived`,
    });
  }
  let journal = getWorkspaceLifecycle(workspaceId);
  if (journal && journal.operation !== "restore") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Workspace ${workspaceId} has an interrupted ${journal.operation} operation`,
      remediation: "Restart Zeros to finish recovery, then retry.",
    });
  }
  const adaptations: string[] = journal ? [...journal.adaptations] : [];

  // Drop only this workspace's exact stale admin entry first. Repository-wide
  // `git worktree prune` can erase missing registrations owned by another
  // Zeros/dev/tool instance and is never appropriate for one restore.
  if (!existsSync(ws.path)) {
    try {
      await removeMissingWorkspaceRegistration(ws);
    } catch {
      // Best effort: the registration remains in `registered` below, so restore
      // safely adapts to a sibling path/branch instead of touching it.
    }
  }
  const registered = new Set(
    (await listWorktreePaths(ws.repoRoot)).map(normalizePathForCompare),
  );

  let targetPath: string;
  let targetBranch: string;
  let createFrom: string | null;
  if (journal) {
    targetPath = journal.targetPath ?? ws.path;
    targetBranch = journal.targetBranch ?? ws.branch;
    createFrom = journal.createFrom;
  } else {
    // Resolve path + branch first, then journal those exact decisions before
    // deleting a stale folder or creating a checkout.
    targetPath = ws.path;
    if (await worktreePathOccupied(ws.path, registered, ws.id)) {
      targetPath = await firstFreeWorktreePath(ws.path, registered, ws.id);
      adaptations.push(
        `The original folder was occupied, so the workspace was restored to "${path.basename(targetPath)}" without changing that folder.`,
      );
    }
    targetBranch = ws.branch;
    createFrom = null;
    if (!(await refExists(ws.repoRoot, `refs/heads/${ws.branch}`))) {
      const anchor = await resolveRestoreAnchor(ws);
      createFrom = anchor.ref;
      adaptations.push(
        `Branch "${ws.branch}" was missing, so it was recreated from ${anchor.label}.`,
      );
    } else if (await branchCheckedOutElsewhere(ws.repoRoot, ws.branch)) {
      targetBranch = await firstFreeBranchName(ws.repoRoot, ws.branch);
      createFrom = ws.branch;
      adaptations.push(
        `Branch "${ws.branch}" was checked out in another workspace, so this one was restored on a new branch "${targetBranch}".`,
      );
    }
    journal = {
      workspaceId,
      operation: "restore",
      phase: "prepared",
      sourcePath: ws.path,
      targetPath,
      sourceBranch: ws.branch,
      targetBranch,
      createFrom,
      archiveSnapshot: ws.archiveSnapshot ?? null,
      archivedHead: ws.archivedHead ?? null,
      adaptations,
      payload: {},
      includeBranch: false,
      startedAt: Date.now(),
    };
    beginWorkspaceLifecycle(journal);
  }

  if (journal.phase !== "prepared") {
    const registrations = await listWorktreeRegistrations(ws.repoRoot);
    const targetKey = normalizePathForCompare(targetPath);
    const targetIdentityMatches =
      existsSync(targetPath) &&
      registrations.get(targetKey) === targetBranch &&
      (await managedCheckoutIdentityMatches({
        ...ws,
        path: targetPath,
        branch: targetBranch,
      }));
    if (!targetIdentityMatches) {
      // The phase write won a race with an external deletion / crash cleanup.
      // Roll the journal back to its last reproducible point; the snapshot/stash
      // is still retained because final DB commit has not happened.
      updateWorkspaceLifecycleDetails(workspaceId, {
        phase: "prepared",
        adaptations,
        payload: journal.payload,
      });
      journal = { ...journal, phase: "prepared" };
    }
  }

  if (journal.phase === "prepared") {
    const registrations = await listWorktreeRegistrations(ws.repoRoot);
    let targetKey = normalizePathForCompare(targetPath);
    const registeredBranch = registrations.get(targetKey);
    if (registrations.has(targetKey) && registeredBranch !== targetBranch) {
      throw new GitError({
        code: "BRANCH_IN_USE",
        message: `Restore target ${targetPath} is now owned by another worktree`,
        remediation: "Remove that worktree or restart the restore.",
      });
    }
    const registeredTargetIsOurs =
      registrations.has(targetKey) &&
      registeredBranch === targetBranch &&
      existsSync(targetPath) &&
      (await managedCheckoutIdentityMatches({
        ...ws,
        path: targetPath,
        branch: targetBranch,
      }));
    // A plain folder can appear after the restore target was journaled. It is
    // not ours and may contain unrelated user data. The same applies to a stale
    // Git registration whose folder now resolves to another repository. Never
    // clear/adopt either; persist a new sibling decision before creating
    // anything so startup recovery resumes against the same safe path.
    if (
      !registeredTargetIsOurs &&
      (registrations.has(targetKey) ||
        (await worktreePathOccupied(
          targetPath,
          new Set(registrations.keys()),
          ws.id,
        )))
    ) {
      const occupiedPath = targetPath;
      targetPath = await firstFreeWorktreePath(
        occupiedPath,
        new Set(registrations.keys()),
        ws.id,
      );
      adaptations.push(
        `The folder "${path.basename(occupiedPath)}" became occupied, so the workspace was restored to "${path.basename(targetPath)}" without changing that folder.`,
      );
      updateWorkspaceLifecycleDetails(workspaceId, {
        phase: "prepared",
        adaptations,
        payload: journal.payload,
        targetPath,
      });
      journal = { ...journal, targetPath, adaptations };
      targetKey = normalizePathForCompare(targetPath);
    }
    if (!registrations.has(targetKey)) {
      let targetBranchExists = await refExists(
        ws.repoRoot,
        `refs/heads/${targetBranch}`,
      );
      let restoreBranchOwnership =
        createFrom !== null
          ? await restoreBranchOwnershipState(
              ws.repoRoot,
              workspaceId,
              targetBranch,
            )
          : ("absent" as const);
      // A marker without its branch can be reused by recreating the same
      // branch. A mismatch, however, proves somebody advanced/replaced that
      // branch; preserve it and release only our stale hidden marker.
      if (
        restoreBranchOwnership === "branch-missing" ||
        restoreBranchOwnership === "mismatch"
      ) {
        await clearWorkspaceBranchOwnershipMarkerFor(
          ws.repoRoot,
          workspaceId,
          "restore",
        );
        restoreBranchOwnership = "absent";
      }
      const targetBranchHeldElsewhere = [...registrations.entries()].some(
        ([registeredPath, registeredBranch]) =>
          registeredPath !== targetKey && registeredBranch === targetBranch,
      );
      // Branch availability can change after the restore decision was
      // journaled. Re-adapt before `worktree add`: never fail merely because
      // another tool checked out the source branch, and never adopt an
      // unrelated ref that appeared under any branch this operation had planned
      // to create (including the original name after it was found missing).
      const plannedCreationBranchAppeared =
        createFrom !== null &&
        targetBranchExists &&
        restoreBranchOwnership !== "owned";
      if (targetBranchHeldElsewhere || plannedCreationBranchAppeared) {
        const occupiedBranch = targetBranch;
        if (restoreBranchOwnership === "owned") {
          await clearWorkspaceBranchOwnershipMarkerFor(
            ws.repoRoot,
            workspaceId,
            "restore",
          );
        }
        const nextBranch = await firstFreeBranchName(
          ws.repoRoot,
          journal.sourceBranch,
        );
        if (!createFrom) createFrom = occupiedBranch;
        targetBranch = nextBranch;
        targetBranchExists = false;
        adaptations.push(
          targetBranchHeldElsewhere
            ? `Branch "${occupiedBranch}" became checked out elsewhere, so this workspace was restored on a new branch "${targetBranch}".`
            : `The planned restore branch "${occupiedBranch}" became occupied, so this workspace used "${targetBranch}" instead.`,
        );
        updateWorkspaceLifecycleDetails(workspaceId, {
          phase: "prepared",
          adaptations,
          payload: journal.payload,
          targetBranch,
          createFrom,
        });
        journal = {
          ...journal,
          targetBranch,
          createFrom,
          adaptations,
        };
      } else if (!targetBranchExists && !createFrom) {
        // The source branch existed when the intent was written but disappeared
        // before checkout. Recompute and persist the same durable recovery
        // anchor used for an initially-missing branch.
        const anchor = await resolveRestoreAnchor(ws);
        createFrom = anchor.ref;
        adaptations.push(
          `Branch "${targetBranch}" disappeared during restore, so it was recreated from ${anchor.label}.`,
        );
        updateWorkspaceLifecycleDetails(workspaceId, {
          phase: "prepared",
          adaptations,
          payload: journal.payload,
          createFrom,
        });
        journal = { ...journal, createFrom, adaptations };
      }
      await mkdir(path.dirname(targetPath), { recursive: true });
      if (!targetBranchExists) {
        if (!createFrom) {
          throw new GitError({
            code: "GIT_COMMAND_FAILED",
            message: `Restore branch "${targetBranch}" disappeared`,
          });
        }
        if (!(await revParseCommitOrNull(ws.repoRoot, createFrom))) {
          const missingBase = createFrom;
          const anchor = await resolveRestoreAnchor(ws);
          createFrom = anchor.ref;
          adaptations.push(
            `Restore base "${missingBase}" disappeared, so "${targetBranch}" was recreated from ${anchor.label}.`,
          );
          updateWorkspaceLifecycleDetails(workspaceId, {
            phase: "prepared",
            adaptations,
            payload: journal.payload,
            createFrom,
          });
          journal = { ...journal, createFrom, adaptations };
        }
        assertSafeGitRef(targetBranch, "restore branch");
        assertSafeGitRef(createFrom, "restore base");
        await createOwnedRestoreBranch({
          repoRoot: ws.repoRoot,
          workspaceId,
          branch: targetBranch,
          startPoint: createFrom,
        });
        updateWorkspaceLifecyclePhase(workspaceId, "branch-created");
        targetBranchExists = true;
      }
      await runGit(ws.repoRoot, ["worktree", "add", targetPath, targetBranch]);
    }
    updateWorkspaceLifecycleDetails(workspaceId, {
      phase: "worktree-created",
      adaptations,
      payload: journal.payload,
    });
    journal = { ...journal, phase: "worktree-created", adaptations };
  }

  // 4. Bring back the uncommitted + untracked work the archive captured.
  let conflicts: string[] = Array.isArray(journal.payload.conflicts)
    ? journal.payload.conflicts.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  let legacyStashApplied = journal.payload.legacyStashApplied === true;
  if (journal.phase === "worktree-created") {
    const snapshot = journal.archiveSnapshot ?? ws.archiveSnapshot ?? null;
    if (snapshot) {
      const archiveBase = journal.archivedHead ?? ws.archivedHead ?? null;
      const applyResult = archiveBase
        ? await applyArchiveSnapshotOntoCurrent(
            targetPath,
            snapshot,
            archiveBase,
          )
        : (await restoreWorktreeFromSnapshot(targetPath, snapshot))
          ? "applied"
          : "unavailable";
      if (applyResult === "conflicted") {
        conflicts = await detectConflictPaths(targetPath);
      } else if (applyResult === "unavailable") {
        throw new GitError({
          code: "STASH_FAILED",
          message: `The saved working-tree snapshot couldn't be applied to ${targetPath}`,
          remediation:
            "The restored checkout, lifecycle journal, and archive snapshot were retained. Repair Git conflicts/metadata and retry; saved work was not discarded.",
          context: { workspaceId, path: targetPath, snapshot },
        });
      }
    } else if (ws.stashRef) {
      // A crash may occur after `stash apply` but before the phase write. A fresh
      // restore checkout is clean, so existing changes mean the apply already
      // landed; never apply the same stash twice.
      const { stdout: statusOut } = await runGit(targetPath, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]);
      if (statusOut.length > 0) {
        legacyStashApplied = true;
        conflicts = await detectConflictPaths(targetPath);
      } else {
        try {
          await runGit(targetPath, ["stash", "apply", ws.stashRef]);
          legacyStashApplied = true;
        } catch (err) {
          conflicts = await detectConflictPaths(targetPath);
          if (conflicts.length === 0) {
            throw new GitError({
              code: "STASH_FAILED",
              message: `Failed to apply stash ${ws.stashRef} to ${targetPath}`,
              cause: err,
            });
          }
          legacyStashApplied = true;
        }
      }
    } else {
      const recovered = await recoverFromLatestTurnSnapshot(ws, targetPath);
      if (recovered) {
        adaptations.push(
          "Uncommitted work was recovered from the most recent turn checkpoint.",
        );
      }
    }
    const payload = {
      ...journal.payload,
      conflicts,
      legacyStashApplied,
    };
    updateWorkspaceLifecycleDetails(workspaceId, {
      phase: "work-applied",
      adaptations,
      payload,
    });
    journal = {
      ...journal,
      phase: "work-applied",
      adaptations,
      payload,
    };
  }

  // 5. Persist the (possibly adapted) state and refresh the recovery seed.
  const restoredAt = Date.now();
  if (ws.kind === "design") {
    // Sparse metadata is worktree-local and was removed with the archived
    // checkout. Reapply the one design cone before publishing the restored row,
    // then reinstate the root-file ACL boundary.
    await setWorkingDirectories(targetPath, [DESIGN_DIRECTORY_NAME], {
      forceSparse: true,
    });
    await lockDesignWorkspaceRoot(targetPath);
  }
  // Folder-keyed chats, the live workspace row, and journal removal share one
  // SQLite transaction. A stop can therefore observe either the old archived
  // identity or the fully rebound live identity, never chats stranded on an
  // intermediate restore path.
  finishWorkspaceLifecycle(
    workspaceId,
    {
      // Preserve the lifecycle `status` the workspace had before archiving —
      // restore is the exact inverse of archive. Clearing `archivedAt` alone
      // un-archives it (back onto the Dashboard, out of History).
      archivedAt: null,
      stashRef: null,
      archivedHead: null,
      archiveSnapshot: null,
      lastActiveAt: restoredAt,
      ...(targetPath !== ws.path ? { path: targetPath } : {}),
      ...(targetBranch !== ws.branch ? { branch: targetBranch } : {}),
    },
    targetPath !== journal.sourcePath
      ? () => rebindChatsFolder(journal.sourcePath, targetPath, workspaceId)
      : undefined,
  );
  await clearWorkspaceBranchOwnershipMarkerFor(
    ws.repoRoot,
    workspaceId,
    "restore",
  );
  // Recovery refs are cleanup, never part of the commit. Deleting them only
  // after the DB is live closes the old crash seam that left an archived row
  // with neither a worktree nor its saved snapshot.
  await deleteArchiveSnapshotRef(ws.repoRoot, ws.id);
  if (ws.stashRef && legacyStashApplied && conflicts.length === 0) {
    try {
      await withStashLock(ws.repoRoot, async () => {
        let ref = ws.stashRef as string;
        if (!/^stash@\{/.test(ref)) {
          const { stdout } = await runGit(targetPath, [
            "stash",
            "list",
            "--format=%H",
          ]);
          const idx = stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .indexOf(ref);
          ref = idx >= 0 ? `stash@{${idx}}` : "";
        }
        if (ref) await runGit(targetPath, ["stash", "drop", ref]);
      });
    } catch {
      /* cosmetic leaked legacy stash; restored work is already committed */
    }
  }
  // Re-write the recovery seed (app-data; the worktree is fresh after `worktree add`).
  const refreshed = getWorkspace(workspaceId);
  writeWorktreeSeed(refreshed);
  return {
    restoredAt,
    conflicts,
    path: targetPath,
    branch: targetBranch,
    adaptations,
    workspace: refreshed,
  };
}

/** Delete a workspace. Removes the worktree folder; optionally removes
 *  the local branch. Never touches the remote branch.
 *
 *  `repoRoot` is read off the workspace record. */
export function deleteWorkspace(
  opts: DeleteOptions,
  beforeMutation?: () => Promise<void>,
  beforeCheckoutEviction?: (
    workspaceId: string,
    worktreePath: string,
  ) => Promise<{ resume(): void; retire(): void }>,
): Promise<void> {
  return withWorkspaceLifecycleFlight(opts.workspaceId, "delete", async () => {
    const startedAt = Date.now();
    const reaperStartedAt = Date.now();
    await beforeMutation?.();
    const reaperMs = Date.now() - reaperStartedAt;
    await deleteWorkspaceInner(opts, beforeCheckoutEviction);
    console.log(
      `[worktree] deleted ${opts.workspaceId} in ${Date.now() - startedAt}ms ` +
        `(reap=${reaperMs}ms, includeBranch=${opts.includeBranch})`,
    );
  });
}

async function deleteWorkspaceInner(
  opts: DeleteOptions,
  beforeCheckoutEviction?: (
    workspaceId: string,
    worktreePath: string,
  ) => Promise<{ resume(): void; retire(): void }>,
): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  const repoRoot = ws.repoRoot;
  let stagedWorktree: PreparedDirectoryEviction | null = null;
  let journal = getWorkspaceLifecycle(ws.id);
  if (isAdoptedWorkspace(ws.id)) {
    // Adoption is registry-only regardless of where the external tool happened
    // to place its worktree. A path under Zeros' root is not ownership proof.
    if (journal) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `Workspace ${ws.id} has an interrupted ${journal.operation} operation`,
        remediation: "Restart Zeros to finish recovery, then retry.",
      });
    }
    await deleteArchiveSnapshotRef(repoRoot, ws.id);
    deleteWorkspaceRow(ws.id);
    removeWorktreeSeed(ws.path);
    return;
  }
  if (
    isManagedWorktreePath(ws.path) &&
    existsSync(ws.path) &&
    !(await workspaceOwnsManagedCheckout(ws.id))
  ) {
    // The registered checkout disappeared and another folder/worktree now owns
    // the stale path. Explicit deletion still removes the Zeros record, but it
    // must behave like "remove from Zeros": preserve that folder and every
    // branch. A restore/create journal may own a different target checkout, so
    // leave those for recovery instead of manufacturing an orphan.
    if (journal?.operation === "restore" || journal?.operation === "create") {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `Workspace ${ws.id} has an interrupted ${journal.operation} operation`,
        remediation: "Restart Zeros to finish recovery, then retry deletion.",
      });
    }
    await deleteArchiveSnapshotRef(repoRoot, ws.id);
    deleteWorkspaceRow(ws.id);
    removeWorktreeSeed(ws.path);
    return;
  }
  if (journal && journal.operation !== "delete") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Workspace ${ws.id} has an interrupted ${journal.operation} operation`,
      remediation: "Restart Zeros to finish recovery, then retry.",
    });
  }
  if (!journal) {
    journal = {
      workspaceId: ws.id,
      operation: "delete",
      phase: "prepared",
      sourcePath: ws.path,
      targetPath: null,
      sourceBranch: ws.branch,
      targetBranch: null,
      createFrom: null,
      archiveSnapshot: ws.archiveSnapshot ?? null,
      archivedHead: ws.archivedHead ?? null,
      adaptations: [],
      payload: {},
      includeBranch: opts.includeBranch,
      startedAt: Date.now(),
    };
    beginWorkspaceLifecycle(journal);
  }
  // Legacy rows without explicit adoption metadata still use managed-root
  // containment as their ownership signal. New adopted rows returned above
  // before reaching this path, even if another tool placed them under the
  // managed root.
  if (journal.phase !== "worktree-removed" || existsSync(ws.path)) {
    if (isManagedWorktreePath(ws.path)) {
      if (existsSync(ws.path)) {
        stagedWorktree = await removeManagedWorktreeForLifecycle(
          ws,
          beforeCheckoutEviction,
        );
      } else {
        await removeMissingWorkspaceRegistration(ws);
      }
    }
    updateWorkspaceLifecyclePhase(ws.id, "worktree-removed");
  }
  if (journal.includeBranch && isManagedWorktreePath(ws.path)) {
    // Branch cleanup is subordinate to deletion. A protected/locked branch
    // must not strand a live DB row whose directory was already removed.
    try {
      await runGit(repoRoot, ["branch", "-D", ws.branch]);
    } catch (err) {
      console.warn(
        `[worktree] deleted ${ws.id}, but branch ${ws.branch} remains: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Drop the durable archive snapshot ref (if any) so its commit becomes
  // gc-able — best-effort, and a no-op for a workspace that was never archived.
  await deleteArchiveSnapshotRef(repoRoot, opts.workspaceId);
  deleteWorkspaceRow(opts.workspaceId);
  stagedWorktree?.commit();
  removeWorktreeSeed(ws.path); // drop the app-data crash-recovery seed
}

/** Scan `git status` for files in a conflict (unmerged) state. Used by
 *  restoreWorkspace to surface a structured list when checkpoint application leaves
 *  markers behind. Uses `-z` so paths with spaces are byte-exact. */
async function detectConflictPaths(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(worktreePath, [
      "status",
      "--porcelain=v1",
      "-z",
      "-uno",
    ]);
    return parsePorcelainZ(stdout)
      .filter(isConflictEntry)
      .map((e) => e.path);
  } catch {
    return [];
  }
}

/** Relocate worktrees from the legacy hidden ~/.zeros/worktrees to the
 *  visible ~/zeros/workspaces. Uses git-native `worktree move` (atomic per
 *  worktree; a failure leaves the source intact + the gitdir pointers valid).
 *  Updates the registry `path` on success. Best-effort + idempotent —
 *  already-relocated worktrees are skipped, and seedFromDisk's dual-root scan
 *  recovers any that couldn't move. Roots default to the real ones; tests pass
 *  tmp dirs (the test seam makes the two equal → a no-op). */
export async function migrateWorktreesToNewRoot(
  legacyRoot: string = legacyWorktreesRoot(),
  newRoot: string = worktreesRoot(),
): Promise<{ moved: number; failed: number }> {
  if (legacyRoot === newRoot) return { moved: 0, failed: 0 };
  let moved = 0;
  let failed = 0;
  for (const ws of listWorkspacesFromDb()) {
    if (!ws.path || !ws.path.startsWith(legacyRoot + path.sep)) continue;
    if (ws.archivedAt != null) continue;
    if (isAdoptedWorkspace(ws.id)) continue;
    // Recovery owns every path decision while a lifecycle journal exists.
    // Moving it here would leave the durable source/target pointing at a folder
    // that no longer exists and turn a recoverable crash into an orphan.
    if (getWorkspaceLifecycle(ws.id)) continue;
    const newPath = path.join(newRoot, path.relative(legacyRoot, ws.path));
    const publishRelocation = () => {
      // Move folder-keyed durable consumers first. If the process stops before
      // the workspace row update, the next startup repeats this idempotently.
      rebindChatsFolder(ws.path, newPath, ws.id);
      writeWorktreeSeed({ ...ws, path: newPath });
      updateWorkspace(ws.id, { path: newPath });
      removeWorktreeSeed(ws.path);
    };
    try {
      if (!existsSync(ws.path)) {
        // `git worktree move` can complete before the following DB update. Only
        // adopt the destination when both the parent registration and the
        // folder's own Git identity prove it is the same checkout.
        if (!existsSync(newPath)) continue;
        if (
          !(await managedCheckoutIdentityMatches({
            ...ws,
            path: newPath,
          }))
        ) {
          continue;
        }
        publishRelocation();
        moved++;
        continue;
      }
      if (existsSync(newPath)) {
        failed++;
        console.warn(
          `[zeros] worktree relocate skipped for ${ws.id}: destination is occupied (${newPath})`,
        );
        continue;
      }
      if (registeredNestedOwnerPath(ws)) {
        failed++;
        console.warn(
          `[zeros] worktree relocate skipped for ${ws.id}: a separately registered owner is nested under ${ws.path}`,
        );
        continue;
      }
      if (!(await managedCheckoutIdentityMatches(ws))) {
        failed++;
        console.warn(
          `[zeros] worktree relocate skipped for ${ws.id}: source Git identity no longer matches (${ws.path})`,
        );
        continue;
      }
      await mkdir(path.dirname(newPath), { recursive: true });
      await runGit(ws.repoRoot, ["worktree", "move", ws.path, newPath]);
      publishRelocation();
      moved++;
    } catch (err) {
      failed++;
      console.warn(
        `[zeros] worktree relocate failed for ${ws.id} (${ws.path} → ${newPath}); left in place:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (moved > 0) {
    console.log(
      `[zeros] relocated ${moved} worktree(s) to ${newRoot}` +
        (failed ? ` (${failed} failed, left at the old path)` : ""),
    );
  }
  return { moved, failed };
}
