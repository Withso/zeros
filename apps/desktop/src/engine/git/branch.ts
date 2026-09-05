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
import { branchDisplayName, isValidBranchName } from "./naming";
import { updateWorkspace } from "./state";
import type { Branch } from "./types";
import { refExists } from "./default-branch";
import { prepareDesignSafeIntegration } from "./design-draft-guard";

// isomorphic-git fs handle. Same recipe as diff.ts — pass the main
// repo's .git directly so the shared ref store resolves cleanly.
const fs = nodeFs;

/** List branches in the workspace's repository. Cross-tool worktree detection
 *  lives in cross-tool.ts.
 *
 *  For each branch we emit: name, tip SHA, last commit date, and
 *  whether it's currently checked out in the requested workspace's
 *  worktree. This local result deliberately does not infer checkout state for
 *  unrelated worktrees. */
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

/** The namespace a workspace's branch currently sits under — separator
 *  included, so a rename can move it WITHIN that namespace — or `""` when the
 *  branch has none.
 *
 *  Everything up to the LAST `/`, deliberately not branchDisplayName's
 *  boundary. branchDisplayName only concedes a prefix when the tail is
 *  allocator-shaped, which is right for labelling (a user's `feature/plain`
 *  keeps its namespace as identity) but wrong here for two reasons:
 *
 *    • a branch renamed ONCE no longer has a colour-shaped tail, so a SECOND
 *      rename of `jordan/add-canvas-zoom` found no prefix and silently
 *      published a bare `login-fix`;
 *    • an adopted `cursor/foo` lost its namespace on its first rename, for the
 *      same reason.
 *
 *  Renaming is a different question from labelling: whatever the tail looks
 *  like, `<namespace>/<name>` is the shape of the ref and a rename replaces
 *  only `<name>`.
 *
 *  A branch with no slash simply has no namespace, and this returns `""`.
 *
 *  It briefly consulted the SETTING instead, to recover a prefix from a branch
 *  where the string carries no boundary. That was wrong twice over. The shape
 *  it was written for (`myname-Cream`, from a custom prefix spliced in
 *  verbatim) has never existed in a shipped build — the released allocator only
 *  ever emitted `zeros/<Colour>` — and the `startsWith` test it used matches
 *  any coincidence: with the DEFAULT setting, an adopted branch named
 *  `zeros-experiment` starts with `zeros`, so renaming it produced the
 *  run-together `zerosadd-canvas-zoom`. A namespace is a slash-delimited thing;
 *  guessing one from a substring match creates refs nobody asked for. */
