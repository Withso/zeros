// ──────────────────────────────────────────────────────────
// review-provider — the host-neutral seam under the Review tab
// ──────────────────────────────────────────────────────────
//
// Everything the Review surface reads or writes goes through ONE typed
// interface (`ReviewProvider`) instead of calling the GitHub façade directly.
// Today the only implementation is GitHub (delegating to `@/native/git`, which
// rides the engine bridge → Octokit); GitLab / Bitbucket land later by adding
// a provider here and teaching `resolveReviewProvider` to pick it from the
// workspace's origin host — zero changes in the UI or the live-data store.
//
// The wire types (PR / PrChecksResult / PrCommitSummary / PrTimelineItem) are
// intentionally provider-neutral already — "PR" reads as "merge request" for
// GitLab without loss — so they stay the shared vocabulary rather than gaining
// a parallel copy.

import {
  ghAuthStatus,
  ghPrChecks,
  ghPrComment,
  ghPrCommits,
  ghPrGet,
  ghPrMarkReady,
  ghPrMerge,
  ghPrReviews,
  type AuthStatusResult,
  type PR,
  type PrChecksResult,
  type PrCommitSummary,
  type PrTimelineItem,
} from "../../native/git";

export type ReviewMergeMethod = "squash" | "merge" | "rebase";

/** Identifies one reviewable unit (a PR / MR) inside a workspace. */
export interface ReviewTarget {
  workspaceId: string;
  prNumber: number;
}

export interface ReviewProvider {
  /** Stable id — persisted nowhere yet, but lets the UI label provider-
   *  specific affordances ("Open on GitHub") without sniffing URLs. */
  id: "github" | "gitlab" | "bitbucket";
  /** Human label for the external host ("GitHub"). */
  hostLabel: string;
  authStatus(): Promise<AuthStatusResult>;
  getPr(target: ReviewTarget): Promise<PR>;
  getChecks(target: ReviewTarget): Promise<PrChecksResult>;
  getCommits(target: ReviewTarget): Promise<PrCommitSummary[]>;
  /** Reviews + conversation comments, oldest-first. */
  getTimeline(target: ReviewTarget): Promise<PrTimelineItem[]>;
  addComment(
    target: ReviewTarget,
    body: string,
  ): Promise<{ id: number; url: string }>;
  merge(target: ReviewTarget, method: ReviewMergeMethod): Promise<{ sha: string }>;
  markReady(target: ReviewTarget): Promise<PR>;
}

const githubProvider: ReviewProvider = {
  id: "github",
  hostLabel: "GitHub",
  authStatus: () => ghAuthStatus(),
  getPr: (t) => ghPrGet(t),
  getChecks: (t) => ghPrChecks(t),
  getCommits: (t) => ghPrCommits(t),
  getTimeline: (t) => ghPrReviews(t),
  addComment: (t, body) => ghPrComment({ ...t, body }),
  merge: (t, method) => ghPrMerge({ ...t, method }),
  markReady: (t) => ghPrMarkReady(t),
};

/** Pick the provider for a workspace. GitHub is the only host wired today;
 *  when GitLab/Bitbucket land this switches on the workspace's origin host
 *  (available via the workspace row / originUrl) — callers already pass
 *  through here, so they won't change. */
export function resolveReviewProvider(_originHost?: string | null): ReviewProvider {
  return githubProvider;
}
