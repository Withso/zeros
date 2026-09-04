// Write-path git operations: commit, push, pull, rebase, stash,
// change-target-branch. All shell out via git-exec.ts — system git
// handles the gnarly edge cases (auth helpers, refspecs, line-ending
// conversion) that isomorphic-git is shakier on.

import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
import {
  discoverDesignDirectories,
  resolveDesignDirectoryPointerState,
} from "../design/directory";
import { stickyRecognizedDesignDirectories } from "../design/recognition-store";
import { repoPathOverlapsDesignRoot } from "../design/path-authority";
import {
  designDirectoriesAtRef,
  prepareDesignSafeIntegration,
  semanticDesignDirectories,
} from "./design-draft-guard";

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
  /** Narrow engine-only authority selector. Design authority commits only an
   * immutable snapshot of its staged lane; Code authority snapshots the
   * complementary staged lane. Neither can absorb concurrent staging from the
   * other. Omission is Code authority so a new caller cannot bypass territory
   * checks accidentally. */
  authority?: "code" | "design";
}

export interface CommitResult {
  sha: string;
  branch: string;
}

/** Commit path arrays are exact repository paths, not Git pathspec programs.
 * Keep this lower-level backstop even though the workspace bridge validates
 * its payload: commit() is also an internal API, and `--` does not disable
 * Git's `:(top)`/glob/exclude expansion. */
function exactCommitPaths(candidates: readonly string[]): string[] {
  return candidates.map((candidate) => {
    const slash = candidate.replace(/\\/g, "/");
    const normalized = path.posix.normalize(slash).replace(/\/+$/, "");
    if (
      !candidate ||
      candidate.includes("\0") ||
      slash.startsWith("/") ||
      /^[A-Za-z]:\//.test(slash) ||
      normalized === "." ||
      normalized === ".." ||
      normalized.startsWith("../")
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "commit files must be exact repository-relative paths",
      });
    }
    return normalized.replace(/^\.\//, "");
  });
}

async function stagedPaths(
  cwd: string,
  env?: Record<string, string | undefined>,
): Promise<string[]> {
  const { stdout } = await runGit(
    cwd,
    [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      // A rename ordinarily reports only its destination in --name-only
      // output. Disable rename detection so moving a protected Design file out
      // of the directory is represented as a protected deletion plus an add.
      "--no-renames",
      "--diff-filter=ACDMRTUXB",
    ],
    { env, readOnly: true },
  );
  return stdout.split("\0").filter(Boolean);
}

async function stagedRenames(
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<Array<{ from: string; to: string }>> {
  const { stdout } = await runGit(
    cwd,
    ["diff", "--cached", "--name-status", "-z", "--find-renames"],
    { env, readOnly: true },
  );
  const fields = stdout.split("\0");
  const renames: Array<{ from: string; to: string }> = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) break;
    const firstPath = fields[index++] ?? "";
    if (status.startsWith("R")) {
      const secondPath = fields[index++] ?? "";
      if (firstPath && secondPath) {
        renames.push({ from: firstPath, to: secondPath });
      }
    }
  }
  return renames;
}

async function currentHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      cwd,
      ["rev-parse", "--verify", "HEAD^{commit}"],
      { readOnly: true },
    );
    return stdout.trim();
  } catch {
    // An initialized repository with no first commit has an unborn HEAD.
    return null;
  }
}

export async function assertGitCheckpointReady(cwd: string): Promise<void> {
  const inProgress = await getInProgressState(cwd);
  if (inProgress) {
    throw new GitError({
      code:
        inProgress === "merge"
          ? "MERGE_IN_PROGRESS"
          : inProgress === "rebase"
            ? "REBASE_IN_PROGRESS"
            : "VALIDATION_FAILED",
      message: `An explicit ${inProgress} continuation is required before creating another checkpoint.`,
      remediation:
        "Resolve the operation with Continue or Abort, then retry the checkpoint.",
    });
  }
  const { stdout: unmerged } = await runGit(
    cwd,
    ["ls-files", "--unmerged", "-z"],
    { readOnly: true },
  );
  if (unmerged.length > 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Unmerged paths must be resolved before creating a checkpoint.",
      remediation:
        "Resolve every conflict through Continue or Abort, then retry.",
    });
  }
}

interface CommitIndexSnapshot {
  directory: string;
  env: { GIT_INDEX_FILE: string };
}