function resolveExistingBranchPrefix(ws: { branch: string }): string {
  const cut = ws.branch.lastIndexOf("/");
  return cut === -1 ? "" : ws.branch.slice(0, cut + 1);
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
 *  rename came from a UI form or from the background-rename hook.
 *
 *  Returns the RESULTING branch (unchanged on a no-op). Callers must not
 *  reconstruct it: the prefix comes from the workspace's existing branch, so
 *  `newName` alone doesn't determine the answer — and the renderer's inline
 *  rename box guessed `zeros/<name>` for years, which was wrong for every
 *  workspace on any other prefix. */
export async function renameBranch(opts: RenameBranchOptions): Promise<string> {
  const ws = getWorkspace(opts.workspaceId);
  if (!opts.newName || typeof opts.newName !== "string") {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "renameBranch: 'newName' must be a non-empty string",
    });
  }
  // The prefix ALWAYS comes from the existing branch — never from `newName`,
  // even when the caller supplied a prefixed ref. `newName` is untrusted (the
  // inline rename box, and `git.renameBranch` is remote-reachable) and lands as
  // a `git branch -m` argument. Honouring a caller-supplied prefix let
  // `--force/Login` through: branchDisplayName strips any TitleCase-tailed
  // prefix, so the slug validated clean as `Login` while the raw string was
  // passed to git. Rebuilding the ref from a validated slug plus the
  // workspace's own prefix means no caller-controlled substring survives.
  //
  // Re-prefixing with THIS workspace's prefix rather than the global default is
  // the other half: a rename moves a branch, it does not re-home it. Renaming
  // `jordan/Cream` used to hand back `zeros/add-canvas-zoom`, silently dropping
  // the user's configured namespace. Derived from the existing branch, so it
  // stays correct even if the setting changed since the workspace was created.
  const currentPrefix = resolveExistingBranchPrefix(ws);
  // The caller may pass either the bare slug or an already-prefixed ref, and
  // the validator only accepts the bare slug — so peel first. This workspace's
  // OWN prefix leads: branchDisplayName recognises a prefix only when the tail
  // is allocator-shaped, so a caller echoing back a ref this function itself
  // produced (`jordan/add-canvas-zoom` — already renamed once, so no longer a
  // colour name) failed validation on the slash it had just been handed. Note
  // this widens what parses, not what is trusted: whatever is peeled here is
  // discarded, and `target` below is rebuilt from `currentPrefix`.
  const slug =
    currentPrefix && opts.newName.startsWith(currentPrefix)
      ? opts.newName.slice(currentPrefix.length)
      : branchDisplayName(opts.newName);
  if (!isValidBranchName(slug)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `Branch name "${opts.newName}" does not pass validation`,
      remediation:
        "Use 3-49 characters: letters, digits, and hyphens. Must start with a letter.",
    });
  }
  const target = `${currentPrefix}${slug}`;
  // Defence in depth for the prefix half (the slug half is isValidBranchName'd
  // above): it came from an existing row, but a row can be written by a paired
  // device. createOwnedBranch guards its own refs the same way.
  assertSafeGitRef(target, "renameBranch.target");
  if (target === ws.branch) {
    return target; // No-op rename.
  }
  await runGit(ws.path, ["branch", "-m", target]);
  updateWorkspace(opts.workspaceId, { branch: target });
  return target;
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
  const localBranchExists = await refExists(
    ws.path,
    `refs/heads/${opts.branchName}`,
  );
  let expectedTarget: string | null = null;
  if (localBranchExists || !opts.createIfMissing) {
    expectedTarget = await prepareDesignSafeIntegration({
      workspaceId: opts.workspaceId,
      path: ws.path,
      repoRoot: ws.repoRoot,
      target: opts.branchName,
      operation: "Checkout",
      comparison: "tree-transition",
    });
    const { stdout } = await runGit(
      ws.path,
      ["rev-parse", "--verify", `${opts.branchName}^{commit}`],
      { readOnly: true },
    );
    if (stdout.trim() !== expectedTarget) {
      throw new GitError({
        code: "GIT_COMMAND_FAILED",
        message: `Branch ${opts.branchName} changed while checkout was being prepared.`,
        remediation: "Review the latest branch tip and retry checkout.",
      });
    }
  }
  const args = localBranchExists
    ? ["checkout", opts.branchName]
    : opts.createIfMissing
      ? ["checkout", "-b", opts.branchName]
      : ["checkout", opts.branchName];
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
  const { stdout: checkedOut } = await runGit(
    ws.path,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { readOnly: true },
  );
  const branch = checkedOut.trim();
  if (!branch || branch === "HEAD") {
    throw new GitError({
      code: "GIT_COMMAND_FAILED",
      message: "Checkout did not leave the workspace on a local branch.",
      remediation: "Check out a local branch and retry.",
    });
  }
  updateWorkspace(opts.workspaceId, { branch });
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
  const startCommit = await prepareDesignSafeIntegration({
    workspaceId: opts.workspaceId,
    path: ws.path,
    repoRoot: ws.repoRoot,
    target: startRef,
    operation: "Continue on a new branch",
    comparison: "tree-transition",
  });

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
  await runGit(ws.path, ["checkout", "-b", branch, startCommit]);
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
