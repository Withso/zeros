// Write-path git operations: commit, push, pull, rebase, stash,
// change-target-branch. All shell out via git-exec.ts — system git
// handles the gnarly edge cases (auth helpers, refspecs, line-ending
// conversion) that isomorphic-git is shakier on.

import { getWorkspace, resolveRepoForGitOp } from "./worktree";
import {
  assertSafeGitRef,
  classifyGitTransportError,
  runGit,
  type ExpectedCategory,
} from "./git-exec";
import { refExists } from "./default-branch";
import { withStashLock } from "./stash-lock";
import { isConflictEntry, parsePorcelainZ } from "./porcelain";
import { getInProgressState } from "./repo";
import { GitError } from "./errors";
import { getWorkspaceById, updateWorkspace } from "./state";
import { resolveRepoGit } from "../settings/repo-git";
import {
  DEFAULT_DESIGN_DIRECTORY_NAME,
  designDirectoryNameFor,
} from "../design/directory-registry";

/** `git -c core.editor=true` — neutralizes the editor so --continue /
 *  merge / cherry-pick / revert never block on an interactive prompt. */
const NO_EDITOR = ["-c", "core.editor=true"];

/** Read currently-conflicted paths from `git status` output. Used by
 *  pull/rebase to surface a structured list when they hit conflicts.
 *  Uses `-z` so paths with spaces or special characters are byte-exact. */
async function listConflictedPaths(worktreePath: string): Promise<string[]> {
  const { stdout } = await runGit(worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
  ]);
  return parsePorcelainZ(stdout)
    .filter(isConflictEntry)
    .map((e) => e.path);
}

// ── commit ───────────────────────────────────────────────

export interface CommitOptions {
  workspaceId: string;
  message: string;
  /** Optional explicit list of paths to commit. When omitted, commits
   *  whatever's already staged in the index. */
  files?: string[];
  /** Amend the previous commit instead of creating a new one. The
   *  message replaces the previous message. */
  amend?: boolean;
  /** Narrow engine-only escape hatch for Design Mode → Save designs. Generic
   * code commits must never set this; commit() independently verifies that the
   * explicit pathspec is exactly the active Design directory. */
  authority?: "code" | "design-save";
}

export interface CommitResult {
  sha: string;
  branch: string;
}

function pathInsideDesign(candidate: string, designDir: string): boolean {
  const normalized = candidate
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return normalized === designDir || normalized.startsWith(`${designDir}/`);
}

async function stagedDesignPaths(
  cwd: string,
  designDir: string,
): Promise<string[]> {
  const { stdout } = await runGit(cwd, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    // A rename ordinarily reports only its destination in --name-only
    // output. Disable rename detection so moving a protected Design file out
    // of the directory is represented as a protected deletion plus an add.
    "--no-renames",
    "--diff-filter=ACDMRTUXB",
  ]);
  return stdout
    .split("\0")
    .filter((candidate) => candidate && pathInsideDesign(candidate, designDir));
}

