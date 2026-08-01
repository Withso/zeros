// ──────────────────────────────────────────────────────────
// review-model — pure helpers behind the Review tab
// ──────────────────────────────────────────────────────────
//
// Everything here is renderer-free and unit-tested (review-model.test.ts):
// the merged activity timeline (opened → commits → reviews/comments → merged),
// the Commits tab's day grouping, the Checks tab's status buckets + summary,
// and the small time/duration formatters the surfaces share.

import type {
  PR,
  PrCheck,
  PrChecksResult,
  PrCommitSummary,
  PrTimelineItem,
} from "../../native/git";

// ── time formatting ──────────────────────────────────────────

/** "just now" / "4m ago" / "3h ago" / "2d ago" / "5w ago". Clock skew (a
 *  GitHub timestamp slightly ahead of the local clock) clamps to "just now". */
export function relTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const d = now - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.floor(d / 86_400_000)}d ago`;
  return `${Math.floor(d / (7 * 86_400_000))}w ago`;
}

/** "2s" / "1m 35s" / "1h 4m" — the Checks tab's duration column. */
export function formatDuration(ms: number): string {
  if (ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** Recency bucket label for the Commits tab groups: "Today" / "Yesterday" /
 *  "Last 7 days" / "Last 30 days", then the month — "March" within the
 *  current year, "June 2025" beyond it. Clock skew clamps to "Today". */
export function recencyLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const n = new Date(now);
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(n) - startOf(d)) / 86_400_000);
  if (dayDiff <= 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return "Last 7 days";
  if (dayDiff < 30) return "Last 30 days";
  const month = d.toLocaleDateString("en-US", { month: "long" });
  return d.getFullYear() === n.getFullYear()
    ? month
    : `${month} ${d.getFullYear()}`;
}

// ── commits: recency grouping ────────────────────────────────

export interface CommitGroup {
  label: string;
  commits: PrCommitSummary[];
}

/** Recency groups, newest bucket first (Today at the top) with commits
 *  newest-first inside. Buckets are monotonic in time, so grouping the
 *  sorted list sequentially keeps equal labels contiguous. */
export function groupCommitsByRecency(
  commits: PrCommitSummary[],
  now = Date.now(),
): CommitGroup[] {
  const sorted = [...commits].sort((a, b) => b.date - a.date);
  const groups: CommitGroup[] = [];
  for (const c of sorted) {
    const label = recencyLabel(c.date, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.commits.push(c);
    else groups.push({ label, commits: [c] });
  }
  return groups;
}

/** "Cursor Agent and Jordan Lee" — primary author + co-authors. */
export function commitAuthorsLabel(c: PrCommitSummary): string {
  const names = [c.authorName, ...c.coAuthors.map((a) => a.name)].filter(
    Boolean,
  );
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ── checks: buckets + summary ────────────────────────────────

export type CheckOutcome = "passed" | "failed" | "pending";

/** One check's terminal bucket. Mirrors the engine's counting rules
 *  (success/neutral/skipped pass; failure/cancelled/timed_out/error fail;
 *  everything still running is pending). */
export function checkOutcome(c: PrCheck): CheckOutcome {
  if (
    c.conclusion === "success" ||
    c.conclusion === "neutral" ||
    c.conclusion === "skipped"
  )
    return "passed";
  if (
    c.conclusion === "failure" ||
    c.conclusion === "cancelled" ||
    c.conclusion === "timed_out" ||
    c.conclusion === "error" ||
    c.status === "failure"
  )
    return "failed";
  return "pending";
}

export interface CheckBuckets {
  failed: PrCheck[];
  pending: PrCheck[];
  passed: PrCheck[];
}

export function bucketChecks(checks: PrCheck[]): CheckBuckets {
  const buckets: CheckBuckets = { failed: [], pending: [], passed: [] };
  for (const c of checks) buckets[checkOutcome(c)].push(c);
  return buckets;
}

export type ChecksTone = "success" | "failure" | "pending" | "none";

export interface ChecksSummary {
  tone: ChecksTone;
  /** Sub-nav + header label: "All checks passed", "2 checks failing", … */
  label: string;
  /** "5/5" style progress fraction (passed/total); "" when no checks. */
  fraction: string;
}

export function summarizeChecks(data: PrChecksResult | null): ChecksSummary {
  if (!data || data.total === 0)
    return { tone: "none", label: "No checks", fraction: "" };
  const fraction = `${data.passed}/${data.total}`;
  if (data.failed > 0)
    return {
      tone: "failure",
      label: `${data.failed} ${data.failed === 1 ? "check" : "checks"} failing`,
      fraction,
    };
  if (data.pending > 0)
    return { tone: "pending", label: "Checks running", fraction };
  return { tone: "success", label: "All checks passed", fraction };
}

// ── shared PR action gates ──────────────────────────────────

/**
 * Review repeats two actions that also appear in the shared PR status island.
 * Their enabled state must come from that island's single derived state, not
 * from Review's narrower `isMergeable` field: local commits, divergence,
 * pending checks, and branch-protection requirements all outrank it.
 */
export function reviewActionBlockReason(
  islandKind: string | null,
  action: "merge" | "ready",
): string | null {
  if (
    (action === "merge" && islandKind === "ready-to-merge") ||
    (action === "ready" && islandKind === "draft")
  ) {
    return null;
  }

  switch (islandKind) {
    case null:
      return "Pull request status is loading.";
    case "merge-conflicts":
      return "This branch has conflicts with the base branch — resolve them first.";
    case "uncommitted":
      return "Commit and push the local changes first.";
    case "diverged":
      return "Pull the remote branch and resolve the divergence first.";
    case "ahead":
      return "Push the local commits first.";
    case "behind":
      return "Pull the remote commits first.";
    case "draft":
      return action === "merge"
        ? "Mark this pull request ready for review first."
        : null;
    case "checks-pending":
      return "Wait for the required checks to finish.";
    case "unable-to-merge":
      return "Fix the failing checks before merging.";
    case "behind-base":
      return "Update the branch from the target branch first.";
    case "blocked":
      return "Complete the repository's merge requirements first.";
    case "checking":
      return "GitHub is still checking mergeability.";
    case "pr-open":
      return "Mergeability is unavailable; refresh the pull request status.";
    case "merged":
      return "This pull request is already merged.";
    case "closed":
      return "This pull request is closed.";
    default:
      return action === "ready"
        ? "Resolve the current pull request status before marking it ready."
        : "Resolve the current pull request status before merging.";
  }
}

// ── activity timeline ────────────────────────────────────────

/** The Reviews tab's merged event stream. Compositional (not an API shape):
 *  built from the PR row + commits + reviews/comments, oldest-first. */
export type ReviewTimelineEvent =
  | { kind: "opened"; at: number; author: string }
  | { kind: "commit"; at: number; commit: PrCommitSummary }
  | { kind: "review"; at: number; item: PrTimelineItem }
  | { kind: "comment"; at: number; item: PrTimelineItem }
  | { kind: "merged"; at: number }
  | { kind: "closed"; at: number };

export function composeTimeline(args: {
  pr: PR | null;
  commits: PrCommitSummary[];
  items: PrTimelineItem[];
}): ReviewTimelineEvent[] {
  const events: ReviewTimelineEvent[] = [];
  const { pr, commits, items } = args;
  if (pr && pr.createdAt > 0) {
    events.push({ kind: "opened", at: pr.createdAt, author: pr.authorLogin });
  }
  for (const c of commits) {
    if (c.date > 0) events.push({ kind: "commit", at: c.date, commit: c });
  }
  for (const it of items) {
    events.push({
      kind: it.kind === "review" ? "review" : "comment",
      at: it.createdAt,
      item: it,
    });
  }
  if (pr?.state === "merged" && pr.mergedAt) {
    events.push({ kind: "merged", at: pr.mergedAt });
  } else if (pr?.state === "closed") {
    // The REST PR row carries no closed_at through our shape; anchor the
    // event at updatedAt (the close is what last touched a closed PR).
    events.push({ kind: "closed", at: pr.updatedAt });
  }
  // Stable chronological order; ties keep insertion order (opened → commits →
  // reviews/comments → merged), which reads correctly for same-second events.
  return events
    .map((e, i) => [e, i] as const)
    .sort((a, b) => a[0].at - b[0].at || a[1] - b[1])
    .map(([e]) => e);
}

// ── live-refresh pacing ──────────────────────────────────────

/** Polling cadence for the live store (review-data.ts). Values balance
 *  "instant" against GitHub's 5k/hr budget: while CI is in flight the CHECKS
 *  resource alone refreshes on the fast lane; the full snapshot rides the slow
 *  lane. Both lanes run ONLY while the Review tab is active and the document
 *  is visible — a hidden/pinned-away tab costs zero API calls. */
export const CHECKS_POLL_ACTIVE_MS = 12_000;
export const FULL_POLL_MS = 60_000;

/** True while any check is still running — the fast checks lane's gate. */
export function hasPendingChecks(data: PrChecksResult | null): boolean {
  return (
    !!data &&
    (data.pending > 0 || data.checks.some((c) => checkOutcome(c) === "pending"))
  );
}