async function createCommitIndexSnapshot(
  cwd: string,
  expectedHead: string | null,
  files?: readonly string[],
): Promise<CommitIndexSnapshot> {
  const directory = await mkdtemp(path.join(tmpdir(), "zeros-commit-index-"));
  const indexFile = path.join(directory, "index");
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    if (files) {
      await runGit(
        cwd,
        expectedHead ? ["read-tree", expectedHead] : ["read-tree", "--empty"],
        { env },
      );
      await runGit(
        cwd,
        [
          "add",
          "-A",
          "--",
          ...files.map((candidate) => `:(literal)${candidate}`),
        ],
        { env },
      );
    } else {
      const { stdout } = await runGit(
        cwd,
        ["rev-parse", "--git-path", "index"],
        { readOnly: true },
      );
      const sourceIndex = path.resolve(cwd, stdout.trim());
      try {
        // Git replaces its index atomically, so copying by pathname captures
        // either the complete prior index or the complete next index. A raw
        // `git add` after this point cannot leak into this commit snapshot.
        await copyFile(sourceIndex, indexFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await runGit(
          cwd,
          expectedHead ? ["read-tree", expectedHead] : ["read-tree", "--empty"],
          { env },
        );
      }
    }
    return { directory, env };
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function resetSnapshotPaths(
  cwd: string,
  snapshot: CommitIndexSnapshot,
  expectedHead: string | null,
  paths: readonly string[],
): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += 100) {
    const batch = paths.slice(offset, offset + 100);
    const literals = batch.map((candidate) => `:(literal)${candidate}`);
    await runGit(
      cwd,
      expectedHead
        ? ["reset", "-q", expectedHead, "--", ...literals]
        : ["update-index", "--force-remove", "--ignore-missing", "--", ...batch],
      { env: snapshot.env },
    );
  }
}

async function changedPathsInCommit(
  cwd: string,
  commitSha: string,
): Promise<string[]> {
  const { stdout } = await runGit(
    cwd,
    [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "--no-renames",
      commitSha,
    ],
    { readOnly: true },
  );
  return stdout.split("\0").filter(Boolean);
}

async function updateHeadFromSnapshot(opts: {
  cwd: string;
  snapshot: CommitIndexSnapshot;
  expectedHead: string | null;
  message: string;
  amend: boolean;
}): Promise<string> {
  const { stdout: treeOut } = await runGit(opts.cwd, ["write-tree"], {
    env: opts.snapshot.env,
  });
  const tree = treeOut.trim();
  let parents: string[] = [];
  if (opts.expectedHead) {
    if (opts.amend) {
      const { stdout } = await runGit(
        opts.cwd,
        ["rev-list", "--parents", "-n", "1", opts.expectedHead],
        { readOnly: true },
      );
      parents = stdout.trim().split(/\s+/).slice(1);
    } else {
      parents = [opts.expectedHead];
    }
  }
  const commitArgs = ["commit-tree", tree];
  for (const parent of parents) commitArgs.push("-p", parent);
  commitArgs.push("-m", opts.message);
  let authorEnv: Record<string, string> = {};
  if (opts.amend && opts.expectedHead) {
    const { stdout } = await runGit(
      opts.cwd,
      ["show", "-s", "--format=%an%x00%ae%x00%aI", opts.expectedHead],
      { readOnly: true },
    );
    const [name, email, date] = stdout.trimEnd().split("\0");
    if (name && email && date) {
      authorEnv = {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: date,
      };
    }
  }
  const { stdout: commitOut } = await runGit(opts.cwd, commitArgs, {
    env: { ...opts.snapshot.env, ...authorEnv },
  });
  const nextHead = commitOut.trim();
  const expected = opts.expectedHead ?? "0".repeat(nextHead.length);
  const reflogSubject = opts.message.split(/\r?\n/, 1)[0]!.slice(0, 200);
  try {
    await runGit(opts.cwd, [
      "update-ref",
      "-m",
      `${opts.amend ? "commit (amend)" : "commit"}: ${reflogSubject}`,
      "HEAD",
      nextHead,
      expected,
    ]);
  } catch (cause) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message:
        "The branch changed while this commit snapshot was being prepared.",
      remediation: "Review the latest branch tip and retry the commit.",
      cause,
    });
  }
  return nextHead;
}