export async function commit(opts: CommitOptions): Promise<CommitResult> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  if (!opts.message || opts.message.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "commit: 'message' must be a non-empty string",
    });
  }
  const designDir = getWorkspaceById(opts.workspaceId)
    ? designDirectoryNameFor(ws.path)
    : DEFAULT_DESIGN_DIRECTORY_NAME;
  // An empty array does not add a Git pathspec, so it has exactly the same
  // commit semantics as omission. Normalize it before enforcing authority.
  const files = opts.files && opts.files.length > 0 ? opts.files : undefined;
  const explicitDesignPaths = (files ?? []).filter((candidate) =>
    pathInsideDesign(candidate, designDir),
  );
  const stagedDesign = await stagedDesignPaths(ws.path, designDir);
  if (opts.authority === "design-save") {
    if (!files || files.length !== 1 || files[0] !== designDir) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message:
          "Design-save authority may commit only the active Design directory.",
      });
    }
  } else if (
    opts.authority === "code" &&
    (explicitDesignPaths.length > 0 || (!files && stagedDesign.length > 0))
  ) {
    // A pathspec commit does not include unrelated staged paths. For that form
    // inspect the explicit paths; for the ordinary no-pathspec form inspect
    // the exact staged tree that Git will commit.
    const blocked = [
      ...new Set([...explicitDesignPaths, ...(!files ? stagedDesign : [])]),
    ];
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        blocked.length === 1
          ? `"${blocked[0]}" is inside the Design directory — a code commit cannot include it.`
          : `${blocked.length} staged paths are inside the Design directory — a code commit cannot include them.`,
      remediation: 'Unstage those paths and use Design Mode → "Save designs".',
      context: { workspaceId: opts.workspaceId },
    });
  }
  const args = ["commit", "-m", opts.message];
  if (opts.amend) args.push("--amend");
  if (files) {
    args.push("--", ...files);
  }
  const result = await runGit(ws.path, args, {
    treatAsExpected: ["nothing-to-do"],
  });
  if (result.expectedError === "nothing-to-do") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Nothing to commit — staged tree is empty",
      remediation: "Stage paths via git_stage first, or pass `files`.",
    });
  }
  const { stdout: shaOut } = await runGit(ws.path, ["rev-parse", "HEAD"]);
  const sha = shaOut.trim();
  // Read the branch with `rev-parse --abbrev-ref` (returns "HEAD" on
  // a detached HEAD and exits 0). `symbolic-ref` exits non-zero when
  // detached, which made `runGit` THROW here — AFTER the commit had
  // already landed — so the UI saw an error for a mutation that succeeded
  // and the draft→active bump was skipped.
  const { stdout: branchOut } = await runGit(ws.path, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  const branch = branchOut.trim();
  // A commit just refreshes lastActiveAt now. Created workspaces already start at
  // "in-progress", and lifecycle transitions are driven by PR open/merge — there
  // is no draft→active step in the v18 status model.
  updateWorkspace(opts.workspaceId, { lastActiveAt: Date.now() });
  return { sha, branch };
}

// ── push ─────────────────────────────────────────────────

export interface PushOptions {
  workspaceId: string;
  /** Set upstream tracking on push. Defaults to true on first push
   *  (when the remote ref doesn't exist yet) — passing false is the
   *  escape hatch for partial pushes. */
  setUpstream?: boolean;
  /** Push with --force-with-lease. Brief explicitly forbids unconditional
   *  --force; --force-with-lease is the safer variant that refuses to
   *  overwrite unexpected remote changes. */
  force?: boolean;
  remote?: string;
}

export interface PushResult {
  remoteRef: string;
  ahead: number;
  behind: number;
}

export async function push(opts: PushOptions): Promise<PushResult> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  // No explicit remote → the repo's configured `git.remote` (default origin),
  // so push honors the same "Remote origin" setting as create/fetch/PR.
  const remote = opts.remote ?? resolveRepoGit(ws.repoRoot).remote;
  assertSafeGitRef(remote, "push.remote");
  const args = ["push"];
  if (opts.setUpstream !== false) args.push("-u");
  if (opts.force) args.push("--force-with-lease");
  args.push(remote, ws.branch);
  await runGit(ws.path, args, {
    // Bound the renderer request even if a remote transport wedges.
    timeoutMs: 60_000,
    mapErrorCode: (stderr) =>
      classifyGitTransportError(stderr) ?? "GIT_COMMAND_FAILED",
  });
  const ahead = await aheadBehind(ws.path, `${remote}/${ws.branch}`, ws.branch);
  return { remoteRef: `${remote}/${ws.branch}`, ...ahead };
}

/** Return how many commits `head` is ahead/behind `base`. Both must be
 *  resolvable refs in the worktree. */
async function aheadBehind(
  worktreePath: string,
  base: string,
  head: string,
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await runGit(worktreePath, [
      "rev-list",
      "--left-right",
      "--count",
      `${base}...${head}`,
    ]);
    const [b, a] = stdout
      .trim()
      .split(/\s+/)
      .map((n) => parseInt(n, 10) || 0);
    return { ahead: a, behind: b };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

// ── pull ─────────────────────────────────────────────────

export interface PullOptions {
  workspaceId: string;
  strategy: "rebase" | "merge";
  /** Auto-stash uncommitted changes before pulling and re-apply after.
   *  Wraps git's built-in --autostash for both rebase and merge. */
  autoStash?: boolean;
  remote?: string;
}

export interface PullResult {
  applied: number;
  conflicts: string[];
}

export async function pull(opts: PullOptions): Promise<PullResult> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  // Same setting-aware default as push.
  const remote = opts.remote ?? resolveRepoGit(ws.repoRoot).remote;
  assertSafeGitRef(remote, "pull.remote");
  const args = ["pull"];
  if (opts.strategy === "rebase") args.push("--rebase");
  else args.push("--no-rebase");
  if (opts.autoStash) args.push("--autostash");
  args.push(remote, ws.branch);
  // Snapshot ahead-count BEFORE pulling so we can report how many
  // commits were applied.
  const before = await aheadBehind(ws.path, `${remote}/${ws.branch}`, "HEAD");
  const result = await runGit(ws.path, args, {
    treatAsExpected: ["conflict", "nothing-to-do"] as ExpectedCategory[],
  });
  if (result.expectedError === "conflict") {
    return {
      applied: 0,
      conflicts: await listConflictedPaths(ws.path),
    };
  }
  const after = await aheadBehind(ws.path, `${remote}/${ws.branch}`, "HEAD");
  // Commits applied = (commits behind before) − (commits behind after).
  // Behind dropped to zero is the typical success case.
  const applied = Math.max(0, before.behind - after.behind);
  return { applied, conflicts: [] };
}

