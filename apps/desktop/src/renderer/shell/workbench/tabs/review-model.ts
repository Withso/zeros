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
} from "../../../platform/git";
import {
  buildFixCheckPrompt,
  buildReviewCommentContext,
} from "../../pr/pr-action-prompts";
import type { CodeReviewThreadItem } from "../../../features/code-review/review-thread-model";

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
  /** A check that failed on the head commit, at the time it finished. */
  | { kind: "check"; at: number; check: PrCheck; sha: string }
  | { kind: "review"; at: number; item: PrTimelineItem }
  | { kind: "comment"; at: number; item: PrTimelineItem }
  | { kind: "merged"; at: number }
  | { kind: "closed"; at: number };

export function composeTimeline(args: {
  pr: PR | null;
  commits: PrCommitSummary[];
  items: PrTimelineItem[];
  /** The head commit's checks; their failures join the stream. */
  checks?: PrChecksResult | null;
}): ReviewTimelineEvent[] {
  const events: ReviewTimelineEvent[] = [];
  const { pr, commits, items, checks } = args;
  if (pr && pr.createdAt > 0) {
    events.push({ kind: "opened", at: pr.createdAt, author: pr.authorLogin });
  }
  for (const c of commits) {
    if (c.date > 0) events.push({ kind: "commit", at: c.date, commit: c });
  }
  // Only the head's checks are known by name; a failure without a finish
  // time has no place in the order and stays on the Checks tab.
  if (pr?.headSha && checks) {
    for (const check of checks.checks) {
      if (checkOutcome(check) === "failed" && check.completedAt && check.completedAt > 0)
        events.push({ kind: "check", at: check.completedAt, check, sha: pr.headSha });
    }
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

// ── Overview · PR status ─────────────────────────────────────

const VERDICT_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

/** Each reviewer's standing review, newest first: their latest verdict
 * (approved, changes requested, dismissed), else their latest comment-only
 * review. A comment after a verdict leaves the verdict standing, as on GitHub. */
export function latestReviewsByAuthor(items: readonly PrTimelineItem[]): PrTimelineItem[] {
  const byAuthor = new Map<string, PrTimelineItem>();
  const sorted = items
    .filter((item) => item.kind === "review")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const item of sorted) {
    const held = byAuthor.get(item.author);
    if (!held) byAuthor.set(item.author, item);
    else if (!VERDICT_STATES.has(held.state) && VERDICT_STATES.has(item.state)) byAuthor.set(item.author, item);
  }
  return [...byAuthor.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export interface PrStatusBlocker {
  id: string;
  kind: "check" | "review" | "conflicts" | "behind" | "requirements";
  title: string;
  /** What Add to chat drops in the composer; absent when the row has none. */
  chatText?: string;
}

export interface PrStatusView {
  title: string;
  detail: string | null;
  tone: "success" | "danger" | "neutral" | "merged" | "closed";
  /** The card's one action: Merge (with the remembered method) or Ready for
   *  review. Its enabled state comes from the island (reviewActionBlockReason). */
  action: "merge" | "ready" | null;
  blockers: PrStatusBlocker[];
  /** What is already done, in one quiet line. */
  done: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function joinPhrases(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** The pull request on GitHub: its verdict, the one action, only what blocks
 * it (failing checks and requested changes carry Add to chat), and what is
 * done. Local Git state belongs to Git status and is never repeated here. */
export function derivePrStatusView(args: {
  pr: PR;
  branch: string;
  checks: PrChecksResult | null;
  timeline: readonly PrTimelineItem[] | null;
  now?: number;
}): PrStatusView {
  const { pr, branch, checks, timeline } = args;
  if (pr.state === "merged" || pr.mergedAt != null) {
    return {
      title: "Merged",
      detail: pr.mergedAt ? `Merged ${relTime(pr.mergedAt, args.now)}` : null,
      tone: "merged",
      action: null,
      blockers: [],
      done: null,
    };
  }
  if (pr.state === "closed") {
    return { title: "Closed", detail: "Closed without merging", tone: "closed", action: null, blockers: [], done: null };
  }
  const buckets = bucketChecks(checks?.checks ?? []);
  const reviews = latestReviewsByAuthor(timeline ?? []);
  const blockers: PrStatusBlocker[] = buckets.failed.map((c) => ({
    id: `check:${c.name}`,
    kind: "check",
    title: `${c.name} failed`,
    chatText: buildFixCheckPrompt({ checkName: c.name, prNumber: pr.number, branch: branch || pr.headBranch, detailsUrl: c.detailsUrl }),
  }));
  const changesRequested = reviews.filter((r) => r.state === "CHANGES_REQUESTED");
  for (const r of changesRequested) {
    blockers.push({
      id: `review:${r.author}`,
      kind: "review",
      title: `${r.author} requested changes`,
      chatText: buildReviewCommentContext({ prNumber: pr.number, author: r.author, state: r.state, body: r.body }),
    });
  }
  const mergeable = pr.mergeableState.toLowerCase();
  if (mergeable === "dirty") blockers.push({ id: "conflicts", kind: "conflicts", title: `Conflicts with ${pr.baseBranch}` });
  if (mergeable === "behind") blockers.push({ id: "behind", kind: "behind", title: `Behind ${pr.baseBranch}` });
  if (mergeable === "blocked" && blockers.length === 0) {
    blockers.push({ id: "requirements", kind: "requirements", title: "Repository merge requirements aren’t met" });
  }

  const passed = buckets.passed.length;
  const pending = buckets.pending.length;
  const approvedBy = reviews.filter((r) => r.state === "APPROVED").map((r) => r.author);
  const doneParts = [
    passed > 0 ? plural(passed, "check") + " passed" : null,
    pending > 0 && blockers.length > 0 ? `${pending} running` : null,
    approvedBy.length > 0 ? `Approved by ${joinPhrases(approvedBy)}` : null,
  ].filter((part): part is string => part !== null);
  const done = doneParts.length > 0 ? doneParts.join(" · ") : null;

  if (pr.state === "draft" || mergeable === "draft") {
    return { title: "Draft", detail: "Mark it ready for review to merge", tone: "neutral", action: "ready", blockers, done };
  }
  if (blockers.length > 0) {
    const reasons = [
      buckets.failed.length > 0 ? plural(buckets.failed.length, "failing check") : null,
      changesRequested.length > 0 ? "requested changes" : null,
      mergeable === "dirty" ? `conflicts with ${pr.baseBranch}` : null,
      mergeable === "behind" ? `an out-of-date branch` : null,
      blockers.some((b) => b.kind === "requirements") ? "unmet merge requirements" : null,
    ].filter((part): part is string => part !== null);
    return { title: "Merge blocked", detail: joinPhrases(reasons), tone: "danger", action: "merge", blockers, done };
  }
  if (pending > 0) {
    const total = checks?.checks.length ?? pending;
    return { title: "Checks running", detail: `${pending} of ${total} checks running`, tone: "neutral", action: "merge", blockers, done };
  }
  if ((mergeable === "clean" || mergeable === "has_hooks") && pr.isMergeable !== false) {
    return { title: "Ready to merge", detail: null, tone: "success", action: "merge", blockers, done };
  }
  return { title: "Checking mergeability…", detail: null, tone: "neutral", action: "merge", blockers, done };
}

// ── Overview · Findings ──────────────────────────────────────

export interface ReviewFinding {
  key: string;
  /** Who wrote it: an agent (its provider names the mark), a review app or a
   *  code-scanning check. */
  author: { name: string; kind: "agent" | "bot" | "check"; provider?: string };
  title: string;
  /** "login.ts:18" or "login.ts:18–21". */
  location: string;
  resolved: boolean;
  /** What Add to chat drops in the composer. */
  chatText: string;
}

function findingTitle(body: string): string {
  const line =
    body
      .split("\n")
      .map((text) => text.replace(/\*\*|__/g, "").replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, "").trim())
      .find(Boolean) ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/** Findings are comments from agents, review apps and code scanning; people's
 * reviews stay in Activity. Unresolved first, each in thread order. */
export function reviewFindings(
  threads: readonly CodeReviewThreadItem[],
  prNumber: number,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  for (const thread of threads) {
    const first = thread.comments[0];
    if (!first) continue;
    const kind =
      thread.source === "check"
        ? "check"
        : thread.source === "github" && first.author.kind === "integration"
          ? "bot"
          : thread.source === "workspace" && first.author.kind === "agent"
            ? "agent"
            : null;
    if (!kind) continue;
    const { path, startLine, endLine } = thread.anchor;
    const base = path.split("/").pop() ?? path;
    const lines = endLine > startLine ? `${startLine}–${endLine}` : `${startLine}`;
    const quoted = first.body
      .split("\n")
      .map((text) => `> ${text}`)
      .join("\n");
    findings.push({
      key: `${thread.source}:${thread.id}`,
      author: { name: first.author.name, kind, ...(first.author.provider ? { provider: first.author.provider } : {}) },
      title: findingTitle(first.body),
      location: `${base}:${lines}`,
      resolved: thread.resolved,
      chatText: `PR #${prNumber} — ${first.author.name} on \`${path}:${lines}\`:\n${quoted}\n\n`,
    });
  }
  return findings.sort((a, b) => Number(a.resolved) - Number(b.resolved));
}

// ── Activity · people and bots ───────────────────────────────

/** A GitHub App acts as `name[bot]`. */
export function isBotLogin(login: string): boolean {
  return /\[bot\]$/i.test(login);
}

/** An App's name without its `[bot]` suffix; a Bot badge says the rest. */
export function appDisplayName(login: string): string {
  return login.replace(/\[bot\]$/i, "");
}

export type TimelineFilter = "all" | "people" | "bots";

function eventActor(event: ReviewTimelineEvent): string | null {
  switch (event.kind) {
    case "opened":
      return event.author;
    case "commit":
      return event.commit.authorLogin ?? event.commit.authorName;
    case "review":
    case "comment":
      return event.item.author;
    default:
      return null;
  }
}

/** People keeps every event no App took, including the authorless merged and
 * closed lines; Bots keeps an App's own reviews, comments and commits. */
export function filterTimelineEvents(
  events: readonly ReviewTimelineEvent[],
  filter: TimelineFilter,
): ReviewTimelineEvent[] {
  if (filter === "all") return [...events];
  return events.filter((event) => {
    // A check result is neither a person's nor an App's comment.
    if (event.kind === "check") return false;
    const actor = eventActor(event);
    const bot = actor != null && isBotLogin(actor);
    return filter === "bots" ? bot : !bot;
  });
}

// ── Overview · merge methods ─────────────────────────────────

/** The merge menu's second line: what a method does to this PR's commits. */
export function mergeMethodDetail(
  method: string,
  commits: number | null,
  base: string,
): string | null {
  const count = commits && commits > 0 ? commits : null;
  if (count === 1) {
    if (method === "squash") return `The commit lands on ${base}`;
    if (method === "merge") return `The commit joins ${base} with a merge commit`;
    if (method === "rebase") return `The commit replays onto ${base}`;
    return null;
  }
  const these = count == null ? "The commits" : `The ${count} commits`;
  if (method === "squash") return `${these} land on ${base} as one`;
  if (method === "merge")
    return `${count == null ? "The commits" : `All ${count} commits`} join ${base} with a merge commit`;
  if (method === "rebase") return `${these} replay onto ${base}`;
  return null;
}
