// Shared types for the git + GitHub integration layer.
//
// The shape of these objects is the wire contract between Electron main and
// the renderer (and any future remote-control surface). Keep them flat,
// JSON-serializable, and free of method members.

/** Workspace lifecycle status — the five kanban states shown on the Dashboard.
 *  This is the user-facing "intent" of a workspace and the single source of
 *  truth for the status columns.
 *
 *  Automatic transitions: create → "in-progress", PR opened → "in-review",
 *  PR merged → "done" (see `advanceLifecycle`). "backlog" and "cancelled" are
 *  reachable ONLY by an explicit manual set (right-click → Set status).
 *
 *  ARCHIVE IS ORTHOGONAL to status: an archived workspace keeps its lifecycle
 *  status and is identified by `archivedAt != null` (NOT by a status value).
 *  History lists archived rows; the Dashboard lists non-archived rows grouped
 *  by this field. */
export type WorkspaceStatus =
  | "backlog"
  | "in-progress"
  | "in-review"
  | "done"
  | "cancelled";

export type PrState = "draft" | "ready" | "merged" | "closed";
export type WorkspaceKind = "code" | "design";

/** Background setup-script state. NULL/undefined = no setup configured or it
 *  never ran. "running" while the setup PTY is live, then "passed"/"failed" on
 *  exit — or "stopped" when the run ended without a result (the user pressed
 *  Stop setup, or the engine quit mid-run and the orphan was reconciled).
 *  Setup runs in a worktree-scoped PTY AFTER create returns, so a slow
 *  `pnpm install` no longer blocks (or times out) workspace creation. */
export type SetupState = "running" | "passed" | "failed" | "stopped";

export type DetectedTool =
  | "zeros"
  | "cursor"
  | "conductor"
  | "superset"
  | "workmux"
  | "unknown";

export interface Workspace {
  id: string;
  /** Product surface and provisioning contract. Design workspaces retain the
   * normal Git lifecycle but expose only `Zeros Design/` to agents. */
  kind?: WorkspaceKind;
  repoSlug: string;
  /** Absolute path to the repo root (the "main" working tree). Stored
   *  per workspace so archive / restore / delete don't need the caller
   *  to re-supply it. Set at create time, never mutated. */
  repoRoot: string;
  branch: string;
  baseBranch: string;
  path: string;
  status: WorkspaceStatus;
  createdAt: number;
  archivedAt: number | null;
  stashRef: string | null;
  /** Branch tip commit (SHA) captured at archive time — the recovery anchor the
   *  always-succeeds restore uses to recreate the worktree's branch if it was
   *  deleted out-of-band while archived. Null for never-archived rows and
   *  pre-v16 archives. */
  archivedHead?: string | null;
  /** Commit OID of the durable archive snapshot (the whole working tree —
   *  tracked + untracked-not-ignored — captured at archive time into
   *  `refs/zeros/archive/<id>`). Restore overlays it to bring back uncommitted +
   *  untracked work without `git stash`. Null for never-archived rows and pre-v17
   *  (stash-based) archives, which restore via `stashRef`. */
  archiveSnapshot?: string | null;
  prNumber: number | null;
  prState: PrState | null;
  prUrl: string | null;
  agentId: string | null;
  lastActiveAt: number | null;
  /** Background setup-script state (see SetupState). Null when no setup is
   *  configured / it never ran. Surfaced in the Setup tab. */
  setupState?: SetupState | null;
  /** Does the worktree folder at `path` still exist on disk? Stamped
   *  at list/get time so the renderer can swap in the "Worktree
   *  missing" placeholder when a user has removed the folder out-of-
   *  band (rm -rf, finder trash, parallel tool wiping it). Always
   *  defined coming off the engine; optional in the type only for
   *  backwards-compat with pre-2026-05-28 callers that built Workspace
   *  shapes by hand in tests. */
  present?: boolean;
  /** Cheap "has any work been done here?" flag — a dirty tree OR commits on top
   *  of the base branch. Stamped by workspace.list ONLY when the caller passes
   *  `withChanges` (the Dashboard); undefined otherwise. Drives the Create-PR /
   *  no-button decision on cards + the conversation header. */
  hasChanges?: boolean;
}

export type FileChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  /** Present only for renames. */
  oldPath?: string;
}

export interface Hunk {
  filePath: string;
  /** The a-side (pre-image) path from `diff --git a/<old> b/<new>`. Differs
   *  from filePath on a rename; empty when the header couldn't be parsed. Used
   *  by the remote secret filter to drop a rename FROM a secret file. */
  oldFilePath?: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw unified-diff body for the hunk, including +/- prefixes. The
   *  renderer parses this for line-level rendering; we don't pre-split
   *  to avoid double work on a hot path. */
  body: string;
}

export interface Commit {
  sha: string;
  abbreviatedSha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  parents: string[];
}

export interface Branch {
  name: string;
  /** Short SHA of the tip commit. */
  tipSha: string;
  /** True if this branch is currently checked out in a worktree (any tool). */
  isCheckedOut: boolean;
  /** The worktree path that owns this branch, if any. */
  worktreePath: string | null;
  /** Best-effort detection of which tool created this branch / worktree. */
  origin: DetectedTool;
  /** Unix ms — last commit time on this branch. */
  lastCommitDate: number;
  /** PR URL if a Zeros workspace has one attached. Null otherwise (we don't
   *  scrape GitHub for non-Zeros branches in v1). */
  prUrl: string | null;
}