// ── rebase ───────────────────────────────────────────────

export interface RebaseOptions {
  workspaceId: string;
  ontoBranch: string;
  autoStash?: boolean;
}

export interface RebaseResult {
  applied: number;
  conflicts: string[];
}

export async function rebase(opts: RebaseOptions): Promise<RebaseResult> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.ontoBranch, "rebase.ontoBranch");
  const args = ["rebase"];
  if (opts.autoStash) args.push("--autostash");
  args.push(opts.ontoBranch);
  // How many commits we have AHEAD of the target branch — that's the
  // number we'll replay.
  const before = await aheadBehind(ws.path, opts.ontoBranch, "HEAD");
  const result = await runGit(ws.path, args, {
    treatAsExpected: ["conflict", "nothing-to-do"] as ExpectedCategory[],
  });
  if (result.expectedError === "conflict") {
    return {
      applied: 0,
      conflicts: await listConflictedPaths(ws.path),
    };
  }
  return { applied: before.ahead, conflicts: [] };
}

// ── stash save / pop ─────────────────────────────────────

export interface StashSaveOptions {
  workspaceId: string;
  message?: string;
}

export interface StashSaveResult {
  stashRef: string;
}

export async function stashSave(
  opts: StashSaveOptions,
): Promise<StashSaveResult> {
  const ws = getWorkspace(opts.workspaceId);
  // `stash push` is the modern name; `stash save` was the legacy. Use
  // `push -m` since it doesn't conflict with --include-untracked behavior.
  const args = ["stash", "push", "--include-untracked"];
  if (opts.message) {
    args.push("-m", opts.message);
  }
  // Serialize push + `rev-parse stash@{0}` per repository so a concurrent stash
  // op on another worktree of the SAME repo can't shift the stack between them
  // (which would resolve the WRONG stash SHA → wrong restore later).
  return withStashLock(ws.repoRoot, async () => {
    await runGit(ws.path, args);
    // `stash@{0}` is the freshest stash; resolve to a SHA so the caller has a
    // stable handle even if more stashes pile up.
    const { stdout } = await runGit(ws.path, ["rev-parse", "stash@{0}"]);
    return { stashRef: stdout.trim() };
  });
}

export interface StashPopOptions {
  workspaceId: string;
  /** SHA of the stash to pop. We resolve it to a stash@{N} index by
   *  scanning `git stash list` since `stash pop <sha>` doesn't work
   *  directly. */
  stashRef: string;
}

export interface StashPopResult {
  conflicts: string[];
}

export async function stashPop(opts: StashPopOptions): Promise<StashPopResult> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.stashRef, "stashPop.stashRef");
  // `git stash pop` doesn't accept SHAs — only `stash@{N}` indices. We
  // resolve the SHA to an index via `git stash list --format=%H`, then
  // apply and drop. This matches `pop` semantics. If the SHA isn't on
  // the stack we fall back to `apply <sha>` (which DOES accept SHAs) so
  // re-applying an explicit ref always works.
  const list = await runGit(ws.path, ["stash", "list", "--format=%H"]);
  const lines = list.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const idx = lines.indexOf(opts.stashRef);

  const applyArgs =
    idx >= 0
      ? ["stash", "pop", `stash@{${idx}}`]
      : ["stash", "apply", opts.stashRef];

  const result = await runGit(ws.path, applyArgs, {
    treatAsExpected: ["conflict"] as ExpectedCategory[],
    mapErrorCode: () => "STASH_FAILED",
  });
  if (result.expectedError === "conflict") {
    return { conflicts: await listConflictedPaths(ws.path) };
  }
  return { conflicts: [] };
}

