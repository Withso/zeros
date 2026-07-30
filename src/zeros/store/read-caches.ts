// ──────────────────────────────────────────────────────────
// Shared read caches for pickers, dialogs, and settings probes
// ──────────────────────────────────────────────────────────
//
// One KeyedAsyncCache per data shape, shared by every surface that shows it,
// so reopening a popover (or a second surface asking for the same repo's
// branches) paints the previous rows instantly and refetches only past the
// freshness window. Consumers mount these with useCachedRead.
//
// Freshness windows are per data shape: how stale can a picker's first paint
// be before a background revalidation is worth a bridge/GitHub round-trip?
// ──────────────────────────────────────────────────────────

import type { Branch, GithubOwner, PR, Workspace } from "../../native/git";
import type { GithubAuthSnapshot } from "@zeros/core/github-auth";
import { KeyedAsyncCache } from "../lib/keyed-async-cache";

/** Local git reads (bridge round-trip, no network): branches move often, so
 *  revalidate after a short window — still instant within a browsing burst. */
export const GIT_READ_MAX_AGE_MS = 30_000;

/** GitHub API reads: PRs/owners change on human timescales; probing more than
 *  once a minute per key burns rate limit for no visible benefit. */
export const GITHUB_READ_MAX_AGE_MS = 60_000;

/** Keyed by workspace id — remote branches offered as PR targets. */
export const remoteBranchesCache = new KeyedAsyncCache<Branch[]>(32);

/** Keyed by repo slug — all local+remote branches for create-from pickers. */
export const allBranchesCache = new KeyedAsyncCache<Branch[]>(32);

/** Keyed by origin URL — open PRs for create-from pickers. */
export const openPrsCache = new KeyedAsyncCache<PR[]>(32);

/** Keyed by repo slug (or "*" for every repo) — workspace summaries for
 *  pickers that only need branch/name rows, not the live board collections. */
export const pickerWorkspacesCache = new KeyedAsyncCache<Workspace[]>(16);

/** Single-key ("auth") — GitHub auth probe (status + CLI detection) for the
 *  settings section. Auth changes only on explicit sign-in/out, which write
 *  through setData; the freshness window merely catches out-of-band changes. */
export const ghAuthStatusCache = new KeyedAsyncCache<GithubAuthSnapshot>(1);

/** Single-key ("owners") — authed user + orgs for the publish dialog. */
export const ghOwnersCache = new KeyedAsyncCache<GithubOwner[]>(1);

/** Workspace mutations (create/archive/branch ops) move branches and
 *  checkouts. Mark the affected picker rows stale — mounted pickers refresh in
 *  the background; closed ones pay nothing until reopened. Remote-branch
 *  entries are keyed by workspace id (not repo), so they are invalidated
 *  wholesale; the next open of a base picker refetches behind its cached
 *  rows. */
export function invalidateRepoReadCaches(repoSlug: string | "*"): void {
  if (repoSlug === "*") {
    allBranchesCache.invalidateAll();
    pickerWorkspacesCache.invalidateAll();
  } else {
    allBranchesCache.invalidate(repoSlug);
    pickerWorkspacesCache.invalidate(repoSlug);
    pickerWorkspacesCache.invalidate("*");
  }
  remoteBranchesCache.invalidateAll();
}

/** External fetch/ref changes arrive with opaque workspace ids, not repository
 * slugs. Invalidate the exact target-branch catalogs plus the bounded repo-wide
 * branch catalogs. Mounted pickers silently refresh; closed pickers do no work. */
export function invalidateExternalGitRefCaches(
  workspaceIds?: readonly string[],
): void {
  if (!workspaceIds || workspaceIds.length === 0) {
    remoteBranchesCache.invalidateAll();
  } else {
    for (const workspaceId of new Set(workspaceIds.filter(Boolean))) {
      remoteBranchesCache.invalidate(workspaceId);
    }
  }
  // allBranchesCache is repo-slug keyed, and host paths/slugs deliberately do
  // not travel on the watcher event. Its hard bound makes exact retained-key
  // invalidation cheap and privacy-preserving.
  allBranchesCache.invalidateAll();
}

/** A NON-initial bridge (re)connection — engine restart, crash recovery, a
 *  network drop — is an authoritative freshness boundary for EVERY
 *  engine-derived snapshot above: branches may have moved, PRs merged, auth
 *  changed while the renderer couldn't hear DB_CHANGED broadcasts. Mark every
 *  retained key stale — mounted consumers revalidate silently behind their
 *  cached rows; closed surfaces pay nothing until reopened. Lives here (not at
 *  the reconnect call site in use-git-refresh-key) so adding a cache above and
 *  enrolling it in the reconnect boundary is one edit in one file. */
export function invalidateAllEngineReadCaches(): void {
  remoteBranchesCache.invalidateAll();
  allBranchesCache.invalidateAll();
  openPrsCache.invalidateAll();
  pickerWorkspacesCache.invalidateAll();
  ghAuthStatusCache.invalidateAll();
  ghOwnersCache.invalidateAll();
}
