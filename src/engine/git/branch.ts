// Branch operations. Reads via isomorphic-git (fast, no subprocess);
// writes via shell git (battle-tested).
//
// Note on linked-worktree gitdir: every isomorphic-git call passes
// `gitdir: await resolveGitdir(worktreePath)` — without this, reads
// against a worktree silently throw "could not find HEAD" because
// `.git` is a file pointing into `<root>/.git/worktrees/<name>/`.

import * as git from "isomorphic-git";
import nodeFs from "node:fs";
import path from "node:path";
import { allocateWorkspaceBranch, getWorkspace } from "./worktree";
import { assertSafeGitRef, runGit } from "./git-exec";
import { resolveRepoGit } from "../settings/repo-git";
import { GitError } from "./errors";
import { isValidBranchName } from "./naming";
import { updateWorkspace } from "./state";
import type { Branch } from "./types";

// isomorphic-git fs handle. Same recipe as diff.ts — pass the main
// repo's .git directly so the shared ref store resolves cleanly.
const fs = nodeFs;

/** List branches in the workspace's repo. Single-worktree scope —
 *  cross-tool worktree detection lives in cross-tool.ts (Phase 5).
 *
 *  For each branch we emit: name, tip SHA, last commit date, and
 *  whether it's currently checked out in the requested workspace's
 *  worktree (a coarse approximation — full cross-worktree analysis is
 *  Phase 5). */
export async function listBranches(workspaceId: string): Promise<Branch[]> {
  const ws = getWorkspace(workspaceId);
  const gitdir = path.join(ws.repoRoot, ".git");
  // The workspace's own branch is the "currently checked out" one for
  // its worktree — we don't ask isomorphic-git for that because the
  // common gitdir's HEAD reflects the main repo's HEAD, not ours.
  const names = await git.listBranches({ fs, gitdir });
  const out: Branch[] = [];
  for (const name of names) {
    try {
      const oid = await git.resolveRef({ fs, gitdir, ref: name });
      const commit = await git.readCommit({ fs, gitdir, oid });
      out.push({
        name,
        tipSha: oid,
        isCheckedOut: name === ws.branch,
        worktreePath: name === ws.branch ? ws.path : null,
        origin: "zeros",
        lastCommitDate: commit.commit.author.timestamp * 1000,
        prUrl: null,
      });
    } catch {
      // Corrupted ref — skip; don't fail the whole list.
    }
  }
  // Newest commits first.
  out.sort((a, b) => b.lastCommitDate - a.lastCommitDate);
  return out;
}

/** List the repo's REMOTE branches (`refs/remotes/<remote>/*`, where <remote>
 *  is the settings-effective `git.remote`, default "origin") as merge/PR
 *  targets. A PR merges on the remote (GitHub), so the base branch must exist
 *  there — the target-branch picker therefore offers remote branches, never
 *  local-only ones.
 *
 *  Names are returned WITHOUT the "<remote>/" prefix so they match how
 *  `baseBranch` is persisted (a PLAIN name — see resolveBaseRef in diff.ts) and
 *  stay comparable with `workspace.baseBranch`. This reads the local
 *  remote-tracking refs only (no network round-trip), so the list reflects the
 *  last `git fetch` — same trade-off as the rest of the instant popover. */
export async function listRemoteBranches(
  workspaceId: string,
): Promise<Branch[]> {
  const ws = getWorkspace(workspaceId);
  // Settings-sourced (a paired device can write `git.remote`) — guard before
  // it reaches git inside a ref pattern. Same treatment as repoHasRemote.
  const { remote } = resolveRepoGit(ws.repoRoot);
  assertSafeGitRef(remote, "listRemoteBranches.remote");
  // for-each-ref (subprocess) rather than isomorphic-git: it yields the tip SHA
  // + commit date in one pass and never hits the network. Mirrors listAllBranches.
  const { stdout } = await runGit(ws.repoRoot, [
    "for-each-ref",
    "--format=%(refname:short)|%(objectname)|%(committerdate:unix)",
    `refs/remotes/${remote}/`,
  ]);
  const prefix = `${remote}/`;
  const out: Branch[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [shortRef, tipSha, commitDateStr] = line.split("|");
    // "origin/main" → "main"; skip the bare remote / "<remote>/HEAD" symref.
    if (!shortRef.startsWith(prefix)) continue;
    const name = shortRef.slice(prefix.length);
    if (!name || name === "HEAD") continue;
    out.push({
      name,
      tipSha,
      isCheckedOut: name === ws.branch,
      worktreePath: null,
      origin: "zeros",
      lastCommitDate: (parseInt(commitDateStr, 10) || 0) * 1000,
      prUrl: null,
    });
  }
  // Newest commits first.
  out.sort((a, b) => b.lastCommitDate - a.lastCommitDate);
  return out;
}