// ── change target branch ─────────────────────────────────

export interface ChangeTargetBranchOptions {
  workspaceId: string;
  newTarget: string;
  /** Explicit opt-in history rewrite after updating the target metadata.
   *  Target selection itself defaults to metadata-only so a picker cannot
   *  unexpectedly autostash/rebase a dirty or conflicted working tree. */
  rebase?: boolean;
}

export interface ChangeTargetBranchResult {
  baseBranch: string;
  conflicts: string[];
}

export async function changeTargetBranch(
  opts: ChangeTargetBranchOptions,
): Promise<ChangeTargetBranchResult> {
  // Throws WORKSPACE_NOT_FOUND if the id is unknown — the return value is
  // unused here; the call validates the target exists (worktree or trunk).
  await resolveRepoForGitOp(opts.workspaceId);
  if (!opts.newTarget || typeof opts.newTarget !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "changeTargetBranch: 'newTarget' must be a non-empty string",
    });
  }
  assertSafeGitRef(opts.newTarget, "changeTargetBranch.newTarget");
  let conflicts: string[] = [];
  if (opts.rebase) {
    // The target is picked from the REMOTE branch list, so it may have no local
    // branch of that name (a teammate's branch we've never checked out). Rebase
    // onto the remote-tracking ref in that case; `git rebase <name>` would fail
    // with "invalid upstream". We still PERSIST the plain name (baseBranch is
    // stored unqualified — see resolveBaseRef in diff.ts).
    const ws = getWorkspace(opts.workspaceId);
    const { remote } = resolveRepoGit(ws.repoRoot);
    const ontoBranch = (await refExists(
      ws.path,
      `refs/heads/${opts.newTarget}`,
    ))
      ? opts.newTarget
      : (await refExists(ws.path, `refs/remotes/${remote}/${opts.newTarget}`))
        ? `${remote}/${opts.newTarget}`
        : opts.newTarget;
    const r = await rebase({
      workspaceId: opts.workspaceId,
      ontoBranch,
      autoStash: true,
    });
    conflicts = r.conflicts;
  }
  updateWorkspace(opts.workspaceId, { baseBranch: opts.newTarget });
  return { baseBranch: opts.newTarget, conflicts };
}

// ── merge / cherry-pick / revert (D.5) ───────────────────

export interface MergeOptions {
  workspaceId: string;
  branch: string;
  /** Force a merge commit even when a fast-forward is possible. */
  noFF?: boolean;
}

export interface MergeResult {
  merged: boolean;
  conflicts: string[];
}

export async function merge(opts: MergeOptions): Promise<MergeResult> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.branch, "merge.branch");
  const args = [...NO_EDITOR, "merge"];
  if (opts.noFF) args.push("--no-ff");
  args.push(opts.branch);
  const result = await runGit(ws.path, args, {
    treatAsExpected: ["conflict", "nothing-to-do"] as ExpectedCategory[],
  });
  if (result.expectedError === "conflict") {
    return { merged: false, conflicts: await listConflictedPaths(ws.path) };
  }
  return { merged: true, conflicts: [] };
}

export interface CherryPickOptions {
  workspaceId: string;
  sha: string;
}

export async function cherryPick(
  opts: CherryPickOptions,
): Promise<{ conflicts: string[] }> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.sha, "cherryPick.sha");
  const result = await runGit(
    ws.path,
    [...NO_EDITOR, "cherry-pick", opts.sha],
    {
      treatAsExpected: ["conflict"] as ExpectedCategory[],
    },
  );
  if (result.expectedError === "conflict") {
    return { conflicts: await listConflictedPaths(ws.path) };
  }
  return { conflicts: [] };
}

export async function revert(
  opts: CherryPickOptions,
): Promise<{ conflicts: string[] }> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.sha, "revert.sha");
  const result = await runGit(ws.path, [...NO_EDITOR, "revert", opts.sha], {
    treatAsExpected: ["conflict"] as ExpectedCategory[],
  });
  if (result.expectedError === "conflict") {
    return { conflicts: await listConflictedPaths(ws.path) };
  }
  return { conflicts: [] };
}

// ── conflict resolution: continue / abort (D.4) ──────────

