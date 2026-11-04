// ──────────────────────────────────────────────────────────
// Repo branch catalog — data for the repo page's Git dropdowns
// ──────────────────────────────────────────────────────────
//
// One repoRoot-scoped read that gathers everything the "Branch new workspaces
// from" and "Remote origin" pickers need: the repo's remotes (with a
// GitHub-or-not verdict per URL), the settings-effective remote + base branch,
// and the branch list a new workspace could fork from — remote-tracking refs
// of the chosen remote when it exists, local branches otherwise (a repo with
// no remote still gets a working picker).
//
// No workspaceId: the repo page runs before any workspace exists. Listing
// reads local refs only (instant, offline-safe); pass `fetch: true` to run a
// bounded best-effort `git fetch` first so the list reflects the live remote
// (the UI calls once without fetch for an instant paint, then once with fetch
// to freshen).
// ──────────────────────────────────────────────────────────

import { GitError } from "./errors";
import { parseGitRemotes, parseGitCatalogRefs } from "@zeros/protocol/git-review-actions";
import { assertSafeGitRef, runGit } from "./git-exec";
import { isRepo } from "./repo";
import { parseGitHubRemote } from "./github";
import { resolveRepoGit } from "../settings/repo-git";
import {
  detectRemoteDefaultBranch,
  fetchRemote,
} from "./default-branch";

export interface RepoRemote {
  /** Remote name, e.g. "origin", "upstream". */
  name: string;
  /** Fetch URL. */
  url: string;
  /** True when the URL parses as a github.com remote. */
  isGitHub: boolean;
}

export interface CatalogBranch {
  /** Plain branch name (no remote prefix), e.g. "main". */
  name: string;
  /** Last commit time (ms epoch), 0 when unknown. */
  lastCommitDate: number;
}

export interface RepoBranchCatalog {
  /** All git remotes configured on the repo (fetch URLs). */
  remotes: RepoRemote[];
  /** The settings-effective `git.remote` (default "origin") — what push /
   *  pull / PR / new-workspace fetch will use. */
  effectiveRemote: string;
  /** True when the listed remote (the override or the effective one) is
   *  actually configured on the repo — even if its remote-tracking namespace
   *  is still empty (never fetched). */
  remoteExists: boolean;
  /** True when `git.base_branch` is set by a real settings layer (an explicit
   *  pick) rather than auto-detected. */
  baseExplicit: boolean;
  /** The branch a new workspace would fork from right now: the explicit
   *  setting when present, else the detected remote default, else "main". */
  effectiveBase: string;
  /** The remote's default branch (its HEAD), when detectable. */
  detectedDefault: string | null;
  /** Which remote `branches` were listed from, or null when the repo has no
   *  such remote and `branches` holds LOCAL branches instead. */
  listedRemote: string | null;
  /** Where `branches` came from: the remote's remote-tracking refs, or the
   *  repo's local branches (no usable remote). */
  branchSource: "remote" | "local";
  branches: CatalogBranch[];
}

export interface RepoBranchCatalogOptions {
  repoRoot: string;
  /** List branches of THIS remote instead of the settings-effective one (the
   *  UI previews a not-yet-saved remote pick). */
  remote?: string;
  /** Run a bounded best-effort `git fetch <remote>` before listing so the
   *  remote-tracking refs reflect the live remote. Non-fatal when offline. */
  fetch?: boolean;
}

async function listRemotes(repoRoot: string): Promise<RepoRemote[]> {
  const { stdout } = await runGit(repoRoot, ["remote", "-v"]);
  return parseGitRemotes(stdout, url => {
    try { parseGitHubRemote(url); return true; } catch { return false; }
  });
}

async function listRefs(repoRoot: string, refPrefix: string): Promise<CatalogBranch[]> {
  const { stdout } = await runGit(repoRoot, ["for-each-ref", "--format=%(refname)|%(committerdate:unix)", refPrefix]);
  return parseGitCatalogRefs(stdout, refPrefix);
}

export async function repoBranchCatalog(
  opts: RepoBranchCatalogOptions,
): Promise<RepoBranchCatalog> {
  if (!(await isRepo(opts.repoRoot))) {
    throw new GitError({
      code: "NOT_A_REPO",
      message: `${opts.repoRoot} is not a git repository`,
    });
  }

  const resolved = resolveRepoGit(opts.repoRoot);
  const remotes = await listRemotes(opts.repoRoot);

  // The remote whose branches we list: an explicit preview override, else the
  // settings-effective remote. Guarded like every settings-sourced ref (a
  // paired device can write `git.remote`) before it reaches git as an argument.
  const wanted = opts.remote?.trim() || resolved.remote;
  assertSafeGitRef(wanted, "repoBranchCatalog.remote");
  const remoteExists = remotes.some((r) => r.name === wanted);

  let detectedDefault: string | null = null;
  let branches: CatalogBranch[] = [];
  let listedRemote: string | null = null;

  if (remoteExists) {
    // Explicit user-driven freshen: bypass the 60s fetch-freshness memo so a
    // just-pushed branch shows up. Still bounded + non-fatal.
    if (opts.fetch) await fetchRemote(opts.repoRoot, wanted, { force: true });
    branches = await listRefs(opts.repoRoot, `refs/remotes/${wanted}/`);
    // Remote HEAD detection can cost an `ls-remote` round-trip when the local
    // symref is unset — only pay it on the fetch (freshen) pass so the instant
    // first paint stays instant. detectRemoteDefaultBranch tries the local
    // symref first either way.
    detectedDefault = opts.fetch
      ? await detectRemoteDefaultBranch(opts.repoRoot, wanted)
      : await detectLocalRemoteHead(opts.repoRoot, wanted);
    if (branches.length > 0) listedRemote = wanted;
  }
  if (!listedRemote) {
    // No usable remote OR its remote-tracking namespace is empty (freshly
    // added remote, offline before the first fetch). Offer local branches —
    // that's what createWorkspace itself falls back to in this state.
    branches = await listRefs(opts.repoRoot, "refs/heads/");
  }

  return {
    remotes,
    effectiveRemote: resolved.remote,
    remoteExists,
    baseExplicit: resolved.baseBranchExplicit,
    effectiveBase: resolved.baseBranchExplicit
      ? resolved.baseBranch
      : (detectedDefault ?? resolved.baseBranch),
    detectedDefault,
    listedRemote,
    branchSource: listedRemote ? "remote" : "local",
    branches,
  };
}

/** The local-only half of detectRemoteDefaultBranch: read the
 *  `refs/remotes/<remote>/HEAD` symref if set, never touch the network. */
async function detectLocalRemoteHead(
  repoRoot: string,
  remote: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);
    const out = stdout.trim();
    const prefix = `${remote}/`;
    if (out.startsWith(prefix)) return out.slice(prefix.length);
    return out || null;
  } catch {
    return null;
  }
}