export interface PR {
  number: number;
  url: string;
  state: PrState;
  title: string;
  body: string;
  /** GitHub login of the PR author. */
  authorLogin: string;
  baseBranch: string;
  headBranch: string;
  /** Exact PR head generation from GitHub. */
  headSha?: string;
  /** "clean" | "dirty" | "blocked" | "unknown" — mirrors Octokit's
   *  pulls.get(mergeable_state). */
  mergeableState: string;
  isMergeable: boolean | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  /** Commit GitHub created for the merge (the squash commit in Zeros' flow). */
  mergeCommitSha?: string | null;
  /** Commits the BASE has that this PR's head doesn't (GitHub compare).
   *  Populated by getPr ONLY when `mergeable_state` is "behind" — powers the
   *  island's "Require branch to be up to date ( N commits behind )" label.
   *  Null/undefined = unknown. */
  behindBy?: number | null;
}

export interface CreateWorkspaceOptions {
  /** Defaults to code for compatibility with every pre-design caller. */
  kind?: WorkspaceKind;
  /** Optional — createWorkspace derives it from the origin URL
   *  (repoSlugFromOriginUrl) when omitted. Callers may pass one to override. */
  repoSlug?: string;
  /** Default base branch is whatever HEAD points to in the repo root. */
  baseBranch?: string;
  /** Original user prompt — used by the background-rename hook
   *  to suggest a semantic branch name. Optional. */
  prompt?: string;
  /** Optional script to run after worktree creation, before the agent
   *  spawns. Path is relative to the repo root. Inherits the user shell
   *  env plus ZEROS_* env vars (see setup-hooks.ts). */
  setupScript?: string;
  /** Untracked files / dirs to copy into the new worktree from the repo
   *  root. Typical use: ".env", ".env.local", "node_modules" (though for
   *  node_modules a symlink is usually better). */
  copyPaths?: string[];
  /** Untracked files / dirs to symlink (vs copy). Faster for large dirs
   *  like node_modules; mutations are shared with the root, which is
   *  usually what you want for dev-server cache reuse. */
  symlinkPaths?: string[];
  /** Bind this workspace to a specific agent at creation time. The
   *  workspace's last_active_at updates whenever this agent spawns
   *  against it. Optional. */
  agentId?: string;
  /** Allow auto-pickup of a repository-resident `.zeros/setup.sh`. Set only on
   *  the LOCAL create path — never for a relay/remote client. Even when set,
   *  auto-run still requires the ZEROS_AUTORUN_SETUP_SH opt-in. */
  allowAutoSetup?: boolean;
}

export interface CreatedWorkspace {
  workspaceId: string;
  branch: string;
  path: string;
  status: WorkspaceStatus;
  /** The resolved setup command to run in the background after create, or null
   *  when the repo has no setup configured (or this is a remote create, which
   *  never runs host shell). The engine spawns the setup PTY from this; the
   *  renderer can use its presence to open the Setup tab by default. */
  setupCommand?: string | null;
}

export interface ArchiveOptions {
  workspaceId: string;
  /** Legacy flag. Archive now ALWAYS captures the working tree into a durable
   *  per-workspace snapshot ref (uncommitted + untracked), since the snapshot is
   *  cheap (content-addressed) and the whole point is to never lose work — so
   *  this no longer gates anything. Kept for wire/API compatibility. */
  stashUncommitted: boolean;
}

export interface ArchiveResult {
  archivedAt: number;
  /** Legacy stash SHA. Null for v17+ archives (which use `archiveSnapshot`); only
   *  populated when the legacy stash path ran. */
  stashRef: string | null;
  /** Commit OID of the durable archive snapshot (`refs/zeros/archive/<id>`), or
   *  null only for a compatible legacy archive row without a snapshot. A new
   *  archive never removes a dirty worktree unless this checkpoint exists. */
  archiveSnapshot: string | null;
  /** Authoritative row after the archive transaction commits. Renderer caches
   * use it to move the same object from Live to Archived without a refetch gap. */
  workspace: Workspace;
}

export interface RestoreResult {
  restoredAt: number;
  /** List of paths with conflicts during stash-apply. Empty when clean. */
  conflicts: string[];
  /** The path the worktree was restored to. Usually the original `path`; differs
   *  when the original folder was occupied and restore adapted to a fresh sibling
   *  so it could always succeed. */
  path: string;
  /** The branch checked out after restore. Usually the original `branch`; differs
   *  when the original branch was checked out in another worktree and restore
   *  forked a fresh branch off it. */
  branch: string;
  /** Human-readable notes about any adaptation restore made so it could always
   *  succeed (occupied folder → fresh path, branch taken → new branch, branch
   *  deleted → recreated from the saved commit). Empty on a clean restore to the
   *  original path + branch. */
  adaptations: string[];
  /** Authoritative live row after restore (including any adapted path/branch). */
  workspace: Workspace;
}

export interface DeleteOptions {
  workspaceId: string;
  /** When true, also delete the local branch with `git branch -D`. The
   *  remote branch is never touched. */
  includeBranch: boolean;
}