/** Continue the in-progress merge/rebase/cherry-pick/revert. Returns any
 *  remaining conflicts as data (not thrown). */
export async function continueOperation(
  workspaceId: string,
): Promise<{ conflicts: string[]; kind: string }> {
  const ws = getWorkspace(workspaceId);
  const kind = await getInProgressState(ws.path);
  if (!kind) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "No merge/rebase/cherry-pick/revert is in progress",
    });
  }
  const result = await runGit(ws.path, [...NO_EDITOR, kind, "--continue"], {
    treatAsExpected: ["conflict"] as ExpectedCategory[],
  });
  if (result.expectedError === "conflict") {
    return { conflicts: await listConflictedPaths(ws.path), kind };
  }
  return { conflicts: [], kind };
}

/** Abort the in-progress merge/rebase/cherry-pick/revert. */
export async function abortOperation(
  workspaceId: string,
): Promise<{ kind: string }> {
  const ws = getWorkspace(workspaceId);
  const kind = await getInProgressState(ws.path);
  if (!kind) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "No merge/rebase/cherry-pick/revert is in progress",
    });
  }
  await runGit(ws.path, [kind, "--abort"]);
  return { kind };
}

// ── stash list / apply / drop (D.5) ──────────────────────

export interface StashEntry {
  index: number;
  ref: string;
  sha: string;
  message: string;
  /** Unix ms. */
  date: number;
}

export async function listStashes(workspaceId: string): Promise<StashEntry[]> {
  const ws = getWorkspace(workspaceId);
  const { stdout } = await runGit(ws.path, [
    "stash",
    "list",
    "--format=%gd%x00%H%x00%ct%x00%gs",
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line, idx) => {
      const [ref, sha, ts, gs] = line.split("\0");
      return {
        index: idx,
        ref: ref ?? `stash@{${idx}}`,
        sha: sha ?? "",
        message: gs ?? "",
        date: (parseInt(ts ?? "0", 10) || 0) * 1000,
      };
    });
}

export async function applyStash(opts: {
  workspaceId: string;
  stashRef: string;
}): Promise<{ conflicts: string[] }> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.stashRef, "applyStash.stashRef"); // (Low) parity with stashPop
  const result = await runGit(ws.path, ["stash", "apply", opts.stashRef], {
    treatAsExpected: ["conflict"] as ExpectedCategory[],
    mapErrorCode: () => "STASH_FAILED",
  });
  if (result.expectedError === "conflict") {
    return { conflicts: await listConflictedPaths(ws.path) };
  }
  return { conflicts: [] };
}

export async function dropStash(opts: {
  workspaceId: string;
  stashRef: string;
}): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  // `git stash drop` only accepts stash@{N}; resolve a SHA to its index.
  let ref = opts.stashRef;
  if (!/^stash@\{/.test(ref)) {
    const { stdout } = await runGit(ws.path, ["stash", "list", "--format=%H"]);
    const idx = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .indexOf(ref);
    if (idx < 0) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `dropStash: stash ${ref} not found on the stack`,
      });
    }
    ref = `stash@{${idx}}`;
  }
  await runGit(ws.path, ["stash", "drop", ref], {
    mapErrorCode: () => "STASH_FAILED",
  });
}

// ── tags (D.5) ───────────────────────────────────────────

export async function createTag(opts: {
  workspaceId: string;
  name: string;
  ref?: string;
  message?: string;
}): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  if (!opts.name) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "createTag: 'name' is required",
    });
  }
  assertSafeGitRef(opts.name, "createTag.name"); // (Low) reject "-"-leading / NUL
  if (opts.ref) assertSafeGitRef(opts.ref, "createTag.ref");
  const args = ["tag"];
  if (opts.message) args.push("-m", opts.message); // implies annotated (-a)
  args.push(opts.name);
  if (opts.ref) args.push(opts.ref);
  await runGit(ws.path, args);
}

export async function listTags(workspaceId: string): Promise<string[]> {
  const ws = getWorkspace(workspaceId);
  const { stdout } = await runGit(ws.path, [
    "tag",
    "--list",
    "--sort=-creatordate",
  ]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function deleteTag(opts: {
  workspaceId: string;
  name: string;
}): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.name, "deleteTag.name"); // (Low) reject "-"-leading / NUL
  await runGit(ws.path, ["tag", "-d", opts.name]);
}