export async function commit(opts: CommitOptions): Promise<CommitResult> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  const authority = opts.authority ?? "code";
  if (!opts.message || opts.message.length === 0) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "commit: 'message' must be a non-empty string",
    });
  }
  const activeDesignDir = getWorkspaceById(opts.workspaceId)
    ? designDirectoryNameFor(ws.path)
    : DEFAULT_DESIGN_DIRECTORY_NAME;
  // An empty array does not add a Git pathspec, so it has exactly the same
  // commit semantics as omission. Normalize it before enforcing authority.
  const files =
    opts.files && opts.files.length > 0
      ? exactCommitPaths(opts.files)
      : undefined;
  if (authority === "design" && files) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "Design commits use the already-staged index and do not accept file paths.",
    });
  }
  if (authority === "design" && opts.amend) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "Design checkpoints cannot be amended implicitly.",
      remediation: "Create a new explicit Design checkpoint instead.",
    });
  }
  await assertGitCheckpointReady(ws.path);
  const expectedHead = await currentHead(ws.path);
  let protectedDesignDirs: string[] = [activeDesignDir];
  if (authority === "code") {
    // Code authority is the complement of EVERY semantic Design root, not only
    // the active canvas. HEAD/index can retain an old root during a rename and
    // a repository may intentionally carry several Design documents. Sticky
    // recognition keeps this final commit backstop aligned with ZSR after an
    // agent or external Git command edits away the repository evidence.
    // Design authority is already exact-root authorized above and deliberately
    // avoids these repository-wide reads on every explicit checkpoint.
    const [discoveredDesignDirs, stickyDesignDirs, pointer] = await Promise.all(
      [
        discoverDesignDirectories(ws.path),
        stickyRecognizedDesignDirectories(ws.path),
        resolveDesignDirectoryPointerState({
          repoRoot: ws.repoRoot,
          workspacePath: ws.path,
        }),
      ],
    );
    protectedDesignDirs = [
      ...new Set([
        activeDesignDir,
        ...(pointer.configured ? [pointer.directory] : []),
        ...discoveredDesignDirs,
        ...stickyDesignDirs,
      ]),
    ];
    const explicitDesignPaths = (files ?? []).filter((candidate) =>
      protectedDesignDirs.some((designDir) =>
        repoPathOverlapsDesignRoot(candidate, designDir),
      ),
    );
    if (explicitDesignPaths.length > 0) {
      const blocked = [...new Set(explicitDesignPaths)];
      throw new GitError({
        code: "VALIDATION_FAILED",
        message:
          blocked.length === 1
            ? `"${blocked[0]}" is inside the Design directory — a code commit cannot include it.`
            : `${blocked.length} staged paths are inside the Design directory — a code commit cannot include them.`,
        remediation:
          "Unstage those paths, then stage and commit them with the dedicated Design actions.",
        context: { workspaceId: opts.workspaceId },
      });
    }
    if (opts.amend && expectedHead) {
      const previousDesignPaths = (
        await changedPathsInCommit(ws.path, expectedHead)
      ).filter((candidate) =>
        protectedDesignDirs.some((designDir) =>
          repoPathOverlapsDesignRoot(candidate, designDir),
        ),
      );
      if (previousDesignPaths.length > 0) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message:
            "Code changes cannot amend a Design checkpoint or mixed Design commit.",
          remediation:
            "Create a new Code commit so Code and Design history remain separate.",
          context: { workspaceId: opts.workspaceId },
        });
      }
    }
  }
  const snapshot = await createCommitIndexSnapshot(
    ws.path,
    expectedHead,
    files,
  );
  let sha: string;
  try {
    const unmerged = await runGit(ws.path, ["ls-files", "--unmerged", "-z"], {
      env: snapshot.env,
      readOnly: true,
    });
    if (unmerged.stdout.length > 0) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "Unmerged paths must be resolved through Continue or Abort.",
        remediation:
          "Resolve every conflict, then continue the active Git operation.",
      });
    }
    const capturedStaged = await stagedPaths(ws.path, snapshot.env);
    const belongsToSelectedLane = (candidate: string): boolean =>
      authority === "design"
        ? repoPathOverlapsDesignRoot(candidate, activeDesignDir)
        : !protectedDesignDirs.some((designDir) =>
            repoPathOverlapsDesignRoot(candidate, designDir),
          );
    const crossingRename = (await stagedRenames(ws.path, snapshot.env)).find(
      ({ from, to }) =>
        belongsToSelectedLane(from) !== belongsToSelectedLane(to),
    );
    if (crossingRename) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: `A staged rename crosses the Code/Design boundary: "${crossingRename.from}" → "${crossingRename.to}".`,
        remediation:
          "Keep Design files inside the Design directory, then stage and commit Code and Design separately.",
        context: { workspaceId: opts.workspaceId },
      });
    }
    const selected = capturedStaged.filter((candidate) =>
      belongsToSelectedLane(candidate),
    );
    const selectedSet = new Set(selected);
    const excluded = capturedStaged.filter(
      (candidate) => !selectedSet.has(candidate),
    );
    if (selected.length === 0) {
      const otherLane = excluded.length > 0;
      throw new GitError({
        code: "VALIDATION_FAILED",
        message:
          authority === "design"
            ? "Nothing to commit — no Design changes are staged."
            : otherLane
              ? "Nothing to commit — only Design changes are staged."
              : "Nothing to commit — no Code changes are staged.",
        remediation:
          authority === "design" || otherLane
            ? "Stage and commit Design changes with the dedicated Design actions."
            : "Stage Code paths first, or pass exact Code files.",
      });
    }
    await resetSnapshotPaths(ws.path, snapshot, expectedHead, excluded);
    sha = await updateHeadFromSnapshot({
      cwd: ws.path,
      snapshot,
      expectedHead,
      message: opts.message,
      amend: opts.amend === true,
    });
  } finally {
    await rm(snapshot.directory, { recursive: true, force: true }).catch(
      () => {},
    );
  }
  // Design commits deliberately end here without discovering every other
  // Design document. Authority was proven against the active root and no
  // Code-side sparse/checkpoint bookkeeping exists.
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