export interface RenameBranchOptions {
  workspaceId: string;
  newName: string;
}

/** Rename the workspace's current branch. Updates the DB row to keep
 *  the workspaces table in sync with the on-disk ref.
 *
 *  We validate `newName` against the same strict regex used for
 *  agent-proposed renames — keeps the surface uniform whether the
 *  rename came from a UI form or from the background-rename hook. */
export async function renameBranch(opts: RenameBranchOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  if (!opts.newName || typeof opts.newName !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "renameBranch: 'newName' must be a non-empty string",
    });
  }
  // Strip a "zeros/" prefix if the caller included one — the validator
  // only allows the unprefixed slug, and we prepend zeros/ ourselves.
  const slug = opts.newName.startsWith("zeros/")
    ? opts.newName.slice("zeros/".length)
    : opts.newName;
  if (!isValidBranchName(slug)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Branch name "${opts.newName}" does not pass validation`,
      remediation:
        "Use 3-49 characters: letters, digits, and hyphens. Must start with a letter.",
    });
  }
  const target = opts.newName.startsWith("zeros/")
    ? opts.newName
    : `zeros/${slug}`;
  if (target === ws.branch) {
    return; // No-op rename.
  }
  await runGit(ws.path, ["branch", "-m", target]);
  updateWorkspace(opts.workspaceId, { branch: target });
}

export interface CheckoutBranchOptions {
  workspaceId: string;
  branchName: string;
  /** If true, creates the branch from the current HEAD when it doesn't
   *  exist. If false and the branch doesn't exist, throws. */
  createIfMissing?: boolean;
}

/** Check out a different branch within the workspace's worktree.
 *  Updates the DB to reflect the new branch. */
export async function checkoutBranch(
  opts: CheckoutBranchOptions,
): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  // Guard the branch name against flag injection (`git checkout` reads the
  // ref as a bare positional; "--" would mark it a pathspec, not a branch).
  assertSafeGitRef(opts.branchName, "checkout.branchName");
  const args = ["checkout"];
  if (opts.createIfMissing) args.push("-B");
  args.push(opts.branchName);
  await runGit(ws.path, args, {
    mapErrorCode: (stderr) => {
      if (/already used by worktree|is already checked out/i.test(stderr)) {
        return "BRANCH_IN_USE";
      }
      if (/pathspec .* did not match/i.test(stderr)) {
        return "VALIDATION_FAILED";
      }
      return "GIT_COMMAND_FAILED";
    },
  });
  updateWorkspace(opts.workspaceId, { branch: opts.branchName });
}

export interface CreateBranchFromOptions {
  workspaceId: string;
  sourceBranch: string;
  newBranchName: string;
}

/** Create a new branch from `sourceBranch` *without* checking it out.
 *  Useful for "create derivative branch" flow when another worktree
 *  holds the source branch — see BRANCH_IN_USE remediation. */
export async function createBranchFrom(
  opts: CreateBranchFromOptions,
): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  if (!opts.sourceBranch || !opts.newBranchName) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message:
        "createBranchFrom: both 'sourceBranch' and 'newBranchName' are required",
    });
  }
  assertSafeGitRef(opts.newBranchName, "createBranchFrom.newBranchName");
  assertSafeGitRef(opts.sourceBranch, "createBranchFrom.sourceBranch");
  await runGit(ws.path, ["branch", opts.newBranchName, opts.sourceBranch]);
}

export interface ContinueOnNewBranchOptions {
  workspaceId: string;
  /** Live PR target branch; falls back to the workspace metadata. */
  baseBranch?: string;
  /** GitHub's exact merge commit, used when the target cannot be fetched. */
  mergedSha?: string;
}

/** "Continue" after a merged PR (2026-07-19, PR-island): start the NEXT unit
 *  of work in the SAME worktree. Creates + checks out a fresh generated branch
 *  from the latest target branch, keeps chats and compatible uncommitted work,
 *  and resets the workspace row to a PR-less, in-progress state — the PR row then
 *  renders in Create-PR mode again. The old branch ref is left in place (its
 *  PR history stays reachable). */
export async function continueOnNewBranch(
  opts: ContinueOnNewBranchOptions,
): Promise<{ branch: string }> {
  const ws = getWorkspace(opts.workspaceId);
  const { remote } = resolveRepoGit(ws.repoRoot);
  const baseBranch = opts.baseBranch ?? ws.baseBranch;
  assertSafeGitRef(remote, "continueOnNewBranch.remote");
  assertSafeGitRef(baseBranch, "continueOnNewBranch.baseBranch");
  if (baseBranch === ws.branch) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "The workspace target branch cannot be its current branch",
      remediation: "Choose the repository's merge target before continuing.",
    });
  }
  if (opts.mergedSha && !/^[0-9a-f]{40}$/i.test(opts.mergedSha)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "continueOnNewBranch.mergedSha must be a full commit SHA",
    });
  }

  // Prefer the live target: a squash merge creates a sibling of the old
  // feature HEAD, so branching at that HEAD would make the next PR repeat the
  // previous PR. FETCH_HEAD is exact even when the caller's remote-tracking ref
  // was stale. Network failure is non-fatal; the exact merge SHA or an existing
  // target ref are safe offline fallbacks, but current HEAD is never one.
  let startRef: string | null = null;
  try {
    await runGit(ws.path, ["fetch", "--no-tags", remote, baseBranch], {
      timeoutMs: 8_000,
    });
    startRef = "FETCH_HEAD";
  } catch {
    const candidates = [
      opts.mergedSha,
      `${remote}/${baseBranch}`,
      baseBranch,
    ].filter((candidate): candidate is string => !!candidate);
    for (const candidate of candidates) {
      try {
        await runGit(ws.path, [
          "rev-parse",
          "--verify",
          "--quiet",
          `${candidate}^{commit}`,
        ]);
        startRef = candidate;
        break;
      } catch {
        /* try the next target-derived fallback */
      }
    }
  }
  if (!startRef) {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: `Could not resolve target branch ${remote}/${baseBranch}`,
      remediation:
        "Reconnect to the remote, fetch the target branch, and retry.",
    });
  }

  // Allocated against the repo's used-set, not generated blind. Until
  // 2026-07-29 this called generateBranchName() and leaned entirely on the
  // 4-hex tail for uniqueness ("if the impossible happens git fails loudly").
  // Colour names have no tail, so an unchecked pick here would collide with an
  // existing workspace as soon as the dictionary got crowded.
  const branch = await allocateWorkspaceBranch(ws.repoRoot, ws.repoSlug);
  // `checkout -b` (not -B): never reset an existing branch. The allocator can
  // still lose a race with a concurrent create, and -b makes git refuse rather
  // than silently move someone else's ref. Git carries compatible index/
  // worktree changes across the switch and aborts before switching if target
  // changes would overwrite them.
  await runGit(ws.path, ["checkout", "-b", branch, startRef]);
  updateWorkspace(opts.workspaceId, {
    branch,
    prNumber: null,
    prState: null,
    prUrl: null,
    // A fresh unit of work: direct write (not advanceLifecycle) because the
    // merged workspace is typically already "done", which the auto-advance
    // guard would preserve.
    status: "in-progress",
  });
  return { branch };
}

export interface DeleteBranchOptions {
  workspaceId: string;
  branchName: string;
  /** Force-delete an unmerged branch (`-D` vs `-d`). */
  force?: boolean;
}

/** Delete a local branch (standalone — not tied to workspace deletion).
 *  Refuses to delete the branch currently checked out in this worktree. */
export async function deleteBranch(opts: DeleteBranchOptions): Promise<void> {
  const ws = getWorkspace(opts.workspaceId);
  if (!opts.branchName) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "deleteBranch: 'branchName' is required",
    });
  }
  assertSafeGitRef(opts.branchName, "deleteBranch.branchName"); // (Low) option-injection guard
  if (opts.branchName === ws.branch) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Cannot delete "${opts.branchName}" — it is checked out in this worktree`,
    });
  }
  await runGit(ws.path, ["branch", opts.force ? "-D" : "-d", opts.branchName], {
    mapErrorCode: (stderr) =>
      /not fully merged/i.test(stderr)
        ? "VALIDATION_FAILED"
        : "GIT_COMMAND_FAILED",
  });
}
