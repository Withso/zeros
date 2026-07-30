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

export type ForgeFamily =
  | "github"
  | "gitlab"
  | "bitbucket-cloud"
  | "bitbucket-server";

/** Provider-defined identifier. Its vocabulary is intentionally not a shared
 * union: GitLab exposes a project policy and Bitbucket has no rebase method. */
export type ReviewMergeMethod = string;

export interface ReviewMergeMethodOption {
  id: ReviewMergeMethod;
  label: string;
}

/** Identifies one reviewable unit (a PR / MR) inside a workspace. */
export interface ReviewTarget {
  workspaceId: string;
  /** Canonical provider instance host, so a target can never be silently sent
   * through the wrong adapter. */
  hostOrigin: string;
  /** Number shown in the provider's web URL. For GitLab this is the project-
   * scoped iid, never the instance-global id. */
  reviewRef: string;
}

export interface ReviewProviderCapabilities {
  reviewNoun: "pull request" | "merge request";
  /** Repository-effective options; UI renders this list rather than assuming
   * GitHub's three merge strategies. */
  mergeMethods: readonly ReviewMergeMethodOption[];
}

export interface ReviewProvider {
  family: ForgeFamily;
  /** Canonical hostname for this adapter instance. */
  hostOrigin: string;
  /** Exact-key cache partition, including the provider instance. */
  cacheKey: string;
  /** Human label for the external host ("GitHub"). */
  hostLabel: string;
  capabilities: ReviewProviderCapabilities;
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

function githubPrNumber(target: ReviewTarget): number {
  if (target.hostOrigin !== "github.com" || !/^[1-9]\d*$/.test(target.reviewRef)) {
    throw new Error("Invalid GitHub review target");
  }
  const prNumber = Number(target.reviewRef);
  if (!Number.isSafeInteger(prNumber)) {
    throw new Error("Invalid GitHub pull request number");
  }
  return prNumber;
}

function githubArgs(target: ReviewTarget): {
  workspaceId: string;
  prNumber: number;
} {
  return {
    workspaceId: target.workspaceId,
    prNumber: githubPrNumber(target),
  };
}

const githubProvider: ReviewProvider = {
  family: "github",
  hostOrigin: "github.com",
  cacheKey: "github:github.com",
  hostLabel: "GitHub",
  capabilities: {
    reviewNoun: "pull request",
    mergeMethods: [
      { id: "squash", label: "Squash & merge" },
      { id: "merge", label: "Merge" },
      { id: "rebase", label: "Rebase & merge" },
    ],
  },
  authStatus: () => ghAuthStatus(),
  getPr: (target) => ghPrGet(githubArgs(target)),
  getChecks: (target) => ghPrChecks(githubArgs(target)),
  getCommits: (target) => ghPrCommits(githubArgs(target)),
  getTimeline: (target) => ghPrReviews(githubArgs(target)),
  addComment: (target, body) =>
    ghPrComment({ ...githubArgs(target), body }),
  merge: (target, method) => {
    if (method !== "squash" && method !== "merge" && method !== "rebase") {
      throw new Error(`Unsupported GitHub merge method: ${method}`);
    }
    return ghPrMerge({ ...githubArgs(target), method });
  },
  markReady: (target) => ghPrMarkReady(githubArgs(target)),
};

/** Pick the provider for an explicit workspace origin host. Unsupported hosts
 * return null; they must never fall through to GitHub with misleading auth UI
 * or API traffic. */
export function resolveReviewProvider(
  originHost: string | null | undefined,
): ReviewProvider | null {
  const host = originHost?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  return host === "github.com" ||
    host === "www.github.com" ||
    host === "ssh.github.com"
    ? githubProvider
    : null;
}