async function checkedOutBranch(
  cwd: string,
  operation: "push" | "pull",
): Promise<string> {
  const { stdout } = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], {
    readOnly: true,
  });
  const branch = stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Cannot ${operation} while this workspace has a detached HEAD.`,
      remediation: "Check out a branch, then retry.",
    });
  }
  return branch;
}

export async function push(opts: PushOptions): Promise<PushResult> {
  const ws = await resolveRepoForGitOp(opts.workspaceId);
  // Native Code tools may run `git checkout` directly. Resolve HEAD at the
  // mutation boundary instead of trusting the workspace row's last-known
  // branch, otherwise a push can publish a different branch than the one the
  // user is looking at.
  const branch = await checkedOutBranch(ws.path, "push");
  // No explicit remote → the repo's configured `git.remote` (default origin),
  // so push honors the same "Remote origin" setting as create/fetch/PR.
  const remote = opts.remote ?? resolveRepoGit(ws.repoRoot).remote;
  assertSafeGitRef(remote, "push.remote");
  const args = ["push"];
  if (opts.setUpstream !== false) args.push("-u");
  if (opts.force) args.push("--force-with-lease");
  args.push(remote, branch);
  await runGit(ws.path, args, {
    // Bound the renderer request even if a remote transport wedges.
    timeoutMs: 60_000,
    mapErrorCode: (stderr) =>
      classifyGitTransportError(stderr) ?? "GIT_COMMAND_FAILED",
  });
  const ahead = await aheadBehind(ws.path, `${remote}/${branch}`, branch);
  return { remoteRef: `${remote}/${branch}`, ...ahead };
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
  const branch = await checkedOutBranch(ws.path, "pull");
  const expectedHead = await currentHead(ws.path);
  // Same setting-aware default as push.
  const remote = opts.remote ?? resolveRepoGit(ws.repoRoot).remote;
  assertSafeGitRef(remote, "pull.remote");
  // Pin the network result first. Fetch mutates refs only, so it cannot
  // overwrite a live Design draft. The preflight below then decides whether
  // integrating this exact FETCH_HEAD is safe before any checkout rewrite.
  await runGit(ws.path, ["fetch", "--no-tags", remote, branch], {
    timeoutMs: 60_000,
    mapErrorCode: (stderr) =>
      classifyGitTransportError(stderr) ?? "GIT_COMMAND_FAILED",
  });
  const [headAfterFetch, branchAfterFetch] = await Promise.all([
    currentHead(ws.path),
    checkedOutBranch(ws.path, "pull"),
  ]);
  if (headAfterFetch !== expectedHead || branchAfterFetch !== branch) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: "The checked-out branch changed while pull was fetching.",
      remediation: "Review the current branch tip and retry the pull.",
    });
  }
  const fetchedHead = await prepareDesignSafeIntegration({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
    target: "FETCH_HEAD",
    operation: "Pull",
    comparison: opts.strategy === "rebase" ? "rebase" : "merge-side",
    rejectAnyDirtyDesign: opts.autoStash === true,
  });
  const { stdout: incomingCount } = await runGit(
    ws.path,
    ["rev-list", "--count", `HEAD..${fetchedHead}`],
    { readOnly: true },
  );
  const beforeBehind = Number.parseInt(incomingCount.trim(), 10) || 0;
  const args =
    opts.strategy === "rebase"
      ? ["rebase", ...(opts.autoStash ? ["--autostash"] : []), fetchedHead]
      : [
          ...NO_EDITOR,
          "merge",
          ...(opts.autoStash ? ["--autostash"] : []),
          fetchedHead,
        ];
  const result = await runGit(ws.path, args, {
    treatAsExpected: ["conflict", "nothing-to-do"] as ExpectedCategory[],
  });
  if (result.expectedError === "conflict") {
    return {
      applied: 0,
      conflicts: await listConflictedPaths(ws.path),
    };
  }
  return { applied: beforeBehind, conflicts: [] };
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
  const ontoCommit = await prepareDesignSafeIntegration({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
    target: opts.ontoBranch,
    operation: "Rebase",
    comparison: "rebase",
    rejectAnyDirtyDesign: opts.autoStash === true,
  });
  const args = ["rebase"];
  if (opts.autoStash) args.push("--autostash");
  args.push(ontoCommit);
  // How many commits we have AHEAD of the target branch — that's the
  // number we'll replay.
  const before = await aheadBehind(ws.path, ontoCommit, "HEAD");
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
  const designDirectories = await semanticDesignDirectories({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
  });
  // A generic stash is a Code-lane operation. Positive `.` selects the whole
  // checkout, then literal exclusions subtract every semantic Design root so
  // staged, unstaged, and untracked draft work remains live.
  args.push(
    "--",
    ".",
    ...designDirectories.map(
      (candidate) => `:(top,exclude,literal)${candidate}`,
    ),
  );
  // Serialize push + `rev-parse stash@{0}` per repository so a concurrent stash
  // op on another worktree of the SAME repo can't shift the stack between them
  // (which would resolve the WRONG stash SHA → wrong restore later).
  return withStashLock(ws.repoRoot, async () => {
    const before = await currentStashTip(ws.path);
    await runGit(ws.path, args);
    // `stash@{0}` is the freshest stash; resolve to a SHA so the caller has a
    // stable handle even if more stashes pile up.
    const { stdout } = await runGit(ws.path, ["rev-parse", "stash@{0}"]);
    const stashRef = stdout.trim();
    if (stashRef === before) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "There are no Code changes to stash.",
        remediation:
          "Design work remains live; use the explicit Design stage and commit actions for that draft.",
      });
    }
    return { stashRef };
  });
}

async function currentStashTip(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(
      cwd,
      ["rev-parse", "--verify", "refs/stash^{commit}"],
      { readOnly: true },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function assertCodeOnlyStash(opts: {
  workspaceId: string;
  path: string;
  repoRoot: string;
  stashCommit: string;
  operation: string;
}): Promise<void> {
  const [localDirectories, stashDirectories] = await Promise.all([
    semanticDesignDirectories(opts),
    designDirectoriesAtRef(opts.path, opts.stashCommit),
  ]);
  const protectedDirectories = [
    ...new Set([...localDirectories, ...stashDirectories]),
  ];
  const { stdout: trackedOut } = await runGit(
    opts.path,
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      `${opts.stashCommit}^1`,
      opts.stashCommit,
    ],
    { readOnly: true },
  );
  let untrackedOut = "";
  try {
    ({ stdout: untrackedOut } = await runGit(
      opts.path,
      ["ls-tree", "-r", "--name-only", "-z", `${opts.stashCommit}^3`],
      { readOnly: true },
    ));
  } catch {
    // A stash without --include-untracked has no third parent.
  }
  const designPaths = [...trackedOut.split("\0"), ...untrackedOut.split("\0")]
    .filter(Boolean)
    .filter((candidate) =>
      protectedDirectories.some((designDir) =>
        repoPathOverlapsDesignRoot(candidate, designDir),
      ),
    );
  if (designPaths.length === 0) return;
  throw new GitError({
    code: "VALIDATION_FAILED",
    message: `${opts.operation} is a Code action, but that stash contains Design changes.`,
    remediation:
      "Apply this stash with an external Git tool only after explicitly reconciling its Design changes, or use a Code-only stash.",
    context: {
      workspaceId: opts.workspaceId,
      designPaths: [...new Set(designPaths)].slice(0, 20),
    },
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
  return withStashLock(ws.repoRoot, async () => {
    const { stdout: stableOut } = await runGit(
      ws.path,
      ["rev-parse", "--verify", `${opts.stashRef}^{commit}`],
      { readOnly: true },
    );
    const stableRef = stableOut.trim();
    await assertCodeOnlyStash({
      workspaceId: opts.workspaceId,
      path: ws.path,
      repoRoot: ws.repoRoot,
      stashCommit: stableRef,
      operation: "Stash pop",
    });
    const list = await runGit(ws.path, ["stash", "list", "--format=%H"]);
    const lines = list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const idx = lines.indexOf(stableRef);

    const applyArgs =
      idx >= 0
        ? ["stash", "pop", `stash@{${idx}}`]
        : ["stash", "apply", stableRef];

    const result = await runGit(ws.path, applyArgs, {
      treatAsExpected: ["conflict"] as ExpectedCategory[],
      mapErrorCode: () => "STASH_FAILED",
    });
    if (result.expectedError === "conflict") {
      return { conflicts: await listConflictedPaths(ws.path) };
    }
    return { conflicts: [] };
  });
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
  const target = await prepareDesignSafeIntegration({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
    target: opts.branch,
    operation: "Merge",
    comparison: "merge-side",
  });
  const args = [...NO_EDITOR, "merge"];
  if (opts.noFF) args.push("--no-ff");
  args.push(target);
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
  const target = await prepareDesignSafeIntegration({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
    target: opts.sha,
    operation: "Cherry-pick",
    comparison: "single-commit-apply",
  });
  const result = await runGit(ws.path, [...NO_EDITOR, "cherry-pick", target], {
    treatAsExpected: ["conflict"] as ExpectedCategory[],
  });
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
  const target = await prepareDesignSafeIntegration({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
    target: opts.sha,
    operation: "Revert",
    comparison: "single-commit-revert",
  });
  const result = await runGit(ws.path, [...NO_EDITOR, "revert", target], {
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
  return withStashLock(ws.repoRoot, async () => {
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
  });
}

export async function applyStash(opts: {
  workspaceId: string;
  stashRef: string;
}): Promise<{ conflicts: string[] }> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.stashRef, "applyStash.stashRef"); // (Low) parity with stashPop
  return withStashLock(ws.repoRoot, async () => {
    const { stdout } = await runGit(
      ws.path,
      ["rev-parse", "--verify", `${opts.stashRef}^{commit}`],
      { readOnly: true },
    );
    const stableRef = stdout.trim();
    await assertCodeOnlyStash({
      workspaceId: opts.workspaceId,
      path: ws.path,
      repoRoot: ws.repoRoot,
      stashCommit: stableRef,
      operation: "Stash apply",
    });
    const result = await runGit(ws.path, ["stash", "apply", stableRef], {
      treatAsExpected: ["conflict"] as ExpectedCategory[],
      mapErrorCode: () => "STASH_FAILED",
    });
    if (result.expectedError === "conflict") {
      return { conflicts: await listConflictedPaths(ws.path) };
    }
    return { conflicts: [] };
  });
}

export async function dropStash(opts: {
  workspaceId: string;
  stashRef: string;
}): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  assertSafeGitRef(opts.stashRef, "dropStash.stashRef");
  await withStashLock(ws.repoRoot, async () => {
    // `git stash drop` only accepts stash@{N}; keep resolution and mutation in
    // one repository-global lane so another worktree cannot shift the stack.
    let ref = opts.stashRef;
    if (!/^stash@\{/.test(ref)) {
      const { stdout } = await runGit(ws.path, [
        "stash",
        "list",
        "--format=%H",
      ]);
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
